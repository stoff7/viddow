"""Frozen console entry: preserve browser pipe handles and binary native stdio."""
import json
import os
from pathlib import Path
import sys

ROOT = Path(sys.executable).resolve().parent
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] in ('--check', '--register', '--unregister'):
        from windows_bundle import manage
        sys.exit(manage(ROOT, sys.argv[1:]))
    import ctypes
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_wchar_p]
    kernel.CreateMutexW.restype = ctypes.c_void_p
    active = kernel.CreateMutexW(None, False, 'Local\\ViddowTestHostActive')
    if not active:
        raise ctypes.WinError(ctypes.get_last_error())
    import native_host
    try:
        native_host.main()
    finally:
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        kernel.CloseHandle(active)
