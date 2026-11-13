import http.client
import json
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import download
from jobs import JobManager
from server import Handler, MAX_BODY, Server


def wait_for(predicate, timeout=4):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.02)
    raise AssertionError("Состояние не наступило до таймаута")


class Source(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/denied":
            self.send_error(403)
            return
        if self.path == "/missing.mp4":
            self.send_error(404)
            return
        data = b"local-video-fixture" * 4000
        slow = self.path == "/slow.mp4"
        self.send_response(200)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Content-Length", str(len(data) * (300 if slow else 1)))
        self.end_headers()
        try:
            for _ in range(300 if slow else 1):
                self.wfile.write(data)
                self.wfile.flush()
                if slow:
                    time.sleep(0.03)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, *args):
        pass


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.manager = JobManager(workers=1, folder=self.folder.name)
        self.server = Server(("127.0.0.1", 0), self.manager)
        self.source = ThreadingHTTPServer(("127.0.0.1", 0), Source)
        for server in (self.server, self.source):
            threading.Thread(target=server.serve_forever, daemon=True).start()
        self.source_url = f"http://127.0.0.1:{self.source.server_port}"
        self.quiet = patch.object(Handler, "log_message", lambda *args: None)
        self.quiet.start()

    def tearDown(self):
        self.manager.close()
        for server in (self.server, self.source):
            server.shutdown()
            server.server_close()
        self.folder.cleanup()
        self.quiet.stop()

    def request(self, path, body=None, headers=None, raw=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=4)
        method = "POST" if body is not None or raw is not None else "GET"
        data = json.dumps(body) if body is not None else raw
        request_headers = {"Content-Type": "application/json"} if method == "POST" else {}
        request_headers.update(headers or {})
        connection.request(method, path, body=data, headers=request_headers)
        response = connection.getresponse()
        payload = response.read().decode()
        status = response.status
        connection.close()
        return status, json.loads(payload) if response.getheader("Content-Type", "").startswith("application/json") else payload

    def test_end_to_end_download_and_static_files(self):
        for path in ("/", "/web/app.css", "/web/app.js", "/web/extractor.js"):
            self.assertEqual(self.request(path)[0], 200)
        status, health = self.request("/health")
        self.assertEqual(status, 200)
        self.assertEqual(health["workers"], 1)
        status, result = self.request("/download", {"urls": [self.source_url + "/video.mp4"], "name": "My video"})
        self.assertEqual(status, 200)
        wait_for(lambda: self.manager.snapshots()[0]["status"] == "done")
        status, jobs = self.request("/jobs")
        self.assertEqual(jobs[0]["id"], result["ids"][0])
        saved = Path(jobs[0]["path"])
        self.assertEqual(saved.read_bytes(), b"local-video-fixture" * 4000)
        self.assertEqual(self.request(f"/jobs/{jobs[0]['id']}/retry", {})[0], 409)
        self.assertEqual(self.request("/jobs/clear", {})[0], 200)
        self.assertTrue(saved.exists())
        self.assertEqual(self.request("/jobs")[1], [])

    def test_active_cancel_then_retry(self):
        _, result = self.request("/download", {"urls": [self.source_url + "/slow.mp4"]})
        job_id = result["ids"][0]
        wait_for(lambda: bool(list(Path(self.folder.name).glob("*.part"))))
        self.assertEqual(self.request(f"/jobs/{job_id}/cancel", {})[0], 200)
        wait_for(lambda: self.manager.snapshots()[0]["status"] == "cancelled")
        self.assertEqual(list(Path(self.folder.name).iterdir()), [])
        status, retry = self.request(f"/jobs/{job_id}/retry", {})
        self.assertEqual(status, 200)
        self.assertNotEqual(retry["id"], job_id)
        self.assertEqual(self.request(f"/jobs/{retry['id']}/cancel", {})[0], 200)
        self.assertEqual(self.request("/jobs/999/cancel", {})[0], 404)

    def test_input_and_origin_validation(self):
        for body in ([], None, {"urls": ["file:///tmp/test"]}, {"urls": ["http://"]},
                     {"urls": ["https://example.com"], "name": []},
                     {"urls": ["https://example.com"], "referer": "https://example.com/\r\nx: y"},
                     {"urls": ["https://example.com"], "headers": {"Cookie": "bad\nheader"}},
                     {"urls": ["https://example.com"], "source_kind": []}):
            with self.subTest(body=body):
                self.assertEqual(self.request("/download", raw=json.dumps(body))[0], 400)
        self.assertEqual(self.request("/download", raw="{")[0], 400)
        self.assertEqual(self.request("/download", {}, headers={"Origin": "https://other.example"})[0], 403)
        self.assertEqual(self.request("/download", {}, headers={"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.request("/jobs", headers={"Host": "evil.example"})[0], 403)
        # Отказ определяется по заголовку до чтения тела. Не отправляем мегабайт
        # в уже закрываемый сокет: это проверяло гонку TCP, а не HTTP-контракт.
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=4)
        self.addCleanup(connection.close)
        connection.putrequest("POST", "/download")
        connection.putheader("Content-Type", "application/json")
        connection.putheader("Content-Length", str(MAX_BODY + 1))
        connection.endheaders()
        response = connection.getresponse()
        self.assertEqual(response.status, 413)
        self.assertIn("слишком большой", response.read().decode())
        self.assertEqual(self.manager.snapshots(), [])

    @patch("download.run_ytdlp", return_value="/tmp/fallback.mp4")
    @patch("download.resolve_tool", return_value="yt-dlp")
    def test_real_http_403_reaches_extractor(self, which, ytdlp):
        self.assertEqual(download.download(self.source_url + "/denied"), "/tmp/fallback.mp4")
        ytdlp.assert_called_once()


if __name__ == "__main__":
    unittest.main()
