"""Complete inherited quarantine metadata using the public macOS URL API.

Native Messaging inherits the browser's quarantine context. POSIX writes alone
leave a download classified as Sandboxed, unlike a normal browser download.
Keep quarantine enabled; never clear flags or mark a file as user-approved.
"""

import subprocess
import sys
import urllib.parse


_SCRIPT = """
ObjC.import('Foundation');
function run(argv) {
    const url = $.NSURL.fileURLWithPath(argv[0]);
    const value = Ref(), error = Ref();
    if (!url.getResourceValueForKeyError(value, $.NSURLQuarantinePropertiesKey, error))
        throw Error('Cannot read download metadata');
    if (!ObjC.unwrap(value[0])) return;
    const properties = value[0].mutableCopy;
    properties.setObjectForKey('LSQuarantineTypeWebDownload', 'LSQuarantineType');
    if (argv[1]) properties.setObjectForKey(argv[1], 'LSQuarantineDataURL');
    if (argv[2]) properties.setObjectForKey(argv[2], 'LSQuarantineOriginURL');
    if (!url.setResourceValueForKeyError(properties, $.NSURLQuarantinePropertiesKey, error))
        throw Error('Cannot complete download metadata');
}
"""


def _origin(url):
    """Do not persist signed URLs, page queries, credentials or fragments."""
    try:
        parsed = urllib.parse.urlsplit(url or "")
        if parsed.scheme not in ("https", "http") or not parsed.hostname:
            return ""
        host = parsed.hostname
        if ":" in host:
            host = f"[{host}]"
        port = f":{parsed.port}" if parsed.port else ""
        return f"{parsed.scheme}://{host}{port}/"
    except ValueError:
        return ""


def complete_download_metadata(path, source, referer=None):
    """Best effort, only on a just-completed download; never removes quarantine."""
    if sys.platform != "darwin":
        return
    try:
        subprocess.run(
            ["/usr/bin/osascript", "-l", "JavaScript", "-e", _SCRIPT,
             str(path), _origin(source), _origin(referer)],
            check=True, capture_output=True, text=True, timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        # A metadata failure must not turn a complete video into a failed job.
        print("Не удалось оформить метаданные загрузки macOS; файл сохранён.", file=sys.stderr)
