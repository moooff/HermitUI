#!/usr/bin/env python3
"""Build HermitUI Agent into one self-contained HTML file.

    python3 build.py            # from hermit-agent/ (or any directory)
    python3 build.py --refresh  # re-download every cached library

Reads src/ (index.html, style.css, worker.js, script.js, favicon.svg) and writes
dist/hermit-agent-standalone.html with everything inlined: the CDN libraries (verified
against the SRI pins in src/index.html), the Inter font, and the Pyodide core
(verified against PYODIDE_SHA256 below, gzipped + base64-encoded as
window.__PYODIDE_INLINE__). Downloads are cached in libs/ (gitignored). Like the root
build it fails loudly instead of writing an output that still points at a CDN.

Adapted from ../build.py; it never reads from or writes to anything outside this folder.
"""
import base64
import gzip
import hashlib
import json
import pathlib
import re
import sys
import urllib.request

sys.stdout.reconfigure(line_buffering=True)

ROOT = pathlib.Path(__file__).resolve().parent
SRC = ROOT / "src"
LIBS = ROOT / "libs"
DIST = ROOT / "dist"
MANIFEST = LIBS / ".urls.json"
REFRESH = "--refresh" in sys.argv

# The Pyodide version pin lives in src/script.js (PYODIDE_VERSION / PYODIDE_CDN); these
# hashes pin the exact core files of that release. Bumping Pyodide means updating both.
# Pyodide 0.29.x is deliberate: 314+ refuses classic workers, and Chromium won't start
# a Blob *module* worker on file:// (PHASE0_FINDINGS.md, "Offline boot findings").
PYODIDE_SHA256 = {
    "pyodide.js": "7f832a350240263d9946a9c3c877f7bcdab6c37d6dc65f72cd3be5905dca62dd",
    "pyodide.asm.js": "356c42f69e1695397e9d8670bd3c2e678248cde76e18bdae1731e848537b47d7",
    "pyodide.asm.wasm": "54309a5a2cfd757b1f0fdbc9093c92503f7b341500110329d932487183912718",
    "python_stdlib.zip": "831fd1e535084b972f87c6a35275de3d236efd5166f5e77ce89497710635e73c",
    "pyodide-lock.json": "14d2c2dba101277999e17135e653d8f15389ad1437f53eae213bf0c3cdff723d",
}

# The standalone file's policy: no remote script/style/font host at all, so agent
# code can't import() a remote script (DESIGN §10). Must stay in step with the dev
# policy in src/index.html minus its CDN hosts and local-file sources.
STANDALONE_CSP = ("default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' blob:; "
                  "style-src 'unsafe-inline'; font-src data:; img-src blob: data:; "
                  "connect-src * blob: data:; worker-src blob:; base-uri 'none'; form-action 'none'")

# Regexes for the CDN tags in src/index.html: (cache name, extract-URL pattern, whole-tag pattern).
CDN_TAGS = [
    ("marked.js", r'<script\s+src="(https://cdn\.jsdelivr\.net/npm/marked@[^"]+)"[^>]*></script>'),
    ("dompurify.js", r'<script\s+src="(https://cdn\.jsdelivr\.net/npm/dompurify@[^"]+)"[^>]*></script>'),
    ("highlight.css", r'<link\s+rel="stylesheet"\s+href="(https://cdnjs\.cloudflare\.com/ajax/libs/highlight\.js/[^"]+)"[^>]*>'),
    ("highlight.js", r'<script\s+src="(https://cdnjs\.cloudflare\.com/ajax/libs/highlight\.js/[^"]+)"[^>]*></script>'),
    ("inter.css", r'<link\s+href="(https://fonts\.googleapis\.com/css2[^"]+)"\s+rel="stylesheet"\s*>'),
]
BROWSER_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")


def fail(msg):
    print("❌ " + msg)
    sys.exit(1)


def fetch(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.read()
    except Exception as e:
        fail(f"Failed to fetch {url}: {e}")


def escape_script_close(js):
    return re.sub(r'</(script)', r'<\\/\1', js, flags=re.IGNORECASE)


def replace_once(text, old, new, what):
    if text.count(old) != 1:
        fail(f"{what}: expected exactly one match in src/index.html, found {text.count(old)}.")
    return text.replace(old, new)


def main():
    LIBS.mkdir(exist_ok=True)
    (LIBS / "fonts").mkdir(exist_ok=True)
    DIST.mkdir(exist_ok=True)
    manifest = {}
    if MANIFEST.exists():
        try:
            manifest = json.loads(MANIFEST.read_text())
        except Exception:
            manifest = {}

    html = (SRC / "index.html").read_text(encoding="utf-8")
    css = (SRC / "style.css").read_text(encoding="utf-8")
    worker_js = (SRC / "worker.js").read_text(encoding="utf-8")
    script_js = (SRC / "script.js").read_text(encoding="utf-8")
    integrity = dict(re.findall(r'(?:src|href)="(https://[^"]+)"[^>]*?integrity="(sha384-[^"]+)"', html))

    def cached(url, name, check=None, headers=None):
        path = LIBS / name
        if not REFRESH and manifest.get(name) == url and path.exists():
            data = path.read_bytes()
            print(f"  -> {name} (cached)")
        else:
            print(f"  -> fetching {name} …")
            data = fetch(url, headers)
        if len(data) < 256:
            fail(f"{name}: implausibly small response ({len(data)} bytes) from {url}.")
        if url in integrity:
            digest = "sha384-" + base64.b64encode(hashlib.sha384(data).digest()).decode()
            if digest != integrity[url]:
                fail(f"{name}: sha384 mismatch against the SRI pin in src/index.html ({url}).")
        if check and hashlib.sha256(data).hexdigest() != check:
            fail(f"{name}: sha256 mismatch against PYODIDE_SHA256 in build.py ({url}).")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        manifest[name] = url
        MANIFEST.write_text(json.dumps(manifest, indent=1))
        return data

    print("📥 Libraries")
    libs = {}
    for name, pattern in CDN_TAGS:
        m = re.search(pattern, html)
        if not m:
            fail(f"{name}: CDN tag not found in src/index.html.")
        headers = {"User-Agent": BROWSER_UA} if "fonts.googleapis.com" in m.group(1) else None
        libs[name] = cached(m.group(1), name if name != "inter.css" else "inter-google.css", headers=headers)

    # Inter: inline every woff2 as a data: URL (font-src data: in the CSP).
    inter_css = libs["inter.css"].decode()
    font_urls = sorted(set(re.findall(r'url\((https://[^)]+\.woff2)\)', inter_css)))
    if not font_urls:
        fail("No woff2 URLs in the Google Fonts CSS (format changed, or a stale cache: try --refresh).")
    for url in font_urls:
        data = cached(url, "fonts/" + url.rsplit("/", 1)[-1])
        inter_css = inter_css.replace(url, "data:font/woff2;base64," + base64.b64encode(data).decode())

    print("📥 Pyodide core")
    m = re.search(r'const PYODIDE_CDN = "([^"]+)";', script_js)
    v = re.search(r'const PYODIDE_VERSION = "([^"]+)";', script_js)
    if not m or not v or v.group(1) not in m.group(1):
        fail("PYODIDE_VERSION / PYODIDE_CDN not found (or disagreeing) in src/script.js.")
    inline = {}
    raw_total = 0
    for name, sha in PYODIDE_SHA256.items():
        data = cached(m.group(1) + name, f"pyodide-{v.group(1)}/{name}", check=sha)
        raw_total += len(data)
        inline[name] = base64.b64encode(gzip.compress(data, 9)).decode()
    pyodide_script = "<script>window.__PYODIDE_INLINE__ = " + json.dumps(inline) + ";</script>"

    if re.search(r'</style', css, re.IGNORECASE):
        fail("src/style.css contains a literal '</style'.")

    print("🔨 Assembling")
    out = html
    out, n = re.subn(r'(<meta http-equiv="Content-Security-Policy" content=")[^"]*(")',
                     lambda mm: mm.group(1) + STANDALONE_CSP + mm.group(2), out)
    if n != 1:
        fail("Content-Security-Policy <meta> not found in src/index.html.")
    for name, pattern in CDN_TAGS:
        body = libs[name].decode() if name != "inter.css" else inter_css
        tag = (f"<style>{body}</style>" if name.endswith(".css")
               else f"<script>{escape_script_close(body)}</script>")
        out, n = re.subn(pattern, lambda mm, t=tag: t, out)
        if n != 1:
            fail(f"inlining {name}: expected one tag, found {n}.")
    out = replace_once(out, '<link rel="stylesheet" href="style.css">', f"<style>\n{css}\n</style>", "style.css")
    out = replace_once(out, '<script src="worker.js"></script>', f"<script>\n{escape_script_close(worker_js)}\n</script>", "worker.js")
    out = replace_once(out, '<script src="script.js"></script>', f"<script>\n{escape_script_close(script_js)}\n</script>", "script.js")
    out = replace_once(out, "<!-- @pyodide:inline -->", pyodide_script, "@pyodide:inline placeholder")
    favicon = base64.b64encode((SRC / "favicon.svg").read_bytes()).decode()
    out = replace_once(out, '<link rel="icon" href="favicon.svg">',
                       f'<link rel="icon" href="data:image/svg+xml;base64,{favicon}">', "favicon")
    if re.search(r'(?:src|href)="https?://', out):
        fail("The standalone output still references a remote URL.")

    target = DIST / "hermit-agent-standalone.html"
    target.write_text(out, encoding="utf-8")
    print(f"  ✅ {target.relative_to(ROOT)}: {target.stat().st_size / 1e6:.2f} MB "
          f"(Pyodide core {raw_total / 1e6:.1f} MB raw)")


if __name__ == "__main__":
    main()
