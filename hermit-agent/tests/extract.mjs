// Pulls the real implementations under test out of ../src/script.js and evaluates them
// in isolation, so the tests exercise shipped code rather than a copy that can drift
// (the same approach as HermitUI's ../../tests/extract.mjs). Everything sliced out here
// is pure — no DOM, no worker — so taking it by name is enough. Renaming one of these
// functions fails the suite loudly; update the list below with the rename.
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

// A single-line `const NAME = …;` declaration the extracted code depends on.
function constDecl(name) {
    const m = src.match(new RegExp(`^\\s*const ${name} = .*;$`, "m"));
    if (!m) throw new Error(`extract.mjs: const ${name} not found in src/script.js`);
    return m[0].trim();
}

// A marker block's `const NAME = <strict JSON>;` (BUNDLED_LIBRARIES, which build.py
// parses the same way).
function jsonBlock(marker, name) {
    const m = src.match(new RegExp(`// @${marker}:start\\nconst ${name} = (\\{[\\s\\S]*?\\n\\});\\n// @${marker}:end`));
    if (!m) throw new Error(`extract.mjs: ${name} block not found in src/script.js`);
    return `const ${name} = ${JSON.stringify(JSON.parse(m[1]))};`;
}

const CONSTS = ["FILE_EXTENSIONS", "APP_VERSION", "SESSION_FORMAT", "SESSION_FORMAT_VERSION", "LIMITS", "CLOUD_PROVIDERS", "REASONING_PARAM_KEYS", "CRC_TABLE", "STEP_STAT_KEYS", "FILE_TOOLS", "READONLY_FILE_TOOLS", "FANCY_PUNCT", "AGENT_TOOL_NAMES", "HARNESS_ONLY_PACKAGES"];
const FUNCS = [
    "escapeHtml", "createThrottle", "parseThinkSegments", "apiEndpoint", "normalizeApiUrl", "apiRoot",
    "detectCloudProvider", "isLocalEndpoint", "describeRemoteEndpoint", "chatErrorHint",
    "parseReasoningTemplateSupport", "buildReasoningParams", "looksLikeReasoningRejection",
    "buildSystemPrompt", "formatBytes", "buildTaskMessage", "splitReply", "parseReply", "truncateOutput",
    "diffListings", "formatChanges", "classifyEffect", "buildObservation", "appendToLastUserMessage",
    "isSafeRelPath", "normalizeUploadPath", "makeFence", "filenameCommentHint", "missingMentionedFiles",
    "normalizeActionPath", "normalizeSearchPath", "globToRegExp", "hasNestedQuantifier", "searchRegExp", "parseTagAttrs", "extractFileActions", "decodeTextFile", "countOccurrences", "plainPunct", "matchEditText", "closestExcerpt", "applyFileActions",
    "fileActionLabel", "formatFileResults", "validateSyntaxResult", "syntaxErrorNote",
    "buildStepStats", "cleanStepStats", "formatStepStats",
    "formatFileList", "isContextOverflowError", "messageChars", "estimateTokens", "contextLimit", "compactionDue", "cutByContext", "contextSizeFromModelList", "ollamaNumCtx", "checkpointsToDrop",
    "planCompaction", "taskMessageBase", "buildCompactionRequest", "buildCompactedMessages",
    "crc32", "streamThrough", "sha256Hex", "sha256HexJs", "zipWrite", "zipRead", "cleanForExport",
    "transcriptMarkdown", "buildSessionArchive", "validateManifest", "validateSession", "parseSessionArchive", "workspaceEntriesFromZip",
    "lineDiff", "diffHunks", "elideHistory", "isRetryableError", "retryDelayMs", "contextGauge", "uploadWarning",
    "packageImportNames", "importPackageIndex", "normalizePackageName", "bundledImportIndex", "bundledAliases", "planBundledLoad", "packageLoadNote", "packageFailureMessage", "moduleNotFoundHint", "referencedPythonFiles", "rewritePyodideInstallAdvice", "readEntry",
    "describeBinary", "zipCentralDirectory", "binarySummary", "binaryFileNotes", "periodicFileListing", "fileListingKey",
    "awaitsModel", "copyMessage", "agentToolDefs", "resolveProtocol", "toolSupportFromProps", "toolSupportFromOllamaShow", "findListedModel",
    "toolSupportFromModelList", "looksLikeToolRejection", "fallbackToolCallId", "toolCallToFileAction", "cleanAskOptions", "splitAskOptions", "parseToolCalls", "toolCallAsText",
    "messageAsText", "toolHistoryAsText", "fileCallResults", "noActionAdvice",
];

const mod = `
${CONSTS.map(constDecl).join("\n")}
${jsonBlock("bundled", "BUNDLED_LIBRARIES")}
${FUNCS.map(fn).join("\n")}
export { ${[...CONSTS, "BUNDLED_LIBRARIES", ...FUNCS].join(", ")} };
`;

export default await import("data:text/javascript;base64," + Buffer.from(mod).toString("base64"));
