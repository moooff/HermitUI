// HermitUI Cleaner: clean up text another model wrote, optionally have a local model
// reword part of it, and add a few typing mistakes. Nothing is stored: settings and
// text live in this tab's memory only.
//
// The pure functions come first (tests/extract.mjs slices them out by name, by brace
// counting, so keep literal braces out of their regexes, strings and comments); the
// DOM wiring is at the bottom.

const APP_VERSION = "0.1.0";

// ========== Stage 1: character cleanup ==========

// What survives: tab, newline, printable ASCII, printable Latin-1 (U+00A1-U+00FF; the
// no-break space U+00A0 and the soft hyphen U+00AD are turned into a space and removed
// on the way), plus the euro sign, which every European keyboard has although Latin-1
// predates it.
const KEEP_RE = /^[\t\n\x20-\x7e\xa1-\xac\xae-\xff\u20ac]$/;

// Invisible characters: format characters (zero-width space/joiners, BiDi controls,
// BOM, word joiner, soft hyphen), control characters, variation selectors, and the
// letters and fillers that render as blank space.
const INVISIBLE_RE = /^(?:[\p{Cf}\p{Cc}\u034f\u115f\u1160\u17b4\u17b5\u2800\u3164\ufe00-\ufe0f\uffa0]|[\u{e0100}-\u{e01ef}])$/u;

// Unusual spaces that become a plain space. Line and paragraph separators become \n.
const SPACE_CHARS = "\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u202f\u205f\u3000";

// Typography a keyboard can't type, and letters NFKD doesn't decompose.
const CHAR_MAP = {
    "\u2018": "'", "\u2019": "'", "\u201a": "'", "\u201b": "'", "\u2032": "'", "\u2035": "'",
    "\u2039": "'", "\u203a": "'", "\u02bc": "'", "\u02bb": "'",
    "\u201c": "\"", "\u201d": "\"", "\u201e": "\"", "\u201f": "\"", "\u2033": "\"", "\u2036": "\"",
    "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2013": "-", "\u2212": "-", "\u2043": "-",
    "\u2026": "...", "\u2022": "-", "\u2023": "-", "\u25e6": "-", "\u2219": "-", "\u25cf": "-", "\u25aa": "-",
    "\u2192": "->", "\u2190": "<-", "\u2194": "<->", "\u21d2": "=>", "\u21d0": "<=", "\u21d4": "<=>",
    "\u2264": "<=", "\u2265": ">=", "\u2260": "!=", "\u2248": "~", "\u2044": "/", "\u2215": "/",
    "\u2122": "(TM)", "\u2116": "No.", "\u2030": " promille", "\u301c": "~", "\u3030": "~",
    "\u27a1": "->", "\u2794": "->", "\u279c": "->", "\u27f6": "->", "\u2b95": "->", "\u21a6": "->", "\u2b05": "<-", "\u27f5": "<-",
    "\u25b6": "-", "\u25ba": "-", "\u25b8": "-", "\u27a4": "-", "\u25a0": "-", "\u25c6": "-", "\u2756": "-", "\u2726": "-",
    "\u0142": "l", "\u0141": "L", "\u0111": "d", "\u0110": "D", "\u0131": "i", "\u0153": "oe", "\u0152": "OE",
    "\u1e9e": "SS", "\u0251": "a", "\u0261": "g", "\u0127": "h", "\u0126": "H", "\u0167": "t", "\u0166": "T",
    // Small capitals, a favourite of "fancy text" generators. NFKD leaves them alone.
    "\u1d00": "a", "\u0299": "b", "\u1d04": "c", "\u1d05": "d", "\u1d07": "e", "\ua730": "f", "\u0262": "g",
    "\u029c": "h", "\u026a": "i", "\u1d0a": "j", "\u1d0b": "k", "\u029f": "l", "\u1d0d": "m", "\u0274": "n",
    "\u1d0f": "o", "\u1d18": "p", "\u0280": "r", "\ua731": "s", "\u1d1b": "t", "\u1d1c": "u", "\u1d20": "v",
    "\u1d21": "w", "\u028f": "y", "\u1d22": "z",
};

// Cyrillic and Greek letters that look like Latin ones. Mapped only inside a word that
// also has real Latin letters, so genuine Russian or Greek text is never "corrected".
const HOMOGLYPHS = {
    "\u0430": "a", "\u0435": "e", "\u043e": "o", "\u0440": "p", "\u0441": "c", "\u0443": "y", "\u0445": "x",
    "\u0456": "i", "\u0458": "j", "\u0455": "s", "\u0501": "d", "\u051b": "q", "\u051d": "w", "\u04bb": "h", "\u04cf": "l",
    "\u0410": "A", "\u0412": "B", "\u0415": "E", "\u041a": "K", "\u041c": "M", "\u041d": "H", "\u041e": "O",
    "\u0420": "P", "\u0421": "C", "\u0422": "T", "\u0425": "X", "\u0423": "Y", "\u0406": "I", "\u0408": "J", "\u0405": "S",
    "\u03bf": "o", "\u03bd": "v", "\u03c1": "p", "\u03b9": "i", "\u03b1": "a",
    "\u0391": "A", "\u0392": "B", "\u0395": "E", "\u0396": "Z", "\u0397": "H", "\u0399": "I", "\u039a": "K",
    "\u039c": "M", "\u039d": "N", "\u039f": "O", "\u03a1": "P", "\u03a4": "T", "\u03a5": "Y", "\u03a7": "X",
    // Armenian, Cherokee, and the Latin click letter that passes for an l.
    "\u0585": "o", "\u057d": "u", "\u0570": "h", "\u0578": "n", "\u0581": "g", "\u0566": "q",
    "\u13aa": "A", "\u13f4": "B", "\u13df": "C", "\u13a0": "D", "\u13ac": "E", "\u13b6": "G", "\u13bb": "H",
    "\u13ab": "J", "\u13e6": "K", "\u13de": "L", "\u13b7": "M", "\u13e2": "P", "\u13da": "S", "\u13a2": "T",
    "\u13d9": "V", "\u13b3": "W", "\u13a9": "Y", "\u13c3": "Z", "\u01c0": "l",
};

// Names for the characters people most often ask about; the rest show as U+XXXX.
const CHAR_NAMES = {
    0x200b: "zero-width space", 0x200c: "zero-width non-joiner", 0x200d: "zero-width joiner",
    0x200e: "left-to-right mark", 0x200f: "right-to-left mark", 0x2060: "word joiner", 0xfeff: "byte-order mark",
    0x00ad: "soft hyphen", 0x00a0: "no-break space", 0x202f: "narrow no-break space", 0x2009: "thin space",
    0x200a: "hair space", 0x2002: "en space", 0x2003: "em space", 0x2007: "figure space", 0x3000: "ideographic space",
    0x2014: "em dash", 0x2015: "horizontal bar", 0x2013: "en dash", 0x2011: "non-breaking hyphen", 0x2212: "minus sign",
    0x2018: "left single quote", 0x2019: "right single quote", 0x201c: "left double quote",
    0x201d: "right double quote", 0x201e: "low double quote", 0x2026: "ellipsis", 0x2022: "bullet",
    0x202a: "LTR embedding", 0x202b: "RTL embedding", 0x202c: "pop directional formatting",
    0x202d: "LTR override", 0x202e: "RTL override", 0x2066: "LTR isolate", 0x2067: "RTL isolate",
    0x2068: "first-strong isolate", 0x2069: "pop directional isolate", 0x061c: "Arabic letter mark",
    0x034f: "combining grapheme joiner", 0x180e: "Mongolian vowel separator", 0x3164: "Hangul filler",
    0x2028: "line separator", 0x2029: "paragraph separator",
};

const CLEAN_CATEGORIES = ["hidden", "invisible", "composed", "spaces", "typography", "homoglyph", "transliterated", "dropped"];

function charLabel(ch) {
    const cp = ch.codePointAt(0);
    const hex = "U+" + cp.toString(16).toUpperCase().padStart(4, "0");
    if (CHAR_NAMES[cp]) return `${CHAR_NAMES[cp]} (${hex})`;
    if (cp >= 0xe0000 && cp <= 0xe007f) return `tag character (${hex})`;
    if (cp >= 0xfe00 && cp <= 0xfe0f) return `variation selector (${hex})`;
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return `control character (${hex})`;
    if ((cp >= 0xe000 && cp <= 0xf8ff) || cp >= 0xf0000) return `private-use character (${hex})`;
    if (cp >= 0xd800 && cp <= 0xdfff) return `broken character, half a surrogate pair (${hex})`;
    if (cp === 0xfffd) return `replacement character \ufffd (${hex})`;
    if (/\p{M}/u.test(ch)) return `combining mark (${hex})`;
    if (INVISIBLE_RE.test(ch)) return `invisible character (${hex})`;
    return `${ch} (${hex})`;
}

// A character outside the kept set, written with kept characters, or null.
function transliterate(ch) {
    if (Object.prototype.hasOwnProperty.call(CHAR_MAP, ch)) return CHAR_MAP[ch];
    // Negative circled and negative squared capitals (fancy text): no decomposition.
    const cp = ch.codePointAt(0);
    if (cp >= 0x1f150 && cp <= 0x1f169) return String.fromCharCode(65 + cp - 0x1f150);
    if (cp >= 0x1f170 && cp <= 0x1f189) return String.fromCharCode(65 + cp - 0x1f170);
    const base = ch.normalize("NFKD").replace(/\p{M}/gu, "");
    if (!base || base === ch) return null;
    let out = "";
    for (const c of base) {
        if (KEEP_RE.test(c)) out += c;
        else if (Object.prototype.hasOwnProperty.call(CHAR_MAP, c)) out += CHAR_MAP[c];
        else if (SPACE_CHARS.includes(c)) out += " ";
        else return null;
    }
    return out;
}

// Indices (into the code-point array) of look-alike letters inside words that also
// contain Latin letters. Invisible characters count as part of the word, since they
// are often used to split one.
function homoglyphPositions(chars) {
    const hits = new Set();
    let i = 0;
    while (i < chars.length) {
        if (!/[\p{L}\p{M}]/u.test(chars[i])) { i++; continue; }
        let j = i, latin = false;
        const candidates = [];
        while (j < chars.length && (/[\p{L}\p{M}]/u.test(chars[j]) || INVISIBLE_RE.test(chars[j]))) {
            if (Object.prototype.hasOwnProperty.call(HOMOGLYPHS, chars[j])) candidates.push(j);
            else if (/\p{Script=Latin}/u.test(chars[j])) latin = true;
            j++;
        }
        if (latin) candidates.forEach(k => hits.add(k));
        i = j;
    }
    return hits;
}

// Clean `text` down to the kept character set.
// Returns the cleaned text, marks for the change view (offsets into the cleaned text;
// a removal is a zero-width mark) and a report: per category, a label -> count map,
// plus any text hidden in tag characters, decoded.
// Besides characters it tidies whitespace, a known hiding place for data: trailing
// spaces and repeated spaces mid-line go, and so do spaces a removed symbol leaves
// behind. Fenced code blocks keep their whitespace.
function cleanText(text) {
    const raw = String(text || "").replace(/\r\n?/g, "\n");
    // NFC first: an accent stored as a separate combining mark ("u" + U+0308, as macOS
    // writes it) becomes the Latin-1 letter instead of losing its accent.
    const nfc = raw.normalize("NFC");
    const chars = Array.from(nfc);
    const counts = {};
    CLEAN_CATEGORIES.forEach(c => { counts[c] = {}; });
    const composed = (raw.match(/\p{M}/gu) || []).length - (nfc.match(/\p{M}/gu) || []).length;
    if (composed > 0) counts.composed["accent stored as a separate mark, recombined"] = composed;
    const hiddenText = [];
    const marks = [];
    const homoglyphs = homoglyphPositions(chars);
    let out = "";
    let lineHasText = false;   // anything but spaces/tabs on the current output line
    let afterDrop = false;     // the last thing done was dropping a symbol
    let fence = null;          // inside a fenced code block: its fence character

    const count = (cat, ch, label) => { const l = label || charLabel(ch); counts[cat][l] = (counts[cat][l] || 0) + 1; };
    const emit = str => {
        out += str;
        afterDrop = false;
        const nl = str.lastIndexOf("\n");
        if (nl >= 0) lineHasText = /[^ \t]/.test(str.slice(nl + 1));
        else if (/[^ \t]/.test(str)) lineHasText = true;
    };
    const removed = (cat, ch, label) => {
        count(cat, ch, label);
        const l = label || charLabel(ch);
        const last = marks[marks.length - 1];
        if (last && last.kind === "removed" && last.start === out.length) {
            last.count++;
            // A long run of removals is one mark; its tooltip names the first few kinds.
            if (last.labels.length < 12 && !last.labels.includes(l)) last.labels.push(l);
        } else {
            marks.push({ start: out.length, end: out.length, kind: "removed", count: 1, labels: [l] });
        }
    };
    const replaced = (cat, ch, rep) => {
        // A replacement that starts with a space (a decomposed accent, say) mustn't
        // double one already there.
        if (!fence && lineHasText && out.endsWith(" ") && rep.startsWith(" ")) {
            rep = rep.replace(/^ +/, "");
            if (!rep) { removed(cat, ch); return; }
        }
        count(cat, ch);
        marks.push({ start: out.length, end: out.length + rep.length, kind: "clean", labels: [charLabel(ch)] });
        emit(rep);
    };
    // Cut spaces/tabs off the end of the output; counted under `label` unless silent.
    const trimEnd = label => {
        let k = out.length;
        while (k > 0 && (out[k - 1] === " " || out[k - 1] === "\t")) k--;
        if (k === out.length) return;
        const cut = out.slice(k);
        out = out.slice(0, k);
        while (marks.length && marks[marks.length - 1].end > out.length) {
            const mk = marks[marks.length - 1];
            if (mk.start >= out.length && mk.end > mk.start) marks.pop();
            else { mk.end = Math.max(mk.start, out.length); break; }
        }
        if (label) for (const ch of cut) removed("spaces", ch, ch === "\t" ? "trailing tab" : label);
    };

    for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];
        const cp = ch.codePointAt(0);
        if (i === 0 || chars[i - 1] === "\n") {
            let k = i;
            while (chars[k] === " " || chars[k] === "\t") k++;
            const f = chars[k] === "`" || chars[k] === "~" ? chars[k] : null;
            if (f && chars[k + 1] === f && chars[k + 2] === f) {
                if (!fence) fence = f;
                else if (fence === f) fence = null;
            }
        }
        if (cp >= 0xe0000 && cp <= 0xe007f) {
            // Tag characters: invisible copies of ASCII (U+E0020-U+E007E). Decode the run,
            // so the user can see what was smuggled in, then drop it.
            let decoded = "";
            let j = i;
            while (j < chars.length && chars[j].codePointAt(0) >= 0xe0000 && chars[j].codePointAt(0) <= 0xe007f) {
                const c = chars[j].codePointAt(0);
                if (c >= 0xe0020 && c <= 0xe007e) decoded += String.fromCharCode(c - 0xe0000);
                removed("hidden", chars[j]);
                j++;
            }
            if (decoded.trim()) hiddenText.push(decoded);
            i = j - 1;
            continue;
        }
        if (ch === "\n") {
            if (!fence) trimEnd(afterDrop ? null : "trailing space");
            emit(ch);
            continue;
        }
        if (ch === " " && !fence) {
            // A symbol was dropped next to this space: don't leave "  " or a leading space.
            if (afterDrop && (!lineHasText || out.endsWith(" "))) continue;
            if (lineHasText && out.endsWith(" ")) {
                // Spaces running to the end of the line are trailing: trimEnd counts them.
                let k = i;
                while (chars[k] === " " || chars[k] === "\t") k++;
                if (k < chars.length && chars[k] !== "\n") { removed("spaces", ch, "repeated space"); continue; }
            }
        }
        if (afterDrop && !fence && /^[,.;:!?)\]]$/.test(ch)) trimEnd(null);
        if (ch === "\t") { emit(ch); continue; }
        if (homoglyphs.has(i)) { replaced("homoglyph", ch, HOMOGLYPHS[ch]); continue; }
        if (KEEP_RE.test(ch)) { emit(ch); continue; }
        if (ch === "\u2028" || ch === "\u2029") { if (!fence) trimEnd(null); replaced("spaces", ch, "\n"); continue; }
        if (SPACE_CHARS.includes(ch)) { replaced("spaces", ch, " "); continue; }
        if (ch === "\u2014" || ch === "\u2015") {
            // An em dash becomes a spaced hyphen, as people type it: "a - b".
            trimEnd(null);
            const lineStart = out.length === 0 || out.endsWith("\n");
            // Following spaces and further dashes ("\u2014\u2014") fold into this one.
            let j = i + 1;
            while (j < chars.length && (chars[j] === " " || chars[j] === "\t" || SPACE_CHARS.includes(chars[j]) || chars[j] === "\u2014" || chars[j] === "\u2015")) {
                if (chars[j] === "\u2014" || chars[j] === "\u2015") count("typography", chars[j]);
                j++;
            }
            const lineEnd = j >= chars.length || chars[j] === "\n";
            replaced("typography", ch, lineStart ? "- " : lineEnd ? " -" : " - ");
            i = j - 1;
            continue;
        }
        if (INVISIBLE_RE.test(ch)) { removed("invisible", ch); continue; }
        const rep = transliterate(ch);
        if (rep !== null) {
            replaced(Object.prototype.hasOwnProperty.call(CHAR_MAP, ch) && !/\p{L}/u.test(ch) ? "typography" : "transliterated", ch, rep);
            continue;
        }
        removed("dropped", ch);
        afterDrop = true;
    }
    if (!fence) trimEnd(afterDrop ? null : "trailing space");
    return { text: out, marks, report: { counts, hiddenText } };
}

// Add one clean report into another (the second pass cleans the model's output).
function mergeCleanReports(a, b) {
    const counts = {};
    CLEAN_CATEGORIES.forEach(cat => {
        counts[cat] = { ...((a && a.counts[cat]) || {}) };
        Object.entries((b && b.counts[cat]) || {}).forEach(([l, n]) => { counts[cat][l] = (counts[cat][l] || 0) + n; });
    });
    return { counts, hiddenText: [...((a && a.hiddenText) || []), ...((b && b.hiddenText) || [])] };
}

function cleanTotal(report) {
    return CLEAN_CATEGORIES.reduce((sum, cat) => sum + Object.values(report.counts[cat]).reduce((s, n) => s + n, 0), 0);
}

// ========== Language ==========

// Short, frequent words per language: enough to tell these apart on one paragraph.
const STOPWORDS = {
    en: "the and is are of to in that it with for this was not you be have on as at by from or but",
    de: "der die das und ist nicht ein eine zu mit den auch sich auf f\u00fcr es im dem von sind wir ich werden oder aber wie bei",
    fr: "le la les et est des une un que pour dans pas sur avec ce qui du au sont il elle mais ou nous",
    es: "el la los las y es que en un una por con para no se del como est\u00e1 pero son lo al",
    it: "il la che di e \u00e8 un una per non sono con del della gli nel ma anche si come",
    nl: "de het een en van is niet dat op met zijn voor ook er maar te wordt aan",
    pt: "o a os as e \u00e9 que em um uma n\u00e3o para com do da se mas por s\u00e3o",
};
const LANGUAGE_NAMES = { en: "English", de: "German", fr: "French", es: "Spanish", it: "Italian", nl: "Dutch", pt: "Portuguese" };
// The keyboard people writing the language most likely use; anything else gets QWERTY.
const KEYBOARD_FOR_LANGUAGE = { de: "qwertz", fr: "azerty" };

// The language of `text` as a code from STOPWORDS, or null when the text is too short
// or the counts too close to call.
function detectLanguage(text) {
    const words = String(text || "").toLowerCase().match(/\p{L}+/gu) || [];
    if (words.length < 8) return null;
    const scores = Object.entries(STOPWORDS).map(([lang, list]) => {
        const set = new Set(list.split(" "));
        return [lang, words.filter(w => set.has(w)).length];
    }).sort((a, b) => b[1] - a[1]);
    const [best, second] = scores;
    if (best[1] < 3 || best[1] < words.length * 0.08 || best[1] < second[1] * 1.3) return null;
    return best[0];
}

// ========== Stage 2: rewording ==========

// Split text into blocks whose texts concatenate back to the input exactly:
// "code" (a fenced block), "sep" (blank lines) and "para" (consecutive non-blank lines).
// `rewrite` marks paragraphs worth sending to the model: real prose, not a table,
// heading, bare URL or something too short to reword.
function splitParagraphs(text) {
    const lines = String(text || "").match(/[^\n]*\n|[^\n]+$/g) || [];
    const blocks = [];
    let fence = null;
    const push = (kind, line) => {
        const last = blocks[blocks.length - 1];
        if (last && last.kind === kind && kind !== "code") last.text += line;
        else blocks.push({ kind, text: line });
    };
    for (const line of lines) {
        const marker = line.trimStart().match(/^(`{3,}|~{3,})/);
        if (fence) {
            blocks[blocks.length - 1].text += line;
            if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !line.trim().slice(marker[1].length).trim()) fence = null;
        } else if (marker) {
            fence = marker[1];
            blocks.push({ kind: "code", text: line });
        } else if (!line.trim()) {
            push("sep", line);
        } else {
            push("para", line);
        }
    }
    let offset = 0;
    for (const b of blocks) {
        b.start = offset;
        offset += b.text.length;
        b.rewrite = b.kind === "para" && isRewritable(b.text);
    }
    return blocks;
}

function isRewritable(para) {
    const t = para.trim();
    const letters = (t.match(/\p{L}/gu) || []).length;
    if (letters < 40) return false;
    const lines = t.split("\n");
    if (lines.every(l => /^\s*\|/.test(l))) return false;               // a table
    if (lines.length === 1 && /^#{1,6}\s/.test(t)) return false;         // a heading
    if (/^(?:https?:\/\/|www\.)\S+$/i.test(t)) return false;            // a bare URL
    return true;
}

// Seeded PRNG (mulberry32): a seed gives the same run every time.
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Which of `n` eligible paragraphs to reword: a random `share` of them (0-1), at least
// one when share > 0. Returns sorted indices into the eligible list.
function pickParagraphs(n, share, rng) {
    if (n <= 0 || share <= 0) return [];
    const k = Math.min(n, Math.max(1, Math.round(n * share)));
    const idx = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    return idx.slice(0, k).sort((a, b) => a - b);
}

const REWRITE_SYSTEM = [
    "You rewrite one passage of text so it reads as if a person wrote it themselves.",
    "Rules:",
    "- Keep the meaning and every fact, name, number and quote.",
    "- Keep the language of the passage: German stays German, English stays English.",
    "- Vary the sentence length, and prefer plain everyday words over formal ones.",
    "- Avoid stock phrases such as \"delve\", \"moreover\", \"furthermore\", \"in conclusion\", \"it is important to note\", and their equivalents in other languages (German: \"dar\u00fcber hinaus\", \"zusammenfassend l\u00e4sst sich sagen\", \"es ist wichtig zu beachten\").",
    "- Don't add or drop information. Keep Markdown that is there (lists, bold), but add none.",
    "- Reply with the rewritten passage only: no introduction, no comments, no quotation marks around it.",
].join("\n");

// `lang` (a LANGUAGE_NAMES code) is spelled out in the prompt: "keep the language" alone
// isn't enough for small models, which drift into English on German text.
function buildRewriteMessages(paragraph, lang) {
    const name = LANGUAGE_NAMES[lang];
    const system = name ? `${REWRITE_SYSTEM}\n- The passage is in ${name}. Write your rewrite in ${name}.` : REWRITE_SYSTEM;
    return [
        { role: "system", content: system },
        { role: "user", content: String(paragraph).trim() },
    ];
}

// The chat request body for one paragraph. Thinking is switched off where the chat
// template supports it (a reasoning trace only costs time here); `noKwargs` drops that
// for a strict server that refused it once.
function buildRewriteBody(model, paragraph, noKwargs, lang) {
    const body = {
        model: model || "local-model",
        messages: buildRewriteMessages(paragraph, lang),
        temperature: 0.9,
        stream: false,
    };
    if (!noKwargs) body.chat_template_kwargs = { enable_thinking: false };
    return body;
}

// The answer without any reasoning trace. A reply that is all trace (cut off before
// the answer) comes back empty.
function stripThinking(text) {
    let t = String(text || "");
    t = t.replace(/<(think|thought|reasoning)>[\s\S]*?<\/\1>/gi, "");
    // A template that opens the trace in the prompt leaves only the closing tag.
    const close = t.search(/<\/(?:think|thought|reasoning)>/i);
    if (close >= 0) t = t.slice(t.indexOf(">", close) + 1);
    // An opening tag never closed: the model ran out of tokens while thinking.
    const open = t.search(/<(?:think|thought|reasoning)>/i);
    if (open >= 0) t = t.slice(0, open);
    return t.trim();
}

const PREAMBLE_RE = /^(?:here(?:'s| is| are)\b|sure[,!.]|certainly[,!.]|of course[,!.]|okay[,!.]|ok[,!.]|hier ist\b|hier sind\b|gerne[,!.]|klar[,!.]|nat\u00fcrlich[,!.]|rewritten\b|umformuliert\b|voici\b|voil\u00e0\b|claro[,!.]|aqu\u00ed (?:est\u00e1|tienes)\b|ecco\b|certo[,!.])/i;

// Is the model's reply a usable rewrite of `orig` (in language `lang`, if known)?
// Returns the text to use, or why not.
function acceptRewrite(orig, reply, lang) {
    let t = stripThinking(reply);
    const o = String(orig || "").trim();
    // Quotes wrapped around the whole reply that the original didn't have.
    if (t.length > 1 && /^["'\u201c\u201e]/.test(t) && /["'\u201c\u201d]$/.test(t) && !/^["'\u201c\u201e]/.test(o)) t = t.slice(1, -1).trim();
    if (!t) return { ok: false, reason: "empty reply" };
    if (PREAMBLE_RE.test(t)) return { ok: false, reason: "the model added an introduction" };
    const ratio = t.length / Math.max(1, o.length);
    if (ratio < 0.5) return { ok: false, reason: "reply much shorter than the original" };
    if (ratio > 2) return { ok: false, reason: "reply much longer than the original" };
    const got = lang ? detectLanguage(t) : null;
    if (got && got !== lang) return { ok: false, reason: `the model answered in ${LANGUAGE_NAMES[got]} instead of ${LANGUAGE_NAMES[lang]}` };
    return { ok: true, text: t };
}

// Put a rewritten core back between the paragraph's own leading/trailing whitespace.
function keepWhitespace(original, core) {
    const lead = original.match(/^\s*/)[0];
    const trail = original.match(/\s*$/)[0];
    return lead + core + trail;
}

// ========== Stage 3: typos ==========

const KEYBOARDS = {
    qwertz: ["qwertzuiop\u00fc", "asdfghjkl\u00f6\u00e4", "yxcvbnm"],
    qwerty: ["qwertyuiop", "asdfghjkl", "zxcvbnm"],
    azerty: ["azertyuiop", "qsdfghjklm", "wxcvbn"],
};

// Letters next to `ch` on the layout: same row left/right, and the touching keys of the
// rows above and below (staggered: up = same and next column, down = previous and same).
function keyNeighbors(ch, layout) {
    const rows = KEYBOARDS[layout] || KEYBOARDS.qwertz;
    const lower = ch.toLowerCase();
    for (let r = 0; r < rows.length; r++) {
        const c = rows[r].indexOf(lower);
        if (c < 0) continue;
        const near = [rows[r][c - 1], rows[r][c + 1]];
        if (r > 0) near.push(rows[r - 1][c], rows[r - 1][c + 1]);
        if (r < rows.length - 1) near.push(rows[r + 1][c - 1], rows[r + 1][c]);
        return near.filter(Boolean);
    }
    return [];
}

// Ranges no typo may touch: fenced code, inline code, URLs, e-mail addresses.
function protectedRanges(text) {
    const ranges = [];
    const add = re => { for (const m of text.matchAll(re)) ranges.push([m.index, m.index + m[0].length]); };
    add(/(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(\n\2[^\n]*|$)/g);
    add(/`[^`\n]+`/g);
    add(/\b(?:https?:\/\/|www\.)[^\s<>()]+/gi);
    add(/[\w.+-]+@[\w-]+\.[\w.-]+/g);
    return ranges;
}

// One typo in `word` (letters only). Returns the new word and the kind, or null.
function makeTypo(word, kind, layout, rng, sentenceStart) {
    const pick = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
    const n = word.length;
    if (kind === "case") {
        if (!sentenceStart || word[0] === word[0].toLowerCase()) return null;
        return word[0].toLowerCase() + word.slice(1);
    }
    if (kind === "neighbor") {
        for (let tries = 0; tries < 4; tries++) {
            const i = pick(1, n - 1);
            const near = keyNeighbors(word[i], layout);
            if (!near.length) continue;
            let rep = near[Math.floor(rng() * near.length)];
            if (word[i] !== word[i].toLowerCase()) rep = rep.toUpperCase();
            return word.slice(0, i) + rep + word.slice(i + 1);
        }
        return null;
    }
    if (kind === "swap") {
        for (let tries = 0; tries < 4; tries++) {
            const i = pick(1, n - 2);
            if (word[i] !== word[i + 1]) return word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2);
        }
        return null;
    }
    if (kind === "drop") {
        const i = pick(1, n - 1);
        return word.slice(0, i) + word.slice(i + 1);
    }
    if (kind === "double") {
        const i = pick(1, n - 1);
        return word.slice(0, i + 1) + word[i] + word.slice(i + 1);
    }
    return null;
}

const TYPO_KINDS = [["neighbor", 0.35], ["swap", 0.25], ["drop", 0.15], ["double", 0.15], ["case", 0.10]];

// Add typing mistakes to `text`. opts.rate is the chance per eligible word (0-1),
// opts.layout a KEYBOARDS key, opts.minGap the fewest words between two typos.
// opts.lang "de" makes capitalised words in mid-sentence eligible: in German those are
// mostly nouns, not names. (A typo never changes a word's first letter, except the
// "case" kind at a sentence start.)
// Returns the text, marks (offsets into the new text) and the edits made (offsets into
// the input), which shiftMarks uses to move earlier marks along.
function addTypos(text, opts, rng) {
    const rate = Math.max(0, Number((opts || {}).rate) || 0);
    const layout = (opts || {}).layout || "qwertz";
    const minGap = (opts || {}).minGap ?? 12;
    const nounsCapitalised = (opts || {}).lang === "de";
    const src = String(text || "");
    const ranges = protectedRanges(src);
    const isProtected = (a, b) => ranges.some(([s, e]) => a < e && b > s);
    let out = "", last = 0, sinceTypo = minGap;
    const marks = [], edits = [];
    for (const m of src.matchAll(/\p{L}+/gu)) {
        const word = m[0], at = m.index, end = at + word.length;
        sinceTypo++;
        const prev = src[at - 1] || "", next = src[end] || "";
        // Sentence start: only spaces, quotes or a list bullet since the last full stop,
        // line break or the beginning of the text.
        let p = at - 1;
        while (p >= 0 && /[ \t"'(*_]/.test(src[p])) p--;
        let sentenceStart = p < 0 || /[.!?:\n]/.test(src[p]);
        if (!sentenceStart && /[-+]/.test(src[p])) {
            let q = p - 1;
            while (q >= 0 && /[ \t]/.test(src[q])) q--;
            sentenceStart = q < 0 || src[q] === "\n";
        }
        const eligible = word.length >= 4
            && !(word.length > 1 && word === word.toUpperCase())
            && !/[\d_@/\\]/.test(prev + next)
            && !(next === "." && /\p{L}/u.test(src[end + 1] || ""))
            && !(prev === "." && /\p{L}/u.test(src[at - 2] || ""))
            && !(word[0] !== word[0].toLowerCase() && !sentenceStart && !nounsCapitalised)
            && !isProtected(at, end);
        if (!eligible || sinceTypo < minGap || rng() >= rate) continue;
        let r = rng(), kind = TYPO_KINDS[TYPO_KINDS.length - 1][0];
        for (const [k, w] of TYPO_KINDS) { if (r < w) { kind = k; break; } r -= w; }
        const typo = makeTypo(word, kind, layout, rng, sentenceStart) || makeTypo(word, "swap", layout, rng, sentenceStart);
        if (!typo || typo === word) continue;
        out += src.slice(last, at);
        marks.push({ start: out.length, end: out.length + typo.length, kind: "typo", labels: [word] });
        edits.push({ at, removed: word.length, inserted: typo.length });
        out += typo;
        last = end;
        sinceTypo = 0;
    }
    out += src.slice(last);
    return { text: out, marks, edits };
}

// Move marks made on a text through edits made to it (sorted by position, not
// overlapping, each removing at least one character). A position inside an edited span
// snaps to the span's new start, or its new end for a mark's end.
function shiftMarks(marks, edits) {
    const move = (pos, isEnd) => {
        let delta = 0;
        for (const e of edits) {
            if (e.at + e.removed <= pos) delta += e.inserted - e.removed;
            else if (e.at < pos) return e.at + delta + (isEnd ? e.inserted : 0);
            else break;
        }
        return pos + delta;
    };
    return marks.map(m => {
        const start = move(m.start, false);
        return { ...m, start, end: m.end === m.start ? start : Math.max(start, move(m.end, true)) };
    });
}

// ========== Copied from HermitUI (../src/script.js) ==========

// Hosts that keep the text on the user's own machine or LAN.
function isLocalEndpoint(rawUrl) {
    let host;
    try { host = new URL(rawUrl).hostname; }
    catch {
        try { host = new URL("https://" + rawUrl).hostname; } catch { return false; }
    }
    host = host.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
    if (host === "::1") return true;
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;            // IPv6 unique-local
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false;
    if (host === "0.0.0.0") return true;
    if (/^127\./.test(host)) return true;                        // loopback
    if (/^10\./.test(host)) return true;                         // RFC1918
    if (/^192\.168\./.test(host)) return true;                   // RFC1918
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;    // RFC1918
    if (/^169\.254\./.test(host)) return true;                   // link-local
    return false;
}

// Normalize a base URL (or a pasted full chat endpoint) to the given API path.
function apiEndpoint(base, path) {
    let url = base.trim().replace(/\/+$/, "");
    for (const known of ["/chat/completions", "/completions", "/models"]) {
        if (url.endsWith(known)) { url = url.slice(0, -known.length); break; }
    }
    if (!url.endsWith(path)) url += path;
    return url;
}

// A base URL typed without a scheme would be fetched relative to this page.
function normalizeApiUrl(raw) {
    const url = String(raw || "").trim();
    if (!url) throw new Error("Enter an API Base URL first, e.g. http://localhost:8080/v1.");
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(url)) return url;
    return (isLocalEndpoint("http://" + url) ? "http://" : "https://") + url;
}

// One line of advice under a failed request; the raw error stays visible above it.
// "" means the error already says everything useful.
function chatErrorHint(message, opts) {
    const { apiUrl = "", mixedContent = false } = opts || {};
    const msg = String(message || "");
    const status = Number((msg.match(/^Server Error (\d{3})\b/) || [])[1] || 0);
    if (status === 401 || status === 403) return "The server rejected the request's credentials — check the API key in Settings.";
    if (status === 404) return "Nothing answered at that address — check the API Base URL and the model name in Settings.";
    if (status === 429) return "Rate-limited or out of quota — wait a moment, or check your provider account.";
    if (status >= 500) return "The server failed while handling the request — its own logs will say why.";
    if (!status && /is not valid JSON|JSON\.parse|Unexpected token/i.test(msg)) {
        return "The server answered, but not with JSON — the API Base URL probably points at a web page instead of the API (it usually ends in /v1).";
    }
    if (/context (?:length|size|window)|n_ctx|too many tokens|maximum context/i.test(msg)) {
        return "The paragraph doesn't fit the model's context — raise the server's context size.";
    }
    if (/Failed to fetch|NetworkError|^Load failed$/i.test(msg)) {
        if (mixedContent) return "This page is served over https, so the browser blocks plain-http servers on your network — use localhost, an https endpoint, or open the Cleaner over http.";
        return isLocalEndpoint(apiUrl)
            ? `Couldn't reach ${apiUrl} — make sure the server is running and allows CORS from this page.`
            : `Couldn't reach ${apiUrl} — check the URL and your connection; the provider must also allow requests from a browser (CORS).`;
    }
    return "";
}

// Browsers block http:// requests from an https:// page, loopback exempted.
function isBlockedMixedContent(rawUrl) {
    if (typeof location === "undefined" || location.protocol !== "https:") return false;
    if (!/^http:\/\//i.test((rawUrl || "").trim())) return false;
    let host;
    try { host = new URL(rawUrl).hostname.toLowerCase(); } catch { return false; }
    return !(host === "localhost" || host.endsWith(".localhost") || /^127\./.test(host) || host === "[::1]" || host === "::1");
}

// The "Server Error NNN: detail" shape chatErrorHint reads, from a failed response.
async function serverError(res) {
    let detail = res.statusText || "";
    try {
        const body = await res.text();
        try {
            const j = JSON.parse(body);
            detail = (j.error && (j.error.message || j.error)) || j.message || j.detail || body;
        } catch { detail = body || detail; }
    } catch { /* keep statusText */ }
    if (typeof detail !== "string") detail = JSON.stringify(detail);
    return new Error(`Server Error ${res.status}: ${detail.slice(0, 300)}`);
}

// ========== DOM ==========

if (typeof document !== "undefined") {
    const $ = id => document.getElementById(id);

    // Settings: memory only (strict ephemerality).
    let API_URL = "http://localhost:8080/v1";
    let MODEL_NAME = "";
    let API_KEY = "";
    let kwargsRejected = false;

    // The last run, so Reroll typos needn't call the model again.
    let last = null;
    let running = null;   // AbortController of the current run
    let showChanges = true;

    $("versionBadge").textContent = "v" + APP_VERSION;

    // ----- theme -----
    const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.setAttribute("data-theme", prefersDark ? "dark" : "light");
    $("themeBtn").addEventListener("click", () => {
        const dark = document.documentElement.getAttribute("data-theme") === "dark";
        document.documentElement.setAttribute("data-theme", dark ? "light" : "dark");
    });

    // ----- toast (copied from HermitUI) -----
    let toastTimeout = null;
    function showToast(message, opts) {
        const { error = false } = opts || {};
        let toast = $("toastNotification");
        if (!toast) {
            toast = document.createElement("div");
            toast.id = "toastNotification";
            toast.className = "toast";
            toast.setAttribute("role", "status");
            toast.setAttribute("aria-live", "polite");
            document.body.appendChild(toast);
        }
        toast.textContent = message;
        toast.classList.toggle("error", error);
        toast.classList.add("show");
        if (toastTimeout) clearTimeout(toastTimeout);
        toastTimeout = setTimeout(() => toast.classList.remove("show"), error ? 8000 : 2500);
    }

    function errorText(err) {
        const hint = chatErrorHint(err.message, { apiUrl: API_URL, mixedContent: isBlockedMixedContent(API_URL) });
        return (err.message || "Unknown error") + (hint ? "\n" + hint : "");
    }

    function authHeaders() {
        const h = { "Content-Type": "application/json" };
        if (API_KEY) h.Authorization = "Bearer " + API_KEY;
        return h;
    }

    function updateEndpointBadge() {
        const badge = $("endpointBadge");
        badge.textContent = (MODEL_NAME ? MODEL_NAME + " @ " : "") + API_URL.replace(/^https?:\/\//, "");
        badge.title = API_URL;
        badge.classList.toggle("remote", !isLocalEndpoint(API_URL));
        $("remoteWarning").hidden = isLocalEndpoint(API_URL);
    }
    updateEndpointBadge();

    // ----- settings modal -----
    const modal = $("settingsModal");
    function openSettings() {
        $("settingUrl").value = API_URL;
        $("settingModel").value = MODEL_NAME;
        $("settingKey").value = API_KEY;
        modal.classList.add("active");
        $("settingUrl").focus();
    }
    function closeSettings() { modal.classList.remove("active"); $("settingsBtn").focus(); }
    $("settingsBtn").addEventListener("click", openSettings);
    $("settingsCancel").addEventListener("click", closeSettings);
    modal.addEventListener("click", e => { if (e.target === modal) closeSettings(); });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && modal.classList.contains("active")) closeSettings(); });
    $("settingsSave").addEventListener("click", () => {
        let url;
        try { url = normalizeApiUrl($("settingUrl").value); }
        catch (e) { showToast(e.message, { error: true }); return; }
        if (url !== API_URL) kwargsRejected = false;
        API_URL = url;
        MODEL_NAME = $("settingModel").value.trim();
        API_KEY = $("settingKey").value.trim();
        updateEndpointBadge();
        closeSettings();
        showToast("Settings saved (for this tab only)");
    });

    async function listModels(base, key, signal) {
        const headers = key ? { Authorization: "Bearer " + key } : {};
        const res = await fetch(apiEndpoint(base, "/models"), { headers, signal });
        if (!res.ok) throw await serverError(res);
        const data = await res.json();
        return (data.data || data.models || []).map(m => (m && (m.id || m.name)) || m).filter(m => typeof m === "string");
    }

    $("testConnectionBtn").addEventListener("click", async () => {
        const btn = $("testConnectionBtn");
        let base;
        try { base = normalizeApiUrl($("settingUrl").value); }
        catch (e) { showToast(e.message, { error: true }); return; }
        btn.disabled = true;
        btn.textContent = "Testing…";
        try {
            const models = await listModels(base, $("settingKey").value.trim(), AbortSignal.timeout(10000));
            const list = $("modelList");
            list.replaceChildren(...models.map(id => Object.assign(document.createElement("option"), { value: id })));
            if (!$("settingModel").value.trim() && models.length) $("settingModel").value = models[0];
            showToast(`✅ Connected — ${models.length} model${models.length === 1 ? "" : "s"} available`);
        } catch (e) {
            const hint = chatErrorHint(e.message, { apiUrl: base, mixedContent: isBlockedMixedContent(base) });
            showToast("❌ " + (e.message || "Connection failed") + (hint ? "\n" + hint : ""), { error: true });
        } finally {
            btn.disabled = false;
            btn.textContent = "Test Connection";
        }
    });

    // ----- input: paste, open, drop -----
    const input = $("inputText");
    function updateInputStats() {
        const n = input.value.length;
        $("inputStats").textContent = n ? `${n.toLocaleString()} characters` : "";
        $("runBtn").disabled = !n || !!running;
    }
    input.addEventListener("input", updateInputStats);

    async function loadFile(file) {
        if (!file) return;
        if (file.size > 5e6) { showToast("That file is over 5 MB — paste the part you need instead.", { error: true }); return; }
        const isText = /^text\//.test(file.type) || /\.(txt|md|markdown|text|csv|html?|json|tex|rst)$/i.test(file.name);
        if (!isText) { showToast(`${file.name} isn't a text file.`, { error: true }); return; }
        input.value = await file.text();
        updateInputStats();
        showToast(`Loaded ${file.name}`);
    }
    $("openBtn").addEventListener("click", () => $("fileInput").click());
    $("fileInput").addEventListener("change", e => { loadFile(e.target.files[0]); e.target.value = ""; });
    const inputCard = $("inputCard");
    inputCard.addEventListener("dragover", e => { e.preventDefault(); inputCard.classList.add("drag"); });
    inputCard.addEventListener("dragleave", () => inputCard.classList.remove("drag"));
    inputCard.addEventListener("drop", e => {
        e.preventDefault();
        inputCard.classList.remove("drag");
        if (e.dataTransfer.files.length) loadFile(e.dataTransfer.files[0]);
    });
    $("clearBtn").addEventListener("click", () => { input.value = ""; updateInputStats(); input.focus(); });

    // ----- options -----
    const opt = {
        clean: () => $("optClean").checked,
        reword: () => $("optReword").checked,
        typos: () => $("optTypos").checked,
        share: () => Number($("optShare").value),
        rate: () => Number($("optRate").value) / 100,
        layout: () => $("optLayout").value,
    };
    function syncOptions() {
        $("optShare").disabled = !opt.reword();
        $("optRate").disabled = $("optLayout").disabled = !opt.typos();
        $("rateValue").textContent = Number($("optRate").value).toFixed(1) + " %";
        $("rerollBtn").disabled = !last || !opt.typos() || !!running;
    }
    ["optClean", "optReword", "optTypos", "optShare", "optRate", "optLayout"].forEach(id => $(id).addEventListener("input", syncOptions));
    syncOptions();

    function setStatus(text, kind) {
        const s = $("status");
        s.textContent = text || "";
        s.className = "status" + (kind ? " " + kind : "");
    }

    // ----- the model call -----
    async function rewordOne(paragraph, signal, lang) {
        if (!MODEL_NAME) {
            // Ollama needs a real model name; llama.cpp takes any. Ask the server once.
            try {
                const models = await listModels(API_URL, API_KEY, signal);
                if (models.length) { MODEL_NAME = models[0]; updateEndpointBadge(); }
            } catch (e) {
                if (e.name === "AbortError") throw e;
                /* the chat request below reports the real problem */
            }
        }
        for (let attempt = 0; attempt < 2; attempt++) {
            const res = await fetch(apiEndpoint(API_URL, "/chat/completions"), {
                method: "POST",
                headers: authHeaders(),
                body: JSON.stringify(buildRewriteBody(MODEL_NAME, paragraph, kwargsRejected, lang)),
                signal,
            });
            if (res.ok) {
                const data = await res.json();
                const msg = data.choices && data.choices[0] && data.choices[0].message;
                return (msg && msg.content) || "";
            }
            // A strict server refuses the unknown chat_template_kwargs: drop it, once.
            if (res.status === 400 && !kwargsRejected) { kwargsRejected = true; continue; }
            throw await serverError(res);
        }
        throw new Error("The server refused the request.");
    }

    // ----- pipeline -----
    async function run() {
        const source = input.value;
        if (!source) return;
        if (!opt.clean() && !opt.reword() && !opt.typos()) { showToast("Switch on at least one step.", { error: true }); return; }
        running = new AbortController();
        const signal = running.signal;
        $("runBtn").hidden = true;
        $("stopBtn").hidden = false;
        $("rerollBtn").disabled = true;
        document.body.classList.add("is-running");

        const empty = { counts: Object.fromEntries(CLEAN_CATEGORIES.map(c => [c, {}])), hiddenText: [] };
        let text = source, marks = [], clean1 = empty, clean2 = empty;
        const docLang = detectLanguage(source);
        const reword = { attempted: 0, done: 0, eligible: 0, skipped: [], stopped: false, error: null };
        try {
            if (opt.clean()) {
                const r = cleanText(text);
                text = r.text; marks = r.marks; clean1 = r.report;
            }
            if (opt.reword()) {
                const blocks = splitParagraphs(text);
                const eligible = blocks.filter(b => b.rewrite);
                reword.eligible = eligible.length;
                const chosen = new Set(pickParagraphs(eligible.length, opt.share(), mulberry32(Date.now() >>> 0)).map(i => eligible[i]));
                reword.attempted = chosen.size;
                let out = "", newMarks = [], k = 0;
                for (const b of blocks) {
                    const start = out.length;
                    let replaced = null;
                    if (chosen.has(b) && !reword.stopped && !reword.error) {
                        k++;
                        setStatus(`Rewording paragraph ${k} of ${chosen.size}…`, "busy");
                        try {
                            const lang = detectLanguage(b.text) || docLang;
                            const reply = await rewordOne(b.text, signal, lang);
                            const verdict = acceptRewrite(b.text, reply, lang);
                            if (verdict.ok) {
                                const cleaned = opt.clean() ? cleanText(verdict.text) : { text: verdict.text, report: empty };
                                clean2 = mergeCleanReports(clean2, cleaned.report);
                                replaced = keepWhitespace(b.text, cleaned.text);
                                reword.done++;
                            } else {
                                reword.skipped.push(`Paragraph ${k}: ${verdict.reason} — kept the original.`);
                            }
                        } catch (e) {
                            if (e.name === "AbortError") reword.stopped = true;
                            else reword.error = e;
                        }
                    }
                    if (replaced !== null) {
                        out += replaced;
                        const core = replaced.trim();
                        const coreStart = start + replaced.indexOf(core);
                        newMarks.push({ start: coreStart, end: coreStart + core.length, kind: "reword", labels: [b.text.trim()] });
                    } else {
                        out += b.text;
                        // This block's cleanup marks move with it.
                        const shift = start - b.start, bEnd = b.start + b.text.length;
                        const isLast = b === blocks[blocks.length - 1];
                        marks.filter(m => (m.start >= b.start && m.start < bEnd) || (isLast && m.start === bEnd))
                            .forEach(m => newMarks.push({ ...m, start: m.start + shift, end: m.end + shift }));
                    }
                }
                text = out;
                marks = newMarks;
            }
            last = { text, marks, clean1, clean2, reword, lang: docLang, did: { clean: opt.clean(), reword: opt.reword() } };
            finish();
        } finally {
            running = null;
            $("runBtn").hidden = false;
            $("stopBtn").hidden = true;
            document.body.classList.remove("is-running");
            updateInputStats();
            syncOptions();
        }
    }

    // The typo stage and rendering; also what Reroll typos reruns.
    function finish() {
        let { text, marks } = last;
        let typos = 0;
        last.layout = opt.layout() === "auto" ? (KEYBOARD_FOR_LANGUAGE[last.lang] || "qwerty") : opt.layout();
        if (opt.typos()) {
            const r = addTypos(text, { rate: opt.rate(), layout: last.layout, lang: last.lang }, mulberry32((Math.random() * 2 ** 32) >>> 0));
            marks = shiftMarks(marks, r.edits).concat(r.marks);
            text = r.text;
            typos = r.marks.length;
        }
        last.output = text;
        renderOutput(text, marks);
        renderReport(typos);
        const { reword } = last;
        if (reword.error) setStatus("❌ " + errorText(reword.error), "error");
        else if (reword.stopped) setStatus(`Stopped — reworded ${reword.done} of ${reword.attempted} paragraphs.`, "warn");
        else setStatus("Done.", "ok");
    }

    function renderOutput(text, marks) {
        const box = $("outputText");
        box.replaceChildren();
        $("copyBtn").disabled = !text;
        $("outputStats").textContent = text ? `${text.length.toLocaleString()} characters` : "";
        if (!text && !marks.length) { box.textContent = ""; return; }
        // Inline marks per character (a later mark wins), reworded ranges as a layer
        // below them, and removals as markers in between.
        const inline = new Array(text.length).fill(null);
        const reword = new Array(text.length).fill(null);
        const removedAt = new Map();
        for (const m of marks) {
            if (m.kind === "removed") {
                const prev = removedAt.get(m.start);
                if (prev) { prev.count += m.count; prev.labels = [...new Set([...prev.labels, ...m.labels])]; }
                else removedAt.set(m.start, { ...m, labels: [...m.labels] });
                continue;
            }
            const layer = m.kind === "reword" ? reword : inline;
            for (let i = Math.max(0, m.start); i < Math.min(text.length, m.end); i++) layer[i] = m;
        }
        const frag = document.createDocumentFragment();
        let i = 0;
        let rewordSpan = null;
        const target = () => rewordSpan || frag;
        while (i <= text.length) {
            const rm = removedAt.get(i);
            if (rm) {
                const s = document.createElement("span");
                s.className = "m-removed";
                s.title = `Removed ${rm.count}: ${rm.labels.slice(0, 12).join(", ")}${rm.labels.length >= 12 ? ", …" : ""}`;
                s.setAttribute("aria-label", s.title);
                target().appendChild(s);
            }
            if (i === text.length) break;
            if (reword[i] && (!rewordSpan || rewordSpan._mark !== reword[i])) {
                rewordSpan = document.createElement("span");
                rewordSpan.className = "m-reword";
                rewordSpan.title = "Reworded. Original:\n" + reword[i].labels[0];
                rewordSpan._mark = reword[i];
                frag.appendChild(rewordSpan);
            } else if (!reword[i]) {
                rewordSpan = null;
            }
            let j = i + 1;
            while (j < text.length && inline[j] === inline[i] && reword[j] === reword[i] && !removedAt.has(j)) j++;
            const piece = text.slice(i, j);
            const m = inline[i];
            if (m) {
                const s = document.createElement("span");
                s.className = "m-" + m.kind;
                s.title = m.kind === "typo" ? `Typo (was "${m.labels[0]}")` : `Was ${m.labels.join(", ")}`;
                s.textContent = piece;
                target().appendChild(s);
            } else {
                target().appendChild(document.createTextNode(piece));
            }
            i = j;
        }
        box.appendChild(frag);
    }

    const CATEGORY_TEXT = {
        hidden: "Hidden text (tag characters)",
        invisible: "Invisible characters",
        composed: "Accents stored as two characters (recombined)",
        spaces: "Unusual spaces",
        typography: "Typography",
        homoglyph: "Look-alike letters",
        transliterated: "Letters outside Latin-1",
        dropped: "Removed (no keyboard equivalent)",
    };

    function renderReport(typos) {
        const box = $("report");
        box.replaceChildren();
        const add = (tag, text, cls) => {
            const el = document.createElement(tag);
            if (text) el.textContent = text;
            if (cls) el.className = cls;
            box.appendChild(el);
            return el;
        };
        const { clean1, clean2, reword, did } = last;
        add("p", `Language: ${LANGUAGE_NAMES[last.lang] || "not recognised"}`, "report-note");
        if (did.clean) {
            const total = cleanTotal(clean1);
            add("h4", total ? `Cleanup: ${total} character${total === 1 ? "" : "s"} changed` : "Cleanup: the text was already clean");
            for (const cat of CLEAN_CATEGORIES) {
                const entries = Object.entries(clean1.counts[cat]).sort((a, b) => b[1] - a[1]);
                if (!entries.length) continue;
                const n = entries.reduce((s, [, c]) => s + c, 0);
                const details = add("details", "", "report-cat cat-" + cat);
                const sum = document.createElement("summary");
                sum.textContent = `${CATEGORY_TEXT[cat]}: ${n}`;
                details.appendChild(sum);
                const ul = document.createElement("ul");
                entries.forEach(([label, c]) => { const li = document.createElement("li"); li.textContent = `${label} × ${c}`; ul.appendChild(li); });
                details.appendChild(ul);
            }
            if (clean1.hiddenText.length) {
                add("p", "⚠️ The text carried hidden instructions or data, now removed:", "report-warn");
                clean1.hiddenText.forEach(t => add("pre", t, "hidden-text"));
            }
        }
        if (did.reword) {
            if (!reword.eligible) add("h4", "Rewording: no paragraph long enough to reword");
            else add("h4", `Rewording: ${reword.done} of ${reword.eligible} paragraph${reword.eligible === 1 ? "" : "s"} reworded`);
            reword.skipped.forEach(s => add("p", s, "report-note"));
            const fixed = cleanTotal(clean2);
            if (fixed) add("p", `Cleaned ${fixed} character${fixed === 1 ? "" : "s"} out of the model's answers.`, "report-note");
            add("p", "Rewording changes the word choice, which is what statistical watermarks live in. No tool can promise what an AI detector will say.", "report-note");
        }
        if (opt.typos()) add("h4", `Typos: ${typos} added (${last.layout.toUpperCase()} keyboard)`);
    }

    $("runBtn").addEventListener("click", () => { run().catch(e => setStatus("❌ " + errorText(e), "error")); });
    $("stopBtn").addEventListener("click", () => { if (running) running.abort(); });
    $("rerollBtn").addEventListener("click", () => { if (last && !running) finish(); });
    input.addEventListener("keydown", e => {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !$("runBtn").disabled) { e.preventDefault(); $("runBtn").click(); }
    });

    $("changesBtn").addEventListener("click", () => {
        showChanges = !showChanges;
        $("outputText").classList.toggle("plain", !showChanges);
        $("changesBtn").setAttribute("aria-pressed", String(showChanges));
        $("changesBtn").textContent = showChanges ? "Hide changes" : "Show changes";
    });

    $("copyBtn").addEventListener("click", async () => {
        if (!last || last.output == null) return;
        try {
            await navigator.clipboard.writeText(last.output);
            showToast("Copied");
        } catch {
            // file:// in some browsers: fall back to selecting a hidden textarea.
            const ta = document.createElement("textarea");
            ta.value = last.output;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand("copy");
            ta.remove();
            showToast(ok ? "Copied" : "Copy failed — select the text and copy it by hand.", { error: !ok });
        }
    });

    updateInputStats();
}
