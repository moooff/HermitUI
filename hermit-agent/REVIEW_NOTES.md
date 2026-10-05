# Decisions to review (Phase 1 MVP build, Phase 2a)

The MVP was built unattended on 2026-10-03, and Phase 2a on 2026-10-05, on the instruction "make educated guesses
when problems arise, note them for me to decide later". Each entry says what was
decided, why, and what the alternative is. When you confirm or reverse one, delete it
here; if you reverse it, update DESIGN.md too. The ⭐ entries are the ones most worth a
look.

## Process

- **No implementation-plan approval round.** AGENTS.md asks for a plan and explicit
  approval before major changes. You asked for the build to run unattended, so this
  file and DESIGN.md's "as built" notes stand in for the plan. A local
  `walkthrough.md` (gitignored) summarises the changes.
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
- **Version v0.1.0**, shown in the header. No git tag was created.

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
