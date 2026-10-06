# HermitUI Agent — Design

Status: **Phase 1 (MVP), Phase 2a (reliability) and Phase 2b (rich output) implemented**
in `src/` (see
[ROADMAP.md](ROADMAP.md)). Where
the build deviated from the original plan, the section says so; decisions that
still need an owner's call are collected in
[REVIEW_NOTES.md](REVIEW_NOTES.md). Statements still marked *(verify in spike)* are
unconfirmed.

Decisions taken so far:

| Topic | Decision |
|---|---|
| Task scope | General assistant, data/file processing, writing & testing code, research/reasoning |
| Default supervision | **Risk-based**: harmless steps auto-run, risky steps ask |
| Backend | External OpenAI-compatible endpoint first; in-browser wllama later |
| Session persistence | **Required:** import/export of a whole session to one file |
| Project layout | Own folder (`hermit-agent/`) in the HermitUI repo; merge later is possible |

---

## 1. Vision & non-goals

**Vision:** an agent you can hand a task to and *supervise*. It loops on its own
(think → write Python → run → observe → repeat), but every action is visible,
risky actions wait for approval, every step can be rewound, and the whole thing runs
in a browser sandbox with nothing persisted unless you export it.

**Non-goals:**
- **Not a Jupyter replacement.** There are no notebooks and no user-authored cells.
  The user supervises; the agent writes the code.
- **Not a browser-automation agent.** It does not click around websites or control
  other tabs.
- **No access to the real file system.** Files come in only by upload and go out
  only by download or export. No File System Access API mounts in v1.
- **No server component.** It is a single HTML file, like HermitUI.

---

## 2. Supervision model

This is the core of the product. Everything else serves it.

### 2.1 What the user sees

- **Step timeline (centre).** One card per step:
  1. **Reasoning:** think blocks, rendered collapsible exactly as HermitUI does
     (`parseThinkSegments`).
  2. **Proposed code:** syntax-highlighted Python, editable while the step is pending.
  3. **Output:** stdout and stderr. Tracebacks are trimmed for display, with the full
     text on expand. Generated images (matplotlib figures) appear inline. *As built
     (Phase 2b):* every image file a step created or changed (by extension: PNG, JPEG,
     GIF, WebP, BMP, SVG) is shown on its card while its version is held, captured
     figures first, at most 8, scaled down to fit but never up; a click opens the
     viewer. They are `<img>` elements on Blob URLs (an `<img>` never runs scripts, SVG
     included), cached per content hash and revoked once the version is freed.
  4. **Effect:** files created, modified or deleted, with a per-file diff on click.
     *As built:* the chip of a modified text file counts its changed lines (`+3 −1`,
     while both versions are held and under 512 KB together) and opens the viewer on a
     unified line diff (Myers, `lineDiff` / `diffHunks`, 3 lines of context), with tabs
     for the version after and before the step. Added files open as they are, deleted
     ones as they were. A diff is drawn as text, never HTML, and stops at 4,000 lines.
     A modified *binary* file (Phase 2b) opens on both versions side by side, each with
     its summary (below), as images when they are; a binary chip's tooltip carries the
     summary too.
  5. **Verdict:** a badge showing auto-committed, approved, edited & approved, or
     rejected, plus who decided.
  6. **Model stats:** a footer row for that step's model request: generation speed
     (tok/s), time to first token, output and prompt tokens (reasoning and cached
     counts when reported), prompt speed, context used against the context size
     (with a fill bar) and total inference time. Server-measured figures (llama.cpp's
     `timings`) win over the page's clock; the context size comes from llama.cpp's
     `/props` and is left out when the endpoint doesn't expose it. Figures the server
     didn't report are omitted, never shown as 0. The stats are part of the session
     export and are re-validated on import.
- **Workspace panel (side).** A file tree of the virtual file system. Files changed
  in the latest step are highlighted. Clicking a file opens a viewer: text with
  highlighting, image previews, or hex/size info for other binaries. Files can be
  uploaded by drag-drop and downloaded individually or as a zip.
  *As built (Phase 2b), the binary summary:* `describeBinary` reads what a file is from
  its first bytes, never decoding it: the format and what its header tells cheaply —
  image size and colour type (PNG, JPEG, GIF, WebP, BMP), a PDF's version and page
  count, an SQLite database's tables and pages, a `.npy` array's dtype and shape, a
  pickle's protocol, a zip's entry count and unpacked size (recognising `.xlsx`,
  `.docx`, `.pptx`, `.npz`, wheels, JARs and EPUBs), a gzip member's name and size, a
  tar's entries, a WAV's rate, channels and length, and the type alone for about twenty
  more formats. The viewer shows it above the hex dump, with a zip's entries listed;
  the model gets it for the binary files a step writes and for a `<read_file>` of a
  binary (§5.1).
- **Status bar.** The step being worked on and the step the run pauses at (each
  instruction or follow-up moves that point on by the step limit; Continue at the
  limit by as many steps as the limit note's field says, 10 by default, and never
  lowers it), what the agent is doing right now (model thinking / writing, loading
  packages, running Python, file actions, compacting, or a countdown to the next retry
  while the endpoint is unreachable), elapsed time, tokens, the interpreter state
  (booting / idle / running / failed), the checkpoints held, and a **context gauge**:
  the next request's estimated size against the context size, with a tick where
  auto-compaction starts (§5.4); without a known size it shows just the estimate. A
  "⚠️ not exported" flag (and a dot on 💾 Export) shows while the session has changes
  that no export holds (§3). The interpreter is idle while the model thinks, which is
  most of the time.
- **Header.** The model and endpoint, and where content goes: a 🏠 *local* badge for
  an endpoint on this machine or the local network (`isLocalEndpoint`), or the ☁️
  "sent to …" note for anything else.
- **Debug console.** A 🐛 header button drops down a log of every tool call (python,
  `read_file` / `write_file` / `edit_file`, final answer, ask) with its arguments and
  result, the gate decisions, and optionally the model requests and interpreter
  state changes. In memory only, capped at 1000 entries, never exported.

### 2.2 What the user controls

- **Autonomy level**, switchable at any time, even mid-task:

  | Level | Behaviour |
  |---|---|
  | Approve each step | Every step waits: **Run / Edit / Reject** |
  | **Risk-based (default)** | Steps whose effect is harmless commit automatically; risky ones wait (see §2.3) |
  | Autopilot | Everything commits; the run stops at the step limit, on a timeout, or when the task finishes |

- **Edit before run:** change the agent's code and run your version. The model is
  told the code was edited and sees the edited version, so it doesn't get confused
  about what actually ran. *As built:* in the editor Tab indents (Shift+Tab leaves the
  field) and Ctrl/Cmd+Enter runs; ↺ Reset brings the agent's code back; once it ran, the
  card offers the diff between the agent's code and yours.
- **Reject with a reason.** The reason goes back to the model as the step's
  observation.
- **Inject guidance:** type a note at any time. It is appended to the next request
  ("use pandas, not csv", "skip the archive folder"). *As built:* the note's card says
  *queued* until it goes out. While the model's reply is still streaming, **⚡ Send now**
  aborts that request and asks again with the note included; the aborted reply is
  discarded and doesn't count as a step.
- **Stop** finishes the current step, then ends the loop.
- **Kill** terminates the Python worker immediately (infinite loop, runaway memory).
  The workspace survives (see §4.3); interpreter variables don't.
- **Step limit and per-step timeout**, set in the settings. At the limit, the note
  offers *Run [N] more steps* with ⏯ Continue (N defaults to 10 and is remembered).

### 2.3 Effect-based risk gating (the key idea)

Classifying arbitrary Python as safe or risky by reading it, through static analysis
or by asking the model, is unreliable. Instead, gating is based on **what the step
actually did**. Inside the sandbox a step has only three ways to affect anything:

1. **The virtual file system.** It can be snapshotted, diffed and rolled back.
2. **The network.** Blocked by default (see §10).
3. **CPU and memory.** Bounded by a timeout and the Kill button.

So each step runs like a transaction:

```
checkpoint VFS ──► run step in worker ──► collect diff ──► classify ──► auto-commit
                                                                   └──► hold for approval
                                                                          ├─ approve → commit
                                                                          └─ reject  → roll back VFS
```

**Classification** (in risk-based mode):

| Effect | Verdict |
|---|---|
| Only new files, or changes to files the agent itself created this session | **auto** |
| Deletes, overwrites or renames a **user-provided** file (uploaded or imported) | **ask** |
| More than *N* files touched, or more than *M* MB written in one step | **ask** |
| A network attempt was blocked | **ask**: "allow network for this step?", then re-run |
| A package must be downloaded (see §8) | **auto** from the pinned Pyodide CDN, shown in the timeline (configurable) |
| Timeout hit | step fails, worker killed, VFS rolled back |

Each file carries an **origin** (`user` | `agent`), which is what makes "overwrites a
user file" decidable. Uploads and imported workspace files are `user`; anything the
agent creates is `agent`.

Caveats, stated honestly:
- The step *has already run* when it is gated, and its stdout exists. For VFS effects
  that's harmless because they are rolled back. It is exactly why the network must be
  blocked rather than merely observed.
- Rollback restores files, **not interpreter state**. Python variables can still hold
  data from a rejected step. On reject, the interpreter is therefore **restarted**,
  and the model is told its variables are gone (see §4.3).

**File-action steps (§5.1) are gated *before* they apply.** Their effect is computed on
the main thread from the canonical workspace, without running anything, so the same
classification sees the diff while nothing has changed yet. A reject has nothing to roll
back and the interpreter keeps its variables. In approve-each mode a file step waits too,
reads included, because a read sends file content to the model. A committed file step is
pushed to the worker with its `write` op when the worker held exactly the previous
workspace; otherwise the next python step re-seeds it.

### 2.4 Checkpoints & rewind

- A checkpoint is taken after every committed step. Storage is content-addressed (a
  map from hash to bytes), so unchanged files are shared between checkpoints. Changed
  files are not: every version a checkpoint references stays in memory, and the
  workspace limit (256 MB) only bounds the current files.
- **Budget** (as built): between turns, once the versions that only checkpoints hold
  (not the workspace) pass 512 MB, the oldest checkpoints are dropped until they fit,
  never the newest 3. A dropped checkpoint becomes `null`, so timeline links keep their
  index; its card says rewind is unavailable, a note names what went, and its versions
  are freed (file chips then say the version is no longer held). Exports keep the gaps
  as `null` in `checkpoints/index.json`. The status bar shows the checkpoints left and
  the file contents held (workspace plus older versions), flagged from 75 % of the
  budget. A step's written versions are protected from garbage collection only until
  it is decided; before this they were protected for the whole session, so nothing
  was ever freed.
- **Rewind to step N** restores that workspace, truncates the timeline and the model
  history after N, and restarts the interpreter. The user can then retry, edit the
  task, or inject guidance.
- Checkpoints live in memory only. They leave the tab only via session export (§3).
- **➕ New** clears the timeline, the model history, the checkpoints and the interpreter.
  When the workspace has files it offers to keep them: kept files become user files
  (origin `user`), so changing them in the new session needs approval like any upload (§2.3).

---

## 3. Session import & export (required)

**Why:** the app never persists anything on its own. A file the user exports is the
only way to pause a task and resume it tomorrow, to hand a session to someone else for
review, or to keep an audit record of what an agent did. This follows HermitUI's chat
Export/Import (`src/script.js`, Export Chat / `parseChatExport`).

### 3.1 Format: one `.zip`

Markdown, which HermitUI's chat export uses, isn't enough here: workspaces contain
binary files, and HermitUI's own parser already documents delimiter-collision
limitations. The zip opens in any archive tool, so a session can be inspected without
the app.

```
hermit-agent-session-2026-10-03-14-30.zip
├── manifest.json      format id "hermit-agent-session", format version, app version, created-at
├── session.json       task, messages, steps, settings (see below)
├── transcript.md      human-readable log, HermitUI export style, for reading without the app
├── workspace/…        the current VFS as real files (paths preserved)
└── checkpoints/       optional (toggle at export time)
    ├── blobs/<hash>   content-addressed file contents not already in workspace/
    └── index.json     per-step file lists: path → hash, origin
```

`session.json` contains:
- the task, the system prompt and the full model message history;
- the **timeline**: every item the user saw, in order: the task, each step, user
  notes, answers and follow-ups, system notes and errors. Per step it holds
  reasoning, proposed code, the code that actually ran (if edited), output (stored
  untruncated), the per-file changes with hashes, the risk verdict and its reasons,
  the decision, who made it, and timestamps. *(Built as a timeline rather than a bare
  `steps` list, so an import can rebuild the exact view.)*
- per python step, `figures`: the figures captured from it (path, width, height, and
  whether `plt.show()` or the end of the step captured them), and per step
  `fileListSent`: how many files the periodic file list (§5.4) that followed it named;
- per file-action step, `fileActions`: tool, path, ok, message, the line range of a read
  and the old/new pairs of an edit. Written content isn't repeated: it is in the
  workspace and checkpoint blobs, which the step's file chips point to;
- file origins (`user`/`agent`) for the current workspace;
- autonomy level, step limit, timeout, max tokens, reasoning effort, auto-compaction
  threshold and context size;
- `compactions`: the full history each compaction replaced (§5.4), so rewind still
  works after an import. Checkpoints record their `epoch`;
- non-secret connection settings: base URL and model name. **The API key is never
  exported.**

**Workspace-only export** is a second option: a plain zip of the files, with no
session metadata.

**Nothing is lost by accident** *(as built)*. The session exists only in the tab, so
closing or reloading it asks first (`beforeunload`) while there is work no export holds:
a fingerprint of the session (timeline, history, compactions, checkpoints, workspace
version) is recorded at each session export or import and compared. A running agent
always counts; a workspace of uploads alone doesn't (you have those files). The status
bar's "⚠️ not exported" flag opens the export dialog. A workspace-only export clears the
flag only when there is no timeline.

### 3.2 Zip implementation

A small vanilla-JS zip writer and reader on the main thread, using
`CompressionStream("deflate-raw")` / `DecompressionStream("deflate-raw")` plus a CRC32
table. It needs no library. The alternative is Python's `zipfile` inside Pyodide,
which is rejected because import must work *before* the interpreter has booted, and
export must work after a Kill. ZIP64 is not needed in v1 because of the size limits
below.

### 3.3 Import rules

- **Untrusted input.** Check the format id and version. Validate `session.json`
  against the expected shape (unknown fields ignored, missing required ones fail
  loudly). Reject path traversal (`..`, absolute paths) in `workspace/`. Enforce size
  limits on total uncompressed bytes and file count, which also guards against zip
  bombs. Everything rendered goes through `DOMPurify.sanitize()`, exactly like live
  output.
- **Nothing executes on import.** The session restores in a **paused** state: the
  timeline is rebuilt, the workspace is seeded, and checkpoints are reloaded if
  present. The interpreter starts fresh, and the model is told so on resume.
- **Approvals don't carry over.** "Network allowed" and similar grants from the
  original session are not active in the new one.
- **Connection settings don't carry over either** *(MVP decision)*. Autonomy and
  limits are restored, but the base URL and model stay as the importing user set
  them; the import note names the endpoint the session was recorded against. A
  shared session must not silently send its contents to the sender's endpoint.
- **Confirm before replacing** a non-empty current session, mirroring HermitUI's
  `importConfirmModal`.
- **Version policy:** the reader accepts its own format version and older ones (with
  migrations). A newer version gets a clear "made with a newer HermitUI Agent" error.

### 3.4 Tests

- Unit test of the export → import round-trip (pure JS, in the style of
  `tests/export-import.test.mjs`). Cover binary files, empty directories, unicode
  file names, a session without `checkpoints/`, and rejection of traversal paths and
  oversized archives.
- End-to-end round-trip in a real browser (in the style of
  `tests/e2e_export_import.py`): run a short scripted session, export it, reload,
  import it, and compare the timeline and workspace.

---

## 4. Architecture

```
┌──────────────────────── main thread ────────────────────────┐      ┌──── Web Worker ────┐
│ UI (timeline, workspace panel, settings)                    │      │ Pyodide (WASM)     │
│ Agent loop  ──► LLM endpoint (OpenAI chat completions, SSE) │◄────►│ MEMFS /workspace   │
│ Canonical workspace + checkpoint store (content-addressed)  │ msgs │ runner: exec code, │
│ Session export/import (zip)                                 │      │ capture out, diff  │
└─────────────────────────────────────────────────────────────┘      └────────────────────┘
```

### 4.1 Main thread
- Owns the **canonical** copy of the workspace and all checkpoints. The worker is
  disposable.
- Runs the agent loop (§5), renders the UI, and does import/export.
- Treats every message from the worker as untrusted data. Agent code can reach the
  worker's JS globals through Pyodide's `js` module, so it could forge messages. The
  protocol is small and validated, and nothing the worker sends is ever evaluated.

### 4.2 Worker
- Boots Pyodide once. The working directory is `/workspace` on MEMFS.
- `run(code)`:
  1. capture stdout and stderr;
  2. execute in a persistent namespace, notebook-like, so variables survive between
     steps and the agent can build up state;
  3. scan `/workspace` and return the file listing with content hashes plus the bytes
     of changed files;
  4. return the result.
- Hashing and diffing happen in the worker, so only changed bytes cross the
  boundary.
- *As built:* before each step the harness drops every module loaded from
  `/workspace` from `sys.modules`, so an edited module is re-read (spike finding).
  `input()` raises instead of hanging, and `MPLBACKEND` selects the harness's inline
  backend (§8, matplotlib). Output is capped
  at the first 1 MB plus the last 64 KB per step. The main thread re-hashes every
  changed file it receives and refuses a result whose bytes don't match the
  worker's listing. A forged result can therefore only *hide* changes, which never
  reach the canonical workspace, so the next re-seed discards them.

### 4.3 Kill & re-seed
A clean interrupt (`pyodide.setInterruptBuffer`) needs `SharedArrayBuffer`, which
requires cross-origin isolation (COOP/COEP headers). Neither `file://` nor GitHub
Pages can provide that. The spike confirmed this for `file://` in Chromium and
Firefox; GitHub Pages is still unchecked. So:

- **Kill** calls `worker.terminate()`. That is always available and always effective.
- Spawn a new worker, boot Pyodide, and **re-seed** `/workspace` from the main-thread
  canonical copy (the last committed checkpoint).
- Tell the model: "The interpreter was restarted; variables are lost; files are
  intact."
- Measured in the spike: kill → fresh worker → workspace restored takes about 0.8 s
  in Chromium and Firefox, so there's no warm spare worker for now. If it is ever
  needed, posting a pre-compiled `WebAssembly.Module` to the new worker is the next
  lever.

### 4.4 Workspace in/out
- Upload with the file picker or drag-drop onto the workspace panel, including
  folders via `webkitdirectory` and `DataTransferItem.webkitGetAsEntry`. Uploaded
  files get origin `user`. *As built:* sizes are checked before anything is read: 50 MB
  in one go, one file of 25 MB or 500 files ask first (`uploadWarning`), saying that
  everything lives in tab memory, that changed versions are kept for rewinding, and
  whether it would exceed the workspace limit. A zip import asks the same way.
- Download a single file, or the whole workspace via the §3.2 zip writer.
- **Import a zip into the workspace** (📦 Import zip, or a plain zip given to the
  header 📂 Import): a workspace zip contributes all its files, and a session export
  only its `workspace/` folder. OS archive junk (`__MACOSX/`, `.DS_Store`) is
  skipped. It is read with the same untrusted `zipRead` as a session import, and the
  files go through the upload path, so the limits apply and they get origin `user`.
  If the workspace already has files, the user picks **Replace** or **Merge**.
  Merge overwrites files with the same name. The session itself is left alone.
- **Delete** a file or a whole folder from the tree, after a confirm. The worker is
  re-seeded before the next step. Checkpoints keep their blobs, so a rewind brings
  the files back. If a task is running, the model is told what was deleted with its
  next request.
- Deleting and replacing are refused while a step runs or waits for approval: a
  held step's commit was computed against the current files and could bring a
  deleted file back.

---

## 5. Agent loop & action format

### 5.1 Baseline: code-as-action
The model answers in one of three ways:
- reasoning plus **exactly one** ` ```python ` block, which is executed as one step;
- a final answer with no code block, which ends the task (the user can continue it
  with a follow-up);
- a question to the user (an `ask:` line), which pauses the loop until the user
  answers.

Why this is the baseline: it works with *any* chat model and any OpenAI-compatible
endpoint, needs no tool-calling support, and small models handle it far better than
JSON function calls. It is the pattern used by CodeAct and smolagents' CodeAgent.

Parsing rules:
- If there is more than one code block, only the first runs, and the model is told
  so.
- An unclosed block (the stream was cut) is treated as a failed step, not executed.
- Only fences tagged `python` (or `py`) run. Untagged and other fences (` ```text `)
  are prose, and the system prompt tells the model to show output that way. In the
  spike, an optional tag made the loop execute a bare fence the model used to quote a
  timestamp, which failed as a syntax error.
- *Added in Phase 2a:* `<python>…</python>` at the start of a line runs like a fence
  (a fence inside the tags is the code). Qwen3.8, trained on tool-call formats, answered
  with exactly that, and the reply used to count as a final answer that ended the task.
  A `<tool_call>` runs nothing; the model is told there are no tool calls here.
  *Phase 2b:* so does a guessed tool tag (`<run_python>`, `<bash>`, `<shell>`, …): in the
  2b success measurement Qwen3.8 once answered `<run_python>python process.py</run_python>`,
  which counted as a final answer and ended the task with nothing run.

**File actions** *(added after the MVP)*. Writing a file from Python means escaping its
source inside a string, changing one line means rewriting the file, and printing a file
runs into the observation truncation. So a reply can instead hold any number of file
actions, written as tags at the start of a line:

```
<read_file path="data.csv"/>                       numbered lines, 400 at a time
<read_file path="app.py" start="120" end="200"/>
<write_file path="report.md">
full content
</write_file>
<edit_file path="app.py">
<old>
exact current text
</old>
<new>
replacement
</new>
</edit_file>
```

- **Exclusive with code:** a reply holds file actions *or* one python block. A reply with
  both is answered with an error observation and nothing runs. Tags are taken out before
  the python fences are looked for, so a written README's ` ```python ` samples are
  content, not code. The one limit: content can't contain its own closing tag.
- **The executor** (`applyFileActions`) is separate from the parser
  (`extractFileActions`) and runs on the main thread against the canonical workspace.
  It works on an overlay, so a read sees an earlier write in the same reply. Writes and
  edits are **all-or-nothing**: the first one that fails stops the batch and nothing is
  written, and the model is told which action failed.
- **Edits** need each `<old>` to occur exactly once. No match, a match only when
  whitespace is ignored, and several matches are each reported with advice. `<old>` and
  `<new>` are adapted to a CRLF file.
- **Reads** are capped at 400 lines and 32 000 characters per read, 64 000 per reply,
  and 2 000 per line. They end with where to continue. Binary files are refused, so
  Python handles those; the refusal says what the file is (`binarySummary`: "PNG
  image, 640×480 px, RGBA, 18 KB"). File-step output skips the §5.2 truncation, because the reads
  are already capped.
- Gating is in §2.3.

### 5.2 Observations
Observations go back as a `user`-role message (OpenAI-schema compliant) in a fixed
envelope:

```
<observation step="4" status="ok|error|rejected|timeout">
stdout/stderr (truncated: first 2 KB + last 4 KB, with "[… 18 KB omitted …]")
files changed: +report.md  ~data/clean.csv  -tmp/
</observation>
```

The full, untruncated output stays in the UI and in the session export. Tracebacks
are trimmed to the last frames plus the exception line.

### 5.3 System prompt contract
The system prompt describes:
- the environment: Pyodide (CPython in WASM), `/workspace` as the working
  directory, which packages are available and which can be loaded, no network,
  `input()` not available;
- the response format of §5.1;
- the rules: inspect before modifying, keep outputs short (print summaries, not whole
  files), save deliverables as files, and how plots are captured.

The user's custom instructions are appended after it, like HermitUI personas.

*Added 2026-10-06:* if the workspace has an `AGENTS.md`, the agent is told to read it
before it starts and follow it, unless it conflicts with the task or the prompt's rules.
That's the common convention for a project's agent instructions. It is still an
uploaded file: whatever it asks for goes through the same gating (§2.3).

*As built:* the prompt lists every package Pyodide can load, plus the bundled libraries
(§8, Phase 3.5), by import name (about 300
names, ~1k tokens, read from the inlined `pyodide-lock.json`: real packages only, no
shared libraries, `*-tests` or `_private` names). Nor `micropip`: it installs at run time, which agent code can't (no network), and with it on the list the agent was seen reaching for `micropip.install` instead of a plain import, which failed (2026-10-05). A package loads by being imported; an `import micropip` gets that advice. Before the core is read it names a
few examples instead. It costs a fixed prefix the server caches, and it stops the model
from reaching for `requests` or `pip`.

### 5.4 Context management
- Older observations are progressively elided ("[step 3 output elided; see
  workspace]") while the last *K* stay in full.
- When the history nears the context window, summarise older turns. HermitUI already
  has a summarise flow (`summarizeBtn`) to adapt.
- The current file listing is re-sent in compact form every few steps so the model
  doesn't rely on stale memory of the workspace.

*As built: elision.* `elideHistory` shortens what is *sent*, never the history: in steps
older than the kept tail, an observation body over 2,000 characters keeps its first and
last 600 (its envelope, the files-changed line and the notes sit at the end, so they
survive) with a note that says how much of which step was elided, and a `<write_file>`
body over 2,000 characters becomes a one-line placeholder (the file is in /workspace).
The last 4–7 steps are sent in full: the boundary moves in blocks of 4 steps, so for
4 requests in a row the prompt prefix is byte-identical and llama.cpp can reuse its
prompt cache (a boundary that moved every step would make it re-read the tail every
time). The token estimate, the compaction trigger and the context gauge all measure
the elided request; the summariser reads the full history.

*As built (Phase 2b): the periodic file listing.* Every 5th step (`LIMITS.fileListEvery`),
"Files in /workspace now: …" (names and sizes, sorted, at most 50) follows that step's
observation in the same user message, but only when the workspace changed since the
model last got a list: the task message and every compaction carry one, so they reset
the comparison, while a rewind, an import or ➕ New clear it, so the next due step sends
one. It goes into the history like the observation it follows, so the prompt prefix
stays cacheable and elision (which only shortens observation bodies) leaves it alone.
The step card says it was sent, and the debug console logs it.

*As built (auto-compaction):*
- **Setting:** *Auto-compact at (%)*, default 85, 0 = off, and *Context size*, default
  0 = what the server reports. Both are exported with the session. The reported size is
  probed in this order: llama.cpp's `/props` (`n_ctx`), Ollama's `/api/show` (`num_ctx`,
  only when the model sets one: Ollama doesn't report its default), then the model list,
  `/v1/models` and LM Studio's `/api/v0/models`, read for the configured model:
  vLLM's `max_model_len`, LM Studio's `loaded_context_length` (not its
  `max_context_length`, the model's maximum), or `context_length` / `context_window`
  (OpenRouter, Together, Groq). llama.cpp's `meta.n_ctx_train` is the trained size, not
  the server's, and is ignored. Test Connection shows the size and where it came from,
  or says to set it.
- **Compact button** (🗜️, in the composer, between runs once there are at least two
  steps): compacts now (reason `manual`), as far as needed like the fallbacks, and
  returns to the status it had. Stop aborts it.
- **Trigger:** before each request, the prompt is estimated as characters times the
  tokens per character the previous request measured (`prompt_tokens` / characters
  sent, or 1/3.5 before the first). It compacts at the threshold if at least 2 steps lie
  outside the kept tail, so it can't fire every turn. It also compacts once the
  estimate leaves less room than *Max tokens / reply* (capped at half the context):
  llama.cpp (context shift off, its default) silently ends a reply when prompt plus
  reply reach `n_ctx`, so without this reserve the reply budget shrank with every step
  — at 85 % of a 50k context only ~7.5k tokens were left, less than the 8k default.
  With no known context size, only the fallbacks apply: a context-overflow error
  compacts once, as far as needed (down to keeping one step), and retries the request.
- **Context-cut replies:** that silent end is reported as `finish_reason: "length"`,
  exactly like `max_tokens` (verified against llama.cpp: `max_tokens` 8192, reply
  stopped at 770 with prompt + reply = `n_ctx` − 2). A "length" reply whose prompt plus
  completion reached the server's `n_ctx` (or, with `n_ctx` unknown, that stayed under
  `max_tokens`) is a context cut: the step says so, the model is told the context ran
  out rather than to reason less, and the next turn compacts first, as far as needed
  (reason `context`), regardless of the threshold.
- **Mechanism:** one extra request to the same endpoint, with a fixed summariser prompt.
  The headings are Task, Done so far, Files, Interpreter state, Errors and dead ends, and
  Next. Observations in it are clipped to 1.5 + 1.5 KB. The history becomes the system
  prompt, then the task message with `<history_summary steps="1-K">…</history_summary>`
  and the current file list appended, then the last 4 steps verbatim. The kept tail
  starts at an assistant message, so roles still alternate. A later compaction
  folds the earlier summary in. A failed or empty summary leaves the history unchanged,
  with a warning, and the threshold trigger then waits 2 steps.
- **Timeline:** a 🗜️ card shows the step range, the token estimate before and after, and
  the summary (sanitized Markdown). The status bar shows "compacting history…". Stop
  aborts it.
- **Rewind:** `session.compactions[i].before` keeps the full history each compaction
  replaced, and a checkpoint records its `epoch` (the number of compactions so far).
  Rewinding to an earlier epoch restores that history first, then truncates it as usual.

### 5.5 Endpoint failures: retry, then pause *(added in Phase 2a)*
- **What is retried** (`isRetryableError`): a network error (the server is down or
  restarting), a 408, 429 or 5xx other than 501/505, a stream that ends without a
  `finish_reason` or `[DONE]` (the connection dropped mid-reply), an empty answer, and a
  stream that goes silent for 3 minutes *after* data started flowing (before the first
  token, prompt processing can legitimately take that long, so there is no watchdog
  then). Not retried: other 4xx, a prompt too long for the context (that compacts
  instead), and a non-JSON answer.
- **How:** `requestWithRetry` waits 2, 4, 8, 16, then 30 s between attempts, for up to
  2 minutes in all. The step card says it is retrying, the status bar counts down, and
  Stop ends the wait at once. A retry starts the reply over: what streamed before the
  drop is discarded. A step that needed retries says so on its card ("answered again
  after 3 retries"), and that note is exported. The compaction request retries the
  same way.
- **Then pause, not end:** when the window is used up, an error card explains, with
  agent wording (`chatErrorHint` with `retriedMs`), that the run is paused and nothing
  is lost, and the run is `paused`: Retry on the card or ⏯ Continue resumes it exactly
  where it stopped, with the history unchanged. Probing the endpoint (`/props` & co.)
  while it is down isn't cached, so the context size is found again once it is back.
- **Context overflow** that compaction can't fix, or with auto-compaction off, gets its
  own advice (lower Max tokens / reply, or press 🗜️ Compact / turn it on).

### 5.6 Native tool calls *(built in Phase 3)*
When the endpoint supports OpenAI `tools`, offer `run_python(code)`,
`ask_user(question)` and `finish(answer)` as tools. The executor, gating and timeline
are identical; only the parsing layer changes. Auto-detect support (as HermitUI
probes reasoning support), with code-as-action as the fallback.

The file actions are ready for this. The tag names are the tool names, and the parser
already emits the shape a tool call will produce, `{ tool, args }`, which
`applyFileActions` consumes:

| Tool | Arguments |
|---|---|
| `read_file` | `path` (string), `start_line`, `end_line` (integers ≥ 1, optional) |
| `write_file` | `path`, `content` (strings) |
| `edit_file` | `path` (string), `edits`: array of `{ old_text, new_text }` |

*As built (Phase 3):*
- **Setting:** Settings → *Actions*: **Auto** (default), *Native tool calls*, or *Code blocks
  and tags*. Auto goes native only on a positive report, because a server that silently
  ignores `tools` would leave the model with no way to act: llama.cpp's `/props`
  (`chat_template_caps.supports_tool_calls`, else a template that references `tools`),
  Ollama's `/api/show` (`capabilities` contains `"tools"`, else a template with `.Tools`),
  or a model list's `supported_parameters` (OpenRouter). It is the same probe that reads
  the reasoning levels and the context size; Test Connection shows what it found. A
  header badge beside 🏠 local says which one the next request uses: 🔧 native, 📝 text,
  or 🔧 auto until the endpoint has been probed (before the first request, or by Test
  Connection of the saved endpoint).
- **Request:** the six tools, `parallel_tool_calls: true`, otherwise unchanged. The system
  prompt keeps the environment section and swaps the response-format section for one that
  describes the tools; `S.protocol` records which one `messages[0]` holds, and it is
  switched (`syncSystemPrompt`) when the next request uses the other protocol.
- **Fallback:** a request refused because of `tools` (a 400/404/422/500/501 whose message
  names tools, tool choice, tool calls or function calls: llama.cpp without `--jinja`,
  vLLM without `--enable-auto-tool-choice`, an Ollama model without tool support, an
  OpenRouter route without one) is not retried: that endpoint switches to code-as-action
  until its URL or model changes, a note says so, and the turn is asked again.
- **One reply = one step** (`parseToolCalls`), the same kinds as `parseReply`: the first
  *action* call decides. A `run_python` runs alone; a file tool runs together with the file
  calls right after it, as one all-or-nothing batch (§5.1). `finish` and `ask_user` count
  only in a reply without action calls. Every call that doesn't run gets its own result
  saying why (a second `run_python`, a file call next to code, `finish` next to actions, an
  unknown tool with no-shell advice). `run_python` without code, or only unknown calls,
  runs nothing (`badcall`). Arguments that aren't a JSON object are dropped from the
  history (servers re-parse stored arguments when they render the prompt) and named in a
  note; cut off by the token limit, the step is `cutoff`. Calls without an id, or with a
  repeated one, get a generated 9-character alphanumeric id (the strictest APIs want that).
- **A reply without calls** is read like a code-as-action reply, except that a ```python
  fence, a file tag or a `<tool_call>` written as text runs nothing (`textaction`) and is
  told to call the tool: plain text is the final answer, and a final answer may show
  sample code. An `ask:` line still asks.
- **History:** real OpenAI messages: the assistant message carries `tool_calls`, and each
  call gets a `tool` message with its observation envelope (§5.2); a file batch answers
  each call with its own read/write/edit result, the step's file changes and notes going
  with the last one. `finish` and `ask_user` stay unanswered until the user replies:
  `ask_user`'s result *is* the answer; `finish` gets "Your final answer was shown to the
  user" and the follow-up comes as a user message. Notes and the periodic file list after
  tool results are user messages. Elision shortens old `write_file` arguments (still valid
  JSON) and old tool results; the summariser and a code-as-action request see the calls
  written out as blocks and tags (`toolHistoryAsText`), so a fallback or a switch of the
  setting mid-session works on the same history.
- **Same executor, gating, timeline and export:** a native step runs through
  `executeStep` / `executeFileStep` like any other and gets a 🔧 badge; while it streams,
  the card says which tool is being called. Session format 2 adds `tool_calls`, `tool`
  messages, `protocol` (session and step) and `skippedCalls`; format 1 still imports.

---

## 6. Model guidance

- **External endpoint first.** Agent loops need a model that recovers from its own errors.
  Practical options are a local llama.cpp server (`--jinja`) or Ollama with a capable
  coder or instruct model, or any cloud OpenAI-compatible API. Model-specific advice
  goes in the README once real tasks have been tried. No claims before then.
- **In-browser (wllama), later.** HermitUI's benchmark numbers (root `AGENTS.md`,
  dev machine, July 2026) give the realistic floor. Qwen3 0.6B/1.7B are too weak for
  multi-step work. 4B is marginal. gpt-oss-20b loads via Memory64 and decodes at
  ≈ 43 t/s on GPU, which makes it the most plausible fully offline agent model.
  CPU-only devices will likely not run a usable agent model.
- The reasoning-effort control (Off/Low/Med/High) carries over unchanged.

---

## 7. Constraints carried over from HermitUI

These are non-negotiable. See the root [`AGENTS.md`](../AGENTS.md).

- **Single HTML file** as the deliverable (`dist/hermit-agent-standalone.html`), built
  from split sources by a Python `build.py`.
- **Vanilla only:** no frameworks, no CSS frameworks, no npm or bundlers.
- **Strict ephemerality:** no `localStorage`, `IndexedDB` or cookies. Pyodide's MEMFS
  is fine because it is RAM. **IDBFS is forbidden.** OPFS too: the same reasoning as
  HermitUI's ban on wllama's `loadModelFromUrl` applies to Pyodide's package cache.
- **DOMPurify** on everything model-generated or imported that is rendered as HTML or
  Markdown.
- **OpenAI chat completions schema** for all LLM traffic.
- Glassmorphism look, the Inter font, CSS variables with `data-theme`, a fluid layout
  without media queries where possible. The workspace panel collapses into a drawer on
  narrow screens using flexbox wrapping, not breakpoints.

---

## 8. Packaging & the biggest risk

**Risk #1: booting Pyodide from a single HTML file on `file://` with no server.**
Pyodide normally fetches several files relative to its `indexURL`: the loader JS, the
`.wasm`, the stdlib zip and the lock file.

Verified in the spike ([PHASE0_FINDINGS.md](PHASE0_FINDINGS.md), "Offline boot
findings"). This works from `file://` in Chromium and Firefox with **Pyodide 0.29.x**,
because 0.29.x still runs in a *classic* worker and Chromium won't start a Blob
*module* worker on `file://`.
Pyodide 314+ is module-worker-only, so moving to it requires patching that check.
- `build.py` downloads a **pinned** Pyodide release and inlines the core files as
  gzip + base64. This is the same technique HermitUI uses for Mermaid
  (`window.__MERMAID_INLINE__`) and the wllama engine (`window.__WLLAMA_INLINE__`),
  inflated in-browser with `DecompressionStream` (`gunzipToBytes`).
- The worker is a classic worker created from a Blob URL. The main thread inflates
  the core once and posts copies at each boot. Inside the worker, `pyodide.js` and
  `pyodide.asm.js` are loaded with `importScripts()` on worker-made Blob URLs. The
  loader skips its own script load when `_createPyodideModule` already exists.
  `loadPyodide` gets a fake `indexURL`, and a worker-side `fetch` shim serves
  `pyodide.asm.wasm` (as `application/wasm`), `python_stdlib.zip` and
  `pyodide-lock.json` from the inlined bytes. `packageBaseUrl` points at the pinned
  CDN.
- Measured: the core is 12.3 MB raw and **7.3 MB inlined**, plus HermitUI's existing
  libraries. Boot takes about 1 s (new worker to Python ready) in Chromium and Firefox,
  plus 0.2–0.35 s to inflate once per page load. Memory after boot is 20 MB of WASM.

**Packages** (numpy, pandas, matplotlib, …):
- Default: load on demand from the **pinned** Pyodide CDN. Verified from `file://`:
  numpy loads in about 0.5 s and leaves IndexedDB, OPFS and Cache Storage empty. The
  app must not call `navigator.storage.getDirectory()` or `caches.keys()` itself,
  because just probing them makes Firefox create storage. Before a step runs, the
  harness detects imports (`pyodide.code.find_imports`) and loads the needed packages
  through the harness, never through agent code, then shows "loaded pandas" in the
  timeline. They are held in memory only, never in a persistent cache.
- Later, optionally: an "offline pack" build that inlines a curated set at a much
  larger file size.
- If packages can't load (offline), the step fails with a clear observation, and the
  model is told which packages are available.

*As built (Phase 2a):*
- **Loading is its own phase.** Before a step runs, the worker reports what the code
  imports (`find_imports`) and what is loaded; the main thread maps imports to packages
  with the lock file. The workspace `.py` files the step uses count too
  (`referencedPythonFiles`: modules it imports, files it names, e.g. for
  `runpy.run_path("make_report.py")`, and in turn the ones those use): a step that only
  runs a script imports nothing itself, and its packages used to stay unloaded. If anything has to be downloaded, the status bar says "loading
  numpy, pandas…", the debug console logs it, and a separate `load` call fetches them
  with the network limited to the pinned CDN (`cdn` mode, §10) and its own 2-minute time
  limit, so a slow CDN doesn't eat the step's timeout. The code then runs with the
  network closed. The step notes "Loaded numpy, pandas from the Pyodide CDN (1.2 s)".
- **When a package fails, the code doesn't run.** The step fails with a message that
  says why: the browser is offline; the CDN couldn't be reached; the download was
  redirected outside the CDN (a tampered registry, §10); or the loader's own error. It
  adds that the standard library and packages loaded earlier still work.
- **An import nothing can provide** (`ModuleNotFoundError` for a name that isn't in the
  distribution) gets a note: there is no pip; use the standard library or a listed
  package. A package that exists but wasn't loaded (an import built at run time) gets
  "add `import x` to the step's own code", and Pyodide's own advice in the traceback,
  "await micropip.install(…)", is replaced in the output: agent code can't download.
- **Libraries for common jobs** (in the system prompt, both protocols): pandas for
  tables, openpyxl or xlsxwriter for Excel (and pandas `read_excel`/`to_excel`),
  python-docx for Word, python-pptx for PowerPoint, pymupdf for creating and reading PDFs
  (`insert_htmlbox` lays out HTML; there is no reportlab or fpdf), matplotlib or seaborn
  for charts, markdown and markdownify between Markdown and HTML, tabulate for plain-text
  tables, qrcode, Pillow, jinja2, beautifulsoup4/lxml and xmltodict, python-dateutil,
  pyyaml, sqlite3; and "don't assemble these file formats by hand". Without such a line the
  agent was seen assembling a PDF by hand. Until Phase 3.5 the line said nothing here
  writes `.xlsx`, `.docx` or `.pptx`.

*As built (Phase 3.5): bundled pure-Python libraries.* Pyodide leaves pure-Python
packages to micropip and PyPI, which agent code can't reach. Ten are bundled in the HTML,
picked by [PHASE3_5_LIBRARY_STUDY.md](PHASE3_5_LIBRARY_STUDY.md) (Tier 1 and Tier 2):
openpyxl (with et-xmlfile), XlsxWriter, python-docx, python-pptx, Markdown, qrcode,
tabulate, xmltodict, markdownify, seaborn: 11 wheels, 1.69 MB, +2.27 MB on the file once
base64-encoded.
- **One manifest**, `BUNDLED_LIBRARIES` in `src/script.js` (strict JSON between
  `@bundled:start`/`@bundled:end`): per library its import names, `uses` (words that need
  it without an import), the bundled libraries it requires, the Pyodide packages it
  imports (by lock-file name), and its wheels pinned by URL and sha256.
- **`build.py`** reads the manifest, downloads each wheel from files.pythonhosted.org,
  checks its sha256, and checks it against its own metadata: a pure wheel, a license file
  in its `.dist-info` (the wheels are inlined unmodified, so each carries its license
  text), every `Requires-Dist` that applies in Pyodide either bundled with it or in its
  Pyodide list, its import names present, and no clash with a Pyodide package. The wheels
  are inlined base64-encoded as `window.__HERMIT_WHEELS__` (gzip saves 3 % on wheels,
  which are zips already; a solid archive would save ~14 % but lose the pinned
  per-wheel artefacts). The unbuilt source fetches the same wheels from PyPI instead,
  checked against the same hashes.
- **Installed on first use, in the loading phase.** `planBundledLoad` adds to a step's
  plan the libraries its imports (and those of the workspace files it uses) name, the
  ones whose `uses` words appear in its code (pandas imports openpyxl, XlsxWriter and
  tabulate itself: `to_excel`, `read_excel`, `ExcelWriter`, `engine="xlsxwriter"`,
  `to_markdown`), the bundled libraries those require (XlsxWriter for python-pptx's
  charts), and the Pyodide packages they import, some undeclared or optional extras
  (lxml, typing-extensions, Pillow, beautifulsoup4, six, numpy/pandas/matplotlib). The
  `load` call first loads those Pyodide packages from the CDN, then unpacks the wheels,
  sent with the request, into site-packages like pip (MEMFS: gone with the worker). A
  restarted worker installs them again from the page's copy. The step notes "Loaded lxml
  from the Pyodide CDN and python-docx from the libraries bundled with HermitUI Agent".
  If a Pyodide package fails, the libraries aren't installed, so a later step retries both.
- **Offline:** openpyxl, XlsxWriter, Markdown, tabulate and xmltodict need nothing else and
  work with no network at all. python-docx and python-pptx need lxml (and Pillow), qrcode
  Pillow for PNGs, markdownify beautifulsoup4, seaborn numpy, pandas and matplotlib: those
  come from the CDN like any Pyodide package, so offline they fail with the usual message.
  Inlining those too is the "offline pack" question (below: not for now, revisit with
  Phase 4).
- **A bundled import the harness couldn't see** (built at run time) fails with a plain
  `ModuleNotFoundError`, since Pyodide knows nothing about these: the step gets "add
  `import docx` to the step's own code", as for an unloaded Pyodide package. pandas'
  "Missing optional dependency 'openpyxl'" gets the same advice.
- **Offline: decided, no offline pack for now.** Inlining even numpy + pandas would
  roughly double the 9 MB file, and a curated set would still miss what a given task
  needs. Packages load from the CDN on first import and stay in memory for the tab's
  life (§7: never a persistent cache); offline, the failure is explicit and the model
  is steered to the standard library. Revisit with Phase 4 (fully offline wllama),
  where an "offline pack" build flavor would pay off.

**matplotlib:** force the `Agg` backend. `plt.show()` is patched to save to
`/workspace/figures/step-N-k.png` and render it inline in the timeline.

*As built (Phase 2b):*
- `MPLBACKEND=module://hermit_inline` selects a backend the harness writes to
  `/hermit/hermit_inline.py` (outside `/workspace`, so it is no workspace file): Agg's
  canvas, whose `show()` hands every open figure to the harness. That one saves each as
  `figures/step-N-K.png` (K counts within the step) and closes it, like a notebook's
  inline backend: a `show()` per figure in a loop gives one image each.
- **At the end of every step** (a failed one too) figures still open are saved the
  same way and closed. That also covers an agent that picked a backend itself
  (`matplotlib.use("Agg")`, where `show()` does nothing), and code that never calls
  `show()`.
- **A figure the agent saved itself isn't saved twice.** An import hook marks
  `Figure.savefig` from the moment `matplotlib.figure` is first imported, whichever
  backend is active; a figure saved that way is closed without a capture, and its own
  file is shown on the card instead. Empty figures are skipped. The prompt warns that a
  `savefig` *after* `show()` saves an empty figure (the notebook rule).
- The worker reports the figures with the run result (path, size, `show` or `end`);
  the main thread keeps only those whose file exists and is a change of the step.
  The model is told which figures the user was shown, and that it can't see images;
  other binary files the step wrote get their summary (`binaryFileNotes`).
- The figures are ordinary agent files: checkpointed, gated, exported, rewindable.

---

## 9. Reuse map from HermitUI

All of these exist in `../src/script.js` (verified 2026-10-03). For now they are
*copied and adapted*, not imported (see §11).

| Need | HermitUI source |
|---|---|
| Streaming LLM calls, abort | `fetchAndStreamChat`, `createThrottle` |
| Think blocks | `parseThinkSegments` |
| Markdown / highlight / copy rendering | `updateMessageUI`, `appendMessage`, `injectCopyButtons` |
| Error advice | `chatErrorHint`, `chatErrorHtml` (pure, unit-tested) |
| Endpoint handling | `normalizeApiUrl`, `apiRoot`, `detectCloudProvider`, the Test Connection flow (`testConnectionBtn`) |
| Reasoning effort | `setThinkingLevel`, `buildReasoningParams`, `probeReasoningSupport` |
| Files in | `processFiles`, `isTextFile`, `renderChips` |
| UI helpers | `showToast`, `escapeHtml`, `copyToClipboard`, `trapModalFocus`, `openModalEl` |
| Import confirm pattern | `importConfirmModal` flow |
| Inline decompression | `gunzipToBytes`, the Blob-URL loading of the inlined wllama engine |
| Build | `../build.py`: pinned downloads with SRI verification, regex CDN substitution, gzip+base64 inlining, `@wllama` marker stripping |
| Tests | `../tests/extract.mjs` (slice real functions out of the source), `tests/run.mjs`, the Playwright e2e style |

---

## 10. Security

**The threat model is a misbehaving model**: confused, prompt-injected by a file's
contents, or simply wrong. The sandbox is the primary defence, and approval gating
is the second.

- **Code execution:** agent code runs only inside the worker's WASM interpreter. It
  can't touch the real file system, other tabs or the main thread's DOM.
- **Exfiltration is the real risk.** Through Pyodide's `js` module, agent code can
  reach the worker's `fetch`, `XMLHttpRequest`, `WebSocket`, `importScripts`, dynamic
  `import()` and nested `Worker`. Defences, from weakest to strongest *(verify in
  spike)*:
  1. Delete or replace those globals in the worker after Pyodide and its packages
     have loaded. This is defence in depth only, and not airtight: dynamic `import()`
     can't be removed.
  2. A Content-Security-Policy. Blob-URL workers inherit the document's CSP, so a
     `connect-src` / `script-src` policy can block outbound requests. The hard part
     is that the LLM endpoint is user-configured at runtime, while a `<meta>` CSP can
     only be tightened later, never loosened. Options to evaluate: insert the CSP
     once the endpoint is set (changing the endpoint then needs a reload), or route
     package loading and the LLM call strictly through the main thread and give the
     worker a CSP of its own.
  - The UI must say plainly how strong the guarantee is that the spike establishes.
    Don't claim "no network" if it is only best-effort.

  **As built and measured (2026-10-03, `tests/e2e_agent.py`, Chromium 149, Firefox
  151 (Playwright), stock Firefox 157).** Both layers are in place:
  1. The worker replaces `fetch`, `importScripts`, `XMLHttpRequest.prototype.open`,
     `WebSocket`, `WebSocketStream`, `EventSource`, `WebTransport`, `Worker`,
     `SharedWorker` and `BroadcastChannel` on the global object and its prototype
     chain, with non-writable, non-configurable properties. The constructors'
     `prototype.constructor` back-references are replaced too. `caches`,
     `indexedDB` and `navigator.storage` are disabled, which also enforces the
     ephemerality rule against agent code. The real `fetch` lives only in a closure.
  2. The built file carries a strict CSP: `script-src 'unsafe-inline'
     'wasm-unsafe-eval' blob:`, with no remote host and no `'unsafe-eval'`. Blob
     workers inherit it in both engines. This blocks `import("https://…")` even
     from a blob script, as well as `eval` and `Function`. Pyodide 0.29.5 boots
     without `'unsafe-eval'`. `connect-src` stays open (`*`), because the endpoint
     is user-configured.
  3. Network modes: `closed` while agent code runs; `cdn` while the harness loads
     packages, where only URLs under the pinned Pyodide CDN pass; `open` only for
     a step the user re-ran with "Allow network". (Since Phase 2a the packages load
     in a worker call of their own before the step, §8; the modes are unchanged.) The `cdn` mode closes a real
     hole. Agent code can rewrite Pyodide's package registry
     (`pyodide_js._api.lockfile_packages[...].file_name`), and Pyodide then
     fetches an absolute URL as-is the next time that package is imported, with
     the harness's network window open. This was verified: the poisoned load
     reached the guard, which refused it.

  All 17 probes are blocked and recorded, in every engine tested, and the mock
  endpoint received **no** request. The probes: `pyfetch`, `js.fetch`, the
  prototype's `fetch`, `open_url` (sync XHR), XHR, `WebSocket` (also via
  `prototype.constructor`), `EventSource`, `importScripts`, a nested `Worker`,
  `eval`, `Function`, dynamic `import()` via a blob script,
  `pyodide.loadPackage(url)`, `caches`, `indexedDB`, OPFS, and a poisoned package
  registry. **Still best-effort**: it is a denylist over a large API surface, a new
  browser API could open a path, and the unbuilt dev source has a looser CSP (CDN
  hosts). The UI says "blocked on a best-effort basis" and nothing stronger.
- **Prompt injection** via uploaded files ("ignore previous instructions, delete
  everything") is expected. Effect gating limits the damage: deleting user files
  needs approval, and network is blocked.
- **Rendering:** all model output and imported session content goes through DOMPurify,
  and code is shown as text, never as HTML.
- **Secrets:** the API key is held in memory only, never exported, and never visible
  to the worker.

---

## 11. Project layout & merge path

Future layout of this folder:

```
hermit-agent/
├── README.md  DESIGN.md  ROADMAP.md  PHASE0_FINDINGS.md  AGENTS.md
├── src/          index.html, style.css, script.js, worker.js (inlined at build)
├── build.py      own build; may import helpers from ../build.py later
├── tests/        run.mjs + unit tests, e2e tests
└── dist/         hermit-agent-standalone.html (committed, like HermitUI's dist/)
```

- **Sharing code:** copy and adapt from `../src/` for now. Keep a "copied from
  HermitUI" list (function, source commit) in `AGENTS.md` so fixes can be carried
  over in either direction. Don't import across folders until the merge decision.
- **The root build is unaffected:** `../build.py` never reads `hermit-agent/`, and
  GitHub Pages keeps serving the root `index.html`. The agent's `dist/` will be
  reachable at `…/HermitUI/hermit-agent/dist/hermit-agent-standalone.html` for free.
- **Merge criteria (later):** once the MVP is stable, decide between:
  - (a) a HermitUI build flavor via `@agent:start/@agent:end` marker blocks (like
    wllama);
  - (b) an "Agent mode" inside the main app;
  - (c) staying separate.

  Decide based on how much code has diverged and on the size cost to the main app.

---

## 12. Roadmap summary

See [ROADMAP.md](ROADMAP.md) for checklists and exit criteria.

0. **Spike:** Pyodide from `file://` in a Blob worker, kill & re-seed, network
   blocking, size and boot time.
1. **MVP:** external-endpoint backend, code-as-action loop, timeline, workspace panel,
   effect-based gating, checkpoints & rewind, **session import/export**.
2. **Polish:** diffs, plots, package UX, context management. (Mobile moved to a later
   phase, see ROADMAP.md.)
3. **Native tool calls.**
4. **wllama flavor:** fully offline.
5. **Merge decision.**

---

## 13. Open questions

- ~~Which packages, if any, to inline for offline use, and what file size is
  acceptable?~~ *Decided in Phase 2a: none for now (§8); revisit with Phase 4.*
- Workspace limits: max total size and max file count. Browser tab memory is the real
  ceiling. *(MVP: 5,000 files / 256 MB; an import is capped at 20,000 entries /
  512 MB unpacked. Not yet measured against real tab memory.)*
- Diff UI for many files at once: summary first, then per-file?
- How should a step that ran fine but whose *output* reveals something sensitive be
  handled? Output already reaches the model before the user sees it in auto mode.
- Should the interpreter be persistent (notebook-like, the current plan) or fresh per
  step (simpler, rollback-consistent, but the agent must re-load data every step)?
- Multiple tasks per session, or one task per session with follow-ups?
- Does the step-approval UI need keyboard shortcuts (Enter = run, Esc = reject) from
  day one?
