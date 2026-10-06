#!/usr/bin/env python3
"""Build HermitUI Agent into one self-contained HTML file.

    python3 build.py            # from hermit-agent/ (or any directory)
    python3 build.py --refresh  # re-download every cached library

Reads src/ (index.html, style.css, worker.js, script.js, favicon.svg) and writes
dist/hermit-agent-standalone.html with everything inlined: the CDN libraries (verified
against the SRI pins in src/index.html), the Inter font, and the Pyodide core
(verified against PYODIDE_SHA256 below, gzipped + base64-encoded as
window.__PYODIDE_INLINE__), and the bundled pure-Python libraries (BUNDLED_LIBRARIES in
src/script.js: wheels verified against their sha256 pins and their own metadata, inlined
gzipped + base64-encoded as window.__HERMIT_WHEELS__; a library PyPI has no wheel for gets
one built from its pinned source archive). Downloads are cached in libs/ (gitignored).
Like the root build it fails loudly instead of writing an output that still points at a CDN.

Adapted from ../build.py; it never reads from or writes to anything outside this folder.
"""
import base64
import gzip
import hashlib
import io
import json
import pathlib
import re
import sys
import tarfile
import urllib.request
import zipfile

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


def norm(name):
    return re.sub(r"[-_.]+", "-", name).lower()


def bundled_libraries(script_js):
    """BUNDLED_LIBRARIES from the marker block in src/script.js (strict JSON)."""
    m = re.search(r"// @bundled:start\nconst BUNDLED_LIBRARIES = (\{.*?\n\});\n// @bundled:end", script_js, re.S)
    if not m:
        fail("BUNDLED_LIBRARIES block (// @bundled:start … // @bundled:end) not found in src/script.js.")
    try:
        return json.loads(m.group(1))
    except ValueError as e:
        fail(f"BUNDLED_LIBRARIES isn't strict JSON: {e}")


def requirement_applies(line, lib, what):
    """Whether a Requires-Dist line applies in Pyodide (CPython 3.13, emscripten): extras
    and other platforms don't. An unknown marker fails the build for a human to look at."""
    marker = line.split(";", 1)[1].strip() if ";" in line else ""
    if not marker:
        return True
    if "extra ==" in marker or re.fullmatch(r'sys_platform\s*==\s*"win32"', marker):
        return False
    v = re.fullmatch(r'python_version\s*<\s*"3\.(\d+)"', marker)
    if v:
        return 13 < int(v.group(1))
    fail(f"{lib}: {what} has a requirement marker build.py doesn't understand: {line!r}")


def check_wheel(lib, spec, data, wheel_dists):
    """A wheel's own metadata against the manifest: pure, licensed, and its dependencies
    either bundled with it or listed as Pyodide packages. Returns its top-level names."""
    if not spec["file"].endswith("-none-any.whl"):
        fail(f"{lib}: {spec['file']} is not a pure-Python wheel.")
    z = zipfile.ZipFile(io.BytesIO(data))
    names = z.namelist()
    meta = [n for n in names if re.fullmatch(r"[^/]+\.dist-info/METADATA", n)]
    if len(meta) != 1:
        fail(f"{lib}: {spec['file']} has no METADATA.")
    info = meta[0].split("/")[0]
    if not any(n.startswith(info + "/") and re.search(r"(LICEN[CS]E|COPYING)", n.upper()) for n in names):
        fail(f"{lib}: {spec['file']} carries no license file (the bundle must carry each license text).")
    pyodide = {norm(p) for p in BUNDLED[lib]["pyodide"]}
    for line in z.read(meta[0]).decode("utf-8", "replace").splitlines():
        if not line.startswith("Requires-Dist:") or not requirement_applies(line, lib, spec["file"]):
            continue
        dep = norm(re.match(r"Requires-Dist:\s*([A-Za-z0-9_.-]+)", line).group(1))
        if dep not in wheel_dists and dep not in pyodide:
            fail(f"{lib}: {spec['file']} requires {dep}, which is neither bundled with it nor in its \"pyodide\" list.")
    return {n.split("/")[0].removesuffix(".py") for n in names if not n.split("/")[0].endswith((".dist-info", ".data"))}



def wheel_from_sdist(lib, spec, data):
    """A pure wheel built from a pinned source archive, for a library PyPI publishes no
    wheel for (odfpy). Its setup.py never runs: the manifest names the packages to take
    and the requirements to declare, and both are checked against setup.py's own literals.
    Stored entries, fixed timestamps and sorted names make the wheel the same bytes on any
    machine, whatever its zlib, so its sha256 can be pinned like a downloaded one."""
    sd = spec["sdist"]
    m = re.fullmatch(r"([A-Za-z0-9_.]+)-([0-9][A-Za-z0-9_.]*)\.tar\.gz", sd["file"])
    if not m:
        fail(f"{lib}: {sd['file']} isn't named like a source archive (name-version.tar.gz).")
    root = f"{m.group(1)}-{m.group(2)}"
    tag = re.fullmatch(re.escape(root) + r"-((?:py\d\.)*py\d)-none-any\.whl", spec["file"])
    if not tag:
        fail(f"{lib}: {spec['file']} must be named {root}-<python tag>-none-any.whl, after its source archive.")
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as t:
        src = {i.name: t.extractfile(i).read() for i in t.getmembers() if i.isfile() and i.name.startswith(root + "/")}
    get = lambda name: src.get(f"{root}/{name}")   # noqa: E731
    setup, pkg_info = get("setup.py"), get("PKG-INFO")
    if setup is None or pkg_info is None:
        fail(f"{lib}: {sd['file']} has no setup.py or PKG-INFO at its top.")
    literal = lambda key: sorted(re.findall(r"['\"]([A-Za-z0-9_.-]+)['\"]", (re.search(key + r"\s*=\s*\[([^\]]*)\]", setup.decode()) or [None, ""])[1]))  # noqa: E731
    if literal("packages") != sorted(sd["packages"]) or sorted(map(norm, literal("install_requires"))) != sorted(map(norm, sd["requires"])):
        fail(f"{lib}: setup.py in {sd['file']} declares packages {literal('packages')} and requirements "
             f"{literal('install_requires')}; the manifest says {sd['packages']} and {sd['requires']}.")
    info = f"{root}.dist-info"
    files = {}
    for name, body in src.items():
        rel = name[len(root) + 1:]
        if rel.split("/")[0] in sd["packages"] and "/" in rel and "__pycache__" not in rel and not rel.endswith((".pyc", ".pyo")):
            files[rel] = body
        elif "/" not in rel and re.search(r"(LICEN[CS]E|COPYING)", rel.upper()):
            files[f"{info}/licenses/{rel}"] = body
    if not any(f.startswith(info + "/licenses/") for f in files):
        fail(f"{lib}: {sd['file']} has no license file at its top.")
    meta = pkg_info.decode("utf-8").replace("\r\n", "\n")
    if re.search(r"^Requires-Dist:", meta, re.M):
        fail(f"{lib}: {sd['file']}'s PKG-INFO lists requirements already; build.py adds them from the manifest.")
    # Requires-Dist needs metadata 1.2; nothing in 1.1 changed meaning in 1.2.
    meta = re.sub(r"^Metadata-Version: 1\.[01]$", "Metadata-Version: 1.2", meta, count=1, flags=re.M)
    meta = re.sub(r"^(Version: .*)$", lambda mm: mm.group(1) + "".join(f"\nRequires-Dist: {r}" for r in sd["requires"]), meta, count=1, flags=re.M)
    files[f"{info}/METADATA"] = meta.encode("utf-8")
    files[f"{info}/WHEEL"] = ("Wheel-Version: 1.0\nGenerator: hermit-agent build.py\nRoot-Is-Purelib: true\n"
                              + "".join(f"Tag: {py}-none-any\n" for py in tag.group(1).split("."))).encode()
    files[f"{info}/top_level.txt"] = "".join(p + "\n" for p in sd["packages"]).encode()
    record = "".join(f"{n},sha256={base64.urlsafe_b64encode(hashlib.sha256(b).digest()).decode().rstrip('=')},{len(b)}\n" for n, b in sorted(files.items()))
    files[f"{info}/RECORD"] = (record + f"{info}/RECORD,,\n").encode()
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as z:
        for n in sorted(files, key=lambda n: (n.startswith(info + "/"), n.endswith("/RECORD"), n)):
            zi = zipfile.ZipInfo(n, date_time=(1980, 1, 1, 0, 0, 0))
            zi.create_system, zi.external_attr = 3, 0o644 << 16
            z.writestr(zi, files[n])
    return out.getvalue()


BUNDLED = {}


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
            fail(f"{name}: sha256 mismatch against its pin ({url}).")
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

    print("📥 Bundled libraries")
    BUNDLED.update(bundled_libraries(script_js))
    lock = json.loads((LIBS / f"pyodide-{v.group(1)}" / "pyodide-lock.json").read_text())["packages"]
    lock_names = {norm(k) for k in lock} | {norm(p["name"]) for p in lock.values()}
    lock_imports = {i for p in lock.values() for i in p.get("imports", [])}
    dist_of = lambda f: norm(f.split("-")[0])   # noqa: E731
    wheels, wheel_total = {}, 0
    for lib, spec in BUNDLED.items():
        if norm(lib) in lock_names or set(spec["imports"]) & lock_imports:
            fail(f"{lib}: Pyodide already has it (by name or import name); don't bundle it.")
        for p in spec["pyodide"]:
            if p not in lock:
                fail(f"{lib}: \"pyodide\" lists {p}, which isn't a package in pyodide-lock.json.")
        for r in spec["requires"]:
            if r not in BUNDLED:
                fail(f"{lib}: requires {r}, which isn't in BUNDLED_LIBRARIES.")
    for lib, spec in BUNDLED.items():
        # Its own wheels and those of the bundled libraries it requires, transitively.
        dists, todo, seen = set(), [lib], set()
        while todo:
            n = todo.pop()
            if n not in seen:
                seen.add(n)
                dists |= {dist_of(w["file"]) for w in BUNDLED[n]["wheels"]}
                todo += BUNDLED[n]["requires"]
        tops = set()
        for w in spec["wheels"]:
            sd = w.get("sdist")
            origin = sd or w
            if not re.fullmatch(r"https://files\.pythonhosted\.org/packages/[0-9a-f/]+/" + re.escape(origin["file"]), origin["url"]):
                fail(f"{lib}: {origin['file']} must come from files.pythonhosted.org under its own file name.")
            if sd:
                data = wheel_from_sdist(lib, w, cached(sd["url"], "wheels/" + sd["file"], check=sd["sha256"]))
                if hashlib.sha256(data).hexdigest() != w["sha256"]:
                    fail(f"{lib}: the wheel built from {sd['file']} has sha256 {hashlib.sha256(data).hexdigest()}, "
                         f"not its pin: wheel_from_sdist changed (update the pin) or isn't reproducible.")
                print(f"  -> {w['file']} (built from {sd['file']})")
            else:
                data = cached(w["url"], "wheels/" + w["file"], check=w["sha256"])
            tops |= check_wheel(lib, w, data, dists)
            if w["file"] not in wheels:
                # gzip: a built wheel is stored, not deflated (that is what makes it reproducible).
                wheels[w["file"]] = base64.b64encode(gzip.compress(data, 9, mtime=0)).decode()
                wheel_total += len(data)
        missing = set(spec["imports"]) - tops
        if missing:
            fail(f"{lib}: its wheels provide no top-level {', '.join(sorted(missing))}.")
    wheels_script = "<script>window.__HERMIT_WHEELS__ = " + json.dumps(wheels) + ";</script>"
    print(f"  -> {len(BUNDLED)} libraries, {len(wheels)} wheels, {wheel_total / 1e6:.2f} MB "
          f"({sum(map(len, wheels.values())) / 1e6:.2f} MB inlined)")

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
    out = replace_once(out, "<!-- @pyodide:inline -->", pyodide_script + "\n" + wheels_script, "@pyodide:inline placeholder")
    favicon = base64.b64encode((SRC / "favicon.svg").read_bytes()).decode()
    out = replace_once(out, '<link rel="icon" href="favicon.svg">',
                       f'<link rel="icon" href="data:image/svg+xml;base64,{favicon}">', "favicon")
    if re.search(r'(?:src|href)="https?://', out):
        fail("The standalone output still references a remote URL.")

    target = DIST / "hermit-agent-standalone.html"
    target.write_text(out, encoding="utf-8")
    print(f"  ✅ {target.relative_to(ROOT)}: {target.stat().st_size / 1e6:.2f} MB "
          f"(Pyodide core {raw_total / 1e6:.1f} MB raw, bundled libraries {wheel_total / 1e6:.2f} MB raw)")


if __name__ == "__main__":
    main()
