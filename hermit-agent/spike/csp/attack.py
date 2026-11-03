import json, pathlib, socket, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(line_buffering=True)
HERE = pathlib.Path(__file__).resolve().parent
HITS = []
CDN = "https://cdn.jsdelivr.net/pyodide/v0.29.5/full/"


class Evil(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _hit(self):
        HITS.append(("evil-tcp", self.command + " " + self.path.split("via=")[-1]))
        self.send_response(200); self.send_header("Access-Control-Allow-Origin", "*"); self.end_headers(); self.wfile.write(b"x")
    do_GET = do_POST = _hit


class Endpoint(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path.startswith("/redirect"):
            HITS.append(("endpoint", "redirect " + self.path.split("via=")[-1]))
            self.send_response(302); self.send_header("Location", EVIL + "/?via=followed-redirect")
            self.send_header("Access-Control-Allow-Origin", "*"); self.end_headers(); return
        self.send_response(200); self.end_headers()


def serve(h):
    s = ThreadingHTTPServer(("127.0.0.1", 0), h); threading.Thread(target=s.serve_forever, daemon=True).start(); return s.server_address[1]


EVIL_PORT = serve(Evil); EVIL = f"http://127.0.0.1:{EVIL_PORT}"
END = f"http://127.0.0.1:{serve(Endpoint)}"
udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); udp.bind(("127.0.0.1", EVIL_PORT))  # WebTransport (QUIC) + STUN
def udp_loop():
    while True:
        data, addr = udp.recvfrom(4096); HITS.append(("evil-udp", f"{len(data)} bytes"))
threading.Thread(target=udp_loop, daemon=True).start()

E = {"evil": EVIL, "evilPort": EVIL_PORT, "udpPort": EVIL_PORT, "endpoint": END, "cdn": CDN, "allow": [END, CDN, "blob:", "data:"]}
with sync_playwright() as pw:
    for b in ("chromium", "firefox"):
        br = getattr(pw, b).launch(); pg = br.new_page()
        HITS.clear()
        pg.goto((HERE / "attack.html").as_uri())
        r = pg.evaluate("E => runAttacks(E)", E)
        time.sleep(1.5)
        print(f"\n##### {b} {br.version}")
        for side in ("worker", "page"):
            print(f"  [{side}]")
            for name, v in (r[side] if isinstance(r[side], list) else [["?", r[side]]]):
                print(f"    {name:32} {v}")
        print("  HITS:", json.dumps(HITS))
        br.close()
