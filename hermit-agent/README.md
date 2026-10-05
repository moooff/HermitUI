# HermitUI Agent

*A supervised, sandboxed, ephemeral agent that runs entirely in your browser.*

> **Status: v0.2.0** (Phase 3, native tool calls). One self-contained HTML file,
> [`dist/hermit-agent-standalone.html`](dist/hermit-agent-standalone.html) (≈ 9 MB,
> Python included). It is developed here, separately from the main app in
> [`../src/`](../src/), so it can move fast without destabilising HermitUI.

## Try it

1. Start an OpenAI-compatible server that allows browser requests (CORS). For
   example, llama.cpp: `llama-server -m model.gguf --jinja --port 8080`. Any
   OpenAI-compatible cloud API works too, but then the task and what the agent
   prints go to that provider.
2. Open `dist/hermit-agent-standalone.html`. Double-clicking the file is fine: no
   server is needed, and Python boots offline in about a second.
3. Open ⚙️ Settings and set the API Base URL (default `http://localhost:8080/v1`),
   the model and, if needed, the key. Use **Test Connection** to check them.
4. Drop files into the workspace, describe the task, and press **Start**.

The agent needs a model that can recover from its own errors. The reference tasks
pass with Qwen3.8-27B at reasoning effort Low (see [ROADMAP.md](ROADMAP.md)).
Packages such as numpy or pandas load on demand from the pinned Pyodide CDN, so they
need a connection; the standard library works fully offline, and a package that can't
load says why. If the server goes away mid-task, the agent retries for two minutes and
then pauses: nothing is lost, and Retry carries on where it stopped.

Agent code runs in a WebAssembly Python inside the tab. Its network access is
blocked on a **best-effort** basis: 17 known paths are tested and closed (DESIGN
§10), but it is a denylist, not a guarantee. Don't put secrets in the workspace that
you couldn't afford to leak.

## The idea

You give the agent a task, for example "clean up these CSVs and chart the monthly
totals", "write and test a parser for this log format" or "check this calculation
numerically". The agent works through it step by step: it writes Python, runs it
against a virtual file system, reads the output and decides the next step. Text
files it can also read, write and edit directly, with `read_file`, `write_file`
and `edit_file` actions that need no Python and are gated before they apply.

The agent acts through **native tool calls** (OpenAI `tools`) when the endpoint says it
supports them (llama.cpp with `--jinja`, Ollama models with tool support), and through
```` ```python ```` blocks and file tags in its reply with any other chat model. Settings →
**Actions** picks one explicitly; a server that refuses tool calls falls back on its own.

What makes it different from CLI agents is that **you can supervise it**:

- **Every step is visible:** the model's reasoning, the exact code, the output, the
  charts and images it made (inline), and a diff of which files changed.
- **Risky steps wait for you.** Harmless steps run on their own. Anything that
  deletes or overwrites your files, or tries to reach the network, is held for
  approval.
- **Every step can be undone.** The workspace is checkpointed after each step, and
  you can rewind to any of them.
- **It can't touch your machine.** Python runs as WebAssembly (Pyodide) in a Web
  Worker. The agent only sees the in-memory workspace you put files into, and that
  workspace is gone when you close the tab.
- **Sessions go where you put them.** Export a whole session (conversation, steps,
  workspace, checkpoints) to a single `.zip` and import it later to resume or review.
  ➕ New can start a clean session on the same workspace files. The app itself still
  remembers nothing.

## Relationship to HermitUI

It is the same brand and the same philosophy: a single HTML file, vanilla JS, no
persistence, any OpenAI-compatible endpoint. It reuses much of HermitUI's proven
code: streaming, think-tag parsing, settings, error hints and the inline build
machinery (the list is in [AGENTS.md](AGENTS.md)). It lives in its own folder with
its own `src/`, `build.py` and `tests/`, and may merge back into HermitUI later as a
build flavor or a mode.
See [DESIGN.md §11](DESIGN.md#11-project-layout--merge-path).

## Documents

| Document | What's in it |
|---|---|
| [DESIGN.md](DESIGN.md) | The full design: supervision model, session import/export, architecture, agent loop, security, packaging |
| [ROADMAP.md](ROADMAP.md) | Phases with checklists and exit criteria, from the first spike to the merge decision |
| [PHASE0_FINDINGS.md](PHASE0_FINDINGS.md) | What the Phase 0 spike measured: offline boot, kill & re-seed, network blocking, GitHub Pages |
| [PHASE3_5_LIBRARY_STUDY.md](PHASE3_5_LIBRARY_STUDY.md) | Which pure-Python libraries to bundle: cost, whether they work in Pyodide, and what the model reaches for |
| [AGENTS.md](AGENTS.md) | Rules for anyone (human or AI) working in this folder, build & test commands |
| [REVIEW_NOTES.md](REVIEW_NOTES.md) | Open decisions (MVP, Phases 2a, 2b and 3), waiting for a review |
| [tests/README.md](tests/README.md) | What the unit, end-to-end and real-model tests cover |
