# HermitUI Agent — Phase 0 findings

What the Phase 0 spike (`spike/`) found out, kept here so [ROADMAP.md](ROADMAP.md)
only carries the result. Section references (§) point to [DESIGN.md](DESIGN.md).

## Offline boot findings

2026-10-03, `spike/build_standalone.py` + `spike/probe_file_boot.py`: Pyodide
**0.29.5** (Python 3.13.2) inlined into one HTML file, opened from `file://` in
headless Chromium 149, stock Firefox 157 and Playwright's Firefox 151.

- **The single-file `file://` boot works in Chromium and Firefox.** Pyodide 0.29.x
  still runs in a *classic* worker, and both browsers start a classic Blob-URL worker
  on `file://`. Inside the worker, `importScripts()` of a Blob URL created in that
  worker also works. (The NetworkError in the first spike came from a URL, not a
  blob.) What was needed:
  - Pre-evaluate `pyodide.js` and `pyodide.asm.js` through `importScripts(blob:)`.
    The loader skips its own script load when `_createPyodideModule` is already
    defined.
  - Pass a fake `indexURL` (`https://pyodide.invalid/`) and a worker-side `fetch`
    shim that serves `pyodide.asm.wasm` (as `application/wasm`, so streaming
    instantiation works), `python_stdlib.zip` and `pyodide-lock.json` from the
    inlined bytes. `stdLibURL` and `lockFileContents` weren't needed.
  - Set `packageBaseUrl` to the pinned CDN, so packages still load on demand.
  - The indirect-`eval` fallback in the spike was never used.
- **Size:** the core is 12.3 MB raw and 7.3 MB inlined (gzip + base64): wasm 3.8 MB,
  stdlib 3.2 MB (already compressed, so base64 grows it), asm.js 0.3 MB. That is
  before HermitUI's own libraries.
- **Boot times** (warm machine, cold page): inflating the core on the main thread
  takes 0.2–0.35 s. From `new Worker()` to Python ready takes 1.0 s in Chromium and
  0.9 s in stock Firefox. Playwright's patched Firefox takes 2.8 s, so don't quote
  that build for timings. WASM memory after boot is 20 MB, and the main-thread JS
  heap is 28 MB in Chromium.
- **Kill & re-seed:** `terminate()` during `while True: pass`, then a fresh worker
  plus a restored workspace (byte-identical hashes, namespace gone as expected)
  takes 0.8 s in both browsers. That is fast enough that the warm spare worker from
  §4.3 isn't needed yet.
- **numpy 2.2.5 on demand** from the pinned CDN works from `file://` (the
  null-origin CORS fetch is fine): 0.5 s in Chromium and stock Firefox. IndexedDB,
  OPFS and Cache Storage stay empty. Firefox's `storage.estimate()` reports 544 KB
  usage, but that is created by the probe itself (`navigator.storage.getDirectory()`
  490 KB, `caches.keys()` 64 KB; a blank page reports 0). The real app must not call
  either.
- `crossOriginIsolated` is `false` and `SharedArrayBuffer` is undefined on `file://`
  in both browsers, so `setInterruptBuffer` is out, as §4.3 assumed.
- **Caveats:** this pins the agent to the 0.29.x line (Python 3.13) rather than 314
  (Python 3.14). If 0.29.x stops getting maintenance releases, patching 314's
  classic-worker check is the fallback, and it is untested. Firefox warns that
  Pyodide 0.29's wasm uses the deprecated legacy exception-handling `try`
  instruction. That is harmless today, but it will matter if Firefox ever drops it.
  Not yet tested: Edge and Firefox on Windows, Safari, and mobile.
- **Desktop Chrome on Windows** (the dev machine, opened by hand from
  `C:\workspace\…`) passes every check, a little faster than headless Linux:
  inflate 0.24 s, boot 0.75 s, kill & re-seed 0.65 s, numpy 0.39 s, storage untouched
  (IndexedDB and caches empty, OPFS refused with SecurityError on `file://`).

## Agent loop spike findings

2026-10-03, `spike/agent_loop.py`: code-as-action loop against a local Qwen3.8-27B
through llama.cpp, with Pyodide 314.0.7 in a Blob module worker in headless Chromium.

- **`file://` boot is harder than §8 assumes** *(resolved by the offline boot
  findings above: Pyodide 0.29.x in a classic worker)*. Pyodide 314 refuses classic workers
  ("Classic web workers are not supported"), and on a `file://` page Chromium won't
  start a Blob module worker at all, and `importScripts()` from a classic Blob worker
  fails with NetworkError. `fetch()` works in both. The spike is therefore served
  from `http://127.0.0.1`. The single-file boot is still open. HermitUI works around
  the same Chromium restriction in `loadWllamaModel` (`../src/script.js`) by
  stripping `{ type: "module" }` from the `Worker` constructor. That only works
  because wllama's worker is classic-compatible, and Pyodide 314 isn't. Options to
  try: Pyodide 0.29.x (still loads in classic workers) with its files fed in as Blob
  URLs, or patching Pyodide 314's classic-worker check.
- The loop works: all 3 reference task types passed (data processing in 2 steps,
  calculation in 1 to 4, code plus tests). The model recovered from its own errors.
- Prompt gaps: the model tried `subprocess` to run unittest (Emscripten has no
  processes). §5.3 should say "no subprocess; run tests in-process".
- **Stale modules in the persistent namespace:** after the agent edited
  `test_roman.py`, re-running the tests used the old import from `sys.modules`. That
  cost 3 steps, and the task hit the 10-step limit just as the tests went green. The
  harness should drop changed workspace modules from `sys.modules` after each step
  (§4.2).
- **Reasoning effort matters a lot for agent loops.** With no setting, Qwen3.8's
  template defaults to `xhigh`. One step of an open-ended task ("a complex hello world
  in Java") spent the whole 8192-token budget on 35k chars of reasoning and returned
  empty content. The spike now defaults to `low` (HermitUI's `buildReasoningParams`
  mapping, levels read from `/props`), switchable with `/effort`, and reports a
  cut-off instead of treating the empty reply as a final answer. The agent needs the
  same control plus a cut-off state.
- **Pyodide is 32-bit:** numpy's default integer is int32 and overflows silently. At
  low effort the model returned the primes sum mod 2³² as a confident final answer;
  at xhigh it had sanity-checked its result and caught it. One line in the system
  prompt (§5.3) fixed it (3/3 runs).
- llama.cpp returns the reasoning in `reasoning_content`, not inline `<think>`, so
  the timeline must read both. HermitUI's `fetchAndStreamChat` already does this
  (`reasoning_content` / `reasoning` / `thinking`, streamed and non-streamed), so
  copy that rather than writing it again.

## Network blocking

Answered by the MVP rather than a separate spike: the worker's network globals are
replaced and a static `<meta>` CSP is set. `tests/e2e_agent.py` runs **17 probes**
(listed in DESIGN §10, "As built and measured"), and all 17 are blocked in Chromium
and Firefox; the mock endpoint receives no request. A CSP inserted at runtime was not
tried, because the static one was enough (`connect-src` has to stay open for the
model endpoint anyway).

What this does and doesn't show: 17 known paths are blocked. It is a denylist over a
large API surface, so it is **no guarantee** that there is no other path. A new
browser API could open one, and the unbuilt dev source runs under a looser CSP (CDN
hosts). The UI and README therefore say "blocked on a best-effort basis" and nothing
stronger.

## `crossOriginIsolated` on GitHub Pages

2026-10-05, the deployed
`https://moooff.github.io/HermitUI/hermit-agent/dist/hermit-agent-standalone.html`,
headless Chromium 149 and Playwright's Firefox 151. GitHub Pages sends no
`Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` headers, so
`crossOriginIsolated` is `false` and `SharedArrayBuffer` is undefined, both on the
page and inside a Blob worker, in both engines. Together with the `file://` result
above, `setInterruptBuffer` is unusable everywhere the agent ships, and
kill & re-seed (§4.3) stays the only way to stop a runaway step.
