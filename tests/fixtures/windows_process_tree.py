"""Harmless process fixture. Each leaf self-exits within 30 seconds."""
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
mode, directory = sys.argv[1:]
directory = Path(directory)

if mode == "leaf":
    with (directory / "locked.tmp").open("w") as locked:
        locked.write("temporary test file")
        locked.flush()
        (directory / "leaf.pid").write_text(str(os.getpid()))
        time.sleep(30)
elif mode == "parent":
    subprocess.Popen([sys.executable, __file__, "leaf", str(directory)], close_fds=True)
elif mode in ("controller", "nested"):
    if os.environ.get('VIDDOW_TEST_JOB_IMPLEMENTATION') == 'production':
        from windows_process import JobProcess
    else:
        from prototypes.windows_job import JobProcess
    owner = JobProcess([sys.executable, __file__, "parent", str(directory)])
    try:
        owner.wait()
        (directory / "controller.ready").touch()
        if mode == "controller":
            sys.stdin.buffer.read()  # real EOF from test; parent exit is tested separately
        else:
            deadline = time.monotonic() + 20
            while not (directory / "release").exists() and time.monotonic() < deadline:
                time.sleep(0.01)
    finally:
        owner.stop()
