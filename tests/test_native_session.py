import json
import queue
import struct
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

from test_server import Source

ROOT = Path(__file__).resolve().parents[1]


class NativeSessionTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix="viddow-native-")
        self.source = ThreadingHTTPServer(("127.0.0.1", 0), Source)
        threading.Thread(target=self.source.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.source.server_port}"
        self.process = subprocess.Popen([sys.executable, str(ROOT / "native_host.py")],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.messages = queue.Queue()
        self.reader = threading.Thread(target=self.read_messages, daemon=True)
        self.reader.start()
        self.send({"type": "session", "settings": {"workers": 1, "output_dir": self.folder.name}})
        self.ready = self.wait(lambda message: message["type"] == "ready")
        self.request_id = 0

    def read_messages(self):
        while header := self.process.stdout.read(4):
            length = struct.unpack("<I", header)[0]
            self.messages.put(json.loads(self.process.stdout.read(length)))

    def send(self, message):
        data = json.dumps(message).encode()
        self.process.stdin.write(struct.pack("<I", len(data)) + data)
        self.process.stdin.flush()

    def wait(self, predicate):
        import time
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            message = self.messages.get(timeout=max(0.01, deadline - time.monotonic()))
            if predicate(message):
                return message
        self.fail("Нет ожидаемого ответа Native Messaging")

    def command(self, command, **kwargs):
        self.request_id += 1
        request_id = str(self.request_id)
        self.send({"command": command, "request_id": request_id, "session": self.ready["session"], **kwargs})
        return self.wait(lambda message: message.get("request_id") == request_id)

    def tearDown(self):
        if self.process.stdin and not self.process.stdin.closed:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        self.reader.join(timeout=1)
        self.process.stdout.close()
        self.process.stderr.close()
        self.source.shutdown()
        self.source.server_close()
        self.folder.cleanup()

    def test_one_host_queues_cancels_and_retries(self):
        self.assertEqual(self.ready["protocol"], 2)
        reply = self.command("download", urls=[self.url + "/slow.mp4", self.url + "/video.mp4"],
                             headers={"X-Test": "private-context"})
        self.assertTrue(reply["ok"])
        first, second = reply["result"]["ids"]
        state = self.wait(lambda message: message["type"] == "state" and len(message["jobs"]) == 2)
        self.assertEqual([job["status"] for job in state["jobs"]], ["running", "queued"])
        self.assertNotIn("private-context", json.dumps(state))
        self.assertFalse(self.command("configure", settings={"workers": 2})["ok"])
        self.assertTrue(self.command("cancel", id=first)["ok"])
        completed = self.wait(lambda message: message["type"] == "state" and any(
            job["id"] == second and job["status"] == "done" for job in message["jobs"]))
        self.assertEqual(completed["jobs"][0]["status"], "cancelled")
        saved = Path(completed["jobs"][1]["path"])
        self.assertEqual(saved.read_bytes(), b"local-video-fixture" * 4000)
        retry = self.command("retry", id=first)
        self.assertTrue(retry["ok"])
        self.assertNotEqual(retry["result"]["id"], first)
        self.assertTrue(self.command("cancel", id=retry["result"]["id"])["ok"])
        self.wait(lambda message: message["type"] == "state" and len(message["jobs"]) == 3 and
                  all(job["status"] in ("done", "cancelled") for job in message["jobs"]))
        self.assertFalse(list(Path(self.folder.name).glob("*.part")))
        folder = str(Path(self.folder.name, "other"))
        changed = self.command("configure", settings={"workers": 3, "output_dir": folder})
        self.assertTrue(changed["ok"])
        self.assertEqual(changed["result"], {"workers": 3, "output_dir": str(Path(folder).resolve())})
        self.assertTrue(self.command("clear")["ok"])
        self.assertTrue(saved.exists())

    def test_disconnect_stops_active_and_waiting_downloads(self):
        self.command("download", urls=[self.url + "/slow.mp4"] * 3)
        self.wait(lambda message: message["type"] == "state" and len(message["jobs"]) == 3)
        self.process.stdin.close()
        self.assertEqual(self.process.wait(timeout=4), 0)
        self.assertEqual(list(Path(self.folder.name).iterdir()), [])

    def test_invalid_commands_do_not_break_session(self):
        for command, args in [("download", {"urls": ["file:///etc/passwd"]}),
                              ("configure", {"settings": {"workers": True}}),
                              ("configure", {"settings": {"output_dir": "relative"}}),
                              ("cancel", {"id": "1"}), ("unknown", {})]:
            self.assertFalse(self.command(command, **args)["ok"])
        self.assertTrue(self.command("download", urls=[self.url + "/video.mp4"])["ok"])
        self.wait(lambda message: message["type"] == "state" and any(job["status"] == "done" for job in message["jobs"]))

    def test_stale_session_cannot_change_current_queue(self):
        reply = self.command("download", urls=[self.url + "/slow.mp4"])
        job_id = reply["result"]["ids"][0]
        for command, args in [("cancel", {"id": job_id}), ("retry", {"id": job_id}),
                              ("clear", {}), ("configure", {"settings": {"workers": 8}}),
                              ("download", {"urls": [self.url + "/video.mp4"]})]:
            with self.subTest(command=command):
                reply = self.command(command, session="previous-session", **args)
                self.assertFalse(reply["ok"])
                self.assertIn("Сессия", reply["error"])
        state = self.wait(lambda message: message["type"] == "state" and bool(message["jobs"]))
        self.assertEqual(len(state["jobs"]), 1)
        self.assertEqual(state["jobs"][0]["status"], "running")
        self.assertEqual(state["settings"]["workers"], 1)
        self.assertTrue(self.command("cancel", id=job_id)["ok"])

    def test_legacy_single_commands_remain_compatible(self):
        # Старый download пишет только в тестовую папку; реальный Finder здесь
        # заменён, его вызов через session v2 отдельно проверяет browser smoke.
        script = (
            "import functools,sys,os; from unittest.mock import patch; import download; "
            "download.DEFAULT_DIR=sys.argv[1]; "
            "download.download=functools.partial(download.download,folder=sys.argv[1]); "
            "import native_host; "
            "\nwith patch('native_host.subprocess.run') as reveal:"
            "\n native_host.main()"
            "\n if reveal.called: assert reveal.call_args.args[0] == ['open','-R',os.path.realpath(sys.argv[2])]"
        )

        def single(message, expected, saved=""):
            process = subprocess.Popen([sys.executable, "-c", script, self.folder.name, saved],
                                       cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            messages = queue.Queue()

            def read():
                while header := process.stdout.read(4):
                    messages.put(json.loads(process.stdout.read(struct.unpack("<I", header)[0])))

            reader = threading.Thread(target=read, daemon=True)
            reader.start()
            try:
                data = json.dumps(message).encode()
                process.stdin.write(struct.pack("<I", len(data)) + data)
                process.stdin.flush()
                while True:
                    reply = messages.get(timeout=5)
                    if reply["type"] == "error":
                        self.fail(reply["error"])
                    if reply["type"] == expected:
                        break
                self.assertEqual(process.wait(timeout=5), 0, process.stderr.read().decode())
                return reply
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
                reader.join(timeout=1)
                for stream in (process.stdin, process.stdout, process.stderr):
                    stream.close()

        reply = single({"type": "download", "url": self.url + "/video.mp4"}, "done")
        self.assertEqual(Path(reply["path"]).read_bytes(), b"local-video-fixture" * 4000)
        self.assertEqual(single({"type": "reveal", "path": reply["path"]}, "ok", reply["path"]), {"type": "ok"})


if __name__ == "__main__":
    unittest.main()
