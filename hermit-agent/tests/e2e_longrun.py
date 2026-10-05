"""Phase 2a exit criterion: a 20+ step task survives an endpoint outage and a compaction,
and passes in 4 of 5 runs, against a real model.

    ../benchmark/.venv/bin/python tests/e2e_longrun.py --base-url http://localhost:8080/v1 [--runs 5]

The task is a treasure hunt of 22 questions (hunt.py, uploaded as your file): each correct
answer reveals the next question, so it takes at least one step per question. The app
talks to the real endpoint through a small proxy that this script controls, counting the
model requests that pass through it:
- request 6: a short outage (every connection refused for 25 s). The app's own retries
  must ride it out;
- request 11 on: the first reply that streams 3 KB is cut there (a short one can't be);
- request 16: a long outage (150 s), longer than the app's 2-minute retry window. The run
  must pause, not end. Once the proxy is back, the script presses Retry, as a user would.
The app keeps its default retry timings. Context size is set to 8,000 tokens with
4,096 max tokens per reply (so compaction starts near 4,000 tokens, the reply reserve
being capped at half the context); a hunt step adds only ~100–150 tokens, and at 12,000
the history never got there.

A run passes when all 22 answers are in, the final answer holds the code word, it took at
least 20 steps, the history was compacted, the outages and the drop all happened, and the
run carried on after each. Launch it detached and watch the log: a run takes 10–20 min.
"""
import argparse
import base64
import datetime
import http.client
import json
import pathlib
import sys
import threading
import time
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(line_buffering=True)
ROOT = pathlib.Path(__file__).resolve().parent.parent
APP_PATH = ROOT / "dist" / "hermit-agent-standalone.html"
CODE_WORD = "AURORA-7"

# [question, accepted answers]. Numbers match numerically, text case-insensitively.
QUESTIONS = [
    ["What is 17 × 23?", ["391"]],
    ["How many vowels (a, e, i, o, u) are in the word 'encyclopedia'?", ["5"]],
    ["How many files are in the folder clues/ of the workspace?", ["7"]],
    ["What is the sum of the digits of 2**20?", ["31"]],
    ["Reverse the string 'workspace'.", ["ecapskrow"]],
    ["What is the value of the key 'magic' in clues/config.json?", ["kestrel"]],
    ["What is the 10th Fibonacci number, if the 1st and the 2nd are both 1?", ["55"]],
    ["How many days lie between 2026-01-15 and 2026-03-01 (the later date minus the earlier)?", ["45"]],
    ["Which is larger, 3**7 or 7**3? Answer with the larger number.", ["2187"]],
    ["What is the word in clues/word.txt spelled backwards, in uppercase?", ["NRETNAL"]],
    ["What is the greatest common divisor of 462 and 1071?", ["21"]],
    ["What is 45 written in binary, without a 0b prefix?", ["101101"]],
    ["How many lines of clues/poem.txt contain the letter z?", ["3"]],
    ["How many prime numbers are there below 100?", ["25"]],
    ["What is 37 degrees Celsius in Fahrenheit?", ["98.6"]],
    ["What is the product of all the numbers in clues/numbers.txt?", ["360"]],
    ["What is the median of 7, 1, 9, 4, 3 and 8?", ["5.5"]],
    ["On which weekday did 2000-01-01 fall?", ["saturday"]],
    ["What are the first 8 hex characters of the SHA-256 digest of the string 'hermit'?", ["3348f46a"]],
    ["How many times does the letter s appear in 'Mississippi'?", ["4"]],
    ["What is 2**64 modulo 1000?", ["616"]],
    ["Sort these words alphabetically and give the third one: pear, apple, fig, cherry, banana.", ["cherry"]],
]

HUNT_PY = '''"""A treasure hunt of {n} questions. `import hunt; hunt.start()` shows the current question.
Answer question n with `hunt.answer(n, "your answer")`: a correct answer prints the next
question. Progress is kept in .hunt_state.json, so it survives an interpreter restart."""
import base64, json, zlib

_DATA = "{data}"
_STATE = "/workspace/.hunt_state.json"


def _hunt():
    return json.loads(zlib.decompress(base64.b64decode(_DATA)))


def _load():
    try:
        with open(_STATE) as f:
            return json.load(f)
    except Exception:
        return {{"solved": 0}}


def _match(value, accepted):
    v = str(value).strip().strip("'\\"").rstrip(".").replace(",", "").strip().lower()
    for a in accepted:
        try:
            if abs(float(v) - float(a)) < 1e-9:
                return True
        except ValueError:
            pass
        if v == a.lower():
            return True
    return False


def start():
    h, s = _hunt(), _load()
    q = h["questions"]
    if s["solved"] >= len(q):
        print("The hunt is complete. The code word is " + h["word"] + ".")
    else:
        print(f"Question {{s['solved'] + 1}} of {{len(q)}}: {{q[s['solved']][0]}}")


def answer(n, value):
    h, s = _hunt(), _load()
    q = h["questions"]
    cur = s["solved"] + 1
    if cur > len(q):
        return start()
    if n != cur:
        print(f"You are on question {{cur}}, not {{n}}.")
        return start()
    if not _match(value, q[cur - 1][1]):
        print(f"Not quite: {{value!r}} is not the answer to question {{cur}}. Try again.")
        return
    s["solved"] = cur
    with open(_STATE, "w") as f:
        json.dump(s, f)
    if cur == len(q):
        print("Correct! The hunt is complete. The code word is " + h["word"] + ". Tell the user the code word.")
    else:
        print(f"Correct! Question {{cur + 1}} of {{len(q)}}: {{q[cur][0]}}")
'''

CLUES = {
    "clues/config.json": json.dumps({"magic": "kestrel", "level": 3, "tags": ["a", "b"]}),
    "clues/word.txt": "lantern\n",
    "clues/poem.txt": "The lazy fox sleeps\nUnder a frozen moon\nBirds sing at dawn\nA breeze in the trees\nRivers run to the sea\nStars fade by morning\n",
    "clues/numbers.txt": "3\n4\n5\n6\n",
    "clues/a.txt": "nothing here\n",
    "clues/b.txt": "nothing here either\n",
    "clues/c.txt": "still nothing\n",
}

PROMPT = ("There is a treasure hunt in hunt.py (your file: don't change it). Run `import hunt; hunt.start()` to get "
          "the first question, and answer each question with hunt.answer(n, answer). Take one question per step: answer "
          "the current question, read the next question in the output, and answer it in your next step. Don't read "
          "hunt.py or decode its data; work only from the questions. Some questions are about files in clues/. When the "
          "hunt is complete, tell me the code word.")


def hunt_source():
    data = base64.b64encode(zlib.compress(json.dumps({"questions": QUESTIONS, "word": CODE_WORD}).encode())).decode()
    return HUNT_PY.format(n=len(QUESTIONS), data=data)


# ---------- The outage proxy ----------
class Proxy:
    """Forwards everything to the real endpoint, streaming replies through, and stages
    outages by model-request number (only /chat/completions POSTs count)."""

    def __init__(self, upstream, short_at=6, short_s=25, drop_at=11, long_at=16, long_s=150):
        u = urlsplit(upstream)
        self.host, self.port = u.hostname, u.port or 80
        self.plan = {short_at: ("down", short_s), drop_at: ("drop",), long_at: ("down", long_s)}
        self.chat = 0
        self.down_until = 0.0
        self.drop_armed = False
        self.events = []
        self.lock = threading.Lock()

    def log(self, what):
        self.events.append({"t": round(time.time(), 1), "chat": self.chat, "event": what})
        print(f"    🔌 proxy: {what} (model request {self.chat})")

    def is_down(self):
        return time.time() < self.down_until

    def reset(self):
        with self.lock:
            self.chat, self.down_until, self.drop_armed, self.events = 0, 0.0, False, []


def make_handler(px):
    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def refuse(self):
            self.close_connection = True
            try:
                self.connection.shutdown(2)
            except OSError:
                pass

        def forward(self):
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else None
            is_chat = self.command == "POST" and self.path.endswith("/chat/completions")
            drop = False
            with px.lock:
                if px.is_down():
                    return self.refuse()
                if is_chat:
                    px.chat += 1
                    act = px.plan.get(px.chat)
                    if act and act[0] == "down":
                        px.down_until = time.time() + act[1]
                        px.log(f"outage for {act[1]} s")
                        return self.refuse()
                    if act and act[0] == "drop":
                        px.drop_armed = True
                    drop = px.drop_armed
            headers = {k: v for k, v in self.headers.items() if k.lower() not in ("host", "connection", "keep-alive", "accept-encoding", "content-length")}
            conn = http.client.HTTPConnection(px.host, px.port, timeout=900)
            try:
                conn.request(self.command, self.path, body=body, headers=headers)
                resp = conn.getresponse()
            except OSError:
                return self.refuse()
            self.send_response(resp.status, resp.reason)
            for k, v in resp.getheaders():
                if k.lower() not in ("transfer-encoding", "connection", "keep-alive", "content-length"):
                    self.send_header(k, v)
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            sent = 0
            try:
                while True:
                    chunk = resp.read1(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
                    sent += len(chunk)
                    # Cut a reply that is well under way (one that streamed 3 KB): a short
                    # one can't be cut mid-way, so the drop waits for the next long one.
                    if drop and sent > 3000:
                        with px.lock:
                            px.drop_armed = False
                            px.log(f"stream cut after {sent} bytes")
                        self.connection.shutdown(2)
                        break
            except OSError:
                pass
            finally:
                conn.close()

        do_GET = do_POST = do_OPTIONS = forward

    return H


class QuietServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        pass


# ---------- One run ----------
def ev(page, js, arg=None):
    return page.evaluate(js, arg) if arg is not None else page.evaluate(js)


def run_once(page, px, deadline_s):
    px.reset()
    page.click("#newSessionBtn")
    if page.locator("#confirmModal.active").count():
        page.click("#confirmOk")
    while ev(page, "() => PY.state") != "idle":
        time.sleep(0.3)
    files = {"hunt.py": hunt_source(), **CLUES}
    page.set_input_files("#wsFileInput", files=[{"name": n.split("/")[-1], "mimeType": "text/plain", "buffer": c.encode()} for n, c in files.items() if "/" not in n])
    # clues/ keeps its folder: added through the same path as a folder upload.
    ev(page, "async (fs) => { const r = await addUserFiles(fs.map(([p, t]) => ({ path: p, bytes: new TextEncoder().encode(t) }))); reportUpload(r); }",
       [[n, c] for n, c in files.items() if "/" in n])
    while ev(page, "() => WS.files.size") < len(files):
        time.sleep(0.2)
    page.fill("#taskInput", PROMPT)
    page.click("#sendBtn")
    t0 = time.time()
    seen, approvals, resumed, answers = 0, [], 0, 0
    while time.time() - t0 < deadline_s:
        info = ev(page, """() => ({ status: S.status, active: RUN.active, last: (S.timeline[S.timeline.length - 1] || {}).type,
            steps: S.timeline.filter(t => t.type === 'step' && t.phase === 'done').map(t => ({ n: t.n, kind: t.kind, status: t.status,
            out: (t.output || '').slice(-140), retry: t.retryNote || '' })), comps: S.timeline.filter(t => t.type === 'compaction').length })""")
        for s in info["steps"][seen:]:
            print(f"    step {s['n']:>2}: {s['kind']:6} {s['status'] or '':8} {s['out'].strip()[-110:]!r}" + (f"  {s['retry']}" if s["retry"] else ""))
        seen = len(info["steps"])
        st = info["status"]
        if st == "awaiting-approval":
            reasons = ev(page, "() => { const t = S.timeline[S.timeline.length - 1]; return t.risk ? t.risk.reasons : []; }")
            print(f"    ⚠️  held: {'; '.join(reasons)} → approving")
            approvals.append(reasons)
            page.locator(".step-card.phase-pending-approval [data-action=approve]").click()
        elif st == "awaiting-user":
            page.fill("#taskInput", "Use your best judgement, and carry on with the hunt.")
            page.click("#sendBtn")
        elif st == "paused" and not info["active"] and info["last"] == "error":
            hint = ev(page, "() => S.timeline[S.timeline.length - 1].hint")
            print(f"    ⏸ paused by the outage: {hint}")
            while px.is_down():
                time.sleep(1)
            print("    ▶ the endpoint is back: pressing Retry")
            page.locator(".error-card [data-action=retry]").last.click()
            resumed += 1
        elif st == "paused" and not info["active"]:
            print("    ⏸ step limit → Continue")
            page.click("#continueBtn")
        elif st in ("done", "error", "stopped"):
            break
        time.sleep(1)
    status = ev(page, "() => S.status")
    answer = ev(page, "() => { const t = S.timeline.filter(t => t.type === 'step').pop(); return t ? t.content : ''; }") or ""
    solved = ev(page, "async () => { const r = await runInWorker('import json\\ntry:\\n    print(json.load(open(\"/workspace/.hunt_state.json\"))[\"solved\"])\\nexcept Exception as e:\\n    print(0)', { timeoutMs: 60000 }); return r.output; }")
    info = ev(page, """() => ({ steps: S.stepCount, comps: S.timeline.filter(t => t.type === 'compaction').map(t => [t.fromStep, t.toStep, t.reason]),
        retryNotes: S.timeline.filter(t => t.retryNote).map(t => [t.n, t.retryNote]), errors: S.timeline.filter(t => t.type === 'error').map(t => t.text),
        tokens: S.tokens })""")
    ev_kinds = [e["event"] for e in px.events]
    problems = []
    if status != "done":
        problems.append(f"ended in state {status}")
    if solved.strip() != str(len(QUESTIONS)):
        problems.append(f"solved {solved.strip()} of {len(QUESTIONS)}")
    if CODE_WORD.lower() not in answer.lower():
        problems.append("the final answer lacks the code word")
    if info["steps"] < 20:
        problems.append(f"only {info['steps']} steps")
    if not info["comps"]:
        problems.append("no compaction")
    if sum(k.startswith("outage") for k in ev_kinds) < 2 or not any(k.startswith("stream cut") for k in ev_kinds):
        problems.append(f"not every outage happened: {ev_kinds}")
    if not info["retryNotes"]:
        problems.append("no step recovered by retrying")
    if not resumed:
        problems.append("the long outage didn't pause the run")
    return {"passed": not problems, "detail": "; ".join(problems), "status": status, "solved": solved.strip(), "secs": round(time.time() - t0),
            "resumed": resumed, "approvals": approvals, "proxy": px.events, "answer": answer[-300:], **info}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://localhost:8080/v1")
    ap.add_argument("--model", default="")
    ap.add_argument("--effort", default="low")
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--deadline", type=int, default=3600, help="seconds per run")
    ap.add_argument("--app", default=str(APP_PATH))
    ap.add_argument("--out", default="")
    args = ap.parse_args()
    up = urlsplit(args.base_url)
    px = Proxy(f"{up.scheme}://{up.netloc}")
    server = QuietServer(("127.0.0.1", 0), make_handler(px))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    proxied = f"http://127.0.0.1:{server.server_address[1]}{up.path}"
    out = pathlib.Path(args.out) if args.out else ROOT / "tests" / "results" / f"longrun-{datetime.datetime.now():%Y%m%d-%H%M%S}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    results = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page()
        page.on("pageerror", lambda e: print("  [pageerror]", e))
        page.goto(pathlib.Path(args.app).resolve().as_uri())
        while ev(page, "() => PY.state") != "idle":
            time.sleep(0.3)
        page.click("#settingsBtn")
        page.fill("#settingUrl", proxied)
        page.fill("#settingModelInput", args.model)
        page.fill("#settingStepLimit", "60")
        page.fill("#settingMaxTokens", "4096")
        page.fill("#settingContextSize", "8000")
        page.click("#settingSave")
        page.select_option("#effortSelect", args.effort)
        page.select_option("#autonomySelect", "risk")
        for run in range(1, args.runs + 1):
            print(f"▶ run {run}/{args.runs} (via proxy {proxied}) …")
            r = run_once(page, px, args.deadline)
            r["run"] = run
            print(f"  {'✅' if r['passed'] else '❌'} run {run}: {r['steps']} steps, {r['secs']} s, compactions {r['comps']}, resumed {r['resumed']}× {r['detail']}")
            results.append(r)
            out.write_text(json.dumps({"base_url": args.base_url, "effort": args.effort, "results": results}, indent=1))
        browser.close()
    server.shutdown()
    passed = sum(r["passed"] for r in results)
    print(f"\nLONG RUN: {passed}/{len(results)} passed (exit criterion: 4 of 5) → {out}")
    sys.exit(0 if passed >= max(1, round(len(results) * 0.8)) else 1)


if __name__ == "__main__":
    main()
