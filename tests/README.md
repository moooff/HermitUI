# Tests

A deliberately small suite: no test runner, no `package.json`, no dependencies to install
for the unit half. It covers the pure logic where a silent regression would be expensive —
the Export/Import format (which doubles as both writer and reader) and the parsing and
normalization the app does before anything reaches the screen or the network.

```bash
node tests/run.mjs        # every *.test.mjs file, aggregate exit code
```

Individual files can be run directly. `extract.mjs` slices the functions under test
straight out of `src/script.js` and evaluates them, so the tests exercise shipped code and
fail loudly if something is renamed rather than quietly testing a stale copy. Only pure
functions can be covered this way — anything touching `document` belongs in the end-to-end
test instead. `check.mjs` is the shared 30-line assertion helper.

## Core logic — `core.test.mjs`

```bash
node tests/core.test.mjs
```

Covers, per numbered section: `parseThinkSegments` (closed/unclosed segments, unslashed
`<|thought_end|>` closers, and half-arrived tags during streaming never flashing as literal
text), `buildFinalHistory` (a separate `reasoning` field folded in exactly once),
`apiEndpoint` (base URLs and pasted full endpoints), `detectCloudProvider` (providers match
as hostname suffixes — `mybox.ai` must not trip the `x.ai` warning), `isTextFile` /
`isImageFile` (including SVG's deliberate exclusion), vision-model detection,
`normalizeGgufUrl` (the three accepted URL shapes plus the rejections), and
`detectTemplateFromArch` / `buildWllamaPrompt` (prompt wrapping asserted byte for byte,
since a malformed prompt only shows up as a model answering badly). Section 10 covers
`createThrottle`, which is timing-based and uses real timers.

## Export/Import round-trip — `export-import.test.mjs`

```bash
node tests/export-import.test.mjs
```

Covers: system prompt and turn recovery, text attachments (single, multiple, alongside
context-pane text), attachments sent with no prompt text, filenames needing HTML escaping,
images being flattened to a placeholder, 📋 summaries keeping their `isSummary` status,
an empty system prompt staying distinguishable from an absent one, and the documented
truncation limits.

Every file exits non-zero on failure.

## End-to-end — `e2e_export_import.py`

```bash
benchmark/.venv/bin/python -m playwright install chromium   # once
benchmark/.venv/bin/python tests/e2e_export_import.py
```

Drives the real `dist/hermit-ui-standalone.html` in headless Chromium through its own
buttons — attach, send, export, re-import — and asserts on the resulting DOM: the 📎 Attached
Context disclosure, the ✏️ Edit button refilling file chips, images not surviving, and an
imported 📋 summary coming back as a summary bubble that stays out of the next request's
payload (asserted on the stubbed `fetch`'s actual body).
`fetch` is stubbed with a one-chunk SSE stream, so no API server is needed. Reuses the
`benchmark/` virtualenv rather than adding another one.

**Run `python3 build.py` first** — this test reads `dist/`, not `src/`.

## Notes on the format

- Text attachments are inlined into the export as `<file name="…">…</file>` blocks and are
  fully restored on import, including the file chips behind ✏️ Edit.
- Images are deliberately **not** exported. `contentToText` flattens them to
  `[N images attached]`; no image bytes and no filenames reach the file, and after import
  the message reverts from a multimodal array to a plain string.
- Attachment bodies are inlined unescaped, so content reproducing `\n\n</div>` or
  `\n</file>\n\n` truncates the block. Asserted in the tests as accepted limitations so a
  future format change is a deliberate decision.
- A 📋 summary is written as `<div class="summary-message">` rather than `ai-message`, so
  the import restores it as a summary. That matters beyond styling: summaries are filtered
  out of every request payload, and an untagged one would come back as a real assistant
  turn the model then sees. Older exports have no such block and are unaffected.
- The `> **System:**` block distinguishes absent (keep the session's current prompt) from
  present-but-empty (restore the cleared prompt).
