# Tests

Focused regression tests for 📤 Export / 📂 Import. Not a general test suite — the project
has no test runner, no `package.json`, and no dependencies to install for the unit half.
These exist because the export format doubles as the import format, so a change to one side
silently breaks the other.

## Unit round-trip — `export-import.test.mjs`

```bash
node tests/export-import.test.mjs
```

Node only, no install step. `extract.mjs` slices the real `escapeHtml`, `unescapeHtml`,
`contentToText`, `parseChatExport`, `splitContextBlocks` and the export handler's
Markdown-building body straight out of `src/script.js` and evaluates them, so the tests
exercise shipped code and fail loudly if a function is renamed.

Covers: system prompt and turn recovery, text attachments (single, multiple, alongside
context-pane text), attachments sent with no prompt text, filenames needing HTML escaping,
images being flattened to a placeholder, and the documented truncation limits.

Exits non-zero on failure.

## End-to-end — `e2e_export_import.py`

```bash
benchmark/.venv/bin/python -m playwright install chromium   # once
benchmark/.venv/bin/python tests/e2e_export_import.py
```

Drives the real `dist/hermit-ui-standalone.html` in headless Chromium through its own
buttons — attach, send, export, re-import — and asserts on the resulting DOM: the 📎 Attached
Context disclosure, the ✏️ Edit button refilling file chips, and images not surviving.
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
