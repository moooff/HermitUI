<div align="center">
  <img width="500" alt="hermitui-logo" src="https://github.com/user-attachments/assets/f501dda0-d187-4318-aaf8-b10ac085788b" />
  <p><i>A lightweight, modern, and ephemeral single-page web interface for local AI models.</i></p>
  <p>
    <a href="LICENSE"><img alt="License: AGPL v3" src="https://img.shields.io/badge/License-AGPL%20v3-blue.svg" /></a>
    <img alt="Vanilla JS" src="https://img.shields.io/badge/Vanilla%20JS-F7DF1E?style=flat&logo=javascript&logoColor=black" />
    <img alt="Zero Install" src="https://img.shields.io/badge/Install-0_Steps-brightgreen.svg" />
  </p>
  <p>
    <a href="https://moooff.github.io/HermitUI"><b>🌐 Online Demo</b></a> •
    <a href="#-try-it-in-60-seconds">Try It</a> •
    <a href="#-in-browser-inference">In-Browser AI</a> •
    <a href="#-benchmarks">Benchmarks</a> •
    <a href="#-connect-to-your-own-endpoint">Connect a Server</a> •
    <a href="#-features">Features</a>
  </p>
</div>

<div align="center">
  <img src="promo/demo_gpu.webp" alt="HermitUI demo: a GGUF model is downloaded from Hugging Face and answers in real time — WebGPU-accelerated, fully in-browser" width="800" />
  <p><i>In-browser inference with WebGPU acceleration: the model downloads straight into memory (timelapsed) and the answer streams in real time.</i></p>
</div>

<div align="center">
  <a href="https://moooff.github.io/HermitUI">
    <img src="https://img.shields.io/badge/🚀_Try_the_Live_Online_Demo-2ea44f?style=for-the-badge" alt="Try the Live Online Demo" />
  </a>
  <a href="https://moooff.github.io/HermitUI/dist/hermit-ui-wllama.html#gguf=hf:unsloth/Qwen3-0.6B-GGUF/Qwen3-0.6B-Q4_K_M.gguf">
    <img src="https://img.shields.io/badge/🧠_Try_the_In--Browser_AI_Demo-8A2BE2?style=for-the-badge" alt="Try the In-Browser AI Demo" />
  </a>
  <p><i>Left: connect it to your local AI server. Right: one click downloads a small but capable model (Qwen3-0.6B, ~380 MB) and chats <b>fully inside your browser</b> — no server at all.</i></p>
</div>

HermitUI is a chat interface that is **one `.html` file**. No install, no server, no build step, no npm — double-click it and it opens.

Two things set it apart, and they only work together:

*   **🧠 It runs models itself.** GGUF models execute entirely in your browser via llama.cpp compiled to WebAssembly, with WebGPU acceleration. A 12.1 GB model loads in a tab and decodes at 43 tok/s — [and we measured it properly](#-benchmarks).
*   **🔒 It stores absolutely nothing.** No `localStorage`, no `IndexedDB`, no cookies, no model cache, no telemetry. Close the tab and the conversation *and* the model are gone.

Or ignore all of that and point it at LM Studio, Ollama, llama.cpp or vLLM as a [normal client](#-connect-to-your-own-endpoint).

Built for the machines where nothing else fits: air-gapped boxes, locked-down corporate and government networks, shared kiosks and hot desks.

## ⚡ Try it in 60 seconds

**One click:** open the [🧠 In-Browser AI Demo](https://moooff.github.io/HermitUI/dist/hermit-ui-wllama.html#gguf=hf:unsloth/Qwen3-0.6B-GGUF/Qwen3-0.6B-Q4_K_M.gguf) — it pre-fills Qwen3-0.6B (~380 MB) via the `#gguf=` URL parameter; confirm the banner and chat.

Or do it by hand:

1. Save [`dist/hermit-ui-wllama.html`](https://raw.githubusercontent.com/moooff/HermitUI/main/dist/hermit-ui-wllama.html) to disk (right-click → *Save link as…*, since GitHub serves raw `.html` as plain text), then open it in your browser.
2. Settings → Backend Mode → **True Offline (Wllama GGUF)**, then paste into the URL field: `hf:unsloth/Qwen3-0.6B-GGUF/Qwen3-0.6B-Q4_K_M.gguf`
3. Hit **⬇️ Load** (~380 MB download) and chat — no server, no install, and nothing persisted.

## 🧠 In-Browser Inference

HermitUI can run **true offline inference entirely in the browser** — no local server or OpenAI-compatible endpoint required. It's powered by [wllama](https://github.com/ngxson/wllama) (llama.cpp compiled to WebAssembly, with optional WebGPU acceleration): you load a `.gguf` model file and chat with it directly on the page.

This ships as a dedicated build output, **`dist/hermit-ui-wllama.html`** — the regular standalone app plus a **Backend Mode** switch in Settings (`Remote / Local API` ↔ `True Offline (Wllama GGUF)`). The main builds stay lean: the feature is stripped out of them at build time.

*   **🔌 The app needs no network:** The wllama engine (JS + WASM) is embedded directly into the file at build time (gzipped, decompressed in-browser via the native `DecompressionStream` API), so the ~6 MB file is complete on its own — perfect for USB-stick distribution to air-gapped machines. Pair it with a `.gguf` from disk and the whole stack is offline; only the *optional* download-by-URL path touches the network.
*   **📂 Local GGUF loading:** Pick a `.gguf` file from disk and run it fully client-side, with an optional **WebGPU** toggle for hardware acceleration. **Download a model once, keep it, and re-pick it every session** — no network involved, so this is also the fastest way to use HermitUI repeatedly (and the only way on an air-gapped machine).
*   **🔗 Load by URL / Hugging Face:** Paste a direct `.gguf` link, a Hugging Face `/blob/` page URL (auto-rewritten to `/resolve/`), or the `hf:user/repo/file.gguf` shorthand and hit Load. The model streams **straight into memory** with a live progress bar — true to the ephemerality promise, nothing is written to browser storage. That means a URL-loaded model re-downloads each session; to avoid that, save the `.gguf` once and load it from disk with the file picker instead. A model can also be baked into a shareable link: `hermit-ui-wllama.html#gguf=hf:user/repo/file.gguf` (see [Configuration via URL](#-configuration-via-url)).
*   **🎚️ Configurable inference:** Adjustable **context window** (`n_ctx`, default 32k — automatically halved until it fits in memory, with the effective size shown in the status line) and **max output tokens** per reply (default 4096); temperature, top-p, and seed from the regular settings apply too.
*   **🧩 Layered chat-template handling:** Uses the model's own embedded `tokenizer.chat_template` when present, otherwise auto-detects a sane format from the model architecture (ChatML, Llama 3, Mistral, Gemma, Phi-3, Zephyr, Alpaca, …), with a manual override.
*   **🐛 Quake-style debug console:** A drop-down console with graduated **verbosity levels** (Off → Errors → Warnings → Info → Debug) that surfaces engine init, download/load progress, model metadata, the exact prompt sent, and native llama.cpp logs.
*   **⏱️ Live tokens/s:** A real-time generation-speed readout while the model streams.

### 🚀 One-click model links

Every link below opens the wllama build with that model pre-filled via `#gguf=` — confirm the banner and it streams straight into memory. **Nothing is written to disk or browser storage**, so each session re-downloads. Start small; the bigger rungs need a modern Chrome/Edge (see [Browser support](#browser-support--model-size-limits)).

| Model | Download | Try it |
|---|---|---|
| **Qwen3-0.6B** | 0.4 GB | [▶ Run in browser](https://moooff.github.io/HermitUI/dist/hermit-ui-wllama.html#gguf=hf:unsloth/Qwen3-0.6B-GGUF/Qwen3-0.6B-Q4_K_M.gguf) |
| **Qwen3-1.7B** | 1.1 GB | [▶ Run in browser](https://moooff.github.io/HermitUI/dist/hermit-ui-wllama.html#gguf=hf:unsloth/Qwen3-1.7B-GGUF/Qwen3-1.7B-Q4_K_M.gguf) |
| **Qwen3-4B** ⭐ | 2.5 GB | [▶ Run in browser](https://moooff.github.io/HermitUI/dist/hermit-ui-wllama.html#gguf=hf:unsloth/Qwen3-4B-GGUF/Qwen3-4B-Q4_K_M.gguf) |
| **Qwen3-8B** | 5.0 GB | [▶ Run in browser](https://moooff.github.io/HermitUI/dist/hermit-ui-wllama.html#gguf=hf:unsloth/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf) |
| **Gemma-4-E2B** | 3.1 GB | [▶ Run in browser](https://moooff.github.io/HermitUI/dist/hermit-ui-wllama.html#gguf=hf:unsloth/gemma-4-E2B-it-GGUF/gemma-4-E2B-it-Q4_K_M.gguf) |
| **Gemma-4-E4B** | 5.0 GB | [▶ Run in browser](https://moooff.github.io/HermitUI/dist/hermit-ui-wllama.html#gguf=hf:unsloth/gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q4_K_M.gguf) |
| **Gemma-4-12B** | 7.1 GB | [▶ Run in browser](https://moooff.github.io/HermitUI/dist/hermit-ui-wllama.html#gguf=hf:unsloth/gemma-4-12b-it-GGUF/gemma-4-12b-it-Q4_K_M.gguf) |
| **gpt-oss-20b** ⚠️ | 12.1 GB | [▶ Run in browser](https://moooff.github.io/HermitUI/dist/hermit-ui-wllama.html#gguf=hf:ggml-org/gpt-oss-20b-GGUF/gpt-oss-20b-MXFP4.gguf) |

⭐ = best speed/quality trade-off on a WebGPU machine. ⚠️ = the fastest large model measured here (~43 t/s), but a 12 GB download that needs a mostly-free GPU and stalled in 1 of 4 benchmark runs — see the note under the results table. Quants are `Q4_K_M` from [unsloth](https://huggingface.co/unsloth) except gpt-oss-20b, which is MXFP4 from [ggml-org](https://huggingface.co/ggml-org). On a CPU-only machine, use **Qwen3-1.7B** or smaller.

**Downloading once instead of every session:** these links re-fetch the model each time, which is fine for a first try but wasteful afterwards. Save the `.gguf` locally (the links point at the same Hugging Face files, or grab them from the repos directly), then use **Settings → Backend Mode → True Offline → the file picker** to load it from disk — no download, and it works with no network at all. Browsers don't allow a file path to be pre-filled from a link, so it's a manual pick each session; you still pay the model's load time (≈6 s for 0.6B up to ≈59 s for 12B, see the table below), just not the transfer.

## 📊 Benchmarks

A [Playwright harness](benchmark/) drives the **unmodified** `dist/hermit-ui-wllama.html` — via `#gguf=` and the app's own buttons, exactly as a user would — and has every model answer the same [10 questions](benchmark/questions.json), scored for correctness by hand. 16 threads, RTX 5070 Ti, Edge (WebGPU), 3+ runs per model on a verified-idle GPU (the harness [refuses to start](benchmark/run_benchmark.py) otherwise).

| Model | Size | Load | avg TTFT | decode t/s | end-to-end t/s |
|---|---:|---:|---:|---:|---:|
| Qwen3-0.6B | 0.4 GB | 5.7s | 0.66s | **79** | 56 |
| Qwen3-1.7B | 1.1 GB | 11.3s | 0.91s | **73** | 54 |
| Qwen3-4B | 2.5 GB | 21.4s | 1.03s | **64** | 43 |
| Qwen3-8B | 5.0 GB | 41.5s | 1.17s | **55** | 35 |
| Gemma-4-E2B | 3.1 GB | 26.5s | 9.3s | 40 | 6.1 |
| Gemma-4-E4B | 5.0 GB | 36.6s | 11.7s | 32 | 5.6 |
| Gemma-4-12B | 7.1 GB | 58.6s | 15.2s | 36 | 4.0 |
| gpt-oss-20b † | 12.1 GB | ~80s | 3.4s | **43** | 15 |

*Load = engine init + model transfer from a local HTTP server (not your Hugging Face download time). Decode = pure generation speed with TTFT excluded; end-to-end = what the app's own stats readout shows, prompt processing included.*

† **gpt-oss-20b is MXFP4, not `Q4_K_M`, and it is a reasoning model.** Its hidden thinking trace inflates the end-to-end denominator — one terse-but-correct logic answer read 2.9 t/s end-to-end while decoding at 40.5 t/s — so that column is not comparable to the rest. It also **stalled once in four runs**: no first token within 120 s on a question that took ~4.5 s otherwise. Decode speed is excellent and the answers are genuinely good; treat the 12 GB rung as promising rather than dependable.

CPU-only (WebGPU off, same machine): Qwen3-0.6B ≈ 16 t/s, Qwen3-1.7B ≈ 10 t/s. Everything larger is unusable — Qwen3-4B ≈ 3 t/s, Gemma-4-E2B ≈ 1.6 t/s.

**What the numbers say:**

*   **Qwen3 is the sweet spot in a browser.** Even 8B stays interactive on WebGPU, and TTFT is ~1 s across the whole family.
*   **Gemma-4 decodes fine but prompt-processes slowly under wllama** — 9–15 s before the first token drags the end-to-end figure into single digits even though tokens then arrive at 30–40 t/s. All its answers were correct: an engine-side prompt-eval gap, not a model-quality one.
*   **12.1 GB runs, and runs well.** gpt-oss-20b out-decodes the 7.1 GB Gemma-4-12B on a 16 GB card — a sparse MoE activating only ~3.6B params per token beats a dense model despite being 70 % larger on disk. Architecture predicts throughput, not file size. WASM Memory64 (Chrome/Edge) is required: without it, anything above ~4 GB fails outright.
*   **The GPU matters more than the model.** 0.6B → 8B costs ~30 % of decode throughput; dropping to CPU costs ~80 %. Free VRAM matters most of all — a contended GPU understated these same runs by 23×, so if your numbers look nothing like these, check what else is on your card first.

**[Reproduce it yourself](benchmark/README.md)** — one `pip install`, no Node. Each run writes `review.md` with the timings *and every answer in full*, so quality is reviewable and not just asserted, plus a machine-readable `run.json`.

### Browser support & model size limits

How large a model you can load — and how fast it runs — depends on two WebAssembly/GPU features of your browser, which wllama detects at load time:

| Capability | What it enables | Chrome / Edge | Firefox |
|---|---|---|---|
| **JSPI** (`WebAssembly.Suspending`) | Streams the GGUF straight into the engine instead of copying it whole into the WASM heap → model size limited only by your RAM/VRAM | ✅ Chrome 137+ | ⚠️ Firefox **153+** only |
| **WebGPU** (in workers) | Hardware-accelerated inference | ✅ mature | ⚠️ new / may fail to initialize → CPU fallback |

In practice:

*   **Chrome / Edge:** Multi-GB models (7B+ quants) load and run fine, with WebGPU acceleration. The limit is your actual RAM/VRAM.
*   **Firefox before 153:** Without JSPI, wllama falls back to copying the **entire model file into the 4 GiB WASM heap**. Models larger than roughly ~3 GB fail with the cryptic error `source array is too long` (an unchecked allocation failure inside wllama). **Fix: update to Firefox 153+**, which enables JSPI by default. You can verify support by typing `!!WebAssembly.Suspending` into the DevTools console — it must print `true`.
*   **Firefox speed:** Even with JSPI, Firefox's WebGPU support is much newer than Chrome's and may not initialize inside the wllama worker, dropping inference to single-threaded CPU WASM — noticeably slower than Chrome on the same machine. Check the debug console (verbosity **Debug**, then reload the model) to see whether a WebGPU device or the CPU backend was picked. If WebGPU misbehaves, try unchecking the WebGPU toggle — a clean CPU run can beat a broken GPU path.

## 🔌 Connect to Your Own Endpoint

Prefer to run the model outside the browser? The standalone build (`index.html` / `dist/hermit-ui-standalone.html`) talks to anything that speaks the OpenAI chat completions API.

1.  **Start your local AI server** — [LM Studio](https://lmstudio.ai/), [Ollama](https://ollama.com/), [llama.cpp](https://github.com/ggml-org/llama.cpp), or [vLLM](https://github.com/vllm-project/vllm).
2.  **Open HermitUI** — double-click the `index.html` file in any modern browser.
3.  **Configure** — click **⚙️ Settings** in the top right to set the API URL, model name, API key, or system prompt.

<details>
<summary><b>Configuration examples for popular servers</b></summary>

### LM Studio (the default)
1. Launch LM Studio and start the **Local Server**.
2. **API URL:** `http://localhost:1234/v1/chat/completions`
3. **Model Name:** leave blank, or set to the specific model identifier you loaded.
4. *Tip:* ensure CORS is enabled in the LM Studio settings.

### Ollama
1. Start your Ollama server from the terminal, making sure to enable CORS:
   ```bash
   OLLAMA_ORIGINS="*" ollama serve
   ```
2. **API URL:** `http://localhost:11434/v1/chat/completions`
3. **Model Name:** the name of the model you pulled (e.g., `llama3`, `mistral`, `deepseek-coder`).

### vLLM
1. Start your vLLM server with an OpenAI-compatible endpoint:
   ```bash
   python -m vllm.entrypoints.openai.api_server --model meta-llama/Llama-2-7b-chat-hf --cors-allowed-origins "*"
   ```
2. **API URL:** `http://localhost:8000/v1/chat/completions`
3. **Model Name:** the model name specified in your command (e.g., `meta-llama/Llama-2-7b-chat-hf`).

### Cloud models (OpenRouter, OpenAI, Groq, …)
1. **API URL:** the provider's chat completions endpoint (e.g., `https://openrouter.ai/api/v1/chat/completions`).
2. **Model Name:** the model you want (e.g., `anthropic/claude-3.5-sonnet`, `gpt-4o`).
3. **API Key:** enter your provider's key in the settings menu.

> [!WARNING]
> **Privacy note:** using cloud models is generally **not advised** if you require strict privacy. Your data leaves your machine, and it is unclear how these providers handle, store, or train on it. For true ephemerality, stick to local models.

</details>

### Troubleshooting (CORS)

If HermitUI fails to connect to your local AI server (e.g., a "Network Error"), it is most likely **CORS**. Because HermitUI runs as a local file (`file://`), browsers block its requests to `http://localhost` unless the server explicitly allows it.

*   **LM Studio:** "Local Server" tab → find the **CORS** toggle → turn it **ON**.
*   **Ollama:** set `OLLAMA_ORIGINS` before starting, e.g. `OLLAMA_ORIGINS="*" ollama serve`.
*   **vLLM:** start with `--cors-allowed-origins "*"`.

## ✨ Features

*   **📦 Zero-dependency setup:** all external libraries (Marked.js, DOMPurify, Highlight.js, KaTeX, Mermaid) and the Inter font are bundled directly into the file. No installation, no build step. (A CDN-linked developer version lives in `dist/hermit-ui-cdn.html`.)
*   **🔒 Privacy first & ephemeral:** no `localStorage`, `IndexedDB`, or cookies — nothing survives the tab.
*   **🧠 Thinking-model support:** built-in parser formats `<think>`, `<thought>`, and `<reasoning>` tags natively streamed by reasoning models.
*   **⚡ Real-time streaming** with **📊 live performance stats** — prompt tokens, completion tokens, tokens/second, and total duration.
*   **🖼️ Image & vision support:** upload, drag-and-drop, or paste (Ctrl+V) images for vision-capable models, sent as `image_url` content per the OpenAI schema with automatic vision-model detection.
*   **📝 Rich rendering:** Markdown with per-block copy buttons, syntax highlighting, **🧮 LaTeX math** (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`) rendered via KaTeX to native MathML — no webfonts, works mid-stream and offline — and **📈 Mermaid diagrams** from ```` ```mermaid ```` fences.
*   **🎭 Personas:** switch between preset system prompts (technical, general, writing, tutor) on the fly.
*   **✏️ Edit & regenerate** any previous message without restarting the conversation.

<details>
<summary><b>More features</b></summary>

*   **📎 Context attachments:** drag-and-drop or upload text files to inject their contents into your prompt.
*   **🎛️ Advanced sampling controls:** `temperature`, `max_tokens`, `top_p`, `presence_penalty`, `frequency_penalty`, and `seed` from a collapsible Settings panel. Params are only sent when set, keeping payloads compatible with minimal backends.
*   **🎨 Modern UI/UX:** clean, responsive design with smooth micro-animations, comprehensive CSS variables for theming, and a glassmorphism feel. Light and dark themes.
*   **💾 Chat export:** download the entire conversation as a formatted Markdown file.
*   **⚙️ Customizable settings:** API URL, model name, API key, and system prompt via the on-page settings overlay.

</details>

## 🔗 Configuration via URL

You can pre-configure HermitUI through the URL **fragment** (the part after `#`), so a single link or bookmark carries the whole connection setup:

```
hermit-ui-standalone.html#api=http://localhost:8080/v1&model=qwen3-8b
hermit-ui-standalone.html#api=https://api.groq.com/openai/v1&key=gsk_...&model=llama-3.3-70b
hermit-ui-wllama.html#gguf=hf:unsloth/Qwen3-0.6B-GGUF/Qwen3-0.6B-Q4_K_M.gguf
```

| Parameter | Effect |
|---|---|
| `api` | API base URL (same as the Settings field) |
| `model` | Model name |
| `key` | API key |
| `persona` | Preset persona: `technical`, `general`, `writing`, or `tutor` |
| `gguf` | *(wllama build only)* GGUF model to load in-browser — direct URL, Hugging Face link, or `hf:user/repo/file.gguf` shorthand. Shows a one-click confirmation banner before downloading. |

Why the fragment and not `?query`: the part after `#` **never leaves your browser** — it is not sent in any HTTP request — and nothing is stored, so this stays true to the ephemerality promise (the URL *is* the config; refresh keeps your setup). Applied settings are always announced in a toast, so a shared link can't reconfigure the app invisibly. Free-text system prompts are deliberately not supported as a parameter, since a link could smuggle a malicious prompt.

> [!NOTE]
> A `key` in the URL is never transmitted, but it does end up in your **browser history** (and any bookmark you save). Prefer entering keys in Settings on shared machines.

## 🎯 Ideal Use Cases

*   **Heavily regulated environments:** enterprise or government networks where software installation is restricted, but a secure local or remote inference endpoint is accessible.
*   **Air-gapped systems:** distribute on a USB stick and run on disconnected machines — either against a local network LLM server, or with the wllama build and a `.gguf`, against nothing at all.
*   **Ephemeral kiosks & shared terminals:** no chat history is ever written, making it safe for public workstations and desk-sharing environments.

## 🏗️ Architecture & Philosophy

HermitUI enforces strict architectural constraints to remain lightweight and accessible:

*   **Single file constraint:** the final product is always a single, standalone `.html` file. The `src/` directory is a blueprint only — its split into `index.html`, `style.css`, and `script.js` exists for maintainability, and `build.py` assembles them back into one file.
*   **Vanilla only:** no React, Vue, Angular, or other frontend frameworks.
*   **No build tools:** no `package.json`, `npm`, Webpack, or Vite.
*   **No CSS frameworks:** pure vanilla CSS, no Tailwind or Bootstrap.
*   **Security:** all rendered AI responses are sanitized with `DOMPurify` to prevent XSS.
*   **Online version:** try the live build on GitHub Pages at [moooff.github.io/HermitUI](https://moooff.github.io/HermitUI).

## 📦 Building & Development

The root `index.html` (a copy of `dist/hermit-ui-standalone.html`) is a completely offline, standalone build: web fonts and images are base64-encoded and external JS/CSS libraries are injected directly into the file, which is what makes it work in air-gapped environments.

To modify it, edit the modular sources in `src/` — `index.html`, `style.css`, and `script.js`, which reference libraries via CDN for convenient local development — then run:

```bash
python build.py
```

This generates the standalone build at `dist/hermit-ui-standalone.html`, copies it to the root `index.html` for GitHub Pages, and creates the alternative builds in `dist/`. The standalone, CDN, and wllama variants (`dist/hermit-ui-standalone.html`, `dist/hermit-ui-cdn.html`, `dist/hermit-ui-wllama.html`) are committed so they are browsable and downloadable straight from GitHub; the local variant `dist/hermit-ui-local.html` and the downloaded `libs/` are generated-only and stay gitignored.

## 🛠️ Built With

*   **Vanilla HTML5 / CSS3 / ES6 JavaScript**
*   [wllama](https://github.com/ngxson/wllama) — llama.cpp in WebAssembly, for in-browser inference
*   [Marked.js](https://marked.js.org/) — Markdown parsing
*   [DOMPurify](https://github.com/cure53/DOMPurify) — HTML sanitization / XSS prevention
*   [Highlight.js](https://highlightjs.org/) — code syntax highlighting
*   [KaTeX](https://katex.org/) — LaTeX math rendering (MathML output)
*   [Mermaid](https://mermaid.js.org/) — diagram rendering from ```` ```mermaid ```` fences
*   [Google Fonts (Inter)](https://fonts.google.com/specimen/Inter) — typography

## 🗺️ Roadmap

*   **Split-GGUF support:** load sharded models (`-00001-of-000NN.gguf`) through the in-browser URL loader.
*   **Companion text-analysis app:** a separate ultra-light single-file build (Transformers.js + WebGPU, sub-200 MB models) dedicated to summarization and text analysis.

The full list of ideas and tasks lives in [`docs/backlog.md`](docs/backlog.md).

## 📄 License

This project is open-source and available under the terms of the **GNU AGPL v3**. See the included [LICENSE](LICENSE) file for the full text.
