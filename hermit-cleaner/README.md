# HermitUI Cleaner

*Clean up text another model wrote: hidden characters out, typography plain, some
sentences or paragraphs reworded by your own local model, and a few natural typos.*

> **Status: v0.2.1.** One self-contained HTML file in two flavours:
> [`dist/hermit-cleaner-standalone.html`](dist/hermit-cleaner-standalone.html) (≈ 290 KB)
> rewords through a model server, and
> [`dist/hermit-cleaner-wllama.html`](dist/hermit-cleaner-wllama.html) (≈ 3.6 MB) can also
> run a small GGUF model right in the tab, with no server at all.
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
2. **Reword** (optional). Your local model rewrites 10 %, 30 %, 60 % or all of the
   **sentences** (the default) or **paragraphs** of the prose.
   - **Change** sets how much: **Light** (the default) swaps one or two words per
     sentence and trims stock phrases; **Medium** rephrases each sentence; **Strong**
     rewrites freely. A Light reply that changes more than half the words is refused.
     Each level shows the model one short example exchange (English or German),
     which small models follow far better than rules alone.
   - **Tone**: keep it, or make it a little more casual, more formal or simpler.
   - **Also**: one instruction of your own, such as "use du" or "British spelling".
   - The words the model changed are highlighted inside each reworded span, and the
     report gives the average share of words changed. A reply with the same words as
     the original is reported as unchanged.
   - A reply that comes back unchanged or is refused gets **one second try**, told what
     was wrong and sampled a little more freely. At Light this rewords most of what
     small models first leave alone (Qwen3-1.7B: 66 % → 83 % of the sentences). Units
     under 20 letters that come back unchanged get no second try: those are mostly
     greetings and names the model rightly left as they were.
   - **Min. letters** (default 6): sentences and paragraphs with fewer letters are not
     sent. 6 lets "Hi Sarah," and "Best regards," through but not a bare "Tom".

   By sentence, each one is sent with its paragraph as context, so the rewrite still fits in, and picked sentences
   next to each other (up to three) go together in one request. Abbreviations like
   "z. B.", "Dr." or "e.g." and dates like "3. Mai" don't end a sentence. Headings, code
   blocks, tables and lines under the Min. letters are never sent. The language is detected (English, German, French, Spanish,
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
- Small in-browser models write weaker German than English: past Light edits, a 1.7B
  model makes grammar mistakes. Check the highlighted changes before you use them.

## Rewording in the browser (`hermit-cleaner-wllama.html`)

Open ⚙️ Settings, choose **In this tab**, and pick a `.gguf` file or paste a link
(`hf:user/repo/file.gguf` works). The model is held in memory only and is gone with
the tab. The engine ([wllama](https://github.com/ngxson/wllama) 3.6.1) is inside the
file, so nothing else is downloaded.

A link can name the model: `hermit-cleaner-wllama.html#gguf=hf:unsloth/gemma-4-E2B-it-GGUF/gemma-4-E2B-it-Q4_K_M.gguf`
(or a direct `.gguf` / Hugging Face URL). Opening it shows a banner with the model and
the host it would come from; the download starts only when you press **Load model**.

Speed and first impressions in the browser (CPU, 16 threads, a 3-sentence request,
warm; 2026-10-09, before the prompt fixes that the judged table below includes):

| Model (Q4_K_M) | Size | s / request | English | German |
|---|---|---|---|---|
| Qwen3 0.6B | 0.4 GB | ≈ 4–6 | tiny edits whatever the level; often returns the text unchanged | the same |
| **Qwen3 1.7B** | 1.1 GB | ≈ 8 | **good at every level**, Light trims stock phrases | Light is fine; Medium/Strong make grammar mistakes |
| **Qwen3 4B** | 2.5 GB | ≈ 18–22 | the clearest Light/Medium/Strong steps (median 18 / 37 / 50 % of words changed) | Light is fine; once turned "unterschätzen" into "überschätzen" at Medium |
| Gemma-4 E2B | 3.1 GB | ≈ 19 | changes a lot even at Light (median 23 %) | the most natural German at Medium/Strong |

Small models can flip a word's meaning, so read the highlighted changes.

**Quality, judged** ([`bench/`](bench/README.md), 2026-10-09): 9 English, German and
French texts, every level, 3 runs, scored 1-5 by gpt-oss-20b (meaning / grammar,
averaged over the levels):

| Model (Q4_K_M) | English | German | Notes |
|---|---|---|---|
| Qwen3 0.6B | 4.65 / 4.99 | 3.00 / 3.05 | not usable for German |
| Qwen3 1.7B | 4.65 / 4.96 | 4.28 / 4.66 | Light leaves a third of the sentences unchanged |
| Qwen3 4B | 4.79 / 4.93 | 4.21 / 4.82 | turned "unterschätzen" into "überschätzen" in all 3 Medium runs |
| Qwen3.5 4B | 4.73 / 4.96 | 4.54 / 4.68 | the best Light edits (no problems found), but German grammar slips at Medium/Strong |
| **Gemma-4 E2B** | 4.81 / 4.97 | **4.67 / 4.85** | the best overall: no meaning or grammar problem at Light or Medium |
| Gemma-4 E4B | 4.72 / 4.80 | 4.70 / 4.83 | no better than E2B, and slower |

Every model kept 88-100 % of the numbers and 95-100 % of the names.

Opened as a plain file the model runs on one CPU thread; served with cross-origin isolation (COOP/COEP headers,
for example `../benchmark/serve.py`) it uses every core. WebGPU helps on a real
graphics card, but not in Firefox yet (bug 1870699), where it is off by default.

## Try it

1. For rewording, start an OpenAI-compatible server that allows browser requests
   (CORS). For example, llama.cpp: `llama-server -m model.gguf --jinja --port 8080`.
   Ollama works too. Cleanup and typos need no server. Or use the `-wllama` file and
   a model in the tab (above).
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
python3 build.py                                     # → dist/hermit-cleaner-standalone.html and -wllama.html
node tests/run.mjs                                   # unit tests (pure logic)
../benchmark/.venv/bin/python tests/e2e_cleaner.py   # e2e vs. a mock endpoint, Chromium + Firefox
../benchmark/.venv/bin/python bench/bench.py        # reword benchmark: real GGUF models on llama-server, judged
```

See [tests/README.md](tests/README.md), [bench/README.md](bench/README.md) and [AGENTS.md](AGENTS.md).

## Roadmap

- A per-language example for French, Spanish and the others (today only English and
  German get one).
