#!/usr/bin/env python3
"""Serve the repo root on 127.0.0.1 with COOP/COEP headers.

wllama's multithreaded WASM needs crossOriginIsolated, which plain
`python -m http.server` doesn't provide. Serving page and models from one
origin also avoids CORS entirely. Stdlib only.
"""
import argparse
import http.server
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(REPO_ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):  # keep benchmark output readable
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8471)
    args = ap.parse_args()
    server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"serving {REPO_ROOT} on http://127.0.0.1:{args.port} (COOP/COEP on)")
    server.serve_forever()


if __name__ == "__main__":
    main()
