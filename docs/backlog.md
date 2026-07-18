# HermitUI Backlog

Upcoming features, tasks, and ideas. The headline items are summarized in the README's [Roadmap](../README.md#-roadmap).

## 📝 To-Do

- [ ] **Split-GGUF support for the URL loader**
  - Accept sharded models (`-00001-of-000NN.gguf`) in the in-browser (wllama) URL loader and fetch all parts.
- [ ] **Companion text-analysis app (browser-based standalone)**
  - A separate single-file app (e.g., `dist/hermit-analyze.html`) so the main HermitUI build stays lean.
  - Reuse the existing `src/` split (`index.html`, `style.css`, `script.js`) via `build.py`, which assembles both apps into standalone single-file outputs — the explicit build-workflow exception to the Single File Constraint in `AGENTS.md`.
  - Use Transformers.js with WebGPU acceleration (WebAssembly fallback).
  - Target ultra-small models (< 200 MB) like specialized T5 or SmolLM, dedicated to text analysis and summarization.
- [ ] **wllama: Gemma template strictness**
  - Ensure the Gemma 2 prompt template matches expected whitespace exactly (no stray leading/trailing spaces).

## ✅ Completed

- [x] **wllama: fully inline the engine** — `build.py` embeds `index.js` + `wllama.wasm` (gzip + base64, decompressed in-browser via `DecompressionStream`) into `dist/hermit-ui-wllama.html`, so first model load needs zero network; dev source keeps the CDN `import()` fallback
- [x] **wllama: merged into the main tree** — ported from `temp_wllama/` into `src/` behind `@wllama:start/end` build markers; ships as `dist/hermit-ui-wllama.html`
- [x] **wllama: resource cleanup** — `await wllamaInstance.exit()` before initializing a new model
- [x] **wllama: global `window.Worker` mutation leak** — patch is scoped to the model load and restored in a `finally`
- [x] **wllama: loading-state protection** — file input disabled while a load is in flight
