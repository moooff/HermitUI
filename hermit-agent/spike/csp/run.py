"""CSP allow-list spike: page + workers vs. servers, hits are ground truth."""
import base64, hashlib, json, pathlib, ssl, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(line_buffering=True)
HERE = pathlib.Path(__file__).resolve().parent
PAGE = (HERE / "csp-test.html").read_bytes()
import socket as _s, subprocess, tempfile
def _lan_ip():  # the address the default route leaves from (WSL mirrored: the LAN IP)
    u = _s.socket(_s.AF_INET, _s.SOCK_DGRAM); u.connect(("192.0.2.1", 9)); ip = u.getsockname()[0]; u.close(); return ip
LAN_IP = _lan_ip()
CERT_DIR = pathlib.Path(tempfile.mkdtemp())  # throwaway self-signed cert for the https page
subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-days", "1",
                "-keyout", str(CERT_DIR / "key.pem"), "-out", str(CERT_DIR / "cert.pem")], check=True, capture_output=True)
CDN = "https://cdn.jsdelivr.net/pyodide/v0.29.5/full/"
HITS = []  # (server name, path)


def make_handler(name):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_OPTIONS(self):
            HITS.append((name, "OPTIONS " + self.path))
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Allow-Headers", "*")
            self.end_headers()

        def do_GET(self):
            if self.path.startswith("/csp-test.html"):
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write(PAGE)
                return
            HITS.append((name, self.path))
            key = self.headers.get("Sec-WebSocket-Key")
            if key:
                acc = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
                self.send_response(101)
                self.send_header("Upgrade", "websocket")
                self.send_header("Connection", "Upgrade")
                self.send_header("Sec-WebSocket-Accept", acc)
                self.end_headers()
                time.sleep(0.5)
                return
            self.send_response(200)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"hi")
    return H


def serve(name, host, tls=False):
    s = ThreadingHTTPServer((host, 0), make_handler(name))
    if tls:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(CERT_DIR / "cert.pem", CERT_DIR / "key.pem")
        s.socket = ctx.wrap_socket(s.socket, server_side=True)
    threading.Thread(target=s.serve_forever, daemon=True).start()
    return s.server_address[1]


P_END = serve("endpoint", "127.0.0.1")
P_EVIL = serve("evil", "127.0.0.1")
P_LAN = serve("lan", LAN_IP)
P_PAGE = serve("pagehost", "127.0.0.1")
P_TLS = serve("pagehost-tls", "127.0.0.1", tls=True)

ORIGINS = {
    "file": (HERE / "csp-test.html").as_uri(),
    "http-localhost": f"http://localhost:{P_PAGE}/csp-test.html",
    "https-public": f"https://localhost:{P_TLS}/csp-test.html",  # Chromium: overridden to the public address space
}


def scenario(endpoint):
    end = f"http://127.0.0.1:{P_END}" if endpoint == "loopback" else f"http://{LAN_IP}:{P_LAN}"
    targets = {
        "http": {
            "endpoint-loopback": {"url": f"http://127.0.0.1:{P_END}"},
            "endpoint-lan": {"url": f"http://{LAN_IP}:{P_LAN}", "las": "local"},
            "evil": {"url": f"http://127.0.0.1:{P_EVIL}"},
        },
        "ws": {
            "endpoint-loopback": f"ws://127.0.0.1:{P_END}",
            "evil": f"ws://127.0.0.1:{P_EVIL}",
        },
    }
    return {"allow": [end, "https://cdn.jsdelivr.net"], "targets": targets, "cdn": CDN}


def summarize(res, label):
    print(f"\n=== {label}")
    print("inserted:", res.get("inserted"))
    for ctx in ("pre_page", "page"):
        print(f"  [{ctx}]", json.dumps(res[ctx]))
    print("  page violations:", json.dumps(res["page_violations"]))
    for w in ("workerA", "workerB"):
        r = res[w]
        print(f"  [{w}]", json.dumps(r.get("results") if r.get("ok") else r))
        print(f"  {w} violations:", json.dumps(r.get("violations")))
    if "pyodideB" in res:
        print("  [pyodideB]", json.dumps(res["pyodideB"]))


def hits_by_ctx():
    out = {}
    for name, path in HITS:
        via = path.split("via=")[-1] if "via=" in path else path
        out.setdefault(name, []).append(via)
    return out


with sync_playwright() as pw:
    for bname in ("chromium", "firefox"):
        btype = getattr(pw, bname)
        args = [f"--ip-address-space-overrides=127.0.0.1:{P_TLS}=public"] if bname == "chromium" else []
        browser = btype.launch(args=args)
        print(f"\n##### {bname} {browser.version}")
        for oname, url in ORIGINS.items():
            for endpoint in ("loopback", "lan"):
                ctx = browser.new_context(ignore_https_errors=True)
                if bname == "chromium":
                    for perm in (["local-network-access"], ["local-network"], ["loopback-network"]):
                        try:
                            ctx.grant_permissions(perm)
                            print("granted", perm)
                        except Exception as e:
                            print("grant failed", perm, str(e).splitlines()[0][:100])
                page = ctx.new_page()
                console = []
                page.on("console", lambda m: console.append(m.text[:200]))
                HITS.clear()
                label = f"{bname} / {oname} / endpoint={endpoint}"
                print(f"\n... {label}: loading")
                page.goto(url)
                P = scenario(endpoint)
                P["pyodide"] = endpoint == "loopback"
                try:
                    res = page.evaluate("P => runSpike(P)", P)
                    summarize(res, label)
                except Exception as e:
                    print("  RUN FAILED", str(e)[:400])
                time.sleep(0.5)
                print("  SERVER HITS:", json.dumps(hits_by_ctx()))
                if console:
                    print("  console:", json.dumps(console[:12]))
                ctx.close()
        browser.close()
