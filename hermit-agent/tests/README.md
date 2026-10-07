# Tests

Same approach as HermitUI's `../../tests/`: no test runner, no `package.json`, no
dependencies to install for the unit half.

```bash
node tests/run.mjs                                              # unit tests (all *.test.mjs)
python3 build.py && ../benchmark/.venv/bin/python tests/e2e_agent.py [chromium] [firefox] [firefox=/path/to/stock/firefox]
../benchmark/.venv/bin/python tests/e2e_reference.py --base-url http://localhost:8080/v1 [--runs 3] [--tool-mode native|text]
../benchmark/.venv/bin/python tests/e2e_longrun.py --base-url http://localhost:8080/v1 [--runs 5]
```

`E2E_ONLY=outage,diff_edit …` runs only the named e2e scenarios (the names are in
`main()` of `e2e_agent.py`).

## Unit tests (pure logic)

`extract.mjs` slices the real functions out of `src/script.js` by name and evaluates
them, so the tests exercise shipped code. Renaming one fails the suite loudly; update
the `FUNCS` list with the rename. Only DOM-free code can be covered this way.

- **`agent.test.mjs`** covers:
  - `parseReply`: only `python`-tagged fences run, the first block wins, and
    unclosed blocks, cut-offs, `ask:`, empty replies and final answers are handled.
    Includes the spike's bare-fence bug, and `<python>…</python>` tags (Qwen3.8 wrote
    those instead of a fence), `<tool_call>` replies and guessed tool tags
    (`<run_python>`, `<execute>`, `<run script="x.py"/>`), alone or next to file actions.
  - `splitReply`, `truncateOutput` (2 KB + 4 KB), `diffListings`, `formatChanges`.
  - `classifyEffect`: every row of the DESIGN §2.3 table.
  - `buildObservation`: the §5.2 envelope.
  - `appendToLastUserMessage` (never two user messages in a row), the path rules,
    `makeFence`.
  - The helpers copied from HermitUI: reasoning params and chat error hints.
  - The prompts, and that the JS sha256 fallback matches WebCrypto.
  - The per-step model stats: `buildStepStats` (server `timings` over the page
    clock, token fallbacks, garbage input), `formatStepStats`, `cleanStepStats`.
  - Context compaction: the token estimate, context size and threshold, the cut
    point (kept tail, minimum steps, forced), the summariser request (clipped, with the
    earlier summary), the compacted history (roles alternate, one summary block, the
    file list), and the overflow-error matcher.
- **`archive.test.mjs`** covers:
  - CRC32, and the zip round-trip (binary, unicode names, empty files).
  - The untrusted-input rules: traversal, absolute and backslash paths, CRC
    mismatch, size and entry limits, an entry that inflates past its declared size,
    directory entries.
  - The session archive round-trip, with and without checkpoints, including that
    runtime-only fields and the API key never reach the export.
  - Tampering: a wrong checkpoint blob, missing content, an index pointing past the
    session, a missing manifest, a newer format version, broken JSON.
  - `validateSession` coercion and defaults.
  - Compactions and checkpoint epochs: round-trip, tampering, and older exports
    without them.
  - `workspaceEntriesFromZip`: a workspace zip, OS junk, a session export's
    `workspace/` files, and foreign or broken `manifest.json`s.
- **`reliability.test.mjs`** covers Phase 2a:
  - `lineDiff` (300 fuzz cases: the ops rebuild both texts, and the diff is minimal
    against an LCS) and `diffHunks` (context, merging, line numbers).
  - `elideHistory`: the block boundary, what an elided observation keeps, write_file
    bodies, short outputs untouched, the history itself unchanged.
  - `isRetryableError`, `retryDelayMs`, and `chatErrorHint`'s agent wording (paused after
    retries, overflow with and without auto-compaction).
  - `contextGauge`, `uploadWarning`.
  - Packages: `packageImportNames` and `importPackageIndex` (also against the real lock
    file), the system prompt's list, `packageFailureMessage` (offline, CDN down,
    redirected outside the CDN), `moduleNotFoundHint`.
  - `readEntry` on a fake dropped folder read in batches, and the exported retry note.
- **`richoutput.test.mjs`** covers Phase 2b:
  - `describeBinary` on hand-built headers (PNG, a progressive JPEG behind other
    segments, GIF, the three WebP kinds, a top-down BMP, `.npy`, a pickle, PDF, tar, WAV,
    wasm, TrueType, PE) and on real files (an SQLite database, a gzip member), zips
    written by `zipWrite` (xlsx, npz, plain), and look-alikes that must stay "binary
    data"; 2,000 truncated and corrupted samples, none of which may throw.
  - `binarySummary`, `binaryFileNotes` (figures, other binaries, text skipped, the cap),
    `periodicFileListing` (due steps, unchanged, changed, off), the binary messages of
    `read_file` / `edit_file`, the prompt's figure rules.
  - `figures` and `fileListSent` through `validateSession` (unsafe paths dropped, junk
    coerced, older exports) and the transcript.
- **`tools.test.mjs`** covers native tool calls (DESIGN §5.6): the tool definitions,
  `resolveProtocol`, support detection from llama.cpp `/props`, Ollama `/api/show` and
  model lists, which refusals count as a tool rejection, `parseToolCalls` (what runs,
  what is skipped and why, finish/ask_user, unknown tools, bad JSON, cut-off arguments,
  generated ids, replies without calls), native file batches through `applyFileActions`
  and `fileCallResults`, answering a pending `ask_user`/`finish`, `toolHistoryAsText`
  (calls written out parse back to the same actions), elision and compaction with tool
  calls, the native system prompt and hints, and session format 2 (a system message
  only as the first message).
- **`bundled.test.mjs`** covers the bundled libraries (Phase 3.5, DESIGN §8): the real
  `BUNDLED_LIBRARIES` manifest (Tier 1 and Tier 2 plus odfpy, pinned pure wheels from
  PyPI or, for odfpy, a pinned source archive to build one from, known `requires`),
  `bundledImportIndex`, `bundledAliases`, `planBundledLoad` (python-pptx brings XlsxWriter and
  Pillow, what is loaded is skipped with names compared normalized, pandas' `to_excel`,
  `engine="xlsxwriter"` and `to_markdown` pull in openpyxl, XlsxWriter and tabulate, a
  `.ods` or `engine="odf"` odfpy, a word inside a longer name doesn't), `packageLoadNote`,
  `moduleNotFoundHint` for a bundled import and pandas' "Missing optional dependency"
  (by library name: odfpy → `import odf`), and the system prompt naming
  a library per format in both protocols.
- **`files.test.mjs`** covers the file actions (DESIGN §5.1):
  - `extractFileActions`: both quote styles, fences inside written content,
    line-start only, unclosed tags, path normalising and unsafe paths.
  - `parseReply` kinds `files`, `mixed`, `broken` and `cutoff`.
  - `applyFileActions`:
    - reads: numbering, ranges, the line, character and per-reply caps, binary and
      missing files;
    - writes: create, replace, unchanged, folder and parent-file conflicts;
    - edits: unique, missing and repeated matches, the whitespace hint, CRLF,
      ordered pairs, literal `$&`;
    - all-or-nothing batches.
  - `formatFileResults`, `buildObservation` with `truncate: false`, `fileActions` in
    `validateSession` and the transcript.

- **`filetools.test.mjs`** covers Phase 3.6 (DESIGN §5.1): the `search_files`,
  `delete_file` and `move_file` tags (quoted `>` in a pattern, a trailing `/`, the whole
  workspace as `.`), `globToRegExp` and `searchRegExp` (the `(?i)` prefix, plain text for
  an invalid regex), `applyFileActions` for search (listing, matches, the match, file,
  line, size and read-budget caps, binary files, the reply's earlier writes), delete
  (files, folders, delete then write) and move (binary bytes and a BOM kept, folders,
  every refusal, move then edit, delete then move), the native calls and their text form
  round-tripping, `classifyEffect` for moves, `validateSyntaxResult` and
  `syntaxErrorNote`, the ask options of both protocols (`cleanAskOptions`,
  `splitAskOptions`) through import and the transcript, and both system prompts.

## End-to-end — `e2e_agent.py`

Opens the **built** `dist/hermit-agent-standalone.html` from `file://`, against
`mock_openai.py`: a scripted OpenAI-compatible endpoint that picks replies by a
keyword in the task and records every request, plus every hit on `/exfil/…`. The
main scenarios (the mock can also refuse connections, answer 503, cut a stream or let
it stall, on cue; see its docstring):

1. **Risk-based**:
   - An auto-committed step.
   - A delete of a user file held, rejected with a reason and rolled back.
   - A step timeout.
   - **17 network probes** from Python, which must all be blocked, with the mock
     receiving nothing. The step after them imports a package whose registry entry
     the probe step pointed at the mock; the load must be refused.
   - The file viewer, the workspace zip, and the session export (checked with
     Python's `zipfile`; the API key must not appear anywhere in it).
2. **Import** into a fresh page:
   - A session file with a second system message is refused, and nothing is restored.
   - Timeline and workspace identical, a follow-up carrying the restart note. The file's
     system prompt was replaced with an old one: the follow-up's request carries
     today's, with the step time limit set on the page.
   - Rewind to a step and to the start, with the worker re-seeded and its
     variables gone.
   - Confirm-before-replace.
3. **Approve each step**: edit before run, a guidance note, Kill, and reject before
   run, each checked against what the model is told.
4. **Autopilot**: a delete of a user file commits without a hold, but the risk is
   still recorded. Every step card shows its stats block, with the mock's llama.cpp
   `timings` and the context size from its `/props`.
5. **File actions**:
   - Write, read and edit without Python. The model gets numbered lines.
   - A python step imports the edited module.
   - A write after a python step reaches the worker without a re-seed.
   - An edit of a user file is held and rejected: the file is unchanged and the
     interpreter keeps its variables.
   - A mixed reply runs nothing.
   - Export → import rebuilds the action rows.
6. **Auto-compaction** with a tiny context size:
   - Two compactions (steps 1–2, then 3–4) and nothing earlier.
   - The next request carries the summary and the last 4 steps verbatim, with roles
     alternating.
   - The second pass folds in the first summary.
   - Rewinding to before a compaction restores the full history.
   - A context-overflow error (the mock's 400) compacts and retries without leaving
     an error card.
   - A "length" reply that filled the mock's `n_ctx` is told apart from `max_tokens`
     and compacts before the next request.
   - Under the mock's vLLM-style path (`/vllm/v1`: no `/props`, `max_model_len` and
     `owned_by: "vllm"` in the model list, tool calling not enabled) Test Connection and
     the run find the context size, Auto goes native and falls back to text on vLLM's
     400, and the 🗜️ Compact button summarises on request and the follow-up carries the
     summary.
   The mock answers the summariser's request with a fixed summary, and counts the
   compacted steps toward its turn index.
   - **Checkpoint budget** (shrunk to 2.5 KB): the oldest checkpoints are dropped with a
     note, their versions freed, their cards say rewind is unavailable, the status bar
     flags it, and a kept checkpoint still rewinds.
7. **Workspace**:
   - Import a zip into an empty workspace (junk skipped).
   - Cancel a delete, then delete a file and a folder. The interpreter no longer
     sees them, and the model is told.
   - No delete while a step waits for approval.
   - Merge a zip, replace with a plain zip via the header Import, and import a
     session export's workspace files.

8. **Endpoint outage**: a refused, a 503, a dropped and a stalled request are retried
   (the card notes it, the half reply is discarded); an outage longer than the retry
   window pauses the run with the agent wording, and Retry resumes it with no step lost
   or repeated.
9. **⚡ Send now**: a note during a slow reply is queued; Send now restarts the request
   with the note, still as step 1. A note queued while the reply turns out to be the
   final answer is sent afterwards, and the agent answers it.
10. **Diffs and edit-before-run**: a held overwrite's chip counts the changed lines and
    opens the diff, with Before / This version tabs; in the code editor Tab indents,
    Reset appears with the first change and restores the code, Ctrl+Enter runs, and the
    card shows the edit's diff.
11. **Modules and closing**: a module changed by `edit_file`, and one rewritten by
    Python, is imported fresh (the `sys.modules` carry-over); no `__pycache__`; the
    context gauge; closing with unexported work asks (`beforeunload`), and doesn't once
    exported.
12. **Packages**: the system prompt's list and step time limit, a real load of `six` from the CDN (needs a
    connection) with its note, a `ModuleNotFoundError` hint, and a load that fails
    offline (Chromium: `set_offline`, then the model request retries until online
    again; Firefox: the CDN blocked by a route, because Playwright's Firefox holds
    requests made offline forever).
13. **Elision**: nothing elided before 8 steps, then the oldest 4 at once; requests 5–8
    share their prefix; the history keeps the full output.
14. **Uploads** (carry-over): a folder through the folder input, a dropped file (a
    synthetic drop, so the `files` fallback; entry-based folder drops still need a real
    drag), and the large-upload confirm.
15. **Step limit**: *Run 1 more step* runs exactly one.
16. **Figures** (Phase 2b; loads matplotlib from the CDN): `plt.show()` and a figure left
    open are captured as `figures/step-1-K.png`, a `savefig`'d one isn't saved twice,
    figures are closed between steps, `matplotlib.use("Agg")` by the agent still gets
    end-of-step capture, a Pillow JPEG is described, `read_file` of a binary says what it
    is, the file list follows step 5's observation (and no other), the cards show the
    images (figures first) and they load, the viewer shows a summary, a changed PNG opens
    on both versions, a zip's entries are listed, and figures survive export → import.
16b. **Packages through a script** (in the packages scenario): a package imported only by
    a workspace script that the step runs with `runpy` is loaded before the step, and
    `import micropip` gets "nothing needs installing" instead of Pyodide's micropip advice.
16c. **Bundled libraries** (Phase 3.5; `bundled`). One page refuses every request that
    leaves the machine: openpyxl (a formula round trip), XlsxWriter (a chart), Markdown
    (a table), tabulate, xmltodict and odfpy (an `.odt` read back; the wheel build.py
    builds) work, each step notes it was installed from the
    bundle, nothing left the machine, and after an interpreter restart openpyxl installs
    again. A second page blocks only PyPI: python-docx, python-pptx (a native chart; it
    brings XlsxWriter), qrcode (a PNG), markdownify and seaborn work with their Pyodide
    packages from the CDN, pandas' `to_excel`/`read_excel`/`to_markdown` work without an
    import of openpyxl or tabulate, a `.ods` round trip without an import of odf, and PyPI
    is never asked. The prompt's package list
    includes the bundled libraries.
17. **Native tool calls** (Phase 3; `native`, `native_fallback`), against the mock's
    `/tools/v1`, whose `/props` reports tool support, and `/notools/v1`, which refuses
    `tools` like llama.cpp without `--jinja`. The mock checks every request's history like
    a strict server (each call answered by one tool message, valid JSON arguments, no
    tool messages without `tools`). Auto goes native; a read + write batch answers each
    call; a `write_file` next to `run_python` is not run and says so; an `edit_file` of
    an uploaded file is held and its rejection reaches the model with the reason; a call
    without an id gets a generated one; code in plain text runs nothing; the answer to
    `ask_user` is its tool result; `finish` ends the task and a follow-up acknowledges it;
    cards carry the 🔧 badge and list calls that didn't run; export (format 2) → import
    keeps the history and a strict server accepts a follow-up. A refused request falls
    back to code-as-action without an error card, and switching Settings → Actions to
    text mid-session sends the history with calls written out as code and tags.

18. **More file tools** (Phase 3.6; `filetools`, `native_filetools`): a search reaches the
    model as `path:line: text`; a `.py` that doesn't compile gets a note in the
    observation and on the card, and its fix none; deleting the agent's own folder runs
    on its own and is gone in the interpreter too, folder included; moving your file is
    held and named as a move, and after approval it stays yours (overwriting it is held
    again); a rejected delete changes nothing; an `ask:` with options shows buttons, a
    click is the answer, and they're disabled afterwards; the transcript and export →
    import keep the new action rows and options (disabled once imported). Natively: a
    search + move batch gets one result per call, the moved file keeps its origin, the
    syntax note is in the tool result, and a clicked option is `ask_user`'s result.
19. **Tool tags in the model's own spelling** (`stray_tag`): `<run script="job.py"/>`
    after a `write_file` lets the write apply and tells the model the tag ran nothing;
    `<execute>` alone runs nothing and doesn't end the task; runpy then runs the script.

Stock Firefox (`firefox=<binary>`, driven over WebDriver BiDi) runs everything except
the download-based checks, which Playwright can't capture over BiDi. It matters
because the network guard depends on browser behaviour (the CSP reaching Blob
workers), and Playwright's own Firefox is a patched build. Under BiDi, Firefox reports
two expected things as page errors; the test ignores exactly those two:
- the CSP blocking the probes' `eval`/`import`;
- the forced stop of a killed worker, which the page itself never sees.

The page's CSP blocks `eval`, so Playwright's `wait_for_function` can't run in it.
Waits poll `page.evaluate()` instead, which goes through the browser protocol.

## Real model — `e2e_reference.py`

The success measurement (Phase 2a; its first three tasks are the Phase 1 exit
criterion). A real model does 24 tasks in the built app under risk-based supervision:
data processing, code plus tests, calculation, fixing a bug in an uploaded file, a JSON
transform, word frequencies, log analysis, code from a spec, a matplotlib chart, a
pandas pivot, renaming a setting across two uploaded files, SQLite, counting, dates and
a Markdown report, plus Phase 2b's three: a chart it must *show* (the figure has to be
captured and shown inline on its card), a Pillow image, and a question about an
uploaded SQLite file, and a PDF report that must come from a library (its text is
checked with pymupdf, and no step's code or workspace script may hold raw PDF syntax), plus
Phase 3.5's five, one per bundled format, each file checked with a library: an Excel
workbook (a sheet per region and a Summary, read with openpyxl), a Word report (heading
and table, python-docx), a PowerPoint deck with a native column chart (its values and
categories, python-pptx), Markdown → HTML (headings, list, table, link and code block,
beautifulsoup4) and a QR code (decoded with OpenCV), plus an OpenDocument spreadsheet
of region totals (read with pandas' ODF engine; odfpy was bundled later). For those,
whether the agent's code
used a bundled library is recorded (`library_used`) but doesn't decide the pass. Phase
3.6 added two (27 in all): renaming a function across a small project with folders
(no file may still name it, and the project's tests must pass) and tidying up your files
(CSVs into `data/`, a PNG into `assets/` byte for byte, the `.tmp` files deleted); which
file tools the agent used is recorded (`tools_used`), not required. `--runs N` repeats the suite; the result is one pass rate, plus a
per-task table and a JSON file in `tests/results/` (gitignored). The script approves
held steps, logging their reasons, and answers `ask:` questions generically. It checks
the results inside the same interpreter, or against the final answer. The four tasks
that change an uploaded file must have been held for it: that is the real-model gating
check. It takes minutes per task, so launch it detached and watch the log; `--app`
tests a copy of the build, so rebuilding meanwhile doesn't change what is measured.
`--quick` runs only the five tasks in `QUICK` (data processing, rename a setting, the
binary-file question, the shown chart, the Excel workbook), once: the check after a small
change, about a minute per protocol; the full suite is for bigger ones (AGENTS.md).
`--tool-mode native|text|auto` sets Settings → Actions (Phase 3); with `native` or `text`
a run fails unless every step used that protocol, and each result records how many
steps used which.

## Real model, long run — `e2e_longrun.py`

The Phase 2a exit criterion: a 20+ step task survives an endpoint outage and a
compaction, in 4 of 5 runs. The task is a 22-question treasure hunt (each answer reveals
the next question). The app reaches the endpoint through a proxy in the script that
refuses every connection for 25 s at the 6th model request (the app's retries ride it
out), cuts the first reply from the 11th request on once it has streamed 3 KB, and goes down for 150 s at the 16th
(longer than the 2-minute retry window: the run pauses, and the script presses Retry
once the proxy is back). Context size 8,000 with 4,096 max tokens forces compaction
(at 12,000 the short hunt steps never reached the threshold).
