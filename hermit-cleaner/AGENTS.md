# Agent & Contributor Rules — `hermit-cleaner/`

These rules apply to everything inside `hermit-cleaner/`. They **extend** the root
[`../AGENTS.md`](../AGENTS.md): every root rule still applies unless this file
explicitly overrides it. If you are an AI agent, read the root file first.

> Local tooling: Claude Code reads `CLAUDE.md`. As in the root folder, a gitignored
> `CLAUDE.md -> AGENTS.md` symlink can be created here; don't commit it.

## Status
v0.1.0: cleanup, rewording through an OpenAI-compatible server, and typos. Phase 2 is
in-browser rewording through wllama (`@wllama` marker blocks and a `-wllama` output,
as in the root app).

## Build & test
```bash
python3 build.py                                     # → dist/hermit-cleaner-standalone.html
node tests/run.mjs                                   # unit tests (pure logic)
../benchmark/.venv/bin/python tests/e2e_cleaner.py   # e2e vs. a mock endpoint, Chromium + Firefox
```
The page's CSP blocks `eval`, so Playwright's `wait_for_function` can't run inside it:
poll with `page.evaluate` instead.

## Inherited from the root (unchanged)
- **One HTML file is the deliverable.** It is assembled by a Python `build.py`. No
  npm, bundlers or Node build tools.
- **Vanilla JS and CSS only.** Glassmorphism, Inter, CSS variables plus `data-theme`,
  and a fluid layout with no media queries.
- **Strict ephemerality.** No `localStorage`, `IndexedDB` or cookies, for any reason,
  including settings. The e2e test asserts that storage stays empty.
- **OpenAI chat-completions schema** for all model traffic.
- Git workflow: check origin first, review before commit, and **never commit or push
  unless the user asks**.

## Specific to this folder
- **Don't touch the root app.** Never edit `../src/`, `../build.py`, `../tests/` or
  `../dist/` as part of Cleaner work. `build.py` must not write outside this folder.
- **Model output is rendered as text, never HTML.** The output pane is built with
  `textContent` and DOM nodes only, so the root DOMPurify rule has nothing to
  sanitize. If HTML or Markdown rendering is ever added, `DOMPurify.sanitize()` becomes
  mandatory.
- **Keep the pure section of `src/script.js` ASCII.** Everything above
  `// ========== Copied from HermitUI` writes non-ASCII characters as `\uXXXX` escapes:
  the cleaner's own tables hold invisible and look-alike characters, and these must
  stay visible in review. The test files follow the same rule. Check with
  `grep -nP '[^\x00-\x7e]' src/script.js tests/*.mjs tests/*.py`.
- **The kept set is Latin-1 plus €** (`KEEP_RE`). Changing it changes what the whole
  app promises, so update the README with it.
- **Be honest in UI text.** Don't claim the app removes watermarks it can't see, or
  that it beats AI detectors.
- **A version bump in every commit** that changes this folder: `APP_VERSION` in
  `src/script.js` and the status line in `README.md`.
- **Tests:** pure logic goes in unit tests that slice the real functions out of
  `src/script.js` (`tests/extract.mjs`, the same approach as `../tests/`). Renaming a
  function fails the suite; update the lists there. DOM behaviour goes in
  `tests/e2e_cleaner.py`.

## Copied from HermitUI
| Function / block | From (`../src/…`) | Source commit | Adapted how |
|---|---|---|---|
| `isLocalEndpoint`, `apiEndpoint`, `normalizeApiUrl`, `isBlockedMixedContent` | `script.js` | `7773cdd` | default URL in the error text says :8080; `isBlockedMixedContent` tolerates a missing `location` |
| `chatErrorHint` | `script.js` | `7773cdd` | wllama branch dropped; context advice talks about the paragraph |
| `showToast`, toast and settings-modal CSS | `script.js`, `style.css` | `7773cdd` | unchanged apart from theme variables |
| `tests/check.mjs`, `tests/run.mjs`, the `extract.mjs` approach | `../hermit-agent/tests/` | `7773cdd` | the extractor also slices multi-line `const` tables |
| `build.py` techniques (Inter woff2 inlining, `</script` escaping, strict CSP) | `../hermit-agent/build.py` | `7773cdd` | one output; only the Latin Inter subsets, one block each |
