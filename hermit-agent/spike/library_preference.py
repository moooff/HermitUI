"""Phase 3.5 study, part 3: which libraries does the model reach for?

A real model does everyday format tasks that name no library, in a build whose system
prompt suggests none (by default the committed build, saved to spike/out/study-app.html).
Every import it attempts is recorded, from step code and from the .py files it writes,
together with whether that module exists here. That shows what it reaches for first,
and what it falls back to when that is missing.

    ../benchmark/.venv/bin/python spike/library_preference.py --base-url http://localhost:8080/v1 --runs 2

Uses tests/e2e_reference.py's task driver. Results: spike/out/library_preference.json.
"""
import argparse
import json
import pathlib
import re
import subprocess
import sys
import time

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(line_buffering=True)
ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
import e2e_reference as ref  # noqa: E402

OUT = ROOT / "spike" / "out" / "library_preference.json"
LOCK = ROOT / "libs" / "pyodide-0.29.5" / "pyodide-lock.json"


def tiny_pdf(text):
    """A minimal one-page PDF with one line of text (so no PDF library is needed here)."""
    stream = f"BT /F1 18 Tf 72 720 Td ({text}) Tj ET".encode()
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
            b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream",
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    out, offsets = bytearray(b"%PDF-1.4\n"), []
    for i, o in enumerate(objs, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + o + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1) + b"".join(b"%010d 00000 n \n" % o for o in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
    return bytes(out)


CATALOG_XML = """<catalog><book id="b1"><title>Dune</title><price currency="EUR">9.99</price></book>
<book id="b2"><title>Emma</title><price currency="EUR">5.50</price></book></catalog>"""
NOTES_MD = "# Meeting notes\n\n- **Budget** approved\n- Next: hire 2 people\n\n| Item | Owner |\n|---|---|\n| Plan | Ana |\n"
PAGE_HTML = "<html><body><h1>Release 2.0</h1><p>New <b>dark mode</b> and <a href='https://x.org'>docs</a>.</p><ul><li>Faster</li><li>Smaller</li></ul></body></html>"
LATIN1 = "Name;Stadt\nMüller;Köln\nGroß;Düsseldorf\nSchäfer;Würzburg\n".encode("latin-1")
TITLES = "Grüße aus Köln\nÜber den Wolken: Ein Bericht\nStraßenbahn & Bus — Fahrplan 2026\n"

TASKS = [
    {"name": "excel", "files": {"sales.csv": ref.SALES_CSV}, "prompt": "Turn sales.csv into sales.xlsx with one sheet per region and a total row at the bottom of each sheet. Skip rows without a numeric amount."},
    {"name": "word", "files": {"inventory.csv": ref.INVENTORY_CSV}, "prompt": "Write report.docx: a short Word report with a heading, one paragraph, and a table of the items in inventory.csv whose qty is below min_qty."},
    {"name": "powerpoint", "files": {"monthly.csv": ref.MONTHLY_CSV}, "prompt": "Make deck.pptx, a 3-slide PowerPoint about monthly.csv: a title slide, a slide with a chart of the totals, and a summary slide."},
    {"name": "pdf create", "files": {"inventory.csv": ref.INVENTORY_CSV}, "prompt": "Make invoice.pdf: an invoice for 10 nuts at 0.20 and 5 washers at 0.15 (EUR), with a header, a table of the positions and the total."},
    {"name": "pdf read", "files": {"report.pdf": tiny_pdf("Quarterly revenue grew by 12 percent")}, "prompt": "What does report.pdf say? Give me its text."},
    {"name": "pdf merge", "files": {"a.pdf": tiny_pdf("Part A"), "b.pdf": tiny_pdf("Part B")}, "prompt": "Merge a.pdf and b.pdf into ab.pdf, a first, and tell me how many pages it has."},
    {"name": "markdown to html", "files": {"notes.md": NOTES_MD}, "prompt": "Convert notes.md to a styled, standalone notes.html (the table must stay a table)."},
    {"name": "html to markdown", "files": {"page.html": PAGE_HTML}, "prompt": "Convert page.html to Markdown, saved as page.md."},
    {"name": "text table", "files": {"inventory.csv": ref.INVENTORY_CSV}, "prompt": "Show inventory.csv as a neatly aligned plain-text table, and save it as table.txt."},
    {"name": "qr code", "files": {}, "prompt": "Make qr.png, a QR code for https://example.org."},
    {"name": "opendocument", "files": {"monthly.csv": ref.MONTHLY_CSV}, "prompt": "Convert monthly.csv to an OpenDocument spreadsheet, monthly.ods."},
    {"name": "stats chart", "files": {"grades.csv": ref.GRADES_CSV}, "prompt": "Make box.png: a box plot of the scores per subject in grades.csv, with the individual scores drawn on top."},
    {"name": "calendar", "files": {}, "prompt": "Create meeting.ics: a calendar invite for a 'Planning' meeting on 2026-10-12 from 09:00 to 10:00 Europe/Berlin time."},
    {"name": "slugs", "files": {"titles.txt": TITLES}, "prompt": "Make an ASCII URL slug for each line of titles.txt and write them to slugs.txt, one per line."},
    {"name": "fake data", "files": {}, "prompt": "Generate customers.csv with 50 rows of realistic fake German customer data: name, street, city, email, phone."},
    {"name": "encoding", "files": {"data.txt": LATIN1}, "prompt": "data.txt isn't UTF-8 and I don't know its encoding. Detect it and save a UTF-8 copy as data_utf8.txt."},
    {"name": "xml to json", "files": {"catalog.xml": CATALOG_XML}, "prompt": "Convert catalog.xml to catalog.json, keeping the attributes."},
    {"name": "number words", "files": {}, "prompt": "Write 1234.56 EUR in words, in English and in German, to amount.txt."},
]


def imports_in(code):
    names = set()
    for m in re.finditer(r"^[ \t]*(?:from[ \t]+([\w.]+)[ \t]+import|import[ \t]+([\w., \t]+))", code, re.M):
        if m.group(1):
            names.add(m.group(1).split(".")[0])
        else:
            for part in m.group(2).split(","):
                n = part.strip().split()[0] if part.strip() else ""
                if n:
                    names.add(n.split(".")[0])
    return names


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://localhost:8080/v1")
    ap.add_argument("--runs", type=int, default=2)
    ap.add_argument("--app", default="", help="default: the committed build (no library hint)")
    ap.add_argument("--only", default="")
    ap.add_argument("--deadline", type=int, default=600)
    args = ap.parse_args()
    app = pathlib.Path(args.app) if args.app else ROOT / "spike" / "out" / "study-app.html"
    if not args.app:
        app.parent.mkdir(parents=True, exist_ok=True)
        app.write_bytes(subprocess.run(["git", "-c", f"safe.directory={ROOT.parent}", "show", "HEAD:hermit-agent/dist/hermit-agent-standalone.html"],
                                       cwd=ROOT, capture_output=True, check=True).stdout)
    lock = json.loads(LOCK.read_text())["packages"]
    pyodide_imports = {i for v in lock.values() for i in v.get("imports", [])}
    stdlib = set(sys.stdlib_module_names)
    tasks = [t for t in TASKS if not args.only or any(o in t["name"] for o in args.only.split(","))]
    results = json.loads(OUT.read_text())["results"] if OUT.exists() and args.only else []
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        page = b.new_page()
        page.goto(app.resolve().as_uri())
        while page.evaluate("() => PY.state") != "idle":
            time.sleep(0.3)
        page.click("#settingsBtn")
        page.fill("#settingUrl", args.base_url)
        page.click("#settingSave")
        page.select_option("#effortSelect", "low")
        page.select_option("#autonomySelect", "autopilot")
        for run in range(1, args.runs + 1):
            for task in tasks:
                print(f"▶ run {run} · {task['name']}")
                r = ref.run_task(page, task, args.deadline)
                # A task still running at its deadline is stopped, so it can't spill into
                # the next one.
                if page.evaluate("() => RUN.active"):
                    page.click("#stopBtn")
                    while page.evaluate("() => RUN.active"):
                        time.sleep(0.5)
                info = page.evaluate("""() => ({
                    steps: S.timeline.filter(t => t.type === 'step').map(t => ({ code: t.ranCode || t.proposedCode || '', out: t.output || '' })),
                    py: [...WS.files].filter(([p]) => p.endsWith('.py')).map(([p, f]) => new TextDecoder().decode(WS.blobs.get(f.hash))),
                    files: [...WS.files.keys()] })""")
                # The agent's own modules (xml2json.py → import xml2json) aren't libraries.
                own = {f.rsplit("/", 1)[-1][:-3] for f in info["files"] if f.endswith(".py")}
                stdlib_or_own = stdlib | own
                seq, missing = [], []
                for s in info["steps"]:
                    for n in sorted(imports_in(s["code"])):
                        if n not in stdlib_or_own and n not in seq:
                            seq.append(n)
                    for m in re.findall(r"No module named '([\w.]+)'", s["out"]):
                        if m.split(".")[0] not in missing:
                            missing.append(m.split(".")[0])
                for code in info["py"]:
                    for n in sorted(imports_in(code)):
                        if n not in stdlib_or_own and n not in seq:
                            seq.append(n)
                row = {"task": task["name"], "run": run, "status": r.get("detail") or ("done" if r["passed"] else "?"),
                       "steps": r["steps"], "secs": r["secs"], "imports": seq,
                       "available": [n for n in seq if n in pyodide_imports], "unavailable": [n for n in seq if n not in pyodide_imports],
                       "module_not_found": missing, "files": info["files"], "answer": r["answer"][-300:]}
                results.append(row)
                print(f"   imports {seq}  missing {missing}  → {r['steps']} steps, {r['secs']} s")
                OUT.write_text(json.dumps({"date": time.strftime("%Y-%m-%d"), "app": str(app), "results": results}, indent=1))
        b.close()
    print(f"→ {OUT}")


if __name__ == "__main__":
    main()
