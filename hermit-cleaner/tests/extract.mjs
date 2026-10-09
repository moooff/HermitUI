// Pulls the real implementations under test out of ../src/script.js and evaluates them
// in isolation, so the tests exercise shipped code rather than a copy that can drift
// (the same approach as HermitUI's ../../tests/extract.mjs). Everything sliced out here
// is pure (no DOM), so taking it by name is enough. Renaming one of these functions
// fails the suite loudly; update the lists below with the rename.
//
// Slicing is plain brace counting: an unbalanced brace inside a listed function's
// regex, string or comment runs the slice on into the next function, and every test
// file fails with "Identifier ... has already been declared". To see the real error:
//   node -e 'import("./tests/extract.mjs").catch(e => console.log(e.message))'
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "script.js");
const src = readFileSync(SRC, "utf8");

// Slice `[async] function name(...) { ... }` by brace matching from its declaration.
function fn(name) {
    let i = src.indexOf(`function ${name}(`);
    if (i < 0) throw new Error(`extract.mjs: function ${name} not found in src/script.js`);
    if (src.slice(i - 6, i) === "async ") i -= 6;
    let depth = 0, started = false, j = i;
    for (; j < src.length; j++) {
        if (src[j] === "{") { depth++; started = true; }
        else if (src[j] === "}") { depth--; if (started && depth === 0) { j++; break; } }
    }
    return src.slice(i, j);
}

// A top-level `const NAME = ...;` declaration, single- or multi-line (an object or
// array literal closed by `};` / `];` at the start of a line).
function constDecl(name) {
    const one = src.match(new RegExp(`^const ${name} = [^\\n]*;$`, "m"));
    if (one && !/[[{(]$/.test(one[0].slice(0, -1))) return one[0];
    const multi = src.match(new RegExp(`^const ${name} = [\\s\\S]*?^[\\]}\\)][^\\n]*;$`, "m"));
    if (!multi) throw new Error(`extract.mjs: const ${name} not found in src/script.js`);
    return multi[0];
}

const CONSTS = ["APP_VERSION", "KEEP_RE", "INVISIBLE_RE", "SPACE_CHARS", "CHAR_MAP", "HOMOGLYPHS", "CHAR_NAMES",
    "CLEAN_CATEGORIES", "STOPWORDS", "LANGUAGE_NAMES", "KEYBOARD_FOR_LANGUAGE", "REWRITE_SYSTEM", "PREAMBLE_RE", "KEYBOARDS", "TYPO_WEIGHTS", "TYPO_NAMES", "GERMAN_DETERMINER_RE", "GERMAN_COMMA_WORDS", "LETTER_KINDS", "ABBREVIATIONS"];
const FUNCS = [
    "charLabel", "transliterate", "homoglyphPositions", "cleanText", "mergeCleanReports", "cleanTotal",
    "detectLanguage", "splitParagraphs", "isRewritable", "splitSentences", "rewordUnits", "groupUnits", "applyRewrites", "mulberry32", "pickUnits", "buildRewriteMessages", "buildRewriteBody",
    "stripThinking", "acceptRewrite",
    "keyNeighbors", "protectedRanges", "makeTypo", "addTypos", "shiftMarks",
    "isLocalEndpoint", "apiEndpoint", "normalizeApiUrl", "chatErrorHint",
];

const mod = `
${CONSTS.map(constDecl).join("\n")}
${FUNCS.map(fn).join("\n")}
export { ${[...CONSTS, ...FUNCS].join(", ")} };
`;

export default await import("data:text/javascript;base64," + Buffer.from(mod).toString("base64"));
