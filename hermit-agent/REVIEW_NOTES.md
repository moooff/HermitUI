# Decisions to review (Phase 1 MVP build, Phases 2a, 2b, 3, 3.5, 3.6 and 3.7, prompt review)

Open decisions from the MVP (2026-10-03), Phases 2a and 2b (2026-10-05), Phase 3
(2026-10-05), Phase 3.5 and Phase 3.6 (2026-10-06), Phase 3.7 (2026-10-23), waiting for the owner's call. Each entry says what was decided, why, and
what the alternative is. When you confirm or reverse one, delete it
here; if you reverse it, update DESIGN.md too. The ⭐ entries are the ones most worth a
look.

## Process

- **Phase 0 network blocking was answered by the MVP's own tests** instead of a
  separate spike (DESIGN §10, "As built and measured"). `crossOriginIsolated` on
  GitHub Pages was checked on 2026-10-05 (false), which closed Phase 0.

## Packaging

- ⭐ **Pyodide 0.29.5 (Python 3.13), not 314 (Python 3.14).** 314 refuses classic
  workers, and Chromium won't start a Blob module worker on `file://`. Pinned by
  sha256 in `build.py`. When 0.29.x stops getting releases, the fallback is
  patching 314's classic-worker check (untested).
- **One output only**, `dist/hermit-agent-standalone.html` (8.8 MB). There are no
  CDN or local variants, unlike HermitUI. For development, open `src/index.html`
  directly: it loads the libraries and Pyodide from the CDNs, under a looser CSP.
- **Default API URL is `http://localhost:8080/v1`** (llama.cpp) rather than HermitUI's
  `:1234` (LM Studio), because that's what the spike and your machine use.

## Agent loop

- **Every model turn that doesn't end the loop counts toward the step limit**,
  including cut-off, empty and malformed replies that ran no code. Otherwise a model
  that keeps replying with nothing could loop forever. Alternative: count only
  executed steps and add a separate "consecutive empty replies" guard.
- ⭐ **Stop aborts an in-flight model request immediately**, rather than "finishing
  the current step" as §2.2 says. A Python step that is *running* still finishes.
  Reason: with reasoning models one request can take minutes, and nothing has run
  yet, so nothing is lost by aborting it.
- **Guidance, upload notices and restart notices are merged into the next user
  message** (usually the latest observation) instead of being sent as their own
  message. Some chat templates reject two user messages in a row.
- **Reasoning effort defaults to Low.** This is a spike finding: Qwen3.8 at its
  default (xhigh) spent the whole token budget on one step. Max tokens defaults to
  8192. The control is a `<select>` in the composer, not HermitUI's segmented
  control.
- **Reasoning support is probed automatically** (`/props`, then `/api/show`) before
  the first request to an endpoint, and again from Test Connection. HermitUI has a
  separate button for this. If the probe finds nothing, the parameter is sent
  optimistically, and the strip-and-retry on a 400 still applies.
- **The model's reasoning isn't sent back in the history**, only its visible reply.
- **The first message lists the workspace files** (name and size, up to 50).
  Uploads made after the task started are announced to the model in the next
  request.
- **An empty model name sends `"local-model"`**, as HermitUI does.
- **`ask:` is detected at the start of any line**, case-insensitive, with or without
  bold. A final answer that contains a line starting with "Ask:" would pause the
  loop. That's unlikely but possible.
- **A final answer that names files the workspace doesn't have is sent back once.**
  This applies to names in backticks or bold with a common file extension. The
  model is told which files are missing and which exist; its second answer stands
  either way. A step whose code starts with a `# name.py` comment also gets a note
  when no such file exists afterwards. Why: a real model "saved" `csv_reader.py`
  that way, then claimed in its final answer to have created it. False positive: an
  answer that mentions a file the agent deliberately deleted, in backticks, gets
  sent back once.
- **A follow-up after the final answer continues the same conversation**, and the
  step budget is extended by the step limit. To start fresh, use ➕ New.

## Gating (DESIGN §2.3)

- ⭐ **Approve-each mode approves *before* the run, and there is no second hold
  after it**, even if the step then deletes a user file: you approved the code.
  Alternative: also hold risky effects after an approved run.
- ⭐ **"Allow network & re-run" and "Edit & re-run" restart the interpreter** before
  the second run, so variables from earlier steps are lost (the model is told).
  This is consistent with the rollback rule, since variables may hold the rejected
  step's data, but it can break code that relied on earlier variables. A network
  re-run commits without another hold, with the network open for that run only.
  An edited re-run is gated again like any step.
- **Autopilot commits everything** except a step that would exceed the workspace
  limits, which is auto-rejected. In risk-based mode that case is a hold reason
  instead.
- **A package load that the harness refused also holds the step**, because it
  shows up as a blocked network attempt. That happens when agent code pointed
  Pyodide's registry somewhere other than the pinned CDN.
- **An overwritten user file stays a user file.** New files are `agent`, and a
  rename counts as delete + add, so renaming a user file asks.
- **Empty directories aren't tracked.** The workspace is files only; export writes
  no directory entries.
- **Uploads are refused while a step is running.** They're allowed while a step
  waits for approval; the worker is then re-seeded before the next run.
- **Kill when idle** restarts the interpreter, and the model is told on its next
  request.

## File actions (added after the MVP)

- ⭐ **A reply holds file actions or one python block, never both** (your call).
  A mixed reply runs nothing and gets an error observation. The alternative was
  "files first, then the code" in one turn, which saves a model round-trip.
- **Writes and edits in one reply are all-or-nothing.** The first failure stops the
  batch. Reads before it keep their output; later actions are reported as not run.
- **Approve-each holds read-only file steps too**, since a read sends file content to
  the model. Risk-based and autopilot never hold a pure read.
- **Tags count only at the start of a line, and content runs to the first closing
  tag.** So a file can't contain its own `</write_file>` literally. That is rare
  enough; the alternative is a length-prefixed or fence-counted format that small
  models get wrong.
- **Read caps:** 400 lines and 32 000 characters per read, 64 000 per reply, and
  2 000 per line. They were picked to fit a typical source file in one read without
  flooding an 8–16 k context. The file-step observation is therefore not truncated
  again.
- **Path leniency:** `/workspace/x` and `./x` are accepted as `x`. Anything else
  unsafe is refused per action.
- **A file step never boots the interpreter.** After a commit, the bytes go to the
  worker only if it was idle and in sync. Otherwise the next python step re-seeds it.

## Checkpoints & rewind

- **A checkpoint is taken after every model turn**, including rejected and non-code
  ones, and at the task start. Rewind truncates the timeline, the history and later
  checkpoints, garbage-collects unreferenced file contents, and restarts the
  interpreter. Rewinding needs the agent stopped.
- **Rejected steps' file versions stay in memory while their card exists**, so the
  file chips can still show them. They're never exported.

## Context compaction (DESIGN §5.4, added after the MVP)

- **Default 85 %, keep the last 4 steps, at least 2 steps per compaction.** 85 % was
  chosen by the owner (first built at 75 %). It leaves ~2.4 k of a 16 k context for a
  reply. A longer reply that overflows is caught by the overflow fallback. Lower
  the threshold if `max_tokens` is large compared with the context.
- **The token estimate is calibrated, not counted.** No tokenizer runs in the page. The
  previous request's `prompt_tokens` per character is used, which also covers the chat
  template's overhead. After an import, chars ÷ 3.5 is used until the first request.
- **Ollama and cloud APIs don't report a context size.** Without the *Context size*
  setting, only the overflow fallback works there. Ollama truncates silently instead of
  failing, so set the size by hand for it.
- **The summary is written by the same model, with the user's reasoning effort and
  `max_tokens`.** A summary cut off at `max_tokens` is still used. Only an empty one is
  rejected.
- **Exports carry every compaction's full pre-compaction history**, so they grow by
  roughly one context's worth per compaction. That is the price of rewind
  across a compaction.

## Export / import (DESIGN §3)

- **`session.json` stores a `timeline`** (every card in order) instead of a bare
  `steps` list, so an import rebuilds the exact view. DESIGN §3.1 was updated.
- ⭐ **Import doesn't apply the session's endpoint or model.** Autonomy and limits
  are restored, and a note names the endpoint the session was recorded against. A
  shared session shouldn't silently send its content to the sender's server.
- **Limits:** the workspace holds up to 5,000 files / 256 MB; an import is capped
  at 20,000 entries / 512 MB unpacked. Not measured against real tab memory.
- **Only format version 1 exists**, so there is no migration code yet. A newer
  version is refused with a clear message.
- **There is no "import a workspace zip as files".** A zip you upload stays a zip in
  the workspace, and the agent can unpack it with `zipfile`.

## Security

- ⭐ **The network guard is best-effort and the UI says so.** It is a denylist over
  the worker's API surface plus a strict CSP. All 17 probes are blocked in
  Chromium, Playwright's Firefox and stock Firefox 157, and the mock endpoint
  received nothing. A future browser API could still open a path. The unbuilt dev
  source allows the CDN hosts in `script-src`.
- **`script-src 'unsafe-inline'` is unavoidable for a single file.** Model output
  is sanitized with DOMPurify, so script injection would need a DOMPurify bypass.
  `connect-src` is `*`, because the endpoint is user-configured.
- **In risk-based and autopilot modes, a step's output reaches the model before you
  see it** (DESIGN §13, open question; unchanged).
- **A forged worker result can only hide changes**, never invent them: the main
  thread re-hashes every received file. Hidden changes never reach the canonical
  workspace and disappear at the next re-seed.

## UI

- **The workspace panel sits on the right and wraps below the timeline on narrow
  screens.** It's not a drawer yet (Phase 2 mobile pass).
- **Per-file text diffs** (Phase 2a): a modified file's chip opens a line diff, with
  tabs for both versions. Binary files (images included) have no diff view yet.
- **No approve/reject keyboard shortcuts** (DESIGN §13 open question). Ctrl+Enter
  submits the composer.
- **Dark mode follows the system at load**, and the toggle isn't remembered
  (ephemerality).

## Phase 2a (reliability), decided while building it

- ⭐ **Retry for 2 minutes, then pause.** Network errors, 408/429/5xx, a dropped or
  stalled stream and an empty answer are retried after 2, 4, 8, 16, then 30 s, up to
  2 minutes in all; then the run pauses (Retry / Continue resume it). It is a constant,
  not a setting. Alternative: a "Retry for (s)" setting, or waiting indefinitely with
  a periodic probe and auto-resume.
- **A stream silent for 3 minutes after data started is given up and retried.** There
  is no watchdog before the first token, because a long prompt can take minutes to
  process; a connection that dies silently *before* the first token still hangs until
  Stop. (Playwright's Firefox showed this with requests made offline.)
- **A retry discards the partial reply** and asks again from scratch, rather than
  trying to continue it.
- ⭐ **Elision keeps the last 4–7 steps in full and moves in blocks of 4**, so the
  prompt prefix stays cacheable for 4 requests at a time. Observations over 2,000
  characters keep 600 + 600; long `<write_file>` bodies become a placeholder. Old
  python code is never elided. Alternative: a fixed window of K steps (simpler, but
  re-reads the tail on every request).
- ⭐ **The system prompt lists all ~300 loadable packages** (~1k tokens of fixed,
  cacheable prefix). Alternative: a curated short list, which would save tokens on
  small contexts but invite `ModuleNotFoundError` round-trips.
- ⭐ **No offline package pack** (DESIGN §8). Packages need the CDN on first import; the
  failure says so. Revisit with Phase 4.
- **Package loading has its own 2-minute limit**, outside the step timeout, and a
  failed package means the code doesn't run at all.
- **`<python>…</python>` runs like a fence.** Seen with Qwen3.8 in the success
  measurement, where it ended a task as a "final answer". A `<tool_call>` gets advice
  instead of running. Alternative: treat both as malformed replies.
- **⚡ Send now aborts the model's reply in flight**, discarding its reasoning so far,
  and the turn starts over with the note. It isn't offered while Python runs or a
  step waits for you: the note goes out with the next request anyway.
- **The close warning only fires for unexported work**, and a workspace of uploads
  alone doesn't count. Before, any timeline or file triggered it.
- **Large uploads ask first** at 50 MB in one go, 25 MB in one file, or 500 files.
- **Tab in the code editor indents** (Shift+Tab leaves the field), which traps forward
  Tab for keyboard users in that one field.
- **"Run N more steps" remembers N** for the session (default 10); the composer's
  Continue at the limit uses it too.

## Phase 2b (rich output), decided while building it

- ⭐ **2b's exit criteria were set before building**, as the roadmap asked:
  every item tested (unit + e2e in Chromium and Firefox), and an 18-task success
  measurement (three new 2b tasks) at ≥ 90 % over 3 runs, with the shown-chart task's
  figure captured in every run. Alternative: a stricter bar (no regression from 2a's
  98 %) or a separate figure-only suite.
- ⭐ **Figures are workspace files** (`figures/step-N-K.png`), as DESIGN §8 planned:
  checkpointed, exported, rewindable, and the agent can open them. The cost: they add to
  the workspace and the checkpoint budget, and the file tree grows with every plot.
  Alternative: keep figures as step attachments outside the workspace.
- ⭐ **Figures still open at the end of a step are captured and closed**, like a
  notebook, not only those passed to `plt.show()`. A figure saved with `savefig` isn't
  captured again (its own file is shown). The catch, also a notebook's: `savefig` *after*
  `show()` saves an empty figure, and a figure built across several steps with
  `plt.*` calls is gone after the first (`fig.savefig` on a kept `fig` still works).
  The prompt says so. Alternative: capture only on `show()` and leave figures open.
- **Every image file a step writes is shown on its card**, by extension (PNG, JPEG, GIF,
  WebP, BMP, SVG), at most 8, never upscaled; not only captured figures. TIFF and ICO
  aren't shown inline (browsers don't render TIFF), but the viewer describes them.
- **The model is told what binary files it wrote** (format, size, header facts; at most
  10 per step), and which figures the user saw, with "you can't see images". Images are
  never sent to the model, even to a vision model: that would need image content parts
  and vision detection. Alternative: send figures to vision-capable endpoints.
- **The binary summary reads headers only**, never decodes a file: for a PDF it scans up
  to 16 MB of text for the page tree's `/Count` (absent when the page tree sits in a
  compressed object stream), for SQLite up to 4 MB for `CREATE TABLE` names (sorted).
  Format detection is by magic bytes, not extension.
- **The periodic file list goes out every 5 steps, only when the workspace changed**
  since the model's last list, appended after that step's observation. Rewind, import
  and ➕ New forget the last list, so the next due step sends one. Alternatives: every
  N steps regardless, or a tool the model calls.

- **A guessed tool tag at the start of a line runs nothing** (`<run_python>`, `<bash>`,
  `<shell>`, `<execute_python>`, …), with advice to send a ```python block and to run
  a script with `runpy.run_path`. Found in the 2b measurement, where such a reply ended
  a task as its "final answer". Alternative: run the tag's content as Python, like
  `<python>` (here it held a shell command, which would only fail).

## Phase 3 (native tool calls), decided while building it

- ⭐ **Auto uses native tool calls only when the endpoint says it supports them**
  (llama.cpp `/props`, Ollama `/api/show`, a model list's `supported_parameters`).
  Unknown — most cloud APIs — means code-as-action; pick *Native tool calls* in Settings
  for those. Reason: a server that ignores `tools` would leave the model unable to act,
  while code-as-action works everywhere. Alternative: go native on unknown and rely on
  the refusal fallback (which can't catch a server that silently ignores `tools`).
- ⭐ **Plain text without a tool call is the final answer**, and `finish` is offered too.
  Code or file tags in such text run nothing and the model is told to call the tool,
  rather than being executed. Alternatives: require `finish` (models that end with text
  would be pushed back every time), or run fences found in text.
- ⭐ **Several calls in one reply: the first action call decides**, as in "only the
  first code block runs". `write_file` + `run_python` in one reply writes the file and
  tells the model to call `run_python` again, instead of running both in order. Running
  both would mix the two gating paths (a file step is gated before it applies, a code step
  after it runs). Alternative: run file calls, then the code, as two gated sub-steps.
- **A server that refuses `tools` switches that endpoint to code-as-action for the rest
  of the session** (until its URL or model changes), including when *Native* is chosen
  explicitly, with a note. Alternative: an error card when Native was chosen.
- **`parallel_tool_calls: true` is always sent**, so llama.cpp parses more than one call
  per reply (its default is one). Servers that don't know the parameter ignore it.
- **User notes after a tool result are user messages**, not text appended to the tool
  result; the answer to `ask_user` is its tool result. A template that insists on strict
  user/assistant alternation around tool messages would refuse these histories; none
  tested does.
- **Session format 2.** Older builds refuse format-2 exports with "made with a newer
  HermitUI Agent" rather than a malformed-message error. Format-1 exports still import.
- **The Actions setting is exported but not restored on import**, like the connection
  settings: it is about the endpoint, and the history works in either protocol.

## Phase 3.5 (bundled libraries), decided while building it

The pick itself (Tier 1 and Tier 2 of the study) was the owner's; these are the choices
made building it (DESIGN §8, "bundled pure-Python libraries").

- ⭐ **Only the libraries are bundled, not the Pyodide packages they import.** openpyxl,
  XlsxWriter, Markdown, tabulate and xmltodict work fully offline; python-docx and
  python-pptx still load lxml (and Pillow) from the CDN, qrcode Pillow, markdownify
  beautifulsoup4, seaborn numpy/pandas/matplotlib. That keeps the growth to the chosen
  set's size (+2.27 MB, 9.04 → 11.31 MB). Alternative: also inline lxml, Pillow and
  typing-extensions (2.7 MB of wheels, about 3.6 MB more on the file) so Word, PowerPoint
  and QR codes work offline: a step
  towards the offline pack DESIGN §8 deferred to Phase 4.
- **Downloaded wheels are inlined unmodified, gzipped and base64-encoded.** (Without gzip until
  odfpy was added: gzip gains only 3 % on downloaded wheels, but the wheel built for odfpy
  is stored and shrinks 596 → 105 KB.) A solid `.tar.gz` of their contents would save
  ~0.3 MB but replace the pinned artefacts with a repacked one. Unmodified wheels also carry each library's license text in their
  `.dist-info`, which the build checks; there is no separate licenses page in the UI.
  Alternative: list the bundled libraries and their licenses in an About box.
- **`uses` words trigger a library without an import:** pandas imports openpyxl,
  XlsxWriter and tabulate itself, so `to_excel`, `read_excel`, `ExcelWriter`,
  `ExcelFile`, `"xlsxwriter"` and `to_markdown` anywhere in a step's code (comments
  included) install them. A false hit costs an unpacked wheel, nothing more.
- **The manifest lives in `src/script.js`** as strict JSON between markers, read by
  `build.py` and the unit tests, rather than in a separate file: the unbuilt source needs
  it too and can't read local files from `file://`.
- **The unbuilt dev source fetches the wheels from files.pythonhosted.org** (main thread,
  sha256-checked); the built file never does. The dev CSP's `connect-src *` allows it.
- **The reference tasks for the new formats don't require the library.** Whether the
  agent used one is recorded (`library_used`); the pass is the file checked with a
  library. Alternative: fail a task built without its library (as the PDF task fails on
  raw PDF syntax).

- **odfpy, added after the pick (2026-10-06), with a wheel built from its source
  archive.** PyPI publishes none. `build.py` takes the `odf` package and the license
  files out of the pinned archive without running `setup.py`. It declares `defusedxml`
  from the manifest, checked against setup.py's literal, and writes a stored,
  timestamp-free wheel whose sha256 is pinned. Alternatives: inline the source archive
  itself (unmodified, but about 1 MB inlined instead of 0.17 MB, mostly docs and tests), or a
  piwheels wheel (a third-party host). The unbuilt source can't load it, since there is
  nothing on PyPI to fetch, and says to use `dist/`.

## Phase 3.6 (more file tools), decided while building it

The pick (search, syntax check, delete/move, ask options) was the owner's; these are
the choices made building it (DESIGN §5.1, §2.3).

- ⭐ **The syntax check reports, it doesn't refuse.** A `.py` that doesn't compile is
  saved as written and the step gets a note. SWE-agent rejects such an edit instead;
  here a module written in two steps would be refused halfway. Only file actions are
  checked: a file written from Python reports its error when it runs. It boots the
  interpreter if a session has had no python step yet (about a second, once).
- ⭐ **`move_file` never overwrites.** Moving onto an existing file fails with advice to
  `delete_file` it first in the same reply (unlike `os.replace`), so replacing a file is
  always an explicit, separately gated delete. Alternative: an `overwrite` flag.
- ⭐ **A moved user file stays a user file.** Its origin goes with it, so a later
  overwrite still asks. A rename from Python still loses it (it shows as a delete plus a
  new file), so the two paths differ. Alternative: track renames by content hash for
  Python steps too.
- **`search_files` uses JavaScript regular expressions**, not Python's `re`. They agree
  on everyday patterns. Where they don't, `(?P<name>…)` is invalid in JavaScript, and an
  invalid pattern is searched as plain text, which the result says, rather than failing.
  A leading `(?i)` is understood. Alternative: run the search in the worker with `re`
  (exact semantics, but a worker round trip and a boot).
- ⭐ **Runaway patterns are refused, not run in a killable worker.** The search runs on
  the main thread, where catastrophic backtracking would hang the tab for good.
  `hasNestedQuantifier` refuses the classic shape (a repeated group that repeats inside),
  and a 3 s budget stops slow searches. It is a heuristic: overlapping alternations
  such as `(a|a)*` aren't caught. Alternative: a throwaway Blob worker per search,
  terminated on a timeout (exact, but the search then needs a copy of the workspace's
  text files).
- **`search_files` is never held in risk-based mode, but waits in approve-each**, like
  `read_file`: what it returns goes to the model.
- **`delete_file` takes folders**, recursively, like `rm -r`; risk-based gating still
  asks for each of your files in it.
- **The worker's `remove` also drops the folders a delete leaves empty**, so the
  interpreter and the workspace agree (the workspace has no empty folders). A folder an
  agent created with `os.makedirs` and emptied with `delete_file` is gone too.
- **Code-as-action options are the `- ` / `* ` / `1. ` lines that end an `ask:`**, 2 to 6
  of them. A question that happens to end in such a list gets buttons it didn't mean to;
  harmless, since the user can still type an answer. More than 6 stay plain text.
- **Options of an imported session are shown, but disabled**: the run is paused, and an
  answer goes through the composer.
- **The quick selection is unchanged** (5 tasks). The two new tasks are in the full
  suite only.

## Phase 3.7 (a plan the user can see), decided while building it

The roadmap left five questions open; these are the answers the build took.
- ⭐ **`update_plan` rides along** with any reply: code, file actions, an ask, the final
  answer. One reply stays one step, and the plan is part of it. A reply with *only* a plan
  is a step of kind `plan` that runs nothing else. Alternative: a file-style action that
  ends the step, which costs a turn per update (a 10-step task with 4 updates: 14 turns).
- ⭐ **The user can't edit the plan.** A note (guidance) changes the agent's course, and
  the agent updates the plan; the panel says so. Alternative: an editable panel whose
  edit is sent as guidance. It was left out because it makes two writers of one list
  (what if the model sends a plan while you edit?) for little gain over a note.
- ⭐ **Encouraged, not required:** the prompt asks for a plan on tasks of more than three
  or four steps and says to skip it for short ones.
- ⭐ **One reminder at step 2**, and only if no plan has been sent yet: a note in that
  step's observation (or, if step 2 ran nothing, the next step that runs something)
  asks for a plan if the task will take more than a few more steps, and says to skip it
  when nearly done. It was added after measuring without one: with
  Qwen3.8-27B code-as-action kept a plan in 15 of 23 longer runs, native in **none of
  81**. Natively the model reads the files first and never comes back to the plan. With
  the reminder, native kept one in 3 of 8 longer runs, but in only 1 of 17 on the full
  suite: it helps on long tasks (the app task kept one in 7 of 8), little on short ones.
  Alternatives: no reminder (native
  then shows no plan at all), or a repeating one every N steps without a plan, as Claude
  Code does for its todo list. That costs prompt tokens on every long run and nags on
  tasks that don't need a plan.
- ⭐ **Stored on the step that sent it**, the current plan derived from the timeline: rewind
  needs nothing, and export carries it per step with no new session format (an older
  version drops the field). Compaction appends the current plan to the compacted task
  message.
- ⭐ **Prose next to a plan with open steps isn't a final answer** (code-as-action): "I'll
  read the file first" plus a plan would otherwise end the task. The cost: a model that
  answers without ticking off its last step gets one more turn to send the answer again.
- **A plan-only step counts against the step limit**, like any other step.
- **Native plan results are one short line** ("Plan updated (1 of 3 done).") rather than
  an `<observation>` envelope; in code-as-action a plan that was read adds nothing to the
  observation, only an unreadable one adds a note. Both keep the per-step overhead small.
- **Small models keeping a plan up to date** (question 5) is left to Phase 4. The
  success measurement records the plans sent (`plans`), so a stale plan can be spotted.

## The loop guard (v0.3.14, 2026-10-24), decided while building it

From comparing pi, opencode and Claude Code (opencode's `doom_loop`).
- ⭐ **Skip the third, pause on the fourth.** The third identical action in a row isn't
  run, and the model is told why; a fourth pauses the run for the user. Alternatives:
  opencode asks the user at the third (a supervised agent already holds risky steps, and
  a model often recovers from one nudge without anyone being disturbed), or only telling
  the model (a model that ignores the note loops until the step limit).
- ⭐ **Exact repeats only**: the same code (trimmed) or the same file actions with the same
  arguments. A loop that changes one character each time isn't caught. Alternative: a
  similarity threshold, which risks stopping legitimate reruns.
- **Read-only actions count too.** Reading the same file three times in a row is the same
  loop, even though it changes nothing.
- **Anything between two steps resets the count**, including compaction, so a note from
  the user always gives the agent a fresh start.

## Compaction with a focus (v0.3.15, 2026-10-24), decided while building it

- ⭐ **Only by hand.** The 🗜️ Compact button asks for an optional focus; automatic
  compaction has none. Alternative: a standing "compact instructions" setting, as
  Claude Code reads from CLAUDE.md. The custom instructions setting is close enough, and
  the agent's `AGENTS.md` isn't read by the summariser.
- ⭐ **The focus may push the summary past its 400 words**, since the user asked for
  detail. Alternative: keep the cap and let the focus crowd out other sections.

## The compaction thrash guard (v0.3.16, 2026-10-24), decided while building it

- ⭐ **3 automatic compactions within 4 steps pause the run.** That is a summary used up
  within about one step. Compacting every 3 steps, as the 10k-context runs of 2026-10-24
  did (5 in 15 steps), still makes progress and doesn't trigger it. Alternatives: a
  tighter or looser window; or stop compacting and let the server refuse the prompt.
- ⭐ **Pause rather than keep going without compaction**, since the next request would
  overflow anyway; the note names the fix (context size, or less output).

## Edit the task (v0.3.17, 2026-10-24), decided while building it

- ⭐ **A new start, not an edit in place.** The edited task starts a fresh session with
  the workspace as it was at the start. Alternative: replace the task message and keep
  the session, which leaves a timeline that answers a task nobody sent.
- **Only on the task card.** A follow-up can't be edited this way; rewinding to the step
  before it and sending a new follow-up does the same.

## Plan first (v0.3.18, 2026-10-24), decided while building it

- ⭐ **An autonomy level, not a separate agent.** opencode switches to a Plan agent with
  other permissions; here the existing gate does it: while the plan waits, every file
  change is rolled back. Alternative: hide the writing tools while planning, which
  changes the tool list mid-session (the prompt prefix the server caches) and doesn't
  help code-as-action.
- ⭐ **Python runs while planning.** Reading an Excel file or a SQLite database needs it,
  and the effect gate sees whether a run wrote anything. Alternative: block code until
  approval, as opencode blocks edits (it allows bash, though).
- ⭐ **Approved = risk-based from then on.** Alternative: keep asking for every step
  (Approve each step) or drop to Autopilot.
- ⭐ **The approval is a timeline note**, so a rewind past it takes it back, and export
  carries it. It counts as part of the record, not as a pending approval, so the rule
  that imports never carry approvals over (DESIGN §3.3) isn't touched: the imported
  session still starts paused.
- **A step that sends a plan pauses the run**, even a plan sent alongside code that only
  read. A model that answers without a plan (a plain question) just finishes.

## ask_llm (v0.3.29, 2026-10-30), decided while building it

- ⭐ **The same endpoint and model answer.** The point is a fresh context, not a
  stronger model. Alternative: an optional "model for ask_llm" setting (Amp's oracle
  asks a stronger reasoning model), which works on OpenRouter or a router-mode
  llama-server but not on a server with one model loaded.
- ⭐ **No approval outside Approve each step.** It changes no file, and the data only
  goes to the endpoint the agent already sends everything to. Alternative: hold it in
  Auto too, since a cloud endpoint bills each request.
- **One request per reply, run alone**, like `run_python`. Alternative: let it run in a
  batch with file tools, or several requests in parallel (a map over many files),
  which a single-slot llama.cpp server would queue anyway.
- **Files as `path` or `path:first-last` strings**, text only, 200,000 characters sent
  with the prompt. A string works the same in the tag and the tool, and llama.cpp's
  grammar needs no `anyOf`. Alternative: objects `{path, start_line, end_line}` like
  `read_file`'s arguments in the native tool.
- **The answer is cut at 16,000 characters**, not head plus tail. Alternative: save a
  long answer to a file and return its path.

## ask_llm reasoning level and budget (v0.3.30, 2026-10-31)

From the long-context recall probe (`~/ws/hermit-agent-lab/2026-10-31-recall/`): 3 of 12
requests on parts of a 277k-character book came back empty, the whole 8,192-token budget
spent on reasoning at session level Low.

- ⭐ **The agent picks the level, the session caps it.** A request can't reason more than
  the user set; "Model default" sets no cap. Alternative: the request's level wins, so
  "high" works in a Low session (more surprise, and cost on a cloud endpoint).
- ⭐ **The budget is not a parameter.** Models guess token counts badly, and a budget set
  too small fails the same way. The app gives `ask_llm` twice Max tokens instead, capped
  by the context. Alternative: a `max_tokens` argument.
- ⭐ **One automatic retry with reasoning off** when a reply has no answer but reasoning:
  cut off at the token limit, or ended inside the reasoning (seen once in the v0.3.30
  rerun as "The model returned an empty answer"). Alternative: the error alone, as before, which the agent answered by sending
  smaller parts, each failure costing a full request.
- **Levels off, low, medium, high**, the session's own set, not `xhigh` or a token
  count. "high" still maps to the template's maximum (`buildReasoningParams`).

## Text encodings (v0.3.12, 2026-10-23), decided while building it

- ⭐ **A Windows-1252 file keeps its encoding** (option (b) of 2026-10-09). Before, a
  file that wasn't strict UTF-8 was binary everywhere: a hex dump in the viewer, refused
  by read_file and edit_file, skipped by search. Now it is text, and writes and edits
  store it as cp1252 again; a UTF-8 BOM is kept the same way (before, an edit dropped
  it). Alternative (a): read as cp1252, write UTF-8 — simpler, but it changes a user's
  file in a way the diff doesn't show, and Excel then shows `GrÃ¼ÃŸe`.
- ⭐ **An edit cp1252 can't hold is refused, not converted**, naming the characters and
  how to convert the file in Python. Alternative: convert to UTF-8 on such an edit and
  say so in the result.
- ⭐ **The cp1252 guess needs the bytes to look like text** (no undefined cp1252 bytes,
  < 1 % control characters, < 30 % high bytes past 32 bytes), since cp1252 decodes any
  byte. A short binary without NUL bytes could still pass as text; real formats (PNG,
  JPEG, zip, gzip) contain NULs or fail the checks. Other legacy code pages aren't
  detected.
- No system-prompt change: the read_file result names the encoding when it matters.

## Network tasks (v0.3.9, 2026-10-23), decided while building it

- ⭐ **The prompt no longer says "no network access … HTTP clients can't connect".** It
  replaces the 2026-10-07 decision below: the network is off, a step that connects is
  held, the user may allow it for that step, and only CORS sites can be read. Measured
  in headless Chromium against Qwen3.8: the model tried web tasks anyway, so the old
  line only misinformed it about what happens next.
- ⭐ **urllib goes through a sync XHR in the harness**, not through the `pyodide-http`
  package: no extra download at boot, and it also covers `build_opener()`, not just
  `urlopen`. Headers the browser forbids (`User-Agent`, `Host`, …) are left out.
- **Not done, for review:** an "allow network for the rest of this task" grant (today
  every step that connects is held again), and a prompt rule against third-party reader
  proxies (Qwen reached a no-CORS page through `r.jina.ai` after 9 held retries; the
  user approved each one, but the URL left through someone else's server).

## Prompt review (2026-10-07), decided while building it

- ⭐ **HTTP clients stay on the prompt's package list**, with "requests and other HTTP
  clients import, but can't connect" next to "no network access". Off the list, the model
  would treat a project's `import requests` as unavailable and rewrite code that runs
  fine here. Alternative: leave them off the list (they would still load), which the
  review first suggested.
- ⭐ **An imported history with a system message anywhere but first, or none first, is
  refused**, not repaired. Genuine exports never have one, and silently dropping it would
  hide a tampered file. Alternative: drop such messages and say so in the import note.
- **Every request rebuilds the system prompt**, not only a protocol switch or saving
  Settings: an import, a package list that arrives late, a changed step limit. The same
  inputs give the same text, so the prompt cache still holds. On import the importing
  user's custom instructions apply (they are a setting, and settings aren't exported), as
  on a rewind.
- **The step time limit is in the prompt**, so changing it changes the prompt prefix
  once (one prompt-cache miss).
- **The summariser's headings changed** (From the user … Still to do). Summaries written
  before keep their old headings; the next compaction folds them in.
- ⭐ **The prompt doesn't say how to run a script**: a line naming `runpy.run_path` was
  measured and dropped (DESIGN §5.3: no fewer scripts written first, and the only misses
  came with it). The advice after a shell tool or a made-up run tag names it.
  Alternative: keep the line now that made-up tags no longer end a task, for the extra
  step it may save.
- **`<execute>` and `<run script="x.py"/>` run nothing and get advice**, like `<run_python>`
  before them; next to file actions the step names the tag. Alternative: treat
  `<run script="x.py"/>` as a real action that runs the script with runpy. It is the
  model's own guess at the syntax, but it would add an action to both protocols.

## Security & robustness review (2026-10-08, v0.3.5)

Three fixes from a review of the agent against a misbehaving/prompt-injected model
(DESIGN §10's threat model). Each is covered by a new test and the build is green.

- ⭐ **Model-rendered Markdown is sanitised against UI redress, not just scripts.**
  `renderMarkdown` now passes `ALLOW_DATA_ATTR:false` and `FORBID_ATTR:["style"]`, and
  opens links in a new tab. Before, DOMPurify's defaults kept `data-*` and inline
  `style`, so a reply could lay a transparent overlay carrying
  `data-action="rerun-net"` over a held step's card; a user's *Reject* click then read
  as "allow network & re-run" and a blocked step's data left the machine (confirmed
  against the built file, then fixed). The timeline's click handler keys on
  `data-action`/`data-idx`/`data-role`, which model output now can't carry. Alternative
  considered: hardening `handleTimelineClick` to only accept app-created controls (more
  invasive; the sanitiser change is surgical and also closes the file-viewer path). The
  parent HermitUI app's `AI_SANITIZE` may have the same gap — not touched here per the
  folder rules; worth a look there.
- **`search_files` bounds each `re.exec` to `LIMITS.searchMaxScanChars` (64 KB).** The
  3 s budget was only checked between lines, so one very long line (minified JS,
  one-line JSON) could make a single `exec` backtrack for far longer — measured ~23 s on
  a 1 MB line with `.*`-style patterns, and files may be up to 10 MB. A longer line is
  now searched only up to the cap, counted and noted; the deadline is also checked every
  line. Alternative: run the search in a terminable worker (exact, but a copy of the
  workspace text and a round trip). The cap keeps it on the main thread and bounded.
- **Imported numeric settings are clamped like *Settings → Save*.** `validateSession`
  only type-coerced step limit / timeout / max tokens; a shared or old session could
  carry a step timeout of 0, which disables the per-step watchdog (a falsy timeout means
  "no timer" in `workerCall`). They are now clamped to the same bounds the Settings form
  uses.

## Not covered by automated tests

- Drag-drop of a *folder* (entry-based): the folder input and a synthetic file drop are
  in e2e, and the folder walk is unit-tested with fake entries, but a real OS drag of a
  folder is tested by hand only.
- Safari, mobile browsers, and real desktop Chrome/Edge/Firefox on Windows. The
  spike page ran in desktop Chrome on Windows; the app itself hasn't.
- Long tasks against a real model: the Phase 2a long run (`tests/e2e_longrun.py`)
  continued correctly across up to 4 compactions in a 33-step task, with Qwen3.8-27B.
  That is one model and one task shape (short, independent steps); summaries of long,
  stateful work (say, a refactor across files) haven't been measured.
- Stock Firefox: once, under heavy CPU load (a real-model run in parallel), the outage
  scenario's retry request neither failed nor answered for 30 s; it passed 9 runs in a
  row afterwards. Not understood; a request that hangs before its first byte is only
  ended by Stop (DESIGN §5.5).
