# Tests

Same approach as HermitUI's `../../tests/`: no test runner, no `package.json`, no
dependencies to install for the unit half.

```bash
node tests/run.mjs                                              # unit tests (all *.test.mjs)
python3 build.py && ../benchmark/.venv/bin/python tests/e2e_agent.py [chromium] [firefox] [firefox=/path/to/stock/firefox]
../benchmark/.venv/bin/python tests/e2e_reference.py --base-url http://localhost:8080/v1 [--runs 3]
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
    those instead of a fence) and `<tool_call>` replies.
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
   - Timeline and workspace identical, a follow-up carrying the restart note.
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
   - Under the mock's vLLM-style path (`/vllm/v1`: no `/props`, `max_model_len` in the
     model list) Test Connection and the run find the context size, and the 🗜️ Compact
     button summarises on request and the follow-up carries the summary.
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
   with the note, still as step 1.
10. **Diffs and edit-before-run**: a held overwrite's chip counts the changed lines and
    opens the diff, with Before / This version tabs; in the code editor Tab indents,
    Reset appears with the first change and restores the code, Ctrl+Enter runs, and the
    card shows the edit's diff.
11. **Modules and closing**: a module changed by `edit_file`, and one rewritten by
    Python, is imported fresh (the `sys.modules` carry-over); no `__pycache__`; the
    context gauge; closing with unexported work asks (`beforeunload`), and doesn't once
    exported.
12. **Packages**: the system prompt's list, a real load of `six` from the CDN (needs a
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
criterion). A real model does 15 tasks in the built app under risk-based supervision:
data processing, code plus tests, calculation, fixing a bug in an uploaded file, a JSON
transform, word frequencies, log analysis, code from a spec, a matplotlib chart, a
pandas pivot, renaming a setting across two uploaded files, SQLite, counting, dates and
a Markdown report. `--runs N` repeats the suite; the result is one pass rate, plus a
per-task table and a JSON file in `tests/results/` (gitignored). The script approves
held steps, logging their reasons, and answers `ask:` questions generically. It checks
the results inside the same interpreter, or against the final answer. The two tasks
that change an uploaded file must have been held for it: that is the real-model gating
check. It takes minutes per task, so launch it detached and watch the log; `--app`
tests a copy of the build, so rebuilding meanwhile doesn't change what is measured.

## Real model, long run — `e2e_longrun.py`

The Phase 2a exit criterion: a 20+ step task survives an endpoint outage and a
compaction, in 4 of 5 runs. The task is a 22-question treasure hunt (each answer reveals
the next question). The app reaches the endpoint through a proxy in the script that
refuses every connection for 25 s at the 6th model request (the app's retries ride it
out), cuts the first reply from the 11th request on once it has streamed 3 KB, and goes down for 150 s at the 16th
(longer than the 2-minute retry window: the run pauses, and the script presses Retry
once the proxy is back). Context size 8,000 with 4,096 max tokens forces compaction
(at 12,000 the short hunt steps never reached the threshold).
