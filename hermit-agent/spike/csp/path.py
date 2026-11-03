import json, pathlib, sys
from playwright.sync_api import sync_playwright
sys.stdout.reconfigure(line_buffering=True)
HERE = pathlib.Path(__file__).resolve().parent
CDN = "https://cdn.jsdelivr.net/pyodide/v0.29.5/full/"
P = {"allow": [CDN, "blob:", "data:"], "pyodide": True, "cdn": CDN,
     "targets": {"http": {"cdn-other-path": {"url": "https://cdn.jsdelivr.net/npm/marked@18.0.6"},
                          "cdn-pinned": {"url": CDN.rstrip("/")}}}}
with sync_playwright() as pw:
    for b in ("chromium", "firefox"):
        br = getattr(pw, b).launch(); pg = br.new_page()
        pg.goto((HERE / "csp-test.html").as_uri())
        r = pg.evaluate("P => runSpike(P)", P)
        print(b, json.dumps({k: r[k] for k in ("inserted", "page")}), "\n  workerB", json.dumps(r["workerB"]), "\n  pyodide", json.dumps(r["pyodideB"])[:300])
        br.close()
