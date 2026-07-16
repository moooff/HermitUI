#!/usr/bin/env python3
import os
import sys
import urllib.request
import base64
import gzip
import json
import shutil
import re

# libs/ doubles as a download cache: files are reused when they were fetched from
# the exact (version-pinned) URL recorded in this manifest, so version bumps
# re-download automatically. `python3 build.py --refresh` forces re-downloading.
MANIFEST_PATH = "libs/.urls.json"
REFRESH = "--refresh" in sys.argv

URLS = {
    "marked.js": "https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js",
    "dompurify.js": "https://cdn.jsdelivr.net/npm/dompurify@3.0.6/dist/purify.min.js",
    "highlight.css": "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css",
    "highlight.js": "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js",
    "katex.js": "https://cdn.jsdelivr.net/npm/katex@0.16.47/dist/katex.min.js",
    "inter.css": "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
}

def fetch(url, headers=None):
    if headers is None: headers = {}
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            return response.read()
    except Exception as e:
        print(f"❌ Failed to fetch {url}: {e}")
        sys.exit(1)


def sub_required(pattern, repl, text, what):
    """re.sub that fails the build when the pattern matches nothing.

    Guards against a CDN tag in src/index.html drifting out of sync with its
    regex here — without this, a 'standalone' output would silently keep the
    live CDN link.
    """
    new_text, n = re.subn(pattern, repl, text)
    if n == 0:
        print(f"❌ {what}: pattern matched nothing — CDN tag in src/index.html out of sync with build.py.")
        sys.exit(1)
    return new_text

def strip_wllama(text):
    """Remove @wllama:start/@wllama:end marker blocks (HTML, CSS, and JS comment styles).

    The in-browser inference (wllama) feature lives in src/ between these markers and is
    only kept for the dedicated dist/hermit-ui-wllama.html output; every other output is
    built from the stripped source so it stays as lean as before the feature existed.
    """
    text = re.sub(r'[ \t]*<!-- @wllama:start -->.*?<!-- @wllama:end -->\n?', '', text, flags=re.DOTALL)
    text = re.sub(r'[ \t]*/\* @wllama:start \*/.*?/\* @wllama:end \*/\n?', '', text, flags=re.DOTALL)
    text = re.sub(r'[ \t]*// @wllama:start\n.*?// @wllama:end[^\n]*\n?', '', text, flags=re.DOTALL)
    return text

def build():
    os.makedirs("libs/fonts", exist_ok=True)
    # Start from a clean dist/ so renamed/stale outputs don't linger between builds.
    shutil.rmtree("dist", ignore_errors=True)
    os.makedirs("dist", exist_ok=True)

    manifest = {}
    if os.path.exists(MANIFEST_PATH):
        try:
            with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
                manifest = json.load(f)
        except Exception:
            manifest = {}

    def fetch_cached(url, cache_path, headers=None):
        if not REFRESH and manifest.get(cache_path) == url and os.path.exists(cache_path):
            print(f"  -> {os.path.basename(cache_path)} (cached)")
            with open(cache_path, "rb") as f:
                return f.read()
        print(f"  -> Fetching {os.path.basename(cache_path)}...")
        content = fetch(url, headers)
        os.makedirs(os.path.dirname(cache_path), exist_ok=True)
        with open(cache_path, "wb") as f:
            f.write(content)
        manifest[cache_path] = url
        return content

    print("📥 Downloading libraries from CDNs...")
    cache = {}

    for name, url in URLS.items():
        headers = {}
        # Emulate modern browser to get woff2 font format for Inter
        if "fonts.googleapis.com" in url:
            headers["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0"

        # libs/inter.css holds the *processed* (font-path-rewritten) CSS, so the
        # raw Google response is cached under its own name.
        cache_path = "libs/inter-google.css" if name == "inter.css" else f"libs/{name}"
        cache[name] = fetch_cached(url, cache_path, headers)

    print("🖋️ Processing Inter fonts...")
    inter_css = cache["inter.css"].decode("utf-8")
    # Support optional quotes around URL
    font_urls = re.findall(r'url\((?:["\']?)(https://[^)]+?)(?:["\']?)\)', inter_css)
    
    inter_local_css = inter_css
    inter_inline_css = inter_css
    
    # Download and process each woff2 font file
    for font_url in set(font_urls):
        font_filename = font_url.split("/")[-1]
        font_content = fetch_cached(font_url, f"libs/fonts/{font_filename}")

        # Update path for local CSS
        inter_local_css = inter_local_css.replace(font_url, f"fonts/{font_filename}")
        
        # Base64 encode for inline standalone CSS
        b64_font = base64.b64encode(font_content).decode("utf-8")
        inter_inline_css = inter_inline_css.replace(font_url, f"data:font/woff2;base64,{b64_font}")

    # Save local inter CSS
    with open("libs/inter.css", "w", encoding="utf-8") as f:
        f.write(inter_local_css)
        
    cache["inter.css"] = inter_local_css.encode("utf-8")
    cache["inter_inline.css"] = inter_inline_css.encode("utf-8")

    # Read base template and assemble local components
    with open("src/index.html", "r", encoding="utf-8") as f:
        html = f.read()
    
    with open("src/style.css", "r", encoding="utf-8") as f:
        local_css = f.read()
        
    with open("src/script.js", "r", encoding="utf-8") as f:
        local_js = f.read()

    # Wllama engine assets for the fully-offline wllama output. The version pin lives
    # only in src/script.js (WLLAMA_CDN_BASE); the assets are gzipped + base64-encoded
    # and injected as window.__WLLAMA_INLINE__ so first model load needs zero network.
    m = re.search(r'WLLAMA_CDN_BASE\s*=\s*"([^"]+)"', local_js)
    if not m:
        print("❌ WLLAMA_CDN_BASE constant not found in src/script.js.")
        sys.exit(1)
    wllama_base = m.group(1)
    print("📥 Downloading wllama engine assets...")
    wllama_inline = {}
    for key, path in [("js", "index.js"), ("wasm", "wasm/wllama.wasm")]:
        content = fetch_cached(f"{wllama_base}/{path}", f"libs/wllama/{os.path.basename(path)}")
        wllama_inline[key] = base64.b64encode(gzip.compress(content, 9)).decode("utf-8")

    # Mermaid is ~3.5 MB raw — far too heavy to inline plainly into the single-file
    # outputs. Like the wllama engine it is gzipped + base64-encoded and injected as
    # window.__MERMAID_INLINE__; src/script.js decompresses it lazily (via the native
    # DecompressionStream API) only when a chat message actually contains a diagram.
    # The version pin lives only in the src/index.html CDN <script> tag.
    m = re.search(r'<script\s+defer\s+src=["\'](https://cdn\.jsdelivr\.net/npm/mermaid@[^"\']+)["\']', html)
    if not m:
        print("❌ Mermaid CDN <script> tag not found in src/index.html.")
        sys.exit(1)
    print("📥 Downloading mermaid...")
    mermaid_raw = fetch_cached(m.group(1), "libs/mermaid.js")
    mermaid_b64 = base64.b64encode(gzip.compress(mermaid_raw, 9)).decode("utf-8")

    html = html.replace('<link rel="stylesheet" href="style.css">', f'<style>\n{local_css}\n    </style>')
    html = html.replace('<script src="script.js"></script>', f'<script>\n{local_js}\n    </script>')

    # Inline favicon into the template
    try:
        with open("src/favicon.svg", "rb") as f:
            favicon_b64 = base64.b64encode(f.read()).decode("utf-8")
        html = re.sub(
            r'(<link[^>]*?rel=["\']icon["\'][^>]*?href=["\'])[^"\']+(["\'])',
            rf'\g<1>data:image/svg+xml;base64,{favicon_b64}\g<2>',
            html
        )
    except Exception as e:
        print(f"⚠️ Could not inline favicon.svg: {e}")

    # Keep the full source (with the wllama in-browser inference feature) for the
    # dedicated wllama output; everything else builds from the stripped variant.
    html_wllama = html
    html = strip_wllama(html)
    if "@wllama" in html:
        print("❌ Unbalanced @wllama:start/@wllama:end markers — stripping left residue.")
        sys.exit(1)

    print("\n🔨 Generating HTML versions in dist/ ...")

    # 1. CDN Version
    with open("dist/hermit-ui-cdn.html", "w", encoding="utf-8") as f:
        f.write(html)
    print("  ✅ dist/hermit-ui-cdn.html (Base version using CDNs)")

    # Decode cached library contents for inlining. Scripts escape </script> so the
    # inlined code can't prematurely close the surrounding <script> tag.
    marked_script = cache["marked.js"].decode("utf-8").replace("</script>", r"<\/script>")
    dompurify_script = cache["dompurify.js"].decode("utf-8").replace("</script>", r"<\/script>")
    hl_css = cache["highlight.css"].decode("utf-8")
    hl_script = cache["highlight.js"].decode("utf-8").replace("</script>", r"<\/script>")
    katex_script = cache["katex.js"].decode("utf-8").replace("</script>", r"<\/script>")
    inter_inline = cache["inter_inline.css"].decode("utf-8")

    # Single source of truth per asset: each CDN tag's regex lives once and drives both
    # the local (link to ../libs/) and standalone (inline content) rewrites. The inline
    # replacements are callables so their text isn't treated as regex backreferences.
    ASSETS = [
        ("marked",
         r'<script\s+src=["\']https://cdn\.jsdelivr\.net/npm/marked@[^"\']+["\']\s*></script>',
         '<script src="../libs/marked.js"></script>',
         lambda m: f'<script>{marked_script}</script>'),
        ("dompurify",
         r'<script\s+src=["\']https://cdn\.jsdelivr\.net/npm/dompurify@[^"\']+["\']\s*></script>',
         '<script src="../libs/dompurify.js"></script>',
         lambda m: f'<script>{dompurify_script}</script>'),
        ("highlight.css",
         r'<link\s+rel=["\']stylesheet["\']\s+href=["\']https://cdnjs\.cloudflare\.com/ajax/libs/highlight\.js/[^"\']+["\']\s*>',
         '<link rel="stylesheet" href="../libs/highlight.css">',
         lambda m: f'<style>{hl_css}</style>'),
        ("highlight.js",
         r'<script\s+src=["\']https://cdnjs\.cloudflare\.com/ajax/libs/highlight\.js/[^"\']+["\']\s*></script>',
         '<script src="../libs/highlight.js"></script>',
         lambda m: f'<script>{hl_script}</script>'),
        ("katex",
         r'<script\s+src=["\']https://cdn\.jsdelivr\.net/npm/katex@[^"\']+["\']\s*></script>',
         '<script src="../libs/katex.js"></script>',
         lambda m: f'<script>{katex_script}</script>'),
        ("mermaid",
         r'<script\s+defer\s+src=["\']https://cdn\.jsdelivr\.net/npm/mermaid@[^"\']+["\']\s*></script>',
         '<script defer src="../libs/mermaid.js"></script>',
         lambda m: f'<script>window.__MERMAID_INLINE__ = "{mermaid_b64}";</script>'),
        ("inter",
         r'<link\s+href=["\']https://fonts\.googleapis\.com/css2[^"\']+["\']\s+rel=["\']stylesheet["\']\s*>',
         '<link href="../libs/inter.css" rel="stylesheet">',
         lambda m: f'<style>{inter_inline}</style>'),
    ]

    # 2. Local Version (CDN links rewritten to point at the local libs/ directory)
    local_html = html
    for name, pattern, local_repl, _ in ASSETS:
        local_html = sub_required(pattern, local_repl, local_html, f"local rewrite of {name}")

    with open("dist/hermit-ui-local.html", "w", encoding="utf-8") as f:
        f.write(local_html)
    print("  ✅ dist/hermit-ui-local.html (Links point to local libs/ directory)")

    # 3. Standalone Version (all libraries inlined directly into the file)
    standalone_html = html
    for name, pattern, _, inline_repl in ASSETS:
        standalone_html = sub_required(pattern, inline_repl, standalone_html, f"inlining of {name}")

    with open("dist/hermit-ui-standalone.html", "w", encoding="utf-8") as f:
        f.write(standalone_html)
    print("  ✅ dist/hermit-ui-standalone.html (Entirely integrated single-file)")

    # 4. Wllama Version (standalone-style, with the in-browser GGUF inference backend
    #    kept in and the wllama engine itself embedded, so it runs fully offline)
    wllama_html = html_wllama
    for name, pattern, _, inline_repl in ASSETS:
        wllama_html = sub_required(pattern, inline_repl, wllama_html, f"inlining of {name} (wllama)")

    engine_placeholder = "<!-- @wllama:inline-engine -->"
    if engine_placeholder not in wllama_html:
        print("❌ @wllama:inline-engine placeholder not found in src/index.html.")
        sys.exit(1)
    engine_script = (
        f'<script>window.__WLLAMA_INLINE__ = {{ js: "{wllama_inline["js"]}", '
        f'wasm: "{wllama_inline["wasm"]}" }};</script>'
    )
    wllama_html = wllama_html.replace(engine_placeholder, engine_script)

    with open("dist/hermit-ui-wllama.html", "w", encoding="utf-8") as f:
        f.write(wllama_html)
    print("  ✅ dist/hermit-ui-wllama.html (Standalone + fully-offline in-browser wllama inference)")

    # Final step: copy the standalone build out to root index.html for GitHub Pages.
    shutil.copyfile("dist/hermit-ui-standalone.html", "index.html")
    print("  ✅ index.html (Copy of the standalone build, served as the GitHub Pages landing page)")

    with open(MANIFEST_PATH, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=1)

    print("\n🎉 Build complete!")

if __name__ == "__main__":
    build()

