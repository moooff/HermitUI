# HermitUI Agent — Roadmap

Each phase ends with **exit criteria**. Don't start the next phase until they are met,
or until they are consciously waived and the reason is written down here. Section
references (§) point to [DESIGN.md](DESIGN.md).

---

## Phase 0 — Spike: prove the risky parts

Throwaway code, kept in `hermit-agent/spike/`, which gets deleted or folded into
`src/` afterwards. The goal is answers, not polish.

- [x] Pin a Pyodide release. Download its core files with a minimal script.
- [x] Single HTML file opened from **`file://`**, with no server: inline the core
      (gzip + base64), create a **Blob-URL worker**, and boot Pyodide from the inlined
      bytes (§8). Record which loader options were enough and what needed a `fetch`
      shim.
- [x] Run code in the worker. Read and write `/workspace` on MEMFS. Return a file
      listing with hashes.
- [x] **Kill & re-seed** (§4.3): `terminate()` during `while True: pass`, boot a fresh
      worker, restore the workspace. Measure re-boot time.
- [x] Confirm `setInterruptBuffer` is unusable on `file://` and on GitHub Pages
      (`crossOriginIsolated === false`). *Both confirmed in Chromium and Firefox.*
- [x] **Network blocking** (§10): try removing the worker globals, a CSP via `<meta>`,
      and a CSP inserted at runtime. Try to exfiltrate from Python with `pyfetch`,
      `js.fetch`, `js.XMLHttpRequest`, `js.WebSocket`, `js.eval("import(...)")` and
      nested `js.Worker`. Write down exactly what each approach blocks.
      *Answered by the MVP rather than a separate spike. A CSP inserted at runtime
      was not tried.*
- [x] Load one package (numpy) on demand from the CDN, held in memory only, with no
      OPFS or IndexedDB use. Check DevTools → Application → Storage.
- [x] Measure: standalone file size; cold boot time in Chrome, Firefox and Safari if
      available; memory after boot. *No Safari available on the dev machine.*

**Exit criteria:**
- Pyodide boots offline from a single file in at least Chrome and Firefox.
- Kill & re-seed works.
- A written finding on how strong network blocking can be. This is the input for the
  security wording in the UI.
- Size and boot-time numbers are recorded in DESIGN.md §8, replacing the estimate.

**Result (2026-10-05): all four met, Phase 0 closed.** Pyodide 0.29.5 boots offline
from one file in a classic Blob worker in Chromium and Firefox; kill & re-seed takes
0.8 s; network blocking: 17 known paths blocked, no guarantee; the numbers are in
DESIGN §8. Details: [PHASE0_FINDINGS.md](PHASE0_FINDINGS.md).

---

## Phase 1 — MVP

Scaffold the folder per §11 (`src/`, `build.py`, `tests/`, `dist/`), then:

- [x] **Settings & connection:** base URL, model, API key (memory only), Test
      Connection. Copied from HermitUI and listed in AGENTS.md.
- [x] **Agent loop:** code-as-action parsing, observation envelope, truncation, step
      limit, per-step timeout, final answer and `ask:` handling (§5).
- [x] **Worker runner:** persistent namespace, stdout/stderr capture, workspace
      diffing (§4.2).
- [x] **Step timeline:** reasoning (think blocks), code, output, effect, verdict
      (§2.1).
- [x] **Workspace panel:** tree, highlights, viewer, upload (files and folders),
      download.
- [x] **Effect-based gating:** file origins, classification table, approve / edit /
      reject, rollback plus interpreter restart on reject (§2.3).
- [x] **Autonomy levels:** approve-each / risk-based (default) / autopilot. Stop and
      Kill.
- [x] **Checkpoints & rewind:** content-addressed store, rewind to step N (§2.4).
- [x] **Session export/import:** zip writer and reader, full and workspace-only
      export, import validation, paused restore, confirm-replace (§3).
- [x] **Tests:** unit tests (parsers, classifier, zip round-trip, session schema)
      and one e2e test that scripts a short session against a mock OpenAI endpoint,
      then does export → reload → import.
- [x] `dist/hermit-agent-standalone.html` builds and is committed.

**Exit criteria:**
- A real model on an external endpoint completes three reference tasks, one each for
  data processing, code plus tests, and calculation, under risk-based supervision.
- A rejected delete is rolled back correctly.
- Export → import round-trips a session including checkpoints.
- All tests are green.

**Result (2026-10-03): all four met.**
- `tests/e2e_reference.py` against Qwen3.8-27B (IQ4_XS, llama.cpp, reasoning effort
  Low), risk-based, in the built file in headless Chromium, passed all three tasks:
  data processing (3 steps, 14 s), code plus tests (4 steps, 42 s; 11 unittest
  tests run in-process), and calculation (2 steps, 5 s; 142913828922). No step
  needed approval: none touched a user file.
- `tests/e2e_agent.py` (mock endpoint) runs in Chromium 149 and Playwright's
  Firefox 151, and in stock Firefox 157 without the download-based parts, which
  Playwright can't capture over BiDi. It covers: a rejected delete of a user file
  rolled back with the interpreter restarted; timeout; Kill; edit-before-run;
  guidance; reject-before-run; 17 known network paths, all blocked (no guarantee
  there is no other, DESIGN §10); the file viewer; the workspace zip; export (valid
  for Python's `zipfile`, no API key inside) → fresh page → import (timeline and
  workspace identical) → follow-up → rewind to a step and to the start (worker
  re-seeded, variables gone); and confirm-before-replace on import.
- `node tests/run.mjs`: 135 assertions over reply parsing, observations, diffing,
  risk classification, zip and session archive (tampering included).

What the MVP does *not* have yet is listed in Phase 2. Mobile gets no pass beyond flex
wrapping; it moved to a later phase (see the end).
Decisions taken without the owner are in [REVIEW_NOTES.md](REVIEW_NOTES.md).

---

## Phase 2 — Polish

Phase 2 is split. 2a makes long tasks reliable and measurable; 2b adds richer output
and only starts once 2a's exit criterion is met. Open items are listed in the order
they should be built.

### Phase 2a — Reliability

- [x] **File actions** (DESIGN §5.1): `<read_file>`, `<write_file>`, `<edit_file>`.
      They run on the main thread, are gated before they apply, and are exclusive with
      a python block. Covered by `tests/files.test.mjs` and the e2e `files_scenario`.
- [x] **Per-file text diffs** (line diff) for changed files (DESIGN §2.1): a modified
      file's chip counts its changed lines and opens a unified diff, with tabs for both
      versions; an edited step shows the diff of your edit. Covered by
      `tests/reliability.test.mjs` (Myers, fuzzed against an LCS) and the e2e
      `diff_edit_scenario`.
- [x] **Elision of old observations** (§5.4): long outputs and written file contents of
      older steps are shortened in what is sent, in blocks of 4 steps so the server's
      prompt cache stays valid; the history keeps everything. Covered by
      `tests/reliability.test.mjs` and the e2e `elide_scenario`.
- [x] **Auto-compaction** (§5.4): older steps are summarised at a configurable share
      of the context (default 85 %), and once more on a context-overflow error. Rewind and
      export work across compactions. It keeps room for a full reply, tells a reply
      the context cut short from one `max_tokens` ended (llama.cpp reports both as
      "length") and compacts after it, reads the context size from llama.cpp, Ollama,
      vLLM and LM Studio, and has a 🗜️ Compact button. Covered by `tests/agent.test.mjs`,
      `tests/archive.test.mjs` and the e2e `compaction_scenario` / `vllm_compact_scenario`.
- [x] **Checkpoint memory budget** (§2.4): the oldest checkpoints are dropped once older
      file versions pass 512 MB; the status bar shows what is held. Covered by
      `tests/agent.test.mjs`, `tests/archive.test.mjs` and the e2e
      `checkpoint_budget_scenario`.
- [x] **Success measurement** (pulled forward from Phase 4): 10 to 20 tasks, building
      on the three in `tests/e2e_reference.py`, several runs each against a real model,
      reported as one pass rate. *Result (2026-10-05, Qwen3.8-27B IQ4_XS on llama.cpp,
      reasoning effort Low, risk-based): 15 tasks × 3 runs, **44/45 = 98 %** (13 min).
      The one failure is the known int32 overflow in the calculation task (the answer
      was the true sum mod 2³²). The first measurement scored 41/45 = 91 %: three of
      its four failures were replies that wrapped code in `<python>` tags, which then
      counted as final answers; those run as code now (DESIGN §5.1), and a later run
      surfaced a made-up `<observation>` reply, which now runs nothing and gets advice.
      Every run of the two tasks that change uploaded files was held for approval.*
- [x] **Retry and resume on endpoint errors** (DESIGN §5.5): network errors, 408/429/5xx
      and dropped or stalled streams are retried for up to 2 minutes (the card says so,
      the status bar counts down, Stop ends the wait); then the run pauses, resumable
      with Retry or Continue, with nothing lost. Agent wording in `chatErrorHint` for an
      endpoint down mid-task and for an overflow compaction can't fix. Covered by
      `tests/reliability.test.mjs` and the e2e `outage_scenario` (the mock refuses,
      503s, drops and stalls on cue).
- [x] **Data-loss warning on close** (the session lives only in the tab), plus a "not
      exported" hint while there are changes since the last export (DESIGN §3): the
      close warning fires only for unexported work; a status-bar flag and a dot on
      💾 Export. Covered by the e2e `module_scenario` (`beforeunload`) and `risk_scenario`.
- [x] **Configurable step limit, with a "run N more steps" button**: Settings → Step
      limit (default 20), and the limit note's *Run [N] more steps* field (default 10,
      remembered). Covered by the e2e `step_limit_scenario`.
- [x] **Context indicator, effort switch, visible cut-off state**: a status-bar gauge of
      the next request against the context, with a tick where auto-compaction starts;
      the toolbar's Reasoning select; ✂️ "cut off" on the step card.
- [x] **Warning on large uploads**: 50 MB at once, a 25 MB file or 500 files ask
      first, before anything is read. Covered by `uploadWarning` tests and the e2e
      `upload_scenario`.
- [x] **Where content goes:** a 🏠 *local* badge for local and LAN endpoints, the ☁️
      "sent to …" note for the rest.
- [x] **Packages** (DESIGN §8): the system prompt lists all ~300 loadable packages;
      packages load in their own phase before the step (status bar, debug log, a note
      on the step, their own time limit); a failed load runs nothing and says why
      (offline, CDN unreachable, redirected); `ModuleNotFoundError` gets a no-pip note.
      **Offline decided: no offline pack for now**, revisit with Phase 4. Covered by
      `tests/reliability.test.mjs` and the e2e `packages_scenario` (a real load of
      `six` from the CDN, and an offline one).
- [x] **Inject guidance mid-task; edit-before-run polish**: a note is shown as queued
      until it goes out, and ⚡ Send now restarts a model reply in flight with it; the
      code editor indents with Tab, runs with Ctrl+Enter, has ↺ Reset, and the card
      shows the diff of your edit. Covered by the e2e `send_now_scenario` and
      `diff_edit_scenario`.
- [x] **Open carry-overs:**
      - `sys.modules` cleanup: the e2e `module_scenario` edits a module with
        `edit_file`, and rewrites another from Python, and imports each again.
      - A gating test with a real model on a user file: two tasks of the success
        measurement change uploaded files, and must be held for it.
      - Upload in the e2e test: the folder input and a (synthetic) drop are covered, and
        the folder walk of a dropped folder is unit-tested with fake entries. A real OS
        drag of a folder stays a manual test.

**Exit criterion:** a 20+ step task survives an endpoint outage and a compaction, and
passes in 4 of 5 runs.

**Result (2026-10-05): met, 5 of 5.** `tests/e2e_longrun.py` against Qwen3.8-27B
(IQ4_XS, llama.cpp, reasoning effort Low), risk-based, in the built file in headless
Chromium: a 22-question treasure hunt where each answer reveals the next question.
Every run solved all 22 questions in 27–33 steps, with 1–4 compactions (Context size
8,000), and went through the same staged faults on a proxy between the app and the
server: all connections refused for 25 s (ridden out by the app's retries; the step
card notes it), a reply cut mid-stream (retried, the half reply discarded), and a
150 s outage, longer than the 2-minute retry window, which paused the run; Retry
resumed it with no step lost or repeated. 234–308 s per run, including the outages.
A first attempt with Context size 12,000 never compacted (hunt steps are short), so
the setting was lowered; that attempt's run otherwise passed the same way.

### Phase 2b — Rich output

- [ ] matplotlib capture (Agg plus a patched `show()`) with inline figures (§8).
- [ ] Image previews.
- [ ] A binary summary.
- [ ] A periodic file listing in the context (§5.4).

**Exit criteria:** set before 2b starts.

---

## Phase 3 — Native tool calls

- [ ] `run_python` / `ask_user` / `finish` as OpenAI `tools` (§5.6). `read_file`,
      `write_file` and `edit_file` already have their argument shapes and a
      protocol-independent executor; they only need the tool-call parsing.
- [ ] Capability detection with code-as-action as the fallback.
- [ ] The same timeline, gating and export; only the parsing changes.

**Exit criteria:** both modes pass the Phase 1 reference tasks on an endpoint that
supports tools.

---

## Phase 4 — In-browser models (wllama)

- [ ] Bring over HermitUI's wllama loading (local file / URL into an in-memory Blob,
      Memory64, WebGPU), inside marker blocks for a separate output.
- [ ] Agent prompt tuning for small models. Run the Phase 2a success measurement per
      model, the same way HermitUI's `benchmark/` harness measures speed.
- [ ] Document the realistic model floor in the README.

**Exit criteria:** at least one in-browser model completes the reference tasks fully
offline on the dev machine's GPU.

---

## Phase 5 — Merge decision

Evaluate per DESIGN.md §11: a build flavor in HermitUI, an agent mode in the main app,
or staying separate. Consider how much shared code has diverged, the size cost to the
main app, and user feedback. Record the decision and its reasoning here.

---

## Later phase — Mobile (not planned yet)

- Mobile layout: the workspace drawer, touch-friendly approvals. Until then the layout
  only has to not break at phone width (flex wrapping).
