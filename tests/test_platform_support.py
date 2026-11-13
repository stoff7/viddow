import concurrent.futures
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

import download
import platform_support as platform
from test_download import Response


class FinalizationTests(unittest.TestCase):
    def test_direct_file_created_during_download_survives(self):
        with tempfile.TemporaryDirectory() as directory:
            existing = Path(directory, "video.mp4")
            def progress(*_):
                existing.write_bytes(b"other application")
            saved = download.save(Response(b"our download"), directory, None, progress)
            self.assertEqual(existing.read_bytes(), b"other application")
            self.assertEqual(Path(saved).name, "video (1).mp4")
            self.assertEqual(Path(saved).read_bytes(), b"our download")
            self.assertFalse(list(Path(directory).glob("*.part")))

    def test_ffmpeg_file_created_before_finalization_survives(self):
        with tempfile.TemporaryDirectory() as directory:
            existing = Path(directory, "video.mp4")
            def ffmpeg(command, *args):
                Path(command[-1]).write_bytes(b"stream result")
                existing.write_bytes(b"external result")
            with patch("download.resolve_tool", return_value="ffmpeg"), patch("download.stream_duration", return_value=None), patch("download.run_tool", side_effect=ffmpeg):
                saved = download.download_stream_ffmpeg("https://example.test/live.m3u8", directory, "video", {}, lambda *_: None)
            self.assertEqual(existing.read_bytes(), b"external result")
            self.assertEqual(Path(saved).read_bytes(), b"stream result")
            self.assertEqual(Path(saved).name, "video (1).mp4")
            self.assertFalse(list(Path(directory).glob("*.part")))

    def test_repeated_race_cleans_only_our_reservations(self):
        with tempfile.TemporaryDirectory() as directory:
            desired = Path(directory, "video.mp4")
            part = Path(download.reserve(directory, desired.name) + ".part")
            part.write_bytes(b"download")
            real_move = download.move_file_no_replace
            calls = []
            def conflict(source, destination):
                calls.append(destination)
                if len(calls) <= 2:
                    Path(destination).write_bytes(b"external")
                return real_move(source, destination)
            with patch("download.move_file_no_replace", side_effect=conflict):
                final = download.finalize_file(str(part), str(desired))
            self.assertEqual(Path(final).name, "video (2).mp4")
            self.assertEqual(desired.read_bytes(), b"external")
            self.assertEqual(Path(directory, "video (1).mp4").read_bytes(), b"external")
            self.assertEqual(Path(final).read_bytes(), b"download")
            self.assertFalse(list(Path(directory).glob("*.part")))

    def test_conflict_with_broken_symlink_does_not_replace_it(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory, "video.mp4")
            part = Path(download.reserve(directory, target.name) + ".part")
            part.write_bytes(b"complete")
            try:
                target.symlink_to(Path(directory, "missing"))
            except (OSError, NotImplementedError):
                self.skipTest("Symlink creation unavailable")
            result = download.finalize_file(str(part), str(target))
            self.assertTrue(target.is_symlink())
            self.assertEqual(Path(result).read_bytes(), b"complete")

    def test_concurrent_processes_publish_distinct_complete_files(self):
        # Separate interpreters exercise filesystem arbitration, not one lock.
        with tempfile.TemporaryDirectory() as directory:
            script = """import sys
from pathlib import Path
import download
root, number = sys.argv[1:]
part = Path(root, number + '.part')
part.write_bytes(number.encode() * 100)
print(download.finalize_file(str(part), str(Path(root, 'video.mp4'))))
"""
            def run(number):
                return subprocess.check_output([sys.executable, "-c", script, directory, str(number)], text=True).strip()
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                paths = list(pool.map(run, range(8)))
            self.assertEqual(len(set(paths)), 8)
            for number, path in enumerate(paths):
                self.assertEqual(Path(path).read_bytes(), str(number).encode() * 100)
            self.assertFalse(list(Path(directory).glob("*.part")))

    def test_failed_publication_and_cancel_remove_reservations_not_external_file(self):
        for cancelled in (False, True):
            with self.subTest(cancelled=cancelled), tempfile.TemporaryDirectory() as directory:
                existing = Path(directory, "video.mp4")
                cancel = threading.Event()
                def progress(*_):
                    existing.write_bytes(b"keep")
                real_move = download.move_file_no_replace
                def move(source, target):
                    if Path(target).name != existing.name:
                        if cancelled:
                            cancel.set()
                            raise download.Cancelled()
                        raise PermissionError("read-only destination")
                    return real_move(source, target)
                with patch("download.move_file_no_replace", side_effect=move):
                    with self.assertRaises(download.Cancelled if cancelled else PermissionError):
                        download.save(Response(b"complete"), directory, None, progress, cancel)
                self.assertEqual(existing.read_bytes(), b"keep")
                self.assertEqual(list(Path(directory).iterdir()), [existing])


class ToolResolverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / "bundle"
        self.bin.mkdir()
        environment = {key: value for key, value in os.environ.items() if key not in platform.TOOL_ENV.values()}
        environment["PATH"] = ""
        self.env = patch.dict(os.environ, environment, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.bundle = patch.object(platform, "BIN_DIR", self.bin)
        self.bundle.start()
        self.addCleanup(self.bundle.stop)

    def tool(self, directory, name="yt-dlp"):
        directory.mkdir(exist_ok=True)
        path = directory / (name + (".exe" if sys.platform == "win32" else ""))
        path.write_bytes(b"fixture")
        path.chmod(path.stat().st_mode | stat.S_IXUSR)
        return str(path)

    def test_explicit_bundle_path_priority_and_invalid_override(self):
        system = self.root / "system"
        fallback = self.tool(system)
        os.environ["PATH"] = str(system)
        self.assertEqual(platform.resolve_tool("yt-dlp"), fallback)
        bundled = self.tool(self.bin)
        self.assertEqual(platform.resolve_tool("yt-dlp"), bundled)
        explicit = self.tool(self.root / "explicit")
        os.environ["VIDDOW_YT_DLP"] = explicit
        self.assertEqual(platform.resolve_tool("yt-dlp"), explicit)
        for invalid in ("", "relative/yt-dlp", str(self.root / "missing"), str(self.bin)):
            os.environ["VIDDOW_YT_DLP"] = invalid
            with self.subTest(invalid=invalid), self.assertRaises(platform.ToolConfigurationError):
                platform.resolve_tool("yt-dlp")
            self.assertFalse(platform.tool_status()["yt_dlp"])

    def test_no_cwd_relative_path_shell_or_unknown_tool(self):
        local = self.root / "cwd"
        local_tool = self.tool(local)
        for suffix in ("cmd", "bat"):
            shell = local / ("yt-dlp." + suffix)
            shell.write_text("echo no")
            shell.chmod(0o700)
        old_cwd = os.getcwd()
        os.chdir(local)
        self.addCleanup(os.chdir, old_cwd)
        os.environ["PATH"] = os.pathsep.join(["", ".", str(local), "relative"])
        self.assertNotEqual(platform.resolve_tool("yt-dlp"), local_tool)
        self.assertNotIn(str(local), platform._path_dirs())
        self.assertTrue(all(os.path.isabs(path) for path in platform._path_dirs()))
        os.environ["VIDDOW_YT_DLP"] = str(local / "yt-dlp.cmd")
        with self.assertRaises(platform.ToolConfigurationError):
            platform.resolve_tool("yt-dlp")
        with self.assertRaises(ValueError):
            platform.resolve_tool("python")

    @unittest.skipUnless(os.name == "posix", "Homebrew paths use POSIX semantics")
    def test_homebrew_fallback_and_child_environment_leave_parent_unchanged(self):
        directory = self.root / "tools"
        os.environ["PATH"] = os.pathsep.join(["", ".", str(directory)])
        before = dict(os.environ)
        with patch.object(platform.sys, "platform", "darwin"):
            environment = platform.tool_environment()
        paths = environment["PATH"].split(os.pathsep)
        self.assertEqual(paths, [str(directory), "/opt/homebrew/bin", "/usr/local/bin"])
        self.assertEqual(dict(os.environ), before)
        self.assertEqual(environment["PYTHONIOENCODING"], "utf-8")

    def test_ffmpeg_dependency_pair_and_runtime_absolute_path(self):
        ffmpeg = self.tool(self.bin, "ffmpeg")
        self.tool(self.bin, "ffprobe")
        self.assertEqual(platform.ytdlp_dependency_args(), ["--ffmpeg-location", ffmpeg])
        os.environ["VIDDOW_FFPROBE"] = self.tool(self.root / "elsewhere", "ffprobe")
        with self.assertRaises(platform.ToolConfigurationError):
            platform.ytdlp_dependency_args()
        del os.environ["VIDDOW_FFPROBE"]
        deno = self.tool(self.bin, "deno")
        from source_auth import ytdlp_auth_args
        self.assertEqual(ytdlp_auth_args("https://youtu.be/example"),
                         ["--no-js-runtimes", "--js-runtimes", f"deno:{deno}"])

    def test_child_does_not_read_host_stdin_and_uses_utf8(self):
        lines = []
        download.run_tool([sys.executable, "-c", "import sys; print('Видео'); print(repr(sys.stdin.read()))"], lines.append)
        self.assertEqual(lines, ["Видео", "''"])


if __name__ == "__main__":
    unittest.main()
