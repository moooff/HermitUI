"""Network audit of the built app: one short agent run, every connection logged.

    python3 build.py && ../benchmark/.venv/bin/python tests/e2e_network.py [--log out.json]

Runs on every change (see tests/README.md); findings in DESIGN §10. Needs cdn.jsdelivr.net.

Two independent views of the traffic:
  1. A logging proxy that headless Chromium is forced through, loopback included, so
     every connection from the page, its worker and the browser itself shows up
     (HTTPS as CONNECT host:port).
  2. Playwright's request events: full URL, method, headers and post body.
A canary sits in the task, in an uploaded file and in the API key. The task loads
numpy, pandas and matplotlib from the Pyodide CDN and tabulate from the bundle. The
canary may only reach the mock endpoint; the only third-party host allowed is the
CDN, with plain GETs of wheels under the pinned Pyodide path.
"""
import json
import pathlib
import select
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(line_buffering=True)
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from mock_openai import serve  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
APP_URL = (ROOT / "dist" / "hermit-agent-standalone.html").as_uri()
CANARY = "CANARY7731xq"
API_KEY = f"sk-{CANARY}-key"
CSV = f"name,amount,note\nalice,120.5,{CANARY}-filedata\nbob,80,x\ncarol,99.5,y\n".encode()
CDN_HOST = "cdn.jsdelivr.net"
FAILS = []


def check(name, cond, detail=""):
    print(("  PASS  " if cond else "  FAIL  ") + name + ("" if cond or not detail else f"\n        {detail}"))
    if not cond:
        FAILS.append(name)


def py(code):
    return {"content": "Next step.\n```python\n" + code.strip("\n") + "\n```"}


SCRIPTS = {"NETAUDIT": [
    py("""
import numpy as np, pandas as pd
df = pd.read_csv("data.csv")
print(df)
print("mean", np.mean(df.amount))
"""),
    py("""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd
df = pd.read_csv("data.csv")
plt.bar(df.name, df.amount); plt.savefig("bars.png")
print("saved")
"""),
    py("""
from tabulate import tabulate
import pandas as pd
print(tabulate(pd.read_csv("data.csv"), headers="keys"))
"""),
    {"content": "Done: summary, chart and table."},
]}

PROXY_LOG = []  # ("CONNECT", "host:port") or (method, url, body)


class Proxy(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_CONNECT(self):
        PROXY_LOG.append(("CONNECT", self.path))
        host, port = self.path.rsplit(":", 1)
        try:
            up = socket.create_connection((host, int(port)), timeout=15)
        except OSError as e:
            self.send_error(502, str(e))
            return
        self.send_response(200)
        self.end_headers()
        socks = [self.connection, up]
        try:
            while True:
                r, _, _ = select.select(socks, [], [], 60)
                if not r:
                    break
                for s in r:
                    d = s.recv(65536)
                    if not d:
                        return
                    (up if s is self.connection else self.connection).sendall(d)
        except OSError:
            pass
        finally:
            up.close()

    def _plain(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else b""
        PROXY_LOG.append((self.command, self.path, body.decode(errors="replace")))
        req = urllib.request.Request(self.path, data=body or None, method=self.command,
                                     headers={k: v for k, v in self.headers.items() if k.lower() not in ("proxy-connection", "host")})
        try:
            resp = urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=60)
            status, hdrs = resp.status, resp.getheaders()
        except urllib.error.HTTPError as e:
            resp, status, hdrs = e, e.code, e.headers.items()
        self.send_response(status)
        for k, v in hdrs:
            if k.lower() not in ("transfer-encoding", "connection"):
                self.send_header(k, v)
        self.send_header("Connection", "close")
        self.end_headers()
        while True:  # stream, so SSE replies arrive as they come
            chunk = resp.read1(4096) if hasattr(resp, "read1") else resp.read(4096)
            if not chunk:
                break
            self.wfile.write(chunk)
            self.wfile.flush()

    do_GET = do_POST = do_OPTIONS = _plain


def wait_for(page, js, value, timeout, what):
    end = time.time() + timeout
    while page.evaluate(js) != value:
        if time.time() > end:
            raise AssertionError(f"timed out after {timeout}s waiting for {what}: "
                                 + page.evaluate("() => JSON.stringify(S.timeline.slice(-2))")[:800])
        time.sleep(0.3)


def main():
    t_start = time.time()
    log_path = sys.argv[sys.argv.index("--log") + 1] if "--log" in sys.argv else None
    _, mport, state = serve(SCRIPTS)
    proxy = ThreadingHTTPServer(("127.0.0.1", 0), Proxy)
    proxy.daemon_threads = True
    threading.Thread(target=proxy.serve_forever, daemon=True).start()
    mock_host = f"127.0.0.1:{mport}"

    reqs = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=[f"--proxy-server=http://127.0.0.1:{proxy.server_address[1]}",
                                           "--proxy-bypass-list=<-loopback>"])
        ctx = browser.new_context()
        ctx.on("request", lambda r: reqs.append({"method": r.method, "url": r.url, "headers": r.headers, "post": r.post_data or ""}))
        page = ctx.new_page()
        print("— opening the app (Pyodide boot)")
        page.goto(APP_URL)
        wait_for(page, "() => PY.state", "idle", 120, "interpreter boot")
        boot_net = [r["url"] for r in reqs if urlsplit(r["url"]).scheme not in ("file", "blob", "data")]
        check("booting the app touches no network", not boot_net and not PROXY_LOG, boot_net + PROXY_LOG)

        page.click("#settingsBtn")
        page.fill("#settingUrl", f"http://{mock_host}/v1")
        page.fill("#settingModelInput", "mock-model")
        page.fill("#settingApiKey", API_KEY)
        page.click("#settingSave")
        page.select_option("#autonomySelect", "autopilot")
        page.set_input_files("#wsFileInput", files=[{"name": "data.csv", "mimeType": "text/csv", "buffer": CSV}])
        page.fill("#taskInput", f"NETAUDIT: summarise data.csv, private note {CANARY}-task")
        print("— running the task (numpy, pandas, matplotlib from the CDN; tabulate bundled)")
        page.click("#sendBtn")
        wait_for(page, "() => S.status", "done", 300, "the task")
        st = page.evaluate("() => S.timeline.filter(t => t.type === 'step' && t.kind !== 'final').map(t => ({ status: t.status, notes: (t.notes || []).join(' | ') }))")
        time.sleep(1)
        browser.close()

    print("— checks")
    check("the three steps ran", [s["status"] for s in st][:3] == ["ok"] * 3, st)
    check("numpy and pandas came from the CDN", "numpy, pandas" in st[0]["notes"] and "from the Pyodide CDN" in st[0]["notes"], st[0]["notes"])
    check("matplotlib came from the CDN", "matplotlib" in st[1]["notes"] and "from the Pyodide CDN" in st[1]["notes"], st[1]["notes"])
    check("tabulate came from the bundle", "Loaded tabulate from the libraries bundled" in st[2]["notes"], st[2]["notes"])

    third = sorted({p[1].rsplit(":", 1)[0] for p in PROXY_LOG if p[0] == "CONNECT"})
    plain = sorted({urlsplit(p[1]).netloc for p in PROXY_LOG if p[0] != "CONNECT"})
    check(f"proxy: the only third-party host is {CDN_HOST}", third == [CDN_HOST], third)
    check("proxy: plain HTTP only to the mock", plain == [mock_host], plain)

    web = [r for r in reqs if urlsplit(r["url"]).scheme in ("http", "https")]
    cdn = [r for r in web if urlsplit(r["url"]).netloc != mock_host]
    check("playwright: every third-party request is a GET of a pinned Pyodide wheel, no query",
          cdn and all(r["method"] == "GET" and urlsplit(r["url"]).netloc == CDN_HOST
                      and urlsplit(r["url"]).path.startswith("/pyodide/v") and r["url"].endswith(".whl")
                      and not urlsplit(r["url"]).query for r in cdn),
          [r["method"] + " " + r["url"] for r in cdn if not r["url"].endswith(".whl") or r["method"] != "GET"])
    check("no cookie or Referer to the CDN",
          not any("cookie" in {k.lower() for k in r["headers"]} or r["headers"].get("referer") for r in cdn))
    leaked = [r["url"] for r in cdn if CANARY in r["url"] + json.dumps(r["headers"]) + r["post"]]
    leaked += [p[1] for p in PROXY_LOG if p[0] != "CONNECT" and urlsplit(p[1]).netloc != mock_host and CANARY in p[1] + p[2]]
    check("the canary reaches no one but the endpoint", not leaked, leaked)
    auth = sorted({urlsplit(r["url"]).netloc for r in web if any(k.lower() == "authorization" for k in r["headers"])})
    check("the API key goes only to the endpoint", auth == [mock_host], auth)
    bodies = json.dumps(state.requests)
    check("the API key is in no request body", API_KEY not in bodies and not any(API_KEY in r["post"] for r in web))
    check("the endpoint got the task and the file (sanity)", CANARY + "-task" in bodies and CANARY + "-filedata" in bodies)
    check("no hits on the mock's /exfil", not state.exfil, state.exfil)

    if log_path:
        pathlib.Path(log_path).write_text(json.dumps({"playwright": reqs, "proxy": PROXY_LOG}, indent=1))
        print(f"  full log: {log_path}")
    print(f"\n{len(cdn)} CDN requests, {len(web) - len(cdn)} to the endpoint; {time.time() - t_start:.0f} s")
    print("ALL PASS" if not FAILS else f"{len(FAILS)} FAILED: " + "; ".join(FAILS))
    sys.exit(1 if FAILS else 0)


main()
