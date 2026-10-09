#!/usr/bin/env python3
"""Build HermitUI Cleaner into one self-contained HTML file.

    python3 build.py            # from hermit-cleaner/ (or any directory)
    python3 build.py --refresh  # re-download the cached font files

Reads src/ (index.html, style.css, script.js, favicon.svg) and writes two files with
everything inlined (the stylesheet, the script, the favicon and the Inter font as
data: URLs):
- dist/hermit-cleaner-standalone.html: the @wllama:start/@wllama:end blocks stripped.
- dist/hermit-cleaner-wllama.html: with them, plus the wllama engine (JS + wasm,
  pinned by WLLAMA_CDN_BASE in src/script.js), gzipped + base64-encoded as
  window.__WLLAMA_INLINE__, so a model loads without any network access.
Downloads are cached in libs/ (gitignored). Like the root build it fails loudly
instead of writing an output that still points at a remote host.

Adapted from ../hermit-agent/build.py; it never reads from or writes to anything
outside this folder.
"""
import base64
import gzip
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

# The standalone file's policy: no remote script/style/font host at all. Must stay in
# step with the dev policy in src/index.html minus its font hosts and local files.
STANDALONE_CSP = ("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
                  "font-src data:; img-src data:; connect-src *; base-uri 'none'; form-action 'none'")
# The -wllama build also imports the engine from a blob: URL, runs it in a blob: worker
# and compiles its wasm, which the worker reads from a data: URL by XHR (connect-src).
WLLAMA_CSP = (STANDALONE_CSP
              .replace("script-src 'unsafe-inline';", "script-src 'unsafe-inline' blob: 'wasm-unsafe-eval'; worker-src blob:;")
              .replace("connect-src *;", "connect-src * data: blob:;"))
assert WLLAMA_CSP.count("blob:") == 3

INTER_TAG = r'<link\s+href="(https://fonts\.googleapis\.com/css2[^"]+)"\s+rel="stylesheet"\s*>'
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


def strip_wllama(text, what):
    """Remove @wllama:start/@wllama:end blocks (HTML, CSS and JS comment styles), as the
    root build does."""
    for start, end in [("<!-- @wllama:start -->", "<!-- @wllama:end -->"),
                       ("/* @wllama:start */", "/* @wllama:end */"),
                       ("// @wllama:start", "// @wllama:end")]:
        if text.count(start) != text.count(end):
            fail(f"{what}: unbalanced wllama markers ({text.count(start)} x '{start}', {text.count(end)} x '{end}').")
    text = re.sub(r'[ \t]*<!-- @wllama:start -->.*?<!-- @wllama:end -->\n?', '', text, flags=re.DOTALL)
    text = re.sub(r'[ \t]*/\* @wllama:start \*/.*?/\* @wllama:end \*/\n?', '', text, flags=re.DOTALL)
    text = re.sub(r'[ \t]*// @wllama:start\n.*?// @wllama:end[^\n]*\n?', '', text, flags=re.DOTALL)
    if "@wllama" in text:
        fail(f"{what}: stripping the wllama blocks left residue.")
    return text


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
    script_js = (SRC / "script.js").read_text(encoding="utf-8")

    def cached(url, name, headers=None):
        path = LIBS / name
        if not REFRESH and manifest.get(name) == url and path.exists():
            data = path.read_bytes()
            print(f"  -> {name} (cached)")
        else:
            print(f"  -> fetching {name} …")
            data = fetch(url, headers)
        if len(data) < 256:
            fail(f"{name}: implausibly small response ({len(data)} bytes) from {url}.")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        manifest[name] = url
        MANIFEST.write_text(json.dumps(manifest, indent=1))
        return data

    print("📥 Inter font")
    m = re.search(INTER_TAG, html)
    if not m:
        fail("Inter: Google Fonts <link> not found in src/index.html.")
    inter_css = cached(m.group(1), "inter-google.css", {"User-Agent": BROWSER_UA}).decode()
    # Only the Latin subsets: the output is Latin-1, and any other script in the input
    # falls back to a system font. Google labels each @font-face block with a comment.
    blocks = re.findall(r"/\* ([\w-]+) \*/\s*(@font-face\s*\{[^}]*\})", inter_css)
    if not blocks:
        fail("No subset-labelled @font-face blocks in the Google Fonts CSS (format changed?).")
    # Inter is a variable font: Google repeats one file per weight, so keep one block per
    # subset with the whole weight range, or the file would be inlined four times.
    kept = {}
    for subset, body in blocks:
        if subset in ("latin", "latin-ext") and subset not in kept:
            kept[subset] = re.sub(r"font-weight:\s*\d+;", "font-weight: 400 700;", body)
    inter_css = "\n".join(kept.values())
    font_urls = sorted(set(re.findall(r'url\((https://[^)]+\.woff2)\)', inter_css)))
    if not font_urls:
        fail("No woff2 URLs in the Google Fonts CSS (format changed, or a stale cache: try --refresh).")
    for url in font_urls:
        data = cached(url, "fonts/" + url.rsplit("/", 1)[-1])
        inter_css = inter_css.replace(url, "data:font/woff2;base64," + base64.b64encode(data).decode())

    for name, body in (("src/style.css", css), ("Inter CSS", inter_css)):
        if re.search(r'</style', body, re.IGNORECASE):
            fail(f"{name} contains a literal '</style'.")

    print("📥 wllama engine")
    m = re.search(r'WLLAMA_CDN_BASE = "([^"]+)"', script_js)
    if not m:
        fail("WLLAMA_CDN_BASE not found in src/script.js.")
    engine = {}
    for key, path in (("js", "index.js"), ("wasm", "wasm/wllama.wasm")):
        data = cached(f"{m.group(1)}/{path}", "wllama/" + path.rsplit("/", 1)[-1])
        engine[key] = base64.b64encode(gzip.compress(data, 9)).decode()
    engine_script = f'<script>window.__WLLAMA_INLINE__ = {{ js: "{engine["js"]}", wasm: "{engine["wasm"]}" }};</script>'
    favicon = base64.b64encode((SRC / "favicon.svg").read_bytes()).decode()

    def assemble(page, style, script, csp):
        out, n = re.subn(r'(<meta http-equiv="Content-Security-Policy" content=")[^"]*(")',
                         lambda mm: mm.group(1) + csp + mm.group(2), page)
        if n != 1:
            fail("Content-Security-Policy <meta> not found in src/index.html.")
        out, n = re.subn(INTER_TAG, lambda mm: f"<style>{inter_css}</style>", out)
        if n != 1:
            fail(f"inlining Inter: expected one tag, found {n}.")
        out = replace_once(out, '<link rel="stylesheet" href="style.css">', f"<style>\n{style}\n</style>", "style.css")
        out = replace_once(out, '<script src="script.js"></script>', f"<script>\n{escape_script_close(script)}\n</script>", "script.js")
        out = replace_once(out, '<link rel="icon" href="favicon.svg">',
                           f'<link rel="icon" href="data:image/svg+xml;base64,{favicon}">', "favicon")
        if re.search(r'(?:src|href)="https?://', out):
            fail("The output still references a remote URL.")
        return out

    print("🔨 Assembling")
    outputs = {
        "hermit-cleaner-standalone.html": assemble(strip_wllama(html, "src/index.html"), strip_wllama(css, "src/style.css"),
                                                   strip_wllama(script_js, "src/script.js"), STANDALONE_CSP),
        "hermit-cleaner-wllama.html": replace_once(assemble(html, css, script_js, WLLAMA_CSP),
                                                   "<!-- @wllama:inline-engine -->", engine_script, "engine placeholder"),
    }
    for name, out in outputs.items():
        target = DIST / name
        target.write_text(out, encoding="utf-8")
        print(f"  ✅ {target.relative_to(ROOT)}: {target.stat().st_size / 1e3:.0f} KB")


if __name__ == "__main__":
    main()
