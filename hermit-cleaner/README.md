# HermitUI Cleaner

*Clean up text another model wrote: hidden characters out, typography plain, some
sentences or paragraphs reworded by your own local model, and a few natural typos.*

> **Status: v0.1.1.** One self-contained HTML file,
> [`dist/hermit-cleaner-standalone.html`](dist/hermit-cleaner-standalone.html) (≈ 260 KB).
> It is a sibling of [HermitUI](../) and [HermitUI Agent](../hermit-agent/), developed
> separately in this folder. Nothing is stored: the text and the settings live in the
> tab's memory and are gone when you close it.

## What it does

Three steps, each one optional:

1. **Clean.** Everything outside printable **Latin-1** (plus €) is removed or replaced,
   so German, French, Spanish and other Western European text keeps its letters
   (ä ö ü ß é ñ ç « » …):
   - **Hidden text** in Unicode tag characters (invisible copies of ASCII, used to
     smuggle instructions into text) is removed, and the decoded text is shown in the
     report.
   - **Invisible characters** are removed: zero-width spaces and joiners, the BOM,
     the word joiner, BiDi controls, the soft hyphen, variation selectors, and control
     characters.
   - **Unusual spaces** (no-break, narrow, thin, ideographic) become normal spaces.
   - **Typography** becomes what a keyboard types: “ ” „ → `"`, ‘ ’ → `'`, en dash
     → `-`, em dash → ` - `, … → `...`, → → `->`.
   - **Look-alike letters** (a Cyrillic а inside an otherwise Latin word, say) become
     the Latin letter. Genuinely Cyrillic or Greek words are left alone and then dropped.
   - **Accents stored as two characters** (a letter plus a combining mark, as macOS
     writes them) are recombined, so "u" + "¨" becomes ü instead of losing its accent.
   - **"Fancy text"** becomes plain letters: 𝐛𝐨𝐥𝐝 and 𝓈𝒸𝓇𝒾𝓅𝓉 math letters, Ⓒⓘⓡⓒⓛⓔⓓ,
     🅂🅀🅄🄰🅁🄴🄳 and 🆂🆀🆄🅰🆁🅴🅳 letters, ꜱᴍᴀʟʟ ᴄᴀᴘꜱ, fullwidth, s̶t̶r̶u̶c̶k̶ and Zalgo text.
   - **Other letters** are simplified (ő → o, ł → l). Emoji (with skin tones, flags,
     keycaps and ZWJ sequences), CJK, private-use characters and the like are dropped,
     without leaving stray spaces behind ("✅ Done" → "Done").
   - **Whitespace**, a known hiding place for data: trailing spaces and repeated spaces
     inside a line are removed. Indentation and fenced code blocks are left as they are.
     (This also removes Markdown's two-space line breaks.)
2. **Reword** (optional). Your local model rewrites 30 %, 60 % or all of the
   **sentences** (the default) or **paragraphs** of the prose. By sentence, each one is
   sent with its paragraph as context, so the rewrite still fits in, and picked sentences
   next to each other (up to three) go together in one request. Abbreviations like
   "z. B.", "Dr." or "e.g." and dates like "3. Mai" don't end a sentence. Headings, code
   blocks, tables and short lines are never sent. The language is detected (English, German, French, Spanish,
   Italian, Dutch, Portuguese) and named in the prompt. A reply that comes back empty,
   much shorter or longer than the original, with an introduction ("Here is…"), or in
   the wrong language is discarded, and the original is kept. The model's
   answers go through the cleanup again.
3. **Typos** (optional). A low rate of realistic mistakes:
   - **In every language:** a neighbouring key, two letters swapped, a letter dropped
     or doubled, a missing capital at a sentence start, Shift held too long ("DIese"),
     a repeated word ("the the"), a missing space ("inthe").
   - **In German text, also:**
     - an "n" too many or missing ("habe" → "haben", "keinen" → "keine")
     - -em/-en mixed up ("mit einen Freund", "dem" → "den")
     - das/dass
     - a missing comma before dass/weil/wenn/obwohl and similar conjunctions
     - a noun in lower case
     - ß typed as ss

   The report lists how many of each kind were added. The keyboard follows the language (QWERTZ for German, AZERTY for French,
   QWERTY otherwise), or you pick it. The typos never touch code, URLs, e-mail
   addresses, numbers, ALL-CAPS words, or capitalised words mid-sentence (likely
   names). Words under four letters never get a letter typo: only whole-word slips
   like a repeat or "dem"/"den". German is the exception to the last rule, since there
   those are mostly nouns. **Reroll typos** makes new ones without calling the model
   again.

The output shows every change: hover a highlight to see what was there before.
**Copy** copies the plain text.

## Honest limits

- **Character cleanup doesn't remove real AI watermarks.** Schemes like SynthID-Text
  hide the watermark in *which words* the model picks, not in special characters.
  Rewording changes the word choice, so it is the step that matters for those.
- **No tool can promise what an AI detector will say.** Detectors are unreliable in
  both directions. A rewrite by a small model is still machine-written text.
- Typos make text look hand-typed only up to about 1 %. Beyond that it just looks
  sloppy.
- Text in other scripts (Cyrillic, Greek, CJK, Arabic …) is removed, not translated:
  the kept set is Latin-1. Upside-down text and flag letters are dropped too.
- Markdown formatting (`**bold**`, `## headings`) is left in the text.

## Try it

1. For rewording, start an OpenAI-compatible server that allows browser requests
   (CORS). For example, llama.cpp: `llama-server -m model.gguf --jinja --port 8080`.
   Ollama works too. Cleanup and typos need no server.
2. Open `dist/hermit-cleaner-standalone.html`. Double-clicking the file is fine.
3. Open ⚙️ Settings, check the API Base URL (default `http://localhost:8080/v1`) and
   use **Test Connection**. If you leave the model empty, the server's first model is
   used.
4. Paste text (or drop a `.txt`/`.md` file), choose the steps, and press **Run**
   (Ctrl+Enter).

If the Base URL points at a server outside your machine or network, a warning says
that the text will be sent there.

## Build & test

```bash
python3 build.py                                     # → dist/hermit-cleaner-standalone.html
node tests/run.mjs                                   # unit tests (pure logic)
../benchmark/.venv/bin/python tests/e2e_cleaner.py   # e2e vs. a mock endpoint, Chromium + Firefox
```

See [tests/README.md](tests/README.md) and [AGENTS.md](AGENTS.md).

## Roadmap

- **Phase 2:** in-browser rewording through wllama (a GGUF model in the tab, no
  server), as in HermitUI's `hermit-ui-wllama.html` build.
