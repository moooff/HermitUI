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
  - each typo kind
  - seeded determinism, rate and gap
  - the marks and edits reproduce the input
  - URLs, e-mail, code, numbers, ALL-CAPS words, names and file names are never touched
  - `shiftMarks`
- **`rewrite.test.mjs`**:
  - `detectLanguage` (en, de, fr, es, it, nl)
  - `splitParagraphs` (exact round trip, fences with blank lines, which blocks get rewritten)
  - `pickParagraphs`
  - the request body (language named, thinking off, the retry without kwargs)
  - `stripThinking`
  - `acceptRewrite` (empty, preamble, length, wrong language)
  - German typos on nouns
  - the helpers copied from HermitUI

## End-to-end (`e2e_cleaner.py`)

Opens the built file from `file://` in Chromium and Firefox against
`mock_openai.py`. It checks:
- cleanup of a German text, the report and the change view
- rewording: what is sent, the second cleanup, the retry without `chat_template_kwargs` and an English answer refused for German text
- Stop and a 401 hint
- typos and Reroll, which makes no model call
- Test Connection and Copy
- that `localStorage`, `sessionStorage`, cookies and IndexedDB stay empty
