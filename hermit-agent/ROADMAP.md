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
      Connection. Copied from HermitUI and listed in §9.
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
Open decisions are in [REVIEW_NOTES.md](REVIEW_NOTES.md).

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

- [x] matplotlib capture (Agg plus a patched `show()`) with inline figures (§8).
- [x] Image previews.
- [x] A binary summary.
- [x] A periodic file listing in the context (§5.4).

**Exit criteria** (set on 2026-10-05, before 2b started):
- Every item is covered: pure logic by unit tests, the worker and the DOM by an e2e
  scenario against the mock, green in Chromium and Playwright's Firefox; the existing
  suites stay green.
- The success measurement grows by three Phase 2b tasks: a chart the prompt asks to
  *show* (no file name, so it must be captured from `plt.show()` or the end of the
  step), an image made with Pillow, and a question about an uploaded binary file. The
  18-task suite passes **≥ 90 %** over 3 runs against a real model (Phase 2a: 98 % on
  15), and in every run of the shown-chart task the figure is captured: a PNG under
  `figures/` that its step card shows inline.

**Result (2026-10-05): met.** Unit tests (5 files, `tests/richoutput.test.mjs` new) and
`tests/e2e_agent.py` (418/418 checks in Chromium and Playwright's Firefox, with the new
figures scenario) are green. The success measurement against Qwen3.8-27B (IQ4_XS,
llama.cpp, reasoning effort Low), risk-based, 18 tasks × 3 runs: **53/54 = 98 %** (16
min); the shown chart was captured as `figures/step-N-1.png` and shown inline in 3 of 3
runs, and the Pillow and binary-file tasks passed 3/3. The one failure is the known
int32 overflow in the calculation task. A first, partial measurement (16/18 in its
first run) surfaced a `<run_python>` reply that ended a task as a "final answer"; such
guessed tool tags now run nothing and get advice (DESIGN §5.1), and the result above is
for the build with that fix.

---

## Phase 3 — Native tool calls

- [x] `run_python` / `ask_user` / `finish` as OpenAI `tools` (§5.6), next to `read_file`,
      `write_file` and `edit_file`. Streamed tool-call deltas are assembled; one reply is
      one step (the first action call decides, the other calls are told why they didn't
      run). Covered by `tests/tools.test.mjs` and the e2e `native_scenario`.
- [x] Capability detection with code-as-action as the fallback: Settings → Actions
      (Auto / Native / Code blocks and tags); Auto reads llama.cpp `/props`, Ollama
      `/api/show` and model lists; a server that refuses `tools` switches to
      code-as-action, and the history converts. Covered by the e2e
      `native_fallback_scenario` (a refusal, and a switch mid-session).
- [x] The same timeline, gating and export; only the parsing changes. Native steps run
      through the same executors and gates; session format 2 stores the tool messages.

**Exit criteria:** both modes pass the Phase 1 reference tasks on an endpoint that
supports tools.

**Result (2026-10-05): met.** Qwen3.8-27B (IQ4_XS, llama.cpp b10678, `/props` reports
`supports_tool_calls`), reasoning effort Low, risk-based, the built file in headless
Chromium, `tests/e2e_reference.py --only "data processing,code + tests,calculation"`:
- **Native tool calls** (`--tool-mode native`, every step a tool call): **9/9**, data
  processing, code plus tests, and calculation 3/3 each (6 min).
- **Code blocks and tags** (`--tool-mode text`): 14/18 over two runs of 3. Code plus
  tests 6/6; data processing 5/6, where the model once named the column `amount` instead of
  the requested `total` (and said in its answer that it was `total`); calculation 3/6,
  each failure the known int32 overflow (the answer was the true sum mod 2³², as in
  Phases 2a and 2b). The code-as-action system prompt is byte-identical to the Phase 2b
  one, so these are the model's misses, not a change in that mode.
- `tests/e2e_agent.py` (mock): all checks green in Chromium and Playwright's Firefox,
  with the two new scenarios; `node tests/run.mjs`: 6 files green.

---

## Phase 3.5 — Common pure-Python libraries

The libraries most people and models reach for (openpyxl, XlsxWriter, python-docx,
python-pptx, fpdf2, pypdf, reportlab, Markdown, tabulate) aren't in the Pyodide
distribution. They aren't missing: the distribution mostly carries packages that have to
be compiled for WebAssembly, and Pyodide expects pure-Python ones to be installed from
PyPI with micropip at run time. Agent code can't download (no network), so today they
can't be used, and the system prompt points to what the distribution has instead
(pymupdf, matplotlib): a stopgap, not the best fit.

**Decided (2026-10-05): bundle them.** Pinned wheels are inlined in the HTML at build
time, sha256-checked like the Pyodide core, and installed from memory on first import.
This works offline and leaves the network guard as it is. Not taken: installing from PyPI
in the load phase (smaller file, but needs a connection and widens the network guard
and the CSP, DESIGN §10).

- [x] **Study: which libraries warrant bundling** ([PHASE3_5_LIBRARY_STUDY.md](PHASE3_5_LIBRARY_STUDY.md)).
      33 candidates: size, license, popularity; all 32 bundleable ones work in the app's
      interpreter (seven need Pyodide packages their metadata doesn't declare); Qwen3.8
      on 18 format tasks without a library hint. Recommendation, Tier 1 (1.33 MB):
      openpyxl, XlsxWriter, python-docx, python-pptx, Markdown, qrcode; Tier 2 optional
      (0.35 MB): tabulate, xmltodict, markdownify, seaborn; no extra PDF library.
      **The owner picked Tier 1 and Tier 2** (2026-10-06).
- [x] Bundle the chosen wheels: `build.py` downloads them pinned by sha256, checks them
      against their own metadata and inlines them; the harness installs one into memory
      when a step's imports (or pandas calls that need it, such as `to_excel`) call for it,
      in the same loading phase as Pyodide packages, together with the Pyodide packages
      it imports; the import index and the package list in the system prompt include
      them (DESIGN §8).
- [x] Rewrite the system prompt's library guidance to suggest the bundled libraries for
      the matching tasks.
- [x] Tests: unit (`tests/bundled.test.mjs`: manifest, load plan, notes, hints, prompt),
      e2e (`bundled`: each library works; the five without Pyodide packages with no
      network at all, and again after a restart; PyPI never asked), and five
      success-measurement tasks for the new formats (Excel, Word, PowerPoint, Markdown →
      HTML, QR).

**Exit criteria** (proposed by the study, confirmed with the pick):
- Each bundled library imports and works **offline** in Chromium and Firefox (e2e),
  together with the Pyodide packages it needs, and the file grows by no more than the
  chosen set's size.
- The success measurement grows by one task per bundled format (Excel, Word, PowerPoint,
  Markdown → HTML, QR), each checking the produced file with the library itself, and the
  suite passes **≥ 90 %** over 3 runs against a real model, in both protocols.

**Result (2026-10-06): met.** v0.3.0.
- **Offline, both engines:** `tests/e2e_agent.py` 546/546 checks in Chromium and
  Playwright's Firefox, with the new `bundled` scenario. openpyxl, XlsxWriter, Markdown,
  tabulate and xmltodict work with every request that leaves the machine refused (and
  again after an interpreter restart); python-docx, python-pptx, qrcode, markdownify and
  seaborn work with their Pyodide packages from the CDN; PyPI is never asked. The
  libraries that import Pyodide packages need those from the CDN (DESIGN §8).
- **Size:** 9.04 → 11.31 MB, +2.27 MB: the 1.69 MB of wheels base64-encoded, the study's
  estimate for both tiers (1.8 + 0.47 MB).
- **Success measurement**, Qwen3.8-27B (IQ4_XS, llama.cpp), reasoning effort Low,
  risk-based, 24 tasks (19 + Excel, Word, PowerPoint, Markdown → HTML, QR) × 3 runs:
  - **Code blocks and tags: 71/72 = 99 %** (15 min); the miss is the known int32
    overflow in the calculation task.
  - **Native tool calls: 72/72.** The first run measured 68/72, but two of its misses
    were a bug in the suite: the Excel task's new `orders.csv` fixture shadowed the
    SQLite task's, which then had no customer column (the model said so, 0/3). The
    other was a PowerPoint check that only accepted `2026-01`-style labels and failed a
    correct chart labelled "Jan 2026" (2/3). Both are fixed. The 22 unaffected tasks
    passed 66/66 in that run, and the SQLite and PowerPoint tasks passed 6/6 when re-run.
  - Every run of the five new tasks used the bundled library (`library_used`). They took
    9–18 s on average, against 58 s (Excel), 85 s (Word) and 239 s (PowerPoint) built by
    hand in the study.
- The system prompt also gained a line about `AGENTS.md` in the workspace (DESIGN §5.3)
  after the native run; the text run includes it.
- **Added afterwards (2026-10-06): odfpy**, for OpenDocument `.odt`/`.ods`/`.odp` and
  pandas' `.ods` engine. The study had counted its 0.7 MB source archive; the library is
  ~0.13 MB with defusedxml. PyPI has no wheel, so `build.py` builds a reproducible one
  from the pinned archive (DESIGN §8). The file grows 11.31 → 11.42 MB (gzipping all
  inlined wheels, needed for the built one, takes back ~60 KB). One more success task:
  an `.ods` of region totals, checked with pandas' ODF reader, Qwen3.8 as above: native 3/3
  (4 steps, 11–14 s), text 2/3. The text miss used odfpy directly, guessed its attribute
  names, then wrote a call in another format (a `<function_calls>` block) that was taken
  as the final answer, so no file. Before the prompt named `df.to_excel("x.ods")`, native
  also passed 3/3 but took 5–12 steps: the model tried `to_ods`, `read_ods` and odfpy
  attribute names. The quick selection passed 5/5 in both protocols.

---

## Phase 3.6 — More file tools

Picked by the owner on 2026-10-06 from a comparison with other agent harnesses (Claude
Code, Codex CLI, Gemini CLI, Cline, OpenHands, SWE-agent, smolagents, Aider). Nearly all
of them ship a read-only search, and most a delete or move of their own; hermit-agent
had only Python for these. A native tool is gated before it applies (its effect is known
in advance), needs no worker round trip, and has a fixed output shape, and small models
(Phase 4) do better with a focused tool than with `os.walk` loops. Every tool exists in
both protocols, so each one costs a schema, a tag, its parser, tests and prompt text.

- [x] **`search_files`** (DESIGN §5.1): grep and glob in one read-only file action,
      `path:line: text` capped at 100 matches, a file listing without a pattern. Never
      gated.
- [x] **Syntax check on write/edit** (DESIGN §5.1): a `.py` file written or edited by a
      file action is compiled in the worker after the commit; a syntax error comes back
      as a note on that step. Reported, not refused.
- [x] **`delete_file` / `move_file`** (DESIGN §5.1, §2.3): files and folders, binary
      included, gated before they apply. A moved user file is named as a move and keeps
      its origin.
- [x] **`ask_user` with options** (DESIGN §5.1, §5.6): up to 6 choices, shown as
      buttons; `- ` lines after an `ask:` in code-as-action.
- [x] Tests: unit (`tests/filetools.test.mjs`), e2e (`filetools`, `native_filetools`),
      two success-measurement tasks (a rename across a project, tidying up your files).

**Exit criteria** (proposed with the build):
- Pure logic covered by unit tests; each item covered by an e2e scenario against the
  mock, green in Chromium and Playwright's Firefox; the existing suites stay green.
- The success measurement grows by two tasks (*rename across a project*, *tidy up your
  files*; both change your files, so both must be held), and the 27-task suite passes
  **≥ 90 %** over 3 runs against a real model, in both protocols. Which file tools the
  agent used is recorded (`tools_used`), not required.

**Result (2026-10-06): met.** v0.3.1.
- Unit tests (8 files, `tests/filetools.test.mjs` new) and `tests/e2e_agent.py` (624/624
  checks in Chromium and Playwright's Firefox, with the two new scenarios) are green.
- **Success measurement**, Qwen3.8-27B (IQ4_XS, llama.cpp), reasoning effort Low,
  risk-based, 27 tasks × 3 runs, the built file frozen for the run:
  - **Code blocks and tags: 79/81 = 98 %** (21 min). Misses: the known int32 overflow in
    the calculation task, and a PDF task that ended on a `<run python>` reply (with a
    space), which counted as the final answer. Such spellings now run nothing and get
    advice, like `<run_python>` since Phase 2b (DESIGN §5.1). The quick selection on the
    build with that fix passed 5/5.
  - **Native tool calls: 79/81 = 98 %** (26 min). Both misses are the model's, in tasks
    without the new tools: a wrong average in the log analysis, and pandas' `row.item`
    (a method) used as a column in the Word report.
  - The two new tasks passed **6/6 in each protocol**, and every run was held for
    approval with the right reasons ("moves your file jan.csv to data/jan.csv", "deletes
    your file draft.tmp", "overwrites your file money.py"). Tidying up used `move_file`
    and `delete_file` in 6 of 6 runs; the rename used `search_files` in 3 of 3 native
    runs and 1 of 3 text runs (the other two searched with Python). Nothing in the
    prompt or the tasks asked for the tools.

---

## Phase 3.7 — A plan the user can see (`update_plan`)

Next after 3.6, by the owner's call. The idea, from Codex CLI's `update_plan`, Claude
Code's TodoWrite and Manus's `todo.md`: the agent keeps a short list of steps with a
status each, the UI pins it above the timeline, and it is sent again after every
compaction, so a long task keeps its direction when the details are summarised away. For a
supervised agent the plan is the part the user most wants to see: where it is going, not
only what it just did.

The five open questions were answered while building it (DESIGN §5.7; the alternatives
are in [REVIEW_NOTES.md](REVIEW_NOTES.md)):
- **Ends the step or rides along?** Rides along with any reply; a reply with only a plan
  is a step of kind `plan` that runs nothing else. "One reply = one step" holds.
- **Can the user edit it?** No: a note changes the agent's course, and the agent updates
  the plan.
- **Required?** Encouraged by the prompt for tasks of more than three or four steps,
  with one reminder at step 2 when no plan has been sent yet (added after native runs
  sent none).
- **Compaction, rewind, export, import?** Stored on the step that sent it, the current
  plan derived from the timeline; compaction appends it to the compacted task message;
  no new session format.
- **Small models?** Left to Phase 4; the success measurement records the plans sent. Phase 4's floor run: small models rarely plan with native tool calls, and their text-mode plans go stale.

- [x] `update_plan` in both protocols (DESIGN §5.7): an `<update_plan>` checklist in
      code-as-action, a native tool with `{ step, status }` items, set aside before "the
      first action call decides", so it never makes another call skip.
- [x] The pinned 📋 panel, the plan on each step card that sent one, the streaming
      preview, the transcript.
- [x] The plan through compaction, rewind and export/import.
- [x] System prompt lines in both protocols.
- [x] One reminder at step 2 when no plan has been sent (`planReminder`).
- [x] Tests: unit (`tests/plan.test.mjs`), e2e (`plan`, both protocols), and the success
      measurement records each run's plans (`plans`).

**Exit criteria** (proposed with the build):
- Pure logic covered by unit tests; the e2e `plan` scenario green in Chromium and
  Playwright's Firefox; the existing suites stay green.
- The 27-task suite passes **≥ 90 %** over 3 runs against a real model, in both
  protocols (the prompt grew in both).
- The model uses it: a plan in **at least half** of the runs that take more than 4 steps,
  in both protocols (recorded in `plans`).

**Result** (2026-10-24, Qwen3.8-27B IQ3_S on llama.cpp, one slot):
- The suite passed **80/81 (99 %)** in code-as-action and **78/81 (96 %)** natively, both
  without the reminder. ✅
- Plans: code-as-action kept one in **15 of 23** runs of more than 4 steps ✅. Natively
  the model sent **none in 81 runs** ❌. It reads the files first and never comes back to
  the prompt's request. The step-2 reminder raised that to 3 of 8 longer runs (16/16
  passed on the 8 longest tasks × 2), still under half; on the full suite with the final
  build it was 1 of 17. **The criterion is missed for native tool calls.**
- The final build (with the reminder) passed the full suite natively **80/81 (99 %)** in
  39 min; the miss is the known `amount`/`total` flake of "data processing". The quick
  selection passed 5/5 natively and 4/5 in code-as-action (the same flake; that task
  then passed 3/3).
- On a long multi-file task (a small library-loans app, now `tests/e2e_app.py`, 20k
  context): natively, over 8 runs per side, the plan build passed 7/8 and kept a plan in
  7, at 14.9 steps, 5.0 min and 130k prompt tokens on average, against 7/8, 16.5 steps,
  5.5 min and 136k for v0.3.11. The first 3 runs per side had shown a larger gap (14.7
  vs 17.7 steps); the next 5 shrank it (15.0 vs 15.8). In code-as-action (3 runs per
  side, all passing, plans in 3 of 3) it was 10.0 steps and 2.3 min against 9.7 and 3.7.
  So: no harm, maybe a small saving, nothing to claim.
- Compaction: the plan goes back to the model after each summary, so it might keep a
  compacted run on track. At a 15k context, code-as-action, 3 runs per side, all passed
  either way: 12.3 steps, 3.8 min and 7 compactions with the plan (kept in 3 of 3)
  against 11.7 steps, 3.2 min and 6 compactions for v0.3.11. No benefit shows at this
  size; it isn't a reason to have the plan.
- The plan gives no gain in success rate. Its value is visibility. The model updates it
  coarsely, and natively each update costs a turn, since the model makes one call per
  reply and doesn't send a plan alongside an action.
- Seen along the way: on this model code-as-action beat native on speed. The suite took
  35 vs 45 min, at 6.5 vs 9.2 s and 227 vs 295 output tokens per step. The causes are
  JSON escaping, one call per reply (code-as-action wrote 7 files in one reply, native
  one per reply) and per-turn overhead.

---

## After 3.7 — ideas from pi, opencode and Claude Code (2026-10-24)

A second comparison, with pi (a minimal four-tool harness), opencode and Claude Code's
public docs. Each is a small patch release of its own.
- [x] **The loop guard** (opencode's `doom_loop`; DESIGN §5.8, v0.3.14): the third
      identical action in a row isn't run, a fourth pauses the run.
- [x] **Compaction with a focus** (Claude Code's `/compact <focus>`; v0.3.15): what the
      summary should keep, typed when compacting by hand.
- [x] **A compaction thrash guard** (Claude Code stops auto-compacting when the context
      refills right after each summary; DESIGN §5.4, v0.3.16): pause instead of compacting
      every step.
- [x] **Rewind to the start gives the task back** (opencode's `/undo`; v0.3.17): the
      task text goes back into the composer, to be rephrased.
- [x] **Plan first** (opencode's Plan agent, Claude Code's plan mode; DESIGN §2.3,
      v0.3.18): an autonomy level where the agent may only read, search and send a plan
      until the user approves it.
- **Not taken, for now:** branches instead of a cut on rewind (pi's session tree, Claude
  Code's fork: a timeline and session-format change, worth it only if rewinding gets
  used a lot); a smaller prompt for small models (pi keeps its prompt and tools under
  1,000 tokens; measured in Phase 4: ours is 2,900 to 4,000, and the package list is the
  first thing to shorten); `apply_patch` (only if gpt-oss becomes the
  Phase 4 model, since it is trained on that format); several questions in one
  `ask_user` (opencode's `question`: little gain). pi argues against built-in to-do lists
  ("more state the model must track"); the Phase 3.7 runs found a plan does no harm.
- **Measured, not taken: asking native mode to batch file writes** (2026-10-24). One
  prompt line asked the model to write or edit several files in one reply instead of one
  per reply, the main reason native needed more steps than code-as-action on the app
  task. It did batch (four files in its first reply), but the app task got worse: 2/5
  passed, at 18.0 steps, 5.9 min, 171k prompt tokens and 9 compactions in 5 runs,
  against 7/8, 14.9 steps, 5.0 min and 130k without it. The bigger replies filled the
  20k context sooner, and the time saved writing went into debugging. The quick
  selection still passed 5/5.

---

## Later — more tool ideas (not planned yet)

From the same comparison; none is scheduled.
- **`view_image`**, only when the endpoint has vision: copy HermitUI's vision detection
  back in (dropped from `testConnection`), and send the image as an `image_url` part in
  a follow-up `user` message (tool messages with images aren't portable). The agent
  could then check its own charts; today it is told only their size.
- **`insert` at a line and a per-file undo** (OpenHands' `str_replace_editor`): low
  value while `edit_file` and rewind exist.
- **Not planned, and why:**
  - *`web_fetch` / `web_search`*: against the network guard, and CORS blocks most sites
    from a browser anyway. If it ever comes: main thread only, every URL approved, since
    a URL can carry workspace data out.
  - *Shell / background processes*: Pyodide has no subprocesses; `run_python` is the
    shell.
  - *Subagents*: context isolation would help small models, but at a large cost in
    complexity. Revisit after Phase 4. The cheap half of it is built: `ask_llm`
    (v0.3.29, DESIGN §5.9) sends one request with files attached to a fresh instance of
    the model, without tools, and only the answer comes back. First check (2026-10-30,
    Qwen3.8-27B IQ3_S, 37k context, an ad hoc probe outside the suite, 2 runs per
    protocol): on its own the agent never used it, neither to translate a short German
    note nor to find three decisions in a 48 KB report; it translated itself and searched
    with Python, and all 8 runs passed. Asked to use it, it did in both protocols, and
    all 4 runs passed. Open: tasks where it pays off without being asked (a document
    larger than the context, a small model).
  - *A persistent memory tool*: against ephemerality; within a session, `AGENTS.md`
    and a plan cover it.
  - *An MCP client*: possible over Streamable HTTP, but it widens the sandbox
    considerably.
  - *A `think` tool*: redundant with reasoning models.

---

## Phase 4 — In-browser models (wllama)

**Before the port** (prepared 2026-10-24, measured 2026-10-25):
- [x] **Measure the floor first, without wllama.** Run the small GGUFs HermitUI's
      benchmark already caches (Qwen3-4B, Qwen3.5-4B, Qwen3-8B, all Q4_K_M) on a native
      llama.cpp server (the CUDA build `hermit-cleaner/bench` pins), through the
      existing endpoint path: `e2e_reference.py --quick` in both protocols, then the full
      suite and `e2e_app.py` for any model that passes the quick run. That says whether a
      model this size can drive the agent at all, before any porting; wllama only adds
      speed limits on top (HermitUI's benchmark has those numbers).
- [x] The same runs answer **Auto's protocol choice**: on Qwen3.8-27B code-as-action was
      faster and as accurate as native tool calls (Phase 3.7 Result); if a second model
      agrees, Auto should prefer code-as-action.
- [x] Record whether small models send a plan (`plans`) and how often the loop guard
      fires (`repeat` steps), and how big the prompt is in tokens: pi keeps its system
      prompt and tools under 1,000; ours is several times that.

**Floor result** (2026-10-25, v0.3.19 build; llama.cpp b11531 CUDA on the dev machine's
RTX 5070 Ti, 32k context, one slot, Q4_K_M; two runs per protocol of the full suite for
Qwen3.5-4B and Qwen3-8B, one for Qwen3-4B; between two runs a model moved by up to 6 tasks
in text mode and 3 in native mode). Qwen3-4B's second and third quick runs and its full and
app runs come from a chain meant for the other two models that reached a leftover Qwen3-4B
server instead; they are Qwen3-4B runs and counted as such:

| Model | Quick (native / text) | Full suite, native | Full suite, text | App task (both) |
|---|---|---|---|---|
| Qwen3-4B | 3/5, 3/5, 5/5 / 2/5, 3/5, 2/5 | 16/27, 1.3 min per task | 12/27 | 0/4 |
| Qwen3.5-4B | 5/5 / 4/5 | **21 + 21 of 54, 0.3 min** | 10 + 16 of 54 | 0/4 |
| Qwen3-8B | 3/5 / 4/5 | 20 + 17 of 54, 1.3 min | 19 + 17 of 54 | 0/4 |
| Qwen3.8-27B (3.7 Result) | 5/5 / 4/5 | 80/81 (3 runs) | – | 7/8 (native) |

- **A 4B model can drive the agent on short tasks, not on long ones.** Qwen3.5-4B with
  native tool calls passes most of the suite and is the fastest model here (it writes
  short answers). No small model built the app: most runs hit the 20-step limit or paused
  on the loop guard (Qwen3-8B also needed a compaction there), and Qwen3-4B's text runs
  stopped after 2 or 3 steps with a broken app. `code + tests` failed in every native run
  of every model; Qwen3-4B and Qwen3-8B also miss `data processing` most of the time.
- **Auto's protocol choice: native tool calls on small models.** Text was the weaker
  protocol on both 4B models (Qwen3-4B 12 against 16 of 27, Qwen3.5-4B 26 against 42 of 54)
  and level on 8B (36 against 37 of 54).
  The 27B result doesn't carry over, so Auto keeps preferring native tool calls when the
  template supports them.
- **Plans:** with native tool calls the small models almost never call `update_plan` (0 to
  1 of 27 runs). In text mode Qwen3-4B and Qwen3-8B send one in 16 to 18 of 27 (Qwen3.5-4B in 1 or 2), but it
  stays at step 1 or 2 (`plan 1/3 → 1/3 → 1/3`), so the panel shows a stale plan.
- **Loop guard:** blocked 5 to 11 repeats per text run on the 4B models and a few in the
  app task. Not caught: a failing `edit_file` resent with small changes each time
  (Qwen3-4B, 20 steps of "action 2 failed" on the Excel task). A guard on the same
  error repeating would stop those runs about 15 steps earlier. **Added in v0.3.21**
  (the error-repeat guard, DESIGN §5.8): advice at the third failure in a row with the
  same error, a pause at the fifth, so that run would have paused at step 5. Checked on
  Qwen3.8-27B with the quick selection, 4/5 in each protocol (the miss: the known
  `amount`/`total` flake); the guard didn't fire there. Not yet measured on a small model.
- **Prompt size** (Qwen3-8B tokenizer): text prompt 2,907 tokens; native prompt 2,491 plus
  1,150 for the ten tool schemas, 3,997 for the first request with the template. The
  313-name package sentence is about 1,050 of that (a Qwen3.8 count from 2026-10-07). For
  small models that sentence is the first thing to shorten.

**Then the port:**
- [ ] Native tool calls as the default for the in-browser engine where the model's template
      supports them, code-as-action as the fallback (floor result above; the earlier plan
      was code-as-action, from the 27B result).
- [ ] Keep the prompt prefix byte-identical between steps (already true for the server's
      cache) so wllama can reuse its KV cache: prompt processing is its bottleneck
      (HermitUI measured ~40 s to the first token for Gemma-4 E2B on CPU).
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
