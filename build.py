#!/usr/bin/env python3
import os
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
    with urllib.request.urlopen(req) as response:
        return response.read()

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
    font_urls = re.findall(r'url\((https://[^)]+)\)', inter_css)
    
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
    with open("hermit-ui.html", "r", encoding="utf-8") as f:
        html = f.read()

    print("\n🔨 Generating HTML versions in dist/ ...")

    # 1. CDN Version
    shutil.copy("hermit-ui.html", "dist/hermit-ui-cdn.html")
    print("  ✅ dist/hermit-ui-cdn.html (Base version using CDNs)")

    # 2. Local Version
    local_html = html
    local_html = local_html.replace('https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js', '../libs/marked.js')
    local_html = local_html.replace('https://cdn.jsdelivr.net/npm/dompurify@3.0.6/dist/purify.min.js', '../libs/dompurify.js')
    local_html = local_html.replace('https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css', '../libs/highlight.css')
    local_html = local_html.replace('https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js', '../libs/highlight.js')
    local_html = local_html.replace('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap', '../libs/inter.css')

    with open("dist/hermit-ui-local.html", "w", encoding="utf-8") as f:
        f.write(local_html)
    print("  ✅ dist/hermit-ui-local.html (Links point to local libs/ directory)")

    # 3. Standalone Version
    standalone_html = html
    standalone_html = standalone_html.replace(
        '<script src="https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js"></script>',
        f'<script>{cache["marked.js"].decode("utf-8")}</script>'
    )
    standalone_html = standalone_html.replace(
        '<script src="https://cdn.jsdelivr.net/npm/dompurify@3.0.6/dist/purify.min.js"></script>',
        f'<script>{cache["dompurify.js"].decode("utf-8")}</script>'
    )
    standalone_html = standalone_html.replace(
        '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css">',
        f'<style>{cache["highlight.css"].decode("utf-8")}</style>'
    )
    standalone_html = standalone_html.replace(
        '<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>',
        f'<script>{cache["highlight.js"].decode("utf-8")}</script>'
    )
    standalone_html = standalone_html.replace(
        '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">',
        f'<style>{cache["inter_inline.css"].decode("utf-8")}</style>'
    )

    with open("dist/hermit-ui-standalone.html", "w", encoding="utf-8") as f:
        f.write(standalone_html)
    print("  ✅ dist/hermit-ui-standalone.html (Entirely integrated single-file!)")

    print("\n🎉 Build complete!")

if __name__ == "__main__":
    build()
