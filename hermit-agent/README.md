<div align="center">
  <img width="120" alt="HermitUI logo" src="site/logo.svg" />
  <h1>HermitUI Agent</h1>
  <p><i>A supervised agent that writes and runs Python in your browser tab, with your own model.</i></p>
  <p>
    <a href="../LICENSE"><img alt="License: AGPL v3" src="https://img.shields.io/badge/License-AGPL%20v3-blue.svg" /></a>
    <img alt="One HTML file" src="https://img.shields.io/badge/One_HTML_file-11_MB-6f42c1.svg" />
    <img alt="Python via Pyodide" src="https://img.shields.io/badge/Python-Pyodide_(WebAssembly)-3776ab.svg" />
  </p>
  <p>
    <a href="https://moooff.github.io/HermitUI/hermit-agent/"><b>Project page</b></a> •
    <a href="#try-it">Try it</a> •
    <a href="#how-you-stay-in-control">Supervision</a> •
    <a href="#what-it-can-make">Files it makes</a> •
    <a href="#what-leaves-your-machine">What leaves your machine</a> •
    <a href="#documents">Documents</a>
  </p>
</div>

<div align="center">
  <a href="https://moooff.github.io/HermitUI/hermit-agent/"><img src="site/demo-data.webp" alt="HermitUI Agent cleans a messy sales CSV, recovers from two failed attempts, and draws a chart of monthly revenue per region" width="880" /></a>
  <p><i>A real run with Qwen3.8 27B on a local llama.cpp server, sped up by removing the wait. The agent cleans a messy CSV, recovers from its own errors, and saves a chart and an Excel workbook.</i></p>
</div>

<div align="center">
  <a href="https://moooff.github.io/HermitUI/hermit-agent/dist/hermit-agent-standalone.html">
    <img src="https://img.shields.io/badge/Open_HermitUI_Agent-1f6feb?style=for-the-badge" alt="Open HermitUI Agent" />
  </a>
  <a href="https://moooff.github.io/HermitUI/hermit-agent/">
    <img src="https://img.shields.io/badge/Project_page_with_videos-6f42c1?style=for-the-badge" alt="Project page with videos" />
  </a>
</div>

> **Status: v0.3.30** (Phase 3.7, a plan you can see). One self-contained HTML file,
> [`dist/hermit-agent-standalone.html`](dist/hermit-agent-standalone.html) (about 11 MB,
> Python included), developed in this folder apart from the main app in [`../src/`](../src/).

Give it a task, like "clean up these CSVs and chart the monthly totals" or "write and test a parser for this log format". The agent writes Python, runs it on the files in its workspace, reads the output and picks the next step until the task is done. It can also read, write, edit, move and delete files without Python, and a CSV that Excel saved as Windows-1252 stays Windows-1252.

It works with llama.cpp, Ollama, LM Studio, vLLM or a cloud API. There is nothing to install and nothing is stored: close the tab and the workspace is gone.

## Try it

1. Start an OpenAI-compatible server that allows browser requests (CORS), e.g. `llama-server -m model.gguf --jinja --port 9931`. A cloud API works too, but then the task and what the agent prints go to that provider.
2. Open [`dist/hermit-agent-standalone.html`](https://moooff.github.io/HermitUI/hermit-agent/dist/hermit-agent-standalone.html), or download it and double-click the file. Python starts offline in about a second.
3. In Settings, set the API Base URL (default `http://localhost:9931/v1`), the model and, if needed, the key. **Test Connection** checks them.
4. Drop files into the workspace, describe the task, and press **Start**.

You need a model that can fix its own mistakes. The reference tasks pass with Qwen3.8-27B at reasoning effort Low (see [ROADMAP.md](ROADMAP.md)). If the server drops mid-task, the agent retries for two minutes and then pauses; nothing is lost, and Retry carries on.

The model can also run on another computer, with the agent on a phone, for example. Browsers then block the https page from calling a plain http server, so open the agent over http from the server itself, give the server https (e.g. `tailscale serve`), or let Chrome allow local network access. The steps are in [HermitUI's README](../README.md#a-server-on-another-device-phone-tablet-second-pc); for the agent, the API Base URL ends in `/v1`.

## How you stay in control

<div align="center">
  <img src="site/demo-fix.webp" alt="The agent finds two bugs, its edits to the user's files are held for approval with a diff, and after approval main.py prints the expected totals" width="880" />
  <p><i>Two bugs in two files. The edits wait for approval, with the diff shown, before they touch the files you uploaded.</i></p>
</div>

- **You see every step:** the model's reasoning, the code, the result, any charts or images, and a diff of the changed files.
- **Risky steps wait for you.** Harmless steps run on their own. A step that deletes, overwrites or moves one of your files, or tries to reach the network, waits until you approve it.
- **You see the plan.** On longer tasks the agent keeps a short plan above the steps and ticks it off. A note from you changes its course. With supervision set to **Plan first**, it shows you the plan before it changes anything.
- **It doesn't loop.** The same code three times in a row is not run, and the agent is told why; a fourth time pauses the run. Repeated failures with the same error get the same treatment ([DESIGN §5.8](DESIGN.md#58-the-loop-guard-added-in-v0314)).
- **You can undo any step.** The workspace is saved after each step, and you can go back to any of them, or to the start to rephrase the task.
- **It can't touch your machine.** Python runs as WebAssembly (Pyodide) in a Web Worker and sees only the files you put into the workspace.
- **Sessions are files.** Export a session (conversation, steps, workspace, checkpoints) as one zip and import it later. The app itself remembers nothing.

<div align="center">
  <img src="site/demo-app.webp" alt="The agent builds a small library-loans app from a written spec: it writes the package and the CLI with a nine-step plan pinned above the steps, ticks the plan off, fixes the CLI after three failed tries, and finishes with all eleven tests passing" width="880" />
  <p><i>A small app from a written spec. The plan stays above the steps, and the agent ticks it off as it goes.</i></p>
</div>

The agent uses native tool calls where the server supports them (llama.cpp with `--jinja`, Ollama models with tool support) and ```` ```python ```` blocks in its reply with any other model ([DESIGN §5.6](DESIGN.md#56-native-tool-calls-built-in-phase-3)).

For work on long text, the agent can send the model a separate request with the files, or the parts of them, it chooses: summarise a document, translate it, pull facts out of it, or give a second opinion. The model answers without the conversation and without tools, and only its answer goes back into the agent's context ([DESIGN §5.9](DESIGN.md#59-asking-the-model-ask_llm-added-in-v0329)).

## What it can make

numpy, pandas, matplotlib and other Pyodide packages load on demand from the pinned Pyodide CDN. The standard library works offline, except sqlite3, lzma and ssl, which come from the same CDN.

Eleven pure-Python libraries that Pyodide leaves out are inside the file:

| Format | Library |
|---|---|
| Excel | openpyxl, XlsxWriter |
| Word | python-docx |
| PowerPoint | python-pptx |
| OpenDocument | odfpy |
| Markdown and HTML | Markdown, markdownify |
| Tables, XML, QR codes | tabulate, xmltodict, qrcode |
| Charts | seaborn (with matplotlib from the CDN) |

openpyxl, XlsxWriter, odfpy, Markdown, tabulate and xmltodict need no Pyodide package, so they work offline too.

## What leaves your machine

There is no telemetry, and opening the file makes no network request. Using it sends this, and nothing else:

- **To the API Base URL you set:** the conversation, including what the agent reads from your files and what its code prints, the files it attaches to a separate request, plus the API key. Before the first request, and when the URL or model changes, the app also asks the server what it supports (`/models`, `/props`, `/api/show`), as does **Test Connection**.
- **To jsDelivr (`cdn.jsdelivr.net/pyodide/...`):** only when agent code needs a Pyodide package that isn't in the file, such as numpy or pandas. jsDelivr sees your IP address and the package name, never the task or your files.

Blocking the network for agent code is best effort: 17 known paths are tested and closed ([DESIGN §10](DESIGN.md#10-security)), but it is a denylist, not a guarantee. Don't put secrets in the workspace that you couldn't afford to leak. (The unbuilt `src/index.html` also loads its libraries and font from CDNs; `dist/` has them inlined.)

## Relationship to HermitUI

Same idea as HermitUI: one HTML file, vanilla JS, nothing stored, any OpenAI-compatible server. It reuses many of HermitUI's tested parts ([DESIGN §9](DESIGN.md#9-reuse-map-from-hermitui)) and lives in its own folder, so it could later merge back as a mode ([DESIGN §11](DESIGN.md#11-project-layout--merge-path)).

## Documents

| Document | What's in it |
|---|---|
| [DESIGN.md](DESIGN.md) | The full design: supervision model, session import/export, architecture, agent loop, security, packaging |
| [ROADMAP.md](ROADMAP.md) | Phases with checklists and exit criteria, from the first spike to the merge decision |
| [PHASE0_FINDINGS.md](PHASE0_FINDINGS.md) | What the Phase 0 spike measured: offline boot, kill & re-seed, network blocking, GitHub Pages |
| [PHASE3_5_LIBRARY_STUDY.md](PHASE3_5_LIBRARY_STUDY.md) | Which pure-Python libraries to bundle: cost, whether they work in Pyodide, and what the model reaches for |
| [AGENTS.md](AGENTS.md) | Rules for anyone (human or AI) working in this folder: build & test commands, a code map |
| [REVIEW_NOTES.md](REVIEW_NOTES.md) | Open decisions (MVP, Phases 2a, 2b, 3, 3.5, 3.6 and 3.7), waiting for a review |
| [tests/README.md](tests/README.md) | What the unit, end-to-end and real-model tests cover |
| [index.html](index.html) | The [project page](https://moooff.github.io/HermitUI/hermit-agent/), with the demo videos |
