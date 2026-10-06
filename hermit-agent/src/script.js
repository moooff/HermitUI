// ========== HermitUI Agent — main thread ==========
// Layout of this file:
//   1. Configuration
//   2. Helpers copied from HermitUI (see AGENTS.md "Copied from HermitUI")
//   3. Agent logic (pure, unit-tested via tests/extract.mjs)
//   4. Zip + session archive (pure, unit-tested)
//   5. Python worker client
//   6. LLM streaming
//   7. Session state, workspace store, checkpoints
//   8. Agent loop
//   9. UI
// Functions in sections 2–4 must stay free of DOM access: the unit tests slice them out
// of this file by name.

// ========== 1. Configuration ==========
const APP_VERSION = "0.3.0";
const PYODIDE_VERSION = "0.29.5";
const PYODIDE_CDN = "https://cdn.jsdelivr.net/pyodide/v0.29.5/full/";
// Pure-Python libraries bundled into the HTML (Phase 3.5, DESIGN §8). Pyodide leaves
// them to micropip and PyPI, which agent code can't reach. build.py reads this block as
// JSON, downloads each wheel, checks its sha256 and inlines it (window.__HERMIT_WHEELS__);
// the unbuilt source fetches them from PyPI instead, checked against the same hashes.
// Per library: `imports` (the first is the one the prompt names) and `uses` (words in a
// step's code that need it without an import: pandas imports openpyxl itself) make the
// harness install it; `requires`: other bundled libraries; `pyodide`: Pyodide packages
// it imports, by lock-file name, loaded with it (some are undeclared or optional extras,
// PHASE3_5_LIBRARY_STUDY.md). Strict JSON between the markers.
// @bundled:start
const BUNDLED_LIBRARIES = {
    "openpyxl": { "imports": ["openpyxl", "et_xmlfile"], "uses": ["read_excel", "to_excel", "ExcelWriter", "ExcelFile"], "requires": [], "pyodide": [], "wheels": [
        { "file": "openpyxl-3.1.5-py2.py3-none-any.whl", "sha256": "5282c12b107bffeef825f4617dc029afaf41d0ea60823bbb665ef3079dc79de2", "url": "https://files.pythonhosted.org/packages/c0/da/977ded879c29cbd04de313843e76868e6e13408a94ed6b987245dc7c8506/openpyxl-3.1.5-py2.py3-none-any.whl" },
        { "file": "et_xmlfile-2.0.0-py3-none-any.whl", "sha256": "7a91720bc756843502c3b7504c77b8fe44217c85c537d85037f0f536151b2caa", "url": "https://files.pythonhosted.org/packages/c1/8b/5fe2cc11fee489817272089c4203e679c63b570a5aaeb18d852ae3cbba6a/et_xmlfile-2.0.0-py3-none-any.whl" }] },
    "XlsxWriter": { "imports": ["xlsxwriter"], "uses": ["xlsxwriter"], "requires": [], "pyodide": [], "wheels": [
        { "file": "xlsxwriter-3.2.9-py3-none-any.whl", "sha256": "9a5db42bc5dff014806c58a20b9eae7322a134abb6fce3c92c181bfb275ec5b3", "url": "https://files.pythonhosted.org/packages/3a/0c/3662f4a66880196a590b202f0db82d919dd2f89e99a27fadef91c4a33d41/xlsxwriter-3.2.9-py3-none-any.whl" }] },
    "python-docx": { "imports": ["docx"], "uses": [], "requires": [], "pyodide": ["lxml", "typing-extensions"], "wheels": [
        { "file": "python_docx-1.2.0-py3-none-any.whl", "sha256": "3fd478f3250fbbbfd3b94fe1e985955737c145627498896a8a6bf81f4baf66c7", "url": "https://files.pythonhosted.org/packages/d0/00/1e03a4989fa5795da308cd774f05b704ace555a70f9bf9d3be057b680bcf/python_docx-1.2.0-py3-none-any.whl" }] },
    "python-pptx": { "imports": ["pptx"], "uses": [], "requires": ["XlsxWriter"], "pyodide": ["lxml", "typing-extensions", "pillow"], "wheels": [
        { "file": "python_pptx-1.0.2-py3-none-any.whl", "sha256": "160838e0b8565a8b1f67947675886e9fea18aa5e795db7ae531606d68e785cba", "url": "https://files.pythonhosted.org/packages/d9/4f/00be2196329ebbff56ce564aa94efb0fbc828d00de250b1980de1a34ab49/python_pptx-1.0.2-py3-none-any.whl" }] },
    "Markdown": { "imports": ["markdown"], "uses": [], "requires": [], "pyodide": [], "wheels": [
        { "file": "markdown-3.11-py3-none-any.whl", "sha256": "cd6c89e7eb308c8b332ed673215a52d208a43f8bacc030b1419376129408719e", "url": "https://files.pythonhosted.org/packages/ec/1e/32971905a7ab47f8b66866ed949fa48b104ba1c4a6fa57794c4f2c4b2cb8/markdown-3.11-py3-none-any.whl" }] },
    "qrcode": { "imports": ["qrcode"], "uses": [], "requires": [], "pyodide": ["pillow"], "wheels": [
        { "file": "qrcode-8.2-py3-none-any.whl", "sha256": "16e64e0716c14960108e85d853062c9e8bba5ca8252c0b4d0231b9df4060ff4f", "url": "https://files.pythonhosted.org/packages/dd/b8/d2d6d731733f51684bbf76bf34dab3b70a9148e8f2cef2bb544fccec681a/qrcode-8.2-py3-none-any.whl" }] },
    "tabulate": { "imports": ["tabulate"], "uses": ["to_markdown"], "requires": [], "pyodide": [], "wheels": [
        { "file": "tabulate-0.10.0-py3-none-any.whl", "sha256": "f0b0622e567335c8fabaaa659f1b33bcb6ddfe2e496071b743aa113f8774f2d3", "url": "https://files.pythonhosted.org/packages/99/55/db07de81b5c630da5cbf5c7df646580ca26dfaefa593667fc6f2fe016d2e/tabulate-0.10.0-py3-none-any.whl" }] },
    "xmltodict": { "imports": ["xmltodict"], "uses": [], "requires": [], "pyodide": [], "wheels": [
        { "file": "xmltodict-1.0.4-py3-none-any.whl", "sha256": "a4a00d300b0e1c59fc2bfccb53d7b2e88c32f200df138a0dd2229f842497026a", "url": "https://files.pythonhosted.org/packages/38/34/98a2f52245f4d47be93b580dae5f9861ef58977d73a79eb47c58f1ad1f3a/xmltodict-1.0.4-py3-none-any.whl" }] },
    "markdownify": { "imports": ["markdownify"], "uses": [], "requires": [], "pyodide": ["beautifulsoup4", "six"], "wheels": [
        { "file": "markdownify-1.2.3-py3-none-any.whl", "sha256": "a189a0bedfd14009030fde5f85bb6f77c56897cb839b5c25315dd7d4e3e290ba", "url": "https://files.pythonhosted.org/packages/04/10/fa543d484e8b1199243fe20eedd02cc5af050edebce98a7293a5773df592/markdownify-1.2.3-py3-none-any.whl" }] },
    "seaborn": { "imports": ["seaborn"], "uses": [], "requires": [], "pyodide": ["numpy", "pandas", "matplotlib"], "wheels": [
        { "file": "seaborn-0.13.2-py3-none-any.whl", "sha256": "636f8336facf092165e27924f223d3c62ca560b1f2bb5dff7ab7fad265361987", "url": "https://files.pythonhosted.org/packages/83/11/00d3c3dfc25ad54e731d91449895a79e4bf2384dc3ac01809010ba88f6d5/seaborn-0.13.2-py3-none-any.whl" }] }
};
// @bundled:end
const SESSION_FORMAT = "hermit-agent-session";
// 2: native tool calls (assistant tool_calls, "tool" messages; Phase 3). 1 still reads.
const SESSION_FORMAT_VERSION = 2;
const LIMITS = { maxFiles: 5000, maxWorkspaceBytes: 256 * 1024 * 1024, maxArchiveEntries: 20000, maxArchiveBytes: 512 * 1024 * 1024, maxPathLength: 512, riskMaxFiles: 20, riskMaxBytes: 10 * 1024 * 1024, bootTimeoutMs: 120000, stepLimitIncrement: 10, readMaxLines: 400, readMaxChars: 32000, readMaxTotalChars: 64000, readMaxLineChars: 2000, compactKeepSteps: 4, compactMinSteps: 2, checkpointBudgetBytes: 512 * 1024 * 1024, checkpointKeepMin: 3, elideKeepSteps: 4, elideMinChars: 2000, retryFirstMs: 2000, retryMaxMs: 30000, retryWindowMs: 120000, streamStallMs: 180000, packageTimeoutMs: 120000, uploadWarnBytes: 50 * 1024 * 1024, uploadWarnFileBytes: 25 * 1024 * 1024, uploadWarnFiles: 500, fileListEvery: 5, stepImagesMax: 8 };
const THROTTLE_MS = 80;

// ========== 2. Helpers copied from HermitUI ==========
// Escape text destined for HTML / attribute contexts.
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// build.py embeds the Pyodide core gzipped + base64-encoded; it is inflated in-browser
// with the native DecompressionStream API.
async function gunzipToBytes(b64) {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

function createThrottle(minInterval) {
    let lastRun = 0;
    let pending = null;
    let lastFn = null;
    function throttled(fn) {
        lastFn = fn;
        const now = Date.now();
        if (now - lastRun >= minInterval) {
            lastRun = now;
            fn();
            if (pending) { clearTimeout(pending); pending = null; }
        } else if (!pending) {
            pending = setTimeout(() => {
                lastRun = Date.now();
                pending = null;
                if (lastFn) lastFn();
            }, minInterval - (now - lastRun));
        }
    }
    // Cancel a scheduled trailing call so it can't fire after the final render.
    throttled.cancel = function() {
        if (pending) { clearTimeout(pending); pending = null; }
        lastFn = null;
    };
    return throttled;
}

// isFinal: while streaming, a half-arrived tag must not flash as literal text, so a
// trailing tag prefix is held back. Once the message is complete there is nothing
// left to arrive, and holding it back would permanently eat a real trailing "<".
function parseThinkSegments(rawText, isFinal = false) {
    let segments = [];
    let currentIdx = 0;
    const openRegex = /<\|?(?:think|thought|reasoning|thought_start)[^>]*>/gi;
    // The "/" is optional because some models emit unslashed closers like
    // <|thought_end|>. Side effect: a literal nested open tag inside a think
    // section also terminates it — acceptable, models don't nest these.
    const closeRegex = /<\/?\|?(?:think|thought|reasoning|thought_end)[^>]*>/gi;

    while (true) {
        openRegex.lastIndex = currentIdx;
        let openMatch = openRegex.exec(rawText);

        if (!openMatch) {
            let textContent = rawText.substring(currentIdx);
            // Closing variants included: a partially-streamed '</think'
            // must not flash as literal text before its '>' arrives.
            const partials = ['<think', '<thought', '<reasoning', '<|thought_start', '<|thought_end',
                              '</think', '</thought', '</reasoning'];
            if (!isFinal) {
                const lowerContent = textContent.toLowerCase();
                for (let p of partials) {
                    let found = false;
                    for (let i = p.length - 1; i >= 1; i--) {
                        if (lowerContent.endsWith(p.substring(0, i))) {
                            textContent = textContent.substring(0, textContent.length - i);
                            found = true;
                            break;
                        }
                    }
                    if (found) break;
                }
            }
            if (textContent.length > 0) {
                segments.push({ type: 'text', content: textContent });
            }
            break;
        }

        let textBefore = rawText.substring(currentIdx, openMatch.index);
        if (textBefore.length > 0) {
            segments.push({ type: 'text', content: textBefore });
        }

        closeRegex.lastIndex = openMatch.index + openMatch[0].length;
        let closeMatch = closeRegex.exec(rawText);

        if (closeMatch) {
            let thinkContent = rawText.substring(openMatch.index + openMatch[0].length, closeMatch.index);
            segments.push({ type: 'think', content: thinkContent, isClosed: true });
            currentIdx = closeMatch.index + closeMatch[0].length;
        } else {
            let thinkContent = rawText.substring(openMatch.index + openMatch[0].length);
            segments.push({ type: 'think', content: thinkContent, isClosed: false });
            break;
        }
    }
    return segments;
}

// Normalize a base URL (or a pasted full chat endpoint) to the given API path.
function apiEndpoint(base, path) {
    let url = base.trim().replace(/\/+$/, "");
    // Tolerate a pasted full endpoint of any known kind, so a base left pointing at
    // /models can't produce ".../models/chat/completions". Longest suffix first.
    for (const known of ["/chat/completions", "/completions", "/models"]) {
        if (url.endsWith(known)) { url = url.slice(0, -known.length); break; }
    }
    if (!url.endsWith(path)) url += path;
    return url;
}

// A base URL typed without a scheme is resolved by fetch() as a path *relative to
// this page*. Supply the scheme the cloud/local warnings already assume — http for
// local hosts, https otherwise.
function normalizeApiUrl(raw) {
    const url = String(raw || "").trim();
    if (!url) throw new Error("Enter an API Base URL first, e.g. http://localhost:8080/v1.");
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(url)) return url;
    // Probed with a scheme attached: bare "localhost:1234" parses as scheme "localhost:".
    return (isLocalEndpoint("http://" + url) ? "http://" : "https://") + url;
}

// Capability endpoints (/props, /api/show) live at the server root, not under
// the OpenAI-compatible /v1 prefix, so strip that too.
function apiRoot(base) {
    let url = (base || "").trim().replace(/\/+$/, "");
    for (const known of ["/chat/completions", "/completions", "/models"]) {
        if (url.endsWith(known)) { url = url.slice(0, -known.length); break; }
    }
    return url.replace(/\/v\d+$/, "");
}

// Domains whose use means data leaves the local machine. Matched as hostname
// suffixes (never substrings, so "box.ai" can't match "x.ai").
const CLOUD_PROVIDERS = ["openai.com", "openrouter.ai", "groq.com", "anthropic.com", "together.xyz", "x.ai", "deepseek.com", "googleapis.com", "cloudflare.com", "mistral.ai", "perplexity.ai", "fireworks.ai", "cohere.com", "openai.azure.com"];
function detectCloudProvider(rawUrl) {
    let host;
    try { host = new URL(rawUrl).hostname; }
    catch {
        try { host = new URL("https://" + rawUrl).hostname; } catch { return null; }
    }
    host = host.toLowerCase();
    return CLOUD_PROVIDERS.find(p => host === p || host.endsWith("." + p)) || null;
}

// Hosts that keep the conversation on the user's own machine or LAN.
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
    // The private-range tests below must only run against a real IPv4 literal —
    // matched as a prefix they would also accept "192.168.1.20.evil.com".
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false;
    if (host === "0.0.0.0") return true;
    if (/^127\./.test(host)) return true;                        // loopback
    if (/^10\./.test(host)) return true;                         // RFC1918
    if (/^192\.168\./.test(host)) return true;                   // RFC1918
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;    // RFC1918
    if (/^169\.254\./.test(host)) return true;                   // link-local
    return false;
}

// null when the endpoint keeps data local, otherwise a label for the destination.
function describeRemoteEndpoint(rawUrl) {
    if (!rawUrl || isLocalEndpoint(rawUrl)) return null;
    const known = detectCloudProvider(rawUrl);
    if (known) return known;
    try { return new URL(rawUrl).host; } catch { /* fall through */ }
    try { return new URL("https://" + rawUrl).host; } catch { /* fall through */ }
    return rawUrl;
}

// Browsers block http:// subresources from an https:// page, with loopback exempted.
function isBlockedMixedContent(rawUrl) {
    if (location.protocol !== "https:") return false;
    if (!/^http:\/\//i.test((rawUrl || "").trim())) return false;
    let host;
    try { host = new URL(rawUrl).hostname.toLowerCase(); } catch { return false; }
    return !(host === "localhost" || host.endsWith(".localhost") || /^127\./.test(host) || host === "[::1]" || host === "::1");
}

// One line of "what to do about it" shown under a failed request; the raw error stays
// visible above it. Pure, so it is unit-tested. "" means the error says enough.
// (HermitUI's wllama branch is dropped: the agent has no in-browser backend yet.)
// Agent failures (opts.retriedMs: how long the request was retried; then the run is
// paused, not ended) say so, and so does an overflow that auto-compaction (opts.autoCompact)
// couldn't fix.
function chatErrorHint(message, opts) {
    const { apiUrl = "", mixedContent = false, retriedMs = 0, autoCompact } = opts || {};
    const msg = String(message || "");
    const status = Number((msg.match(/^Server Error (\d{3})\b/) || [])[1] || 0);
    const retried = retriedMs > 0 ? ` (retried for ${retriedMs >= 60000 ? Math.round(retriedMs / 60000) + " min" : Math.round(retriedMs / 1000) + " s"})` : "";
    const resume = retriedMs > 0 ? " The run is paused and nothing is lost: press Retry once it answers again." : "";
    if (status === 401 || status === 403) return "The server rejected the request's credentials — check the API key in Settings.";
    if (status === 404) return "Nothing answered at that address — check the API Base URL and the model name in Settings.";
    if (status === 429) return `Rate-limited or out of quota${retried} — wait a moment, or check your provider account.` + resume;
    if (status >= 500) return `The server failed while handling the request${retried} — its own logs will say why.` + resume;
    if (!status && /is not valid JSON|JSON\.parse|Unexpected token/i.test(msg)) {
        return "The server answered, but not with JSON — the API Base URL probably points at a web page instead of the API (it usually ends in /v1).";
    }
    if (isContextOverflowError(msg)) {
        if (autoCompact === false) return "The task history no longer fits the model's context — press 🗜️ Compact, turn on Auto-compact in Settings, or rewind to an earlier step.";
        if (autoCompact === true) return "The task history doesn't fit the model's context even after compacting — lower Max tokens / reply in Settings, rewind to an earlier step, or raise the server's context size.";
        return "The task history no longer fits the model's context — rewind to an earlier step, start a new session, or raise the server's context size.";
    }
    // Chrome says "Failed to fetch", Firefox "NetworkError when attempting to fetch
    // resource", Safari "Load failed" — all of them hide the actual reason.
    if (/Failed to fetch|NetworkError|^Load failed$/i.test(msg)) {
        if (mixedContent) return "This page is served over https, so the browser blocks plain-http servers on your network — use localhost, an https endpoint, or open the agent over http.";
        return (isLocalEndpoint(apiUrl)
            ? `Couldn't reach ${apiUrl}${retried} — make sure the server is running and allows CORS from this page.`
            : `Couldn't reach ${apiUrl}${retried} — check the URL and your connection; the provider must also allow requests from a browser (CORS).`) + resume;
    }
    if (retriedMs > 0 && isRetryableError(msg)) return `The connection to ${apiUrl} kept dropping mid-reply${retried}.` + resume;
    return "";
}

// The server refused the prompt as longer than its context (llama.cpp: "exceeds the
// available context size"; OpenAI: "maximum context length").
function isContextOverflowError(message) {
    return /context (?:length|size|window)|n_ctx|too many tokens|maximum context/i.test(String(message || ""));
}

// Does a Jinja chat template actually branch on the reasoning controls? Template
// engines silently ignore variables the template never references, so "not
// mentioned" is proof the kwargs would do nothing.
function parseReasoningTemplateSupport(templateText) {
    const t = typeof templateText === "string" ? templateText : "";
    const enableThinking = /enable_thinking/.test(t);
    const reasoningEffort = /reasoning_effort/.test(t);
    // Templates that validate the value enumerate the accepted set and raise on
    // anything else (Qwen3.5/3.8 reject the OpenAI-standard "high").
    let levels = null;
    const m = t.match(/reasoning_effort[\s\S]{0,240}?not\s+in\s*\(([^)]*)\)/);
    if (m) levels = (m[1].match(/['"]([A-Za-z_]+)['"]/g) || []).map(x => x.replace(/['"]/g, ""));
    if (!levels || !levels.length) levels = /xhigh/.test(t) ? ["low", "medium", "xhigh"] : ["low", "medium", "high"];
    return {
        supported: enableThinking || reasoningEffort,
        enableThinking,
        reasoningEffort,
        levels,
        maxLevel: levels.includes("xhigh") ? "xhigh" : "high",
    };
}

// Map a UI thinking level ("off" | "low" | "medium" | "high") onto request params.
// "high" means "whatever this template calls its maximum". A level the template
// doesn't accept is dropped rather than sent. Returns {} for an unknown level.
function buildReasoningParams(level, opts) {
    const o = opts || {};
    const levels = Array.isArray(o.levels) && o.levels.length ? o.levels : ["low", "medium", "high"];
    if (!["off", "low", "medium", "high"].includes(level)) return {};
    if (level === "off") return { chat_template_kwargs: { enable_thinking: false } };
    const wanted = level === "high" && levels.includes("xhigh") ? "xhigh" : level;
    const effort = levels.includes(wanted) ? wanted : null;
    return effort ? { reasoning_effort: effort } : {};
}

// The param names buildReasoningParams can introduce — stripped from a payload when a
// strict server rejects them.
const REASONING_PARAM_KEYS = ["reasoning_effort", "chat_template_kwargs"];

function looksLikeReasoningRejection(detail) {
    const d = String(detail || "");
    return REASONING_PARAM_KEYS.some(k => d.includes(k)) || /reasoning[ _]effort|enable[ _]thinking/i.test(d);
}

// ========== 3. Agent logic (pure) ==========
// DESIGN §5.3. The user's custom instructions are appended after it. packages: the import
// names Pyodide can load (packageImportNames); without them a few examples are named.
// protocol: "tools" describes the native tools (DESIGN §5.6), else code-as-action (§5.1).
function buildSystemPrompt(instructions, packages, protocol) {
    const pkgs = Array.isArray(packages) && packages.length
        ? `Only these packages (the Pyodide distribution plus a few bundled libraries) can be imported besides the standard library; each is loaded automatically on its first import: ${packages.join(", ")}.`
        : "Packages from the Pyodide distribution (numpy, pandas, matplotlib, scipy, scikit-learn, sympy, ...) are loaded automatically when you import them.";
    // Code-as-action (DESIGN §5.1).
    const textFormat = `
Every reply must be exactly ONE of:
1. Short reasoning, then exactly ONE \`\`\`python code block. It is executed and you get its output back in an <observation> message. Write nothing after the code block. Only \`\`\`python blocks are executed. To show output, data or other non-Python text, use a \`\`\`text block.
2. Short reasoning, then one or more file actions (see below). They are applied in order and you get the results back in an <observation> message. Never put file actions and a \`\`\`python block in the same reply.
3. The final answer for the user, with NO python code block and no file actions, once the task is complete. Mention the files you created.
4. A line starting with "ask:" followed by your question, if you cannot continue without information from the user.

File actions read and change text files in /workspace directly. Prefer them over Python for reading, creating and editing source code, documents and other text files. Use Python to run code, process data and handle binary files. Start each tag on its own line:
<read_file path="notes.txt"/>
  Shows the file with line numbers, at most 400 lines at a time; add start="401" end="800" for more. The line numbers are not part of the file.
<write_file path="docs/report.md">
the complete content of the file
</write_file>
  Creates the file, or replaces all of its content. Folders are created as needed.
<edit_file path="app.py">
<old>
the exact text to replace, copied from the file
</old>
<new>
the replacement text
</new>
</edit_file>
  Replaces text in an existing file. Each <old> must match the file exactly, indentation included, and occur exactly once: add surrounding lines to make it unique. Several <old>/<new> pairs may follow each other inside one edit_file. An empty <new></new> deletes the text.
Paths are relative to /workspace. If any write or edit in a reply fails, none of that reply's changes are applied.

Rules:
- Inspect files before you modify them.
- Print short summaries, not whole files or huge data.
- Don't delete or overwrite the user's files unless the task requires it.
- Take one step at a time: you only see a step's output in the next turn.
- Code blocks are executed, never saved. To create a file, use <write_file> (or write it from your code). A "# reader.py" comment at the top of a block does not create a file.`;
    // Native tool calls (DESIGN §5.6): the tools describe their own arguments.
    const toolsFormat = `
You act only through tool calls, and you get each call's result back in an <observation>:
- run_python: runs Python code. Code you run is not saved: to create a file, use write_file (or write it from your code).
- read_file, write_file, edit_file: read and change text files in /workspace directly. Prefer them over Python for reading, creating and editing source code, documents and other text files. Use Python to run code, process data and handle binary files. read_file shows at most 400 lines at a time: ask for more with start_line. Each old_text of edit_file must match the file exactly, indentation included, and occur exactly once.
- finish: ends the task with your final answer for the user, once the task is complete. Mention the files you created.
- ask_user: asks the user a question, if you cannot continue without information from them.

Each reply is ONE step: one run_python call, OR one or more file tool calls (applied in order; if any write or edit fails, none of that reply's changes are applied), OR finish, OR ask_user. Don't combine run_python with other tools in one reply: only the first action runs. Code or file contents written in your message text are not run.

Rules:
- Inspect files before you modify them.
- Print short summaries, not whole files or huge data.
- Don't delete or overwrite the user's files unless the task requires it.
- Take one step at a time: you only see a step's result in the next turn.`;
    const base = `You are an agent that solves tasks by writing and running Python code. A human supervises you and may approve, edit or reject your steps.

Environment: Pyodide (CPython 3.13 compiled to WebAssembly) running inside the user's browser.
- The working directory is /workspace. Files the user gave you are there. Save deliverables there too: the user sees and downloads the files in /workspace.
- If /workspace has an AGENTS.md file, read it before you start: it holds the project's instructions for agents (conventions, commands, what not to touch). Follow them unless they conflict with the user's task or these rules.
- The standard library is available. ${pkgs} Don't install anything: there is no pip or micropip and no network access, so nothing else can be installed. input() does not work.
- There are no subprocesses: subprocess, os.system and multiprocessing fail. Run tests in-process, e.g. unittest.main(module="test_x", argv=["x"], exit=False).
- Variables persist between your steps until the interpreter is restarted (you will be told when that happens). Modules you write to /workspace are re-imported fresh at every step.
- Use a library for common jobs instead of producing a format by hand: pandas for tables, CSV and JSON; openpyxl or xlsxwriter for Excel .xlsx files (pandas read_excel and to_excel work too); python-docx (import docx) for Word .docx; python-pptx (import pptx) for PowerPoint .pptx, charts included; pymupdf (import pymupdf) to create, read and edit PDFs (page.insert_htmlbox lays out HTML with headings and tables; there is no reportlab or fpdf); matplotlib or seaborn for charts, also as PDF pages; markdown to turn Markdown into HTML, markdownify for HTML into Markdown; tabulate for plain-text tables; qrcode for QR codes; Pillow for images; jinja2 for HTML; beautifulsoup4 or lxml to parse HTML and XML, xmltodict to turn XML into dicts; python-dateutil for dates; pyyaml for YAML; sqlite3 for SQL. Don't assemble these file formats by hand.
- It is a 32-bit platform: numpy's default integer is int32 and overflows silently past 2**31. Use dtype=np.int64 (or plain Python ints) for large values.
- matplotlib draws off-screen. plt.show() saves each open figure as figures/step-N-K.png and shows it to the user; figures still open when a step ends are saved the same way, unless you saved them with savefig. Then they are closed, so call plt.savefig("name.png") before plt.show() when the user wants a file. You can't see images: you are told their size.
- Each step has a time limit. A step that runs too long is killed.
${protocol === "tools" ? toolsFormat : textFormat}`;
    const extra = String(instructions || "").trim();
    return extra ? base + "\n\nAdditional instructions from the user:\n" + extra : base;
}

function formatBytes(n) {
    if (!Number.isFinite(n)) return "?";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1024 / 1024).toFixed(1) + " MB";
}

// files: [{ path, size }] → "a.csv (1.2 KB), b.py (300 B)", at most 50 names.
function formatFileList(files) {
    const list = (files || []).map(f => `${f.path} (${formatBytes(f.size)})`);
    if (!list.length) return "(empty)";
    return list.slice(0, 50).join(", ") + (list.length > 50 ? `, … ${list.length - 50} more` : "");
}

// The first user message: the task plus what is in the workspace right now.
function buildTaskMessage(task, files) {
    return `Task: ${task}\n\nFiles in /workspace: ${formatFileList(files)}`;
}

// Split a model reply into its reasoning (inline think tags) and the visible text.
function splitReply(raw, isFinal) {
    let reasoning = "", text = "";
    for (const seg of parseThinkSegments(String(raw || ""), isFinal)) {
        if (seg.type === "think") reasoning += (reasoning ? "\n\n" : "") + seg.content;
        else text += seg.content;
    }
    return { reasoning, text };
}

// DESIGN §5.1. Only fences tagged python run (a bare fence the model used to show
// output was once executed as code); the first block wins; an unclosed block means
// the stream was cut. Models trained on tool-call formats sometimes write
// <python>…</python> (at the start of a line) instead of a fence: that runs the same way.
// A <tool_call> (or a guessed tool tag such as <run_python>, seen with Qwen3.8 holding a
// shell command), or an <observation> the model wrote itself, runs nothing and gets advice.
// File actions and a python block in one reply are "mixed": nothing runs.
// Returns { kind: code|files|mixed|ask|final|broken|cutoff|empty|toolcall|fakeobs, ... }.
function parseReply(text, finishReason) {
    // File-action tags come out first, so fences inside a file's content aren't code.
    const fa = extractFileActions(text);
    const t = fa.rest;
    if (fa.unclosed) return { kind: finishReason === "length" ? "cutoff" : "broken", prose: t.trim(), unclosed: fa.unclosed };
    const fences = [...t.matchAll(/```(?:python3?|py)[ \t]*\r?\n([\s\S]*?)```/g)];
    const tags = [...t.matchAll(/^[ \t]*<python>[ \t]*(?:\r?\n)?([\s\S]*?)<\/python>/gm)];
    const inTag = (m) => tags.some(g => m.index > g.index && m.index < g.index + g[0].length);
    // A fence inside a <python> tag is the code itself.
    const unfence = (c) => { const m = c.match(/^\s*```(?:python3?|py)?[ \t]*\r?\n([\s\S]*?)```\s*$/); return m ? m[1] : c.endsWith("\n") ? c : c + "\n"; };
    const blocks = [...fences.filter(m => !inTag(m)).map(m => ({ index: m.index, code: m[1] })), ...tags.map(m => ({ index: m.index, code: unfence(m[1]) }))]
        .sort((a, b) => a.index - b.index);
    const openTags = (t.match(/^[ \t]*<python>/gm) || []).length;
    const unclosed = /```(?:python3?|py)[ \t]*$/m.test(t) || openTags > tags.length;
    if (fa.actions.length) {
        if (blocks.length || unclosed) return { kind: "mixed", prose: t.trim(), actionCount: fa.actions.length };
        return { kind: "files", actions: fa.actions, prose: t.trim() };
    }
    if (blocks.length) {
        return { kind: "code", code: blocks[0].code, blockCount: blocks.length, prose: t.slice(0, blocks[0].index).trim() };
    }
    if (unclosed) return { kind: finishReason === "length" ? "cutoff" : "broken", prose: t.trim() };
    if (finishReason === "length") return { kind: "cutoff", prose: t.trim() };
    const tool = t.match(/^[ \t]*<(tool_call|function_call|function=|run_python|execute_python|run_code|execute_code|code_interpreter|bash|shell|terminal)\b/im);
    if (tool) return { kind: "toolcall", prose: t.trim(), tag: tool[1].replace(/=$/, "") };
    // Observations only ever come from the harness: a reply that writes one imitates a
    // result instead of acting (seen with Qwen3.8: "<observation>Now let me run it.").
    if (/^[ \t]*<\/?observation\b/im.test(t)) return { kind: "fakeobs", prose: t.trim() };
    const ask = t.match(/^[ \t]*\**ask:\**[ \t]*([\s\S]+)/im);
    if (ask) return { kind: "ask", question: ask[1].trim(), prose: t.slice(0, ask.index).trim() };
    if (!t.trim()) return { kind: "empty", prose: "" };
    return { kind: "final", answer: t.trim() };
}

// DESIGN §5.2: first 2 KB + last 4 KB of a step's output go to the model.
function truncateOutput(s, head = 2048, tail = 4096) {
    const str = String(s || "");
    if (str.length <= head + tail) return str;
    const omitted = str.length - head - tail;
    const kb = omitted >= 1024 ? Math.round(omitted / 1024) + " KB" : omitted + " characters";
    return str.slice(0, head) + `\n[… ${kb} omitted …]\n` + str.slice(-tail);
}

// before/after: { path: sha256 }. Sorted so the timeline and the model see a stable order.
function diffListings(before, after) {
    const added = [], modified = [], deleted = [];
    for (const p of Object.keys(after)) {
        if (!(p in before)) added.push(p);
        else if (before[p] !== after[p]) modified.push(p);
    }
    for (const p of Object.keys(before)) if (!(p in after)) deleted.push(p);
    return { added: added.sort(), modified: modified.sort(), deleted: deleted.sort() };
}

function formatChanges(changes) {
    const c = changes || {};
    const parts = [
        ...(c.added || []).map(x => "+" + (x.path || x)),
        ...(c.modified || []).map(x => "~" + (x.path || x)),
        ...(c.deleted || []).map(x => "-" + (x.path || x)),
    ];
    return parts.length ? parts.join("  ") : "none";
}

// DESIGN §2.3: gate on what the step *did*, not on what its code looks like.
// diff: { added, modified, deleted } (paths); origins: { path: "user" | "agent" }
// for the workspace *before* the step. Returns { verdict: "auto" | "ask", reasons }.
function classifyEffect(diff, origins, opts) {
    const o = opts || {};
    const maxFiles = o.maxFiles ?? LIMITS.riskMaxFiles;
    const maxBytes = o.maxBytes ?? LIMITS.riskMaxBytes;
    const reasons = [];
    for (const p of diff.deleted || []) if (origins[p] === "user") reasons.push(`deletes your file ${p}`);
    for (const p of diff.modified || []) if (origins[p] === "user") reasons.push(`overwrites your file ${p}`);
    const touched = (diff.added || []).length + (diff.modified || []).length + (diff.deleted || []).length;
    if (touched > maxFiles) reasons.push(`touches ${touched} files (more than ${maxFiles})`);
    if ((o.bytesWritten || 0) > maxBytes) reasons.push(`writes ${formatBytes(o.bytesWritten)} (more than ${formatBytes(maxBytes)})`);
    if ((o.netAttempts || []).length) reasons.push(`tried to use the network (blocked): ${o.netAttempts[0]}${o.netAttempts.length > 1 ? ` and ${o.netAttempts.length - 1} more` : ""}`);
    if (o.overLimit) reasons.push(o.overLimit);
    return { verdict: reasons.length ? "ask" : "auto", reasons };
}

// DESIGN §5.2: the observation envelope sent back as a user-role message.
function buildObservation(o) {
    const lines = [`<observation step="${o.step}" status="${o.status}">`];
    if (o.status === "rejected") lines.push("The user rejected this step." + (o.reason ? " Reason: " + o.reason : ""));
    if (typeof o.output === "string") {
        // File steps cap their own reads; truncating would cut a read in the middle.
        const out = o.truncate === false ? o.output : truncateOutput(o.output);
        lines.push(out.trim() ? out.replace(/\s+$/, "") : "(no output)");
    }
    if (o.changes) lines.push("files changed: " + formatChanges(o.changes));
    for (const n of o.notes || []) lines.push("note: " + n);
    lines.push("</observation>");
    return lines.join("\n");
}

// Append text to the last user message, or add a user message when the last one is
// the assistant's or a tool result. Some chat templates reject two user messages in a
// row. A native tool call still waiting for the user (ask_user, or finish before a
// follow-up) is answered first: ask_user with the text itself, finish with a short
// acknowledgement and the text as a user message (DESIGN §5.6).
function appendToLastUserMessage(messages, text) {
    const last = messages[messages.length - 1];
    if (last && last.role === "user") { last.content += "\n\n" + text; return messages; }
    const pending = last && last.role === "assistant" ? last.tool_calls || [] : [];
    const asks = pending.filter(c => c.function && c.function.name === "ask_user");
    for (const c of pending) {
        const answered = asks.length && c === asks[asks.length - 1];
        messages.push({ role: "tool", tool_call_id: c.id, content: answered ? text : c.function && c.function.name === "finish" ? "Your final answer was shown to the user." : "(not run)" });
    }
    if (!asks.length) messages.push({ role: "user", content: text });
    return messages;
}

// Does the history end where the model is due to answer (a user message or a tool
// result), rather than with the model's own reply?
function awaitsModel(messages) {
    const last = (messages || [])[(messages || []).length - 1];
    return !!last && (last.role === "user" || last.role === "tool");
}

// A deep copy of a history message, tool calls included.
function copyMessage(m) {
    const c = { role: m.role, content: m.content };
    if (Array.isArray(m.tool_calls)) c.tool_calls = m.tool_calls.map(t => ({ id: t.id, type: "function", function: { name: t.function.name, arguments: t.function.arguments } }));
    if (m.tool_call_id !== undefined) c.tool_call_id = m.tool_call_id;
    return c;
}

// ---------- Native tool calls (DESIGN §5.6) ----------
// The tools offered when the endpoint supports OpenAI `tools`. The file tools take the
// argument shapes applyFileActions consumes; run_python, ask_user and finish are the
// code block, the ask: line and the final answer of code-as-action.
const AGENT_TOOL_NAMES = ["run_python", "read_file", "write_file", "edit_file", "ask_user", "finish"];
function agentToolDefs() {
    const fn = (name, description, properties, required) => ({ type: "function", function: { name, description, parameters: { type: "object", properties, required } } });
    const path = { type: "string", description: "Path relative to /workspace, e.g. \"data/report.md\"" };
    return [
        fn("run_python", "Run Python code in the persistent interpreter, with /workspace as the working directory. Variables persist between calls. You get stdout, stderr, errors and the list of changed files back. Print short summaries, not whole files.",
            { code: { type: "string", description: "The Python code to run" } }, ["code"]),
        fn("read_file", "Show a text file from /workspace with line numbers, at most 400 lines per call. The line numbers are not part of the file.",
            { path, start_line: { type: "integer", minimum: 1, description: "First line to show (default 1)" }, end_line: { type: "integer", minimum: 1, description: "Last line to show" } }, ["path"]),
        fn("write_file", "Create a text file in /workspace, or replace all of its content. Folders are created as needed.",
            { path, content: { type: "string", description: "The complete content of the file" } }, ["path", "content"]),
        fn("edit_file", "Replace text in an existing text file. Each old_text must match the file exactly, indentation included, and occur exactly once: include surrounding lines to make it unique. An empty new_text deletes the text.",
            { path, edits: { type: "array", minItems: 1, items: { type: "object", properties: { old_text: { type: "string" }, new_text: { type: "string" } }, required: ["old_text", "new_text"] } } }, ["path", "edits"]),
        fn("ask_user", "Ask the user a question when you cannot continue without their input. The task pauses until they answer.",
            { question: { type: "string" } }, ["question"]),
        fn("finish", "End the task with your final answer for the user, once the task is complete. Mention the files you created.",
            { answer: { type: "string", description: "The final answer, in Markdown" } }, ["answer"]),
    ];
}

// Which protocol the next request uses: "tools" (native tool calls) or "text"
// (code-as-action). setting: "auto" | "native" | "text"; support: what the endpoint
// reports ("supported" | "unsupported" | "unknown"); rejected: it refused a request
// with tools. Auto only goes native on a positive report: a server that silently ignores
// `tools` would leave the model with no way to act.
function resolveProtocol(setting, support, rejected) {
    if (rejected || setting === "text") return "text";
    if (setting === "native") return "tools";
    return support === "supported" ? "tools" : "text";
}

// Tool-call support from llama.cpp's /props: chat_template_caps when present, else
// whether its chat template handles tools at all.
function toolSupportFromProps(p) {
    const caps = p && p.chat_template_caps;
    if (caps && typeof caps.supports_tool_calls === "boolean") return caps.supports_tool_calls && caps.supports_tools !== false ? "supported" : "unsupported";
    // \x7b is an opening curly brace, spelled out so tests/extract.mjs's brace matching holds.
    if (p && typeof p.chat_template === "string") return /\x7b%-?[^%]*\btools\b/.test(p.chat_template) ? "supported" : "unsupported";
    return "unknown";
}

// From Ollama's /api/show: its capabilities list, else its Go template ({{ .Tools }}).
function toolSupportFromOllamaShow(show) {
    if (show && Array.isArray(show.capabilities)) return show.capabilities.includes("tools") ? "supported" : "unsupported";
    if (show && typeof show.template === "string") return /\.Tools\b/.test(show.template) ? "supported" : "unsupported";
    return "unknown";
}

// The entry for `model` in an OpenAI-style model list; a list of one counts as that model.
function findListedModel(data, model) {
    const list = Array.isArray(data) ? data : (data && (data.data || data.models)) || [];
    if (!Array.isArray(list) || !list.length) return null;
    const want = String(model || "");
    const m = list.find(x => x && want && (x.id === want || x.name === want || x.model === want)) || (list.length === 1 ? list[0] : null);
    return m && typeof m === "object" ? m : null;
}

// From a model list's supported_parameters (OpenRouter and others).
function toolSupportFromModelList(data, model) {
    const m = findListedModel(data, model);
    if (!m || !Array.isArray(m.supported_parameters)) return "unknown";
    return m.supported_parameters.includes("tools") ? "supported" : "unsupported";
}

// Did the server refuse the request because of `tools`? llama.cpp without --jinja, vLLM
// without --enable-auto-tool-choice, Ollama models without tool support and OpenRouter
// routes without one all answer like this; a template that can't render the tool
// messages fails with a 500 that names them.
function looksLikeToolRejection(status, detail) {
    if (![400, 404, 422, 500, 501].includes(status)) return false;
    return /\btools?\b|tool[ _-]?(?:choice|calls?|use|parser)|function[ _-]?call/i.test(String(detail || ""));
}

// Ids for calls the server sent without one (or twice): 9 alphanumerics, the format the
// strictest APIs (Mistral) accept, unique within a session (step, call index).
function fallbackToolCallId(step, i) {
    return "h" + String(step % 100000).padStart(5, "0") + String(i % 1000).padStart(3, "0");
}

// A tool call's arguments → a file action in the shape extractFileActions produces, so
// applyFileActions treats both protocols alike. Errors name the tool's own fields.
function toolCallToFileAction(name, args) {
    const a = args || {};
    const action = { tool: name, args: { path: typeof a.path === "string" ? a.path : "" } };
    const path = normalizeActionPath(a.path);
    if (typeof a.path !== "string" || !a.path.trim()) action.error = `${name} needs a path, e.g. {"path": "notes.txt"}.`;
    else if (!path) action.error = `Unsafe path ${JSON.stringify(a.path.slice(0, 100))}: use a relative path inside /workspace.`;
    else action.args.path = path;
    if (name === "read_file") {
        for (const key of ["start_line", "end_line"]) {
            if (a[key] === undefined || a[key] === null) continue;
            const n = Number(a[key]);
            if (Number.isInteger(n) && n >= 1) action.args[key] = n;
            else action.error = action.error || `${key} ${JSON.stringify(a[key])} is not a line number (lines start at 1).`;
        }
    } else if (name === "write_file") {
        if (typeof a.content !== "string") action.error = action.error || "write_file needs content: the complete text of the file.";
        action.args.content = typeof a.content === "string" ? a.content : "";
    } else {
        const edits = Array.isArray(a.edits) ? a.edits : [];
        action.args.edits = edits.filter(e => e && typeof e === "object").map(e => ({ old_text: typeof e.old_text === "string" ? e.old_text : "", new_text: typeof e.new_text === "string" ? e.new_text : "" }));
        if (!action.args.edits.length) action.error = action.error || "edit_file needs edits: a list of {\"old_text\": …, \"new_text\": …}.";
        else if (edits.some(e => !e || typeof e.old_text !== "string" || typeof e.new_text !== "string")) action.error = action.error || "Every edit needs old_text and new_text, both strings.";
    }
    return action;
}

// DESIGN §5.6: what one native reply does. calls: [{ id, name, arguments }] as streamed
// (arguments a JSON string, or an object from servers that send one). The first action
// call decides: a run_python runs alone; a file tool runs together with the file calls
// right after it, as one batch. finish and ask_user count only without action calls.
// Every call that doesn't run gets a reason. A reply without calls is read like a
// code-as-action reply, except that a fence or a file tag in it runs nothing: plain text
// is the final answer. Returns { kind, prose, code?, actions? (with .id), answer?,
// question?, stored: the calls to keep in the history, [{ id, name, arguments }], skipped:
// [[id, reason]], notes: for the step's observation }.
function parseToolCalls(calls, text, finishReason, step) {
    const prose = String(text || "").trim();
    const out = { prose, stored: [], skipped: [], notes: [] };
    const seen = new Set();
    const list = (calls || []).map((c, i) => {
        let id = typeof c.id === "string" && c.id && !seen.has(c.id) ? c.id : fallbackToolCallId(step || 0, i);
        while (seen.has(id)) id = fallbackToolCallId(step || 0, i + 500);
        seen.add(id);
        const name = String(c.name || "");
        let args = null, json = "";
        if (c.arguments && typeof c.arguments === "object" && !Array.isArray(c.arguments)) { args = c.arguments; json = JSON.stringify(args); }
        else {
            const raw = String(c.arguments ?? "").trim();
            try { args = raw === "" ? {} : JSON.parse(raw); json = raw === "" ? "{}" : raw; } catch (e) { args = null; }
            if (!args || typeof args !== "object" || Array.isArray(args)) args = null;
        }
        return { id, name, args, json };
    });
    // A call whose arguments aren't a JSON object can't go back into the history (servers
    // re-parse them when they render the prompt), so it is dropped there and only named.
    const bad = list.filter(c => !c.args);
    const ok = list.filter(c => c.args);
    if (finishReason === "length" && (bad.length || !list.length)) {
        out.kind = "cutoff";
        out.stored = ok.map(c => ({ id: c.id, name: c.name, arguments: c.json }));
        for (const c of ok) out.skipped.push([c.id, "Not run: the reply was cut off before it finished."]);
        return out;
    }
    for (const c of bad) out.notes.push(`Your ${c.name || "unnamed"} call was ignored: its arguments were not a valid JSON object.`);
    if (!list.length) {
        const p = parseReply(text, finishReason);
        if (["code", "files", "mixed", "broken", "toolcall"].includes(p.kind)) return { ...out, kind: "textaction", tag: p.kind === "toolcall" ? p.tag : "", what: p.kind === "files" ? "files" : p.kind === "toolcall" ? "toolcall" : "code" };
        return { ...p, prose: p.prose !== undefined ? p.prose : prose, stored: [], skipped: [], notes: [] };
    }
    const isAction = (c) => c.name === "run_python" || FILE_TOOLS.includes(c.name);
    const known = (c) => AGENT_TOOL_NAMES.includes(c.name);
    const unknownReason = (c) => `There is no tool ${JSON.stringify(c.name)}. The tools are ${AGENT_TOOL_NAMES.join(", ")}` + (/bash|shell|terminal|exec|command/i.test(c.name) ? " (no shell: run Python, e.g. runpy.run_path(\"script.py\"))." : ".");
    const first = ok.findIndex(c => known(c) && isAction(c));
    if (first < 0) {
        const end = ok.find(c => c.name === "finish" || c.name === "ask_user");
        const field = end && (end.name === "finish" ? "answer" : "question");
        const value = end && typeof end.args[field] === "string" ? end.args[field].trim() : "";
        if (end && (value || (end.name === "finish" && prose))) {
            // Ending the run: only the call that ends it stays in the history, answered when
            // the user replies (appendToLastUserMessage).
            out.stored = [{ id: end.id, name: end.name, arguments: end.json }];
            if (end.name === "finish") return { ...out, kind: "final", answer: value };
            return { ...out, kind: "ask", question: value };
        }
        out.kind = "badcall";
        out.stored = ok.map(c => ({ id: c.id, name: c.name, arguments: c.json }));
        for (const c of ok) {
            out.skipped.push([c.id, !known(c) ? unknownReason(c)
                : `${c.name} needs ${c.name === "finish" ? "an answer" : "a question"}: {"${c.name === "finish" ? "answer" : "question"}": "…"}.`]);
        }
        if (!ok.length) out.notes.push("Nothing ran. Call a tool with valid JSON arguments, or finish with your final answer.");
        return out;
    }
    out.stored = ok.map(c => ({ id: c.id, name: c.name, arguments: c.json }));
    const lead = ok[first];
    if (lead.name === "run_python" && !(typeof lead.args.code === "string" && lead.args.code.trim())) {
        for (const c of ok) out.skipped.push([c.id, c === lead ? "Not run: run_python needs code: {\"code\": \"print(1)\"}." : "Not run: the run_python call before it had no code, so nothing in this reply ran."]);
        return { ...out, kind: "badcall" };
    }
    let ran = [lead];
    if (lead.name !== "run_python") {
        for (let i = first + 1; i < ok.length && FILE_TOOLS.includes(ok[i].name); i++) ran.push(ok[i]);
    }
    const ranIds = new Set(ran.map(c => c.id));
    for (const c of ok) {
        if (ranIds.has(c.id)) continue;
        let why;
        if (!known(c)) why = unknownReason(c);
        else if (c.name === "finish" || c.name === "ask_user") why = `Not processed: ${c.name} only counts in a reply without other tool calls. Call it again on its own once you have seen these results.`;
        else if (c.name === "run_python" && lead.name === "run_python") why = "Not run: only the first run_python call of a reply runs. Send this one again if you still need it.";
        else if (c.name === "run_python") why = "Not run: run_python doesn't run in the same reply as file tools. Call it again now that the file tools have run.";
        else if (lead.name === "run_python") why = `Not run: ${c.name} doesn't run in the same reply as run_python. Call it again now that the code has run.`;
        else why = `Not run: only the file tools at the start of a reply run together, and a call to another tool came first. Call ${c.name} again now.`;
        out.skipped.push([c.id, why]);
    }
    if (lead.name === "run_python") {
        const code = lead.args.code;
        return { ...out, kind: "code", code: code.endsWith("\n") ? code : code + "\n", blockCount: 1, runId: lead.id };
    }
    return { ...out, kind: "files", actions: ran.map(c => ({ ...toolCallToFileAction(c.name, c.args), id: c.id })) };
}

// A native tool call written out the code-as-action way: a ```python block, file-action
// tags, the answer or an ask: line. For text-mode requests and the summariser.
function toolCallAsText(call) {
    const f = call && call.function || {};
    let a = {};
    try { a = JSON.parse(f.arguments || "{}") || {}; } catch (e) { a = {}; }
    const s = (v) => (typeof v === "string" ? v : "");
    const attr = (v) => JSON.stringify(s(v)).replace(/\\"/g, "&quot;");
    switch (f.name) {
        case "run_python": { const code = s(a.code); return "```python\n" + code + (code.endsWith("\n") ? "" : "\n") + "```"; }
        case "read_file": return `<read_file path=${attr(a.path)}${a.start_line ? ` start="${a.start_line}"` : ""}${a.end_line ? ` end="${a.end_line}"` : ""}/>`;
        case "write_file": return `<write_file path=${attr(a.path)}>\n${s(a.content)}</write_file>`;
        case "edit_file": return `<edit_file path=${attr(a.path)}>\n` + (Array.isArray(a.edits) ? a.edits : []).map(e => `<old>\n${s(e && e.old_text)}\n</old>\n<new>\n${s(e && e.new_text)}\n</new>`).join("\n") + "\n</edit_file>";
        case "finish": return s(a.answer);
        case "ask_user": return "ask: " + s(a.question);
        default: return `[call to ${String(f.name || "?")}: ${String(f.arguments || "").slice(0, 2000)}]`;
    }
}

// A message's text with its tool calls written out (toolCallAsText).
function messageAsText(m) {
    const calls = Array.isArray(m.tool_calls) ? m.tool_calls.map(toolCallAsText).filter(Boolean) : [];
    return [String(m.content || "").trim(), ...calls].filter(Boolean).join("\n\n");
}

// The history in code-as-action form, for a text-mode request after native steps (a
// fallback, or the setting changed): calls become blocks and tags, and tool results
// merge with the user message after them into one user message.
function toolHistoryAsText(messages) {
    const out = [];
    for (const m of messages || []) {
        if (m.role === "assistant") { out.push({ role: "assistant", content: messageAsText(m) }); continue; }
        if (m.role === "system") { out.push({ role: "system", content: m.content }); continue; }
        const prev = out[out.length - 1];
        if (prev && prev.role === "user") prev.content += "\n\n" + m.content;
        else out.push({ role: "user", content: m.content });
    }
    return out;
}

// What the model gets back per call of a native file step: each read, write or edit its
// own result, the step's file changes and notes with the last one.
function fileCallResults(results, failed) {
    const failedAt = failed ? results.findIndex(r => !r.ok && r.tool !== "read_file") : -1;
    const native = (s) => String(s).replace(/<old>/g, "old_text").replace(/<new>/g, "new_text").replace(/<write_file>/g, "write_file");
    return results.map((r, i) => {
        let head = `${r.tool} ${r.path || "?"}: ${r.ok ? r.message : "ERROR: " + native(r.message)}`;
        if (failed && r.ok && r.tool !== "read_file") head = `${r.tool} ${r.path}: not applied, because the ${results[failedAt].tool} call for ${results[failedAt].path || "?"} failed: no file changes of this reply were written. Fix it and send all of the changes again.`;
        else if (failed && i === failedAt) head += "\nNo file changes of this reply were applied. Fix this and send all of the changes again.";
        return r.output !== undefined && r.ok ? head + "\n" + r.output : head;
    });
}

// What a reply that ran nothing is told, per kind (parseReply, parseToolCalls).
// native: the session acts through tool calls; ctxCut: the context, not max_tokens, cut it.
function noActionAdvice(parsed, native, ctxCut) {
    const act = native ? "Make ONE tool call (run_python, or file tools), or call finish with the final answer." : "Reply with ONE ```python block, file actions, or the final answer.";
    switch (parsed.kind) {
        case "cutoff": return ctxCut
            ? `Your reply was cut off because the context window filled up before it finished, so nothing ran. ${act}`
            : `Your reply was cut off at the token limit before it finished, so nothing ran. Reason less and ${act.charAt(0).toLowerCase() + act.slice(1)}`;
        case "empty": return native ? "Your reply had no tool call and no answer, so nothing ran. Call a tool, finish with the final answer, or ask_user." : "Your reply had no code block, no file actions and no answer, so nothing ran. Reply with ONE ```python block, file actions, the final answer, or an ask: line.";
        case "broken": return parsed.unclosed
            ? `Your reply had a <${parsed.unclosed}> tag without its closing </${parsed.unclosed}>, so nothing ran. Send the action again, closed.`
            : "Your reply had an unclosed ```python block, so nothing ran. Reply with ONE complete ```python block.";
        case "mixed": return "Your reply had both file actions and a ```python block, so nothing ran. Send file actions and code in separate replies: first the file actions, then the code once you have their results.";
        case "toolcall": return `Your reply had a <${parsed.tag || "tool_call"}> tag, but there are no tool calls here, so nothing ran. To run code, reply with ONE \`\`\`python block of Python (no shell commands: to run a script, use runpy.run_path("script.py")); to read or change files, use the file-action tags (<read_file>, <write_file>, <edit_file>).`;
        case "fakeobs": return native
            ? "Your reply contained an <observation> tag, but observations only come back after a tool call ran, so nothing ran. Call a tool."
            : "Your reply contained an <observation> tag, but observations only come back from the harness after your action ran, so nothing ran. Reply with ONE ```python block, file actions, or the final answer.";
        case "textaction": return parsed.what === "toolcall"
            ? `Your reply contained a tool call written as text (<${parsed.tag || "tool_call"}>) that wasn't received as a tool call, so nothing ran. Make the call again through the tools interface.`
            : `Your reply had ${parsed.what === "files" ? "file-action tags" : "a ```python block"} in its text, but here code and file changes only run as tool calls, so nothing ran. Call ${parsed.what === "files" ? "read_file, write_file or edit_file" : "run_python"} instead, or call finish if that was your final answer.`;
        case "badcall": return "None of your tool calls could run; each one's result says why.";
        default: return "Nothing ran.";
    }
}

// ---------- Context compaction (DESIGN §5.4) ----------
function messageChars(messages) {
    let n = 0;
    for (const m of messages || []) {
        n += String(m.content || "").length;
        for (const c of m.tool_calls || []) n += String(c.function && c.function.name || "").length + String(c.function && c.function.arguments || "").length;
    }
    return n;
}

// A prompt-size estimate: characters times the tokens per character measured on the
// previous request (its prompt_tokens over the characters it sent); 1/3.5 until then.
function estimateTokens(messages, ratio) {
    return Math.ceil(messageChars(messages) * (Number.isFinite(ratio) && ratio > 0 ? ratio : 1 / 3.5));
}

// The context size to compact against: the setting when set, else the server's n_ctx,
// else 0 (unknown: only a context-overflow error triggers a compaction).
function contextLimit(setting, serverCtx) {
    if (Number.isFinite(setting) && setting > 0) return setting;
    return Number.isFinite(serverCtx) && serverCtx > 0 ? serverCtx : 0;
}

// Is the history at pct % of the context or beyond, or too close to its end for a full
// reply? reserve: the reply budget (max_tokens; 0 = none), capped at half the context so
// a large one can't make every step compact. pct 0 turns auto-compaction off.
function compactionDue(estTokens, limit, pct, reserve) {
    if (!(pct > 0 && limit > 0)) return false;
    const room = Math.min(Number.isFinite(reserve) && reserve > 0 ? reserve : 0, limit / 2);
    return estTokens >= Math.min(limit * pct / 100, limit - room);
}

// Did the context window end the reply rather than max_tokens? llama.cpp (context shift
// off, its default) stops a reply at n_ctx and reports finish_reason "length", the same
// as for max_tokens. usage: { prompt, completion }; serverCtx: the server's n_ctx, 0 when
// unknown (then a "length" reply under max_tokens counts).
function cutByContext(finishReason, usage, maxTokens, serverCtx) {
    const u = usage || {};
    if (finishReason !== "length" || !(u.completion > 0)) return false;
    if (serverCtx > 0 && u.prompt > 0) return u.prompt + u.completion >= serverCtx - 16;
    return maxTokens > 0 && u.completion < maxTokens;
}

// Where to cut the history. messages[0] is the system prompt, messages[1] the task, and
// after that assistant and user turns alternate, one assistant message per step. The
// last keepSteps steps stay verbatim, so the kept tail starts at an assistant message
// and the roles still alternate once the summary is merged into the task message.
// Returns { cut, steps }: messages[2..cut) hold `steps` steps to summarise. null when
// fewer than minSteps would be summarised.
function planCompaction(messages, keepSteps, minSteps) {
    const at = [];
    for (let i = 2; i < messages.length; i++) if (messages[i].role === "assistant") at.push(i);
    const steps = at.length - Math.max(1, keepSteps);
    if (steps < Math.max(1, minSteps)) return null;
    return { cut: at[steps], steps };
}

// The task message without the summary an earlier compaction added to it.
function taskMessageBase(content) {
    const s = String(content || "");
    const i = s.indexOf("\n\n<history_summary ");
    return i < 0 ? s : s.slice(0, i);
}

// The summariser's request: the task message (with any earlier summary) and the steps
// up to cut, each clipped so the request itself fits where the agent's no longer does.
function buildCompactionRequest(messages, cut) {
    const system = `You compress the history of an AI agent's session so the agent can continue its task with less context. The agent solves tasks by writing Python and file actions that run in /workspace. You get its earlier turns (AGENT) and what came back (RESULT: <observation> envelopes, plus notes, answers and follow-ups from the user).

Write a summary the agent can continue from, under these headings, in this order, in at most 400 words:
## Task
The task and every follow-up, answer or instruction from the user. Keep their wording where it matters.
## Done so far
What was done and what it found, briefly. Keep the exact values the task needs: numbers, names, columns, paths.
## Files
Files in /workspace that were created or changed, and what each holds.
## Interpreter state
Variables, functions and imports later steps rely on. Say if the interpreter was restarted.
## Errors and dead ends
What failed and why, so it isn't repeated.
## Next
What the agent was about to do.

If the history starts with an earlier summary, fold it in. Write only the summary: no preamble, no code to run, no file actions.`;
    const parts = ["HISTORY:", taskMessageBase(messages[1].content)];
    const prev = String(messages[1].content).slice(taskMessageBase(messages[1].content).length).trim();
    if (prev) parts.push("EARLIER SUMMARY:\n" + prev);
    for (let i = 2; i < cut; i++) {
        const m = messages[i];
        parts.push(`--- ${m.role === "assistant" ? "AGENT" : "RESULT"} ---\n` + truncateOutput(m.role === "assistant" ? messageAsText(m) : m.content, 1500, 1500));
    }
    return [
        { role: "system", content: system },
        { role: "user", content: parts.join("\n\n") + "\n\nWrite the summary now." },
    ];
}

// The compacted history: system prompt, task message plus the summary of steps
// 1..toStep and the current file list, then the kept tail.
function buildCompactedMessages(messages, cut, summary, toStep, files) {
    const block = `<history_summary steps="1-${toStep}">\nSteps 1–${toStep} were summarised to save context. The interpreter and /workspace are unaffected.\n\n${String(summary).trim()}\n</history_summary>\n\nFiles in /workspace now: ${formatFileList(files)}`;
    return [
        { role: messages[0].role, content: messages[0].content },
        { role: "user", content: taskMessageBase(messages[1].content) + "\n\n" + block },
        ...messages.slice(cut).map(copyMessage),
    ];
}

// A relative workspace path that can't escape /workspace or confuse a zip tool.
function isSafeRelPath(p) {
    if (typeof p !== "string" || !p || p.length > LIMITS.maxPathLength) return false;
    if (/[\0\\]/.test(p) || p.startsWith("/") || /^[a-zA-Z]:/.test(p)) return false;
    return p.split("/").every(seg => seg !== "" && seg !== "." && seg !== "..");
}

// Normalise a path from an upload (webkitRelativePath, drag-drop entry) or null.
function normalizeUploadPath(raw) {
    const p = String(raw || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
    return isSafeRelPath(p) ? p : null;
}

// A Markdown fence longer than any backtick run inside the content.
function makeFence(content) {
    const runs = String(content || "").match(/`{3,}/g) || [];
    return "`".repeat(Math.max(3, ...runs.map(r => r.length + 1)));
}

// File names a model is likely to mean as deliverables. Deliberately a fixed list: a
// generic "name.ext" pattern would also match module paths like `os.path`.
const FILE_EXTENSIONS = ["py", "csv", "tsv", "txt", "md", "json", "jsonl", "yaml", "yml", "toml", "ini", "cfg", "xml", "html", "css", "js", "ts", "java", "c", "h", "cpp", "rs", "go", "sql", "sh", "log", "png", "jpg", "jpeg", "gif", "svg", "pdf", "xlsx", "parquet", "pkl", "ipynb", "zip"];

// A code step that starts with a "# reader.py" comment, as if that saved it — but no
// such file exists after the run. Models carry this habit over from chat UIs.
// native: the session acts through tool calls, so the advice names write_file.
function filenameCommentHint(code, paths, native) {
    const first = String(code || "").split("\n").find(l => l.trim()) || "";
    const m = first.match(/^\s*#\s*(?:file(?:name)?\s*:\s*)?(\S+\.([A-Za-z0-9]+))\s*$/i);
    if (!m || !FILE_EXTENSIONS.includes(m[2].toLowerCase())) return "";
    const name = m[1].replace(/^\/?workspace\//, "");
    const have = new Set(paths || []);
    if (have.has(name) || [...have].some(p => p.split("/").pop() === name)) return "";
    return `Your code starts with "# ${m[1]}", but running ${native ? "code" : "a code block"} doesn't save it: there is no ${name} in /workspace. If you meant to create that file, use ${native ? `write_file with path "${name}"` : `<write_file path="${name}">`}.`;
}

// Files a final answer presents (in backticks or bold) that aren't in the workspace.
function missingMentionedFiles(answer, paths) {
    const have = new Set(paths || []);
    const base = new Set([...have].map(p => p.split("/").pop()));
    const out = [];
    for (const m of String(answer || "").matchAll(/(?:`([^`\s]+)`|\*\*([^*\s]+)\*\*)/g)) {
        // "**`name.py`**" matches as bold with the backticks still inside.
        const raw = (m[1] || m[2]).replace(/`/g, "").replace(/^\/?workspace\//, "").replace(/[.,:;)]+$/, "");
        const ext = (raw.match(/\.([A-Za-z0-9]+)$/) || [])[1];
        if (!ext || !FILE_EXTENSIONS.includes(ext.toLowerCase()) || /[()=<>]/.test(raw)) continue;
        if (have.has(raw) || base.has(raw) || out.includes(raw)) continue;
        out.push(raw);
    }
    return out;
}

// File actions (DESIGN §5.1): read, write and edit text files without Python. The tag
// names are also the tool names a native tool-call parser will feed into
// applyFileActions (DESIGN §5.6), which knows nothing about the wire format.
const FILE_TOOLS = ["read_file", "write_file", "edit_file"];

// A path as models write it ("/workspace/x", "./x") made relative, or null if unsafe.
function normalizeActionPath(raw) {
    const p = String(raw || "").trim().replace(/^\/?workspace\//, "").replace(/^(?:\.\/)+/, "");
    return isSafeRelPath(p) ? p : null;
}

function parseTagAttrs(s) {
    const out = {};
    for (const m of String(s || "").matchAll(/([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>/]+))/g)) {
        out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4];
    }
    return out;
}

// Tags count only at the start of a line. Content runs to the first closing tag, so a
// file can hold ``` fences but not its own closing tag. One newline after an opening
// tag is dropped; a write keeps its trailing newline, <old>/<new> drop one at each end.
// Returns { actions: [{ tool, args, error? }], rest (the reply without the tags),
// unclosed (the tool name of a tag that never closed, or "") }.
function extractFileActions(text) {
    const t = String(text || "");
    const open = /^[ \t]*<(read_file|write_file|edit_file)\b([^>\n]*?)(\/?)>/gm;
    const lead = (s) => s.replace(/^\r?\n/, "");
    const snippet = (s) => lead(s).replace(/\r?\n$/, "");
    const actions = [];
    let rest = "", pos = 0, unclosed = "", m;
    while ((m = open.exec(t))) {
        const tool = m[1], attrs = parseTagAttrs(m[2]), selfClosing = m[3] === "/";
        rest += t.slice(pos, m.index);
        let end = m.index + m[0].length, body = "";
        if (tool === "read_file") {
            const close = !selfClosing && t.slice(end).match(/^\s*<\/read_file>/);
            if (close) end += close[0].length;
        } else if (!selfClosing) {
            const ci = t.indexOf(`</${tool}>`, end);
            if (ci < 0) { unclosed = tool; pos = t.length; break; }
            body = t.slice(end, ci);
            end = ci + tool.length + 3;
        }
        pos = open.lastIndex = end;
        const action = { tool, args: { path: attrs.path === undefined ? "" : attrs.path } };
        const path = normalizeActionPath(attrs.path);
        if (attrs.path === undefined || !String(attrs.path).trim()) action.error = `<${tool}> needs a path attribute, e.g. <${tool} path="notes.txt">.`;
        else if (!path) action.error = `Unsafe path ${JSON.stringify(String(attrs.path).slice(0, 100))}: use a relative path inside /workspace.`;
        else action.args.path = path;
        if (selfClosing && tool !== "read_file") action.error = action.error || `<${tool} … /> has no content: put it between <${tool} path="…"> and </${tool}>.`;
        if (tool === "read_file") {
            for (const [attr, key] of [["start", "start_line"], ["end", "end_line"]]) {
                if (attrs[attr] === undefined) continue;
                const n = Number(attrs[attr]);
                if (Number.isInteger(n) && n >= 1) action.args[key] = n;
                else action.error = action.error || `${attr}="${attrs[attr]}" is not a line number (lines start at 1).`;
            }
        } else if (tool === "write_file") {
            action.args.content = lead(body);
        } else {
            const edits = [...body.matchAll(/<old>([\s\S]*?)<\/old>\s*<new>([\s\S]*?)<\/new>/g)].map(e => ({ old_text: snippet(e[1]), new_text: snippet(e[2]) }));
            action.args.edits = edits;
            if (!edits.length) action.error = action.error || "<edit_file> needs at least one <old>…</old> <new>…</new> pair.";
        }
        actions.push(action);
    }
    rest += t.slice(pos);
    return { actions, rest, unclosed };
}

// Text content of a file, or null for binary (NUL bytes or invalid UTF-8).
function decodeTextFile(bytes) {
    if (!bytes || bytes.includes(0)) return null;
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch (e) { return null; }
}

function countOccurrences(hay, needle) {
    let n = 0;
    for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
    return n;
}

// Run file actions against the workspace without touching it. ws: { paths: [...],
// read(path) -> Uint8Array | null }. Actions run in order on an overlay, so a read sees
// an earlier write. Writes and edits are all-or-nothing: the first one that fails stops
// the batch and nothing is written. Returns { results: [{ tool, path, ok, message,
// output?, startLine?, endLine?, edits? }], writes: Map(path -> text), failed }.
function applyFileActions(actions, ws, opts) {
    const lim = { ...LIMITS, ...(opts || {}) };
    const overlay = new Map();
    const paths = new Set(ws.paths || []);
    const results = [];
    let budget = lim.readMaxTotalChars, failed = false;
    const current = (p) => {
        if (overlay.has(p)) return { text: overlay.get(p) };
        const bytes = paths.has(p) ? ws.read(p) : null;
        if (!bytes) return null;
        const text = decodeTextFile(bytes);
        return text === null ? { binary: bytes } : { text };
    };
    const lineCount = (s) => (s === "" ? 0 : s.split("\n").length - (s.endsWith("\n") ? 1 : 0));
    for (const a of actions || []) {
        const path = a.args && a.args.path || "";
        const r = { tool: a.tool, path, ok: false, message: "" };
        results.push(r);
        if (failed) { r.message = "not run: an earlier action failed"; continue; }
        if (a.tool === "edit_file") r.edits = ((a.args && a.args.edits) || []).map(e => ({ old: e.old_text, new: e.new_text }));
        const fail = (msg) => { r.message = msg; if (a.tool !== "read_file") failed = true; };
        if (a.error || !FILE_TOOLS.includes(a.tool)) { fail(a.error || `Unknown file action ${a.tool}.`); continue; }
        const cur = current(path);
        if (a.tool === "read_file") {
            if (!cur) { fail(`There is no file ${path} in /workspace.`); continue; }
            if (cur.binary !== undefined) { fail(`${path} is a binary file (${binarySummary(cur.binary)}); inspect it with python.`); continue; }
            if (budget <= 0) { fail("Not read: this reply's read budget is used up. Read it in your next reply."); continue; }
            const lines = cur.text.split(/\r?\n/);
            if (cur.text.endsWith("\n")) lines.pop();
            const total = cur.text === "" ? 0 : lines.length;
            const start = a.args.start_line || 1;
            if (total === 0) { r.ok = true; r.message = "empty file"; r.output = "(empty file)"; continue; }
            if (start > total) { fail(`${path} has only ${total} line${total === 1 ? "" : "s"}.`); continue; }
            const maxEnd = Math.min(total, start + lim.readMaxLines - 1);
            const want = Math.min(total, a.args.end_line ? Math.max(start, a.args.end_line) : maxEnd);
            const end = Math.min(want, maxEnd);
            const width = String(end).length;
            const cap = Math.min(lim.readMaxChars, budget);
            const out = [];
            let used = 0, last = start - 1;
            for (let i = start; i <= end; i++) {
                let line = lines[i - 1];
                if (line.length > lim.readMaxLineChars) line = line.slice(0, lim.readMaxLineChars) + ` […${line.length - lim.readMaxLineChars} more characters]`;
                const row = String(i).padStart(width) + "\t" + line;
                if (used + row.length + 1 > cap && out.length) break;
                out.push(row);
                used += row.length + 1;
                last = i;
            }
            budget -= used;
            r.ok = true;
            r.startLine = start;
            r.endLine = last;
            r.message = `lines ${start}–${last} of ${total}`;
            r.output = out.join("\n") + (last < want || (!a.args.end_line && last < total) ? `\n[… ${total} lines in total; continue with start="${last + 1}" …]` : "");
            continue;
        }
        if (a.tool === "write_file") {
            const content = String(a.args.content ?? "");
            const exists = (p) => paths.has(p) || overlay.has(p);
            if ([...paths, ...overlay.keys()].some(p => p.startsWith(path + "/"))) { fail(`${path} is a folder.`); continue; }
            const segs = path.split("/");
            const parent = segs.slice(1).map((_, i) => segs.slice(0, i + 1).join("/")).find(exists);
            if (parent) { fail(`${parent} is a file, so it can't contain ${path}.`); continue; }
            r.ok = true;
            if (cur && cur.text === content) { r.message = "unchanged (same content)"; continue; }
            overlay.set(path, content);
            const size = formatBytes(new TextEncoder().encode(content).length);
            r.message = `${cur ? "replaced" : "created"} (${lineCount(content)} line${lineCount(content) === 1 ? "" : "s"}, ${size})`;
            continue;
        }
        // edit_file
        if (!cur) { fail(`There is no file ${path} in /workspace. Create it with <write_file>.`); continue; }
        if (cur.binary !== undefined) { fail(`${path} is a binary file (${describeBinary(cur.binary).type}); it can't be edited as text.`); continue; }
        let text = cur.text;
        const crlf = text.includes("\r\n") && !/(^|[^\r])\n/.test(text);
        const fix = (s) => (crlf ? String(s).replace(/\r?\n/g, "\r\n") : String(s));
        const flat = (s) => s.split(/\r?\n/).map(l => l.trim()).join("\n");
        const edits = a.args.edits || [];
        let error = "";
        for (let k = 0; k < edits.length && !error; k++) {
            const which = edits.length > 1 ? `change ${k + 1} of ${edits.length}: ` : "";
            const oldT = fix(edits[k].old_text), newT = fix(edits[k].new_text);
            if (!oldT) { error = which + "<old> is empty. Copy the text to replace from the file."; break; }
            if (oldT === newT) { error = which + "<old> and <new> are identical."; break; }
            const n = countOccurrences(text, oldT);
            if (n === 0) {
                error = which + (flat(oldT).trim() && flat(text).includes(flat(oldT))
                    ? `the <old> text differs from ${path} only in whitespace or indentation. Copy it exactly (read_file shows the file).`
                    : `the <old> text was not found in ${path}. Read the file and copy the text exactly.`);
            } else if (n > 1) {
                error = which + `the <old> text matches ${n} times in ${path}. Include more surrounding lines so it matches once.`;
            } else {
                const i = text.indexOf(oldT);
                text = text.slice(0, i) + newT + text.slice(i + oldT.length);
            }
        }
        if (error) { fail(error); continue; }
        overlay.set(path, text);
        r.ok = true;
        r.message = `edited (${edits.length} change${edits.length === 1 ? "" : "s"})`;
    }
    return { results, writes: failed ? new Map() : overlay, failed };
}

// What the model gets back from a file step (the observation body).
function formatFileResults(results, failed) {
    const out = [];
    results.forEach((r, i) => {
        const head = `[${i + 1}] ${r.tool} ${r.path || "?"}: ${r.ok ? r.message : "ERROR: " + r.message}`;
        out.push(r.output !== undefined ? head + "\n" + r.output : head);
    });
    if (failed) {
        const i = results.findIndex(r => !r.ok && r.tool !== "read_file");
        out.push(`No file changes were applied, because action ${i + 1} failed. Fix it and send all of the changes again.`);
    }
    return out.join("\n");
}

// ---------- Line diffs (DESIGN §2.1, "Effect") ----------
// Myers' O((N+M)·D) diff over lines, after trimming the common head and tail. Past
// maxD differences it gives up on a minimal diff and reports the changed middle as
// removed and re-added, which is still correct, just not minimal. Returns
// [{ op: " " | "-" | "+", text }].
function lineDiff(oldText, newText, maxD = 2000) {
    const A = String(oldText ?? "").split("\n"), B = String(newText ?? "").split("\n");
    // Both end with a newline: that isn't an empty last line worth showing.
    if (A.length > 1 && B.length > 1 && A[A.length - 1] === "" && B[B.length - 1] === "") { A.pop(); B.pop(); }
    let pre = 0;
    while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
    let suf = 0;
    while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
    const a = A.slice(pre, A.length - suf), b = B.slice(pre, B.length - suf);
    const N = a.length, M = b.length, off = N + M + 1;
    const V = new Int32Array(2 * off + 1);
    const trace = [];
    let solved = N === 0 && M === 0;
    for (let d = 0; !solved && d <= Math.min(N + M, maxD); d++) {
        // V before this round, for k in [-d-1, d+1]: what backtracking reads.
        trace.push(V.slice(off - d - 1, off + d + 2));
        for (let k = -d; k <= d; k += 2) {
            let x = k === -d || (k !== d && V[off + k - 1] < V[off + k + 1]) ? V[off + k + 1] : V[off + k - 1] + 1;
            let y = x - k;
            while (x < N && y < M && a[x] === b[y]) { x++; y++; }
            V[off + k] = x;
            if (x >= N && y >= M) { solved = true; break; }
        }
    }
    const mid = [];
    if (!solved) {
        for (const t of a) mid.push({ op: "-", text: t });
        for (const t of b) mid.push({ op: "+", text: t });
    } else {
        let x = N, y = M;
        for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
            const v = trace[d], at = (k) => v[k + d + 1];
            const k = x - y;
            const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
            const px = at(prevK), py = px - prevK;
            while (x > px && y > py) { mid.push({ op: " ", text: a[x - 1] }); x--; y--; }
            if (d > 0) mid.push(x === px ? { op: "+", text: b[py] } : { op: "-", text: a[px] });
            x = px; y = py;
        }
        mid.reverse();
    }
    return [
        ...A.slice(0, pre).map(text => ({ op: " ", text })),
        ...mid,
        ...A.slice(A.length - suf).map(text => ({ op: " ", text })),
    ];
}

// Group a line diff into hunks with `context` unchanged lines around each change, like
// `diff -u`. Each line carries its old and new line number (0 where it has none).
// Returns { hunks: [{ oldStart, newStart, lines: [{ op, text, oldNo, newNo }] }], added, removed }.
function diffHunks(ops, context = 3) {
    const rows = [];
    let o = 1, n = 1, added = 0, removed = 0;
    for (const x of ops || []) {
        rows.push({ op: x.op, text: x.text, oldNo: x.op === "+" ? 0 : o, newNo: x.op === "-" ? 0 : n });
        if (x.op !== "+") o++;
        if (x.op !== "-") n++;
        if (x.op === "+") added++;
        if (x.op === "-") removed++;
    }
    const hunks = [];
    let cur = null, lastChange = -Infinity;
    rows.forEach((r, i) => {
        if (r.op === " ") return;
        const from = Math.max(0, i - context);
        if (cur && from <= lastChange + context + 1) {
            for (let j = lastChange + 1; j <= i; j++) cur.lines.push(rows[j]);
        } else {
            if (cur) cur.lines.push(...rows.slice(lastChange + 1, Math.min(rows.length, lastChange + 1 + context)));
            cur = { lines: rows.slice(from, i + 1) };
            hunks.push(cur);
        }
        lastChange = i;
    });
    if (cur) cur.lines.push(...rows.slice(lastChange + 1, Math.min(rows.length, lastChange + 1 + context)));
    for (const h of hunks) {
        const first = h.lines[0];
        h.oldStart = first.oldNo || (rows.slice(0, rows.indexOf(first)).filter(r => r.op !== "+").length + 1);
        h.newStart = first.newNo || (rows.slice(0, rows.indexOf(first)).filter(r => r.op !== "-").length + 1);
    }
    return { hunks, added, removed };
}

// ---------- Observation elision (DESIGN §5.4) ----------
// What the model is sent: the history with long observations and written file contents
// of older steps shortened. The history itself keeps everything (summariser, rewind,
// export). The last keepSteps to 2·keepSteps−1 steps stay in full: the boundary moves in
// blocks of keepSteps, so the prompt prefix stays the same for several requests and the
// server can keep reusing its prompt cache, instead of re-reading the tail every step.
function elideHistory(messages, keepSteps, minChars) {
    const keep = Math.max(1, keepSteps || 1), min = Math.max(200, minChars || 0);
    const at = [];
    for (let i = 2; i < messages.length; i++) if (messages[i].role === "assistant") at.push(i);
    const elideSteps = Math.floor(Math.max(0, at.length - keep) / keep) * keep;
    const out = messages.map(copyMessage);
    if (!elideSteps) return out;
    const end = at[elideSteps];   // messages[2..end) belong to the elided steps
    const kb = (n) => (n >= 1024 ? (n / 1024).toFixed(1) + " KB" : n + " characters");
    for (let i = 2; i < end; i++) {
        const m = out[i];
        const placeholder = (body) => `[… ${body.replace(/^\r?\n/, "").split("\n").length} lines (${kb(body.length)}) elided from this old step; the file is in /workspace …]`;
        if (m.role === "assistant") {
            m.content = m.content.replace(/^([ \t]*<write_file\b[^>\n]*>)([\s\S]*?)(<\/write_file>)/gm, (all, open, body, close) => (body.length <= min ? all : `${open}\n${placeholder(body)}\n${close}`));
            // Native write_file calls: the content argument (the arguments stay valid JSON).
            for (const c of m.tool_calls || []) {
                if (c.function.name !== "write_file" || c.function.arguments.length <= min) continue;
                try {
                    const a = JSON.parse(c.function.arguments);
                    if (a && typeof a.content === "string" && a.content.length > min) c.function.arguments = JSON.stringify({ ...a, content: placeholder(a.content) });
                } catch (e) { /* stored calls are valid JSON; leave anything else alone */ }
            }
        } else {
            m.content = m.content.replace(/(<observation step="(\d+)"[^>\n]*>\n)([\s\S]*?)(\n<\/observation>)/g, (all, open, step, body, close) => {
                if (body.length <= min) return all;
                const head = 600, tail = 600;
                return open + body.slice(0, head) + `\n[… ${kb(body.length - head - tail)} of step ${step}'s output elided to save context; read the file or re-run the code if you need it …]\n` + body.slice(-tail) + close;
            });
        }
    }
    return out;
}

// ---------- Endpoint errors: retry and resume ----------
// Worth retrying: the endpoint is down, restarting or overloaded, or the connection
// dropped mid-reply. Not: a bad request, credentials, a wrong URL, a prompt too long.
function isRetryableError(message) {
    const msg = String(message || "");
    const status = Number((msg.match(/^Server Error (\d{3})\b/) || [])[1] || 0);
    if (status) return status === 408 || status === 429 || (status >= 500 && status !== 501 && status !== 505);
    if (isContextOverflowError(msg)) return false;
    // Chrome: "Failed to fetch" / "network error"; Firefox: "NetworkError when attempting
    // to fetch resource" / "Error in input stream"; Safari: "Load failed".
    return /Failed to fetch|NetworkError|network error|^Load failed$|Error in (?:input|body) stream|ERR_|ECONNRESET|connection (?:was )?(?:reset|closed|dropped)|stream ended before|stream stalled/i.test(msg);
}

// The wait before retry `attempt` (1-based): doubling from the first delay, capped.
function retryDelayMs(attempt, firstMs, maxMs) {
    return Math.min(maxMs, firstMs * 2 ** Math.max(0, attempt - 1));
}

// ---------- Context gauge (status bar) ----------
// The next request's estimated size against the context, and where auto-compaction
// kicks in (compactionDue's threshold). limit 0 = unknown size.
function contextGauge(estTokens, limit, pct, reserve) {
    const k = (v) => (v >= 1000 ? (v / 1000).toFixed(1) + "k" : String(Math.round(v)));
    if (!(limit > 0)) return { text: `~${k(estTokens)} tok`, frac: 0, compactAt: 0, level: "unknown" };
    const frac = estTokens / limit;
    const room = Math.min(Number.isFinite(reserve) && reserve > 0 ? reserve : 0, limit / 2);
    const compactAt = pct > 0 ? Math.min(limit * pct / 100, limit - room) : 0;
    const level = compactAt && estTokens >= compactAt ? "high" : frac >= 0.6 ? "mid" : "low";
    return { text: `~${k(estTokens)} / ${k(limit)} · ${Math.round(frac * 100)}%`, frac: Math.min(1, frac), compactAt, level };
}

// ---------- Uploads ----------
// A confirm text when files about to be added are large enough to strain the tab, or "".
// files: [{ path, size }]; currentBytes: what the workspace already holds.
function uploadWarning(files, currentBytes) {
    const list = files || [];
    const total = list.reduce((n, f) => n + (f.size || 0), 0);
    const big = list.reduce((m, f) => (!m || f.size > m.size ? f : m), null);
    const reasons = [];
    if (total >= LIMITS.uploadWarnBytes) reasons.push(`${formatBytes(total)} in ${list.length} file${list.length === 1 ? "" : "s"}`);
    else if (big && big.size >= LIMITS.uploadWarnFileBytes) reasons.push(`${big.path} is ${formatBytes(big.size)}`);
    if (list.length >= LIMITS.uploadWarnFiles) reasons.push(`${list.length} files`);
    if (!reasons.length) return "";
    const after = (currentBytes || 0) + total;
    return `You are adding ${reasons.join(" and ")}. Everything is held in this tab's memory (workspace limit ${formatBytes(LIMITS.maxWorkspaceBytes)}${after > LIMITS.maxWorkspaceBytes ? ": not all of it will fit" : ""}), each changed version is kept for rewinding, and large files make every step that scans the workspace slower. Add them anyway?`;
}

// ---------- Packages (DESIGN §8) ----------
// The import names of the packages Pyodide can load on demand, from its lock file:
// real packages only (no shared libraries, no *-tests), private names left out.
// Pyodide packages agent code must not use: micropip installs at run time, but agent code
// has no network (only the harness's package loading reaches the CDN), so a model that
// sees it in the list reaches for micropip.install instead of a plain import, and fails.
const HARNESS_ONLY_PACKAGES = ["micropip"];

function packageImportNames(lock) {
    const pk = lock && typeof lock === "object" && lock.packages && typeof lock.packages === "object" ? lock.packages : {};
    const names = new Set();
    for (const p of Object.values(pk)) {
        if (!p || p.package_type !== "package" || /-tests$/.test(p.name || "") || HARNESS_ONLY_PACKAGES.includes(p.name)) continue;
        for (const i of Array.isArray(p.imports) ? p.imports : []) {
            if (typeof i === "string" && /^[A-Za-z][\w.-]*$/.test(i)) names.add(i);
        }
    }
    return [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

// Import name -> package name for everything the lock file can load, stdlib modules
// Pyodide ships separately (sqlite3, lzma, …) included.
function importPackageIndex(lock) {
    const pk = lock && typeof lock === "object" && lock.packages && typeof lock.packages === "object" ? lock.packages : {};
    const map = new Map();
    for (const p of Object.values(pk)) {
        if (!p || typeof p.name !== "string" || p.package_type === "shared_library" || p.package_type === "static_library" || HARNESS_ONLY_PACKAGES.includes(p.name)) continue;
        for (const i of Array.isArray(p.imports) ? p.imports : []) if (typeof i === "string" && !map.has(i)) map.set(i, p.name);
    }
    return map;
}

// ---------- Bundled libraries (Phase 3.5) ----------
// Package names compare normalized, the way pip does: Pyodide reports "Pillow" for the
// lock entry "pillow", and "typing-extensions" is "typing_extensions" elsewhere.
function normalizePackageName(name) {
    return String(name || "").toLowerCase().replace(/[-_.]+/g, "-");
}

// Import name -> bundled library name (BUNDLED_LIBRARIES shape).
function bundledImportIndex(libs) {
    const map = new Map();
    for (const [name, lib] of Object.entries(libs && typeof libs === "object" ? libs : {})) {
        for (const i of Array.isArray(lib && lib.imports) ? lib.imports : []) if (typeof i === "string" && !map.has(i)) map.set(i, name);
    }
    return map;
}

// What a step needs from the bundle. imports: top-level names its code (and the workspace
// files it uses) import; texts: that code, searched for each library's `uses` words;
// loaded: package and library names already in the interpreter. Returns { bundles, pyodide }:
// the libraries to install, those they require first, and the Pyodide packages they import
// (lock-file names) that aren't loaded yet.
function planBundledLoad(imports, texts, libs, loaded) {
    const all = libs && typeof libs === "object" ? libs : {};
    const have = new Set([...(loaded || [])].map(normalizePackageName));
    const index = bundledImportIndex(all);
    const wanted = [];
    for (const i of imports || []) { const n = index.get(i); if (n && !wanted.includes(n)) wanted.push(n); }
    for (const [name, lib] of Object.entries(all)) {
        if (wanted.includes(name)) continue;
        const uses = Array.isArray(lib.uses) ? lib.uses : [];
        if (uses.some(w => (texts || []).some(t => new RegExp(`\\b${w.replace(/[^\w]/g, "")}\\b`).test(String(t || ""))))) wanted.push(name);
    }
    const bundles = [], pyodide = [];
    const visit = (name, depth) => {
        const lib = all[name];
        if (!lib || depth > 10 || bundles.includes(name) || have.has(normalizePackageName(name))) return;
        for (const r of Array.isArray(lib.requires) ? lib.requires : []) visit(r, depth + 1);
        bundles.push(name);
        for (const p of Array.isArray(lib.pyodide) ? lib.pyodide : []) {
            if (!have.has(normalizePackageName(p)) && !pyodide.includes(p)) pyodide.push(p);
        }
    };
    for (const n of wanted) visit(n, 0);
    return { bundles, pyodide };
}

// The note a step gets after its packages loaded. r: the validated load result.
function packageLoadNote(r) {
    const loaded = (r && r.loaded) || [], installed = (r && r.installed) || [];
    if (!loaded.length && !installed.length) return "";
    const parts = [];
    if (loaded.length) parts.push(`${loaded.join(", ")} from the Pyodide CDN`);
    if (installed.length) parts.push(`${installed.join(", ")} from the libraries bundled with HermitUI Agent`);
    return `Loaded ${parts.join(" and ")} (${((r.ms || 0) / 1000).toFixed(1)} s).`;
}

// Why a step's packages didn't load, for the step and the model. r: the worker's load
// result { failed, errors, netAttempts }; online: navigator.onLine; cdn: the pinned
// package URL. A blocked download outside the CDN means the registry was tampered with.
function packageFailureMessage(r, online, cdn) {
    const failed = (r && r.failed || []).filter(n => n !== "(packages)");
    const what = failed.length ? failed.join(", ") : "the packages this code imports";
    const outside = (r && r.netAttempts || []).find(a => !String(a).includes(cdn));
    const first = (r && r.errors || []).find(e => !/^The following error occurred/.test(e)) || "";
    const still = " The standard library and packages that loaded earlier still work.";
    if (outside) return `Couldn't load ${what}: the download was redirected outside the pinned package CDN (${outside}), so it was blocked. Nothing ran.${still}`;
    if (online === false) return `Couldn't load ${what}: this browser is offline, and packages are downloaded from the Pyodide CDN the first time they are imported. Nothing ran.${still}`;
    if (!first || /request failed|Failed to fetch|NetworkError|network error|Load failed/i.test(first)) {
        return `Couldn't load ${what}: the Pyodide package CDN (${cdn.replace(/^https?:\/\//, "").split("/")[0]}) couldn't be reached. Nothing ran.${still}`;
    }
    return `Couldn't load ${what}: ${first} Nothing ran.${still}`;
}

// The workspace .py files a step's code uses, so the packages they import are loaded too
// (a step that runs `runpy.run_path("make_report.py")` imports nothing itself). A file
// counts when the code imports its module (`import pkg.mod`, `from mod import x`) or
// names the file ("mod.py", e.g. for runpy or exec); files it uses count in turn.
// paths: workspace paths; read(path) -> text or null. Returns the paths, at most `max`.
function referencedPythonFiles(code, paths, read, max = 50) {
    const mods = new Map();
    for (const p of paths || []) {
        if (!/\.py$/.test(p)) continue;
        const mod = p.slice(0, -3).replace(/\/__init__$/, "").split("/").join(".");
        mods.set(p, { mod, base: p.split("/").pop() });
    }
    const out = [], seen = new Set();
    const queue = [String(code || "")];
    while (queue.length && out.length < max) {
        const text = queue.shift();
        const imported = new Set();
        for (const m of text.matchAll(/^[ \t]*from[ \t]+([\w.]+)[ \t]+import\b/gm)) imported.add(m[1]);
        for (const m of text.matchAll(/^[ \t]*import[ \t]+([\w., \t]+)/gm)) {
            for (const part of m[1].split(",")) { const name = part.trim().split(/\s+/)[0]; if (name) imported.add(name); }
        }
        for (const [p, { mod, base }] of mods) {
            if (seen.has(p) || out.length >= max) continue;
            const named = [...imported].some(i => i === mod || i.startsWith(mod + ".") || mod.startsWith(i + "."));
            if (!named && !text.includes(base)) continue;
            seen.add(p);
            const t = read(p);
            if (typeof t !== "string") continue;
            out.push(p);
            queue.push(t);
        }
    }
    return out;
}

// Pyodide's note on a package it has but didn't load says to call micropip.install or
// loadPackage, neither of which agent code can do (no network). Replace it with what
// works here: an import in the step's own code, which the harness loads first.
// The advice names the module as imported (PIL), not the package (pillow): an
// "import pillow" would fail.
function rewritePyodideInstallAdvice(output) {
    const out = String(output || "");
    const mod = (out.match(/No module named '([\w.]+)'/) || [])[1];
    return out.replace(/\nYou can install it by calling:\n[ \t]*await micropip\.install\("([^"]+)"\) in Python, or\n[ \t]*await pyodide\.loadPackage\("[^"]+"\) in JavaScript/g,
        (all, pkg) => HARNESS_ONLY_PACKAGES.includes(pkg)
            ? `\n[HermitUI: ${pkg} isn't available to agent code, and nothing needs installing: packages load by themselves when the step's code imports them.]`
            : `\n[HermitUI: no micropip here. ${pkg} loads by itself when the step's code, or a workspace .py file it imports or runs, has "import ${mod ? mod.split(".")[0] : pkg}".]`);
}

// A note for a step that failed on an import nothing can provide: Pyodide has no pip.
// For a package it has but that wasn't loaded (an import the harness couldn't see, such
// as one built at run time), how to get it loaded instead.
// bundled: the import names of the bundled libraries, which Pyodide knows nothing about,
// so its own "not installed" note never appears for them. pandas' "Missing optional
// dependency 'openpyxl'" (it imports the library itself) counts as an import of it.
function moduleNotFoundHint(output, available, bundled) {
    const m = String(output || "").match(/ModuleNotFoundError: No module named '([\w.]+)'|ImportError: Missing optional dependency '([\w.-]+)'/);
    if (!m) return "";
    const top = (m[1] || m[2]).split(".")[0];
    const notLoaded = `${top} is available but wasn't loaded: packages are loaded before a step, from the imports in its code and in the workspace .py files it imports or runs by name. Add "import ${top}" at the top of the step's code and run it again. Don't use micropip or loadPackage.`;
    if (top === "micropip" || top === "pip") return `There is no ${top} here, and nothing needs installing: a package from the list in your instructions loads by itself when you import it. Just import it.`;
    if (/is included in the Pyodide distribution, but it is not installed|is unvendored from the Python standard library/.test(output) || (bundled || []).includes(top)) return notLoaded;
    if ((available || []).includes(top)) return m[2] ? notLoaded : "";
    return `${top} isn't part of the Pyodide distribution and can't be installed here (no pip, no network). Use the standard library or one of the packages listed in your instructions, or write the code yourself.`;
}

// ---------- Binary files (DESIGN §2.1) ----------
// What a binary file is, from its first bytes: the format and what its header tells
// cheaply (image size, entry or page count, array shape, audio length). It never decodes
// the file. Returns { kind, type, details }: kind is "image" | "archive" | "document" |
// "data" | "audio" | "video" | "font" | "program" | "binary"; details are short phrases.
function describeBinary(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(0);
    const n = b.length;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const at = (off, sig) => off >= 0 && off + sig.length <= n && sig.every((x, i) => x === b[off + i]);
    const ascii = (off, s) => at(off, [...s].map(c => c.charCodeAt(0)));
    const u16 = (o, le) => (o >= 0 && o + 2 <= n ? dv.getUint16(o, le) : 0);
    const u32 = (o, le) => (o >= 0 && o + 4 <= n ? dv.getUint32(o, le) : 0);
    const latin1 = (from, to) => new TextDecoder("latin1").decode(b.subarray(from, Math.min(n, to)));
    const px = (w, h) => (w > 0 && h > 0 ? [`${w}×${h} px`] : []);
    const plural = (k, one, many) => `${k.toLocaleString("en-US")} ${k === 1 ? one : many}`;
    const out = (kind, type, details) => ({ kind, type, details: (details || []).filter(Boolean) });

    // Images
    if (at(0, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) {
        return out("image", "PNG image", [...px(u32(16), u32(20)), { 0: "grayscale", 2: "RGB", 3: "palette", 4: "grayscale + alpha", 6: "RGBA" }[b[25]]]);
    }
    if (at(0, [0xFF, 0xD8, 0xFF])) {
        for (let o = 2; o + 9 < n;) {
            if (b[o] !== 0xFF) { o++; continue; }
            const m = b[o + 1];
            if (m === 0xFF) { o++; continue; }
            if (m === 0x01 || (m >= 0xD0 && m <= 0xD8)) { o += 2; continue; }   // markers without a length
            if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
                return out("image", "JPEG image", [...px(u16(o + 7), u16(o + 5)), { 1: "grayscale", 3: "color", 4: "CMYK" }[b[o + 9]]]);
            }
            if (m === 0xDA || m === 0xD9) break;   // image data: no frame header before it
            o += 2 + u16(o + 2);
        }
        return out("image", "JPEG image");
    }
    if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return out("image", "GIF image", px(u16(6, true), u16(8, true)));
    if (ascii(0, "RIFF") && ascii(8, "WEBP")) {
        const v = (o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
        if (ascii(12, "VP8X")) return out("image", "WebP image", [...px(v(24) + 1, v(27) + 1), b[20] & 2 ? "animated" : ""]);
        if (ascii(12, "VP8L")) { const bits = u32(21, true); return out("image", "WebP image", px((bits & 0x3FFF) + 1, ((bits >>> 14) & 0x3FFF) + 1)); }
        if (ascii(12, "VP8 ")) return out("image", "WebP image", px(u16(26, true) & 0x3FFF, u16(28, true) & 0x3FFF));
        return out("image", "WebP image");
    }
    if (ascii(0, "BM") && n >= 26 && u32(2, true) <= n + 1024) return out("image", "BMP image", px(dv.getInt32(18, true), Math.abs(dv.getInt32(22, true))));
    if (at(0, [0x49, 0x49, 0x2A, 0]) || at(0, [0x4D, 0x4D, 0, 0x2A])) return out("image", "TIFF image");
    if (at(0, [0, 0, 1, 0]) && u16(4, true) >= 1 && n >= 6 + 16 * u16(4, true)) return out("image", "ICO icon", [plural(u16(4, true), "image", "images")]);
    // Documents and data
    if (ascii(0, "%PDF-")) {
        const text = latin1(0, 16 << 20);
        let pages = 0;
        for (const m of text.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)|\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages\b/g)) pages = Math.max(pages, Number(m[1] || m[2]));
        return out("document", "PDF document", ["version " + latin1(5, 8).replace(/[^\d.]/g, ""), pages ? plural(pages, "page", "pages") : ""]);
    }
    if (ascii(0, "SQLite format 3\0")) {
        const pageSize = u16(16) === 1 ? 65536 : u16(16);
        const tables = [];
        for (const m of latin1(0, 4 << 20).matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["`[]?([A-Za-z_][\w$]*)/gi)) {
            if (!tables.includes(m[1]) && !m[1].startsWith("sqlite_")) tables.push(m[1]);
        }
        tables.sort((x, y) => x.localeCompare(y));   // records sit back to front in a page
        return out("data", "SQLite database", [tables.length ? `tables: ${tables.slice(0, 12).join(", ")}${tables.length > 12 ? " …" : ""}` : "", plural(u32(28), "page", "pages") + ` of ${formatBytes(pageSize)}`]);
    }
    if (at(0, [0x93]) && ascii(1, "NUMPY")) {
        const head = b[6] === 1 ? latin1(10, 10 + u16(8, true)) : latin1(12, 12 + u32(8, true));
        const descr = (head.match(/'descr':\s*'([^']*)'/) || [])[1] || "";
        const shape = (head.match(/'shape':\s*\(([^)]*)\)/) || [])[1];
        const t = descr.match(/^[<>|=]?([a-zA-Z])(\d*)/);
        const names = { f: "float", i: "int", u: "uint", c: "complex", b: "bool", U: "str", S: "bytes", O: "object", M: "datetime64", m: "timedelta64" };
        const dtype = !t ? descr : "fiuc".includes(t[1]) && t[2] ? names[t[1]] + Number(t[2]) * 8 : names[t[1]] || descr;
        return out("data", "NumPy array (.npy)", [dtype && "dtype " + dtype, shape !== undefined ? `shape (${shape.trim()})` : ""]);
    }
    if (ascii(0, "PAR1") && n >= 8 && ascii(n - 4, "PAR1")) return out("data", "Parquet file");
    if (ascii(0, "ARROW1")) return out("data", "Arrow IPC / Feather file");
    if (at(0, [0x89, 0x48, 0x44, 0x46, 0x0D, 0x0A, 0x1A, 0x0A])) return out("data", "HDF5 file");
    if (b[0] === 0x80 && b[1] >= 2 && b[1] <= 5 && b[n - 1] === 0x2E) return out("data", "Python pickle", ["protocol " + b[1]]);
    if (at(0, [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1])) return out("document", "legacy Microsoft Office file (.xls, .doc or .ppt)");
    // Archives
    if (ascii(0, "PK") && (at(2, [3, 4]) || at(2, [5, 6]))) {
        const cd = zipCentralDirectory(b, 2000);
        if (!cd) return out("archive", "ZIP archive", ["unreadable directory"]);
        const names = cd.entries.map(e => e.name);
        const files = names.filter(x => !x.endsWith("/"));
        let type = "ZIP archive";
        if (names.includes("[Content_Types].xml")) {
            type = names.some(x => x.startsWith("xl/")) ? "Excel workbook (.xlsx)" : names.some(x => x.startsWith("word/")) ? "Word document (.docx)" : names.some(x => x.startsWith("ppt/")) ? "PowerPoint presentation (.pptx)" : "Office Open XML file";
        } else if (files.length && files.every(x => x.endsWith(".npy"))) type = "NumPy archive (.npz)";
        else if (names.some(x => /\.dist-info\/WHEEL$/.test(x))) type = "Python wheel";
        else if (names.includes("mimetype") && names.includes("META-INF/container.xml")) type = "EPUB e-book";
        else if (names.includes("META-INF/MANIFEST.MF")) type = "Java archive (JAR)";
        const kind = /Excel|Word|PowerPoint|Office|EPUB/.test(type) ? "document" : type.startsWith("NumPy") ? "data" : "archive";
        return out(kind, type, [
            type.startsWith("NumPy") ? `arrays: ${files.slice(0, 8).map(x => x.slice(0, -4)).join(", ")}${files.length > 8 ? " …" : ""}` : plural(cd.count, "entry", "entries"),
            cd.count ? `unpacks to ${formatBytes(cd.total)}` + (cd.entries.length < cd.count ? "+" : "") : "",
        ]);
    }
    if (at(0, [0x1F, 0x8B])) {
        let name = "";
        if (b[3] & 8) {
            let o = 10 + (b[3] & 4 ? 2 + u16(10, true) : 0);
            const end = b.indexOf(0, o);
            if (end > o) name = latin1(o, Math.min(end, o + 200));
        }
        return out("archive", /\.tar$/i.test(name) ? "gzip-compressed tar archive" : "gzip-compressed data", [name && "of " + name, n >= 18 ? `unpacks to ${formatBytes(u32(n - 4, true))}` : ""]);
    }
    if (ascii(257, "ustar")) {
        let count = 0;
        for (let o = 0; o + 512 <= n && b[o] && count < 100000; count++) {
            const size = parseInt(latin1(o + 124, o + 136).replace(/[^0-7]/g, "") || "0", 8);
            o += 512 + Math.ceil(size / 512) * 512;
        }
        return out("archive", "tar archive", [plural(count, "entry", "entries")]);
    }
    if (ascii(0, "BZh")) return out("archive", "bzip2-compressed data");
    if (at(0, [0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00])) return out("archive", "xz-compressed data");
    if (at(0, [0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C])) return out("archive", "7-Zip archive");
    if (at(0, [0x28, 0xB5, 0x2F, 0xFD])) return out("archive", "Zstandard-compressed data");
    // Audio and video
    if (ascii(0, "RIFF") && ascii(8, "WAVE")) {
        let channels = 0, rate = 0, byteRate = 0, bits = 0, dataSize = -1;
        for (let o = 12; o + 8 <= n;) {
            const id = latin1(o, o + 4), size = u32(o + 4, true);
            if (id === "fmt ") { channels = u16(o + 10, true); rate = u32(o + 12, true); byteRate = u32(o + 16, true); bits = u16(o + 22, true); }
            if (id === "data") { dataSize = Math.min(size, n - o - 8); break; }
            o += 8 + size + (size & 1);
        }
        return out("audio", "WAV audio", [
            rate ? `${rate.toLocaleString("en-US")} Hz` : "", { 1: "mono", 2: "stereo" }[channels] || (channels ? `${channels} channels` : ""), bits ? `${bits}-bit` : "",
            byteRate && dataSize >= 0 ? `${(dataSize / byteRate).toFixed(dataSize / byteRate < 10 ? 2 : 1)} s` : "",
        ]);
    }
    if (ascii(0, "ID3") || (b[0] === 0xFF && [0xFB, 0xF3, 0xF2].includes(b[1]))) return out("audio", "MP3 audio");
    if (ascii(0, "OggS")) return out("audio", "Ogg media");
    if (ascii(0, "fLaC")) return out("audio", "FLAC audio");
    if (ascii(4, "ftyp")) {
        const brand = latin1(8, 12);
        return brand === "M4A " ? out("audio", "MPEG-4 audio") : out("video", brand === "qt  " ? "QuickTime video" : "MP4 video", ["brand " + brand.trim()]);
    }
    // Fonts and programs
    if (ascii(0, "wOFF")) return out("font", "WOFF font");
    if (ascii(0, "wOF2")) return out("font", "WOFF2 font");
    if (ascii(0, "OTTO")) return out("font", "OpenType font");
    if (at(0, [0, 1, 0, 0]) && u16(4) > 0 && u16(4) < 64 && /^[A-Za-z0-9 /]{4}$/.test(latin1(12, 16))) return out("font", "TrueType font");
    if (at(0, [0, 0x61, 0x73, 0x6D])) return out("program", "WebAssembly module", ["version " + u32(4, true)]);
    if (at(0, [0x7F, 0x45, 0x4C, 0x46])) return out("program", "ELF executable", [{ 1: "32-bit", 2: "64-bit" }[b[4]]]);
    if (ascii(0, "MZ") && ascii(u32(60, true), "PE\0\0")) return out("program", "Windows executable");
    return out("binary", "binary data");
}

// The central directory of a zip, read without unpacking anything: { count, total (the
// unpacked size of the entries read), entries: [{ name, size }] (at most max) }, or null.
function zipCentralDirectory(bytes, max) {
    const n = bytes.length;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let i = n - 22; i >= Math.max(0, n - 22 - 65535); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) return null;
    const count = dv.getUint16(eocd + 10, true);
    const entries = [];
    let total = 0;
    const dec = new TextDecoder();
    for (let i = 0, p = dv.getUint32(eocd + 16, true); i < Math.min(count, max); i++) {
        if (p + 46 > n || dv.getUint32(p, true) !== 0x02014b50) return entries.length ? { count, total, entries } : null;
        const nameLen = dv.getUint16(p + 28, true);
        const size = dv.getUint32(p + 24, true);
        entries.push({ name: dec.decode(bytes.subarray(p + 46, p + 46 + nameLen)), size });
        total += size;
        p += 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
    }
    return { count, total, entries };
}

// One line: "PNG image, 640×480 px, RGBA, 18.2 KB".
function binarySummary(bytes) {
    const d = describeBinary(bytes);
    return [d.type, ...d.details, formatBytes(bytes ? bytes.length : 0)].join(", ");
}

// What the model is told about the binary files a step wrote, since it can't open them:
// their format, and which were figures captured for the user (DESIGN §8). written:
// [{ path, bytes }] of the added and modified files; figures: the worker's captures,
// [{ path, width, height, how: "show" | "end" }]. Returns notes (strings).
function binaryFileNotes(written, figures) {
    const figs = new Map((figures || []).map(f => [f.path, f]));
    const shown = [], other = [];
    for (const w of written || []) {
        const f = figs.get(w.path);
        if (f) shown.push(`${w.path} (${f.width}×${f.height} px, ${f.how === "show" ? "from plt.show()" : "still open at the end of the step"})`);
        else if (decodeTextFile(w.bytes) === null) other.push(`${w.path}: ${binarySummary(w.bytes)}`);
    }
    const notes = [];
    if (shown.length) notes.push(`Figure${shown.length === 1 ? "" : "s"} saved and shown to the user: ${shown.join(", ")}. You can't see images; the user can.`);
    if (other.length) notes.push(`Binary file${other.length === 1 ? "" : "s"} written: ${other.slice(0, 10).join("; ")}${other.length > 10 ? `; and ${other.length - 10} more` : ""}.`);
    return notes;
}

// DESIGN §5.4: every `every` steps the model gets the current file list again, when it
// changed since the last list it got, so it doesn't work from a stale memory of
// /workspace. files: [{ path, size, hash }]; lastKey: the key of that last list.
// Returns { note, key } when one is due, else null.
function periodicFileListing(step, every, lastKey, files) {
    if (!(every > 0 && step > 0 && step % every === 0)) return null;
    const key = fileListingKey(files);
    if (key === lastKey) return null;
    return { key, note: `Files in /workspace now: ${formatFileList([...files].sort((a, b) => (a.path < b.path ? -1 : 1)))}` };
}

function fileListingKey(files) {
    return (files || []).map(f => f.path + ":" + f.hash).sort().join("\n");
}

// ========== 4. Zip + session archive (pure) ==========
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();

function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

async function streamThrough(bytes, transform, maxOut) {
    const reader = new Blob([bytes]).stream().pipeThrough(transform).getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (maxOut !== undefined && total > maxOut) {
            reader.cancel().catch(() => {});
            throw new Error("zip entry inflates to more than its declared size");
        }
        chunks.push(value);
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
}

// sha256 as lowercase hex. WebCrypto needs a secure context (file://, https, localhost);
// a page served over plain http on a LAN falls back to the small JS version.
async function sha256Hex(bytes) {
    if (globalThis.crypto && crypto.subtle) {
        const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
        return Array.from(d, b => b.toString(16).padStart(2, "0")).join("");
    }
    return sha256HexJs(bytes);
}

function sha256HexJs(bytes) {
    const K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
    const H = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    const len = bytes.length;
    const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
    padded.set(bytes);
    padded[len] = 0x80;
    const dv = new DataView(padded.buffer);
    dv.setUint32(padded.length - 8, Math.floor(len / 0x20000000));
    dv.setUint32(padded.length - 4, (len << 3) >>> 0);
    const W = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < padded.length; off += 64) {
        for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
        for (let i = 16; i < 64; i++) {
            const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
            const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
            W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
        }
        let [a, b, c, d, e, f, g, h] = H;
        for (let i = 0; i < 64; i++) {
            const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) >>> 0;
            const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
            h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
        }
        H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
    }
    return Array.from(H, x => x.toString(16).padStart(8, "0")).join("");
}

// DESIGN §3.2: a small zip writer. entries: [{ path, data: Uint8Array }]. Deflates
// each entry (stored when that doesn't help), UTF-8 names, no ZIP64 (the size limits
// keep archives far below 4 GB).
async function zipWrite(entries, date) {
    const d = date instanceof Date ? date : new Date();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const enc = new TextEncoder();
    const locals = [], centrals = [];
    let offset = 0;
    for (const e of entries) {
        const name = enc.encode(e.path);
        const raw = e.data instanceof Uint8Array ? e.data : enc.encode(String(e.data ?? ""));
        let data = raw.length ? await streamThrough(raw, new CompressionStream("deflate-raw")) : raw;
        let method = 8;
        if (!raw.length || data.length >= raw.length) { data = raw; method = 0; }
        const crc = crc32(raw);
        const lh = new DataView(new ArrayBuffer(30));
        lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
        lh.setUint16(8, method, true); lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
        lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, raw.length, true);
        lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
        const ch = new DataView(new ArrayBuffer(46));
        ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
        ch.setUint16(8, 0x0800, true); ch.setUint16(10, method, true); ch.setUint16(12, dosTime, true);
        ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true);
        ch.setUint32(24, raw.length, true); ch.setUint16(28, name.length, true);
        ch.setUint32(42, offset, true);
        locals.push(new Uint8Array(lh.buffer), name, data);
        centrals.push(new Uint8Array(ch.buffer), name);
        offset += 30 + name.length + data.length;
    }
    const cdSize = centrals.reduce((n, c) => n + c.length, 0);
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(8, entries.length, true); eocd.setUint16(10, entries.length, true);
    eocd.setUint32(12, cdSize, true); eocd.setUint32(16, offset, true);
    const parts = [...locals, ...centrals, new Uint8Array(eocd.buffer)];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}

// DESIGN §3.3: the reader treats the archive as untrusted. It enforces entry-count
// and total-size limits (declared *and* actual, which also stops zip bombs), rejects
// unsafe paths, encryption and ZIP64, and verifies every CRC. Directory entries are
// skipped. Returns [{ path, data }].
async function zipRead(bytes, limits) {
    const lim = Object.assign({ maxEntries: LIMITS.maxArchiveEntries, maxBytes: LIMITS.maxArchiveBytes }, limits || {});
    if (!(bytes instanceof Uint8Array) || bytes.length < 22) throw new Error("Not a zip file (too small).");
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
        if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("Not a zip file (no end-of-central-directory record).");
    const count = dv.getUint16(eocd + 10, true);
    const cdSize = dv.getUint32(eocd + 12, true);
    const cdOffset = dv.getUint32(eocd + 16, true);
    if (count === 0xFFFF || cdOffset === 0xFFFFFFFF) throw new Error("ZIP64 archives are not supported.");
    if (count > lim.maxEntries) throw new Error(`The archive has ${count} entries (limit ${lim.maxEntries}).`);
    if (cdOffset + cdSize > eocd) throw new Error("Corrupt zip (central directory out of range).");
    const dec = new TextDecoder("utf-8", { fatal: false });
    const out = [];
    const seen = new Set();
    let total = 0;
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
        if (p + 46 > bytes.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error("Corrupt zip (bad central directory entry).");
        const flags = dv.getUint16(p + 8, true);
        const method = dv.getUint16(p + 10, true);
        const crc = dv.getUint32(p + 16, true);
        const csize = dv.getUint32(p + 20, true);
        const usize = dv.getUint32(p + 24, true);
        const nameLen = dv.getUint16(p + 28, true);
        const extraLen = dv.getUint16(p + 30, true);
        const commentLen = dv.getUint16(p + 32, true);
        const localOff = dv.getUint32(p + 42, true);
        const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
        p += 46 + nameLen + extraLen + commentLen;
        if (flags & 1) throw new Error(`Encrypted zip entries are not supported (${name}).`);
        if (csize === 0xFFFFFFFF || usize === 0xFFFFFFFF || localOff === 0xFFFFFFFF) throw new Error("ZIP64 archives are not supported.");
        const isDir = name.endsWith("/");
        const clean = isDir ? name.slice(0, -1) : name;
        if (!isSafeRelPath(clean)) throw new Error(`Unsafe path in archive: ${JSON.stringify(name)}`);
        if (isDir) continue;
        if (seen.has(clean)) throw new Error(`Duplicate path in archive: ${clean}`);
        seen.add(clean);
        total += usize;
        if (total > lim.maxBytes) throw new Error(`The archive unpacks to more than ${formatBytes(lim.maxBytes)}.`);
        if (localOff + 30 > bytes.length || dv.getUint32(localOff, true) !== 0x04034b50) throw new Error(`Corrupt zip (bad local header for ${clean}).`);
        const start = localOff + 30 + dv.getUint16(localOff + 26, true) + dv.getUint16(localOff + 28, true);
        if (start + csize > bytes.length) throw new Error(`Corrupt zip (data out of range for ${clean}).`);
        const comp = bytes.subarray(start, start + csize);
        let data;
        if (method === 0) data = comp.slice();
        else if (method === 8) data = await streamThrough(comp, new DecompressionStream("deflate-raw"), usize);
        else throw new Error(`Unsupported compression method ${method} (${clean}).`);
        if (data.length !== usize) throw new Error(`Size mismatch in ${clean}.`);
        if (crc32(data) !== crc) throw new Error(`CRC mismatch in ${clean}: the archive is corrupt.`);
        out.push({ path: clean, data });
    }
    return out;
}

// Strip runtime-only fields (leading underscore) so they never reach an export.
function cleanForExport(value) {
    return JSON.parse(JSON.stringify(value, (k, v) => (k.startsWith("_") ? undefined : v)));
}

// A human-readable log, for reading a session without the app (DESIGN §3.1).
function transcriptMarkdown(session) {
    const s = session || {};
    const block = (lang, body) => { const f = makeFence(body); return `${f}${lang}\n${String(body).replace(/\n$/, "")}\n${f}`; };
    const md = [`# HermitUI Agent session`, ``, `- Created: ${s.createdAt || "?"}`, `- Model: ${(s.settings && s.settings.model) || "?"}`, ``];
    for (const item of s.timeline || []) {
        if (item.type === "task") md.push(`## Task`, ``, item.text, ``);
        else if (item.type === "user") md.push(`## ${item.kind === "answer" ? "User answer" : item.kind === "followup" ? "Follow-up" : "User note"}`, ``, item.text, ``);
        else if (item.type === "note") md.push(`> ${String(item.text).replace(/\n/g, "\n> ")}`, ``);
        else if (item.type === "error") md.push(`> **Error:** ${item.text}`, ``);
        else if (item.type === "compaction") md.push(`## History compacted — steps ${item.fromStep}–${item.toStep}`, ``, `<details><summary>Summary the model continued from</summary>`, ``, item.summary || "", ``, `</details>`, ``);
        else if (item.type === "step") {
            const verdict = item.decision ? ` · ${item.decision}${item.decidedBy ? " by " + item.decidedBy : ""}` : "";
            md.push(`## Step ${item.n} — ${item.kind}${item.status ? " · " + item.status : ""}${verdict}${item.protocol === "tools" ? " · tool call" : ""}`, ``);
            if (item.retryNote) md.push(`> ${item.retryNote}`, ``);
            if (item.reasoning) md.push(`<details><summary>Reasoning</summary>`, ``, block("text", item.reasoning), ``, `</details>`, ``);
            if (item.kind === "final") md.push(item.content || "", ``);
            else if (item.kind === "ask") md.push(`**Question:** ${item.question || ""}`, ``);
            else {
                if (item.prose) md.push(item.prose, ``);
                if (item.proposedCode) md.push(block("python", item.proposedCode), ``);
                for (const a of item.fileActions || []) {
                    md.push(`- \`${a.tool}\` ${a.path}: ${a.ok ? "" : "failed: "}${a.message}`);
                    for (const e of a.edits || []) md.push(``, block("text", e.old), ``, `replaced by`, ``, block("text", e.new));
                }
                if ((item.fileActions || []).length) md.push(``);
                if (item.edited && item.ranCode) md.push(`Edited by the user before it ran:`, ``, block("python", item.ranCode), ``);
                if (item.output) md.push(`Output:`, ``, block("text", item.output), ``);
                if (item.changes) md.push(`Files changed: ${formatChanges(item.changes)}`, ``);
                if ((item.figures || []).length) md.push(`Figures shown: ${item.figures.map(f => `${f.path} (${f.width}×${f.height} px)`).join(", ")}`, ``);
                if (item.fileListSent) md.push(`The current file list (${item.fileListSent} files) was sent with this step.`, ``);
                if (item.risk && item.risk.reasons && item.risk.reasons.length) md.push(`Held because it ${item.risk.reasons.join("; ")}.`, ``);
                if (item.rejectReason) md.push(`Rejection reason: ${item.rejectReason}`, ``);
                for (const line of item.skippedCalls || []) md.push(`- Tool call not run: ${line}`);
                if ((item.skippedCalls || []).length) md.push(``);
            }
        }
    }
    return md.join("\n");
}

// state: { session, files: Map(path -> { hash, origin }), blobs: Map(hash -> bytes),
// checkpoints: [{ timelineLength, msgCount, stepCount, epoch, label, files: { path: { hash, origin } } } | null] }
// Returns zip entries (DESIGN §3.1). Checkpoint blobs already in workspace/ aren't repeated.
function buildSessionArchive(state, opts) {
    const o = opts || {};
    const enc = new TextEncoder();
    const json = (v) => enc.encode(JSON.stringify(v, null, 1));
    const session = cleanForExport(state.session);
    session.origins = {};
    for (const [p, f] of state.files) session.origins[p] = f.origin;
    const entries = [
        { path: "manifest.json", data: json({ format: SESSION_FORMAT, formatVersion: SESSION_FORMAT_VERSION, appVersion: APP_VERSION, createdAt: o.now || new Date().toISOString() }) },
        { path: "session.json", data: json(session) },
        { path: "transcript.md", data: enc.encode(transcriptMarkdown(session)) },
    ];
    const inWorkspace = new Set();
    for (const [p, f] of [...state.files].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        const bytes = state.blobs.get(f.hash);
        if (!bytes) throw new Error(`Missing file content for ${p}`);
        entries.push({ path: "workspace/" + p, data: bytes });
        inWorkspace.add(f.hash);
    }
    if (o.includeCheckpoints && state.checkpoints && state.checkpoints.length) {
        // Checkpoints dropped to save memory stay null, so timeline links keep their index.
        entries.push({ path: "checkpoints/index.json", data: json(state.checkpoints.map(cp => (cp ? cleanForExport(cp) : null))) });
        const written = new Set();
        for (const cp of state.checkpoints) {
            if (!cp) continue;
            for (const f of Object.values(cp.files)) {
                if (inWorkspace.has(f.hash) || written.has(f.hash)) continue;
                const bytes = state.blobs.get(f.hash);
                if (!bytes) throw new Error(`Missing checkpoint content ${f.hash}`);
                entries.push({ path: "checkpoints/blobs/" + f.hash, data: bytes });
                written.add(f.hash);
            }
        }
    }
    return entries;
}

function validateManifest(m) {
    if (!m || typeof m !== "object" || m.format !== SESSION_FORMAT) throw new Error("This is not a HermitUI Agent session (manifest.json is missing or has the wrong format id).");
    if (!Number.isInteger(m.formatVersion) || m.formatVersion < 1) throw new Error("manifest.json has no valid formatVersion.");
    if (m.formatVersion > SESSION_FORMAT_VERSION) throw new Error(`This session was made with a newer HermitUI Agent (format ${m.formatVersion}; this version reads up to ${SESSION_FORMAT_VERSION}).`);
    return m;
}

// DESIGN §3.3: validate session.json against the expected shape. Unknown fields are
// ignored, missing required ones fail loudly, and every kept field is coerced to its
// type, so nothing imported can carry markup or functions into the app.
function validateSession(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("session.json is not an object.");
    const str = (v) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
    const num = (v, d) => (Number.isFinite(v) ? v : d);
    const strArr = (v) => (Array.isArray(v) ? v.filter(x => typeof x === "string") : []);
    if (typeof raw.task !== "string") throw new Error("session.json: 'task' is missing.");
    if (!Array.isArray(raw.messages)) throw new Error("session.json: 'messages' is missing.");
    if (!Array.isArray(raw.timeline)) throw new Error("session.json: 'timeline' is missing.");
    // Native tool calls (format 2): an assistant message may carry tool_calls, and a
    // "tool" message answers one by its id. Only the fields the API takes are kept.
    const msgList = (arr, where) => arr.map((m, i) => {
        const bad = () => new Error(`session.json: ${where} ${i} is malformed.`);
        if (!m || !["system", "user", "assistant", "tool"].includes(m.role) || typeof m.content !== "string") throw bad();
        const out = { role: m.role, content: m.content };
        if (m.role === "tool") {
            if (typeof m.tool_call_id !== "string" || !m.tool_call_id) throw bad();
            out.tool_call_id = m.tool_call_id;
        }
        if (m.role === "assistant" && m.tool_calls !== undefined) {
            if (!Array.isArray(m.tool_calls)) throw bad();
            out.tool_calls = m.tool_calls.map(c => {
                if (!c || typeof c.id !== "string" || !c.id || !c.function || typeof c.function.name !== "string" || typeof c.function.arguments !== "string") throw bad();
                return { id: c.id, type: "function", function: { name: c.function.name, arguments: c.function.arguments } };
            });
        }
        return out;
    });
    const messages = msgList(raw.messages, "message");
    if (raw.compactions !== undefined && !Array.isArray(raw.compactions)) throw new Error("session.json: 'compactions' is not a list.");
    const compactions = (raw.compactions || []).map((c, i) => {
        if (!c || !Array.isArray(c.before) || !Number.isInteger(c.fromStep) || !Number.isInteger(c.toStep) || c.fromStep < 1 || c.toStep < c.fromStep) throw new Error(`session.json: compaction ${i} is malformed.`);
        return { before: msgList(c.before, `compaction ${i} message`), fromStep: c.fromStep, toStep: c.toStep };
    });
    const fileList = (v, withPrev) => (Array.isArray(v) ? v : []).filter(x => x && isSafeRelPath(x.path)).map(x => {
        const r = { path: x.path, hash: /^[0-9a-f]{64}$/.test(x.hash) ? x.hash : "", size: num(x.size, 0) };
        if (withPrev) r.prevHash = /^[0-9a-f]{64}$/.test(x.prevHash) ? x.prevHash : "";
        return r;
    });
    const STEP_STRINGS = ["kind", "phase", "reasoning", "content", "prose", "question", "proposedCode", "ranCode", "output", "status", "decision", "decidedBy", "rejectReason", "finishReason", "startedAt", "endedAt", "retryNote", "protocol"];
    const timeline = raw.timeline.map((it, i) => {
        if (!it || typeof it !== "object") throw new Error(`session.json: timeline item ${i} is malformed.`);
        const ts = str(it.ts);
        switch (it.type) {
            case "task": return { type: "task", text: str(it.text), files: strArr(it.files), ts, checkpoint: Number.isInteger(it.checkpoint) ? it.checkpoint : undefined };
            case "user": return { type: "user", text: str(it.text), kind: ["guidance", "answer", "followup"].includes(it.kind) ? it.kind : "guidance", ts };
            case "note": return { type: "note", text: str(it.text), tone: ["info", "warn", "error"].includes(it.tone) ? it.tone : "info", ts };
            case "error": return { type: "error", text: str(it.text), hint: str(it.hint), ts };
            case "compaction": return { type: "compaction", reason: ["overflow", "context", "manual"].includes(it.reason) ? it.reason : "threshold", fromStep: num(it.fromStep, 0), toStep: num(it.toStep, 0), summary: str(it.summary), tokensBefore: num(it.tokensBefore, 0), tokensAfter: num(it.tokensAfter, 0), ts };
            case "step": {
                const s = { type: "step", n: num(it.n, 0), ts, checkpoint: Number.isInteger(it.checkpoint) ? it.checkpoint : undefined };
                for (const k of STEP_STRINGS) s[k] = str(it[k]);
                s.edited = it.edited === true;
                s.notes = strArr(it.notes);
                s.netAttempts = strArr(it.netAttempts);
                s.skippedCalls = strArr(it.skippedCalls);
                s.blockCount = num(it.blockCount, 0);
                s.changes = it.changes && typeof it.changes === "object"
                    ? { added: fileList(it.changes.added), modified: fileList(it.changes.modified, true), deleted: fileList(it.changes.deleted, true) }
                    : null;
                s.risk = it.risk && typeof it.risk === "object" ? { verdict: str(it.risk.verdict), reasons: strArr(it.risk.reasons) } : null;
                s.stats = cleanStepStats(it.stats);
                const dim = (v) => (Number.isInteger(v) && v > 0 && v <= 100000 ? v : 0);
                s.figures = (Array.isArray(it.figures) ? it.figures : []).filter(f => f && typeof f === "object" && isSafeRelPath(f.path)).slice(0, 500)
                    .map(f => ({ path: f.path, width: dim(f.width), height: dim(f.height), how: f.how === "show" ? "show" : "end" }));
                s.fileListSent = Number.isInteger(it.fileListSent) && it.fileListSent > 0 ? it.fileListSent : 0;
                if (Array.isArray(it.fileActions)) {
                    s.fileActions = it.fileActions.filter(a => a && typeof a === "object" && FILE_TOOLS.includes(a.tool)).map(a => {
                        const r = { tool: a.tool, path: str(a.path), ok: a.ok === true, message: str(a.message) };
                        if (Number.isInteger(a.startLine)) r.startLine = a.startLine;
                        if (Number.isInteger(a.endLine)) r.endLine = a.endLine;
                        if (Array.isArray(a.edits)) r.edits = a.edits.filter(e => e && typeof e === "object").map(e => ({ old: str(e.old), new: str(e.new) }));
                        return r;
                    });
                }
                // Nothing restores mid-flight: a step that was waiting or running when the
                // session was exported is shown as interrupted.
                if (s.phase && s.phase !== "done") { s.phase = "done"; s.status = s.status || "interrupted"; }
                return s;
            }
            default: throw new Error(`session.json: timeline item ${i} has unknown type ${JSON.stringify(it.type)}.`);
        }
    });
    const st = raw.settings && typeof raw.settings === "object" ? raw.settings : {};
    const origins = {};
    if (raw.origins && typeof raw.origins === "object") {
        for (const [p, o] of Object.entries(raw.origins)) if (isSafeRelPath(p) && (o === "user" || o === "agent")) origins[p] = o;
    }
    return {
        task: raw.task,
        createdAt: str(raw.createdAt),
        status: str(raw.status) || "paused",
        // Which system prompt messages[0] holds (format 1 had code-as-action only).
        protocol: raw.protocol === "tools" ? "tools" : "text",
        messages,
        compactions,
        timeline,
        origins,
        stepCount: num(raw.stepCount, timeline.filter(t => t.type === "step").length),
        tokens: { prompt: num(raw.tokens && raw.tokens.prompt, 0), completion: num(raw.tokens && raw.tokens.completion, 0) },
        activeMs: num(raw.activeMs, 0),
        settings: {
            apiUrl: str(st.apiUrl), model: str(st.model),
            autonomy: ["approve", "risk", "autopilot"].includes(st.autonomy) ? st.autonomy : "risk",
            stepLimit: num(st.stepLimit, 20), stepTimeoutSec: num(st.stepTimeoutSec, 60),
            maxTokens: num(st.maxTokens, 8192), effort: ["off", "low", "medium", "high", "default"].includes(st.effort) ? st.effort : "low",
            autoCompactPct: Math.min(95, Math.max(0, num(st.autoCompactPct, 85))), contextSize: Math.max(0, num(st.contextSize, 0)),
            toolMode: ["auto", "native", "text"].includes(st.toolMode) ? st.toolMode : "auto",
        },
    };
}

// The reverse of buildSessionArchive. entries come from zipRead (already path-checked).
async function parseSessionArchive(entries) {
    const byPath = new Map(entries.map(e => [e.path, e.data]));
    const dec = new TextDecoder();
    const readJson = (p) => {
        const b = byPath.get(p);
        if (!b) return undefined;
        try { return JSON.parse(dec.decode(b)); } catch (e) { throw new Error(`${p} is not valid JSON.`); }
    };
    validateManifest(readJson("manifest.json"));
    const rawSession = readJson("session.json");
    if (rawSession === undefined) throw new Error("The archive has no session.json.");
    const session = validateSession(rawSession);
    const files = new Map(), blobs = new Map();
    let total = 0;
    for (const [p, data] of byPath) {
        if (!p.startsWith("workspace/")) continue;
        const rel = p.slice("workspace/".length);
        if (!isSafeRelPath(rel)) throw new Error(`Unsafe workspace path: ${rel}`);
        total += data.length;
        const hash = await sha256Hex(data);
        blobs.set(hash, data);
        files.set(rel, { hash, origin: session.origins[rel] || "user" });
    }
    if (files.size > LIMITS.maxFiles) throw new Error(`The workspace has ${files.size} files (limit ${LIMITS.maxFiles}).`);
    if (total > LIMITS.maxWorkspaceBytes) throw new Error(`The workspace is larger than ${formatBytes(LIMITS.maxWorkspaceBytes)}.`);
    for (const [p, data] of byPath) {
        if (!p.startsWith("checkpoints/blobs/")) continue;
        const name = p.slice("checkpoints/blobs/".length);
        const hash = await sha256Hex(data);
        if (hash !== name) throw new Error(`Checkpoint blob ${name} does not match its content.`);
        blobs.set(hash, data);
    }
    let checkpoints = [];
    const rawCps = readJson("checkpoints/index.json");
    if (rawCps !== undefined) {
        if (!Array.isArray(rawCps)) throw new Error("checkpoints/index.json is not a list.");
        checkpoints = rawCps.map((cp, i) => {
            if (cp === null) return null;   // dropped to save memory
            const bad = (why) => new Error(`checkpoints/index.json: entry ${i} ${why}.`);
            if (!cp || typeof cp !== "object" || !cp.files || typeof cp.files !== "object") throw bad("is malformed");
            const ints = ["timelineLength", "msgCount", "stepCount"];
            for (const k of ints) if (!Number.isInteger(cp[k]) || cp[k] < 0) throw bad(`has no valid ${k}`);
            // epoch: how many compactions had happened (absent in exports from before them).
            const epoch = cp.epoch === undefined ? session.compactions.length : cp.epoch;
            if (!Number.isInteger(epoch) || epoch < 0 || epoch > session.compactions.length) throw bad("has no valid epoch");
            const histLen = epoch < session.compactions.length ? session.compactions[epoch].before.length : session.messages.length;
            if (cp.timelineLength > session.timeline.length || cp.msgCount > histLen) throw bad("points past the end of the session");
            const out = {};
            for (const [p, f] of Object.entries(cp.files)) {
                if (!isSafeRelPath(p) || !f || !/^[0-9a-f]{64}$/.test(f.hash) || !["user", "agent"].includes(f.origin)) throw bad(`has a bad file entry ${JSON.stringify(p)}`);
                if (!blobs.has(f.hash)) throw bad(`references missing content for ${p}`);
                out[p] = { hash: f.hash, origin: f.origin };
            }
            return { timelineLength: cp.timelineLength, msgCount: cp.msgCount, stepCount: cp.stepCount, epoch, label: typeof cp.label === "string" ? cp.label : "", files: out };
        });
    }
    return { session, files, blobs, checkpoints };
}

// The files a zip contributes to the workspace (DESIGN §4.4): a session export only its
// workspace/ folder, any other zip all of its files. OS archive junk (__MACOSX/,
// .DS_Store, Thumbs.db, desktop.ini) is skipped. The entries come from zipRead, so their
// paths are already safe. Returns { files: [{ path, data }], fromSession }.
function workspaceEntriesFromZip(entries) {
    const manifest = entries.find(e => e.path === "manifest.json");
    let fromSession = false;
    if (manifest) {
        try { fromSession = JSON.parse(new TextDecoder().decode(manifest.data)).format === SESSION_FORMAT; } catch (e) { fromSession = false; }
    }
    const isJunk = (p) => p.split("/")[0] === "__MACOSX" || /^(\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(p.split("/").pop());
    const files = [];
    for (const e of entries) {
        let p = e.path;
        if (fromSession) {
            if (!p.startsWith("workspace/")) continue;
            p = p.slice("workspace/".length);
        }
        if (p && !isJunk(p)) files.push({ path: p, data: e.data });
    }
    return { files, fromSession };
}

// ========== 5. Python worker client ==========
// The main thread owns the canonical workspace; the worker is disposable (DESIGN §4.1).
const PY = {
    worker: null, gen: 0, seq: 0, pending: new Map(), state: "off",
    corePromise: null, readyPromise: null, info: null, syncedVersion: -1,
};
// What Pyodide can load (from its lock file): import names for the system prompt, and
// import name -> package for the "loading …" notice before a step runs.
const PKG = { names: [], byImport: new Map(), loading: [] };

// The Pyodide core: inlined by build.py (gzip + base64), or fetched from the pinned
// CDN when running the unbuilt source.
function loadPyodideCore() {
    if (!PY.corePromise) {
        PY.corePromise = (async () => {
            const names = { loaderJs: "pyodide.js", asmJs: "pyodide.asm.js", wasm: "pyodide.asm.wasm", stdlib: "python_stdlib.zip", lock: "pyodide-lock.json" };
            const inl = window.__PYODIDE_INLINE__;
            const core = {};
            for (const [key, file] of Object.entries(names)) {
                let bytes;
                if (inl) bytes = await gunzipToBytes(inl[file]);
                else {
                    const res = await fetch(PYODIDE_CDN + file);
                    if (!res.ok) throw new Error(`Couldn't download ${file} from the Pyodide CDN (${res.status}).`);
                    bytes = new Uint8Array(await res.arrayBuffer());
                }
                core[key] = key === "loaderJs" || key === "asmJs" ? new TextDecoder().decode(bytes) : bytes.buffer;
            }
            try {
                const lock = JSON.parse(new TextDecoder().decode(core.lock));
                const bundled = Object.values(BUNDLED_LIBRARIES).map(l => l.imports[0]);
                PKG.names = [...new Set([...packageImportNames(lock), ...bundled])].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
                PKG.byImport = importPackageIndex(lock);
            } catch (e) { console.error("pyodide-lock.json unreadable:", e); }
            return core;
        })();
        PY.corePromise.catch(() => { PY.corePromise = null; });
    }
    return PY.corePromise;
}

// A bundled wheel's bytes: inlined by build.py (base64), or fetched from PyPI when running
// the unbuilt source. Either way checked against its sha256 pin in BUNDLED_LIBRARIES, and
// kept for the page's life: a restarted worker gets them again from here.
const WHEELS = new Map();   // file name -> Promise<Uint8Array>
function loadBundledWheel(w) {
    if (!WHEELS.has(w.file)) {
        const p = (async () => {
            const inl = window.__HERMIT_WHEELS__;
            let bytes;
            if (inl) {
                if (typeof inl[w.file] !== "string") throw new Error(`${w.file} is missing from this build.`);
                bytes = Uint8Array.from(atob(inl[w.file]), (c) => c.charCodeAt(0));
            } else {
                const res = await fetch(w.url);
                if (!res.ok) throw new Error(`couldn't download ${w.file} from PyPI (${res.status}).`);
                bytes = new Uint8Array(await res.arrayBuffer());
            }
            if (await sha256Hex(bytes) !== w.sha256) throw new Error(`${w.file} doesn't match its pinned sha256.`);
            return bytes;
        })();
        p.catch(() => WHEELS.delete(w.file));
        WHEELS.set(w.file, p);
    }
    return WHEELS.get(w.file);
}

function rejectAllPending(reason) {
    for (const p of PY.pending.values()) { clearTimeout(p.timer); p.reject(new Error(reason)); }
    PY.pending.clear();
}

function startWorker() {
    const src = "(" + hermitWorkerMain.toString() + ")();";
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    const w = new Worker(url);   // classic on purpose, see worker.js
    URL.revokeObjectURL(url);
    const gen = PY.gen;
    w.onmessage = (e) => {
        if (gen !== PY.gen) return;
        const d = e.data;
        // Untrusted: agent code can post from inside the worker. Only well-formed
        // answers to a pending request are accepted; everything else is dropped.
        if (!d || typeof d !== "object" || !Number.isInteger(d.id) || typeof d.ok !== "boolean") return;
        const p = PY.pending.get(d.id);
        if (!p) return;
        PY.pending.delete(d.id);
        clearTimeout(p.timer);
        if (d.ok) p.resolve(d.result);
        else p.reject(new Error(typeof d.error === "string" ? d.error.slice(0, 2000) : "worker error"));
    };
    // An error from a worker that is being killed is expected; don't let it surface as
    // an uncaught page error.
    w.onerror = (e) => { e.preventDefault(); if (gen === PY.gen) console.error("worker error:", e.message); };
    return w;
}

function workerCall(op, payload, timeoutMs) {
    const w = PY.worker;
    if (!w) return Promise.reject(new Error("interpreter not running"));
    const id = ++PY.seq;
    return new Promise((resolve, reject) => {
        const timer = timeoutMs ? setTimeout(() => {
            if (PY.pending.delete(id)) reject(new Error("timeout"));
        }, timeoutMs) : null;
        PY.pending.set(id, { resolve, reject, timer });
        w.postMessage({ id, op, ...payload });
    });
}

function setInterpreterState(state) {
    if (PY.state !== state && typeof debugLog === "function") debugLog("interp", "python interpreter: " + state + (state === "idle" && PY.info && PY.info.bootMs && PY.state === "booting" ? ` (booted in ${PY.info.bootMs} ms)` : ""));
    PY.state = state;
    if (typeof renderStatusBar === "function") renderStatusBar();
}

// Boot a fresh worker and seed it with the canonical workspace. Any earlier worker is
// terminated; a newer restart supersedes this one (generation counter).
function restartInterpreter() {
    PY.gen++;
    const gen = PY.gen;
    if (PY.worker) PY.worker.terminate();
    PY.worker = null;
    rejectAllPending("killed");
    setInterpreterState("booting");
    PY.readyPromise = (async () => {
        const core = await loadPyodideCore();
        if (gen !== PY.gen) throw new Error("superseded");
        PY.worker = startWorker();
        const info = await workerCall("boot", { core, packageBaseUrl: PYODIDE_CDN }, LIMITS.bootTimeoutMs);
        if (gen !== PY.gen) throw new Error("superseded");
        PY.info = info && typeof info === "object" ? { bootMs: Number(info.bootMs) || 0, pyVersion: String(info.pyVersion || "").slice(0, 20) } : null;
        PY.syncedVersion = -1;
        await syncWorkspaceToWorker();
        setInterpreterState("idle");
    })();
    PY.readyPromise.catch((e) => {
        if (gen !== PY.gen) return;
        setInterpreterState("failed");
        console.error("interpreter boot failed:", e);
        if (typeof addTimelineItem === "function" && e.message !== "killed") {
            showToast("❌ The Python interpreter failed to start: " + e.message, { error: true });
        }
    });
    return PY.readyPromise;
}

async function ensureInterpreter() {
    if (!PY.readyPromise || PY.state === "failed") restartInterpreter();
    for (;;) {
        const p = PY.readyPromise;
        try { await p; } catch (e) { if (p === PY.readyPromise) throw e; }
        if (p === PY.readyPromise) return;   // a restart during the wait: wait for that one
    }
}

// Re-seed the worker when the canonical workspace changed behind its back (uploads,
// rewind, import). Steps keep both in sync themselves.
async function syncWorkspaceToWorker() {
    if (PY.syncedVersion === WS.version) return;
    const files = {};
    for (const [p, f] of WS.files) files[p] = WS.blobs.get(f.hash);
    const version = WS.version;
    await workerCall("seed", { files }, 60000);
    PY.syncedVersion = version;
}

// Validate a run result from the worker; throws on anything malformed.
function validateRunResult(r) {
    const bad = (why) => { throw new Error("The worker sent an invalid result (" + why + ")."); };
    if (!r || typeof r !== "object") bad("not an object");
    if (r.status !== "ok" && r.status !== "error") bad("status");
    if (typeof r.output !== "string" || r.output.length > 3 * 1024 * 1024) bad("output");
    if (!Array.isArray(r.notes) || r.notes.length > 500 || !r.notes.every(n => typeof n === "string")) bad("notes");
    if (!Array.isArray(r.netAttempts) || r.netAttempts.length > 50 || !r.netAttempts.every(n => typeof n === "string")) bad("netAttempts");
    if (!r.listing || typeof r.listing !== "object") bad("listing");
    const paths = Object.keys(r.listing);
    if (paths.length > LIMITS.maxFiles * 2) bad("too many files");
    for (const p of paths) {
        if (!isSafeRelPath(p)) bad("unsafe path " + JSON.stringify(p).slice(0, 80));
        if (!/^[0-9a-f]{64}$/.test(r.listing[p])) bad("hash");
    }
    if (!r.files || typeof r.files !== "object") bad("files");
    for (const [p, b] of Object.entries(r.files)) {
        if (!(p in r.listing) || !(b instanceof Uint8Array)) bad("file bytes");
    }
    // Captured figures: only ones that exist after the step are kept (a step may delete
    // what plt.show() saved earlier in it).
    if (r.figures === undefined) r.figures = [];
    if (!Array.isArray(r.figures) || r.figures.length > 500) bad("figures");
    const dim = (v) => (Number.isInteger(v) && v > 0 && v <= 100000 ? v : 0);
    r.figures = r.figures.filter(f => f && typeof f === "object" && isSafeRelPath(f.path) && f.path in r.listing)
        .map(f => ({ path: f.path, width: dim(f.width), height: dim(f.height), how: f.how === "show" ? "show" : "end" }));
    return r;
}

const PKG_NAME = /^[A-Za-z0-9_.-]{1,100}$/;

// The packages a step needs that aren't loaded yet, from the imports in its code and in
// the workspace .py files it uses (referencedPythonFiles). Returns { packages, imports,
// pyodide, bundles }: imports holds one import name per Pyodide package, for the load op;
// bundles the bundled libraries to install, pyodide the Pyodide packages those import
// (planBundledLoad); packages names all of it, for the status bar.
async function packagesToLoad(code) {
    const read = (p) => { const f = WS.files.get(p); return f ? decodeTextFile(WS.blobs.get(f.hash)) : null; };
    const files = referencedPythonFiles(code, [...WS.files.keys()], read);
    const list = (v) => (Array.isArray(v) ? v.filter(x => typeof x === "string" && PKG_NAME.test(x)).slice(0, 500) : []);
    const texts = [code, ...files.map(read)];
    const packages = [], imports = [], all = [];
    let loaded = new Set();
    for (const text of texts) {
        const r = await workerCall("imports", { code: text }, 30000);
        loaded = new Set(list(r && r.loaded));
        for (const i of list(r && r.imports)) {
            if (!all.includes(i)) all.push(i);
            const p = PKG.byImport.get(i);
            if (p && !loaded.has(p) && !packages.includes(p) && /^[A-Za-z_]\w*$/.test(i)) { packages.push(p); imports.push(i); }
        }
    }
    const { bundles, pyodide } = planBundledLoad(all, texts, BUNDLED_LIBRARIES, [...loaded, ...packages]);
    if (files.length && (packages.length || bundles.length)) debugLog("tool", `imports read from the step's code and ${files.join(", ")}`);
    return { packages: [...packages, ...pyodide, ...bundles], imports, pyodide, bundles };
}

function validateLoadResult(r) {
    const strs = (v, max, len) => (Array.isArray(v) ? v.filter(x => typeof x === "string").slice(0, max).map(x => x.slice(0, len)) : []);
    if (!r || typeof r !== "object") throw new Error("The worker sent an invalid result (load).");
    return { loaded: strs(r.loaded, 200, 100), installed: strs(r.installed, 50, 100), failed: strs(r.failed, 200, 100), errors: strs(r.errors, 20, 500), netAttempts: strs(r.netAttempts, 50, 300), ms: Number.isFinite(r.ms) ? r.ms : 0 };
}

// Run one step. Returns the validated result, or { status: "timeout" | "killed" |
// "crashed" } after which the interpreter has been restarted from the canonical
// workspace — i.e. the step's effects are already rolled back. The packages the code
// imports are loaded first (DESIGN §8), with their own time limit; if one fails, the
// code doesn't run and the result says why.
async function runInWorker(code, opts) {
    const o = opts || {};
    await ensureInterpreter();
    await syncWorkspaceToWorker();
    setInterpreterState("running");
    const gen = PY.gen;
    let phase = "packages", pkgNotes = [], pkgAttempts = [];
    try {
        const { packages: need, imports: needImports, pyodide, bundles } = await packagesToLoad(code);
        if (need.length) {
            PKG.loading = need;
            if (typeof setActivity === "function" && RUN.active) setActivity("packages");
            debugLog("tool", `loading packages: ${need.join(", ")}`);
            const listing = () => { const l = {}; for (const [p, f] of WS.files) l[p] = f.hash; return l; };
            let wheels = [];
            try {
                wheels = await Promise.all(bundles.map(async (name) => ({
                    name, files: await Promise.all(BUNDLED_LIBRARIES[name].wheels.map(async (w) => ({ file: w.file, bytes: await loadBundledWheel(w) }))),
                })));
            } catch (e) {
                // Only the unbuilt source downloads wheels; a build that lacks one is broken.
                PKG.loading = [];
                setInterpreterState("idle");
                const msg = `Couldn't load ${bundles.join(", ")}: ${e.message} Nothing ran. The standard library and packages that loaded earlier still work.`;
                debugLog("error", "bundled library failed: " + e.message);
                return { status: "error", output: msg, notes: [], netAttempts: [], listing: listing(), files: {}, figures: [], packageError: true };
            }
            // The load op reads imports from code: give it one line per needed package, which
            // also covers packages that only the step's workspace modules import. The bundled
            // libraries' own Pyodide packages go by name, their wheels as bytes (copied: the
            // cache keeps the originals for the next worker).
            const lr = validateLoadResult(await workerCall("load", { code: needImports.map(i => "import " + i).join("\n"), packages: pyodide, wheels }, LIMITS.packageTimeoutMs));
            PKG.loading = [];
            pkgAttempts = lr.netAttempts;
            if (lr.failed.length) {
                const msg = packageFailureMessage(lr, typeof navigator !== "undefined" ? navigator.onLine : true, PYODIDE_CDN);
                debugLog("error", "package load failed: " + lr.failed.join(", "), lr.errors.join("\n"));
                setInterpreterState("idle");
                return { status: "error", output: msg, notes: [], netAttempts: lr.netAttempts, listing: listing(), files: {}, figures: [], packageError: true };
            }
            const note = packageLoadNote(lr);
            if (note) {
                pkgNotes = [note];
                debugLog("result", note);
            }
            if (typeof setActivity === "function" && RUN.active) setActivity("python");
        }
        phase = "run";
        const r = validateRunResult(await workerCall("run", { code, allowNetwork: !!o.allowNetwork, step: o.step }, o.timeoutMs));
        r.output = rewritePyodideInstallAdvice(r.output);
        r.notes = [...pkgNotes, ...r.notes];
        r.netAttempts = [...pkgAttempts, ...r.netAttempts];
        setInterpreterState("idle");
        return r;
    } catch (e) {
        PKG.loading = [];
        const status = e.message === "timeout" ? "timeout" : e.message === "killed" ? "killed" : "crashed";
        if (gen === PY.gen) restartInterpreter();
        const output = status === "crashed" ? e.message
            : phase === "packages" && status === "timeout" ? `Loading the packages this code imports took longer than ${Math.round(LIMITS.packageTimeoutMs / 1000)} s, so it was stopped. The package CDN may be slow or unreachable.`
            : "";
        return { status, output, notes: [], netAttempts: [], listing: null, files: {}, figures: [], packagePhase: phase === "packages" };
    }
}

// ========== 6. LLM streaming (adapted from HermitUI's fetchAndStreamChat) ==========
// Streams one chat completion. onDelta(reasoning, content, toolCalls) fires per chunk.
// Resolves to { finishReason, usage, rawUsage, timings, clock, toolCalls }; rejects on
// HTTP/network errors and AbortError. rawUsage/timings are the server's own objects
// (timings: llama.cpp only), clock holds performance.now() stamps for the request, first
// token and end. toolCalls: [{ id, name, arguments }], assembled from the streamed
// deltas (DESIGN §5.6). A refusal because of `tools` carries .toolsRejected.
async function streamChat(payload, signal, onDelta) {
    let promptTokens = 0, completionTokens = 0, finishReason = null, sawStreamData = false, sawEvent = false, sawDone = false;
    let rawUsage = null, timings = null;
    const toolCalls = [];
    const clock = { startMs: performance.now(), firstMs: 0, endMs: 0 };
    const chatUrl = apiEndpoint(SETTINGS.apiUrl, "/chat/completions");
    // A stream that goes silent mid-reply (the server hung, or the connection died without
    // a reset) is given up after LIMITS.streamStallMs, as an error worth retrying. Only
    // once data flows: before the first token, prompt processing can legitimately take
    // minutes.
    const ctrl = new AbortController();
    const forward = () => ctrl.abort();
    if (signal) { if (signal.aborted) ctrl.abort(); else signal.addEventListener("abort", forward, { once: true }); }
    let stallTimer = null, stalled = false;
    const armStall = () => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => { stalled = true; ctrl.abort(); }, LIMITS.streamStallMs);
    };
    const postChat = (body) => fetch(chatUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + (SETTINGS.apiKey || "none") },
        body: JSON.stringify(body),
        signal: ctrl.signal,
    });
    const readDetail = async (res) => {
        let detail = res.statusText || "Unknown Error";
        try { const errBody = await res.json(); detail = (errBody.error && (errBody.error.message || errBody.error)) || detail; } catch (e) { /* not JSON */ }
        return String(detail);
    };

    let response = await postChat(payload);
    let detail = response.ok ? "" : await readDetail(response);
    // A strict server can 400 purely because of the reasoning params: drop them, retry
    // once, and stop sending them for this endpoint.
    if (!response.ok && response.status === 400 && REASONING_PARAM_KEYS.some(k => k in payload) && looksLikeReasoningRejection(detail)) {
        const retry = { ...payload };
        for (const k of REASONING_PARAM_KEYS) delete retry[k];
        REASONING.rejected = true;
        showToast("🧠 This endpoint rejects reasoning settings — retrying without them");
        response = await postChat(retry);
        detail = response.ok ? "" : await readDetail(response);
    }
    if (!response.ok) {
        const err = new Error(`Server Error ${response.status}: ${detail}`);
        // Not retried: the caller switches this endpoint to code-as-action instead.
        if (payload.tools && looksLikeToolRejection(response.status, detail)) err.toolsRejected = true;
        throw err;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "", rawBody = "";
    const readUsage = (data) => {
        if (data.timings && typeof data.timings === "object") timings = data.timings;
        if (!data.usage) return;
        rawUsage = data.usage;
        promptTokens = data.usage.prompt_tokens || promptTokens;
        completionTokens = data.usage.completion_tokens || completionTokens;
    };
    const emit = (reasoning, content, calls) => {
        if (!reasoning && !content && !calls) return;
        sawStreamData = true;
        if (!clock.firstMs) clock.firstMs = performance.now();
        onDelta(reasoning || "", content || "", toolCalls);
    };
    // Tool-call deltas: the first chunk of a call carries its index, id and name, the
    // rest pieces of its arguments. Some servers repeat the id and name in every chunk,
    // or send a call whole, with its arguments as an object.
    const mergeToolCalls = (deltas) => {
        if (!Array.isArray(deltas) || !deltas.length) return false;
        for (const d of deltas) {
            if (!d || typeof d !== "object") continue;
            const f = d.function || {};
            let c = Number.isInteger(d.index) ? toolCalls.find(t => t.index === d.index)
                : d.id ? toolCalls.find(t => t.id === d.id) : toolCalls[toolCalls.length - 1];
            if (!c) { c = { index: Number.isInteger(d.index) ? d.index : toolCalls.length, id: "", name: "", arguments: "" }; toolCalls.push(c); }
            if (typeof d.id === "string" && d.id && !c.id) c.id = d.id;
            if (typeof f.name === "string" && f.name && !c.name) c.name = f.name;
            if (typeof f.arguments === "string") c.arguments += f.arguments;
            else if (f.arguments && typeof f.arguments === "object") c.arguments = JSON.stringify(f.arguments);
        }
        toolCalls.sort((a, b) => a.index - b.index);
        return true;
    };
    const raiseIfError = (data) => {
        if (!data.error) return;
        throw new Error(typeof data.error === "string" ? data.error : (data.error.message || "Unknown server error"));
    };
    const processLine = (line) => {
        if (!line.startsWith("data:")) return;
        const dataStr = line.slice(5).trim();
        if (dataStr === "[DONE]") { sawDone = sawEvent = true; return; }
        if (dataStr === "") return;
        let data;
        try { data = JSON.parse(dataStr); } catch (e) { return; }
        sawEvent = true;
        raiseIfError(data);
        const choice = data.choices && data.choices[0];
        if (choice && choice.finish_reason) finishReason = choice.finish_reason;
        readUsage(data);
        const delta = choice && choice.delta;
        emit(delta && (delta.reasoning_content || delta.reasoning || delta.thinking || ""), delta && delta.content, delta && mergeToolCalls(delta.tool_calls));
    };
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            armStall();
            const text = decoder.decode(value, { stream: true });
            if (!sawStreamData && rawBody.length < 1048576) rawBody += text;
            buffer += text;
            const lines = buffer.split("\n");
            buffer = lines.pop();
            for (const line of lines) processLine(line);
        }
        if (buffer.trim()) processLine(buffer);
    } catch (streamErr) {
        reader.cancel().catch(() => {});
        if (stalled) throw new Error(`The stream stalled: no data for ${Math.round(LIMITS.streamStallMs / 1000)} s in the middle of the reply.`);
        throw streamErr;
    } finally {
        clearTimeout(stallTimer);
        if (signal) signal.removeEventListener("abort", forward);
    }
    // A stream that just stops, with neither a finish_reason nor [DONE], was cut (the
    // server died or the connection dropped): its reply is incomplete, so it's an error
    // worth retrying rather than a reply.
    if (sawEvent && !finishReason && !sawDone) throw new Error("The stream ended before the reply finished: the connection dropped.");
    if (!sawEvent && !rawBody.trim()) throw new Error("The connection closed before the server replied.");
    // The server ignored `stream: true` and sent one JSON body.
    if (!sawStreamData) {
        const trimmed = rawBody.trim();
        let data = null;
        if (trimmed.startsWith("{")) { try { data = JSON.parse(trimmed); } catch { /* not JSON */ } }
        if (data) {
            raiseIfError(data);
            const choice = data.choices && data.choices[0];
            const msg = choice && choice.message;
            if (choice && choice.finish_reason) finishReason = choice.finish_reason;
            readUsage(data);
            if (msg) emit(msg.reasoning_content || msg.reasoning || msg.thinking || "", msg.content, mergeToolCalls(msg.tool_calls));
        }
    }
    clock.endMs = performance.now();
    return { finishReason, usage: { prompt: promptTokens, completion: completionTokens }, rawUsage, timings, clock, sawData: sawStreamData, toolCalls: toolCalls.map(c => ({ id: c.id, name: c.name, arguments: c.arguments })) };
}

// ---------- Per-step inference stats ----------
const STEP_STAT_KEYS = ["prompt", "completion", "reasoning", "cached", "ttftMs", "genMs", "totalMs", "tps", "promptTps", "ctxUsed", "ctxSize"];

// One step's stats from what the server reported plus our own clock. Server-measured
// speeds (llama.cpp `timings`) win over ours, which include network and queueing.
// usage: the raw OpenAI `usage` object; nCtx: the context size, 0 when unknown.
function buildStepStats(usage, timings, clock, nCtx) {
    const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
    const r1 = (v) => Math.round(v * 10) / 10;
    const u = usage || {}, t = timings || {}, c = clock || {};
    const prompt = n(u.prompt_tokens) || n(t.prompt_n) + n(t.cache_n);
    const completion = n(u.completion_tokens) || n(t.predicted_n);
    const ttftMs = c.firstMs ? n(c.firstMs - c.startMs) : 0;
    const genMs = c.firstMs ? n(c.endMs - c.firstMs) : 0;
    let tps = n(t.predicted_per_second), tpsSource = tps ? "server" : "";
    // The first token arrives at firstMs, so n-1 tokens fill the time after it.
    if (!tps && completion > 1 && genMs > 0) { tps = (completion - 1) / (genMs / 1000); tpsSource = "clock"; }
    return {
        prompt, completion,
        reasoning: n(u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens),
        cached: n(u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || n(t.cache_n),
        ttftMs: Math.round(ttftMs), genMs: Math.round(genMs), totalMs: Math.round(n(c.endMs - c.startMs)),
        tps: r1(tps), tpsSource, promptTps: r1(n(t.prompt_per_second)),
        ctxUsed: prompt + completion, ctxSize: n(nCtx),
    };
}

// Imported stats are untrusted: known numeric keys only, anything else dropped.
function cleanStepStats(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const out = {};
    for (const k of STEP_STAT_KEYS) out[k] = Number.isFinite(raw[k]) && raw[k] > 0 ? raw[k] : 0;
    out.tpsSource = raw.tpsSource === "server" || raw.tpsSource === "clock" ? raw.tpsSource : "";
    return out;
}

// The stat block's entries: [{ label, value, title, meter? }]. Figures the server didn't
// report are left out rather than shown as 0.
function formatStepStats(st) {
    if (!st) return [];
    const count = (v) => Math.round(v).toLocaleString("en-US");
    const secs = (ms) => {
        if (ms < 1000) return Math.round(ms) + " ms";
        if (ms < 59950) return (ms / 1000).toFixed(1) + " s";
        const s = Math.round(ms / 1000);
        return `${Math.floor(s / 60)}m ${s % 60}s`;
    };
    const out = [];
    if (st.tps) out.push({ label: "Speed", value: st.tps.toFixed(1) + " tok/s", title: st.tpsSource === "server" ? "Generation speed, measured by the server" : "Generation speed from the first streamed token to the end, by this page's clock (includes network time)" });
    if (st.ttftMs) out.push({ label: "First token", value: secs(st.ttftMs), title: "From sending the request to the first streamed token (reasoning counts): network, queueing and prompt processing" });
    if (st.completion) out.push({ label: "Output", value: count(st.completion) + " tok" + (st.reasoning ? ` · ${count(st.reasoning)} thinking` : ""), title: "Tokens the model generated in this step" + (st.reasoning ? ", of which reasoning" : "") });
    if (st.prompt) out.push({ label: "Prompt", value: count(st.prompt) + " tok" + (st.cached ? ` · ${count(st.cached)} cached` : ""), title: "Tokens sent to the model in this step" + (st.cached ? "; cached ones were reused from the server's prompt cache instead of being processed again" : "") });
    if (st.promptTps) out.push({ label: "Prompt speed", value: count(st.promptTps) + " tok/s", title: "Prompt processing speed, measured by the server (uncached tokens only)" });
    if (st.ctxUsed) {
        const e = { label: "Context", value: count(st.ctxUsed) + " tok", title: "Prompt plus output: how much of the context window this step filled. The endpoint doesn't report its context size (llama.cpp's /props does)." };
        if (st.ctxSize) {
            const frac = st.ctxUsed / st.ctxSize;
            e.value = `${count(st.ctxUsed)} / ${count(st.ctxSize)} · ${Math.round(frac * 100)}%`;
            e.title = "Prompt plus output against the server's context size: how full the context window was at the end of this step";
            e.meter = Math.min(1, frac);
        }
        out.push(e);
    }
    if (st.totalMs) out.push({ label: "Inference", value: secs(st.totalMs), title: "Wall-clock time of the whole model request" + (st.genMs ? ` (${secs(st.genMs)} after the first token)` : "") });
    return out;
}

// Reasoning support for the configured endpoint, read from llama.cpp's /props or
// Ollama's /api/show. Never probed with a throwaway completion: permissive servers
// answer 200 for parameters they ignore, so a non-error proves nothing.
// The same probe reports native tool-call support (tools: "supported" | "unsupported" |
// "unknown", toolsSource); toolsRejected: the endpoint refused a request with tools.
const REASONING = { key: "", state: "unknown", levels: ["low", "medium", "high"], rejected: false, nCtx: 0, ctxSource: "", tools: "unknown", toolsSource: "", toolsRejected: false };

// The context size an OpenAI-style model list reports for `model`, or 0: vLLM's
// max_model_len, LM Studio's loaded_context_length (in its /api/v0/models), or
// context_length / context_window (OpenRouter, Together, Groq and others). Without an
// exact id match, a list of one model counts as that model. llama.cpp's
// meta.n_ctx_train is the trained size, not the server's, so it is left alone.
function contextSizeFromModelList(data, model) {
    const m = findListedModel(data, model);
    if (!m) return 0;
    for (const k of ["max_model_len", "loaded_context_length", "context_length", "context_window"]) {
        if (Number.isFinite(m[k]) && m[k] > 0) return m[k];
    }
    return 0;
}

// Ollama's context size from /api/show: num_ctx when the model sets one, else 0 (the
// server's default then applies, which it doesn't report).
function ollamaNumCtx(show) {
    const m = String((show && show.parameters) || "").match(/^\s*num_ctx\s+(\d+)/m);
    return m ? Number(m[1]) : 0;
}

// Reasoning support plus the context size (nCtx, 0 when unknown; ctxSource names where
// it came from): llama.cpp's /props or Ollama's num_ctx, else the model list; and
// tool-call support (tools, toolsSource) from the same places.
// reached: whether any probe got an HTTP answer at all (an endpoint that is down proves
// nothing, so its result isn't cached).
async function probeReasoningSupport(url, key, model) {
    const r = await probeTemplateCaps(url, key, model);
    if (!r.nCtx || r.tools === "unknown") {
        const l = await probeModelListContext(url, key, model);
        r.reached = r.reached || l.reached;
        if (!r.nCtx) Object.assign(r, { nCtx: l.nCtx, ctxSource: l.ctxSource });
        if (r.tools === "unknown" && l.tools !== "unknown") Object.assign(r, { tools: l.tools, toolsSource: l.toolsSource });
    }
    return r;
}

async function probeModelListContext(url, key, model) {
    const headers = { "Authorization": "Bearer " + (key || "none") };
    let reached = false;
    let tools = "unknown", toolsSource = "";
    const fromList = async (listUrl, source) => {
        try {
            const res = await fetch(listUrl, { headers });
            reached = true;
            if (!res.ok) return null;
            const data = await res.json();
            if (tools === "unknown") { tools = toolSupportFromModelList(data, model); toolsSource = tools === "unknown" ? "" : source; }
            const nCtx = contextSizeFromModelList(data, model);
            return nCtx ? { nCtx, ctxSource: source } : null;
        } catch (e) { return null; }
    };
    const found = (await fromList(apiEndpoint(url, "/models"), "/v1/models"))
        || (await fromList(apiRoot(url) + "/api/v0/models", "LM Studio /api/v0/models"))
        || { nCtx: 0, ctxSource: "" };
    return { ...found, reached, tools, toolsSource };
}

async function probeTemplateCaps(url, key, model) {
    const root = apiRoot(url);
    const headers = { "Authorization": "Bearer " + (key || "none") };
    let nCtx = 0, reached = false, tools = "unknown", toolsSource = "";
    try {
        const res = await fetch(root + "/props", { headers });
        reached = true;
        if (res.ok) {
            const p = await res.json();
            const gen = p.default_generation_settings || {};
            nCtx = Number.isFinite(gen.n_ctx) && gen.n_ctx > 0 ? gen.n_ctx : Number.isFinite(p.n_ctx) && p.n_ctx > 0 ? p.n_ctx : 0;
            const ctxSource = nCtx ? "llama.cpp /props" : "";
            const caps = p.chat_template_caps;
            const t = parseReasoningTemplateSupport(p.chat_template);
            tools = toolSupportFromProps(p);
            toolsSource = tools === "unknown" ? "" : "llama.cpp /props";
            if (caps && typeof caps.supports_reasoning_effort === "boolean") {
                return { state: caps.supports_reasoning_effort || t.supported ? "supported" : "unsupported", levels: t.levels, source: "llama.cpp /props", nCtx, ctxSource, reached, tools, toolsSource };
            }
            if (typeof p.chat_template === "string") return { state: t.supported ? "supported" : "unsupported", levels: t.levels, source: "server chat template", nCtx, ctxSource, reached, tools, toolsSource };
        }
    } catch (e) { /* no /props here — try Ollama next */ }
    try {
        const res = await fetch(root + "/api/show", {
            method: "POST",
            headers: Object.assign({ "Content-Type": "application/json" }, headers),
            body: JSON.stringify({ model }),
        });
        reached = true;
        if (res.ok) {
            const show = await res.json();
            const t = parseReasoningTemplateSupport(show.template);
            const numCtx = ollamaNumCtx(show);
            const ot = toolSupportFromOllamaShow(show);
            if (ot !== "unknown") { tools = ot; toolsSource = "Ollama /api/show"; }
            return { state: t.supported ? "supported" : "unsupported", levels: t.levels, source: "Ollama /api/show", nCtx: nCtx || numCtx, ctxSource: nCtx ? "llama.cpp /props" : numCtx ? "Ollama num_ctx" : "", reached, tools, toolsSource };
        }
    } catch (e) { /* not Ollama either */ }
    return { state: "unknown", levels: ["low", "medium", "high"], source: "endpoint exposes no capability data", nCtx, ctxSource: nCtx ? "llama.cpp /props" : "", reached, tools, toolsSource };
}

async function ensureReasoningProbe() {
    const key = SETTINGS.apiUrl + "|" + SETTINGS.model;
    if (REASONING.key === key) return;
    const r = await probeReasoningSupport(SETTINGS.apiUrl, SETTINGS.apiKey, SETTINGS.model);
    // Probed while the endpoint was down: try again before the next request.
    Object.assign(REASONING, r, { key: r.reached ? key : "", rejected: false, toolsRejected: false });
    renderHeader();
}

// The protocol for the next request (DESIGN §5.6), from the setting and what the probe of
// the current endpoint found.
function currentProtocol() {
    const probed = REASONING.key === SETTINGS.apiUrl + "|" + SETTINGS.model;
    return resolveProtocol(SETTINGS.toolMode, probed ? REASONING.tools : "unknown", probed && REASONING.toolsRejected);
}

function currentReasoningParams() {
    if (SETTINGS.effort === "default" || REASONING.rejected || REASONING.state === "unsupported") return {};
    return buildReasoningParams(SETTINGS.effort, { levels: REASONING.levels });
}

// ========== 7. Session state, workspace store, checkpoints ==========
// Settings live in memory only (ephemerality rule); the API key is never exported and
// never sent to the worker.
const SETTINGS = {
    apiUrl: "http://localhost:8080/v1", apiKey: "", model: "", instructions: "",
    autonomy: "risk", stepLimit: 20, stepTimeoutSec: 60, maxTokens: 8192, effort: "low",
    // DESIGN §5.4: summarise older steps at this % of the context (0 = off), measured
    // against contextSize, or the server's n_ctx when that is 0.
    autoCompactPct: 85, contextSize: 0,
    // DESIGN §5.6: "auto" (native tool calls when the endpoint reports support), "native"
    // or "text" (code-as-action).
    toolMode: "auto",
};

// The canonical workspace (DESIGN §4.1): path -> { hash, origin }, content-addressed blobs.
const WS = { files: new Map(), blobs: new Map(), version: 0, lastChanged: new Set() };
let CHECKPOINTS = [];

function freshSession() {
    return {
        task: "", createdAt: new Date().toISOString(), status: "idle",
        messages: [], timeline: [], stepCount: 0, stepBudget: 0,
        tokens: { prompt: 0, completion: 0 }, activeMs: 0,
        // One entry per compaction: the full history it replaced, so a rewind to an
        // earlier checkpoint can restore it. A checkpoint's epoch indexes this list.
        compactions: [],
        // The protocol messages[0] (the system prompt) describes: "text" or "tools".
        protocol: "text",
    };
}
let S = freshSession();
// step: the step being worked on; activity: what it's doing right now, for the status bar.
// tokenRatio: prompt tokens per character on the last request (estimateTokens);
// overflowRetried: this turn already compacted after a context-overflow error;
// compactAfter: no threshold compaction before this step count (after a failed one);
// compactNext: the last reply ran out of context, so compact before the next request.
// retry: { n, at, error } while waiting to retry a failed request; restartTurn: abort the
// model request and ask again (⚡ Send now); lastError: why the endpoint was given up on;
// moreSteps: what ⏯ Continue at the step limit allows; listedKey: the workspace as the
// model last got its file list ("" = unknown, so the next periodic list goes out).
const RUN = { active: false, abort: null, stopRequested: false, decision: null, activeSince: 0, modelNotes: [], step: 0, activity: "", tokenRatio: 0, overflowRetried: false, compactAfter: 0, compactNext: false, retry: null, restartTurn: false, requesting: false, lastError: null, moreSteps: LIMITS.stepLimitIncrement, listedKey: "" };

function workspaceSize() {
    let total = 0;
    for (const f of WS.files.values()) total += (WS.blobs.get(f.hash) || []).length;
    return total;
}

// The workspace as the model's file lists see it: [{ path, size, hash }].
function workspaceFileList() {
    return [...WS.files].map(([p, f]) => ({ path: p, size: (WS.blobs.get(f.hash) || []).length, hash: f.hash }));
}

function snapshotFiles() {
    const out = {};
    for (const [p, f] of WS.files) out[p] = { hash: f.hash, origin: f.origin };
    return out;
}

// Which checkpoints to drop so that file versions only checkpoints hold (not the
// workspace) fit the budget: the oldest first, never the newest `keep`. Dropped entries
// are null. current: Set of the workspace's hashes; sizes: Map(hash -> bytes). Returns
// { drop: [indices], olderBytes: what older versions hold afterwards }.
function checkpointsToDrop(checkpoints, current, sizes, budget, keep) {
    const refs = new Map();
    const hashesOf = (cp) => new Set(Object.values(cp.files).map(f => f.hash));
    const live = [];
    checkpoints.forEach((cp, i) => {
        if (!cp) return;
        live.push(i);
        for (const h of hashesOf(cp)) refs.set(h, (refs.get(h) || 0) + 1);
    });
    let olderBytes = 0;
    for (const h of refs.keys()) if (!current.has(h)) olderBytes += sizes.get(h) || 0;
    const drop = [];
    for (const i of live.slice(0, Math.max(0, live.length - Math.max(1, keep)))) {
        if (olderBytes <= budget) break;
        for (const h of hashesOf(checkpoints[i])) {
            const n = refs.get(h) - 1;
            refs.set(h, n);
            if (n === 0 && !current.has(h)) olderBytes -= sizes.get(h) || 0;
        }
        drop.push(i);
    }
    return { drop, olderBytes };
}

// What checkpoints cost, for the status bar: cached until the workspace or the
// checkpoints change.
let CP_GEN = 0, cpMemoCache = null;
function checkpointMemory() {
    const key = WS.version + "|" + CHECKPOINTS.length + "|" + CP_GEN;
    if (cpMemoCache && cpMemoCache.key === key) return cpMemoCache;
    const current = new Set([...WS.files.values()].map(f => f.hash));
    const sizes = new Map([...WS.blobs].map(([h, b]) => [h, b.length]));
    const kept = CHECKPOINTS.filter(Boolean).length;
    cpMemoCache = {
        key, kept, dropped: CHECKPOINTS.length - kept,
        workspaceBytes: workspaceSize(),
        olderBytes: checkpointsToDrop(CHECKPOINTS, current, sizes, Infinity, 1).olderBytes,
    };
    return cpMemoCache;
}

// Between turns: drop the oldest checkpoints once the file versions only they hold pass
// the budget, so a long session that keeps rewriting big files can't exhaust the tab.
function enforceCheckpointBudget() {
    const current = new Set([...WS.files.values()].map(f => f.hash));
    const sizes = new Map([...WS.blobs].map(([h, b]) => [h, b.length]));
    const { drop, olderBytes } = checkpointsToDrop(CHECKPOINTS, current, sizes, LIMITS.checkpointBudgetBytes, LIMITS.checkpointKeepMin);
    if (!drop.length) return;
    const labels = drop.map(i => CHECKPOINTS[i].label);
    for (const i of drop) CHECKPOINTS[i] = null;
    CP_GEN++;
    collectGarbage();
    debugLog("result", `dropped ${drop.length} checkpoint(s): ${labels.join(", ")} · older versions now ${formatBytes(olderBytes)}`);
    addNote(`🗂️ Dropped the oldest checkpoint${drop.length === 1 ? "" : "s"} (${labels.join(", ")}) to keep older file versions under ${formatBytes(LIMITS.checkpointBudgetBytes)}. You can no longer rewind to ${drop.length === 1 ? "it" : "them"}; the timeline is unchanged.`, "warn");
    renderTimeline();
    renderStatusBar();
}

function takeCheckpoint(label) {
    const cp = { timelineLength: S.timeline.length, msgCount: S.messages.length, stepCount: S.stepCount, epoch: S.compactions.length, label, files: snapshotFiles() };
    CHECKPOINTS.push(cp);
    return CHECKPOINTS.length - 1;
}

// Only blobs the workspace or a checkpoint still references are kept.
function collectGarbage() {
    const live = new Set();
    for (const f of WS.files.values()) live.add(f.hash);
    for (const cp of CHECKPOINTS) if (cp) for (const f of Object.values(cp.files)) live.add(f.hash);
    for (const item of S.timeline) {
        if (item.type === "step" && item._held) for (const h of item._held) live.add(h);
    }
    for (const h of [...WS.blobs.keys()]) if (!live.has(h)) WS.blobs.delete(h);
    if (typeof document !== "undefined") pruneImageUrls();
}

async function addUserFiles(list) {
    const added = [], skipped = [];
    let total = workspaceSize();
    for (const { path, bytes } of list) {
        const p = normalizeUploadPath(path);
        if (!p) { skipped.push(path + " (unsafe name)"); continue; }
        if (!WS.files.has(p) && WS.files.size >= LIMITS.maxFiles) { skipped.push(p + " (too many files)"); continue; }
        // A file of the same name is replaced, so its old size doesn't count.
        const replaced = WS.files.has(p) ? (WS.blobs.get(WS.files.get(p).hash) || []).length : 0;
        if (total - replaced + bytes.length > LIMITS.maxWorkspaceBytes) { skipped.push(p + " (workspace size limit)"); continue; }
        const hash = await sha256Hex(bytes);
        WS.blobs.set(hash, bytes);
        WS.files.set(p, { hash, origin: "user" });
        total += bytes.length - replaced;
        added.push({ path: p, size: bytes.length });
    }
    if (added.length) {
        WS.version++;
        WS.lastChanged = new Set(added.map(a => a.path));
        // The model only hears about files added after the task started.
        if (S.task) RUN.modelNotes.push("The user added files to /workspace: " + added.map(a => `${a.path} (${formatBytes(a.size)})`).join(", "));
    }
    renderWorkspace();
    return { added, skipped };
}

// Why the user can't delete or replace workspace files right now, or "".
function workspaceLockReason() {
    if (PY.state === "running") return "Wait for the running step to finish before changing the workspace.";
    // A held step's effect was computed against the current files: changing them under
    // it would let its commit bring a deleted file back.
    if (RUN.decision) return "Approve or reject the held step first.";
    return "";
}

function deletedFilesNote(paths) {
    const shown = paths.slice(0, 50).join(", ");
    return "The user deleted from /workspace: " + shown + (paths.length > 50 ? ` and ${paths.length - 50} more` : "");
}

// Delete files by hand. The worker is re-seeded before the next step, and checkpoints
// keep their blobs, so a rewind still brings the files back. Returns the removed paths.
function removeWorkspacePaths(paths) {
    const removed = paths.filter(p => WS.files.has(p));
    if (!removed.length) return removed;
    for (const p of removed) WS.files.delete(p);
    WS.version++;
    WS.lastChanged = new Set();
    collectGarbage();
    if (S.task) RUN.modelNotes.push(deletedFilesNote(removed));
    renderWorkspace();
    return removed;
}

// ========== 8. Agent loop ==========
function nowIso() { return new Date().toISOString(); }

function addTimelineItem(item) {
    item.ts = item.ts || nowIso();
    S.timeline.push(item);
    renderTimelineItem(S.timeline.length - 1, true);
    renderStatusBar();
    return item;
}

function addNote(text, tone) { return addTimelineItem({ type: "note", text, tone: tone || "info" }); }

function setStatus(status) {
    S.status = status;
    renderStatusBar();
    updateComposer();
}

function setActivity(activity) {
    if (RUN.activity === activity) return;
    RUN.activity = activity;
    renderStatusBar();
}

// Queued notes offer ⚡ Send now only while the agent's own model request runs.
function setRequesting(on) {
    RUN.requesting = on;
    S.timeline.forEach((t, i) => { if (t._queued) renderTimelineItem(i); });
}

// Resolves after ms, or rejects with an AbortError when the signal fires (Stop).
function abortableSleep(ms, signal) {
    return new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(t); reject(new DOMException("Aborted", "AbortError")); };
        const t = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
        if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    });
}

// One model request, retried while the endpoint is down, restarting or overloaded, or
// the connection drops mid-reply: waits grow from LIMITS.retryFirstMs to retryMaxMs, for
// up to retryWindowMs in all. attempt(signal) makes the request; onRetry(err, n, delayMs)
// fires before each wait. Errors not worth retrying, and Stop (AbortError, also during a
// wait), are thrown at once; the last error after the window carries .retriedMs.
// RUN.abort holds the current attempt's controller, so Stop reaches it.
async function requestWithRetry(attempt, onRetry) {
    const t0 = Date.now();
    for (let n = 1; ; n++) {
        RUN.abort = new AbortController();
        const signal = RUN.abort.signal;
        try {
            return await attempt(signal);
        } catch (e) {
            if (e.name === "AbortError" || e.toolsRejected || !isRetryableError(e.message)) throw e;
            const waited = Date.now() - t0;
            const delay = retryDelayMs(n, LIMITS.retryFirstMs, LIMITS.retryMaxMs);
            if (waited + delay > LIMITS.retryWindowMs) { e.retriedMs = waited; throw e; }
            debugLog("error", `request failed (${e.message || e}) · retry ${n} in ${Math.round(delay / 1000)} s`);
            RUN.retry = { n, at: Date.now() + delay, error: String(e.message || e) };
            if (onRetry) onRetry(e, n, delay);
            renderStatusBar();
            try { await abortableSleep(delay, signal); } finally { RUN.retry = null; }
        }
    }
}

// What the model is sent: the history with older long outputs elided (DESIGN §5.4), in
// code-as-action form unless the request uses native tool calls (DESIGN §5.6).
function requestMessages(protocol) {
    const msgs = elideHistory(S.messages, LIMITS.elideKeepSteps, LIMITS.elideMinChars);
    return (protocol || currentProtocol()) === "tools" ? msgs : toolHistoryAsText(msgs);
}

// The system prompt describes one protocol: switch it when the next request uses the
// other one (the setting changed, or the endpoint refused tools). S.protocol records
// which one messages[0] holds.
function syncSystemPrompt(protocol) {
    if (S.protocol === protocol || !S.messages.length || S.messages[0].role !== "system") return;
    S.messages[0].content = buildSystemPrompt(SETTINGS.instructions, PKG.names, protocol);
    debugLog("model", `actions switched to ${protocol === "tools" ? "native tool calls" : "code blocks and tags"} (the system prompt follows)`);
    S.protocol = protocol;
}

// The result of the step that the last assistant message started: one tool message per
// call in native mode (perCall: Map(id -> content); calls not in it get `observation`),
// else one user message.
function pushStepResult(observation, perCall) {
    const last = S.messages[S.messages.length - 1];
    const calls = last && last.role === "assistant" ? last.tool_calls || [] : [];
    if (!calls.length) { S.messages.push({ role: "user", content: observation }); return; }
    for (const c of calls) S.messages.push({ role: "tool", tool_call_id: c.id, content: (perCall && perCall.get(c.id)) || observation });
}

function flushModelNotes() {
    if (!RUN.modelNotes.length) return;
    appendToLastUserMessage(S.messages, RUN.modelNotes.map(n => "Note: " + n).join("\n"));
    RUN.modelNotes = [];
    S.timeline.forEach((t, i) => { if (t._queued) { t._queued = false; renderTimelineItem(i); } });
}

// ⚡ Send now: abort the model request in flight; the turn starts over with the note.
function sendNotesNow() {
    if (!RUN.requesting || !RUN.abort || !RUN.modelNotes.length) return;
    RUN.restartTurn = true;
    RUN.abort.abort();
}

function waitForDecision(idx) {
    const item = S.timeline[idx];
    debugLog("decision", "held for your approval", item && item.risk && item.risk.reasons.length ? "Why: " + item.risk.reasons.join("; ") : "Approve each step is on.");
    return new Promise((resolve) => { RUN.decision = { idx, resolve }; });
}

function resolveDecision(decision) {
    const d = RUN.decision;
    if (!d) return;
    RUN.decision = null;
    debugLog("decision", "you chose: " + decision.action + (decision.reason ? " — " + decision.reason : ""), decision.action === "edit" && decision.code ? decision.code : "");
    d.resolve(decision);
}

async function startTask(text) {
    // The package list for the system prompt comes from the core's lock file (usually
    // loaded long before; without it the prompt names a few examples).
    await loadPyodideCore().catch(() => {});
    S = freshSession();
    CHECKPOINTS = [];
    S.task = text;
    S.createdAt = nowIso();
    const files = workspaceFileList();
    // What is known of the endpoint so far; the first turn switches the prompt if its
    // probe finds otherwise (syncSystemPrompt).
    S.protocol = currentProtocol();
    S.messages = [
        { role: "system", content: buildSystemPrompt(SETTINGS.instructions, PKG.names, S.protocol) },
        { role: "user", content: buildTaskMessage(text, files) },
    ];
    RUN.modelNotes = [];
    RUN.compactAfter = 0;
    RUN.compactNext = false;
    RUN.listedKey = fileListingKey(files);
    renderTimeline();
    addTimelineItem({ type: "task", text, files: files.map(f => f.path) });
    S.timeline[S.timeline.length - 1].checkpoint = takeCheckpoint("start");
    renderTimelineItem(S.timeline.length - 1);
    S.stepBudget = SETTINGS.stepLimit;
    runLoop();
}

// User text while a session exists: a note during a run, an answer to `ask:`, or a
// follow-up once the agent has finished or paused.
function submitUserText(text) {
    if (RUN.active) {
        // Queued until the next request; ⚡ Send now on its card restarts a model request
        // that is still running, so a long reasoning turn doesn't have to finish first.
        addTimelineItem({ type: "user", kind: "guidance", text, _queued: true });
        RUN.modelNotes.push("Guidance from the user: " + text);
        showToast("📝 Note queued — it goes out with the next request.");
        return;
    }
    const kind = S.status === "awaiting-user" ? "answer" : "followup";
    if (text) {
        addTimelineItem({ type: "user", kind, text });
        appendToLastUserMessage(S.messages, text);
    } else if (!awaitsModel(S.messages)) {
        showToast("Type a follow-up for the agent first.");
        return;
    }
    flushModelNotes();
    S.stepBudget = Math.max(S.stepBudget, S.stepCount + SETTINGS.stepLimit);
    runLoop();
}

// True while the run sits at the step limit, where Continue allows a few more steps.
function atStepLimit() {
    return !RUN.active && S.status === "paused" && S.stepCount >= S.stepBudget;
}

// Never lowers the budget: Continue after a Stop or an error mid-budget keeps what's left.
// more: how many steps to allow (the step-limit note's field; RUN.moreSteps remembers it).
function continueAfterLimit(more) {
    const n = Number.isInteger(more) && more > 0 ? Math.min(500, more) : RUN.moreSteps;
    RUN.moreSteps = n;
    S.stepBudget = Math.max(S.stepBudget, S.stepCount + n);
    runLoop();
}

// The Compact button: summarise the older steps now, between runs. The status comes back
// as it was; Stop aborts it.
async function compactNow() {
    if (RUN.active || !S.task) return;
    const prev = S.status;
    RUN.active = true;
    RUN.stopRequested = false;
    RUN.activeSince = Date.now();
    setStatus("running");
    try {
        const r = await compactHistory("manual");
        if (r === "stopped") addNote("⏹ Stopped while compacting the history.");   // a failure adds its own note
        if (r === "unreachable") addNote(`⚠️ Couldn't compact the history: the endpoint didn't answer (${RUN.lastError && RUN.lastError.message}). Nothing changed.`, "warn");
    } finally {
        S.activeMs += Date.now() - RUN.activeSince;
        RUN.active = false;
        RUN.abort = null;
        RUN.activity = "";
        setStatus(prev);
        renderTimeline();
    }
}

async function runLoop() {
    if (RUN.active) return;
    RUN.active = true;
    RUN.stopRequested = false;
    RUN.overflowRetried = false;
    RUN.activeSince = Date.now();
    setStatus("running");
    // The step-limit note carries its own Continue button: drop it now the run is on
    // (a follow-up may sit after the note, but no step does).
    for (let i = S.timeline.length - 1; i >= 0 && S.timeline[i].type !== "step"; i--) {
        if (S.timeline[i].limit) renderTimelineItem(i);
    }
    try {
        for (;;) {
            if (RUN.stopRequested) { addNote("⏹ Stopped by the user."); setStatus("stopped"); break; }
            if (S.stepCount >= S.stepBudget) {
                addTimelineItem({ type: "note", tone: "warn", limit: true, text: `⏸ Step limit reached (${S.stepCount} steps). Continue for more steps, or send a follow-up.` });
                setStatus("paused");
                break;
            }
            flushModelNotes();
            const outcome = await agentTurn();
            enforceCheckpointBudget();
            if (outcome === "done" || outcome === "ask" || outcome === "stopped" || outcome === "error") break;
        }
    } catch (e) {
        // A bug or a malformed worker answer: show it rather than leave the loop hanging.
        console.error("agent loop failed:", e);
        const last = S.timeline[S.timeline.length - 1];
        if (last && last.type === "step" && last.phase !== "done") {
            last.phase = "done";
            last.status = last.status || "crashed";
            // The worker may hold changes that never reached the canonical workspace:
            // start it fresh. And answer the code turn, so the history stays well-formed
            // for Retry.
            restartInterpreter();
            const lastMsg = S.messages[S.messages.length - 1];
            if (lastMsg && lastMsg.role === "assistant" && (last.kind === "code" || last.kind === "files")) {
                pushStepResult(buildObservation({ step: last.n, status: "error", notes: ["The harness failed while handling this step (" + (e.message || e) + "). Nothing was committed, and the interpreter was restarted: variables are lost, files are as they were before this step."] }));
            }
        }
        addTimelineItem({ type: "error", text: e.message || String(e), hint: "The step was not committed. Press Retry to ask the model again." });
        setStatus("error");
    } finally {
        S.activeMs += Date.now() - RUN.activeSince;
        RUN.active = false;
        RUN.abort = null;
        RUN.step = 0;
        RUN.activity = "";
        renderStatusBar();
        updateComposer();
        renderTimeline();   // re-enable rewind buttons
    }
}

// One model turn plus whatever it leads to. Returns "continue" | "done" | "ask" |
// "stopped" | "error".
async function agentTurn() {
    const n = S.stepCount + 1;
    RUN.step = n;
    if (SETTINGS.autoCompactPct > 0 && (RUN.compactNext || S.stepCount >= RUN.compactAfter)) {
        await ensureReasoningProbe().catch(() => {});   // n_ctx comes with the probe
        const limit = contextLimit(SETTINGS.contextSize, REASONING.nCtx);
        const forced = RUN.compactNext;
        RUN.compactNext = false;
        if (forced || compactionDue(estimateTokens(requestMessages(), RUN.tokenRatio), limit, SETTINGS.autoCompactPct, SETTINGS.maxTokens)) {
            const r = await compactHistory(forced ? "context" : "threshold");
            if (r === "stopped") { addNote("⏹ Stopped while compacting the history."); setStatus("stopped"); return "stopped"; }
            if (r === "unreachable") { RUN.compactNext = forced; return endpointDown(RUN.lastError); }
        }
    }
    setActivity("thinking");
    await ensureReasoningProbe().catch(() => {});
    const protocol = currentProtocol();
    const native = protocol === "tools";
    syncSystemPrompt(protocol);
    debugLog("model", `→ request to ${SETTINGS.model || "default model"} · ${S.messages.length} messages · effort ${SETTINGS.effort}${native ? " · native tool calls" : ""}`);
    const step = addTimelineItem({
        type: "step", n, phase: "thinking", kind: "", reasoning: "", content: "", prose: "",
        notes: [], netAttempts: [], startedAt: nowIso(), changes: null, risk: null, protocol,
    });
    const idx = S.timeline.length - 1;
    const render = createThrottle(THROTTLE_MS);
    let rawContent = "", apiReasoning = "";
    let result, sent = [];
    const t0 = Date.now();
    try {
        sent = requestMessages(protocol);
        const payload = {
            model: SETTINGS.model || "local-model",
            messages: sent,
            stream: true,
            stream_options: { include_usage: true },
            ...currentReasoningParams(),
        };
        if (native) { payload.tools = agentToolDefs(); payload.parallel_tool_calls = true; }
        if (SETTINGS.maxTokens > 0) payload.max_tokens = SETTINGS.maxTokens;
        setRequesting(true);
        result = await requestWithRetry((signal) => {
            // A retry starts the reply over: what streamed before the drop is discarded.
            rawContent = ""; apiReasoning = ""; step._calling = "";
            setActivity("thinking");
            return streamChat(payload, signal, (r, c, calls) => {
                apiReasoning += r;
                rawContent += c;
                const split = splitReply(rawContent, false);
                const calling = (calls || []).map(t => t.name || "…").join(", ");
                if ((split.text || calling) && RUN.activity === "thinking") setActivity("writing");
                if (step._retry) { step._retry = null; renderTimelineItem(idx); }
                step.reasoning = [apiReasoning, split.reasoning].filter(Boolean).join("\n\n");
                step.content = split.text;
                step._calling = calling;
                render(() => renderTimelineItem(idx));
            });
        }, (e, attempt, delay) => {
            render.cancel();
            step.reasoning = ""; step.content = ""; step._calling = "";
            step._retry = { n: attempt, error: String(e.message || e) };
            step._retries = attempt;
            setActivity("retrying");
            renderTimelineItem(idx);
        });
    } catch (e) {
        render.cancel();
        S.timeline.splice(idx, 1);
        renderTimeline();
        if (e.name === "AbortError") {
            // ⚡ Send now on a queued note: the turn starts over with the note included.
            if (RUN.restartTurn && !RUN.stopRequested) { RUN.restartTurn = false; debugLog("model", "request restarted for your note"); return "continue"; }
            debugLog("model", "request aborted"); addNote("⏹ Stopped the model request."); setStatus("stopped"); return "stopped";
        }
        debugLog("error", "model request failed: " + (e.message || e));
        // DESIGN §5.6: the endpoint refuses native tool calls. Fall back to code-as-action
        // for it (the history is sent in that form from now on) and ask again.
        if (e.toolsRejected && native) {
            REASONING.toolsRejected = true;
            renderHeader();
            addNote(`🔧 The endpoint refused native tool calls (${e.message}). Switched to code blocks and tags for this endpoint; the task goes on.`, "warn");
            showToast("🔧 This endpoint refuses tool calls — using code blocks and tags instead");
            return "continue";
        }
        // The prompt no longer fits: compact once (as far as it takes) and ask again.
        if (isContextOverflowError(e.message) && SETTINGS.autoCompactPct > 0 && !RUN.overflowRetried) {
            RUN.overflowRetried = true;
            const r = await compactHistory("overflow");
            if (r === "stopped") { addNote("⏹ Stopped while compacting the history."); setStatus("stopped"); return "stopped"; }
            if (r === "unreachable") return endpointDown(RUN.lastError);
            if (r === "compacted") return "continue";
        }
        if (e.retriedMs) return endpointDown(e);
        const hint = chatErrorHint(e.message, { apiUrl: SETTINGS.apiUrl, mixedContent: isBlockedMixedContent(SETTINGS.apiUrl), autoCompact: isContextOverflowError(e.message) ? SETTINGS.autoCompactPct > 0 : undefined });
        addTimelineItem({ type: "error", text: e.message || String(e), hint });
        setStatus("error");
        return "error";
    } finally {
        RUN.abort = null;
        RUN.restartTurn = false;
        setRequesting(false);
    }
    render.cancel();
    step._calling = "";
    if (step._retries) {
        const secs = Math.round((Date.now() - t0 - (result.clock.endMs - result.clock.startMs)) / 1000);
        step.retryNote = `🔌 The endpoint answered again after ${step._retries} retr${step._retries === 1 ? "y" : "ies"} (about ${secs} s without a reply).`;
        step._retry = null;
        debugLog("model", step.retryNote);
    }
    RUN.overflowRetried = false;
    S.tokens.prompt += result.usage.prompt;
    S.tokens.completion += result.usage.completion;
    if (result.usage.prompt > 0) RUN.tokenRatio = result.usage.prompt / Math.max(1, messageChars(sent));
    const split = splitReply(rawContent, true);
    step.reasoning = [apiReasoning, split.reasoning].filter(Boolean).join("\n\n");
    step.content = split.text;
    step.finishReason = result.finishReason || "";
    step.stats = buildStepStats(result.rawUsage, result.timings, result.clock, REASONING.nCtx);
    // Native mode reads the reply's tool calls (a reply without any is read as text);
    // code-as-action reads the text. Both give the same kinds (DESIGN §5.6).
    const parsed = native ? parseToolCalls(result.toolCalls, split.text, result.finishReason, n) : parseReply(split.text, result.finishReason);
    step.kind = parsed.kind;
    const ctxCut = cutByContext(result.finishReason, result.usage, SETTINGS.maxTokens, REASONING.nCtx);
    if (ctxCut) {
        RUN.compactNext = true;
        const u = result.usage;
        step.notes.push(`The context window ran out, not the reply budget: the prompt (${u.prompt.toLocaleString("en-US")} tokens) plus this reply (${u.completion.toLocaleString("en-US")}) filled it before ${SETTINGS.maxTokens > 0 ? `the ${SETTINGS.maxTokens.toLocaleString("en-US")} max tokens` : "the reply ended"}.` + (SETTINGS.autoCompactPct > 0 ? " The history is compacted before the next request." : " Auto-compaction is off."));
        debugLog("error", `reply cut by the context window · prompt ${u.prompt} + reply ${u.completion} tok` + (REASONING.nCtx ? ` of n_ctx ${REASONING.nCtx}` : ""));
    }
    const callSummary = native && result.toolCalls.length ? " · calls: " + result.toolCalls.map(c => c.name || "?").join(", ") : "";
    debugLog("model", `← reply · finish ${result.finishReason || "?"} · ${result.usage.completion} tok · ${((result.clock.endMs - result.clock.startMs) / 1000).toFixed(1)} s${callSummary} → ${parsed.kind}`,
        clipForDebug([split.text, ...(native ? result.toolCalls.map(c => `${c.name}(${c.arguments})`) : [])].filter(Boolean).join("\n\n"), 4000));
    // The history keeps the visible reply only; reasoning isn't sent back. Native calls go
    // with it, each answered by a tool message (pushStepResult), or by the user's reply
    // for finish and ask_user.
    const assistantMsg = { role: "assistant", content: split.text };
    if (native && parsed.stored.length) assistantMsg.tool_calls = parsed.stored.map(c => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } }));
    S.messages.push(assistantMsg);
    S.stepCount = n;
    if (parsed.skipped && parsed.skipped.length) {
        step.skippedCalls = parsed.skipped.map(([id, why]) => { const c = parsed.stored.find(x => x.id === id); return `${c ? c.name : "?"}: ${why}`; });
        for (const line of step.skippedCalls) debugLog("error", "tool call not run · " + line);
    }

    if (parsed.kind === "final") {
        if (native && parsed.answer) step.content = [split.text, parsed.answer].filter(Boolean).join("\n\n");
        // An answer that presents files the workspace doesn't have goes back to the
        // model once, instead of ending the task on a false claim. Only once in a
        // row: the second answer stands either way.
        const missing = missingMentionedFiles(step.content, [...WS.files.keys()]);
        const prev = S.timeline.slice(0, idx).reverse().find(t => t.type === "step");
        if (missing.length && !(prev && prev.status === "unverified")) {
            step.status = "unverified";
            step.phase = "done";
            step.endedAt = nowIso();
            const list = missing.join(", ");
            debugLog("tool", "final_answer → sent back: mentions missing " + list);
            step.notes = [`The answer mentions ${list}, which ${missing.length === 1 ? "isn't" : "aren't"} in the workspace. The agent was asked to check.`];
            pushStepResult(buildObservation({ step: n, status: "error", notes: [`Your answer mentions ${list}, but /workspace has no such file${missing.length === 1 ? "" : "s"}. Files that exist: ${[...WS.files.keys()].join(", ") || "(none)"}. Create the missing file${missing.length === 1 ? "" : "s"} with ${native ? "write_file or run_python" : "<write_file> or code"}, or correct your answer.`] }));
            step.checkpoint = takeCheckpoint("step " + n);
            renderTimelineItem(idx);
            return "continue";
        }
        debugLog("tool", "final_answer", clipForDebug(step.content, 4000));
        step.phase = "done";
        step.endedAt = nowIso();
        step.checkpoint = takeCheckpoint("step " + n);
        renderTimelineItem(idx);
        setStatus("done");
        return "done";
    }
    if (parsed.kind === "ask") {
        debugLog("tool", "ask_user", parsed.question);
        step.question = parsed.question;
        step.prose = parsed.prose;
        step.phase = "done";
        step.endedAt = nowIso();
        step.checkpoint = takeCheckpoint("step " + n);
        renderTimelineItem(idx);
        setStatus("awaiting-user");
        return "ask";
    }
    if (parsed.kind !== "code" && parsed.kind !== "files") {
        // Cut off, empty, an unclosed block or tag, file actions mixed with code, a
        // <tool_call> in text, a made-up <observation>, or (native) no call that could
        // run: nothing ran. Tell the model why.
        const why = noActionAdvice(parsed, native, ctxCut);
        debugLog("error", "no tool call (" + parsed.kind + ")", why);
        step.prose = parsed.prose || "";
        step.status = parsed.kind;
        step.phase = "done";
        step.endedAt = nowIso();
        const whyNotes = [...(parsed.kind === "badcall" ? [] : [why]), ...(parsed.notes || [])];
        pushStepResult(buildObservation({ step: n, status: "error", notes: whyNotes }),
            new Map((parsed.skipped || []).map(([id, r]) => [id, buildObservation({ step: n, status: "error", notes: [r, ...whyNotes] })])));
        sendFileListingIfDue(step);
        step.checkpoint = takeCheckpoint("step " + n);
        renderTimelineItem(idx);
        return "continue";
    }

    step.prose = parsed.prose;
    const notes = [...(parsed.notes || [])];
    let outcome;
    if (parsed.kind === "files") {
        if (result.finishReason === "length") notes.push(`Your reply was cut off at ${ctxCut ? "the end of the context window" : "the token limit"} after these file actions; anything after them was lost.`);
        outcome = await executeFileStep(step, idx, parsed.actions, notes);
    } else {
        step.proposedCode = parsed.code;
        step.blockCount = parsed.blockCount;
        if (parsed.blockCount > 1) notes.push(`Only the first of your ${parsed.blockCount} code blocks was run.`);
        outcome = await executeStep(step, idx, notes);
    }
    debugLog("result", `step ${n} done · ${step.status || "?"} · ${step.decision || "no decision"} · changes: ${formatChanges(step.changes)}`);
    step.phase = "done";
    step.endedAt = nowIso();
    // Calls that didn't run get their reason; a file batch gets one result per call.
    const perCall = new Map((parsed.skipped || []).map(([id, why]) => [id, buildObservation({ step: n, status: "error", notes: [why] })]));
    for (const [id, obs] of outcome.perCall || []) perCall.set(id, obs);
    pushStepResult(outcome.observation, perCall);
    sendFileListingIfDue(step);
    step.checkpoint = takeCheckpoint("step " + n);
    // Decided: the versions it wrote are now the workspace's (and the checkpoint's) or
    // rolled back. Keeping them listed would hold every version ever written.
    delete step._held;
    collectGarbage();
    renderTimelineItem(idx);
    renderWorkspace();
    renderStatusBar();
    return "continue";
}

// The endpoint stayed unreachable through every retry: the run pauses, resumable with
// Retry or Continue, instead of ending. Returns the agentTurn outcome.
function endpointDown(e) {
    const err = e || new Error("The endpoint didn't answer.");
    const hint = chatErrorHint(err.message, { apiUrl: SETTINGS.apiUrl, mixedContent: isBlockedMixedContent(SETTINGS.apiUrl), retriedMs: err.retriedMs || LIMITS.retryWindowMs });
    debugLog("error", "endpoint unreachable, run paused: " + (err.message || err));
    addTimelineItem({ type: "error", text: err.message || String(err), hint });
    setStatus("paused");
    return "error";
}

// DESIGN §5.4: every few steps, the current file list follows the step's observation when
// the workspace changed since the model last got one. The step records how many files.
function sendFileListingIfDue(step) {
    const files = workspaceFileList();
    const due = periodicFileListing(step.n, LIMITS.fileListEvery, RUN.listedKey, files);
    if (!due) return;
    appendToLastUserMessage(S.messages, due.note);
    RUN.listedKey = due.key;
    step.fileListSent = files.length;
    debugLog("tool", `file list sent with step ${step.n} (${files.length} file${files.length === 1 ? "" : "s"}; every ${LIMITS.fileListEvery} steps when it changed)`, clipForDebug(due.note, 4000));
}

// DESIGN §5.4: summarise the older steps into the task message, keeping the last few
// verbatim. reason: "threshold" (the history neared the context limit), "overflow" (the
// server refused it), "context" (a reply ran out of context) or "manual" (the Compact
// button); for all but the first, as many steps as it takes are summarised. Returns
// "compacted" | "skipped" (nothing to summarise, or it failed: the history is
// unchanged) | "unreachable" (the endpoint stayed down through the retries; unchanged
// too) | "stopped".
async function compactHistory(reason) {
    const force = reason !== "threshold";
    let plan = planCompaction(S.messages, LIMITS.compactKeepSteps, force ? 1 : LIMITS.compactMinSteps);
    for (let keep = LIMITS.compactKeepSteps - 1; !plan && force && keep >= 1; keep--) plan = planCompaction(S.messages, keep, 1);
    if (!plan) return "skipped";
    const prevTo = S.compactions.length ? S.compactions[S.compactions.length - 1].toStep : 0;
    const fromStep = prevTo + 1, toStep = prevTo + plan.steps;
    const tokensBefore = estimateTokens(requestMessages(), RUN.tokenRatio);
    setActivity("compacting");
    debugLog("model", `→ compacting steps ${fromStep}–${toStep} (${reason}) · ~${tokensBefore} tokens`);
    const payload = {
        model: SETTINGS.model || "local-model",
        messages: buildCompactionRequest(S.messages, plan.cut),
        stream: true,
        stream_options: { include_usage: true },
        ...currentReasoningParams(),
    };
    if (SETTINGS.maxTokens > 0) payload.max_tokens = SETTINGS.maxTokens;
    let text = "";
    let result;
    try {
        result = await requestWithRetry((signal) => {
            text = "";
            setActivity("compacting");
            return streamChat(payload, signal, (r, c) => { text += c; });
        }, () => setActivity("retrying"));
    } catch (e) {
        if (e.name === "AbortError") { debugLog("model", "compaction aborted"); return "stopped"; }
        debugLog("error", "compaction failed: " + (e.message || e));
        // Down for good: say so once, from the caller, rather than also warning here.
        if (e.retriedMs) { RUN.lastError = e; return "unreachable"; }
        RUN.compactAfter = S.stepCount + LIMITS.compactMinSteps;
        if (reason !== "overflow") addNote(`⚠️ Couldn't compact the history (${e.message || e}). Continuing with the full history.`, "warn");
        return "skipped";
    } finally {
        RUN.abort = null;
    }
    S.tokens.prompt += result.usage.prompt;
    S.tokens.completion += result.usage.completion;
    const summary = splitReply(text, true).text.trim();
    if (!summary) {
        debugLog("error", "compaction failed: empty summary");
        RUN.compactAfter = S.stepCount + LIMITS.compactMinSteps;
        addNote("⚠️ Couldn't compact the history: the model returned an empty summary. Continuing with the full history.", "warn");
        return "skipped";
    }
    const files = workspaceFileList();
    RUN.listedKey = fileListingKey(files);   // the compacted history carries the list
    S.compactions.push({ before: S.messages.map(copyMessage), fromStep, toStep });
    S.messages = buildCompactedMessages(S.messages, plan.cut, summary, toStep, files);
    const tokensAfter = estimateTokens(requestMessages(), RUN.tokenRatio);
    debugLog("result", `history compacted · steps ${fromStep}–${toStep} · ~${tokensBefore} → ~${tokensAfter} tokens`, clipForDebug(summary, 4000));
    addTimelineItem({ type: "compaction", reason, fromStep, toStep, summary, tokensBefore, tokensAfter });
    renderStatusBar();
    return "compacted";
}

// Run the step's code under the current autonomy level, gate it on its effect, and
// commit or roll back. Returns { observation, stop }.
async function executeStep(step, idx, notes) {
    let code = step.proposedCode;
    const autonomy = SETTINGS.autonomy;
    if (autonomy === "approve") {
        step.phase = "pending-run";
        renderTimelineItem(idx);
        setStatus("awaiting-approval");
        const d = await waitForDecision(idx);
        setStatus("running");
        if (d.action === "reject") {
            step.decision = "rejected"; step.decidedBy = "user"; step.rejectReason = d.reason || ""; step.status = "rejected";
            return { observation: buildObservation({ step: step.n, status: "rejected", reason: d.reason, notes: [...notes, "Your code did not run."] }), stop: !!d.stop };
        }
        if (d.code !== code) { step.edited = true; code = d.code; }
        step.decision = step.edited ? "edited" : "approved";
        step.decidedBy = "user";
    }
    let allowNetwork = false;
    for (;;) {
        step.ranCode = code;
        step.phase = "running";
        setActivity("python");
        debugLog("tool", `python · ${code.split("\n").length} lines${allowNetwork ? " · network allowed" : ""}`, code);
        const t0 = performance.now();
        renderTimelineItem(idx);
        const r = await runInWorker(code, { allowNetwork, timeoutMs: SETTINGS.stepTimeoutSec * 1000, step: step.n });
        step.notes = [...notes, ...(r.notes || [])];
        step.netAttempts = r.netAttempts || [];
        debugLog(r.status === "ok" ? "result" : "error", `python → ${r.status} · ${Math.round(performance.now() - t0)} ms` + (step.netAttempts.length ? ` · ${step.netAttempts.length} blocked network attempt(s)` : ""), clipForDebug(r.output, 4000) + (step.netAttempts.length ? "\n\nBlocked: " + step.netAttempts.join(", ") : ""));
        if (step.edited) step.notes.push("The user edited your code before it ran. The code that ran:\n```python\n" + code.replace(/\n$/, "") + "\n```");
        if (r.status === "timeout" || r.status === "killed" || r.status === "crashed") {
            const why = {
                timeout: r.packagePhase && r.output ? r.output : `The step exceeded the ${SETTINGS.stepTimeoutSec} s time limit and was killed.`,
                killed: "The user killed the step.",
                crashed: "The interpreter crashed: " + r.output,
            }[r.status];
            step.status = r.status;
            step.output = (r.output && r.status !== "crashed") ? r.output : why;
            step.changes = { added: [], modified: [], deleted: [] };
            step.decision = step.decision || "rolled back";
            step.notes.push(why, "The interpreter was restarted: variables are lost. Files are as they were before this step.");
            return { observation: buildObservation({ step: step.n, status: r.status === "crashed" ? "error" : r.status, output: why, changes: step.changes, notes: step.notes.filter(n => n !== why) }), stop: false };
        }
        step.status = r.status;
        step.output = r.output;
        const effect = await collectEffect(r);
        step.changes = effect.changes;
        step._held = effect.hashes;
        const origins = {};
        for (const [p, f] of WS.files) origins[p] = f.origin;
        const risk = classifyEffect(effect.diff, origins, { bytesWritten: effect.bytesWritten, netAttempts: step.netAttempts, overLimit: effect.overLimit });
        step.risk = risk;
        if (step.netAttempts.length) step.notes.push("Network access is blocked; these attempts failed: " + step.netAttempts.join(", "));
        // Figures and other binary files: the model is told what they are (it can't see them).
        step.figures = r.figures.filter(f => effect.pending.has(f.path));
        step.notes.push(...binaryFileNotes([...effect.pending].map(([p, h]) => ({ path: p, bytes: WS.blobs.get(h) })), step.figures));
        const fileHint = filenameCommentHint(code, Object.keys(r.listing), step.protocol === "tools");
        if (fileHint) step.notes.push(fileHint);
        const modHint = moduleNotFoundHint(r.output, PKG.names, [...bundledImportIndex(BUNDLED_LIBRARIES).keys()]);
        if (modHint) step.notes.push(modHint);

        let decision = { action: "approve" };
        if (autonomy === "risk" && risk.verdict === "ask" && !allowNetwork) {
            step.phase = "pending-approval";
            renderTimelineItem(idx);
            renderWorkspace();
            setStatus("awaiting-approval");
            decision = await waitForDecision(idx);
            setStatus("running");
        } else if (effect.overLimit && autonomy !== "risk") {
            decision = { action: "reject", reason: effect.overLimit, auto: true };
        }

        if (decision.action === "approve") {
            commitEffect(effect);
            if (!step.decision) { step.decision = risk.verdict === "ask" && autonomy === "risk" ? "approved" : "auto"; step.decidedBy = step.decision === "auto" ? "auto" : "user"; }
            return { observation: buildObservation({ step: step.n, status: r.status, output: r.output, changes: step.changes, notes: step.notes }), stop: false };
        }
        // Reject, or re-run: either way the step's effects are rolled back and the
        // interpreter restarted, since variables may hold data from the step.
        await rollbackStep();
        if (decision.action === "reject") {
            step.decision = "rejected"; step.decidedBy = decision.auto ? "auto" : "user"; step.rejectReason = decision.reason || ""; step.status = "rejected";
            WS.lastChanged = new Set();
            return {
                observation: buildObservation({ step: step.n, status: "rejected", reason: decision.reason, notes: ["Its file changes were rolled back and the interpreter was restarted: variables are lost, files are as they were before this step."] }),
                stop: !!decision.stop,
            };
        }
        // "edit" or "rerun-net": run again on a fresh interpreter.
        if (decision.action === "edit") { code = decision.code; step.edited = true; step.decision = "edited"; }
        if (decision.action === "rerun-net") { allowNetwork = true; step.decision = "approved (network)"; }
        step.decidedBy = "user";
        notes = [...notes, "The interpreter was restarted before this run: variables from earlier steps are lost."];
    }
}

// A file-action step (DESIGN §2.3). The actions are worked out against the canonical
// workspace without changing it, so the effect is gated *before* anything is applied:
// a reject has nothing to roll back and the interpreter keeps its variables.
// Returns { observation, stop, perCall? }: native tool calls (actions with an .id) each
// get their own result once applied, the step's changes and notes with the last one.
async function executeFileStep(step, idx, actions, notes) {
    const ws = { paths: [...WS.files.keys()], read: (p) => { const f = WS.files.get(p); return f ? WS.blobs.get(f.hash) || null : null; } };
    setActivity("files");
    const applied = applyFileActions(actions, ws);
    for (const r of applied.results) {
        const edits = r.edits ? ` · ${r.edits.length} edit${r.edits.length === 1 ? "" : "s"}` : "";
        debugLog(r.ok ? "tool" : "error", `${r.tool} ${r.path}${edits} → ${r.ok ? "ok" : "failed"}${r.message ? ": " + r.message : ""}`,
            r.edits ? clipForDebug(r.edits.map((e, i) => `--- edit ${i + 1}: old\n${e.old}\n+++ new\n${e.new}`).join("\n\n"), 4000)
                : r.tool === "write_file" && applied.writes.has(r.path) ? clipForDebug(applied.writes.get(r.path), 4000)
                : r.output ? clipForDebug(r.output, 4000) : "");
    }
    step.fileActions = applied.results.map(r => {
        const a = { tool: r.tool, path: r.path, ok: r.ok, message: r.message };
        if (r.startLine) { a.startLine = r.startLine; a.endLine = r.endLine; }
        if (r.edits) a.edits = r.edits;
        return a;
    });
    step.output = formatFileResults(applied.results, applied.failed);
    step.status = applied.results.every(r => r.ok) ? "ok" : "error";
    step.notes = [...notes];
    let effect = null;
    if (applied.writes.size) {
        const enc = new TextEncoder();
        const listing = {}, files = {};
        for (const [p, f] of WS.files) listing[p] = f.hash;
        for (const [p, text] of applied.writes) {
            files[p] = enc.encode(text);
            listing[p] = await sha256Hex(files[p]);
        }
        effect = await collectEffect({ listing, files });
        effect.gen = -1;   // not in the worker yet: commitEffect mustn't mark it in sync
        if (!effect.diff.added.length && !effect.diff.modified.length) effect = null;
    }
    if (effect) {
        step.changes = effect.changes;
        step._held = effect.hashes;
        const origins = {};
        for (const [p, f] of WS.files) origins[p] = f.origin;
        step.risk = classifyEffect(effect.diff, origins, { bytesWritten: effect.bytesWritten, overLimit: effect.overLimit });
    } else if (applied.writes.size || actions.some(a => a.tool !== "read_file")) {
        step.changes = { added: [], modified: [], deleted: [] };
    }

    const autonomy = SETTINGS.autonomy;
    let decision = { action: "approve" };
    const hold = autonomy === "approve" || (autonomy === "risk" && effect && step.risk.verdict === "ask");
    if (effect && effect.overLimit && autonomy !== "risk") {
        decision = { action: "reject", reason: effect.overLimit, auto: true };
    } else if (hold) {
        step.phase = "pending-approval";
        renderTimelineItem(idx);
        renderWorkspace();
        setStatus("awaiting-approval");
        decision = await waitForDecision(idx);
        setStatus("running");
    }
    if (decision.action === "approve") {
        if (effect) {
            const prevVersion = WS.version;
            commitEffect(effect);
            await pushEffectToWorker(effect, prevVersion);
        }
        if (effect || hold) {
            step.decision = hold ? "approved" : "auto";
            step.decidedBy = hold ? "user" : "auto";
        }
        let perCall = null;
        if (actions.some(a => a.id)) {
            const texts = fileCallResults(applied.results, applied.failed);
            const last = actions.length - 1;
            perCall = new Map(actions.map((a, i) => [a.id, buildObservation({
                step: step.n, status: applied.results[i].ok && !(applied.failed && a.tool !== "read_file") ? "ok" : "error", output: texts[i], truncate: false,
                ...(i === last ? { changes: step.changes, notes: step.notes } : {}),
            })]));
        }
        return { observation: buildObservation({ step: step.n, status: step.status, output: step.output, changes: step.changes, notes: step.notes, truncate: false }), stop: false, perCall };
    }
    step.decision = "rejected";
    step.decidedBy = decision.auto ? "auto" : "user";
    step.rejectReason = decision.reason || "";
    step.status = "rejected";
    WS.lastChanged = new Set();
    const nothing = actions.some(a => a.tool === "read_file") ? "Nothing was applied and you don't get the read results; files are unchanged." : "Nothing was applied; files are unchanged.";
    return { observation: buildObservation({ step: step.n, status: "rejected", reason: decision.reason, notes: [...notes, nothing] }), stop: !!decision.stop };
}

// After a committed file step, hand the new bytes to the worker if it held exactly the
// previous workspace, instead of a full re-seed before the next python step. Anything
// else (not booted, busy, restarted meanwhile) is left to syncWorkspaceToWorker.
async function pushEffectToWorker(effect, prevVersion) {
    if (PY.state !== "idle" || PY.syncedVersion !== prevVersion) return;
    const gen = PY.gen, version = WS.version;
    const files = {};
    for (const [p, hash] of effect.pending) files[p] = WS.blobs.get(hash);
    try {
        await workerCall("write", { files }, 30000);
        if (gen === PY.gen && WS.version === version) PY.syncedVersion = version;
    } catch (e) { /* the next python step re-seeds */ }
}

// Turn a run result into a diff against the canonical workspace, with verified bytes.
async function collectEffect(r) {
    const before = {};
    for (const [p, f] of WS.files) before[p] = f.hash;
    const diff = diffListings(before, r.listing);
    const changes = { added: [], modified: [], deleted: [] };
    const pending = new Map();
    const hashes = [];
    let bytesWritten = 0;
    for (const kind of ["added", "modified"]) {
        for (const p of diff[kind]) {
            const bytes = r.files[p];
            if (!bytes) throw new Error("The worker reported a change to " + p + " without its content.");
            const hash = await sha256Hex(bytes);
            if (hash !== r.listing[p]) throw new Error("The worker reported a wrong hash for " + p + ".");
            WS.blobs.set(hash, bytes);   // held until commit or garbage collection
            hashes.push(hash);
            pending.set(p, hash);
            bytesWritten += bytes.length;
            changes[kind].push(kind === "added" ? { path: p, hash, size: bytes.length } : { path: p, hash, prevHash: before[p], size: bytes.length });
        }
    }
    for (const p of diff.deleted) changes.deleted.push({ path: p, prevHash: before[p] });
    // Would committing this break the workspace limits?
    let total = workspaceSize(), count = WS.files.size;
    for (const p of diff.deleted) { total -= (WS.blobs.get(before[p]) || []).length; count--; }
    for (const p of diff.modified) total -= (WS.blobs.get(before[p]) || []).length;
    total += bytesWritten;
    count += diff.added.length;
    let overLimit = "";
    if (count > LIMITS.maxFiles) overLimit = `would leave ${count} files in the workspace (limit ${LIMITS.maxFiles})`;
    else if (total > LIMITS.maxWorkspaceBytes) overLimit = `would grow the workspace to ${formatBytes(total)} (limit ${formatBytes(LIMITS.maxWorkspaceBytes)})`;
    return { diff, changes, pending, hashes, bytesWritten, overLimit, gen: PY.gen, version: WS.version };
}

function commitEffect(effect) {
    const inSync = effect.gen === PY.gen && effect.version === WS.version;
    for (const p of effect.diff.deleted) WS.files.delete(p);
    for (const [p, hash] of effect.pending) {
        const prev = WS.files.get(p);
        WS.files.set(p, { hash, origin: prev ? prev.origin : "agent" });
    }
    WS.version++;
    // The worker already holds exactly this state, unless it was restarted (Kill while
    // the step waited for approval) or the workspace changed meanwhile (an upload).
    if (inSync) PY.syncedVersion = WS.version;
    WS.lastChanged = new Set([...effect.diff.added, ...effect.diff.modified]);
}

async function rollbackStep() {
    restartInterpreter();
    await ensureInterpreter().catch(() => {});
}

function stopRun() {
    RUN.stopRequested = true;
    if (RUN.abort) RUN.abort.abort();
    if (RUN.decision) resolveDecision({ action: "reject", reason: "Stopped by the user.", stop: true });
    showToast(PY.state === "running" ? "⏹ Stopping after the running step finishes…" : "⏹ Stopping…");
}

function killInterpreter() {
    if (PY.state === "running") {
        RUN.stopRequested = false;
        rejectAllPending("killed");
        restartInterpreter();
        showToast("☠️ Step killed — the interpreter is restarting.");
    } else {
        restartInterpreter();
        if (S.task) RUN.modelNotes.push("The interpreter was restarted by the user: variables are lost, files are intact.");
        showToast("🔄 Interpreter restarting.");
    }
}

async function rewindTo(idx) {
    const item = S.timeline[idx];
    if (!item || !Number.isInteger(item.checkpoint) || !CHECKPOINTS[item.checkpoint]) return;
    if (RUN.active) { showToast("Stop the agent before rewinding."); return; }
    const label = item.type === "task" ? "the start of the task" : `step ${item.n}`;
    if (!(await confirmDialog(`Rewind to ${label}? Everything after it is removed from the timeline, the workspace is restored to that point, and the interpreter restarts.`, "⏪ Rewind"))) return;
    const ci = item.checkpoint;
    const cp = CHECKPOINTS[ci];
    S.timeline.length = cp.timelineLength;
    // A checkpoint from before a compaction: bring back the history it replaced (with
    // today's system prompt, which Settings may have changed since).
    if ((cp.epoch || 0) < S.compactions.length) {
        const system = S.messages[0];
        S.messages = S.compactions[cp.epoch || 0].before.map(copyMessage);
        if (system && system.role === "system" && S.messages[0].role === "system") S.messages[0] = system;
        S.compactions.length = cp.epoch || 0;
    }
    S.messages.length = cp.msgCount;
    S.stepCount = cp.stepCount;
    CHECKPOINTS = CHECKPOINTS.slice(0, ci + 1);
    WS.files = new Map(Object.entries(cp.files).map(([p, f]) => [p, { hash: f.hash, origin: f.origin }]));
    WS.version++;
    WS.lastChanged = new Set();
    collectGarbage();
    RUN.modelNotes = ["The session was rewound to this point and the interpreter was restarted: variables are lost, files are as they were at this point."];
    RUN.compactAfter = 0;
    RUN.compactNext = false;
    RUN.listedKey = "";
    restartInterpreter();
    addNote(`⏪ Rewound to ${label}. ` + (awaitsModel(S.messages) ? "Press Continue to resume, or send a note first." : "Send a follow-up to continue."));
    setStatus("paused");
    renderTimeline();
    renderWorkspace();
}

// ========== 9. UI ==========
const $ = (id) => document.getElementById(id);

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

function renderMarkdown(text) {
    const html = DOMPurify.sanitize(marked.parse(String(text || "")));
    const div = document.createElement("div");
    div.className = "markdown";
    div.innerHTML = html;
    div.querySelectorAll("pre code").forEach((el) => { try { hljs.highlightElement(el); } catch (e) { /* unknown language */ } });
    return div;
}

function highlightedCode(code, lang) {
    const pre = document.createElement("pre");
    const el = document.createElement("code");
    el.className = "hljs language-" + lang;
    try { el.innerHTML = hljs.highlight(String(code || ""), { language: lang, ignoreIllegals: true }).value; }
    catch (e) { el.textContent = code; }
    pre.appendChild(el);
    return pre;
}

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
}

function button(label, action, idx, cls, title) {
    const b = el("button", "card-btn " + (cls || ""), label);
    b.type = "button";
    b.dataset.action = action;
    if (idx !== undefined) b.dataset.idx = idx;
    if (title) b.title = title;
    return b;
}

const VERDICT_LABELS = { auto: "✅ auto-committed", approved: "👍 approved", edited: "✏️ edited & approved", rejected: "↩️ rejected", "rolled back": "↩️ rolled back", "approved (network)": "🌐 approved with network" };
const STATUS_LABELS = { unverified: "⚠️ files missing", ok: "ok", error: "error", timeout: "⏱ timeout", killed: "☠️ killed", crashed: "💥 crashed", rejected: "rejected", cutoff: "✂️ cut off", empty: "empty reply", broken: "unclosed code", mixed: "mixed reply", toolcall: "tool call", fakeobs: "no action", interrupted: "interrupted", textaction: "no tool call", badcall: "bad tool call" };

function renderThink(item, card, streaming) {
    if (!item.reasoning) return;
    const prev = card && card.querySelector("details.think-block");
    const d = el("details", "think-block" + (streaming ? " thinking-active" : ""));
    if (prev ? prev.open : false) d.open = true;
    d.appendChild(el("summary", "", streaming ? "🧠 Thinking…" : `🧠 Reasoning (${item.reasoning.length.toLocaleString()} chars)`));
    d.appendChild(el("div", "think-content", item.reasoning));
    return d;
}

const FILE_ACTION_ICONS = { read_file: "📄", write_file: "✍️", edit_file: "✏️" };
const FILE_ACTION_VERBS = { read_file: "read", write_file: "write", edit_file: "edit" };

// One row per file action; edits expand to their old/new text (as text, never HTML).
function renderFileActions(actions) {
    const ul = el("ul", "file-actions");
    for (const a of actions || []) {
        const li = el("li", "file-action" + (a.ok ? "" : " is-error"));
        li.appendChild(el("span", "file-action-icon", a.ok ? FILE_ACTION_ICONS[a.tool] || "•" : "❌"));
        li.appendChild(el("span", "file-action-verb", FILE_ACTION_VERBS[a.tool] || a.tool));
        li.appendChild(el("code", "file-action-path", a.path || "?"));
        li.appendChild(el("span", "file-action-msg", a.message));
        if ((a.edits || []).length) {
            const d = el("details", "file-edits");
            d.appendChild(el("summary", "", a.edits.length === 1 ? "Show the change" : `Show the ${a.edits.length} changes`));
            for (const e of a.edits) {
                const pair = el("div", "edit-pair");
                pair.appendChild(el("pre", "edit-old", e.old));
                pair.appendChild(el("pre", "edit-new", e.new || "(deleted)"));
                d.appendChild(pair);
            }
            li.appendChild(d);
        }
        ul.appendChild(li);
    }
    return ul;
}

// "+3 −1" for a modified text file whose two versions are still held, else "". Cached:
// cards re-render often and the versions never change.
const DIFF_STAT_CACHE = new Map();
function diffStatLabel(prevHash, hash) {
    const key = prevHash + ">" + hash;
    if (DIFF_STAT_CACHE.has(key)) return DIFF_STAT_CACHE.get(key);
    const a = WS.blobs.get(prevHash), b = WS.blobs.get(hash);
    if (!a || !b || a.length + b.length > 512 * 1024) return "";
    const ta = decodeTextFile(a), tb = decodeTextFile(b);
    const label = ta === null || tb === null ? "" : (({ added, removed }) => `+${added} −${removed}`)(diffHunks(lineDiff(ta, tb), 0));
    DIFF_STAT_CACHE.set(key, label);
    return label;
}

function renderFileChips(changes, idx) {
    const wrap = el("div", "effect");
    const list = [
        ...(changes.added || []).map(f => ["+", "added", f.path, f.hash, ""]),
        ...(changes.modified || []).map(f => ["~", "modified", f.path, f.hash, f.prevHash]),
        ...(changes.deleted || []).map(f => ["−", "deleted", f.path, f.prevHash, ""]),
    ];
    wrap.appendChild(el("span", "effect-label", list.length ? "Files:" : "Files: no changes"));
    for (const [sign, kind, path, hash, prevHash] of list) {
        const b = el("button", "file-chip " + kind, `${sign} ${path}`);
        b.type = "button";
        b.dataset.action = "view-file";
        b.dataset.path = path;
        b.dataset.hash = hash || "";
        if (prevHash) {
            b.dataset.prev = prevHash;
            const stat = diffStatLabel(prevHash, hash);
            if (stat) b.appendChild(el("span", "chip-stat", stat));
        }
        b.title = kind === "deleted" ? "View the version before this step" : kind === "modified" ? "View the changes this step made" : "View this version";
        const summary = cachedBinarySummary(hash);
        if (summary) b.title += " — " + summary;
        wrap.appendChild(b);
    }
    return wrap;
}

// "PNG image, 640×480 px, …" for a held binary version, "" for text or a version no
// longer held. Cached: chips re-render often and a version never changes.
const BINARY_SUMMARY_CACHE = new Map();
function cachedBinarySummary(hash) {
    if (!hash) return "";
    if (BINARY_SUMMARY_CACHE.has(hash)) return BINARY_SUMMARY_CACHE.get(hash);
    const bytes = WS.blobs.get(hash);
    if (!bytes) return "";
    const summary = decodeTextFile(bytes) === null ? binarySummary(bytes) : "";
    BINARY_SUMMARY_CACHE.set(hash, summary);
    return summary;
}

// Object URLs of images shown inline, by content hash; revoked once the version is freed.
const IMAGE_URLS = new Map();
function imageUrl(hash, type) {
    let url = IMAGE_URLS.get(hash);
    if (!url) {
        url = URL.createObjectURL(new Blob([WS.blobs.get(hash)], { type }));
        IMAGE_URLS.set(hash, url);
    }
    return url;
}

function pruneImageUrls() {
    for (const [hash, url] of IMAGE_URLS) {
        if (!WS.blobs.has(hash)) { URL.revokeObjectURL(url); IMAGE_URLS.delete(hash); }
    }
    for (const hash of BINARY_SUMMARY_CACHE.keys()) if (!WS.blobs.has(hash)) BINARY_SUMMARY_CACHE.delete(hash);
}

function imageType(path) {
    return IMAGE_TYPES[(path.split(".").pop() || "").toLowerCase()] || "";
}

// Images a step created or changed, inline on its card (DESIGN §2.1): its captured
// figures first, then the rest, while their versions are held. An <img> never runs
// scripts, SVG included.
function renderStepImages(item) {
    const ch = item.changes;
    if (!ch) return null;
    const figs = new Map((item.figures || []).map(f => [f.path, f]));
    const list = [...(ch.added || []), ...(ch.modified || [])]
        .filter(f => imageType(f.path) && WS.blobs.has(f.hash))
        .sort((a, b) => figs.has(b.path) - figs.has(a.path));
    if (!list.length) return null;
    const wrap = el("div", "step-images" + (list.length === 1 ? " single" : ""));
    for (const f of list.slice(0, LIMITS.stepImagesMax)) {
        const fig = figs.get(f.path);
        const b = el("button", "step-image");
        b.type = "button";
        b.dataset.action = "view-file";
        b.dataset.path = f.path;
        b.dataset.hash = f.hash;
        if (f.prevHash) b.dataset.prev = f.prevHash;
        b.title = `Open ${f.path}`;
        const img = el("img");
        img.src = imageUrl(f.hash, imageType(f.path));
        img.alt = fig ? `Figure ${f.path}` : f.path;
        img.decoding = "async";
        b.appendChild(img);
        b.appendChild(el("span", "step-image-caption", f.path + (fig ? (fig.how === "show" ? " · plt.show()" : " · open figure") : "")));
        wrap.appendChild(b);
    }
    if (list.length > LIMITS.stepImagesMax) wrap.appendChild(el("p", "hint", `${list.length - LIMITS.stepImagesMax} more image${list.length - LIMITS.stepImagesMax === 1 ? "" : "s"} in the file list above.`));
    return wrap;
}

// A unified line diff, as text in the DOM (never HTML). At most maxRows lines are drawn.
function renderDiffView(oldText, newText, maxRows = 4000) {
    const wrap = el("div", "diff-view");
    const { hunks, added, removed } = diffHunks(lineDiff(oldText, newText), 3);
    wrap.appendChild(el("p", "hint diff-stat", hunks.length ? `${added} line${added === 1 ? "" : "s"} added, ${removed} removed` : "No line differs: only invisible bytes (line endings, encoding marks) changed."));
    if (!hunks.length) return wrap;
    const pre = el("pre", "diff");
    let rows = 0;
    for (const h of hunks) {
        if (rows >= maxRows) break;
        pre.appendChild(el("span", "diff-line diff-hunk", `@@ line ${h.oldStart} → ${h.newStart} @@`));
        for (const l of h.lines) {
            if (rows++ >= maxRows) break;
            const row = el("span", "diff-line diff-" + (l.op === "+" ? "add" : l.op === "-" ? "del" : "ctx"));
            row.append(el("span", "diff-no", l.oldNo ? String(l.oldNo) : ""), el("span", "diff-no", l.newNo ? String(l.newNo) : ""), el("span", "diff-sign", l.op), el("span", "diff-text", l.text));
            pre.appendChild(row);
        }
    }
    wrap.appendChild(pre);
    if (rows >= maxRows) wrap.appendChild(el("p", "hint", `Showing the first ${maxRows.toLocaleString("en-US")} diff lines.`));
    return wrap;
}

function buildStepCard(item, idx, old) {
    const card = el("article", "card step-card phase-" + (item.phase || "done"));
    const head = el("div", "card-head");
    head.appendChild(el("span", "card-title", item.kind === "final" ? (item.status === "unverified" ? "↩️ Answer sent back" : "✅ Final answer") : item.kind === "ask" ? "❓ Question" : `Step ${item.n}`));
    if (item.status && STATUS_LABELS[item.status]) head.appendChild(el("span", "badge status-" + item.status, STATUS_LABELS[item.status]));
    if (item.decision) head.appendChild(el("span", "badge verdict-" + item.decision.replace(/\W+/g, "-"), (VERDICT_LABELS[item.decision] || item.decision) + (item.decidedBy === "user" && item.decision !== "auto" ? " by you" : "")));
    if (item.phase === "thinking") head.appendChild(el("span", "badge live", "streaming…"));
    if (item.phase === "running") head.appendChild(el("span", "badge live", "running…"));
    if (item.phase === "pending-run" || item.phase === "pending-approval") head.appendChild(el("span", "badge waiting", "⏸ waiting for you"));
    if (item.protocol === "tools") {
        const b = head.appendChild(el("span", "badge protocol", "🔧"));
        b.title = "The model acted through native tool calls";
    }
    card.appendChild(head);

    const think = renderThink(item, old, item.phase === "thinking" && !item.content);
    if (think) card.appendChild(think);

    card.dataset.retry = item._retry ? String(item._retry.n) : "";
    card.dataset.calling = item._calling || "";
    if (item.phase === "thinking") {
        if (item._retry) card.appendChild(el("p", "hint retry-hint", `🔌 No answer from the endpoint (${item._retry.error}). Retrying automatically (attempt ${item._retry.n}); the status bar counts down, and Stop ends the wait.`));
        if (item.content) card.appendChild(renderMarkdown(item.content));
        if (item._calling) card.appendChild(el("p", "hint calling-hint", `🔧 calling ${item._calling}…`));
        return card;
    }
    if (item.kind === "final") {
        card.appendChild(renderMarkdown(item.content));
        if ((item.notes || []).length) card.appendChild(el("p", "hint", "⚠️ " + item.notes.join(" ")));
        return finishCard(card, item, idx);
    }
    if (item.kind === "ask") {
        if (item.prose) card.appendChild(renderMarkdown(item.prose));
        card.appendChild(renderMarkdown("**" + (item.question || "") + "**"));
        if (S.status === "awaiting-user" && idx === lastStepIndex()) card.appendChild(el("p", "hint", "Answer in the box below."));
        return finishCard(card, item, idx);
    }
    if (item.prose) card.appendChild(renderMarkdown(item.prose));
    if (item.kind === "files") card.appendChild(renderFileActions(item.fileActions));
    if (item.proposedCode !== undefined && item.proposedCode !== "") {
        if (item.phase === "pending-run") {
            card.appendChild(el("label", "field-label", "Proposed code — edit it before running if you like (Tab indents, Ctrl+Enter runs):"));
            card.appendChild(codeEditor(item, item.proposedCode));
        } else {
            card.appendChild(highlightedCode(item.edited && item.ranCode ? item.ranCode : item.proposedCode, "python"));
            if (item.edited) {
                const d = el("details", "file-edits");
                d.appendChild(el("summary", "", "✏️ Edited by you before it ran — show what you changed"));
                d.appendChild(renderDiffView(item.proposedCode, item.ranCode || ""));
                card.appendChild(d);
            }
        }
    }
    if (item.kind === "code" && item.output !== undefined && item.phase !== "pending-run" && item.phase !== "running") {
        const out = String(item.output || "");
        const pre = el("pre", "output" + (item.status === "error" ? " is-error" : ""));
        pre.textContent = out.length > 200000 ? out.slice(0, 200000) + "\n[… display truncated; the full output is in the session export …]" : (out || "(no output)");
        card.appendChild(pre);
    } else if (item.kind === "files") {
        // The model's view of the step: read contents and messages, collapsed.
        if (item.output) {
            const d = el("details", "file-result");
            d.appendChild(el("summary", "", item.phase === "pending-approval" ? "What the agent gets back if you approve" : "What the agent got back"));
            d.appendChild(el("pre", "output", item.output));
            card.appendChild(d);
        }
    } else if (item.kind !== "code" && item.status) {
        card.appendChild(el("p", "hint", { cutoff: "✂️ The reply was cut off before it finished — nothing ran.", empty: "The reply was empty — nothing ran.", broken: "The reply had an unclosed code block or file tag — nothing ran.", mixed: "The reply mixed file actions with a code block — nothing ran.", toolcall: "The reply used a tool-call tag, which isn't how actions work here — nothing ran.", fakeobs: "The reply wrote its own <observation> instead of acting — nothing ran.", textaction: "The reply put code or file actions in its text instead of calling a tool — nothing ran.", badcall: "None of the reply's tool calls could run — nothing ran." }[item.status] || ""));
    }
    if ((item.skippedCalls || []).length) {
        const ul = el("ul", "step-notes skipped-calls");
        for (const line of item.skippedCalls) ul.appendChild(el("li", "", "🔧 " + line));
        card.appendChild(ul);
    }
    if (item.changes) card.appendChild(renderFileChips(item.changes, idx));
    const images = item.phase !== "running" ? renderStepImages(item) : null;
    if (images) card.appendChild(images);
    const shownNotes = (item.notes || []).filter(n => !n.startsWith("The user edited your code"));
    if (shownNotes.length) {
        const ul = el("ul", "step-notes");
        for (const n of shownNotes) ul.appendChild(el("li", "", n));
        card.appendChild(ul);
    }
    if (item.rejectReason) card.appendChild(el("p", "hint", "Reason given: " + item.rejectReason));
    if (item.fileListSent) card.appendChild(el("p", "hint", `📋 The agent also got the current file list (${item.fileListSent} file${item.fileListSent === 1 ? "" : "s"}), as every ${LIMITS.fileListEvery} steps when the workspace changed.`));

    if (item.phase === "pending-run" || item.phase === "pending-approval") {
        const box = el("div", "decision");
        if (item.phase === "pending-approval" && item.kind === "files") {
            const reasons = item.risk && item.risk.reasons.length ? item.risk.reasons : null;
            box.appendChild(el("p", "decision-why", (reasons ? "⚠️ Held for your approval: this step " + reasons.join("; ") + "." : "⏸ Approve each step is on.") + " Nothing is applied or sent to the agent until you approve; rejecting discards it."));
        } else if (item.phase === "pending-approval") {
            box.appendChild(el("p", "decision-why", "⚠️ Held for your approval: this step " + (item.risk ? item.risk.reasons.join("; ") : "needs review") + ". Its effects are applied only if you approve; rejecting rolls them back."));
        }
        const reason = el("input", "reason-input");
        reason.dataset.role = "reason";
        reason.placeholder = "Reason (optional, sent to the agent)";
        const row = el("div", "decision-row");
        if (item.phase === "pending-run") {
            row.appendChild(button("▶ Run", "run", idx, "primary"));
            if (item._draft !== undefined && item._draft !== item.proposedCode) row.appendChild(button("↺ Reset", "reset-code", idx, "", "Discard your edits and go back to the agent's code"));
        } else {
            row.appendChild(button("✅ Approve", "approve", idx, "primary"));
            // A file step has nothing to re-run: nothing has been applied yet.
            if (item.kind !== "files") {
                if ((item.netAttempts || []).length) row.appendChild(button("🌐 Allow network & re-run", "rerun-net", idx, "", "Roll back, restart the interpreter and run the same code with network access"));
                row.appendChild(button("✏️ Edit & re-run", "edit-open", idx, "", "Roll back and run your edited version instead"));
            }
        }
        row.appendChild(button("↩️ Reject", "reject", idx, "danger"));
        box.appendChild(row);
        box.appendChild(reason);
        if (item.phase === "pending-approval" && item._editing) {
            box.appendChild(codeEditor(item, item.ranCode || item.proposedCode));
            box.appendChild(button("▶ Run edited code", "edit", idx, "primary"));
        }
        card.appendChild(box);
    }
    return finishCard(card, item, idx);
}

// The editable code of a step waiting for you: your draft survives re-renders.
function codeEditor(item, original) {
    const ta = el("textarea", "code-edit");
    ta.dataset.role = "code-edit";
    ta.value = item._draft !== undefined ? item._draft : original;
    ta.spellcheck = false;
    ta.setAttribute("aria-label", "Code to run");
    ta.rows = Math.min(24, Math.max(4, ta.value.split("\n").length + 1));
    return ta;
}

function renderStepStats(stats) {
    const entries = formatStepStats(stats);
    if (!entries.length) return null;
    const box = el("div", "step-stats");
    box.setAttribute("aria-label", "Model stats for this step");
    for (const e of entries) {
        const it = el("span", "stat-item");
        it.title = e.title;
        it.appendChild(el("span", "stat-label", e.label));
        it.appendChild(el("span", "stat-value", e.value));
        if (e.meter !== undefined) {
            const bar = el("span", "stat-meter");
            const fill = el("span", "stat-meter-fill" + (e.meter >= 0.85 ? " is-high" : ""));
            fill.style.width = (e.meter * 100).toFixed(1) + "%";
            bar.appendChild(fill);
            it.appendChild(bar);
        }
        box.appendChild(it);
    }
    return box;
}

function finishCard(card, item, idx) {
    if (item.type === "step") {
        if (item.retryNote) card.appendChild(el("p", "hint", item.retryNote));
        const stats = renderStepStats(item.stats);
        if (stats) card.appendChild(stats);
    }
    if (Number.isInteger(item.checkpoint) && (item.type !== "step" || item.phase === "done") && !RUN.active) {
        const foot = el("div", "card-foot");
        if (CHECKPOINTS[item.checkpoint]) foot.appendChild(button("⏪ Rewind to here", "rewind", idx, "ghost", "Restore the workspace and history as of this point"));
        else foot.appendChild(el("span", "hint", "⏪ Rewind unavailable: this checkpoint was dropped to save memory."));
        card.appendChild(foot);
    }
    return card;
}

function lastStepIndex() {
    for (let i = S.timeline.length - 1; i >= 0; i--) if (S.timeline[i].type === "step") return i;
    return -1;
}

function buildCard(item, idx, old) {
    if (item.type === "step") return buildStepCard(item, idx, old);
    if (item.type === "task") {
        const card = el("article", "card task-card");
        card.appendChild(el("div", "card-head")).appendChild(el("span", "card-title", "🎯 Task"));
        card.appendChild(el("p", "task-text", item.text));
        if (item.files && item.files.length) card.appendChild(el("p", "hint", "Workspace at start: " + item.files.join(", ")));
        return finishCard(card, item, idx);
    }
    if (item.type === "user") {
        const card = el("article", "card user-card");
        const head = card.appendChild(el("div", "card-head"));
        head.appendChild(el("span", "card-title", { answer: "💬 Your answer", followup: "💬 Follow-up", guidance: "📝 Your note" }[item.kind] || "💬 You"));
        if (item._queued) head.appendChild(el("span", "badge waiting", "queued"));
        card.appendChild(el("p", "task-text", item.text));
        if (item._queued) {
            const row = el("div", "card-foot");
            row.appendChild(el("span", "hint", RUN.requesting ? "Goes out with the next request, once the model's current reply is done." : "Goes out with the next request."));
            if (RUN.requesting) row.appendChild(button("⚡ Send now", "send-now", idx, "", "Abort the model's current reply and ask again with your note included"));
            card.appendChild(row);
        }
        return card;
    }
    if (item.type === "compaction") {
        const card = el("article", "card compaction-card");
        card.appendChild(el("div", "card-head")).appendChild(el("span", "card-title", "🗜️ History compacted"));
        const k = (v) => (v >= 1000 ? (v / 1000).toFixed(1) + "k" : String(v));
        const why = { overflow: "after the server refused the prompt as too long", context: "after a reply ran out of context", manual: "on request" }[item.reason] || "as it neared the context limit";
        card.appendChild(el("p", "hint", `Steps ${item.fromStep}–${item.toStep} were summarised for the model ${why} (~${k(item.tokensBefore)} → ~${k(item.tokensAfter)} tokens). The timeline keeps the full record, and rewinding to an earlier step restores the full history.`));
        const d = el("details", "think-block");
        d.appendChild(el("summary", "", "📝 Summary the model continues from"));
        d.appendChild(renderMarkdown(item.summary));
        card.appendChild(d);
        return card;
    }
    if (item.type === "error") {
        const card = el("article", "card error-card");
        card.appendChild(el("p", "error-text", "❌ " + item.text));
        if (item.hint) card.appendChild(el("p", "hint", item.hint));
        if (idx === S.timeline.length - 1 && !RUN.active) card.appendChild(button("🔁 Retry", "retry", idx, "primary"));
        return card;
    }
    const card = el("article", "card note-card tone-" + (item.tone || "info"));
    card.appendChild(el("p", "", item.text));
    if (item.limit && idx === S.timeline.length - 1 && atStepLimit()) {
        const row = el("div", "more-steps");
        const label = el("label", "more-steps-label", "Run ");
        const input = el("input", "more-steps-input");
        input.type = "number"; input.min = "1"; input.max = "500"; input.step = "1";
        input.value = String(RUN.moreSteps);
        input.dataset.role = "more-steps";
        input.setAttribute("aria-label", "How many more steps to allow");
        label.append(input, " more steps");
        row.append(label, button("⏯ Continue", "continue", idx, "primary", "Allow this many more steps"));
        card.appendChild(row);
    }
    return card;
}

// While a reply streams, the card is patched in place: rebuilding it on every chunk
// replayed its entry animation and reset the reasoning box's scroll position, which
// made the timeline flicker.
function patchStreamingCard(card, item) {
    if ((card.dataset.retry || "") !== (item._retry ? String(item._retry.n) : "")) return false;
    if ((card.dataset.calling || "") !== (item._calling || "")) return false;
    const thinking = !item.content;
    const think = card.querySelector(":scope > details.think-block");
    if (item.reasoning) {
        if (!think) return false;   // first reasoning chunk: rebuild once to create the box
        const box = think.querySelector(".think-content");
        const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
        if (box.textContent !== item.reasoning) box.textContent = item.reasoning;
        if (atBottom) box.scrollTop = box.scrollHeight;
        think.classList.toggle("thinking-active", thinking);
        think.querySelector("summary").textContent = thinking ? "🧠 Thinking…" : `🧠 Reasoning (${item.reasoning.length.toLocaleString()} chars)`;
    }
    const md = card.querySelector(":scope > .markdown");
    if (item.content) {
        const fresh = renderMarkdown(item.content);
        if (md) md.replaceWith(fresh); else card.appendChild(fresh);
    }
    return true;
}

// isNew: the item was just added, so its card gets the entry animation. Re-renders of
// an existing card never animate.
function renderTimelineItem(idx, isNew) {
    const tl = $("timeline");
    const item = S.timeline[idx];
    if (!tl || !item) return;
    const old = tl.querySelector(`[data-idx="${idx}"]`);
    const nearBottom = tl.scrollHeight - tl.scrollTop - tl.clientHeight < 120;
    const phase = item.type === "step" ? item.phase || "" : "";
    if (!(old && phase === "thinking" && old.dataset.phase === "thinking" && patchStreamingCard(old, item))) {
        const card = buildCard(item, idx, old);
        card.dataset.idx = idx;
        card.dataset.phase = phase;
        if (isNew && !old) card.classList.add("is-new");
        if (old) old.replaceWith(card);
        else tl.appendChild(card);
    }
    $("emptyState")?.remove();
    if (isNew || nearBottom) tl.scrollTop = tl.scrollHeight;
}

function renderTimeline() {
    const tl = $("timeline");
    tl.querySelectorAll("[data-idx]").forEach(n => n.remove());
    if (!S.timeline.length) {
        if (!$("emptyState")) tl.appendChild(buildEmptyState());
        return;
    }
    for (let i = 0; i < S.timeline.length; i++) renderTimelineItem(i);
}

function buildEmptyState() {
    const d = el("div", "empty-state");
    d.id = "emptyState";
    d.innerHTML = `<h2>Hand the agent a task.</h2>
        <p>It writes Python, runs it in a sandboxed interpreter in this tab, looks at the result and repeats until the task is done. You watch every step: harmless steps run on their own, risky ones wait for you, and any step can be rewound.</p>
        <p class="hint">Add files to the workspace on the right, describe the task below, and press Start. Nothing is stored: export the session to keep it.</p>`;
    return d;
}

// ---------- Workspace panel ----------
function buildTree(paths) {
    const root = { dirs: new Map(), files: [] };
    for (const p of paths) {
        const parts = p.split("/");
        let node = root;
        for (const dir of parts.slice(0, -1)) {
            if (!node.dirs.has(dir)) node.dirs.set(dir, { dirs: new Map(), files: [] });
            node = node.dirs.get(dir);
        }
        node.files.push(p);
    }
    return root;
}

function deleteButton(path, isDir) {
    const d = el("button", "ws-del", "🗑");
    d.type = "button";
    d.dataset.action = "delete-path";
    d.dataset.path = path;
    if (isDir) d.dataset.dir = "1";
    d.title = `Delete ${isDir ? "the folder " : ""}${path}`;
    d.setAttribute("aria-label", d.title);
    return d;
}

function renderTreeNode(node, ul, prefix) {
    for (const [name, child] of [...node.dirs].sort((a, b) => a[0].localeCompare(b[0]))) {
        const li = el("li", "ws-dir");
        const det = el("details");
        det.open = true;
        const sum = el("summary");
        const label = el("span", "ws-dir-label", "📁 " + name);
        label.appendChild(deleteButton((prefix || "") + name, true));
        sum.appendChild(label);
        det.appendChild(sum);
        const sub = el("ul");
        renderTreeNode(child, sub, (prefix || "") + name + "/");
        det.appendChild(sub);
        li.appendChild(det);
        ul.appendChild(li);
    }
    for (const p of node.files.sort((a, b) => a.localeCompare(b))) {
        const f = WS.files.get(p);
        const li = el("li", "ws-file" + (WS.lastChanged.has(p) ? " changed" : ""));
        const b = el("button", "ws-file-btn");
        b.type = "button";
        b.dataset.action = "view-file";
        b.dataset.path = p;
        b.dataset.hash = f.hash;
        b.appendChild(el("span", "ws-name", p.split("/").pop()));
        b.appendChild(el("span", "ws-size", formatBytes((WS.blobs.get(f.hash) || []).length)));
        b.appendChild(el("span", "origin origin-" + f.origin, f.origin === "user" ? "yours" : "agent"));
        b.title = `${p} — ${f.origin === "user" ? "your file (changes to it need approval)" : "created by the agent"}`;
        li.appendChild(b);
        li.appendChild(deleteButton(p, false));
        ul.appendChild(li);
    }
}

function renderWorkspace() {
    const tree = $("wsTree");
    if (!tree) return;
    pruneImageUrls();
    renderStatusBar();
    tree.innerHTML = "";
    if (!WS.files.size) {
        tree.appendChild(el("p", "hint ws-empty", "Empty. Drop files or folders here, or use the buttons above."));
    } else {
        const ul = el("ul", "ws-root");
        renderTreeNode(buildTree([...WS.files.keys()]), ul);
        tree.appendChild(ul);
    }
    $("wsSummary").textContent = `${WS.files.size} file${WS.files.size === 1 ? "" : "s"} · ${formatBytes(workspaceSize())}`;
}

// ---------- File viewer ----------
const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml" };
const HL_LANGS = { py: "python", js: "javascript", mjs: "javascript", ts: "typescript", json: "json", md: "markdown", html: "xml", xml: "xml", css: "css", csv: "plaintext", sh: "bash", yml: "yaml", yaml: "yaml", java: "java", c: "c", h: "c", cpp: "cpp", rs: "rust", go: "go", sql: "sql", toml: "ini", ini: "ini", txt: "plaintext" };
let viewerUrls = [];

// An object URL for one viewer image; all of them are revoked when the viewer reopens.
function viewerImageUrl(bytes, type) {
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    viewerUrls.push(url);
    return url;
}

// prevHash: the version before a step changed the file. When it is held, the viewer opens
// on the changes — a line diff for text, both versions side by side for binaries — with
// tabs for either version.
function openViewer(path, hash, prevHash) {
    const bytes = WS.blobs.get(hash);
    const body = $("viewerBody");
    body.innerHTML = "";
    $("viewerTitle").textContent = path;
    const tabs = $("viewerTabs");
    tabs.replaceChildren();
    tabs.hidden = true;
    for (const u of viewerUrls) URL.revokeObjectURL(u);
    viewerUrls = [];
    if (!bytes) {
        $("viewerMeta").textContent = "This version is no longer held in memory (it was rolled back or rewound away).";
        $("viewerDownload").disabled = true;
        openModal("viewerModal");
        return;
    }
    $("viewerDownload").disabled = false;
    $("viewerDownload").onclick = () => downloadBytes(bytes, path.split("/").pop());
    const f = WS.files.get(path);
    const kind = cachedBinarySummary(hash) || formatBytes(bytes.length);
    const meta = `${kind}${f && f.hash === hash ? " · " + (f.origin === "user" ? "your file" : "created by the agent") : " · an earlier version"}`;
    $("viewerMeta").textContent = meta;
    const prev = prevHash ? WS.blobs.get(prevHash) : null;
    if (prevHash && !prev) $("viewerMeta").textContent = meta + " · the version before this step is no longer held, so there is no comparison";
    if (prev) {
        const oldText = decodeTextFile(prev), newText = decodeTextFile(bytes);
        const views = [["changes", "± Changes"], ["after", "This version"], ["before", "Before"]];
        const show = (which) => {
            for (const b of tabs.children) b.setAttribute("aria-selected", b.dataset.view === which ? "true" : "false");
            body.innerHTML = "";
            if (which === "changes") body.appendChild(oldText !== null && newText !== null ? renderDiffView(oldText, newText) : renderBinaryChange(path, prev, bytes));
            else renderFileBody(body, path, which === "after" ? bytes : prev);
            $("viewerDownload").onclick = () => downloadBytes(which === "before" ? prev : bytes, path.split("/").pop());
        };
        for (const [view, label] of views) {
            const b = el("button", "viewer-tab", label);
            b.type = "button";
            b.setAttribute("role", "tab");
            b.dataset.view = view;
            b.onclick = () => show(view);
            tabs.appendChild(b);
        }
        tabs.hidden = false;
        show("changes");
        openModal("viewerModal");
        return;
    }
    renderFileBody(body, path, bytes);
    openModal("viewerModal");
}

// A changed binary file: both versions side by side, as images when they are, each with
// its summary.
function renderBinaryChange(path, before, after) {
    const wrap = el("div", "binary-change");
    for (const [label, bytes] of [["Before", before], ["This version", after]]) {
        const side = el("div", "binary-side");
        side.appendChild(el("p", "binary-side-label", label));
        if (imageType(path)) {
            const img = el("img", "viewer-img");
            img.src = viewerImageUrl(bytes, imageType(path));
            img.alt = `${path} (${label.toLowerCase()})`;
            side.appendChild(img);
        }
        side.appendChild(el("p", "hint", decodeTextFile(bytes) === null ? binarySummary(bytes) : `text, ${formatBytes(bytes.length)}`));
        wrap.appendChild(side);
    }
    if (before.length === after.length && before.every((x, i) => x === after[i])) wrap.appendChild(el("p", "hint", "Both versions are identical."));
    return wrap;
}

// One file version in the viewer: an image, highlighted text, or a binary's summary (with
// a zip's entries) and the start of a hex dump.
function renderFileBody(body, path, bytes) {
    const ext = (path.split(".").pop() || "").toLowerCase();
    if (IMAGE_TYPES[ext]) {
        // An <img> never runs scripts, SVG included.
        const img = el("img", "viewer-img");
        img.src = viewerImageUrl(bytes, IMAGE_TYPES[ext]);
        img.alt = path;
        body.appendChild(img);
        return;
    }
    const text = decodeTextFile(bytes);
    if (text !== null) {
        const shown = text.length > 500000 ? text.slice(0, 500000) : text;
        const lang = HL_LANGS[ext];
        if (lang && lang !== "plaintext" && shown.length < 300000) body.appendChild(highlightedCode(shown, lang));
        else { const pre = el("pre", "viewer-text"); pre.textContent = shown; body.appendChild(pre); }
        if (shown.length < text.length) body.appendChild(el("p", "hint", "Showing the first 500,000 characters. Download the file to see all of it."));
        return;
    }
    const d = describeBinary(bytes);
    const box = el("div", "binary-summary");
    box.appendChild(el("p", "binary-type", d.type));
    if (d.details.length) box.appendChild(el("p", "hint", d.details.join(" · ")));
    const cd = bytes[0] === 0x50 && bytes[1] === 0x4B ? zipCentralDirectory(bytes, 200) : null;   // "PK": a zip
    if (cd && cd.entries.length) {
        const list = el("pre", "viewer-text zip-list");
        list.textContent = cd.entries.map(e => `${formatBytes(e.size).padStart(10)}  ${e.name}`).join("\n") + (cd.count > cd.entries.length ? `\n… ${cd.count - cd.entries.length} more` : "");
        box.appendChild(list);
    }
    body.appendChild(box);
    const pre = el("pre", "viewer-text");
    const head = bytes.subarray(0, 512);
    const rows = [];
    for (let i = 0; i < head.length; i += 16) {
        const chunk = head.subarray(i, i + 16);
        rows.push(i.toString(16).padStart(6, "0") + "  " + Array.from(chunk, b => b.toString(16).padStart(2, "0")).join(" ").padEnd(48) + "  " + Array.from(chunk, b => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join(""));
    }
    pre.textContent = `First ${head.length} bytes:\n\n` + rows.join("\n");
    body.appendChild(pre);
}

function downloadBytes(bytes, name, type) {
    const url = URL.createObjectURL(new Blob([bytes], { type: type || "application/octet-stream" }));
    const a = el("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---------- Modals ----------
let modalReturnFocus = null;
function openModal(id) {
    modalReturnFocus = document.activeElement;
    const m = $(id);
    m.classList.add("active");
    const first = m.querySelector("input, select, textarea, button");
    if (first) first.focus();
}
function closeModal(id) {
    $(id).classList.remove("active");
    if (modalReturnFocus && modalReturnFocus.focus) modalReturnFocus.focus();
}

// Resolves true (OK), false (Cancel/Escape) or "alt" (the optional third button).
function confirmDialog(text, okLabel, altLabel) {
    return new Promise((resolve) => {
        $("confirmText").textContent = text;
        $("confirmOk").textContent = okLabel || "OK";
        $("confirmAlt").hidden = !altLabel;
        $("confirmAlt").textContent = altLabel || "";
        const done = (v) => { $("confirmOk").onclick = null; $("confirmCancel").onclick = null; $("confirmAlt").onclick = null; closeModal("confirmModal"); resolve(v); };
        $("confirmOk").onclick = () => done(true);
        $("confirmCancel").onclick = () => done(false);
        $("confirmAlt").onclick = () => done("alt");
        openModal("confirmModal");
    });
}

// ---------- Debug console ----------
// A drop-down log of what the agent does: model requests, every tool call (python,
// read_file / write_file / edit_file, final answer, ask), their results and the gate
// decisions. Kept in memory only (never exported), capped, and rendered while open.
const DEBUG = { entries: [], max: 1000, filter: "tools" };
const DEBUG_GROUPS = { tools: ["tool", "result", "decision", "error"], model: ["tool", "result", "decision", "error", "model"], all: null };

function debugLog(kind, text, detail) {
    const entry = { ts: new Date(), step: RUN.active && RUN.step ? RUN.step : S.stepCount, kind, text: String(text), detail: detail ? String(detail) : "" };
    DEBUG.entries.push(entry);
    if (DEBUG.entries.length > DEBUG.max) DEBUG.entries.shift();
    const panel = $("debugLog");
    if (panel && $("debugConsole").classList.contains("open") && debugVisible(entry)) {
        const stick = panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 8;
        panel.appendChild(buildDebugLine(entry));
        while (panel.childElementCount > DEBUG.max) panel.removeChild(panel.firstElementChild);
        if (stick) panel.scrollTop = panel.scrollHeight;
    }
}

function debugVisible(entry) {
    const g = DEBUG_GROUPS[DEBUG.filter];
    return !g || g.includes(entry.kind);
}

function buildDebugLine(entry) {
    const line = el("div", "dc-line dc-" + entry.kind);
    const t = entry.ts.toLocaleTimeString([], { hour12: false }) + "." + String(entry.ts.getMilliseconds()).padStart(3, "0");
    const head = el("span", "dc-head", `${t}  #${entry.step}  ${entry.kind.padEnd(8)} ${entry.text}`);
    if (!entry.detail) { line.appendChild(head); return line; }
    const det = document.createElement("details");
    const sum = document.createElement("summary");
    sum.appendChild(head);
    det.append(sum, el("pre", "dc-detail", entry.detail));
    line.appendChild(det);
    return line;
}

function renderDebugLog() {
    const panel = $("debugLog");
    panel.replaceChildren(...DEBUG.entries.filter(debugVisible).map(buildDebugLine));
    if (!panel.childElementCount) panel.appendChild(el("div", "dc-empty", "Nothing logged yet. Tool calls show up here as the agent works."));
    panel.scrollTop = panel.scrollHeight;
}

function setDebugConsole(open) {
    $("debugConsole").classList.toggle("open", open);
    $("debugConsole").setAttribute("aria-hidden", open ? "false" : "true");
    $("debugBtn").classList.toggle("active", open);
    $("debugBtn").setAttribute("aria-pressed", open ? "true" : "false");
    if (open) renderDebugLog();
}

function clipForDebug(text, max) {
    const s = String(text || "");
    return s.length > max ? s.slice(0, max) + `\n… (${s.length - max} more chars)` : s;
}

// ---------- Status bar, header, composer ----------
function formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

const ACTIVITY_LABELS = { thinking: "model thinking…", writing: "model writing…", python: "running Python", files: "file actions", compacting: "compacting history…", packages: "loading packages…", retrying: "endpoint unreachable, retrying…" };

// The session lives only in this tab (DESIGN §3). A fingerprint of what an export holds:
// it changes with every step, note, file change, rewind and dropped checkpoint, and an
// export (or an import) records it.
let EXPORTED_FP = "";
function sessionFingerprint() {
    return [S.createdAt, S.timeline.length, S.stepCount, S.messages.length, S.compactions.length, WS.version, CHECKPOINTS.length, CP_GEN].join("|");
}

// Would closing the tab lose something? Only uploads (the user has those) don't count.
function hasUnexportedWork() {
    if (RUN.active) return true;
    if (!S.timeline.length && ![...WS.files.values()].some(f => f.origin === "agent")) return false;
    return sessionFingerprint() !== EXPORTED_FP;
}

function markExported() {
    EXPORTED_FP = sessionFingerprint();
    renderStatusBar();
}

// The next request's estimated size, cached while the history doesn't change.
let ctxEstCache = null;
function nextRequestTokens() {
    const last = S.messages[S.messages.length - 1];
    const key = [S.messages.length, last ? last.content.length : 0, S.compactions.length, RUN.tokenRatio].join("|");
    if (!ctxEstCache || ctxEstCache.key !== key) ctxEstCache = { key, tokens: estimateTokens(requestMessages(), RUN.tokenRatio) };
    return ctxEstCache.tokens;
}

// The context size for the current endpoint: the setting, else what its probe found.
function currentContextLimit() {
    return contextLimit(SETTINGS.contextSize, REASONING.key === SETTINGS.apiUrl + "|" + SETTINGS.model ? REASONING.nCtx : 0);
}
const STATE_LABELS = { idle: "ready", running: "working", "awaiting-approval": "waiting for you", "awaiting-user": "question for you", done: "done", stopped: "stopped", paused: "paused", error: "error" };
const INTERP_LABELS = { off: "not started", booting: "booting…", idle: "idle", running: "running", failed: "failed" };

function renderStatusBar() {
    if (!$("statStep")) return;
    // While a run is on, show the step being worked on (the card's number), not the
    // last finished one. The limit is where the run pauses; follow-ups move it on.
    const cur = RUN.active && RUN.step ? RUN.step : S.stepCount;
    $("statStep").textContent = `Step ${cur}${S.stepBudget ? " · pauses at " + S.stepBudget : ""}`;
    $("statStep").title = S.stepBudget
        ? `The agent pauses after step ${S.stepBudget}. Each new instruction or follow-up allows ${SETTINGS.stepLimit} more steps (Settings → Step limit); Continue at the limit allows as many as you choose there (${RUN.moreSteps} last time).`
        : "";
    const active = S.activeMs + (RUN.active ? Date.now() - RUN.activeSince : 0);
    $("statTime").textContent = "⏱ " + formatDuration(active);
    const tok = S.tokens.prompt + S.tokens.completion;
    $("statTokens").textContent = "🔢 " + (tok >= 1000 ? (tok / 1000).toFixed(1) + "k" : tok) + " tokens";
    $("statInterp").textContent = "🐍 Python " + (INTERP_LABELS[PY.state] || PY.state);
    $("statInterp").title = "The Python interpreter. It is idle while the model thinks and busy only while a code step runs, which usually takes well under a second.";
    $("statInterp").dataset.state = PY.state;
    const mem = checkpointMemory();
    $("statMemory").textContent = `🗂️ ${mem.kept} checkpoint${mem.kept === 1 ? "" : "s"} · ${formatBytes(mem.workspaceBytes + mem.olderBytes)}`;
    $("statMemory").title = `File contents held in this tab: the workspace (${formatBytes(mem.workspaceBytes)}) plus older versions kept for rewinding (${formatBytes(mem.olderBytes)} of ${formatBytes(LIMITS.checkpointBudgetBytes)}). Past that, the oldest checkpoints are dropped; the last ${LIMITS.checkpointKeepMin} are always kept.` + (mem.dropped ? ` ${mem.dropped} dropped so far.` : "");
    $("statMemory").dataset.warn = mem.olderBytes > LIMITS.checkpointBudgetBytes * 0.75 || mem.dropped ? "1" : "";
    const label = STATE_LABELS[S.status] || S.status;
    let activity = ACTIVITY_LABELS[RUN.activity] || "";
    if (RUN.retry) activity = `🔌 endpoint unreachable · retry ${RUN.retry.n} in ${Math.max(0, Math.ceil((RUN.retry.at - Date.now()) / 1000))} s`;
    else if (RUN.activity === "packages" && PKG.loading.length) activity = `loading ${PKG.loading.slice(0, 4).join(", ")}${PKG.loading.length > 4 ? " …" : ""}…`;
    $("statState").textContent = S.status === "running" && RUN.active && activity ? `${label} · ${activity}` : label;
    $("statState").title = RUN.retry ? `The last request failed: ${RUN.retry.error}. It is retried automatically for up to ${Math.round(LIMITS.retryWindowMs / 60000)} min; Stop ends the wait.` : "";
    $("statState").dataset.state = RUN.retry ? "retrying" : S.status;

    // Context: the next request's estimated size against the context, and where
    // auto-compaction kicks in.
    const ctx = $("statContext");
    ctx.hidden = !S.task || !S.messages.length;
    if (!ctx.hidden) {
        const limit = currentContextLimit();
        const est = nextRequestTokens();
        const g = contextGauge(est, limit, SETTINGS.autoCompactPct, SETTINGS.maxTokens);
        $("statContextText").textContent = "📏 Context " + g.text;
        $("statContextFill").style.width = (g.frac * 100).toFixed(1) + "%";
        $("statContextMark").hidden = !g.compactAt;
        if (g.compactAt) $("statContextMark").style.left = (g.compactAt / limit * 100).toFixed(1) + "%";
        ctx.dataset.level = g.level;
        ctx.title = limit
            ? `The next request is about ${est.toLocaleString("en-US")} tokens of the ${limit.toLocaleString("en-US")}-token context (estimated from the last request's tokens per character). ` + (g.compactAt ? `Older steps are summarised at ~${Math.round(g.compactAt).toLocaleString("en-US")} tokens (the marker): Auto-compact at ${SETTINGS.autoCompactPct} %, keeping room for a ${Math.min(SETTINGS.maxTokens, limit / 2).toLocaleString("en-US")}-token reply.` : "Auto-compaction is off.")
            : `The next request is about ${est.toLocaleString("en-US")} tokens. The endpoint hasn't reported its context size: set Context size in Settings for a gauge and for auto-compaction before the server refuses a prompt.`;
    }

    const unsaved = hasUnexportedWork() && !RUN.active;
    $("statUnsaved").hidden = !unsaved;
    $("unsavedDot").hidden = !unsaved;
    $("exportBtn").title = unsaved ? "Export the session or the workspace — this session has changes that aren't exported yet" : "Export the session or the workspace";
}

function renderHeader() {
    const remote = describeRemoteEndpoint(SETTINGS.apiUrl);
    let host = SETTINGS.apiUrl;
    try { host = new URL(SETTINGS.apiUrl).host; } catch (e) { /* keep raw */ }
    $("modelBadge").textContent = `🤖 ${SETTINGS.model || "default model"} @ ${host}`;
    $("modelBadge").title = SETTINGS.apiUrl;
    const warn = $("cloudWarning");
    warn.hidden = !remote;
    if (remote) warn.textContent = `☁️ Task text, files the agent prints and its outputs are sent to ${remote}.`;
    const local = $("localBadge");
    local.hidden = !!remote || !SETTINGS.apiUrl;
    local.title = "The endpoint is on this machine or your local network, so the task, file contents the agent reads and its outputs go only there.";
    // How the agent acts with the next request (DESIGN §5.6). Auto is only resolved once
    // the endpoint has been probed: before the first request, or by Test Connection.
    const badge = $("protocolBadge");
    const probed = REASONING.key === SETTINGS.apiUrl + "|" + SETTINGS.model;
    const protocol = SETTINGS.toolMode === "auto" && !probed ? "auto" : currentProtocol();
    badge.dataset.protocol = protocol;
    badge.textContent = { tools: "🔧 native", text: "📝 text", auto: "🔧 auto" }[protocol];
    badge.title = {
        tools: "Native tool calls: the agent acts through the endpoint's OpenAI tools support (run_python, read_file, write_file, edit_file, ask_user, finish).",
        text: "Code blocks and tags: the agent acts by writing ```python blocks and file tags in its replies. Works with any chat model."
            + (probed && REASONING.toolsRejected ? " This endpoint refused native tool calls." : SETTINGS.toolMode === "text" ? " Chosen in Settings → Actions." : " The endpoint doesn't report tool-call support; choose Native in Settings → Actions to use it anyway."),
        auto: "Settings → Actions is Auto: native tool calls if the endpoint reports support, else code blocks and tags. Decided before the first request, or by Test Connection.",
    }[protocol];
}

function updateComposer() {
    const input = $("taskInput");
    const send = $("sendBtn");
    const hasSession = !!S.task;
    $("stopBtn").hidden = !RUN.active;
    $("compactBtn").hidden = RUN.active || !hasSession || !planCompaction(S.messages, 1, 1);
    $("continueBtn").hidden = RUN.active || !hasSession || !["paused", "stopped", "error"].includes(S.status) || (S.messages.length && !awaitsModel(S.messages));
    if (!hasSession) { input.placeholder = "Describe a task… (Ctrl+Enter to start)"; send.textContent = "▶ Start"; }
    else if (RUN.active) { input.placeholder = "Add a note for the agent — it goes out with the next request"; send.textContent = "📝 Add note"; }
    else if (S.status === "awaiting-user") { input.placeholder = "Answer the agent's question…"; send.textContent = "↩️ Answer"; }
    else { input.placeholder = "Follow up, or give new instructions…"; send.textContent = "▶ Send"; }
    $("composer").classList.toggle("is-generating", RUN.active);
}

// ---------- Settings ----------
function fillSettingsForm() {
    $("settingUrl").value = SETTINGS.apiUrl;
    $("settingModelInput").value = SETTINGS.model;
    $("settingModelInput").hidden = false;
    $("settingModelSelect").hidden = true;
    $("settingApiKey").value = SETTINGS.apiKey;
    $("settingInstructions").value = SETTINGS.instructions;
    $("settingStepLimit").value = SETTINGS.stepLimit;
    $("settingTimeout").value = SETTINGS.stepTimeoutSec;
    $("settingMaxTokens").value = SETTINGS.maxTokens;
    $("settingAutoCompact").value = SETTINGS.autoCompactPct;
    $("settingContextSize").value = SETTINGS.contextSize;
    $("settingToolMode").value = SETTINGS.toolMode;
    $("reasoningStatus").textContent = REASONING.key ? `Reasoning control: ${REASONING.state} (${REASONING.source || ""}) · ${toolSupportText(REASONING)}` : "";
}

function currentSettingsModel() {
    const select = $("settingModelSelect");
    if (!select.hidden && select.value && select.value !== "custom") return select.value;
    return $("settingModelInput").value.trim();
}

function saveSettings() {
    let url;
    try { url = normalizeApiUrl($("settingUrl").value); }
    catch (e) { showToast(e.message, { error: true }); return false; }
    const int = (id, min, max, d) => { const v = parseInt($(id).value, 10); return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d; };
    SETTINGS.apiUrl = url;
    SETTINGS.model = currentSettingsModel();
    SETTINGS.apiKey = $("settingApiKey").value.trim();
    SETTINGS.instructions = $("settingInstructions").value;
    SETTINGS.stepLimit = int("settingStepLimit", 1, 500, 20);
    SETTINGS.stepTimeoutSec = int("settingTimeout", 1, 3600, 60);
    SETTINGS.maxTokens = int("settingMaxTokens", 0, 1000000, 8192);
    SETTINGS.autoCompactPct = int("settingAutoCompact", 0, 95, 85);
    SETTINGS.contextSize = int("settingContextSize", 0, 10000000, 0);
    SETTINGS.toolMode = ["auto", "native", "text"].includes($("settingToolMode").value) ? $("settingToolMode").value : "auto";
    RUN.compactAfter = 0;
    if (S.messages.length && S.messages[0].role === "system") S.messages[0].content = buildSystemPrompt(SETTINGS.instructions, PKG.names, S.protocol);
    renderHeader();
    return true;
}

// What the probe found about native tool calls, for the settings dialog.
function toolSupportText(r) {
    if (r.toolsRejected) return "tool calls: refused by the endpoint, using code blocks and tags";
    if (r.tools === "supported") return `tool calls: supported (${r.toolsSource})`;
    if (r.tools === "unsupported") return `tool calls: not supported (${r.toolsSource}), Auto uses code blocks and tags`;
    return "tool calls: not reported, Auto uses code blocks and tags";
}

async function testConnection() {
    const btn = $("testConnectionBtn");
    const original = btn.textContent;
    btn.textContent = "⏳ Testing…";
    btn.disabled = true;
    try {
        const url = normalizeApiUrl($("settingUrl").value);
        const key = $("settingApiKey").value.trim();
        const res = await fetch(apiEndpoint(url, "/models"), { headers: { "Authorization": "Bearer " + (key || "none") } });
        if (!res.ok) {
            let detail = res.statusText || "Unknown Error";
            try { const j = await res.json(); detail = (j.error && (j.error.message || j.error)) || detail; } catch { /* not JSON */ }
            throw new Error(`Server Error ${res.status}: ${detail}`);
        }
        const data = await res.json();
        let models = data.data;
        if (!Array.isArray(models)) models = Array.isArray(data) ? data : (data.models || []);
        if (!models.length) throw new Error("the server answered but lists no models — type the model name in manually.");
        const select = $("settingModelSelect");
        select.innerHTML = "";
        for (const m of models) {
            const id = typeof m === "string" ? m : (m.id || m.name || m.model || "");
            if (!id) continue;
            const opt = el("option", "", id);
            opt.value = id;
            select.appendChild(opt);
        }
        const custom = el("option", "", "✍️ Custom / manual entry");
        custom.value = "custom";
        select.appendChild(custom);
        const current = $("settingModelInput").value.trim();
        if ([...select.options].some(o => o.value === current)) select.value = current;
        select.hidden = false;
        $("settingModelInput").hidden = true;
        const r = await probeReasoningSupport(url, key, currentSettingsModel());
        // The saved endpoint was tested: keep what was found (the header's Actions badge).
        if (url === SETTINGS.apiUrl && currentSettingsModel() === SETTINGS.model && r.reached) {
            Object.assign(REASONING, r, { key: url + "|" + SETTINGS.model, rejected: false, toolsRejected: false });
            renderHeader();
        }
        $("reasoningStatus").textContent = `Reasoning control: ${r.state} (${r.source}) · ` + (r.nCtx ? `context ${r.nCtx.toLocaleString("en-US")} tokens (${r.ctxSource})` : "context size not reported: set it below for auto-compaction") + " · " + toolSupportText(r);
        showToast(`✅ Connection successful! Found ${models.length} model${models.length === 1 ? "" : "s"}.`);
    } catch (error) {
        const baseUrl = $("settingUrl").value.trim();
        const hint = chatErrorHint(error.message, { apiUrl: baseUrl, mixedContent: isBlockedMixedContent(baseUrl) });
        showToast(`❌ Connection failed: ${error.message}${hint ? "\n" + hint : ""}`, { error: true });
    } finally {
        btn.textContent = original;
        btn.disabled = false;
    }
}

// ---------- Export / import ----------
function sessionSnapshot() {
    return {
        session: {
            task: S.task, createdAt: S.createdAt, status: S.status, messages: S.messages, timeline: S.timeline,
            stepCount: S.stepCount, tokens: S.tokens, activeMs: S.activeMs, compactions: S.compactions, protocol: S.protocol,
            // Non-secret connection settings only: the API key is never exported.
            settings: { apiUrl: SETTINGS.apiUrl, model: SETTINGS.model, autonomy: SETTINGS.autonomy, stepLimit: SETTINGS.stepLimit, stepTimeoutSec: SETTINGS.stepTimeoutSec, maxTokens: SETTINGS.maxTokens, effort: SETTINGS.effort, autoCompactPct: SETTINGS.autoCompactPct, contextSize: SETTINGS.contextSize, toolMode: SETTINGS.toolMode },
        },
        files: WS.files, blobs: WS.blobs, checkpoints: CHECKPOINTS,
    };
}

function stampForFile() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}`;
}

async function exportSession(includeCheckpoints) {
    if (RUN.active) { showToast("Stop the agent before exporting, so the export is consistent."); return; }
    try {
        const entries = buildSessionArchive(sessionSnapshot(), { includeCheckpoints });
        const zip = await zipWrite(entries);
        downloadBytes(zip, `hermit-agent-session-${stampForFile()}.zip`, "application/zip");
        markExported();
        showToast(`💾 Session exported (${formatBytes(zip.length)}).`);
    } catch (e) {
        showToast("❌ Export failed: " + e.message, { error: true });
    }
}

async function exportWorkspace() {
    try {
        const entries = [...WS.files].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([p, f]) => ({ path: p, data: WS.blobs.get(f.hash) }));
        const zip = await zipWrite(entries);
        downloadBytes(zip, `hermit-agent-workspace-${stampForFile()}.zip`, "application/zip");
        // Without a timeline, the files are all there is to keep.
        if (!S.timeline.length) markExported();
    } catch (e) {
        showToast("❌ Export failed: " + e.message, { error: true });
    }
}

async function importSessionFile(file) {
    let parsed;
    try {
        const entries = await zipRead(new Uint8Array(await file.arrayBuffer()));
        // A zip without a session manifest is a plain workspace zip: import its files.
        const picked = workspaceEntriesFromZip(entries);
        if (!picked.fromSession) { await importWorkspaceEntries(picked, file.name); return; }
        if (RUN.active) { showToast("Stop the agent before importing a session."); return; }
        parsed = await parseSessionArchive(entries);
    } catch (e) {
        showToast("❌ Import failed: " + e.message, { error: true });
        return;
    }
    if ((S.timeline.length || WS.files.size) && !(await confirmDialog("Replace the current session and workspace with the imported one? Export first if you want to keep them.", "📂 Replace"))) return;
    const s = parsed.session;
    S = freshSession();
    Object.assign(S, {
        task: s.task, createdAt: s.createdAt, status: "paused", messages: s.messages, timeline: s.timeline,
        stepCount: s.stepCount, stepBudget: s.stepCount + SETTINGS.stepLimit, tokens: s.tokens, activeMs: s.activeMs,
        compactions: s.compactions, protocol: s.protocol,
    });
    WS.files = parsed.files;
    WS.blobs = parsed.blobs;
    WS.version++;
    WS.lastChanged = new Set();
    CHECKPOINTS = parsed.checkpoints;
    // Checkpoint links on the timeline only survive when the checkpoints came along.
    for (const item of S.timeline) {
        if (!Number.isInteger(item.checkpoint) || item.checkpoint >= CHECKPOINTS.length) delete item.checkpoint;
    }
    // Autonomy and limits carry over; connection settings don't (they would silently
    // send the session somewhere else), and approvals never do (DESIGN §3.3).
    SETTINGS.autonomy = s.settings.autonomy;
    SETTINGS.stepLimit = s.settings.stepLimit;
    SETTINGS.stepTimeoutSec = s.settings.stepTimeoutSec;
    SETTINGS.maxTokens = s.settings.maxTokens;
    SETTINGS.autoCompactPct = s.settings.autoCompactPct;
    SETTINGS.contextSize = s.settings.contextSize;
    RUN.compactAfter = 0;
    RUN.compactNext = false;
    RUN.listedKey = "";
    $("autonomySelect").value = SETTINGS.autonomy;
    RUN.modelNotes = ["This session was restored from an export into a fresh interpreter: variables are lost, files are intact."];
    restartInterpreter();
    renderTimeline();
    renderWorkspace();
    const conn = s.settings.apiUrl && s.settings.apiUrl !== SETTINGS.apiUrl ? ` It was recorded against ${s.settings.model || "a model"} at ${s.settings.apiUrl}; the current connection settings were kept.` : "";
    addNote(`📂 Session imported, paused. Nothing has run.${conn} ` + (awaitsModel(S.messages) ? "Press Continue to resume." : "Send a follow-up to continue."));
    setStatus("paused");
    markExported();   // it is in a file already
}

// ---------- Workspace import & delete ----------
async function importWorkspaceZip(file) {
    let picked;
    try {
        picked = workspaceEntriesFromZip(await zipRead(new Uint8Array(await file.arrayBuffer())));
    } catch (e) {
        showToast("❌ Import failed: " + e.message, { error: true });
        return;
    }
    await importWorkspaceEntries(picked, file.name);
}

// picked: from workspaceEntriesFromZip. Asks Replace or Merge when the workspace has files.
async function importWorkspaceEntries({ files, fromSession }, name) {
    const busy = workspaceLockReason();
    if (busy) { showToast(busy); return; }
    const source = fromSession ? `the workspace of the session in ${name}` : name;
    if (!files.length) { showToast(`No files to import from ${source}.`, { error: true }); return; }
    const count = `${files.length} file${files.length === 1 ? "" : "s"}`;
    let replace = false;
    if (WS.files.size) {
        const choice = await confirmDialog(`Import ${count} from ${source}. Replace the current workspace, or merge into it? Merging overwrites files with the same name.`, "♻️ Replace", "➕ Merge");
        if (!choice) return;
        replace = choice === true;
        const nowBusy = workspaceLockReason();
        if (nowBusy) { showToast(nowBusy); return; }
    }
    const warn = uploadWarning(files.map(f => ({ path: f.path, size: f.data.length })), replace ? 0 : workspaceSize());
    if (warn && (await confirmDialog(warn, "📎 Add them")) !== true) return;
    if (workspaceLockReason()) { showToast(workspaceLockReason()); return; }
    if (replace) {
        const incoming = new Set(files.map(f => normalizeUploadPath(f.path)));
        const gone = [...WS.files.keys()].filter(p => !incoming.has(p));
        WS.files = new Map();
        WS.version++;
        WS.lastChanged = new Set();
        if (S.task && gone.length) RUN.modelNotes.push(deletedFilesNote(gone));
    }
    const result = await addUserFiles(files.map(f => ({ path: f.path, bytes: f.data })));
    if (replace) collectGarbage();
    reportUpload(result);
}

async function confirmDeletePath(path, isDir) {
    const busy = workspaceLockReason();
    if (busy) { showToast(busy); return; }
    const paths = isDir ? [...WS.files.keys()].filter(p => p.startsWith(path + "/")) : [path];
    if (!paths.length) return;
    const what = isDir ? `the folder ${path} (${paths.length} file${paths.length === 1 ? "" : "s"})` : path;
    if (!(await confirmDialog(`Delete ${what} from the workspace? Only the copy in this tab is removed; your original on disk isn't touched.`, "🗑️ Delete"))) return;
    const nowBusy = workspaceLockReason();
    if (nowBusy) { showToast(nowBusy); return; }
    const removed = removeWorkspacePaths(paths);
    if (removed.length) showToast(`🗑️ Deleted ${removed.length === 1 ? removed[0] : removed.length + " files"}.`);
}

// ---------- Uploads ----------
// Walk a dropped FileSystemEntry (a file, or a folder and everything in it) into
// [{ path, file }]. A folder's reader hands out its entries in batches, so it is read
// until it returns an empty one. No file is read yet: the sizes come first.
async function readEntry(entry, prefix, out) {
    if (entry.isFile) {
        const file = await new Promise((res, rej) => entry.file(res, rej));
        out.push({ path: prefix + file.name, file });
    } else if (entry.isDirectory) {
        const reader = entry.createReader();
        for (;;) {
            const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
            if (!batch.length) break;
            for (const e of batch) await readEntry(e, prefix + entry.name + "/", out);
        }
    }
}

const RUNNING_UPLOAD = "Wait for the running step to finish before adding files.";

// list: [{ path, file }]. Large additions are confirmed before anything is read.
async function addFileObjects(list) {
    if (PY.state === "running") { showToast(RUNNING_UPLOAD); return; }
    if (!list.length) return;
    const warn = uploadWarning(list.map(x => ({ path: x.path, size: x.file.size })), workspaceSize());
    if (warn && (await confirmDialog(warn, "📎 Add them")) !== true) return;
    if (PY.state === "running") { showToast(RUNNING_UPLOAD); return; }
    const withBytes = [];
    for (const x of list) withBytes.push({ path: x.path, bytes: new Uint8Array(await x.file.arrayBuffer()) });
    reportUpload(await addUserFiles(withBytes));
}

async function uploadFileList(files) {
    await addFileObjects([...files].map(f => ({ path: f.webkitRelativePath || f.name, file: f })));
}

function reportUpload({ added, skipped }) {
    if (added.length) showToast(`📎 Added ${added.length} file${added.length === 1 ? "" : "s"} to the workspace.`);
    if (skipped.length) showToast("Skipped: " + skipped.slice(0, 5).join(", ") + (skipped.length > 5 ? " …" : ""), { error: true });
}

// ---------- Event wiring ----------
function handleTimelineClick(e) {
    const b = e.target.closest("[data-action]");
    if (!b) return;
    const action = b.dataset.action;
    const idx = Number(b.dataset.idx);
    const item = S.timeline[idx];
    const card = b.closest(".card");
    const reason = card && card.querySelector("[data-role=reason]") ? card.querySelector("[data-role=reason]").value.trim() : "";
    const code = card && card.querySelector("[data-role=code-edit]") ? card.querySelector("[data-role=code-edit]").value : null;
    if (action === "view-file") { openViewer(b.dataset.path, b.dataset.hash, b.dataset.prev); return; }
    if (action === "rewind") { rewindTo(idx); return; }
    if (action === "retry") { S.timeline.splice(idx, 1); renderTimeline(); runLoop(); return; }
    if (action === "continue") {
        const more = card && card.querySelector("[data-role=more-steps]") ? parseInt(card.querySelector("[data-role=more-steps]").value, 10) : NaN;
        if (atStepLimit()) continueAfterLimit(more);
        return;
    }
    if (action === "send-now") { sendNotesNow(); return; }
    if (!RUN.decision || RUN.decision.idx !== idx) return;
    if (action === "run") resolveDecision({ action: "run", code: code !== null ? code : item.proposedCode });
    else if (action === "approve") resolveDecision({ action: "approve" });
    else if (action === "reject") resolveDecision({ action: "reject", reason });
    else if (action === "rerun-net") resolveDecision({ action: "rerun-net" });
    else if (action === "edit-open") {
        item._editing = true;
        renderTimelineItem(idx);
        document.querySelector(`[data-idx="${idx}"] [data-role=code-edit]`)?.focus();
    }
    else if (action === "edit") resolveDecision({ action: "edit", code: code !== null ? code : item.ranCode });
    else if (action === "reset-code") {
        delete item._draft;
        renderTimelineItem(idx);
        document.querySelector(`[data-idx="${idx}"] [data-role=code-edit]`)?.focus();
    }
}

// Keys in the timeline's fields. A step's code editor: Tab indents (Shift+Tab leaves the
// field), Ctrl/Cmd+Enter runs.
function handleCodeEditKey(e) {
    const ta = e.target;
    // Enter in the step-limit note's "Run N more steps" field presses its Continue.
    if (ta.dataset.role === "more-steps" && e.key === "Enter") {
        e.preventDefault();
        ta.closest(".card")?.querySelector("[data-action=continue]")?.click();
        return;
    }
    if (ta.dataset.role !== "code-edit") return;
    if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        ta.setRangeText("    ", ta.selectionStart, ta.selectionEnd, "end");
        ta.dispatchEvent(new Event("input", { bubbles: true }));
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        ta.closest(".card")?.querySelector("[data-action=run], [data-action=edit]")?.click();
    }
}

function wireEvents() {
    $("timeline").addEventListener("click", handleTimelineClick);
    $("timeline").addEventListener("keydown", handleCodeEditKey);
    $("timeline").addEventListener("input", (e) => {
        if (e.target.dataset.role === "more-steps") {
            const v = parseInt(e.target.value, 10);
            if (Number.isInteger(v) && v > 0) RUN.moreSteps = Math.min(500, v);
            return;
        }
        if (e.target.dataset.role !== "code-edit") return;
        const card = e.target.closest("[data-idx]");
        const item = card && S.timeline[Number(card.dataset.idx)];
        if (!item) return;
        const first = item._draft === undefined || item._draft === item.proposedCode;
        item._draft = e.target.value;
        // The ↺ Reset button appears with the first change: re-render, keeping the caret.
        if (first !== (item._draft === item.proposedCode) && item.phase === "pending-run") {
            const pos = e.target.selectionStart;
            renderTimelineItem(Number(card.dataset.idx));
            const ta = document.querySelector(`[data-idx="${card.dataset.idx}"] [data-role=code-edit]`);
            if (ta) { ta.focus(); ta.setSelectionRange(pos, pos); }
        }
    });
    $("wsTree").addEventListener("click", (e) => {
        const d = e.target.closest("[data-action=delete-path]");
        // preventDefault: a folder's button sits in its <summary>, which would toggle.
        if (d) { e.preventDefault(); confirmDeletePath(d.dataset.path, d.dataset.dir === "1"); return; }
        const b = e.target.closest("[data-action=view-file]");
        if (b) openViewer(b.dataset.path, b.dataset.hash);
    });
    $("composer").addEventListener("submit", (e) => {
        e.preventDefault();
        const text = $("taskInput").value.trim();
        if (!S.task) {
            if (!text) { showToast("Describe a task first."); return; }
            startTask(text);
        } else {
            if (!text && RUN.active) return;
            submitUserText(text);
        }
        $("taskInput").value = "";
    });
    $("taskInput").addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $("composer").requestSubmit(); }
    });
    $("stopBtn").addEventListener("click", stopRun);
    $("killBtn").addEventListener("click", killInterpreter);
    $("compactBtn").addEventListener("click", compactNow);
    $("continueBtn").addEventListener("click", () => {
        if (atStepLimit()) continueAfterLimit();
        else submitUserText("");
    });
    $("autonomySelect").addEventListener("change", (e) => { SETTINGS.autonomy = e.target.value; });
    $("effortSelect").addEventListener("change", (e) => { SETTINGS.effort = e.target.value; });
    $("newSessionBtn").addEventListener("click", async () => {
        if (RUN.active) { showToast("Stop the agent first."); return; }
        let choice = true;
        if (WS.files.size) choice = await confirmDialog("Start a new session? The timeline and the model history are cleared. Keep the workspace files, or clear everything? Export first if you want to keep them.", "🗑️ Clear everything", "📁 Keep files");
        else if (S.timeline.length) choice = await confirmDialog("Start a new session? The timeline is cleared. Export first if you want to keep it.", "➕ New session");
        if (!choice) return;
        S = freshSession();
        CHECKPOINTS = [];
        if (choice === "alt") {
            // Files carried over are the user's inputs now: only files the agent created in
            // *this* session are changed without approval (DESIGN §2.3).
            for (const f of WS.files.values()) f.origin = "user";
            WS.version++; WS.lastChanged = new Set();
            collectGarbage();
            showToast(`➕ New session, ${WS.files.size} workspace file${WS.files.size === 1 ? "" : "s"} kept.`);
        } else {
            WS.files = new Map(); WS.blobs = new Map(); WS.version++; WS.lastChanged = new Set();
        }
        RUN.modelNotes = [];
        RUN.listedKey = "";
        restartInterpreter();
        renderTimeline(); renderWorkspace(); setStatus("idle");
    });
    $("settingsBtn").addEventListener("click", () => { fillSettingsForm(); openModal("settingsModal"); });
    $("settingCancel").addEventListener("click", () => closeModal("settingsModal"));
    $("settingSave").addEventListener("click", () => { if (saveSettings()) { closeModal("settingsModal"); showToast("✅ Settings saved (in memory only)."); } });
    $("testConnectionBtn").addEventListener("click", testConnection);
    $("settingModelSelect").addEventListener("change", (e) => {
        if (e.target.value === "custom") { e.target.hidden = true; $("settingModelInput").hidden = false; $("settingModelInput").focus(); }
    });
    $("viewerClose").addEventListener("click", () => closeModal("viewerModal"));
    $("exportBtn").addEventListener("click", () => openModal("exportModal"));
    $("exportCancel").addEventListener("click", () => closeModal("exportModal"));
    $("exportSessionBtn").addEventListener("click", () => { closeModal("exportModal"); exportSession($("exportCheckpoints").checked); });
    $("exportWorkspaceBtn").addEventListener("click", () => { closeModal("exportModal"); exportWorkspace(); });
    $("importBtn").addEventListener("click", () => $("importInput").click());
    $("importInput").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) importSessionFile(f); });
    $("wsUploadBtn").addEventListener("click", () => $("wsFileInput").click());
    $("wsFolderBtn").addEventListener("click", () => $("wsFolderInput").click());
    $("wsDownloadBtn").addEventListener("click", exportWorkspace);
    $("wsImportZipBtn").addEventListener("click", () => $("wsZipInput").click());
    $("wsZipInput").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) importWorkspaceZip(f); });
    for (const id of ["wsFileInput", "wsFolderInput"]) {
        $(id).addEventListener("change", async (e) => { const files = [...e.target.files]; e.target.value = ""; await uploadFileList(files); });
    }
    const pane = $("workspacePane");
    pane.addEventListener("dragover", (e) => { e.preventDefault(); pane.classList.add("drag-over"); });
    pane.addEventListener("dragleave", (e) => { if (!pane.contains(e.relatedTarget)) pane.classList.remove("drag-over"); });
    pane.addEventListener("drop", async (e) => {
        e.preventDefault();
        pane.classList.remove("drag-over");
        if (PY.state === "running") { showToast(RUNNING_UPLOAD); return; }
        const items = [...(e.dataTransfer.items || [])];
        const entries = items.map(i => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
        if (entries.length) {
            const out = [];
            for (const en of entries) await readEntry(en, "", out);
            await addFileObjects(out);
        } else {
            await uploadFileList([...e.dataTransfer.files]);
        }
    });
    $("themeBtn").addEventListener("click", () => {
        const dark = document.documentElement.getAttribute("data-theme") === "dark";
        document.documentElement.setAttribute("data-theme", dark ? "light" : "dark");
    });
    document.querySelectorAll(".modal-overlay").forEach((m) => {
        m.addEventListener("click", (e) => { if (e.target === m && m.id !== "confirmModal") closeModal(m.id); });
    });
    document.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        const open = document.querySelector(".modal-overlay.active");
        if (open) { if (open.id === "confirmModal") $("confirmCancel").click(); else closeModal(open.id); }
        else if ($("debugConsole").classList.contains("open")) setDebugConsole(false);
    });
    $("debugBtn").addEventListener("click", () => setDebugConsole(!$("debugConsole").classList.contains("open")));
    $("debugClose").addEventListener("click", () => setDebugConsole(false));
    $("debugClear").addEventListener("click", () => { DEBUG.entries = []; renderDebugLog(); });
    $("debugFilter").addEventListener("change", (e) => { DEBUG.filter = e.target.value; renderDebugLog(); });
    // The session lives only in this tab: closing it with unexported work asks first.
    window.addEventListener("beforeunload", (e) => {
        if (!hasUnexportedWork()) return;
        e.preventDefault();
        e.returnValue = "";
    });
    $("statUnsaved").addEventListener("click", () => openModal("exportModal"));
    setInterval(() => { if (RUN.active) renderStatusBar(); }, 1000);
}

function init() {
    const dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    $("versionBadge").textContent = "v" + APP_VERSION;
    $("autonomySelect").value = SETTINGS.autonomy;
    $("effortSelect").value = SETTINGS.effort;
    wireEvents();
    renderHeader();
    renderTimeline();
    renderWorkspace();
    renderStatusBar();
    updateComposer();
    restartInterpreter();
}

if (typeof document !== "undefined") init();
