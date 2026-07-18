# HermitUI Model Benchmark

Races progressively larger Qwen3 GGUFs through the **unmodified**
`dist/hermit-ui-wllama.html` and recommends the largest model your machine
runs at a usable speed. The harness drives the real app with Playwright
exactly like a user would — via the `#gguf=` link parameter and the app's own
buttons — so the numbers are what a real user gets. On top of raw speed, every
model answers the same 10 demo questions (`questions.json`) and all answers
are saved for you to judge quality yourself.

The app itself stays fully ephemeral: models are cached on *disk* by the
harness (in `models/`, gitignored) and served from localhost; the browser
never stores anything.

## The ladder

| Model | File | ~Size |
|---|---|---|
| Qwen3-0.6B | `Qwen3-0.6B-Q4_K_M.gguf` | 0.4 GB |
| Qwen3-1.7B | `Qwen3-1.7B-Q4_K_M.gguf` | 1.1 GB |
| Qwen3-4B | `Qwen3-4B-Q4_K_M.gguf` | 2.5 GB |

It ends at 4B on purpose: wllama runs in wasm32, so model + KV cache +
runtime must fit a ~4 GB address space — 8B+ cannot load in-browser.

## Setup

```bash
cd benchmark
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/playwright install chromium
python3 download_models.py     # one-time ~4 GB, resumable, skips existing
```

## Run

```bash
.venv/bin/python run_benchmark.py            # CPU (headless Chromium)
.venv/bin/python run_benchmark.py --gpu      # real WebGPU via Windows Edge (WSL2)
.venv/bin/python run_benchmark.py --both     # CPU run, then GPU run
.venv/bin/python run_benchmark.py --models 0.6B,1.7B --threshold 8
```

Notes:
- **GPU mode is for WSL2 setups**: headless Chromium inside WSL only gets
  SwiftShader (software) WebGPU, so `--gpu` launches Windows Edge
  (`--headless=new --enable-unsafe-webgpu`) via interop and connects over CDP.
  Mirrored networking makes localhost work in both directions.
- A model is stopped early when it averages below the threshold (default
  5 tok/s) after two questions; larger rungs are then skipped.
- Answers use the app's default sampling settings (temperature 0.7), i.e.
  exactly what a user gets — expect some run-to-run variation.
- All questions carry Qwen3's `/no_think` switch except `reasoning-1`, which
  runs with thinking enabled to exercise HermitUI's `<think>` rendering.

## Results

Each run writes `results/<timestamp>-<backend>/`:
- `review.md` — speed summary table, the recommendation (with a ready-to-share
  `#gguf=` link), then every question with each model's answer side by side
  (+ TTFT and tok/s per answer) for human judging.
- `run.json` — the full raw data.

`models/`, `results/` and `.venv/` are gitignored.
