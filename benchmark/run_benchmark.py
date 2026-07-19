#!/usr/bin/env python3
"""Model-speed + quality benchmark for the unmodified dist/hermit-ui-wllama.html.

Drives the real app with Playwright exactly like a user would: opens it with
`#gguf=<local url>`, clicks the app's own load banner, asks the 10 demo
questions from questions.json (fresh chat each), and records TTFT, tok/s and
every answer for human review.

Backends:
  (default) CPU — headless Chromium inside WSL (WebGPU there is SwiftShader
            only, so the toggle is forced off).
  --gpu     real WebGPU — launches Windows Edge headless via WSL interop and
            connects over CDP (mirrored networking, localhost works both ways).
  --both    CPU run, then GPU run.

Results land in benchmark/results/<timestamp>-<backend>/ as run.json + review.md.
"""
import argparse
import json
import re
import socket
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

from download_models import LADDER, MODELS_DIR

# Progress must reach the log/monitor live, also when stdout is a file.
sys.stdout.reconfigure(line_buffering=True)

BENCH_DIR = Path(__file__).parent
APP_PATH = "dist/hermit-ui-wllama.html"
EDGE_EXE = "/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
EDGE_CDP_PORT = 9223

LOAD_TIMEOUT_S = 900          # engine init + copy model into memory + load
DEFAULT_QUESTION_TIMEOUT_S = 300
DEFAULT_THRESHOLD_TPS = 5.0
DEFAULT_CTX = 8192            # conservative KV size so the 4B rung fits wasm32


# ---------------------------------------------------------------- utilities

def port_open(port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0


def ensure_server(port: int):
    """Start serve.py unless something already listens on the port."""
    if port_open(port):
        return None
    proc = subprocess.Popen(
        [sys.executable, str(BENCH_DIR / "serve.py"), "--port", str(port)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    for _ in range(50):
        if port_open(port):
            return proc
        time.sleep(0.2)
    proc.terminate()
    sys.exit("❌ could not start local server")


def ensure_models(selected):
    missing = [m["file"] for m in selected if not (MODELS_DIR / m["file"]).exists()]
    if missing:
        sys.exit(
            "❌ missing model file(s): " + ", ".join(missing)
            + "\n   run: python3 benchmark/download_models.py"
        )


def parse_num(text: str) -> float:
    m = re.search(r"[\d.]+", text or "")
    return float(m.group()) if m else 0.0


def launch_edge():
    """Launch Windows Edge headless with WebGPU + CDP from WSL interop."""
    win_temp = subprocess.run(
        ["cmd.exe", "/c", "echo %TEMP%"], capture_output=True, text=True,
        cwd="/mnt/c",
    ).stdout.strip()
    profile = f"{win_temp}\\hermit-bench-edge"
    proc = subprocess.Popen(
        [
            EDGE_EXE, "--headless=new",
            f"--remote-debugging-port={EDGE_CDP_PORT}",
            "--enable-unsafe-webgpu", "--enable-features=WebGPU",
            f"--user-data-dir={profile}", "--no-first-run",
        ],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    for _ in range(100):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{EDGE_CDP_PORT}/json/version", timeout=1)
            return proc
        except OSError:
            time.sleep(0.3)
    proc.terminate()
    sys.exit("❌ Edge CDP endpoint never came up — is Edge installed on Windows?")


# ---------------------------------------------------------------- benchmark

def benchmark_model(page, base: str, model: dict, questions, cfg) -> dict:
    """Load one model in a fresh page and run all questions. Returns rung record."""
    model_url = f"{base}/benchmark/models/{model['file']}"
    page_url = (f"{base}/{APP_PATH}#gguf=" + urllib.parse.quote(model_url, safe="")
                + "&persona=" + urllib.parse.quote(cfg["persona"], safe=""))
    rec = {
        "model": model["name"], "file": model["file"],
        "size_bytes": (MODELS_DIR / model["file"]).stat().st_size,
        "status": "ok", "load_seconds": None, "questions": [],
    }

    page.goto(page_url)
    page.wait_for_selector("#wllamaHashBanner", state="visible", timeout=60_000)
    page.evaluate(
        """cfg => {
            document.getElementById("wllamaWebGpuToggle").checked = cfg.gpu;
            document.getElementById("settingWllamaCtx").value = cfg.ctx;
        }""",
        {"gpu": cfg["gpu"], "ctx": cfg["ctx"]},
    )

    t0 = time.monotonic()
    page.click("#wllamaHashLoadBtn")
    try:
        page.wait_for_function(
            """() => {
                const s = document.getElementById("wllamaStatus").textContent;
                return s.includes("Ready 🟢") || s.includes("Error");
            }""",
            timeout=LOAD_TIMEOUT_S * 1000,
        )
    except PWTimeout:
        rec["status"] = "load_timeout"
        return rec
    status_text = page.text_content("#wllamaStatus")
    if "Error" in status_text:
        rec["status"] = "load_failed"
        rec["error"] = status_text
        print(f"   💥 load failed: {status_text}")
        return rec
    rec["load_seconds"] = round(time.monotonic() - t0, 1)
    print(f"   🟢 loaded in {rec['load_seconds']}s")

    for i, q in enumerate(questions):
        print(f"   ▷ {q['id']} ({i + 1}/{len(questions)})…")
        page.click("#clearBtn")
        prompt = q["text"] + (" /no_think" if not q["thinking"] and model.get("nothink") else "")
        prev = page.evaluate("document.querySelectorAll('.msg-wrapper.ai .msg-content').length")
        page.fill("#userInput", prompt)
        t_send = time.monotonic()
        page.click("#sendBtn")

        qrec = {"id": q["id"], "category": q["category"], "question": q["text"],
                "thinking": q["thinking"], "truncated": False}
        try:
            page.wait_for_function(
                """prev => {
                    const els = document.querySelectorAll('.msg-wrapper.ai .msg-content');
                    return els.length > prev && els[els.length - 1].textContent.trim().length > 0;
                }""",
                arg=prev, timeout=120_000,
            )
            qrec["ttft_s"] = round(time.monotonic() - t_send, 2)
        except PWTimeout:
            qrec.update(status="no_response", ttft_s=None)
            rec["questions"].append(qrec)
            print(f"   ❓ {q['id']}: no response within 120s — skipping model")
            rec["status"] = "too_slow"
            break

        try:
            page.wait_for_function(
                """() => document.getElementById("chatbox").getAttribute("aria-busy") !== "true" """,
                timeout=cfg["question_timeout"] * 1000,
            )
        except PWTimeout:
            qrec["truncated"] = True
            page.click("#stopBtn")
            page.wait_for_function(
                """() => document.getElementById("chatbox").getAttribute("aria-busy") !== "true" """,
                timeout=30_000,
            )
        # aria-busy clears before the app's throttled final flush — reading now
        # loses the answer's tail. Wait for the app's own isWaiting flag, then
        # for the message content to stop growing.
        page.wait_for_function("() => !isWaiting", timeout=30_000)
        gen_s = time.monotonic() - t_send
        prev_len, stable, deadline = -1, 0, time.monotonic() + 10
        while stable < 2 and time.monotonic() < deadline:
            cur = page.evaluate(
                """() => { const m = messages[messages.length - 1];
                           return m && m.role === "assistant" ? m.content.length : -1; }"""
            )
            if cur == prev_len and cur >= 0:
                stable += 1
            else:
                prev_len, stable = cur, 0
            time.sleep(0.25)

        stats = page.evaluate(
            """() => ({
                prompt: document.getElementById("stat-prompt").textContent,
                completion: document.getElementById("stat-completion").textContent,
                tps: document.getElementById("stat-tps").textContent,
                time: document.getElementById("stat-time").textContent,
            })"""
        )
        answer = page.evaluate(
            """() => {
                const last = messages[messages.length - 1];
                return last && last.role === "assistant" ? last.content : null;
            }"""
        )
        if answer is None:  # fallback: rendered text
            answer = page.evaluate(
                """() => {
                    const els = document.querySelectorAll('.msg-wrapper.ai .msg-content');
                    return els.length ? els[els.length - 1].innerText : "";
                }"""
            )

        completion_tokens = parse_num(stats["completion"])
        gen_after_ttft = max(gen_s - (qrec["ttft_s"] or 0), 0.001)
        qrec.update(
            status="ok",
            answer=answer,
            prompt_tokens=int(parse_num(stats["prompt"])),
            completion_tokens=int(completion_tokens),
            app_tps=parse_num(stats["tps"]),
            measured_tps=round(completion_tokens / gen_after_ttft, 1),
            total_s=round(gen_s, 1),
        )
        rec["questions"].append(qrec)
        trunc = " (truncated)" if qrec["truncated"] else ""
        print(f"   💬 {q['id']}: TTFT {qrec['ttft_s']}s, {qrec['app_tps']} t/s app / {qrec['measured_tps']} t/s measured{trunc}")

        # Early stop: two questions are enough to know it's unusably slow.
        if i >= 1:
            speeds = [x["app_tps"] or x["measured_tps"] for x in rec["questions"] if x.get("status") == "ok"]
            if speeds and sum(speeds) / len(speeds) < cfg["threshold"]:
                rec["status"] = "too_slow"
                print(f"   🛑 below {cfg['threshold']} t/s — stopping this model")
                break

    ok = [x for x in rec["questions"] if x.get("status") == "ok"]
    if ok:
        rec["avg_ttft_s"] = round(sum(x["ttft_s"] for x in ok) / len(ok), 2)
        rec["avg_tps"] = round(sum((x["app_tps"] or x["measured_tps"]) for x in ok) / len(ok), 1)
    return rec


def run_backend(pw, backend: str, base: str, questions, cfg) -> dict:
    print(f"\n===== backend: {backend.upper()} =====")
    edge_proc = None
    if backend == "gpu":
        edge_proc = launch_edge()
        browser = pw.chromium.connect_over_cdp(f"http://127.0.0.1:{EDGE_CDP_PORT}")
    else:
        browser = pw.chromium.launch(headless=True)

    run = {"backend": backend, "started": datetime.now().isoformat(timespec="seconds"),
           "threshold_tps": cfg["threshold"], "ctx": cfg["ctx"], "models": []}
    try:
        probe_ctx = browser.new_context()
        probe = probe_ctx.new_page()
        probe.goto(f"{base}/{APP_PATH}")
        run["device"] = probe.evaluate(
            """async () => {
                const a = navigator.gpu ? await navigator.gpu.requestAdapter().catch(() => null) : null;
                return {
                    userAgent: navigator.userAgent,
                    threads: navigator.hardwareConcurrency,
                    deviceMemory: navigator.deviceMemory ?? null,
                    crossOriginIsolated: crossOriginIsolated,
                    gpuAdapter: a && a.info ? {
                        vendor: a.info.vendor, architecture: a.info.architecture,
                        device: a.info.device, description: a.info.description,
                    } : null,
                };
            }"""
        )
        probe_ctx.close()
        print(f"   device: {run['device']['threads']} threads, "
              f"crossOriginIsolated={run['device']['crossOriginIsolated']}, "
              f"gpu={run['device']['gpuAdapter']}")

        stopped = {}  # family -> reason; a bad rung only skips the rest of its own family
        for model in cfg["ladder"]:
            print(f"\n▶ {model['name']} ({model['file']})")
            family = model.get("family", model["name"])
            if family in stopped:
                run["models"].append({"model": model["name"], "file": model["file"],
                                      "status": f"skipped ({stopped[family]})", "questions": []})
                print(f"   ⏭️ skipped ({stopped[family]})")
                continue
            context = browser.new_context()
            page = context.new_page()
            cfg_b = dict(cfg, gpu=(backend == "gpu"))
            rec = benchmark_model(page, base, model, questions, cfg_b)
            context.close()  # unload model, free memory before next rung
            run["models"].append(rec)
            if rec["status"] in ("too_slow", "load_failed", "load_timeout"):
                stopped[family] = "previous rung " + ("too slow" if rec["status"] == "too_slow" else "failed to load")
    finally:
        if backend == "gpu":
            # plain close() only disconnects CDP; actually terminate Edge
            try:
                browser.new_browser_cdp_session().send("Browser.close")
            except Exception:
                pass
            if edge_proc:
                edge_proc.wait(timeout=15)
        else:
            browser.close()

    usable = [m for m in run["models"] if m.get("avg_tps") and m["avg_tps"] >= cfg["threshold"]
              and m["status"] == "ok"]
    run["recommendation"] = usable[-1]["model"] if usable else None
    return run


# ---------------------------------------------------------------- reporting

THINK_RE = re.compile(r"<(think|thought|reasoning)>(.*?)</\1>", re.DOTALL)


def split_think(answer: str):
    thinks = [m.group(2).strip() for m in THINK_RE.finditer(answer or "")]
    visible = THINK_RE.sub("", answer or "").strip()
    # An unmatched tag (e.g. truncated thinking) would make markdown renderers
    # swallow everything after it — escape whatever survived.
    visible = re.sub(r"</?(think|thought|reasoning)>", lambda m: m.group().replace("<", "&lt;"), visible)
    return visible, "\n\n".join(thinks).strip()


def hf_share_link(model: dict) -> str:
    return f"https://moooff.github.io/HermitUI/dist/hermit-ui-wllama.html#gguf=hf:{model['repo']}/{model['file']}"


def write_review(run: dict, questions, out_dir: Path, cfg):
    by_file = {m["file"]: m for m in cfg["ladder"]}
    lines = [f"# HermitUI model benchmark — {run['started']} ({run['backend'].upper()})", ""]
    dev = run["device"]
    gpu = dev["gpuAdapter"]
    lines += [
        f"Device: {dev['threads']} threads, crossOriginIsolated={dev['crossOriginIsolated']}, "
        + (f"GPU: {gpu['vendor']} {gpu['architecture']}" if gpu else "no WebGPU adapter"),
        "", "## Speed summary", "",
        "| Model | Size | Load | avg TTFT | avg gen speed | Status |",
        "|---|---|---|---|---|---|",
    ]
    for m in run["models"]:
        size = f"{m['size_bytes'] / 1e9:.1f} GB" if m.get("size_bytes") else "—"
        lines.append(
            f"| {m['model']} | {size} | "
            f"{str(m.get('load_seconds', '—')) + 's' if m.get('load_seconds') else '—'} | "
            f"{str(m.get('avg_ttft_s', '—')) + 's' if m.get('avg_ttft_s') else '—'} | "
            f"{str(m.get('avg_tps', '—')) + ' t/s' if m.get('avg_tps') else '—'} | {m['status']} |"
        )
    lines.append("")
    if run["recommendation"]:
        rec_model = next(m for m in cfg["ladder"] if m["name"] == run["recommendation"])
        lines += [
            f"## 🏆 Recommendation: **{run['recommendation']}**", "",
            f"Largest model above {run['threshold_tps']} t/s on this device ({run['backend'].upper()}).",
            f"Load it in HermitUI: `hf:{rec_model['repo']}/{rec_model['file']}`",
            f"or via link: <{hf_share_link(rec_model)}>", "",
        ]
    else:
        lines += ["## Recommendation: none — no model reached the usable-speed threshold.", ""]

    lines += ["## Answers for review", ""]
    for q in questions:
        lines += [f"### {q['id']} · {q['category']}", "", f"> {q['text']}", ""]
        for m in run["models"]:
            qrec = next((x for x in m["questions"] if x["id"] == q["id"]), None)
            if not qrec or qrec.get("status") != "ok":
                lines += [f"**{m['model']}**: _not answered ({(qrec or m)['status']})_", ""]
                continue
            visible, think = split_think(qrec["answer"])
            trunc = " · ⚠️ truncated" if qrec["truncated"] else ""
            lines.append(f"**{m['model']}** — TTFT {qrec['ttft_s']}s · {qrec['app_tps'] or qrec['measured_tps']} t/s{trunc}")
            lines.append("")
            if think:
                lines += ["<details><summary>🧠 thinking</summary>", "", think, "", "</details>", ""]
            lines += [visible or "_(empty answer)_", "", "---", ""]
    (out_dir / "review.md").write_text("\n".join(lines), encoding="utf-8")


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--gpu", action="store_true", help="WebGPU via Windows Edge over CDP")
    ap.add_argument("--both", action="store_true", help="CPU run, then GPU run")
    ap.add_argument("--port", type=int, default=8471)
    ap.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD_TPS,
                    help="usable-speed cutoff in tok/s (default 5)")
    ap.add_argument("--ctx", type=int, default=DEFAULT_CTX)
    ap.add_argument("--question-timeout", type=int, default=DEFAULT_QUESTION_TIMEOUT_S,
                    help="seconds per question before Stop is clicked (default 300)")
    ap.add_argument("--models", help="comma-separated subset, e.g. 0.6B,1.7B")
    ap.add_argument("--persona", default="general",
                    help="app persona for the answers (default: general)")
    args = ap.parse_args()

    ladder = LADDER
    if args.models:
        wanted = {w.strip().lower() for w in args.models.split(",")}
        ladder = [m for m in LADDER if any(w in m["name"].lower() for w in wanted)]
        if not ladder:
            sys.exit(f"❌ no ladder model matches {args.models}")
    ensure_models(ladder)

    if not (BENCH_DIR.parent / APP_PATH).exists():
        sys.exit(f"❌ {APP_PATH} missing — run: python3 build.py")

    questions = json.loads((BENCH_DIR / "questions.json").read_text(encoding="utf-8"))["questions"]
    cfg = {"ladder": ladder, "threshold": args.threshold, "ctx": args.ctx,
           "question_timeout": args.question_timeout, "persona": args.persona}

    backends = ["cpu", "gpu"] if args.both else (["gpu"] if args.gpu else ["cpu"])
    server = ensure_server(args.port)
    base = f"http://127.0.0.1:{args.port}"
    try:
        with sync_playwright() as pw:
            for backend in backends:
                run = run_backend(pw, backend, base, questions, cfg)
                out_dir = BENCH_DIR / "results" / f"{datetime.now():%Y%m%d-%H%M%S}-{backend}"
                out_dir.mkdir(parents=True)
                (out_dir / "run.json").write_text(json.dumps(run, indent=2, ensure_ascii=False), encoding="utf-8")
                write_review(run, questions, out_dir, cfg)
                print(f"\n📄 results: {out_dir}/review.md")
                if run["recommendation"]:
                    print(f"🏆 recommendation ({backend}): {run['recommendation']}")
                else:
                    print(f"🏆 recommendation ({backend}): none above {args.threshold} t/s")
    finally:
        if server:
            server.terminate()


if __name__ == "__main__":
    main()
