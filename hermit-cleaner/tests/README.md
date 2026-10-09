# Tests

Same approach as HermitUI's `../../tests/`: no test runner, no `package.json`, and
nothing to install for the unit half.

```bash
node tests/run.mjs                                              # unit tests (all *.test.mjs)
python3 build.py && ../benchmark/.venv/bin/python tests/e2e_cleaner.py [chromium] [firefox]
```

## Unit tests (pure logic)

`extract.mjs` slices the real functions and constant tables out of `src/script.js` by
name and evaluates them, so the tests exercise shipped code. Renaming one fails the
suite loudly; update the lists in `extract.mjs`. Slicing counts braces, so an
unbalanced brace in a listed function's regex, string or comment breaks every file.
The comment at the top of `extract.mjs` shows how to see the real error.

- **`clean.test.mjs`** covers `cleanText`:
  - Latin-1 survives untouched.
  - Each class of invisible character is removed and counted.
  - Tag-character hidden text is decoded.
  - Spaces, typography and em-dash spacing.
  - Look-alike letters are fixed only inside Latin words.
  - Transliteration is applied per character.
  - Emoji and CJK are dropped, without leftover spaces (flags, skin tones, keycaps, ZWJ sequences).
  - Accents stored as separate marks (NFD) are recombined.
  - "Fancy text" becomes plain letters (math, circled, squared, small caps, fullwidth, strikethrough, Zalgo).
  - Whitespace: trailing and repeated spaces go; indentation and code fences stay.
  - A sweep over every code point (U+0000–U+10FFFF, as one run and each one between
    spaces) lands entirely in the kept set, with valid marks, and a second pass changes
    nothing. It takes a few seconds; a quadratic slip anywhere in `cleanText` turns that
    into minutes.
- **`typos.test.mjs`**:
  - keyboard neighbours (QWERTZ, QWERTY and umlauts)
  - each typo kind, including Shift held too long, repeated words and missing spaces
  - the German kinds (an n too many or missing, -em/-en, das/dass, a missing comma, a noun in lower case, ß as ss), and that English text never gets them
  - seeded determinism, rate and gap
  - the marks and edits reproduce the input
  - URLs, e-mail, code, numbers, ALL-CAPS words, names and file names are never touched
  - `shiftMarks`
- **`rewrite.test.mjs`**:
  - `detectLanguage` (en, de, fr, es, it, nl)
  - `splitParagraphs` (exact round trip, fences with blank lines, which blocks get rewritten)
  - `splitSentences` (abbreviations, ordinals, quotes, line breaks, list markers)
  - `rewordUnits`, `groupUnits` and `applyRewrites` (sentence or paragraph units, neighbours sent together, marks moved)
  - `pickUnits`
  - the request body (language named, the paragraph as context, thinking off, the retry without kwargs)
  - the change levels, tone and extra instruction in the prompt, and the example exchange (German for German text, none for other languages)
  - `wordDiff` (share of changed words, the changed ranges, the fallback for very long texts)
  - `stripThinking`
  - `acceptRewrite` (empty, preamble, length, wrong language, unchanged, too much change for a Light edit)
  - German typos on nouns
  - the helpers copied from HermitUI, including the GGUF URL ones of the `-wllama` build

## End-to-end (`e2e_cleaner.py`)

Opens the built file from `file://` in Chromium and Firefox against
`mock_openai.py`. It checks:
- cleanup of a German text, the report and the change view
- rewording by paragraph and by sentence: what is sent (and the context), the second cleanup, the retry without `chat_template_kwargs` and an English answer refused for German text
- Stop and a 401 hint
- typos and Reroll, which makes no model call
- Test Connection and Copy
- the level, tone and extra instruction reaching the prompt, the changed-word marks, and an unchanged reply
- that `localStorage`, `sessionStorage`, cookies and IndexedDB stay empty
- the `-wllama` build: the backend switch, the error without a model, and, if
  `../benchmark/models/Qwen3-0.6B-Q4_K_M.gguf` exists, loading it from the file picker
  (from `file://`, so through the page's CSP) and one real reword in Chromium
- `#gguf=` links: the banner (model and host, nothing downloaded before its button),
  Dismiss, a refused bad link, the standalone build ignoring them, and a real download
  and load through the banner from a local server in Chromium

## Real models

Model quality is measured by the benchmark in [`../bench/`](../bench/README.md), not here.
