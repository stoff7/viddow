# Windows personal test bundle

14 November 2026. Target: Windows 11 x64; unsigned personal test, version
3.5.0-test.1. No main merge, existing release replacement or public release.

Use one PyInstaller console-mode onedir host and Inno Setup 6.4.3 per-user
installer. Console mode preserves native messaging stdin/stdout; child tools use
CREATE_NO_WINDOW and explicit inherited stdio handles. Browser launch/visibility
must still be checked on the user's Windows desktop. No Python installation,
PATH mutation, service, first-start executable download or additional UI framework.

Immutable layout: `%LOCALAPPDATA%/Programs/Viddow-Test/<version>/` with
ViddowHost.exe, `_internal`, `bin` (yt-dlp, FFmpeg shared DLLs, ffprobe, Deno),
licenses, and components.json. Stable per-browser manifests live in `native/`
beside version directories. Logs: `%LOCALAPPDATA%/Viddow/logs`; video goes to
Windows Known Folder Downloads or the explicitly selected directory. Windows
persistent partial storage stays disabled.

Frozen mode locates resources from sys.executable, ignores development overrides
and global PATH. Install/repair checks every payload hash before registration;
missing tools fail explicitly. Registration validates actual per-browser extension
IDs and checks both HKCU views for conflicts; it writes the 32-bit view, restores
manifest snapshots on failure, and removes only matching owned registrations.
Browser connectivity is separate from registration. No extension installation.

Windows tools use creation-time PROC_THREAD_ATTRIBUTE_JOB_LIST plus explicit
HANDLE_LIST, non-inheritable KILL_ON_JOB_CLOSE job and inherited stdio duplicates.
No unowned spawn fallback. Wait polls without holding ownership lock; stop drains
the entire job before closing handles. Stop always runs after root exit. Prototype
remains isolated for its original regression tests; production adds pipes/env tests.

The full installer repairs the same version. Version directories retain the old
payload for rollback, but automated transactional multi-version upgrade is not
accepted yet. Close browsers and finish downloads before install/repair/uninstall;
Inno must not kill tools or silently replace busy executables. A failed registration
leaves a diagnosable installed payload and preserves the prior registration.

Executables are pinned by URL/version/SHA-256 in components.lock.json. Output
components.json inventories runtime files including license texts and exact hashes.
FFmpeg is the upstream LGPL shared variant, not GPL/nonfree; its complete shipped
notices accompany replaceable DLLs. Archive matching corresponding library sources
before any public distribution. This private test is not public release readiness.

Sources consulted: [PyInstaller onedir/platform rules](https://pyinstaller.org/en/stable/operating-mode.html),
[license exception](https://pyinstaller.org/en/stable/license.html),
[Inno license](https://jrsoftware.org/files/is/license.txt),
[Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging),
[yt-dlp EJS](https://github.com/yt-dlp/yt-dlp/wiki/EJS),
[FFmpeg build variants](https://github.com/FFmpeg-Builds/FFmpeg-Builds).

Acceptance: real installed binary framing/EOF, real WinAPI tree ownership and
pipes, direct/HLS/separate audio/video, repair/corruption/uninstall, Cyrillic paths,
registry ownership. CI Server 2025 results are evidence only for that environment;
Chrome/Edge UI, redirected Downloads, Explorer, ACL failures and Windows 11 remain
explicit user-machine acceptance items.
