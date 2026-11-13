"""Small OS boundary shared by CLI, web and native host; no registration/UI."""
import ctypes
import os
from pathlib import Path
import sys

BIN_DIR = Path(__file__).absolute().parent / "bin"
TOOL_ENV = {"yt-dlp": "VIDDOW_YT_DLP", "ffmpeg": "VIDDOW_FFMPEG",
            "ffprobe": "VIDDOW_FFPROBE", "deno": "VIDDOW_DENO", "node": "VIDDOW_NODE"}


class ToolConfigurationError(ValueError):
    """An explicitly configured tool is invalid; never silently use another."""


def _executable(path):
    path = Path(path)
    try:
        return (path.is_file() and os.access(path, os.X_OK)
                and path.suffix.lower() not in (".cmd", ".bat")
                and (sys.platform != "win32" or path.suffix.lower() == ".exe"))
    except (OSError, ValueError):
        return False


def _path_dirs():
    """Ignore empty/relative entries and cwd, including aliases through symlinks."""
    result = []
    cwd = os.path.normcase(os.path.realpath(os.getcwd()))
    entries = os.environ.get("PATH", os.defpath).split(os.pathsep)
    if sys.platform == "darwin":
        entries += ["/opt/homebrew/bin", "/usr/local/bin"]
    seen = set()
    for entry in entries:
        if not os.path.isabs(entry):
            continue
        identity = os.path.normcase(os.path.realpath(entry))
        if identity == cwd or identity in seen:
            continue
        seen.add(identity)
        result.append(os.path.abspath(entry))
    return result


def resolve_tool(name):
    """Known logical tool -> absolute executable, preserving bin symlinks."""
    if name not in TOOL_ENV:
        raise ValueError(f"Неизвестный инструмент: {name}")
    variable = TOOL_ENV[name]
    if variable in os.environ:
        path = os.environ[variable]
        if not os.path.isabs(path) or not _executable(path):
            raise ToolConfigurationError(f"{variable}: нужен абсолютный путь к исполняемому {name}: {path!r}")
        return os.path.abspath(path)
    filename = name + (".exe" if sys.platform == "win32" else "")
    for directory in [str(BIN_DIR), *_path_dirs()]:
        candidate = os.path.join(directory, filename)
        if _executable(candidate):
            return os.path.abspath(candidate)
    return None


def tool_status():
    status = {}
    for key, name in (("yt_dlp", "yt-dlp"), ("ffmpeg", "ffmpeg")):
        try:
            status[key] = bool(resolve_tool(name))
        except ToolConfigurationError:
            # State keeps its existing bool schema; the attempted action reports
            # the invalid setting rather than falling back to a different tool.
            status[key] = False
    return status


def tool_environment():
    """Only the child sees this PATH. Never inherit cwd as a search directory."""
    environment = os.environ.copy()
    environment["PATH"] = os.pathsep.join(_path_dirs())
    environment["NoDefaultCurrentDirectoryInExePath"] = "1"
    environment["PYTHONIOENCODING"] = "utf-8"
    return environment


def ytdlp_dependency_args():
    """Pin yt-dlp's media tools too; it expects ffprobe beside ffmpeg."""
    ffmpeg, ffprobe = resolve_tool("ffmpeg"), resolve_tool("ffprobe")
    if not ffmpeg:
        return []
    if ffprobe:
        filename = os.path.basename(ffmpeg)
        companion = filename.replace("ffmpeg", "ffprobe") if "ffmpeg" in filename else (
            "ffprobe.exe" if sys.platform == "win32" else "ffprobe")
        expected = os.path.join(os.path.dirname(ffmpeg), companion)
        if os.path.normcase(expected) != os.path.normcase(ffprobe):
            raise ToolConfigurationError("Для yt-dlp разместите выбранные ffmpeg и ffprobe рядом, с согласованными именами")
    return ["--ffmpeg-location", ffmpeg]


def move_file_no_replace(source, destination):
    """Publish a completed sibling file without a check/rename overwrite race.

    Native exclusive rename on supported systems avoids requiring hard links on
    removable disks. Other POSIX systems use link/unlink, never os.replace.
    """
    if sys.platform == "win32":
        os.rename(source, destination)  # Windows refuses an existing destination.
    elif sys.platform == "darwin":
        libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
        rename = libc.renamex_np
        rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        rename.restype = ctypes.c_int
        if rename(os.fsencode(source), os.fsencode(destination), 0x00000004):  # RENAME_EXCL
            code = ctypes.get_errno()
            raise OSError(code, os.strerror(code), os.fspath(destination))
    else:
        os.link(source, destination)
        os.unlink(source)
