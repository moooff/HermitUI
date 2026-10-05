"""Phase 3.5 study, part 1: what each candidate library would cost to bundle.

For every candidate: its latest version on PyPI, whether it ships a pure-Python wheel,
the wheel size, its license, last month's downloads (pypistats.org), and its dependency
tree resolved against the pinned Pyodide distribution: dependencies Pyodide already has
cost nothing; the others must be bundled too (and must be pure-Python themselves).

    python3 spike/library_study.py            # → spike/out/library_study.json + a table

Network: pypi.org and pypistats.org. Results go to spike/out/ (gitignored).
"""
import json
import pathlib
import re
import sys
import time
import urllib.request

sys.stdout.reconfigure(line_buffering=True)
ROOT = pathlib.Path(__file__).resolve().parent.parent
LOCK = ROOT / "libs" / "pyodide-0.29.5" / "pyodide-lock.json"
OUT = ROOT / "spike" / "out" / "library_study.json"

# Candidates by the task they serve. Deliberately broad: the study decides.
CANDIDATES = {
    "Excel (.xlsx)": ["openpyxl", "XlsxWriter"],
    "Word (.docx)": ["python-docx", "docx2txt", "mammoth", "docxtpl"],
    "PowerPoint (.pptx)": ["python-pptx"],
    "OpenDocument (.odt/.ods)": ["odfpy"],
    "PDF create": ["fpdf2", "reportlab"],
    "PDF read / edit": ["pypdf", "pdfminer.six"],
    "Markdown / HTML text": ["Markdown", "markdown-it-py", "mistune", "html2text", "markdownify"],
    "Text tables": ["tabulate"],
    "Charts": ["seaborn", "plotly"],
    "Data formats": ["xmltodict", "jsonschema", "icalendar", "feedparser"],
    "Text utilities": ["Unidecode", "python-slugify", "chardet", "humanize", "num2words"],
    "Barcodes / QR": ["qrcode", "segno", "python-barcode"],
    "Test data": ["Faker"],
}


def norm(name):
    return re.sub(r"[-_.]+", "-", name).lower()


def get_json(url, tries=6):
    for i in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=20) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001  (pypistats answers 429 when asked too fast)
            if i == tries - 1:
                return {"_error": str(e)}
            time.sleep(3 * (i + 1))


# Requirement markers we treat as "not needed here": extras, other platforms, old Pythons.
def needed(req):
    if ";" not in req:
        return True
    marker = req.split(";", 1)[1]
    if "extra" in marker:
        return False
    if re.search(r'sys_platform\s*==\s*"(win32|darwin|cygwin)"|platform_system\s*==\s*"(Windows|Darwin)"|os_name\s*==\s*"nt"', marker):
        return False
    m = re.search(r'python_version\s*<\s*"3\.(\d+)"', marker)
    if m and int(m.group(1)) <= 13:
        return False
    if re.search(r'implementation_name\s*==\s*"pypy"|platform_python_implementation\s*==\s*"PyPy"', marker):
        return False
    return True


def req_name(req):
    return norm(re.split(r"[\s;<>=!~\[(]", req.strip(), maxsplit=1)[0])


def pypi(name, cache):
    key = norm(name)
    if key in cache:
        return cache[key]
    d = get_json(f"https://pypi.org/pypi/{name}/json")
    if "_error" in d:
        cache[key] = {"name": name, "error": d["_error"]}
        return cache[key]
    info = d["info"]
    wheels = [u for u in d["urls"] if u["packagetype"] == "bdist_wheel"]
    sdists = [u for u in d["urls"] if u["packagetype"] == "sdist"]
    pure = [u for u in wheels if u["filename"].endswith("-none-any.whl")]
    lic = info.get("license_expression") or ""
    if not lic:
        lic = (info.get("license") or "").split("\n")[0][:40]
    if not lic or len(lic) > 38:
        cls = [c.split(" :: ")[-1] for c in info.get("classifiers", []) if c.startswith("License ::")]
        lic = cls[0] if cls else (lic or "?")
    cache[key] = {
        "name": info["name"], "version": info["version"], "summary": info.get("summary") or "",
        "license": lic, "pure": bool(pure), "wheels": len(wheels),
        # No wheel at all, only a source archive: pure Python can still be bundled, after
        # building a wheel from it at build time.
        "sdist_only": not wheels and bool(sdists), "sdist_size": sdists[0]["size"] if sdists else 0,
        "wheel": pure[0]["filename"] if pure else "", "url": pure[0]["url"] if pure else "",
        "sha256": pure[0]["digests"]["sha256"] if pure else "",
        "size": pure[0]["size"] if pure else 0,
        "requires": sorted({req_name(r) for r in (info.get("requires_dist") or []) if needed(r)}),
    }
    return cache[key]


def downloads(name):
    d = get_json(f"https://pypistats.org/api/packages/{norm(name)}/recent")
    return (d.get("data") or {}).get("last_month") if "_error" not in d else None   # None: unknown


def main():
    lock = json.loads(LOCK.read_text())["packages"]
    in_pyodide = {norm(k): v["version"] for k, v in lock.items()}
    for v in lock.values():   # import names too (e.g. "pyyaml" is listed as "PyYAML")
        in_pyodide.setdefault(norm(v["name"]), v["version"])
    cache, rows = {}, []
    for area, names in CANDIDATES.items():
        for name in names:
            top = pypi(name, cache)
            if "error" in top:
                rows.append({"area": area, "name": name, "error": top["error"]})
                continue
            # Resolve: everything the library needs that Pyodide lacks must be bundled too.
            extra, covered, blockers, seen = [], [], [], set()
            todo = list(top["requires"])
            while todo:
                dep = todo.pop()
                if dep in seen:
                    continue
                seen.add(dep)
                if dep in in_pyodide:
                    covered.append(dep)
                    continue
                info = pypi(dep, cache)
                if info.get("sdist_only"):
                    extra.append({"name": info["name"], "version": info["version"], "size": info["sdist_size"], "license": info["license"], "sdist_only": True})
                    todo.extend(info["requires"])
                    continue
                if "error" in info or not info["pure"]:
                    blockers.append(dep)
                    continue
                extra.append({"name": info["name"], "version": info["version"], "size": info["size"], "license": info["license"]})
                todo.extend(info["requires"])
            rows.append({
                "area": area, "name": top["name"], "version": top["version"], "summary": top["summary"],
                "license": top["license"], "pure": top["pure"], "sdist_only": top["sdist_only"], "in_pyodide": norm(name) in in_pyodide,
                "wheel": top["wheel"], "url": top["url"], "sha256": top["sha256"], "size": top["size"],
                "extra_deps": extra, "covered_deps": sorted(covered), "blockers": sorted(blockers),
                "total_size": (top["size"] or top["sdist_size"]) + sum(e["size"] for e in extra),
                "downloads_last_month": downloads(name),
            })
            r = rows[-1]
            time.sleep(1.5)   # pypistats rate limit
            kind = "in Pyodide" if r["in_pyodide"] else "wheel" if r["pure"] else "sdist only" if r["sdist_only"] else "compiled"
            print(f"{area:26} {r['name']:16} {r['version']:10} {kind:10} "
                  f"{r['total_size'] / 1024:7.0f} KB  {(r['downloads_last_month'] or 0) / 1e6 if r['downloads_last_month'] is not None else float('nan'):7.1f} M/mo  "
                  f"+{','.join(e['name'] for e in extra) or '-'}  blockers={','.join(blockers) or '-'}  {r['license']}")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"date": time.strftime("%Y-%m-%d"), "pyodide": "0.29.5", "rows": rows}, indent=1))
    print(f"\n→ {OUT}")


if __name__ == "__main__":
    main()
