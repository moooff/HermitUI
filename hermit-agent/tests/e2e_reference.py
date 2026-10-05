"""Real-model success measurement (ROADMAP Phase 2a, building on the Phase 1 exit
criterion): a real model works through a suite of tasks in the built app under
risk-based supervision, several runs each, reported as one pass rate.

    ../benchmark/.venv/bin/python tests/e2e_reference.py --base-url http://localhost:8080/v1 [--runs 3]
    ../benchmark/.venv/bin/python tests/e2e_reference.py --only "data processing,code + tests,calculation"   # Phase 1's three

Drives dist/hermit-agent-standalone.html like a user would: uploads the task's files,
starts the task, approves held steps (each one is logged with its reasons), answers
`ask:` questions with "Use your best judgement.", and checks the result inside the
same interpreter (or against the final answer). Tasks that change a file you uploaded
must be held for approval at least once: that is the real-model gating check. The first
three tasks are the spike's (spike/agent_loop.py). A run takes minutes per task: launch
it detached and watch the log. Results go to tests/results/ (gitignored) as JSON.
"""
import argparse
import datetime
import json
import pathlib
import sys
import time

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(line_buffering=True)
ROOT = pathlib.Path(__file__).resolve().parent.parent
APP_PATH = ROOT / "dist" / "hermit-agent-standalone.html"

SALES_CSV = """date,region,amount
2026-01-03,north,120.50
2026-01-17,south,80
03/01/2026,north,
2026-02-02,south,200.25
2026-02-14,north,n/a
2026-02-28,east,99.75
2026-03-05,north,310
15.03.2026,east,40
2026-03-20,south,
"""

STATS_PY = '''def mean(xs):
    return sum(xs) / len(xs)


def median(xs):
    """The middle value of xs; the mean of the two middle values when len(xs) is even."""
    n = len(xs)
    mid = n // 2
    if n % 2:
        return xs[mid]
    return (xs[mid] + xs[mid + 1]) / 2
'''

TEST_STATS_PY = '''import unittest
from stats import mean, median


class TestStats(unittest.TestCase):
    def test_mean(self):
        self.assertEqual(mean([1, 2, 3, 4]), 2.5)

    def test_median_odd(self):
        self.assertEqual(median([3, 1, 2]), 2)

    def test_median_even(self):
        self.assertEqual(median([4, 1, 3, 2]), 2.5)

    def test_median_single(self):
        self.assertEqual(median([7]), 7)
'''

ORDERS_JSON = json.dumps([
    {"id": 1, "customer": "acme", "status": "paid", "items": [{"sku": "A", "qty": 2, "unit_price": 9.99}, {"sku": "B", "qty": 1, "unit_price": 24.5}]},
    {"id": 2, "customer": "globex", "status": "cancelled", "items": [{"sku": "A", "qty": 10, "unit_price": 9.99}]},
    {"id": 3, "customer": "initech", "status": "paid", "items": [{"sku": "C", "qty": 3, "unit_price": 5.25}]},
    {"id": 4, "customer": "globex", "status": "paid", "items": [{"sku": "B", "qty": 2, "unit_price": 24.5}, {"sku": "C", "qty": 1, "unit_price": 5.25}]},
    {"id": 5, "customer": "acme", "status": "shipped", "items": [{"sku": "C", "qty": 4, "unit_price": 5.25}]},
], indent=1)

STORY_TXT = """The lighthouse keeper woke before the storm. The keeper climbed the stairs of the lighthouse and lit the lamp.
Ships passed in the night, and every ship saw the lamp. The keeper wrote the names of the ships in a book.
A storm came from the west. The storm bent the trees and the waves broke on the rocks.
The keeper kept the lamp burning, and the ships found the harbour. In the morning the keeper slept.
The lamp is still there, and the book of ships sits on a shelf in the lighthouse.
"""

SERVER_LOG = """2026-03-02 08:59:58 INFO GET /api/items 200 120ms
2026-03-02 09:01:12 INFO GET /api/items 200 95ms
2026-03-02 09:15:40 ERROR POST /api/orders 500 1830ms
2026-03-02 09:16:02 INFO GET /api/users 200 60ms
2026-03-02 09:44:19 ERROR GET /api/orders 502 2210ms
2026-03-02 10:05:00 INFO GET /api/items 200 110ms
2026-03-02 10:30:31 WARN GET /api/items 200 640ms
2026-03-02 11:02:13 ERROR DELETE /api/items/7 500 980ms
2026-03-02 11:20:45 INFO POST /api/login 200 230ms
2026-03-02 13:00:00 INFO GET /health 200 5ms
"""

GRADES_CSV = """student,subject,score
ana,math,90
ana,math,80
ana,art,70
ben,math,60
ben,art,95
ben,art,85
cai,math,75
cai,art,88
"""

CONFIG_INI = """[server]
host = localhost
timeout = 30
retries = 3
"""

APP_PY = '''import configparser


def load(path="config.ini"):
    cfg = configparser.ConfigParser()
    cfg.read(path)
    return cfg


def get_timeout(path="config.ini"):
    return load(path).getint("server", "timeout")


def get_retries(path="config.ini"):
    return load(path).getint("server", "retries")
'''

CUSTOMERS_CSV = "id,name,city\n1,Alice,Berlin\n2,Bob,Paris\n3,Chen,Rome\n4,Dana,Oslo\n"
ORDERS_CSV = "id,customer_id,amount\n1,1,120.0\n2,2,80.5\n3,1,30.0\n4,3,200.25\n5,2,99.5\n6,4,10\n"
MONTHLY_CSV = "month,total\n2026-01,200.5\n2026-02,300.0\n2026-03,350.0\n2026-04,280.75\n"
INVENTORY_CSV = "item,qty,min_qty\nbolts,120,100\nnuts,40,100\nwashers,5,50\nscrews,300,250\nrivets,0,20\n"

# Each task: files to upload, the prompt, and how to check the result: `check` runs in the
# agent's interpreter and must print CHECK OK; `answer_contains` (all of them) is matched
# against the final answer with commas and spaces removed; `needs_approval` means a step
# must have been held because it changed one of your files.
TASKS = [
    {
        "name": "data processing",
        "files": {"sales.csv": SALES_CSV},
        "prompt": "sales.csv has messy rows. Drop rows whose amount is missing or not a number. Dates come in several formats (ISO, DD/MM/YYYY, DD.MM.YYYY). Write monthly_totals.csv with columns month,total where month is YYYY-MM, sorted by month, and tell me the totals.",
        "check": """
import csv
rows = {r["month"]: round(float(r["total"]), 2) for r in csv.DictReader(open("/workspace/monthly_totals.csv"))}
assert rows == {"2026-01": 200.5, "2026-02": 300.0, "2026-03": 350.0}, rows
print("CHECK OK")
""",
    },
    {
        "name": "code + tests",
        "files": {},
        "prompt": "Write roman.py with to_roman(n) and from_roman(s) for 1..3999 (from_roman must raise ValueError on invalid numerals), plus test_roman.py with unittest tests. Run the tests and report the result.",
        "check": """
import importlib, sys
sys.modules.pop("roman", None)
import roman
assert roman.to_roman(1994) == "MCMXCIV" and roman.to_roman(3999) == "MMMCMXCIX"
assert all(roman.from_roman(roman.to_roman(i)) == i for i in range(1, 4000))
for bad in ["IIII", "IC", "MMMM", "ABC", ""]:
    try:
        roman.from_roman(bad)
        raise AssertionError("accepted " + repr(bad))
    except ValueError:
        pass
import os
assert os.path.exists("/workspace/test_roman.py")
print("CHECK OK")
""",
    },
    {
        "name": "calculation",
        "files": {},
        "prompt": "What is the sum of all primes below 2,000,000? Compute it, don't recall it.",
        "answer_contains": ["142913828922"],
    },
    {
        "name": "fix a bug in your file",
        "files": {"stats.py": STATS_PY, "test_stats.py": TEST_STATS_PY},
        "prompt": "The tests in test_stats.py fail. Fix the bug in stats.py so that all tests pass, without changing the tests, and run them to show they pass.",
        "needs_approval": True,
        "check": """
import sys, hashlib
sys.modules.pop("stats", None)
import stats
assert stats.median([5, 3, 1]) == 3 and stats.median([10, 2, 8, 4]) == 6.0 and stats.median([1]) == 1 and stats.median([2, 1]) == 1.5
assert hashlib.sha256(open("/workspace/test_stats.py", "rb").read()).hexdigest() == TEST_HASH, "test_stats.py was changed"
print("CHECK OK")
""",
    },
    {
        "name": "json transform",
        "files": {"orders.json": ORDERS_JSON},
        "prompt": "orders.json lists orders with their items. Compute the revenue per customer (quantity × unit price, skipping cancelled orders) and write revenue.csv with columns customer,revenue, sorted by revenue from highest to lowest, revenue rounded to 2 decimals.",
        "check": """
import csv
rows = [(r["customer"], round(float(r["revenue"]), 2)) for r in csv.DictReader(open("/workspace/revenue.csv"))]
assert rows == [("acme", 65.48), ("globex", 54.25), ("initech", 15.75)], rows
print("CHECK OK")
""",
    },
    {
        "name": "word frequency",
        "files": {"story.txt": STORY_TXT},
        "prompt": "Find the 5 most frequent words in story.txt: case-insensitive, punctuation ignored, and leave out these stopwords: the, a, and, of, to, in. Write them to top_words.txt, one 'word count' per line (word, a space, the count), most frequent first.",
        "check": """
lines = [l.split() for l in open("/workspace/top_words.txt").read().strip().splitlines()]
got = {w.lower(): int(c) for w, c in lines}
assert got == {"keeper": 5, "lamp": 4, "ships": 4, "lighthouse": 3, "storm": 3}, got
counts = [int(c) for w, c in lines]
assert counts == sorted(counts, reverse=True), counts
print("CHECK OK")
""",
    },
    {
        "name": "log analysis",
        "files": {"server.log": SERVER_LOG},
        "prompt": "server.log is a web server log. Write errors_by_hour.csv with columns hour,errors, where hour is 'YYYY-MM-DD HH', listing only the hours with at least one ERROR line, sorted by hour. Then tell me the average response time over all requests in ms, rounded to one decimal.",
        "answer_contains": ["628.0"],
        "check": """
import csv
rows = [(r["hour"].strip(), int(r["errors"])) for r in csv.DictReader(open("/workspace/errors_by_hour.csv"))]
assert rows == [("2026-03-02 09", 2), ("2026-03-02 11", 1)], rows
print("CHECK OK")
""",
    },
    {
        "name": "spec to code",
        "files": {},
        "prompt": "Write slugify.py with slugify(text): lowercase the text, transliterate ä→ae, ö→oe, ü→ue and ß→ss, replace every run of characters other than a-z and 0-9 with a single hyphen, and strip hyphens from both ends. Add unittest tests in test_slugify.py and run them.",
        "check": """
import sys
sys.modules.pop("slugify", None)
from slugify import slugify
cases = {"Hello, World!": "hello-world", "  Grüße aus Köln  ": "gruesse-aus-koeln", "Straße & Ölmühle": "strasse-oelmuehle",
         "---a__b---": "a-b", "Ärger": "aerger", "": "", "R2-D2": "r2-d2"}
for k, v in cases.items():
    assert slugify(k) == v, (k, slugify(k), v)
import os
assert os.path.exists("/workspace/test_slugify.py")
print("CHECK OK")
""",
    },
    {
        "name": "chart (matplotlib)",
        "files": {"monthly.csv": MONTHLY_CSV},
        "prompt": "Make a bar chart of monthly.csv with the month on the x axis and the total on the y axis, give it a title, and save it as chart.png.",
        "check": """
data = open("/workspace/chart.png", "rb").read()
assert data[:8] == b"\\x89PNG\\r\\n\\x1a\\n" and len(data) > 2000, len(data)
print("CHECK OK")
""",
    },
    {
        "name": "pandas pivot",
        "files": {"grades.csv": GRADES_CSV},
        "prompt": "Using pandas, make a pivot table of grades.csv with one row per student and one column per subject holding the mean score, save it as pivot.csv (the student in the first column), and tell me which student has the highest overall average score.",
        "answer_contains": ["cai"],
        "check": """
import csv
rows = list(csv.reader(open("/workspace/pivot.csv")))
head = [h.strip().lower() for h in rows[0]]
got = {}
for r in rows[1:]:
    if not r or not r[0].strip():
        continue
    got[r[0].strip().lower()] = {head[i]: float(r[i]) for i in range(1, len(r)) if head[i] in ("math", "art") and r[i].strip()}
assert got.get("ana") == {"math": 85.0, "art": 70.0} and got.get("ben") == {"math": 60.0, "art": 90.0} and got.get("cai") == {"math": 75.0, "art": 88.0}, got
print("CHECK OK")
""",
    },
    {
        "name": "rename a setting in your files",
        "files": {"config.ini": CONFIG_INI, "app.py": APP_PY},
        "prompt": "Rename the setting 'timeout' to 'request_timeout' in config.ini and update app.py to match. Keep the function names: get_timeout() must still return the value.",
        "needs_approval": True,
        "check": """
import configparser, sys
cfg = configparser.ConfigParser()
cfg.read("/workspace/config.ini")
assert cfg.getint("server", "request_timeout") == 30 and not cfg.has_option("server", "timeout"), dict(cfg["server"])
sys.modules.pop("app", None)
import app
assert app.get_timeout() == 30 and app.get_retries() == 3
print("CHECK OK")
""",
    },
    {
        "name": "sqlite",
        "files": {"customers.csv": CUSTOMERS_CSV, "orders.csv": ORDERS_CSV},
        "prompt": "Load customers.csv and orders.csv into an SQLite database shop.db, with tables named customers and orders. Then use SQL to find the customer with the largest total order amount, and tell me their name and total.",
        "answer_contains": ["Chen", "200.25"],
        "check": """
import sqlite3
con = sqlite3.connect("/workspace/shop.db")
assert con.execute("select count(*) from customers").fetchone()[0] == 4
assert con.execute("select count(*) from orders").fetchone()[0] == 6
print("CHECK OK")
""",
    },
    {
        "name": "counting",
        "files": {},
        "prompt": "How many integers from 1 to 10,000 inclusive are divisible by 3 or by 5, but not by 15? Compute it.",
        "answer_contains": ["4001"],
    },
    {
        "name": "dates",
        "files": {},
        "prompt": "How many weekdays (Monday to Friday) are there in the year 2027, not counting these holidays: 2027-01-01, 2027-12-24, 2027-12-25 and 2027-12-31? Compute it.",
        "answer_contains": ["258"],
    },
    {
        "name": "markdown report",
        "files": {"inventory.csv": INVENTORY_CSV},
        "prompt": "Read inventory.csv and write reorder.md: a Markdown table of the items whose qty is below min_qty, with the columns Item, Qty and Missing (min_qty minus qty), sorted by Missing from highest to lowest.",
        "check": """
rows = [l.strip().strip("|").split("|") for l in open("/workspace/reorder.md") if l.strip().startswith("|")]
rows = [[c.strip().strip("*`").lower() for c in r] for r in rows]
body = [r for r in rows if r and r[0] not in ("item", "") and not set(r[0]) <= set("-: ")]
assert [r[0] for r in body] == ["nuts", "washers", "rivets"], body
assert [int(float(r[2])) for r in body] == [60, 45, 20], body
print("CHECK OK")
""",
    },
]


def ev(page, js, arg=None):
    return page.evaluate(js, arg) if arg is not None else page.evaluate(js)


def run_task(page, task, deadline_s):
    page.click("#newSessionBtn")
    if page.locator("#confirmModal.active").count():
        page.click("#confirmOk")
    while ev(page, "() => PY.state") != "idle":
        time.sleep(0.3)
    if task["files"]:
        page.set_input_files("#wsFileInput", files=[{"name": n, "mimeType": "text/plain", "buffer": c.encode()} for n, c in task["files"].items()])
        while ev(page, "() => WS.files.size") < len(task["files"]):
            time.sleep(0.2)
    page.fill("#taskInput", task["prompt"])
    page.click("#sendBtn")
    t0 = time.time()
    seen = 0
    approvals = []
    while time.time() - t0 < deadline_s:
        info = ev(page, """() => ({ status: S.status, steps: S.timeline.filter(t => t.type === 'step' && t.phase === 'done').map(t => ({
            n: t.n, kind: t.kind, status: t.status, decision: t.decision, out: (t.output || '').slice(-160), content: t.content })) })""")
        for s in info["steps"][seen:]:
            print(f"    step {s['n']}: {s['kind']:6} {s['status'] or '':9} {s['decision'] or '':10} {s['out'].strip()[-100:]!r}")
        seen = len(info["steps"])
        st = info["status"]
        if st == "awaiting-approval":
            reasons = ev(page, "() => { const t = S.timeline[S.timeline.length - 1]; return t.risk ? t.risk.reasons : []; }")
            print(f"    ⚠️  held: {'; '.join(reasons)} → approving")
            approvals.append(reasons)
            page.locator(".step-card.phase-pending-approval [data-action=approve]").click()
        elif st == "awaiting-user":
            q = ev(page, "() => S.timeline[S.timeline.length - 1].question")
            print(f"    ❓ {q!r} → answering")
            page.fill("#taskInput", "Use your best judgement.")
            page.click("#sendBtn")
        elif st in ("done", "error", "paused", "stopped"):
            break
        time.sleep(1)
    elapsed = time.time() - t0
    status = ev(page, "() => S.status")
    answer = ev(page, "() => { const t = S.timeline.filter(t => t.type === 'step').pop(); return t ? t.content : ''; }") or ""
    steps = ev(page, "() => S.stepCount")
    tokens = ev(page, "() => S.tokens")
    base = {"name": task["name"], "steps": steps, "secs": round(elapsed), "tokens": tokens, "approvals": approvals, "answer": answer[-400:]}
    if status != "done":
        return {**base, "passed": False, "detail": f"ended in state {status}" + ("" if time.time() - t0 < deadline_s else " (deadline)")}
    problems = []
    flat = answer.replace(",", "").replace(" ", "")
    for want in task.get("answer_contains", []):
        if want.replace(",", "").replace(" ", "") not in flat:
            problems.append(f"answer lacks {want!r}")
    if "check" in task:
        code = task["check"].replace("TEST_HASH", repr(__import__("hashlib").sha256(TEST_STATS_PY.encode()).hexdigest()))
        out = ev(page, "async (c) => { const r = await runInWorker(c, { timeoutMs: 120000 }); return r.output; }", code)
        if "CHECK OK" not in out:
            problems.append("check: " + out[-500:])
    if task.get("needs_approval") and not any(any("your file" in r for r in a) for a in approvals):
        problems.append("no step was held for changing your file")
    return {**base, "passed": not problems, "detail": "; ".join(problems)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://localhost:8080/v1")
    ap.add_argument("--model", default="")
    ap.add_argument("--browser", default="chromium")
    ap.add_argument("--effort", default="low")
    ap.add_argument("--runs", type=int, default=1, help="runs of the whole suite")
    ap.add_argument("--deadline", type=int, default=1200, help="seconds per task")
    ap.add_argument("--only", default="", help="comma-separated substrings of task names")
    ap.add_argument("--app", default=str(APP_PATH), help="the built HTML file to test")
    ap.add_argument("--out", default="", help="results JSON (default: tests/results/success-<time>.json)")
    args = ap.parse_args()
    tasks = [t for t in TASKS if not args.only or any(o.strip() and o.strip() in t["name"] for o in args.only.split(","))]
    out = pathlib.Path(args.out) if args.out else ROOT / "tests" / "results" / f"success-{datetime.datetime.now():%Y%m%d-%H%M%S}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    results = []
    started = time.time()
    with sync_playwright() as pw:
        browser = getattr(pw, args.browser).launch()
        page = browser.new_page()
        page.on("pageerror", lambda e: print("  [pageerror]", e))
        page.goto(pathlib.Path(args.app).resolve().as_uri())
        while ev(page, "() => PY.state") != "idle":
            time.sleep(0.3)
        page.click("#settingsBtn")
        page.fill("#settingUrl", args.base_url)
        page.fill("#settingModelInput", args.model)
        page.click("#settingSave")
        page.select_option("#effortSelect", args.effort)
        page.select_option("#autonomySelect", "risk")
        for run in range(1, args.runs + 1):
            for task in tasks:
                print(f"▶ run {run}/{args.runs} · {task['name']} …")
                r = run_task(page, task, args.deadline)
                r["run"] = run
                print(f"  {'✅' if r['passed'] else '❌'} {task['name']}: {r['steps']} steps, {r['secs']} s {r.get('detail', '')}")
                results.append(r)
                out.write_text(json.dumps({"base_url": args.base_url, "model": args.model, "effort": args.effort, "results": results}, indent=1))
        browser.close()
    passed = sum(r["passed"] for r in results)
    print(f"\n{'task':34} pass rate")
    for task in tasks:
        rs = [r for r in results if r["name"] == task["name"]]
        print(f"{task['name']:34} {sum(r['passed'] for r in rs)}/{len(rs)}" + "".join(f"  ❌ run {r['run']}: {r['detail'][:120]}" for r in rs if not r["passed"]))
    print(f"\nPASS RATE: {passed}/{len(results)} = {100 * passed / max(1, len(results)):.0f} % "
          f"({len(tasks)} tasks × {args.runs} run{'s' if args.runs != 1 else ''}, {round((time.time() - started) / 60)} min) → {out}")
    sys.exit(0 if results and passed == len(results) else 1)


if __name__ == "__main__":
    main()
