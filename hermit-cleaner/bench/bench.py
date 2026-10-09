"""Benchmark the Reword step of HermitUI Cleaner across GGUF models.

Drives the unmodified built app in headless Chromium, so what is measured is what a
user gets: the app's own prompt, sentence grouping, refusal checks and second cleanup.

Backends:
  server (default)  llama.cpp's llama-server on the GPU, started per model by this
                    script (a pinned CUDA build is downloaded once into ~/.cache).
                    Several pages run at once against --parallel server slots, so a
                    small model takes a minute or two.
  wllama            the in-browser engine of dist/hermit-cleaner-wllama.html, on the
                    CPU (or --webgpu): slow, but what the -wllama file really does.
  --api URL         an OpenAI-compatible server that is already running (one model).

Each model rewords every text in corpus.json by sentence at each change level,
--runs times, after one warm-up run per page. Then a judge model (default: the
local gpt-oss-20b, on the same llama-server) scores every rewrite 1-5 for meaning,
grammar and naturalness. Results go to bench/results/<time>-<label>/: review.md (the
summary, the problems the judge found, a recommendation), samples.md (every pair) and
run.json.

    ../benchmark/.venv/bin/python bench/bench.py                       # default ladder
    ../benchmark/.venv/bin/python bench/bench.py --models Qwen3-4B-Q4_K_M.gguf --runs 1
    ../benchmark/.venv/bin/python bench/bench.py --judge none --levels light
    ../benchmark/.venv/bin/python bench/bench.py --backend wllama --models Qwen3-1.7B-Q4_K_M.gguf

Models are read from --models-dir (default ../benchmark/models, filled by
../benchmark/download_models.py). See bench/README.md.
"""
import argparse
import asyncio
import concurrent.futures
import datetime
import functools
import http.server
import json
import os
import pathlib
import re
import shutil
import statistics
import subprocess
import sys
import tarfile
import threading
import time
import urllib.request

from playwright.async_api import async_playwright

sys.stdout.reconfigure(line_buffering=True)

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
REPO = ROOT.parent

LLAMA_TAG = "b11531"
LLAMA_ASSETS = [f"llama-{LLAMA_TAG}-bin-ubuntu-cuda-12.8-x64.tar.gz", f"cudart-llama-{LLAMA_TAG}-bin-ubuntu-cuda-12.8-x64.tar.gz"]
CACHE = pathlib.Path(os.environ.get("XDG_CACHE_HOME", pathlib.Path.home() / ".cache")) / "hermit-cleaner-bench"
DEFAULT_MODELS = ["Qwen3-0.6B-Q4_K_M.gguf", "Qwen3-1.7B-Q4_K_M.gguf", "Qwen3-4B-Q4_K_M.gguf", "Qwen3.5-4B-Q4_K_M.gguf", "Qwen3-8B-Q4_K_M.gguf",
                  "gemma-4-E2B-it-Q4_K_M.gguf", "gemma-4-E4B-it-Q4_K_M.gguf"]
JUDGES = ["gpt-oss-20b-MXFP4.gguf", "Qwen3-8B-Q4_K_M.gguf"]
LANG_NAMES = {"en": "English", "de": "German", "fr": "French"}
WARMUP = "This is a short warm-up sentence that the model can reword without any trouble at all."
VRAM_BUSY_MB = 3000   # more than this in use before a run: something else holds the GPU


def log(msg):
    print(f"[{datetime.datetime.now():%H:%M:%S}] {msg}")


# ----- metrics (the same word alignment as wordDiff in src/script.js) -----

def words(s):
    return [w.lower() for w in re.findall(r"[^\W_]+", s)]


def change_ratio(a, b):
    x, y = words(a), words(b)
    if not x and not y:
        return 0.0
    n, m = len(x), len(y)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            dp[i][j] = dp[i + 1][j + 1] + 1 if x[i] == y[j] else max(dp[i + 1][j], dp[i][j + 1])
    return 1 - dp[0][0] / max(n, m)


def numbers_kept(a, b):
    norm = lambda s: sorted(re.sub(r"(?<=\d)[.,](?=\d{3}\b)", "", n) for n in re.findall(r"\d[\d.,]*\d|\d", s))
    return norm(a) == norm(b)


def stock_count(s, phrases):
    low = s.lower()
    return sum(low.count(p) for p in phrases)


def stock_added(a, b, phrases):
    """Stock phrases the rewrite `b` has more often than the original `a`: brought in by the model."""
    la, lb = a.lower(), b.lower()
    return sum(max(0, lb.count(p) - la.count(p)) for p in phrases)


# ----- llama-server -----

def ensure_llama_server():
    """The pinned llama-server, downloaded and unpacked into the cache on first use."""
    target = CACHE / f"llama.cpp-{LLAMA_TAG}"
    found = list(target.rglob("llama-server")) if target.exists() else []
    if found:
        return found[0]
    target.mkdir(parents=True, exist_ok=True)
    for name in LLAMA_ASSETS:
        archive = target / "dl" / name
        if not archive.exists():
            archive.parent.mkdir(exist_ok=True)
            log(f"downloading {name} \u2026")
            urllib.request.urlretrieve(f"https://github.com/ggml-org/llama.cpp/releases/download/{LLAMA_TAG}/{name}", archive)
        with tarfile.open(archive) as tf:
            tf.extractall(target / "bin", filter="data")
    found = list(target.rglob("llama-server"))
    if not found:
        sys.exit(f"llama-server not found in {target}")
    # The CUDA runtime from the cudart archive must sit next to the binary.
    for lib in (target / "bin").rglob("*.so*"):
        dest = found[0].parent / lib.name
        if not dest.exists():
            shutil.copy2(lib, dest)
    found[0].chmod(0o755)
    return found[0]


class LlamaServer:
    def __init__(self, binary, model, port, parallel, ctx, log_path, gpu_layers):
        self.url = f"http://127.0.0.1:{port}"
        env = dict(os.environ, LD_LIBRARY_PATH=f"{binary.parent}:{os.environ.get('LD_LIBRARY_PATH', '')}")
        self.log_file = open(log_path, "w")
        cmd = [str(binary), "-m", str(model), "--alias", model.stem, "--host", "127.0.0.1", "--port", str(port),
               "-c", str(ctx * parallel), "-np", str(parallel), "-ngl", str(gpu_layers), "--jinja", "--metrics",
               # Parallel slots sharing one KV cache shifted replies measurably (an English
               # sentence came back German 92 of 120 times with German requests in flight,
               # 27 without the shared cache); separate caches cost nothing at this size.
               "--no-kv-unified"]
        self.proc = subprocess.Popen(cmd, env=env, stdout=self.log_file, stderr=subprocess.STDOUT)

    def wait_ready(self, timeout=600):
        end = time.time() + timeout
        while time.time() < end:
            if self.proc.poll() is not None:
                return False
            try:
                with urllib.request.urlopen(self.url + "/health", timeout=5) as r:
                    if r.status == 200:
                        return True
            except Exception:
                pass
            time.sleep(1)
        return False

    def metrics(self):
        try:
            with urllib.request.urlopen(self.url + "/metrics", timeout=5) as r:
                text = r.read().decode()
        except Exception:
            return {}
        return {k: float(v) for k, v in re.findall(r"^llamacpp:(\w+) ([\d.e+-]+)$", text, re.M)}

    def stop(self):
        self.proc.terminate()
        try:
            self.proc.wait(30)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        self.log_file.close()


def gpu_memory_mb():
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=memory.used,memory.total,name", "--format=csv,noheader,nounits"],
                             capture_output=True, text=True, timeout=10).stdout.strip().split(", ")
        return int(out[0]), int(out[1]), out[2]
    except Exception:
        return None


# ----- static server for the app (and, for wllama, the models) -----

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Cross-origin isolation lets wllama use every CPU thread.
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass


def serve_dir(directory):
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=str(directory)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1]


# ----- driving the app -----

async def wait_for(page, js, timeout):
    end = time.time() + timeout
    while time.time() < end:
        if await page.evaluate(js):
            return True
        await asyncio.sleep(0.2)
    return False


async def configure_api(page, api_url, model_name):
    await page.click("#settingsBtn")
    await page.fill("#settingUrl", api_url)
    await page.fill("#settingModel", model_name)
    await page.click("#settingsSave")


async def load_wllama(page, url, webgpu, timeout=900):
    await page.click("#settingsBtn")
    await page.select_option("#settingBackend", "wllama")
    await page.evaluate("document.querySelector('.model-options').open = true")
    if await page.is_enabled("#wllamaWebGpu"):
        await page.set_checked("#wllamaWebGpu", webgpu)
    await page.fill("#wllamaUrl", url)
    await page.click("#wllamaUrlBtn")
    await wait_for(page, "/Ready|Error/.test(document.getElementById('wllamaStatus').textContent)", timeout)
    status = await page.text_content("#wllamaStatus")
    await page.click("#settingsSave")
    return "Ready" in status, status


async def run_once(page, text, level, unit="sentence", share="1", timeout=1800):
    await page.evaluate("t => { const el = document.getElementById('inputText'); el.value = t; el.dispatchEvent(new Event('input')); }", text)
    await page.set_checked("#optClean", True)
    await page.set_checked("#optReword", True)
    await page.set_checked("#optTypos", False)
    await page.select_option("#optShare", share)
    await page.select_option("#optUnit", unit)
    await page.select_option("#optLevel", level)
    started = time.time()
    await page.click("#runBtn")
    await wait_for(page, "!document.body.classList.contains('is-running') && !!document.getElementById('status').textContent", timeout)
    secs = time.time() - started
    spans = await page.evaluate("""() => Array.from(document.querySelectorAll('#outputText .m-reword'),
        s => ({ original: s.title.replace(/^Reworded. Original:\\n/, ''), rewrite: s.textContent }))""")
    # Sentences the app removed outright for being nothing but stock phrases.
    gone = await page.evaluate("""() => Array.from(document.querySelectorAll('#outputText .m-removed'), s => s.title)
        .map(t => (t.match(/stock phrase "([\\s\\S]*)"$/) || [])[1]).filter(Boolean)""")
    report = await page.inner_text("#report")
    m = re.search(r"Rewording: (\d+) of (\d+)", report)
    un = re.search(r"(\d+) \w+ came back unchanged", report)
    re2 = re.search(r"(\d+) \w+ got a second try, (\d+) of them", report)
    return {
        "secs": secs,
        "status": await page.text_content("#status"),
        "spans": spans,
        "gone": gone,
        "done": int(m.group(1)) if m else 0,
        "eligible": int(m.group(2)) if m else 0,
        "unchanged": int(un.group(1)) if un else 0,
        "retried": int(re2.group(1)) if re2 else 0,
        "rescued": int(re2.group(2)) if re2 else 0,
        "refused": re.findall(r'^".*?": (.*?) \u2014 kept the original\.$', report, re.M),
    }


async def bench_model(browser, app_url, setup, jobs, pages, corpus):
    """Run `jobs` (text, level, run) on `pages` parallel pages after `setup(page)`."""
    texts = {t["id"]: t for t in corpus["texts"]}
    queue = asyncio.Queue()
    for j in jobs:
        queue.put_nowait(j)
    results, errors = [], []

    async def worker(n):
        page = await browser.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        await page.goto(app_url)
        ok, why = await setup(page)
        if not ok:
            errors.append(why)
            await page.close()
            return
        await run_once(page, WARMUP, "light", "paragraph")
        while not queue.empty():
            text_id, level, run = queue.get_nowait()
            t = texts[text_id]
            r = await run_once(page, t["text"], level)
            if r["status"].startswith("\u274c"):
                errors.append(f"{text_id}/{level}: {r['status']}")
            phrases = corpus["stock_phrases"].get(t["lang"], [])
            pairs = [{**s, "change": change_ratio(s["original"], s["rewrite"]),
                      "numbers": numbers_kept(s["original"], s["rewrite"]),
                      "names": all(nm in s["rewrite"] for nm in t["names"] if nm in s["original"]),
                      "stock_before": stock_count(s["original"], phrases), "stock_after": stock_count(s["rewrite"], phrases),
                      "stock_added": stock_added(s["original"], s["rewrite"], phrases)}
                     for s in r["spans"]]
            results.append({"text": text_id, "lang": t["lang"], "level": level, "run": run, "secs": r["secs"],
                            "removed": r["gone"], "removed_stock": sum(stock_count(g, phrases) for g in r["gone"]),
                            "done": r["done"], "eligible": r["eligible"], "unchanged": r["unchanged"],
                            "retried": r["retried"], "rescued": r["rescued"],
                            "refused": r["refused"], "pairs": pairs, "status": r["status"]})
        await page.close()

    await asyncio.gather(*(worker(n) for n in range(pages)))
    return results, errors


# ----- judge -----

JUDGE_SYSTEM = """You check the work of an editor whose job is to make AI-written text read as if a person wrote it.
You get an ORIGINAL passage and the editor's REWRITE, both in {lang}. Replacing hype words, stock phrases and filler
with plainer words, and small shifts in emphasis, are the intended job: they don't lower the meaning score.
Score the REWRITE from 1 to 5 on each scale:
- meaning: 5 = every fact, number, name and claim is still there and still says the same. 4 = a nuance is lost.
  3 = a fact or claim is lost, or clearly weakened or exaggerated. 2 = a fact is wrong or added. 1 = the meaning is
  turned around (for example "underestimate" became "overestimate").
- grammar: 5 = flawless {lang}. Lower it for every grammar, spelling or word-choice error. 1 = many errors.
- natural: 5 = reads like a fluent person wrote it. 1 = awkward or machine-like.
Name each concrete problem briefly in "issues" (an empty string if there is none). Reply with JSON only."""

JUDGE_SCHEMA = {
    "type": "object",
    "properties": {"meaning": {"type": "integer", "minimum": 1, "maximum": 5},
                   "grammar": {"type": "integer", "minimum": 1, "maximum": 5},
                   "natural": {"type": "integer", "minimum": 1, "maximum": 5},
                   "issues": {"type": "string"}},
    "required": ["meaning", "grammar", "natural", "issues"],
}


# Known pairs, scored before the real work: the report says whether the judge caught them.
JUDGE_CALIBRATION = [
    ("de", "Viele Gesch\u00e4ftsf\u00fchrer untersch\u00e4tzen den Aufwand, der mit neuer Software verbunden ist.",
     "Viele Gesch\u00e4ftsf\u00fchrer \u00fcbersch\u00e4tzen den Aufwand, der mit neuer Software verbunden ist.",
     "meaning turned around", lambda v: v["meaning"] <= 2),
    ("en", "Employees save an average of 72 minutes per day by not commuting.",
     "Employees save about 27 minutes a day by not commuting.",
     "number changed", lambda v: v["meaning"] <= 3),
    ("de", "Die Digitalisierung stellt kleine Unternehmen vor gro\u00dfe Herausforderungen.",
     "Die Digitalisierung stellt kleine Unternehmen gro\u00dfe Herausforderung.",
     "German grammar errors", lambda v: v["grammar"] <= 3),
    ("en", "Moreover, it is important to note that sales rose by 23 % in 2021.",
     "Sales rose by 23 % in 2021.",
     "stock phrase dropped (fine)", lambda v: v["meaning"] >= 4 and v["grammar"] >= 4),
    ("de", "Dar\u00fcber hinaus ist es wichtig zu beachten, dass 38 Prozent der Betriebe keine Strategie haben.",
     "Au\u00dferdem haben 38 Prozent der Betriebe keine Strategie.",
     "German stock phrase dropped (fine)", lambda v: v["meaning"] >= 4 and v["grammar"] >= 4),
]


def judge_one(api, model, lang, original, rewrite, reasoning):
    body = {
        "model": model,
        "messages": [{"role": "system", "content": JUDGE_SYSTEM.format(lang=LANG_NAMES.get(lang, lang))},
                     {"role": "user", "content": f"ORIGINAL:\n{original}\n\nREWRITE:\n{rewrite}"}],
        "temperature": 0,
        "max_tokens": 3000,
        "response_format": {"type": "json_schema", "json_schema": {"name": "verdict", "schema": JUDGE_SCHEMA}},
        "chat_template_kwargs": {"reasoning_effort": "low"} if reasoning else {"enable_thinking": False},
    }
    req = urllib.request.Request(api.rstrip("/") + "/chat/completions", json.dumps(body).encode(),
                                 {"Content-Type": "application/json"})
    err = "no verdict"
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=600) as r:
                content = json.loads(r.read())["choices"][0]["message"].get("content") or ""
            m = re.search(r"\{.*\}", content, re.S)
            v = json.loads(m.group(0))
            if all(isinstance(v.get(k), int) for k in ("meaning", "grammar", "natural")):
                return v
            err = f"incomplete verdict: {content[:200]}"
        except Exception as e:
            err = str(e)
    return {"error": err}


def run_judge(api, model, items, threads, reasoning):
    """Score each unique (lang, original, rewrite); returns {key: verdict}."""
    verdicts = {}
    with concurrent.futures.ThreadPoolExecutor(threads) as pool:
        futs = {pool.submit(judge_one, api, model, *k, reasoning): k for k in items}
        for n, f in enumerate(concurrent.futures.as_completed(futs), 1):
            verdicts[futs[f]] = f.result()
            if n % 50 == 0 or n == len(futs):
                log(f"  judged {n}/{len(futs)}")
    return verdicts


# ----- report -----

def mean(xs):
    return sum(xs) / len(xs) if xs else float("nan")


def fmt(x, pct=False):
    if x != x:   # NaN
        return "-"
    return f"{x:.0%}" if pct else f"{x:.2f}"


def summarize(rows):
    pairs = [p for r in rows for p in r["pairs"]]
    req_units = sum(r["eligible"] for r in rows) or 1
    v = [p["verdict"] for p in pairs if "verdict" in p and "error" not in p["verdict"]]
    # Stock phrases in sentences the app removed outright count as removed.
    stock_b = sum(p["stock_before"] for p in pairs) + sum(r.get("removed_stock", 0) for r in rows)
    return {
        "accepted": sum(r["done"] for r in rows) / req_units,
        "unchanged": sum(r["unchanged"] for r in rows) / req_units,
        "refused": sum(len(r["refused"]) for r in rows),
        "retried": sum(r.get("retried", 0) for r in rows), "rescued": sum(r.get("rescued", 0) for r in rows),
        "change": statistics.median([p["change"] for p in pairs]) if pairs else float("nan"),
        "stock_removed": 1 - sum(p["stock_after"] for p in pairs) / stock_b if stock_b else float("nan"),
        "stock_added": sum(p.get("stock_added", 0) for p in pairs),
        "numbers": mean([p["numbers"] for p in pairs]),
        "names": mean([p["names"] for p in pairs]),
        "meaning": mean([x["meaning"] for x in v]), "grammar": mean([x["grammar"] for x in v]),
        "natural": mean([x["natural"] for x in v]),
        "bad": sum(1 for x in v if x["meaning"] <= 3 or x["grammar"] <= 3),
        "judged": len(v), "pairs": len(pairs),
        "secs": sum(r["secs"] for r in rows) / max(1, len(rows)),
    }


def write_reports(out_dir, args, meta, results):
    models = [m for m in args.models if m in results]
    lines = [f"# Cleaner reword benchmark{(' - ' + args.label) if args.label else ''}", "",
             f"{meta['date']} \u00b7 backend **{meta['backend']}** \u00b7 {meta.get('gpu', '')} \u00b7 "
             f"VRAM in use before: {meta.get('vram_before', '?')} MB \u00b7 judge: **{meta['judge'] or 'none'}**", "",
             f"{len(meta['texts'])} texts ({', '.join(meta['texts'])}) \u00d7 levels {', '.join(args.levels)} \u00d7 {args.runs} runs, "
             f"by sentence, all of them; app {meta['app']}.", "",
             *([f"Judge calibration: {sum(c['pass'] for c in meta['calibration'])}/{len(meta['calibration'])} known cases as expected"
                + "".join(f"; **missed: {c['case']}**" for c in meta["calibration"] if not c["pass"]) + ".", ""]
               if meta.get("calibration") else []),
             "Accepted = sentences reworded and kept; Unchanged = sentences the model returned as they were. "
             "Words changed is the median per request. Stock phrases are corpus.json's list: the share of them removed, and how "
             "many the model brought in itself. Meaning/Grammar/Natural are the judge's 1-5 averages; "
             "Bad counts rewrites it scored 3 or lower on meaning or grammar. s/run is one text through the app.", "",
             "| Model | Level | Accepted | Unchanged | Refused | 2nd try (reworded) | Words changed | Stock phrases removed | Stock added | Numbers kept "
             "| Names kept | Meaning | Grammar | Natural | Bad | s/run | decode tok/s |",
             "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    summary = {}
    for m in models:
        for lv in args.levels:
            rows = [r for r in results[m]["rows"] if r["level"] == lv]
            s = summarize(rows)
            summary[(m, lv)] = s
            lines.append(f"| {m.replace('.gguf', '')} | {lv} | {fmt(s['accepted'], 1)} | {fmt(s['unchanged'], 1)} | {s['refused']} | {s['retried']} ({s['rescued']}) | "
                         f"{fmt(s['change'], 1)} | {fmt(s['stock_removed'], 1)} | {s['stock_added']} | {fmt(s['numbers'], 1)} | {fmt(s['names'], 1)} | "
                         f"{fmt(s['meaning'])} | {fmt(s['grammar'])} | {fmt(s['natural'])} | {s['bad']}/{s['judged']} | "
                         f"{s['secs']:.1f} | {results[m].get('decode_tps', '-')} |")
    for m in args.models:
        if m not in results:
            lines.append(f"| {m.replace('.gguf', '')} | failed: {meta['failed'].get(m, '?')} |||||||||||||||")

    if meta["judge"]:
        lines += ["", "## Grammar by language (judge, all levels)", "",
                  "| Model | " + " | ".join(LANG_NAMES.get(l, l) for l in meta["langs"]) + " |",
                  "|---|" + "---|" * len(meta["langs"])]
        for m in models:
            cells = []
            for lang in meta["langs"]:
                v = [p["verdict"] for r in results[m]["rows"] if r["lang"] == lang for p in r["pairs"]
                     if "verdict" in p and "error" not in p["verdict"]]
                cells.append(f"{fmt(mean([x['grammar'] for x in v]))} / meaning {fmt(mean([x['meaning'] for x in v]))}")
            lines.append(f"| {m.replace('.gguf', '')} | " + " | ".join(cells) + " |")

        lines += ["", "## Recommendation", "",
                  "Per level: the best model (highest mean of meaning, grammar and natural, with at least 70 % of the "
                  "sentences accepted), and the smallest model whose meaning and grammar both average 4.5 or more.", ""]
        sizes = {m: (pathlib.Path(args.models_dir) / m).stat().st_size for m in models}
        for lv in args.levels:
            ok = [(m, summary[(m, lv)]) for m in models if summary[(m, lv)]["accepted"] >= 0.7 and summary[(m, lv)]["judged"]]
            if not ok:
                lines.append(f"- **{lv}**: no model reached 70 % accepted.")
                continue
            best = max(ok, key=lambda x: (x[1]["meaning"] + x[1]["grammar"] + x[1]["natural"]) / 3)
            good = sorted([x for x in ok if x[1]["meaning"] >= 4.5 and x[1]["grammar"] >= 4.5], key=lambda x: sizes[x[0]])
            q = lambda s: (s["meaning"] + s["grammar"] + s["natural"]) / 3
            lines.append(f"- **{lv}**: best {best[0].replace('.gguf', '')} ({q(best[1]):.2f}); smallest good enough: "
                         + (f"{good[0][0].replace('.gguf', '')} ({sizes[good[0][0]] / 1e9:.1f} GB, {q(good[0][1]):.2f})" if good else "none"))

        lines += ["", "## Problems the judge found (meaning or grammar 3 or lower)", ""]
        probs = [(m, r, p) for m in models for r in results[m]["rows"] for p in r["pairs"]
                 if "verdict" in p and "error" not in p["verdict"] and (p["verdict"]["meaning"] <= 3 or p["verdict"]["grammar"] <= 3)]
        for m, r, p in sorted(probs, key=lambda x: (x[0], x[1]["level"], x[2]["verdict"]["meaning"])):
            v = p["verdict"]
            lines += [f"- **{m.replace('.gguf', '')} \u00b7 {r['level']} \u00b7 {r['text']}**: meaning {v['meaning']}, grammar {v['grammar']}"
                      f" ({p['change']:.0%} changed) - {v['issues']}", f"  - was: {p['original']}", f"  - now: {p['rewrite']}"]
        if not probs:
            lines.append("- none")
        errs = sum(1 for m in models for r in results[m]["rows"] for p in r["pairs"] if "error" in p.get("verdict", {}))
        if errs:
            lines += ["", f"The judge gave no verdict for {errs} rewrites."]

    lines += ["", "## Refusals", ""]
    reasons = {}
    for m in models:
        for r in results[m]["rows"]:
            for why in r["refused"]:
                key = (m.replace(".gguf", ""), r["level"], re.sub(r"\d+ %", "N %", why))
                reasons[key] = reasons.get(key, 0) + 1
    lines += [f"- {m} \u00b7 {lv}: {why} \u00d7 {n}" for (m, lv, why), n in sorted(reasons.items())] or ["- none"]
    if meta["errors"]:
        lines += ["", "## Errors", ""] + [f"- {m}: {e}" for m, errs in meta["errors"].items() for e in errs[:10]]
    lines += ["", "Every pair: [samples.md](samples.md)."]
    (out_dir / "review.md").write_text("\n".join(lines) + "\n", encoding="utf-8")

    s = [f"# Samples{(' - ' + args.label) if args.label else ''}", ""]
    for m in models:
        for r in sorted(results[m]["rows"], key=lambda r: (r["level"], r["text"], r["run"])):
            s.append(f"## {m.replace('.gguf', '')} \u00b7 {r['level']} \u00b7 {r['text']} \u00b7 run {r['run'] + 1}")
            for p in r["pairs"]:
                v = p.get("verdict", {})
                score = f" \u00b7 meaning {v['meaning']} grammar {v['grammar']} natural {v['natural']}" if "meaning" in v else ""
                flags = ("" if p["numbers"] else " \u00b7 **numbers changed**") + ("" if p["names"] else " \u00b7 **name lost**")
                s += ["", f"- {p['change']:.0%} changed{score}{flags}" + (f" - {v['issues']}" if v.get("issues") else ""),
                      f"  - was: {p['original']}", f"  - now: {p['rewrite']}"]
            for why in r["refused"]:
                s.append(f"- refused: {why}")
            s.append("")
    (out_dir / "samples.md").write_text("\n".join(s), encoding="utf-8")


# ----- main -----

async def main_async(args):
    corpus = json.loads((HERE / "corpus.json").read_text())
    if args.texts:
        corpus["texts"] = [t for t in corpus["texts"] if t["id"] in args.texts or t["lang"] in args.texts]
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    out_dir = pathlib.Path(args.out) / (stamp + (f"-{args.label}" if args.label else ""))
    www = out_dir / "www"
    www.mkdir(parents=True)
    app_name = "hermit-cleaner-wllama.html" if args.backend == "wllama" else "hermit-cleaner-standalone.html"
    app = pathlib.Path(args.app) if args.app else ROOT / "dist" / app_name
    (www / "app.html").write_bytes(app.read_bytes())
    app_version = (re.search(rb'APP_VERSION = "([^"]+)"', app.read_bytes()) or [None, b"?"])[1].decode()
    models_dir = pathlib.Path(args.models_dir)
    gpu = gpu_memory_mb()
    meta = {"date": datetime.datetime.now().isoformat(timespec="minutes"), "backend": args.backend if not args.api else f"api {args.api}",
            "app": f"{app.name} v{app_version}", "texts": [t["id"] for t in corpus["texts"]],
            "langs": sorted({t["lang"] for t in corpus["texts"]}, key=["en", "de", "fr"].index), "judge": None,
            "failed": {}, "errors": {}, "args": vars(args)}
    if gpu:
        meta["vram_before"], meta["gpu"] = gpu[0], f"{gpu[2]} ({gpu[1]} MB)"
        if args.backend == "server" and not args.api and gpu[0] > VRAM_BUSY_MB and not args.allow_busy_gpu:
            sys.exit(f"{gpu[0]} MB of VRAM is already in use (limit {VRAM_BUSY_MB}): something else holds the GPU, "
                     "so timings would be wrong. Free it, or pass --allow-busy-gpu.")
    for name in args.models:
        if not args.api and not (models_dir / name).exists():
            sys.exit(f"missing model: {models_dir / name}")
    needs_server = (args.backend == "server" and not args.api) or (args.judge != "none" and not args.judge_api)
    binary = ensure_llama_server() if needs_server else None
    if binary:
        meta["server"] = f"llama.cpp {LLAMA_TAG} (CUDA 12.8)"
    web, web_port = serve_dir(www)
    app_url = f"http://127.0.0.1:{web_port}/app.html"
    log(f"results in {out_dir}")

    jobs = [(t["id"], lv, run) for run in range(args.runs) for lv in args.levels for t in corpus["texts"]]
    results = {}
    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        for name in args.models:
            started = time.time()
            server = None
            if args.backend == "wllama":
                (www / name).unlink(missing_ok=True)
                (www / name).symlink_to(models_dir / name)
                url = f"http://127.0.0.1:{web_port}/{name}"
                setup = lambda page, url=url: load_wllama(page, url, args.webgpu)
                pages = 1
            else:
                if args.api:
                    api = args.api
                else:
                    log(f"{name}: starting llama-server \u2026")
                    server = LlamaServer(binary, models_dir / name, args.port, args.parallel, args.ctx,
                                         out_dir / f"server-{pathlib.Path(name).stem}.log", args.gpu_layers)
                    if not server.wait_ready():
                        server.stop()
                        meta["failed"][name] = "llama-server didn't start (see its log)"
                        log(f"{name}: llama-server failed")
                        continue
                    api = server.url + "/v1"
                setup = lambda page, api=api, name=name: _ok(configure_api(page, api, pathlib.Path(name).stem))
                pages = args.parallel
            before = server.metrics() if server else {}
            log(f"{name}: {len(jobs)} runs on {pages} page(s) \u2026")
            rows, errors = await bench_model(browser, app_url, setup, jobs, pages, corpus)
            if not rows:
                meta["failed"][name] = "; ".join(errors[:2]) or "no results"
                log(f"{name}: FAILED, nothing measured: {meta['failed'][name]}")
                if server:
                    server.stop()
                continue
            results[name] = {"rows": rows, "secs": time.time() - started}
            if server:
                after = server.metrics()
                d = lambda k: after.get(k, 0) - before.get(k, 0)
                if d("tokens_predicted_seconds_total") > 0:
                    results[name]["decode_tps"] = f"{d('tokens_predicted_total') / d('tokens_predicted_seconds_total'):.0f}"
                    results[name]["prompt_tps"] = f"{d('prompt_tokens_total') / max(d('prompt_seconds_total'), 1e-9):.0f}"
                server.stop()
            if errors:
                meta["errors"][name] = errors
            s = summarize(rows)
            log(f"{name}: done in {time.time() - started:.0f} s; accepted {s['accepted']:.0%}, unchanged {s['unchanged']:.0%}, "
                f"median change {s['change']:.0%}" + (f"; {len(errors)} errors" if errors else ""))
        await browser.close()
    web.shutdown()

    # The judge, on the same llama-server (or a running API with --judge-api).
    judge = None if args.judge == "none" else args.judge
    if judge == "auto":
        judge = next((j for j in JUDGES if (models_dir / j).exists()), None)
    if judge and results:
        items = {(r["lang"], p["original"], p["rewrite"]) for m in results for r in results[m]["rows"] for p in r["pairs"]}
        server = None
        if args.judge_api:
            api, jname = args.judge_api, judge
        else:
            log(f"judge {judge}: starting llama-server \u2026")
            server = LlamaServer(binary, models_dir / judge, args.port, 4, 8192, out_dir / "server-judge.log", args.gpu_layers)
            if not server.wait_ready():
                server.stop()
                sys.exit("the judge's llama-server didn't start (see server-judge.log)")
            api, jname = server.url + "/v1", pathlib.Path(judge).stem
        reasoning = "gpt-oss" in judge
        cal = run_judge(api, jname, [c[:3] for c in JUDGE_CALIBRATION], 4, reasoning)
        meta["calibration"] = []
        for lang, a, b, what, test in JUDGE_CALIBRATION:
            v = cal[(lang, a, b)]
            meta["calibration"].append({"case": what, "verdict": v, "pass": "error" not in v and test(v)})
        passed = sum(c["pass"] for c in meta["calibration"])
        log(f"judge calibration: {passed}/{len(JUDGE_CALIBRATION)} known cases scored as expected")
        log(f"judging {len(items)} rewrites with {judge} \u2026")
        verdicts = run_judge(api, jname, sorted(items), 4, reasoning)
        if server:
            server.stop()
        for m in results:
            for r in results[m]["rows"]:
                for p in r["pairs"]:
                    p["verdict"] = verdicts[(r["lang"], p["original"], p["rewrite"])]
        meta["judge"] = judge.replace(".gguf", "")

    (out_dir / "run.json").write_text(json.dumps({"meta": meta, "results": results}, indent=1, ensure_ascii=False))
    write_reports(out_dir, args, meta, results)
    shutil.rmtree(www)
    log(f"wrote {out_dir / 'review.md'}" + (f" ({len(meta['failed'])} model(s) FAILED: {', '.join(meta['failed'])})" if meta["failed"] else ""))


async def _ok(coro):
    await coro
    return True, ""


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--models", nargs="+", default=DEFAULT_MODELS)
    ap.add_argument("--models-dir", default=str(REPO / "benchmark" / "models"))
    ap.add_argument("--levels", nargs="+", default=["light", "medium", "strong"])
    ap.add_argument("--texts", nargs="+", help="text ids or languages from corpus.json (default: all)")
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--backend", choices=["server", "wllama"], default="server")
    ap.add_argument("--api", help="an OpenAI-compatible server that is already running (use with one model)")
    ap.add_argument("--parallel", type=int, default=4, help="server slots and browser pages (server backend)")
    ap.add_argument("--ctx", type=int, default=4096, help="context per server slot")
    ap.add_argument("--gpu-layers", default="999", help="layers on the GPU: a number, or 'auto' to fit around whatever else uses it")
    ap.add_argument("--port", type=int, default=8691)
    ap.add_argument("--webgpu", action="store_true", help="wllama backend: load with WebGPU")
    ap.add_argument("--judge", default="auto", help="a GGUF in --models-dir, 'auto' (gpt-oss-20b, else Qwen3-8B) or 'none'")
    ap.add_argument("--judge-api", help="judge through a running OpenAI-compatible server instead (--judge names its model)")
    ap.add_argument("--allow-busy-gpu", action="store_true")
    ap.add_argument("--app", help="a copy of the built app to test (default: the dist file for the backend)")
    ap.add_argument("--label", default="")
    ap.add_argument("--out", default=str(HERE / "results"))
    args = ap.parse_args()
    if args.api and len(args.models) != 1:
        ap.error("--api serves one model: pass exactly one --models name")
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
