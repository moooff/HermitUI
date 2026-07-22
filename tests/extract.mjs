// Pulls the real export/import implementations out of ../src/script.js and evaluates
// them in isolation, so the tests exercise shipped code rather than a copy that can
// drift. src/script.js is a browser script with no module boundaries — the functions
// under test are pure string handling, so slicing them out by name is enough.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "script.js");
const src = readFileSync(SRC, "utf8");

// Slice `function name(...) { ... }` by brace matching from its declaration.
function fn(name) {
    const i = src.indexOf(`function ${name}(`);
    if (i < 0) throw new Error(`extract.mjs: function ${name} not found in src/script.js`);
    let depth = 0, started = false, j = i;
    for (; j < src.length; j++) {
        if (src[j] === "{") { depth++; started = true; }
        else if (src[j] === "}") { depth--; if (started && depth === 0) { j++; break; } }
    }
    return src.slice(i, j);
}

// Slice a single-line `const NAME = …;` declaration the extracted code depends on.
function constDecl(name) {
    const m = src.match(new RegExp(`^\\s*const ${name} = .*;$`, "m"));
    if (!m) throw new Error(`extract.mjs: const ${name} not found in src/script.js`);
    return m[0].trim();
}

// The export handler is an inline arrow, so take just its Markdown-building body —
// everything from the header string up to the Blob/download plumbing.
function exportBody() {
    const a = src.indexOf('let md = "# Chat Export');
    const b = src.indexOf("const blob = new Blob", a);
    if (a < 0 || b < 0) throw new Error("extract.mjs: export handler body not found in src/script.js");
    return src.slice(a, b);
}

const mod = `
${constDecl("SUMMARY_PREFIX")}
${fn("escapeHtml")}
${fn("unescapeHtml")}
${fn("contentToText")}
${fn("parseChatExport")}
${fn("splitContextBlocks")}
function exportMd(messages) { ${exportBody()} return md; }
export { SUMMARY_PREFIX, escapeHtml, unescapeHtml, contentToText, parseChatExport, splitContextBlocks, exportMd };
`;

export default await import("data:text/javascript;base64," + Buffer.from(mod).toString("base64"));
