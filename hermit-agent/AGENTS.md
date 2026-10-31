# HermitUI Agent — agent rules

HermitUI Agent (`hermit-agent/`) is a supervised agent that writes and runs Python in the browser tab (Pyodide in a worker) with the user's own OpenAI-compatible endpoint, and asks before it changes their files. It ships as one HTML file, `dist/hermit-agent-standalone.html`. This file extends the root [`../AGENTS.md`](../AGENTS.md); read that first: every root rule applies here unless a line below overrides it. Claude Code reads this file through a local `CLAUDE.md` symlink, gitignored like the root's (never commit it).

## Hard rules
- **Root rules here:** ephemerality covers Pyodide (MEMFS only; never IDBFS or Pyodide's persistent package cache), and exporting the session to a file the user picks is the only persistence. `DOMPurify.sanitize()` covers imported session content as well as model output.
- **Worker messages:** untrusted. Agent code reaches the worker's JS globals through Pyodide's `js` module and can forge messages, so the main thread validates every one and never evaluates what it receives (DESIGN §4.1).
- **API key:** never reaches the worker or an export.
- **Import:** restores a session paused; nothing runs by itself (DESIGN §3.3).
- **Sandbox claims:** UI text about network isolation says only what was proved (DESIGN §10, [PHASE0_FINDINGS.md](PHASE0_FINDINGS.md)).
- **Root app:** agent work never edits `../src/`, `../build.py`, `../tests/` or `../dist/`. A HermitUI bug found on the way gets its own commit, and you say so.
- **Copy, don't import:** code from `../src/` is copied and adapted, and each copied function has a row in DESIGN §9 with its source commit, so fixes can be ported both ways.

## Build & test
`python3 build.py` writes `dist/hermit-agent-standalone.html` and the offline builds in `OFFLINE_BUILDS` (DESIGN §8): `dist/hermit-agent-offline.html` (numpy, pandas, matplotlib inlined, ~38 MB, must stay under 50 MB) and `dist/hermit-agent-offline-full.html` (plus scipy, ~59 MB, gitignored, a release download), plus its `libs/` cache, and nothing outside this folder. The output is committed and linked from the project page, so build before every commit. Details on every test: [tests/README.md](tests/README.md).
```bash
node tests/run.mjs                                    # unit tests (pure logic)
../benchmark/.venv/bin/python tests/e2e_agent.py      # mock endpoint, Chromium + Firefox; E2E_ONLY=a,b runs named scenarios
../benchmark/.venv/bin/python tests/e2e_reference.py --quick --tool-mode native   # real model on :9931: 5 tasks, ~1 min
../benchmark/.venv/bin/python tests/e2e_network.py    # network audit, ~10 s: every change
../benchmark/.venv/bin/python tests/e2e_network.py --offline        # the offline build: no third-party host at all
../benchmark/.venv/bin/python tests/e2e_network.py --offline-full   # the full offline build
```
- Bundled libraries live in one manifest, `BUNDLED_LIBRARIES` in `src/script.js` (strict JSON between the `@bundled` markers; `build.py` and the unit tests parse it). A new one brings a pinned wheel (URL + sha256) and its Pyodide packages; the build checks the rest against the wheel's metadata (DESIGN §8). With no wheel on PyPI, pin its source archive under `sdist` and `build.py` builds the wheel; pin that wheel's sha256 from the first failed build's message.
- Unit tests slice real functions out of `src/script.js` by name (`FUNCS`/`CONSTS` in `tests/extract.mjs`): parsers, the risk classifier, zip and the session schema are tested there; DOM and worker behaviour goes into `e2e_agent.py`. Renaming a listed function fails the suite; update the list with it. The slicer counts raw braces: an unbalanced `{` or `}` in a sliced function's string, regex or comment breaks the suite (every test file fails with "Identifier … has already been declared"), so write `\x7b`/`\x7d`.
- Mock scripts in `e2e_agent.py` are picked by the first key that occurs in the task text, so a new `E2E-…` key must not contain an existing one (`E2E-PLAN` answered `E2E-PLANFIRST`), and a repeated key silently replaces the first.
- The network audit (`e2e_network.py`: only `cdn.jsdelivr.net` is contacted, nothing private reaches it; with `--offline`/`--offline-full`, no third-party host) runs for all three builds on every change, before every commit; a new host or request the check rejects is a finding to report, not a check to loosen without the owner's say. Findings live in DESIGN §10.
- The page's CSP blocks `eval`, so Playwright's `wait_for_function` can't run in it: poll with `page.evaluate`.
- Real-model runs scale with the change. None when no agent behaviour changes. After a small change, the quick run above (and `--tool-mode text` if the change touches that protocol). After a bigger one (a phase, the agent loop, the system prompt's structure, packaging), the full suite: `e2e_reference.py --runs 3`, 27 tasks, 21 to 26 min per protocol on Qwen3.8-27B. `e2e_coding.py` (six coding tasks, hidden tests) and `e2e_app.py` (one long multi-file app) use the same runner and flags; `e2e_longrun.py` runs 20+ steps through outages. Start long runs detached, with `--app` on a copy of the build.

## Code map (`src/`)
`src/script.js` is cut into numbered sections (`// ========== N. … ==========`); `src/worker.js` is the Pyodide worker (`hermitWorkerMain`, DESIGN §4.2).
1. Configuration: `LIMITS` (sizes, timeouts, retry and guard thresholds), `BUNDLED_LIBRARIES`.
2. Helpers copied from HermitUI (DESIGN §9).
3. Agent logic, pure and unit-tested: `buildSystemPrompt`, `parseReply`, `classifyEffect` (the DESIGN §2.3 risk table), native tool calls (`agentToolDefs`, `parseToolCalls`), the plan (`extractPlan`), the loop guard (`repeatsBefore`, `errorRunBefore`), plan first (`effectiveAutonomy`), compaction (`planCompaction`), packages, bundled libraries, binary files.
4. Zip and the session archive: `zipWrite`/`zipRead`, `buildSessionArchive`, `parseSessionArchive`, `validateSession`.
5. Worker client: `startWorker`, `workerCall`, `runInWorker`; `validateRunResult`/`validateLoadResult` check what comes back.
6. Streaming: `streamChat`; `probeReasoningSupport` → `probeTemplateCaps` (reasoning levels, context size, tool-call support).
7. Session state and checkpoints: `freshSession`, `takeCheckpoint`, `enforceCheckpointBudget`.
8. The loop: `runLoop` → `agentTurn` → `executeStep` (Python: run, gate the effect, commit or roll back) or `executeFileStep` (file actions); held steps wait in `waitForDecision`; `requestWithRetry`, `compactHistory`, `rewindTo`.
9. UI: `buildStepCard`, `renderTimeline`, `renderWorkspace`, `testConnection`, `exportSession`/`importSessionFile`, `wireEvents`, `init`.

## Docs
- [DESIGN.md](DESIGN.md) is the source of truth; a change that deviates from it updates it in the same commit.
- [ROADMAP.md](ROADMAP.md): phases, exit criteria and the current phase.
- [REVIEW_NOTES.md](REVIEW_NOTES.md): decisions taken while building that wait for the owner's call (what, why, the alternative).
- [README.md](README.md): the user-facing page.
- `index.html` and `site/` are the hand-written project page, not build output; `spike/` holds the Phase 0 scripts.

## Git & workflow
- Every commit that changes `hermit-agent/` bumps the version in all three places: `APP_VERSION` (`src/script.js`), the header badge (`src/index.html`) and the README's status line. Minor when the commit completes a phase (Phase 4 → v0.4.0; 3.5 counted as one), patch otherwise, sub-phases included.
- Subject line: `hermit-agent: vX.Y.Z; <what changed>`. A port names its source commit: `… (from d73993c)`.
