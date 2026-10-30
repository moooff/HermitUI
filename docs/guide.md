# HermitUI guide

The details behind the [README](../README.md): benchmarks, browser limits, server setup, URL parameters and how the project is built.

- [In-browser inference](#in-browser-inference)
- [Benchmarks](#benchmarks)
- [Qwen3.8-27B in the browser](#qwen38-27b-in-the-browser)
- [Browser support and model size limits](#browser-support-and-model-size-limits)
- [Server setup](#server-setup)
- [CORS troubleshooting](#cors-troubleshooting)
- [Configuration via URL](#configuration-via-url)
- [Use cases](#use-cases)
- [Architecture](#architecture)
- [Building](#building)
- [Built with](#built-with)
- [Roadmap](#roadmap)

## In-browser inference

The in-browser build, `dist/hermit-ui-wllama.html`, runs GGUF models with [wllama](https://github.com/ngxson/wllama): llama.cpp compiled to WebAssembly, with optional WebGPU acceleration. It is the standalone app plus a **Backend Mode** switch in Settings (`Remote / Local API` or `True Offline (Wllama GGUF)`). The other builds stay small because the build script strips the feature out of them.

- **No network needed.** The wllama engine (JS and WASM) is embedded in the file at build time, gzipped and unpacked in the browser with `DecompressionStream`. The ~6 MB file is complete on its own and can go to an air-gapped machine on a USB stick. With a `.gguf` from disk, nothing touches the network; only the optional download by URL does.
- **Local files.** Pick a `.gguf` from disk and run it in the tab, with a **WebGPU** toggle. Keep the file and pick it again each session: it is the fastest way to use HermitUI repeatedly, and the only way on an air-gapped machine.
- **Load by URL.** Paste a direct `.gguf` link, a Hugging Face `/blob/` URL (rewritten to `/resolve/`) or the shorthand `hf:user/repo/file.gguf`, then press **Load**. The model streams into memory with a progress bar and nothing goes to browser storage, so a URL-loaded model is fetched again next session. **💾 Save a copy to disk** under the URL field hands the same file to the browser's download flow, so the file picker can load it [from then on](#download-once-reuse-offline). A model can also go into a link: `hermit-ui-wllama.html#gguf=hf:user/repo/file.gguf` (see [Configuration via URL](#configuration-via-url)).
- **Settings.** Context window (`n_ctx`, default 32k, halved until it fits in memory; the status line shows the size it ended up at) and max output tokens per reply (default 4096). Temperature, top-p and seed from the normal settings apply too.
- **Chat templates.** The model's own `tokenizer.chat_template` is used when the file has one. Otherwise the format is picked from the architecture (ChatML, Llama 3, Mistral, Gemma, Phi-3, Zephyr, Alpaca and more), with a manual override.
- **Debug console.** A drop-down console with verbosity levels (Off, Errors, Warnings, Info, Debug) shows engine start, download and load progress, model metadata, the exact prompt and llama.cpp's own log.
- **Tokens per second** while the reply streams.

### Download once, reuse offline

The one-click links fetch the model again every session. That is fine for a first try. After that, keep the `.gguf` on disk:

1. Put the model URL in **Settings → Backend Mode → True Offline** and click **💾 Save a copy to disk** under the URL field. The browser downloads the same file to a place you choose; the app itself still writes nothing.
2. Next session, load that file with the file picker in the same panel. No transfer and no network.

Downloading the `.gguf` from Hugging Face directly works the same way. Browsers don't let a link pre-fill a file path, so the pick stays manual, and you still wait for the model to load: about 6 s for Qwen3-0.6B up to about 80 s for gpt-oss-20b (measured over a local HTTP server, so a pick from disk is if anything quicker).

## Benchmarks

A [Playwright harness](../benchmark/) drives the unmodified `dist/hermit-ui-wllama.html` the way a user would, through `#gguf=` and the app's own buttons. Every model answers the same [10 questions](../benchmark/questions.json), scored by hand. Setup: 16 threads, RTX 5070 Ti, Edge with WebGPU, 3 or more runs per model on a GPU checked to be idle (the harness [refuses to start](../benchmark/run_benchmark.py) otherwise).

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

*Load: engine start plus model transfer from a local HTTP server (your Hugging Face download time comes on top). Decode: generation speed without TTFT. End-to-end: what the app's stats readout shows, prompt processing included.*

† gpt-oss-20b is MXFP4 (the others are `Q4_K_M`) and a reasoning model. Its hidden thinking inflates the end-to-end denominator: one short, correct logic answer read 2.9 t/s end-to-end while decoding at 40.5 t/s. Compare it on the decode column. Its answers were good, and it is the strongest large model here if you have the VRAM.

CPU only (WebGPU off, same machine): Qwen3-0.6B about 16 t/s, Qwen3-1.7B about 10 t/s. Larger models are too slow to use: Qwen3-4B about 3 t/s, Gemma-4-E2B about 1.6 t/s.

What the numbers show:

- Qwen3 suits the browser best. Even 8B stays interactive on WebGPU, and TTFT is about 1 s across the family.
- Gemma-4 decodes at 30-40 t/s but processes prompts slowly under wllama: 9-15 s before the first token pulls end-to-end into single digits. All its answers were correct, so the gap is in the engine.
- Size is not the limit. 12.1 GB runs well, and so does 13.0 GB: [Qwen3.8-27B at 4 bpw](#qwen38-27b-in-the-browser) holds about 8 t/s. gpt-oss-20b decodes faster than the 7.1 GB Gemma-4-12B on a 16 GB card, because the sparse MoE activates only about 3.6B parameters per token. Architecture predicts speed better than file size. WASM Memory64 (Chrome/Edge) is required; without it, anything above ~4 GB fails.
- The GPU decides more than the model size. Going from 0.6B to 8B costs about 30% of decode speed; dropping to CPU costs about 80%. Free VRAM counts most of all: a busy GPU made these same runs look up to 23× slower, so if your numbers are far off, check what else is using the card.

[Reproduce it](../benchmark/README.md) with one `pip install` and no Node. Each run writes `review.md` with the timings and every answer in full, so you can check quality yourself, plus a machine-readable `run.json`.

## Qwen3.8-27B in the browser

Qwen3.8-27B at 4 bpw runs in the in-browser build. At 13.0 GB it is the largest model tested here.

| | |
|---|---|
| Model | [`byteshape/Qwen3.8-27B-GGUF`](https://huggingface.co/byteshape/Qwen3.8-27B-GGUF) → `Qwen3.8-27B-IQ4_XS-4.00bpw.gguf` |
| Size / quant | 13.0 GB, `IQ4_XS` (4.00 bpw) |
| Architecture | `qwen35`: hybrid attention + SSM, 65 layers, 248k vocab |
| Load time | 18-23 s from a local file (engine start + weights) |
| VRAM | 14.2-14.9 GB of a 16 GB card, at `n_ctx` 8192 |
| Speed (app readout) | about 8 tok/s: 7.7-8.5 across seven replies of 550-920 tokens |

The speed is the app's own tokens/s readout, so it includes prompt processing (the end-to-end column above, not decode). Short replies read lower (4-6 t/s at 50-170 tokens, about 2.5 t/s for the first reply after a load) because the fixed TTFT weighs more. The longer replies give the fair number.

Two limits:

- Tested with the file picker. A 13 GB `#gguf=` link was not tried, and at this size [download once and pick the file](#download-once-reuse-offline) is the better route anyway.
- Chrome/Edge only, and it needs the VRAM. WASM Memory64 is required, as for everything above ~4 GB, and 13 GB of weights leave little room on a 16 GB card. Keep `n_ctx` small (8192 here; the KV cache takes about 64 KB per token).

The model thinks at `xhigh` by default, which is slow on a 27B. Set the **🧠 Think** control in the chat box to `low` or **Off** for simple questions. On three trivial prompts, Off finished in 24.9 s with no reasoning; the default took 57.7 s and wrote about 935 characters of reasoning.

This model was tested by hand, outside the [benchmark harness](../benchmark/), so it has no TTFT or decode figures in the table above. The same file under native `llama-server` on the same GPU decodes at [77-101 t/s](#reference-config-a-27b-on-a-16-gb-card), about 10× faster. The browser build trades speed for no install and nothing leaving the tab.

## Browser support and model size limits

Two browser features decide how large a model can load and how fast it runs. wllama checks for both when it loads.

| Capability | What it does | Chrome / Edge | Firefox | Safari |
|---|---|---|---|---|
| **JSPI** (`WebAssembly.Suspending`) | Streams the GGUF into the engine instead of copying it whole into the WASM heap, so only RAM/VRAM limits the size | ✅ Chrome 137+ | ⚠️ 153+ only | ❌ none, ~3 GB cap |
| **WebGPU** (in workers) | GPU-accelerated inference | ✅ mature | ⚠️ new, may fail to start, falls back to CPU | ⚠️ in recent versions, untested here |

HermitUI checks both by capability (it doesn't read the user agent) and warns in the panel before a download that can't succeed.

- **Chrome / Edge:** multi-GB models (7B and larger quants) load and run with WebGPU. Your RAM and VRAM are the limit.
- **Firefox before 153:** without JSPI, wllama copies the whole model into the 4 GiB WASM heap. Models above about 3 GB fail with `source array is too long` (an unchecked allocation failure in wllama). Update to Firefox 153 or later, which turns JSPI on. To check, type `!!WebAssembly.Suspending` in the DevTools console; it must print `true`.
- **Firefox speed:** Firefox's WebGPU is much newer than Chrome's and may not start in the wllama worker, which leaves single-threaded CPU WASM. When WebGPU does start, decoding is often under 1 tok/s with the GPU nearly idle: Firefox checks for finished GPU work on a fixed 100 ms timer ([bug 1870699](https://bugzilla.mozilla.org/show_bug.cgi?id=1870699)), and llama.cpp waits on the GPU several times per token. HermitUI shows a notice about this in Firefox; until the fix ships, CPU mode is faster there. The debug console (verbosity **Debug**, then reload the model) shows whether WebGPU or the CPU backend was picked. If WebGPU misbehaves, turn the toggle off.
- **Safari:** no JSPI, so the ~3 GB limit applies with no newer version to move to. Qwen3-0.6B and 1.7B work, Qwen3-4B is the realistic maximum, larger models fail. The benchmarks were not run on Safari. The rest of HermitUI (the [client for your own server](../README.md#connect-your-own-server)) works in every browser.

## Server setup

The standalone build talks to any server with the OpenAI chat completions API. Open **⚙️ Settings** to set the API URL, model name, API key and system prompt.

### LM Studio (the default)
1. Start the **Local Server** in LM Studio.
2. **API URL:** `http://localhost:1234/v1/chat/completions`
3. **Model Name:** leave blank, or the identifier of the loaded model.
4. Turn CORS on in LM Studio's server settings.

### Ollama
1. Start Ollama with CORS allowed:
   ```bash
   OLLAMA_ORIGINS="*" ollama serve
   ```
2. **API URL:** `http://localhost:11434/v1/chat/completions`
3. **Model Name:** the model you pulled (e.g. `llama3`, `mistral`, `deepseek-coder`).

### vLLM
1. Start vLLM. It serves an OpenAI-compatible endpoint and allows every origin by default:
   ```bash
   vllm serve meta-llama/Llama-3.1-8B-Instruct
   ```
   To allow only some origins, pass `--allowed-origins` a JSON array: `--allowed-origins '["https://example.com"]'`.
2. **API URL:** `http://localhost:8000/v1/chat/completions`
3. **Model Name:** the model you served (e.g. `meta-llama/Llama-3.1-8B-Instruct`).

### llama.cpp (`llama-server`)
1. Start `llama-server` with a GGUF. `--jinja` applies the model's own chat template, which the 🧠 Think control needs:
   ```bash
   llama-server --model model.gguf --jinja --host 0.0.0.0 --port 8080
   ```
2. **API URL:** `http://localhost:8080/v1/chat/completions`
3. **Model Name:** anything; `llama-server` serves the model it loaded.
4. For a reasoning model, add `--reasoning-format deepseek`. The trace then comes in `reasoning_content`, which HermitUI shows in the collapsible think block. **Settings → Check Reasoning Support** reads the server's `/props` and reports exactly what it supports.

#### Reference config: a 27B on a 16 GB card

A config that fits a 16 GB GPU, with what each flag costs: Qwen3.8-27B at 4 bpw on one RTX 5070 Ti, using the model's MTP layer for speculative decoding. Only the numbers are specific to this card.

```bash
llama-server --model Qwen3.8-27B-IQ4_XS-4.00bpw.gguf \
  --ctx-size 40000 --jinja --reasoning-format deepseek --reasoning-preserve \
  --flash-attn on --cache-type-k q8_0 --cache-type-v q8_0 \
  --spec-type draft-mtp,ngram-mod --spec-draft-n-max 2 \
  --cache-type-k-draft q8_0 --cache-type-v-draft q8_0 \
  --n-gpu-layers all --parallel 1 --threads 32 --batch-size 1024 --ubatch-size 1024 \
  --temp 1.0 --top-p 0.95 --top-k 20 --min-p 0.0 --repeat-penalty 1.0 \
  --host 0.0.0.0 --port 8080
```

Speed, from `llama-server`'s own `timings` (decode only, TTFT excluded):

| Workload | With `--spec-type` | Without | Gain |
|---|---:|---:|---:|
| Prose (200-word explainer, ×3) | **77.1 t/s** | 50.4 t/s | 1.53× |
| Reasoning prompt | **91-96 t/s** | n/a | ~1.85× |
| Code generation | **100.7 t/s** | 50.2 t/s | **2.01×** |

Prompt processing reached 1,489 t/s on a 6,742-token prompt. The baseline without speculation varied by less than 0.3 t/s over four runs, so the gains are real.

Draft acceptance explains the spread: 98.7% on code, 82-88% on the reasoning prompt, 50-65% on prose. MTP predicts structured text much better than free prose, so code gains the most.

⚠️ **Keep `--parallel 1`; it is worth 3.6×.** Without it the server opens 4 slots, which switches llama.cpp to a unified KV cache (`kv_unified = 'true'`) sized for all of them, and every token does far more attention work. Measured on this machine with nothing else changed: 20.4 t/s prose and 29.2 t/s code with 4 slots, 73.8 and 97.1 with one. VRAM stays at about 15.5 GB either way, so nothing looks wrong. Check `total_slots` at `http://localhost:8080/props`; it must be `1`.

Where the VRAM goes at `--ctx-size 40000`, as `nvidia-smi` and the server's load log report it:

| | VRAM |
|---|---:|
| Model weights on GPU (4 bpw) | 12,376 MiB |
| Compute buffers (`--ubatch-size 1024`) | 396 MiB |
| KV cache @ 40k `q8_0`, plus CUDA context overhead | ≈2,260 MiB |
| MTP draft context (what `--spec-type` costs) | ≈860 MiB |
| **Total resident** | **15,893 of 16,303 MiB** |

That leaves about 410 MiB free. It runs, but nothing else fits on the card: don't run a WebGPU browser (HermitUI's in-browser mode included) on the same GPU at this context size.

If it doesn't fit, cut in this order:

1. Lower `--ctx-size`. The KV cache grows linearly with it, so going from 40k to 20k frees about 1,000 MiB. This is the cheapest VRAM there is.
2. Keep `--cache-type-k q8_0 --cache-type-v q8_0` (and `--flash-attn on`, which quantized KV needs). `q8_0` uses one byte per element where f16 uses two, so f16 would roughly double the KV figure above. At 40k context that decides whether it fits.
3. Drop `--spec-type` last. It frees about 860 MiB but loses the 1.5-2.0× decode speedup, so give it up only once the context is as small as you can accept.

This is about 10× the ~8 t/s the same model reaches in the [in-browser build](#qwen38-27b-in-the-browser).

For a ready-made Windows launcher of the same setup on the smaller IQ3_S file, see [start-qwen38.ps1](start-qwen38.ps1). It sizes the context from the free VRAM and checks after start that nothing spilled into shared memory; [reports/llama-server-16gb-tuning.md](../reports/llama-server-16gb-tuning.md) has the measurements behind it.

### Cloud models (OpenRouter, OpenAI, Groq and others)
1. **API URL:** the provider's chat completions endpoint (e.g. `https://openrouter.ai/api/v1/chat/completions`).
2. **Model Name:** the model you want (e.g. `anthropic/claude-opus-4.8`); check the provider's model list for the exact name.
3. **API Key:** your provider's key, in Settings.

> [!WARNING]
> With a cloud model, your chats leave your machine, and it is unclear how the provider handles, stores or trains on them. For privacy, use local models.

## CORS troubleshooting

If HermitUI can't reach a local server (e.g. "Network Error"), the cause is most likely CORS. HermitUI runs as a local file (`file://`), and browsers block its requests to `http://localhost` unless the server allows them.

- **LM Studio:** "Local Server" tab, turn the **CORS** toggle on.
- **Ollama:** set `OLLAMA_ORIGINS` before starting, e.g. `OLLAMA_ORIGINS="*" ollama serve`.
- **vLLM:** allows all origins by default. If you narrowed it, widen `--allowed-origins` (a JSON array, e.g. `'["*"]'`).

## Configuration via URL

You can put the connection settings into the link itself, after the `#`. Save that as a bookmark and the app opens set up:

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
| `persona` | Preset persona: `technical`, `general`, `writing` or `tutor` |
| `gguf` | *(in-browser build only)* GGUF model to load: direct URL, Hugging Face link or `hf:user/repo/file.gguf`. A banner asks before the download starts. |

Your browser never sends the part after `#` to a server, and the app doesn't store it. Reload the page and the settings are still there, because they are in the address. When a link changes a setting, a toast tells you which one, so a link can't switch things behind your back. You can't set the system prompt this way: someone could hide bad instructions in a link.

> [!NOTE]
> A `key` in the link isn't sent anywhere, but your browser history and bookmarks keep it. On a shared computer, type the key into Settings instead.

## Use cases

- **Regulated networks:** company or government networks where you can't install software but can reach a local or remote model server.
- **Air-gapped machines:** carry the file on a USB stick and use it against a model server on the local network, or run the in-browser build with a `.gguf` and no server at all.
- **Kiosks and shared desks:** no chat history is ever written, so the next person finds nothing.

## Architecture

- **One file.** The product is always one standalone `.html` file. `src/` is split into `index.html`, `style.css` and `script.js` for maintenance, and `build.py` puts them back together.
- **Vanilla only.** No React, Vue, Angular or other frontend framework, no `package.json`, npm, Webpack or Vite, and no CSS framework such as Tailwind or Bootstrap.
- **Sanitized output.** Every rendered AI response goes through `DOMPurify`.

The full rule set is in [`AGENTS.md`](../AGENTS.md). The live build runs on GitHub Pages at [moooff.github.io/HermitUI](https://moooff.github.io/HermitUI).

## Building

The root `index.html` is a copy of `dist/hermit-ui-standalone.html` and works fully offline: fonts and images are base64-encoded and the libraries are inlined into the file.

Edit the sources in `src/` (`index.html`, `style.css`, `script.js`; they load the libraries from a CDN, which is handy during development), then run:

```bash
python3 build.py
```

You need Python 3 and, for the first build, an internet connection. `build.py` uses only the standard library: no `pip install`, no `package.json`, no Node.

The output runs offline, but building it does not. On the first build, `build.py` downloads the pinned library versions (Marked.js, DOMPurify, Highlight.js, KaTeX, Mermaid, the Inter font and the wllama engine, about 14 MB) into `libs/` and checks each against the SRI hash in `src/index.html`. Later builds use that copy; `--refresh` downloads again. To build on an air-gapped machine, copy a filled `libs/` folder along with the repo.

The build writes `dist/hermit-ui-standalone.html`, copies it to the root `index.html` for GitHub Pages, and writes the other variants to `dist/`. The standalone, CDN and wllama variants are committed so they can be browsed and downloaded on GitHub. `dist/hermit-ui-local.html` and `libs/` are generated only and gitignored.

Tests: `node tests/run.mjs` for the pure logic, and the end-to-end tests in `tests/` against the built files (see [`tests/README.md`](../tests/README.md)). For changes to inference speed, the [benchmark harness](../benchmark/README.md) gives numbers you can put in a PR.

## Built with

- Vanilla HTML5, CSS3 and ES6 JavaScript
- [wllama](https://github.com/ngxson/wllama): llama.cpp in WebAssembly, for in-browser inference
- [Marked.js](https://marked.js.org/): Markdown parsing
- [DOMPurify](https://github.com/cure53/DOMPurify): HTML sanitization
- [Highlight.js](https://highlightjs.org/): syntax highlighting
- [KaTeX](https://katex.org/): LaTeX math (MathML output)
- [Mermaid](https://mermaid.js.org/): diagrams from ```` ```mermaid ```` fences
- [Google Fonts (Inter)](https://fonts.google.com/specimen/Inter): typography

## Roadmap

- **Split GGUF files:** load sharded models (`-00001-of-000NN.gguf`) through the URL loader.
- **Save while downloading:** write the model to disk as it downloads (File System Access API), so keeping a copy takes one transfer instead of two. Chrome/Edge only, which is why the simpler second download exists today.
- **Text-analysis app:** a separate, very small single-file build (Transformers.js + WebGPU, models under 200 MB) for summarizing and analysing text.

The full list of ideas and tasks is in [`backlog.md`](backlog.md).
