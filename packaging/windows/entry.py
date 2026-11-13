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
    import native_host
    native_host.main()
