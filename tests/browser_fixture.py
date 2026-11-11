"""Локальные серверы для browser_smoke.cjs; данные живут во временной папке."""
import json
import signal
import sys
import tempfile
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from jobs import JobManager
from server import Handler, Server
from test_server import Source


def stop(*_):
    raise KeyboardInterrupt


signal.signal(signal.SIGTERM, stop)
Handler.log_message = lambda *_: None
with tempfile.TemporaryDirectory(prefix="viddow-browser-") as temporary:
    output = Path(temporary, "Downloads")
    output.mkdir()
    manager = JobManager(workers=2, folder=str(output))
    server = Server(("127.0.0.1", 0), manager)
    source = ThreadingHTTPServer(("127.0.0.1", 0), Source)
    threading.Thread(target=source.serve_forever, daemon=True).start()
    print(json.dumps({"app": f"http://127.0.0.1:{server.server_port}",
                      "source": f"http://127.0.0.1:{source.server_port}"}), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        manager.close()
        server.server_close()
        source.shutdown()
        source.server_close()
