import io
import os
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
from email.message import Message
from pathlib import Path
from unittest.mock import Mock, patch

import download


class Response(io.BytesIO):
    def __init__(self, data, total=None, content_type="video/mp4"):
        super().__init__(data)
        self.url = "https://example.com/video.mp4"
        self.headers = Message()
        self.headers["Content-Type"] = content_type
        self.headers["Content-Length"] = str(len(data) if total is None else total)


class RoutingTests(unittest.TestCase):
    @patch("download.run_ytdlp", return_value="selected.mp4")
    @patch("download.shutil.which", side_effect=lambda tool: None if tool == "ffmpeg" else "yt-dlp")
    @patch("download.urllib.request.urlopen")
    def test_selected_formats_require_merger_and_never_fall_back(self, urlopen, which, ytdlp):
        with self.assertRaisesRegex(RuntimeError, "ffmpeg"):
            download.download("https://example.com/watch", format_ids=["v90", "ru"])
        ytdlp.assert_not_called()
        self.assertEqual(download.download("https://example.com/watch", format_ids=["v90"]), "selected.mp4")
        self.assertEqual(ytdlp.call_args.kwargs["format_ids"], ["v90"])
        urlopen.assert_not_called()

    @patch("download.shutil.which", return_value=None)
    def test_missing_tools_explain_installation_without_creating_files(self, which):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(RuntimeError, "brew install yt-dlp"):
                download.download("https://example.com/watch", folder=folder, source_kind="page")
            with self.assertRaisesRegex(RuntimeError, "brew install yt-dlp ffmpeg"):
                download.download("https://example.com/master.m3u8", folder=folder)
            self.assertEqual(list(Path(folder).iterdir()), [])

    @patch("download.run_ytdlp", return_value="saved.mp4")
    @patch("download.shutil.which", return_value="yt-dlp")
    @patch("download.urllib.request.urlopen")
    def test_explicit_page_skips_probe_and_keeps_headers(self, urlopen, which, ytdlp):
        result = download.download("https://example.com/watch", source_kind="page",
                                   browser_headers={"Cookie": "session", "User-Agent": "browser"},
                                   referer="https://example.com/")
        self.assertEqual(result, "saved.mp4")
        urlopen.assert_not_called()
        self.assertEqual(ytdlp.call_args.args[3], {"Cookie": "session", "User-Agent": "browser", "Referer": "https://example.com/"})

    @patch("download.run_ytdlp", return_value="saved.mp4")
    @patch("download.shutil.which", return_value="yt-dlp")
    @patch("download.urllib.request.urlopen")
    def test_blocked_page_falls_back_but_direct_error_does_not(self, urlopen, which, ytdlp):
        def denied(*args, **kwargs):
            raise urllib.error.HTTPError("https://example.com/watch", 403, "Forbidden", {}, None)
        urlopen.side_effect = denied
        self.assertEqual(download.download("https://example.com/watch"), "saved.mp4")
        for url, kind in [("https://example.com/video.mp4", "auto"), ("https://example.com/file", "direct")]:
            with self.assertRaises(urllib.error.HTTPError):
                download.download(url, source_kind=kind)
        self.assertEqual(ytdlp.call_count, 1)

    @patch("download.run_ytdlp", return_value="saved.mp4")
    @patch("download.shutil.which", return_value="yt-dlp")
    @patch("download.urllib.request.urlopen")
    def test_html_and_xhtml_are_pages(self, urlopen, which, ytdlp):
        for content_type in ("text/html", "application/xhtml+xml"):
            urlopen.return_value = Response(b"<html></html>", content_type=content_type)
            self.assertEqual(download.download("https://example.com/watch"), "saved.mp4")
        self.assertEqual(ytdlp.call_count, 2)


class TransferTests(unittest.TestCase):
    def test_tls_fallback_preserves_request_and_stops_after_one_retry(self):
        command = ['yt-dlp', '--impersonate', 'chrome', '--add-headers', 'Cookie:context',
                   '--', 'https://example.com/master.m3u8?token=full']
        with patch('download.run_tool', side_effect=[RuntimeError('curl: (35) SSL_connect'), None]) as run:
            download.run_ytdlp_tool(command, lambda _: None)
        self.assertEqual(run.call_count, 2)
        self.assertEqual(run.call_args.args[0], command[:1] + command[3:])
        with patch('download.run_tool', side_effect=RuntimeError('curl: (35) SSL_connect')) as run:
            with self.assertRaises(RuntimeError):
                download.run_ytdlp_tool(command, lambda _: None)
        self.assertEqual(run.call_count, 2)

    def test_tls_fallback_does_not_restart_partial_transfer_or_other_errors(self):
        command = ['yt-dlp', '--impersonate', 'chrome', '--', 'https://example.com/video']
        def partial(command, receive, cancel, **controls):
            receive('1024 4096')
            raise RuntimeError('curl: (35) SSL_connect')
        for effect in (partial, RuntimeError('curl: (28) timed out'), download.Cancelled()):
            with patch('download.run_tool', side_effect=effect) as run:
                with self.assertRaises((RuntimeError, download.Cancelled)):
                    download.run_ytdlp_tool(command, lambda _: None)
                self.assertEqual(run.call_count, 1)

    @patch("download.shutil.which", return_value="yt-dlp")
    def test_explicit_ids_become_literal_filters_and_no_quality_fallback(self, which):
        with tempfile.TemporaryDirectory() as folder:
            saved = Path(folder, "selected.mp4")
            saved.write_bytes(b"done")
            def finish(command, on_line, cancel, **controls):
                self.assertEqual(command[command.index("-f") + 1], "all[format_id='best']+all[format_id='ru']")
                self.assertIn("--ignore-config", command)
                self.assertIn("--audio-multistreams", command)
                Path(command[command.index("--print-to-file") + 2]).write_text(str(saved))
            with patch("download.run_tool", side_effect=finish):
                self.assertEqual(download.run_ytdlp("https://example.com/watch", folder, "chosen", {}, lambda *_: None,
                                                   format_ids=["best", "ru"]), str(saved))

    def test_save_does_not_overwrite_and_removes_incomplete(self):
        with tempfile.TemporaryDirectory() as folder:
            Path(folder, "video.mp4").write_bytes(b"original")
            saved = download.save(Response(b"new"), folder, None, lambda *_: None)
            self.assertEqual(Path(saved).name, "video (1).mp4")
            self.assertEqual(Path(saved).read_bytes(), b"new")
            self.assertEqual(Path(folder, "video.mp4").read_bytes(), b"original")
            with self.assertRaisesRegex(RuntimeError, "не полностью"):
                download.save(Response(b"short", total=1000), folder, None, lambda *_: None)
            self.assertFalse(list(Path(folder).glob("*.part")))
            self.assertFalse(Path(folder, "video (2).mp4").exists())

    def test_cancel_direct_removes_partial_file(self):
        cancel = threading.Event()
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(download.Cancelled):
                download.save(Response(b"x" * (download.CHUNK_SIZE * 3)), folder, None,
                              lambda *_: cancel.set(), cancel)
            self.assertEqual(list(Path(folder).iterdir()), [])

    def test_silent_subprocess_can_be_cancelled(self):
        cancel = threading.Event()
        timer = threading.Timer(0.2, cancel.set)
        timer.start()
        start = time.monotonic()
        try:
            with self.assertRaises(download.Cancelled):
                download.run_tool([sys.executable, "-c", "import time; time.sleep(10)"], lambda *_: None, cancel)
        finally:
            timer.cancel()
        self.assertLess(time.monotonic() - start, 4)

    def test_callback_failure_stops_subprocess(self):
        def fail(line):
            raise RuntimeError("callback failed")
        start = time.monotonic()
        with self.assertRaisesRegex(RuntimeError, "callback failed"):
            download.run_tool([sys.executable, "-u", "-c", "import time; print('ready'); time.sleep(10)"], fail)
        self.assertLess(time.monotonic() - start, 4)

    @unittest.skipUnless(os.name == "posix", "POSIX process groups")
    def test_cancellation_kills_descendants(self):
        cancel = threading.Event()
        pids = []
        script = ("import os,subprocess,sys,time; "
                  "child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(10)']); "
                  "print(str(os.getpid())+' '+str(child.pid),flush=True); time.sleep(10)")

        def ready(line):
            pids.extend(map(int, line.split()))
            cancel.set()

        with self.assertRaises(download.Cancelled):
            download.run_tool([sys.executable, "-u", "-c", script], ready, cancel)
        for pid in pids:
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)

    @patch("download.shutil.which", return_value="ffmpeg")
    @patch("download.stream_duration", side_effect=download.Cancelled)
    def test_cancel_during_probe_removes_reservation(self, duration, which):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(download.Cancelled):
                download.download_stream_ffmpeg("https://example.com/master.m3u8", folder, "video", {}, lambda *_: None)
            self.assertEqual(list(Path(folder).iterdir()), [])

    @patch("download.shutil.which", return_value="yt-dlp")
    @patch("download.run_tool", side_effect=download.Cancelled)
    def test_cancel_ytdlp_removes_reservation(self, tool, which):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(download.Cancelled):
                download.run_ytdlp("https://example.com/watch", folder, "video", {}, lambda *_: None)
            self.assertEqual(list(Path(folder).iterdir()), [])

    @patch("download.shutil.which", return_value="yt-dlp")
    def test_ytdlp_completed_file_survives_late_cancel(self, which):
        with tempfile.TemporaryDirectory() as folder:
            completed = Path(folder, "video.mp4")

            def finish_then_cancel(command, on_line, cancel, **controls):
                completed.write_bytes(b"finished")
                receipt = command[command.index("--print-to-file") + 2]
                Path(receipt).write_text(str(completed))
                raise download.Cancelled

            with patch("download.run_tool", side_effect=finish_then_cancel):
                result = download.run_ytdlp("https://example.com/watch", folder, "video", {}, lambda *_: None)
            self.assertEqual(result, str(completed))
            self.assertEqual(completed.read_bytes(), b"finished")
            self.assertFalse(list(Path(folder).glob("*.part")))


if __name__ == "__main__":
    unittest.main()
