#!/usr/bin/env python3
import os
import sys
import urllib.request
import base64
import shutil
import re

URLS = {
    "marked.js": "https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js",
    "dompurify.js": "https://cdn.jsdelivr.net/npm/dompurify@3.0.6/dist/purify.min.js",
    "highlight.css": "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css",
    "highlight.js": "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js",
    "inter.css": "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
}

def fetch(url, headers=None):
    if headers is None: headers = {}
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req) as response:
            return response.read()
    except Exception as e:
        print(f"❌ Failed to fetch {url}: {e}")
        sys.exit(1)

def build():
    os.makedirs("libs/fonts", exist_ok=True)
    os.makedirs("dist", exist_ok=True)
    
    print("📥 Downloading libraries from CDNs...")
    cache = {}
    
    for name, url in URLS.items():
        print(f"  -> Fetching {name}...")
        headers = {}
        # Emulate modern browser to get woff2 font format for Inter
        if "fonts.googleapis.com" in url:
            headers["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0"
        
        content = fetch(url, headers)
        cache[name] = content
        
        if name != "inter.css":
            with open(f"libs/{name}", "wb") as f:
                f.write(content)

    print("🖋️ Processing Inter fonts...")
    inter_css = cache["inter.css"].decode("utf-8")
    # Support optional quotes around URL
    font_urls = re.findall(r'url\((?:["\']?)(https://[^)]+?)(?:["\']?)\)', inter_css)
    
    inter_local_css = inter_css
    inter_inline_css = inter_css
    
    # Download and process each woff2 font file
    for font_url in set(font_urls):
        font_filename = font_url.split("/")[-1]
        print(f"  -> Fetching font {font_filename}...")
        font_content = fetch(font_url)
        
        with open(f"libs/fonts/{font_filename}", "wb") as f:
            f.write(font_content)
            
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

    # Read base template
    with open("src/hermit-ui.src.html", "r", encoding="utf-8") as f:
        html = f.read()

    # Inline favicon into the template
    try:
        with open("favicon.svg", "rb") as f:
            favicon_b64 = base64.b64encode(f.read()).decode("utf-8")
        html = re.sub(
            r'(<link[^>]*?rel=["\']icon["\'][^>]*?href=["\'])[^"\']+(["\'])',
            rf'\g<1>data:image/svg+xml;base64,{favicon_b64}\g<2>',
            html
        )
    except Exception as e:
        print(f"⚠️ Could not inline favicon.svg: {e}")

    print("\n🔨 Generating HTML versions in dist/ ...")

    # 1. CDN Version
    with open("dist/hermit-ui-cdn.html", "w", encoding="utf-8") as f:
        f.write(html)
    print("  ✅ dist/hermit-ui-cdn.html (Base version using CDNs)")

    # 2. Local Version
    local_html = html
    local_html = re.sub(r'<script\s+src=["\']https://cdn\.jsdelivr\.net/npm/marked@[^"\']+["\']\s*></script>', '<script src="../libs/marked.js"></script>', local_html)
    local_html = re.sub(r'<script\s+src=["\']https://cdn\.jsdelivr\.net/npm/dompurify@[^"\']+["\']\s*></script>', '<script src="../libs/dompurify.js"></script>', local_html)
    local_html = re.sub(r'<link\s+rel=["\']stylesheet["\']\s+href=["\']https://cdnjs\.cloudflare\.com/ajax/libs/highlight\.js/[^"\']+["\']\s*>', '<link rel="stylesheet" href="../libs/highlight.css">', local_html)
    local_html = re.sub(r'<script\s+src=["\']https://cdnjs\.cloudflare\.com/ajax/libs/highlight\.js/[^"\']+["\']\s*></script>', '<script src="../libs/highlight.js"></script>', local_html)
    local_html = re.sub(r'<link\s+href=["\']https://fonts\.googleapis\.com/css2[^"\']+["\']\s+rel=["\']stylesheet["\']\s*>', '<link href="../libs/inter.css" rel="stylesheet">', local_html)

    with open("dist/hermit-ui-local.html", "w", encoding="utf-8") as f:
        f.write(local_html)
    print("  ✅ dist/hermit-ui-local.html (Links point to local libs/ directory)")

    # 3. Standalone Version
    standalone_html = html
    
    marked_script = cache["marked.js"].decode("utf-8").replace("</script>", r"<\/script>")
    dompurify_script = cache["dompurify.js"].decode("utf-8").replace("</script>", r"<\/script>")
    hl_css = cache["highlight.css"].decode("utf-8")
    hl_script = cache["highlight.js"].decode("utf-8").replace("</script>", r"<\/script>")
    inter_inline = cache["inter_inline.css"].decode("utf-8")

    standalone_html = re.sub(r'<script\s+src=["\']https://cdn\.jsdelivr\.net/npm/marked@[^"\']+["\']\s*></script>', lambda m: f'<script>{marked_script}</script>', standalone_html)
    standalone_html = re.sub(r'<script\s+src=["\']https://cdn\.jsdelivr\.net/npm/dompurify@[^"\']+["\']\s*></script>', lambda m: f'<script>{dompurify_script}</script>', standalone_html)
    standalone_html = re.sub(r'<link\s+rel=["\']stylesheet["\']\s+href=["\']https://cdnjs\.cloudflare\.com/ajax/libs/highlight\.js/[^"\']+["\']\s*>', lambda m: f'<style>{hl_css}</style>', standalone_html)
    standalone_html = re.sub(r'<script\s+src=["\']https://cdnjs\.cloudflare\.com/ajax/libs/highlight\.js/[^"\']+["\']\s*></script>', lambda m: f'<script>{hl_script}</script>', standalone_html)
    standalone_html = re.sub(r'<link\s+href=["\']https://fonts\.googleapis\.com/css2[^"\']+["\']\s+rel=["\']stylesheet["\']\s*>', lambda m: f'<style>{inter_inline}</style>', standalone_html)

    with open("hermit-ui.html", "w", encoding="utf-8") as f:
        f.write(standalone_html)
    print("  ✅ hermit-ui.html (Entirely integrated single-file, placed in root!)")

    with open("index.html", "w", encoding="utf-8") as f:
        f.write(standalone_html)
    print("  ✅ index.html (Same file, served as the GitHub Pages landing page)")

    print("\n🎉 Build complete!")

if __name__ == "__main__":
    build()

