# Agent & Contributor Rules — `hermit-agent/`

These rules apply to everything inside `hermit-agent/`. They **extend** the root
[`../AGENTS.md`](../AGENTS.md): every root rule still applies unless this file
explicitly overrides it. If you are an AI agent, read the root file first.

> Local tooling: Claude Code reads `CLAUDE.md`. As in the root folder, a gitignored
> `CLAUDE.md -> AGENTS.md` symlink can be created here; don't commit it.

## Status
Phase 1 (MVP), Phase 2a (reliability), Phase 2b (rich output) and Phase 3 (native tool
calls) are built: `src/` →
`build.py` → `dist/hermit-agent-standalone.html`. The source of truth is
[DESIGN.md](DESIGN.md), and the current phase is in [ROADMAP.md](ROADMAP.md). If an
implementation needs to deviate from the design, update DESIGN.md in the same commit.
Open decisions waiting for review (the MVP build, Phases 2a, 2b and 3) are listed in
[REVIEW_NOTES.md](REVIEW_NOTES.md).

## Build & test
```bash
python3 build.py                                   # → dist/hermit-agent-standalone.html
node tests/run.mjs                                 # unit tests (pure logic)
../benchmark/.venv/bin/python tests/e2e_agent.py   # e2e vs. a mock endpoint, Chromium + Firefox
../benchmark/.venv/bin/python tests/e2e_reference.py --base-url http://localhost:8080/v1 --runs 3   # real model: success rate (--tool-mode native|text)
../benchmark/.venv/bin/python tests/e2e_longrun.py --base-url http://localhost:8080/v1           # real model: 20+ steps through outages
```
See [tests/README.md](tests/README.md). The page's CSP blocks `eval`, so Playwright's
`wait_for_function` can't run inside it: poll with `page.evaluate` instead.

## Inherited from the root (unchanged)
- **The single HTML file is the deliverable.** Split sources are assembled by a
  Python `build.py`. No `package.json`, npm, bundlers or Node build tools.
- **Vanilla JS (ES6+) and vanilla CSS only.** No frameworks, no CSS frameworks or
  preprocessors.
- **Strict ephemerality.** No `localStorage`, `IndexedDB`, cookies or OPFS, for any
  reason. Pyodide **MEMFS only; never IDBFS**, and never Pyodide's persistent package
  cache. Session export/import to a user-chosen file is the only persistence.
- **`DOMPurify.sanitize()`** on all model output *and* all imported session content
  rendered as HTML or Markdown.
- **OpenAI chat-completions schema** for all LLM traffic.
- Glassmorphism, the Inter font, CSS variables plus `data-theme`, a fluid layout with
  minimal media queries.
- Git workflow: check origin first, review before commit, and **never commit or push
  unless the user asks**. No implementation plan is needed before implementing.

## Specific to this folder
- **Don't touch the root app for agent work.** Never edit `../src/`, `../build.py`,
  `../tests/` or `../dist/` as part of HermitUI Agent work. If a HermitUI bug is found
  while copying code, fix it in a separate commit and say so.
- **Own build.** `hermit-agent/build.py` produces `hermit-agent/dist/`. It must not
  write outside `hermit-agent/`. Run it before committing changes to
  `hermit-agent/src/`. When nothing in `hermit-agent/` changed, the root build rule
  (`python3 build.py`) still applies as usual.
- **Copy, don't import.** Code taken from `../src/` is copied and adapted, and every
  copied function is listed in the table below with the source commit, so fixes can
  be ported in either direction.
- **Worker messages are untrusted.** Agent code can reach the worker's JS globals.
  The main thread validates every worker message and never evaluates anything it
  receives (DESIGN.md §4.1).
- **Never send the API key to the worker or into an export.**
- **Never auto-execute imported sessions.** Import restores in a paused state (DESIGN
  §3.3).
- **Be honest about the sandbox.** UI text about network isolation must match what
  the Phase 0 spike actually proved (DESIGN §10). Don't overclaim.
- **Tests:** pure logic (parsers, risk classifier, zip, session schema) goes in unit
  tests that slice real functions out of the source, following
  `../tests/extract.mjs`. DOM and worker behaviour goes in the e2e tests.

## Copied from HermitUI
| Function / block | From (`../src/…`) | Source commit | Adapted how |
|---|---|---|---|
| `escapeHtml`, `gunzipToBytes`, `createThrottle`, `parseThinkSegments` | `script.js` | `28483fc` | unchanged |
| `apiEndpoint`, `normalizeApiUrl`, `apiRoot`, `CLOUD_PROVIDERS`, `detectCloudProvider`, `isLocalEndpoint`, `describeRemoteEndpoint`, `isBlockedMixedContent` | `script.js` | `28483fc` | unchanged (example URL in the error text says :8080) |
| `chatErrorHint` | `script.js` | `28483fc` | wllama branch dropped; context-overflow advice says "rewind"; its overflow regex moved into `isContextOverflowError` (shared with auto-compaction); agent wording via `retriedMs` (paused after retries) and `autoCompact` (overflow advice) |
| `parseReasoningTemplateSupport`, `REASONING_PARAM_KEYS`, `looksLikeReasoningRejection` | `script.js` | `28483fc` | unchanged |
| `buildReasoningParams` | `script.js` | `28483fc` | external-endpoint path only (no wllama kwargs path) |
| `probeReasoningSupport` | `script.js` | `28483fc` | returns levels plus the context size and where it came from: llama.cpp's `n_ctx`, Ollama's `num_ctx`, else the model list (vLLM, LM Studio, OpenRouter-style); runs automatically before the first request |
| `fetchAndStreamChat` → `streamChat` | `script.js` | `28483fc` | API path only; returns `{finishReason, usage, rawUsage, timings, clock}` instead of callbacks; strip-and-retry of reasoning params kept; a stream that ends without `finish_reason`/`[DONE]`, an empty answer, or 3 min of silence after data started throw retryable errors (`requestWithRetry`) |
| Test Connection handler → `testConnection` | `script.js` | `28483fc` | no vision detection; also probes reasoning support |
| `showToast` | `script.js` | `28483fc` | unchanged |
| Debug console (`setDebugConsole`, `#debugConsole` markup and CSS) | `script.js`, `index.html`, `style.css` | `28483fc` | logs agent tool calls instead of wllama output; filter instead of verbosity; no tab, Escape closes |
| `tests/check.mjs`, `tests/run.mjs`, the `extract.mjs` approach | `../tests/` | `28483fc` | extractor also slices `async function`s |
| `build.py` techniques (SRI-verified downloads, gzip+base64 inlining, `</script` escaping, Inter woff2 inlining) | `../build.py` | `28483fc` | rewritten for one output; Pyodide pinned by sha256; CSP swapped for a strict one |
