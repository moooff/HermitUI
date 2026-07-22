// Pulls the real implementations under test out of ../src/script.js and evaluates them
// in isolation, so the tests exercise shipped code rather than a copy that can drift.
// src/script.js is a browser script with no module boundaries — everything sliced out
// here is pure (no DOM, no network), so taking it by name is enough. Anything that
// touches `document` cannot be extracted this way; test that end-to-end instead.
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

// Same, for a multi-line `const NAME = { … };` object literal. Brace matching is safe
// here because the braces inside its strings/templates/regexes are themselves balanced.
function constBlock(name) {
    const i = src.indexOf(`const ${name} = {`);
    if (i < 0) throw new Error(`extract.mjs: const block ${name} not found in src/script.js`);
    let depth = 0, started = false, j = i;
    for (; j < src.length; j++) {
        if (src[j] === "{") { depth++; started = true; }
        else if (src[j] === "}") { depth--; if (started && depth === 0) { j++; break; } }
    }
    return src.slice(i, j) + ";";
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
${constDecl("CLOUD_PROVIDERS")}
${constDecl("SUPPORTED_IMAGE_TYPES")}
${constDecl("VISION_MODELS")}
${constDecl("VISION_NAME_RE")}
${constBlock("CHAT_TEMPLATES")}
${fn("escapeHtml")}
${fn("unescapeHtml")}
${fn("contentToText")}
${fn("parseChatExport")}
${fn("splitContextBlocks")}
${fn("parseThinkSegments")}
${fn("buildFinalHistory")}
${fn("createThrottle")}
${fn("apiEndpoint")}
${fn("detectCloudProvider")}
${fn("isTextFile")}
${fn("isImageFile")}
${fn("modelSupportsVision")}
${fn("modelReportsVision")}
${fn("extractModelId")}
${fn("normalizeGgufUrl")}
${fn("detectTemplateFromArch")}
${fn("buildWllamaPrompt")}
function exportMd(messages) { ${exportBody()} return md; }
export {
    SUMMARY_PREFIX, escapeHtml, unescapeHtml, contentToText, parseChatExport,
    splitContextBlocks, exportMd,
    parseThinkSegments, buildFinalHistory, createThrottle, apiEndpoint,
    detectCloudProvider, isTextFile, isImageFile, modelSupportsVision,
    modelReportsVision, extractModelId, normalizeGgufUrl, detectTemplateFromArch,
    buildWllamaPrompt,
};
`;

export default await import("data:text/javascript;base64," + Buffer.from(mod).toString("base64"));
