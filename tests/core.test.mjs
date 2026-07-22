// Unit tests for the pure logic HermitUI depends on outside of Export/Import:
// think-tag parsing, endpoint normalization, the cloud-provider warning, file-type
// gating, the render throttle, and the wllama prompt builders. Run with:
//   node tests/core.test.mjs
// Everything under test is sliced out of src/script.js by extract.mjs, so a rename
// there fails loudly here instead of silently skipping coverage.
import H from "./extract.mjs";
import { check, checkThrows, section, report } from "./check.mjs";

const {
    parseThinkSegments, buildFinalHistory, createThrottle, apiEndpoint,
    detectCloudProvider, isTextFile, isImageFile, modelSupportsVision,
    modelReportsVision, extractModelId, normalizeGgufUrl, detectTemplateFromArch,
    buildWllamaPrompt,
} = H;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const types = segs => segs.map(s => s.type).join(",");
const file = (name, type = "") => ({ name, type });

// The think parser runs on every streamed chunk, so it sees text mid-tag. A partially
// arrived tag must never flash as literal text in the answer.
section("1. think-tag parsing");
{
    check("plain text is one text segment",
        types(parseThinkSegments("Hello world")) === "text");

    const closed = parseThinkSegments("<think>weighing it up</think>The answer.");
    check("closed think splits into think + text", types(closed) === "think,text", types(closed));
    check("think content extracted", closed[0].content === "weighing it up", closed[0].content);
    check("closed flag set", closed[0].isClosed === true);
    check("answer text extracted", closed[1].content === "The answer.", closed[1].content);

    const open = parseThinkSegments("<think>still thinking");
    check("unclosed think is still a think segment", types(open) === "think");
    check("unclosed flag set", open[0].isClosed === false);

    check("text before a think tag is kept",
        types(parseThinkSegments("intro <think>t</think> tail")) === "text,think,text");

    // Unslashed closers, as emitted by some models (see the closeRegex comment in src).
    const unslashed = parseThinkSegments("<|thought_start|>hmm<|thought_end|>done");
    check("unslashed <|thought_end|> closes the segment", types(unslashed) === "think,text", types(unslashed));
    check("unslashed think content extracted", unslashed[0].content === "hmm", unslashed[0].content);
    check("unslashed answer extracted", unslashed[1].content === "done", unslashed[1].content);

    check("<reasoning> is recognized",
        types(parseThinkSegments("<reasoning>r</reasoning>a")) === "think,text");

    // Streaming: a half-arrived tag is withheld from the rendered text segment.
    const partialOpen = parseThinkSegments("Answer so far <thin");
    check("partial opening tag withheld from text",
        partialOpen[0].content === "Answer so far ", JSON.stringify(partialOpen[0].content));
    const partialClose = parseThinkSegments("<think>t</think>Answer</thi");
    check("partial closing tag withheld from text",
        partialClose[1].content === "Answer", JSON.stringify(partialClose[1].content));
    check("empty input yields no segments", parseThinkSegments("").length === 0);
}

// Servers that return reasoning in a separate field (reasoning_content) must have it
// folded back into the stored text as a <think> block — but only once.
section("2. final history rebuild");
{
    check("separate reasoning field is wrapped",
        buildFinalHistory("The answer.", "step one") === "<think>\nstep one\n</think>\nThe answer.",
        JSON.stringify(buildFinalHistory("The answer.", "step one")));
    check("no reasoning leaves the text untouched",
        buildFinalHistory("The answer.", "") === "The answer.");
    check("inline think tags are not double-wrapped",
        buildFinalHistory("<think>step one</think>The answer.", "step one")
            === "<think>step one</think>The answer.");
    check("inline <|thought_start|> is not double-wrapped",
        buildFinalHistory("<|thought_start|>x<|thought_end|>a", "x")
            === "<|thought_start|>x<|thought_end|>a");
}

// Users paste both base URLs and full chat endpoints into the API URL field.
section("3. API endpoint normalization");
{
    check("base URL gets the path appended",
        apiEndpoint("http://localhost:1234/v1", "/chat/completions") === "http://localhost:1234/v1/chat/completions");
    check("trailing slashes stripped",
        apiEndpoint("http://localhost:1234/v1//", "/chat/completions") === "http://localhost:1234/v1/chat/completions");
    check("surrounding whitespace stripped",
        apiEndpoint("  http://localhost:1234/v1  ", "/models") === "http://localhost:1234/v1/models");
    check("a pasted full endpoint is not doubled",
        apiEndpoint("http://localhost:1234/v1/chat/completions", "/chat/completions") === "http://localhost:1234/v1/chat/completions");
    check("a pasted chat endpoint still resolves /models",
        apiEndpoint("http://localhost:1234/v1/chat/completions", "/models") === "http://localhost:1234/v1/models");
}

// The banner claims data leaves the machine, so a false positive is a lie to the user:
// providers match as hostname suffixes, never substrings.
section("4. cloud provider detection");
{
    check("openai detected", detectCloudProvider("https://api.openai.com/v1") === "openai.com");
    check("gemini's openai-compatible endpoint detected",
        detectCloudProvider("https://generativelanguage.googleapis.com/v1beta/openai") === "googleapis.com");
    check("protocol-less input still matches", detectCloudProvider("api.x.ai/v1") === "x.ai");
    check("localhost is not a cloud provider", detectCloudProvider("http://localhost:1234/v1") === null);
    check("LAN address is not a cloud provider", detectCloudProvider("http://192.168.1.20:8080/v1") === null);
    check("suffix match, not substring: mybox.ai is not x.ai",
        detectCloudProvider("https://mybox.ai/v1") === null);
    check("suffix match, not substring: notopenai.com is not openai.com",
        detectCloudProvider("https://notopenai.com/v1") === null);
    check("subdomains still match", detectCloudProvider("https://eu.api.mistral.ai/v1") === "mistral.ai");
    check("unparseable input yields null", detectCloudProvider("") === null);
}

// Attachment gating: text files are inlined into the prompt, images go into the
// multimodal content array, everything else is rejected.
section("5. attachment file-type gating");
{
    check("text/* MIME accepted", isTextFile(file("README", "text/plain")));
    check("known extension accepted without a MIME type", isTextFile(file("main.py")));
    check("extension match is case-insensitive", isTextFile(file("NOTES.MD")));
    check("binary rejected", isTextFile(file("app.bin", "application/octet-stream")) === false);
    check("png accepted as image", isImageFile(file("a.png", "image/png")));
    check("webp accepted as image", isImageFile(file("a.webp", "image/webp")));
    check("svg deliberately excluded", isImageFile(file("a.svg", "image/svg+xml")) === false);
    check("a text file is not an image", isImageFile(file("a.txt", "text/plain")) === false);
}

section("6. vision model detection");
{
    check("gpt-4o recognized by name", modelSupportsVision("gpt-4o"));
    check("qwen VL recognized by name", modelSupportsVision("qwen2-vl-7b-instruct"));
    check("text-only model not recognized", modelSupportsVision("llama-3.1-8b-instruct") === false);
    check("empty id is false", modelSupportsVision("") === false);
    check("server-reported modalities honored",
        modelReportsVision({ id: "custom", architecture: { input_modalities: ["text", "image"] } }));
    check("server-reported capabilities honored",
        modelReportsVision({ id: "custom", capabilities: ["vision"] }));
    check("no hints means no vision", modelReportsVision({ id: "custom" }) === false);
    check("non-object is not vision-capable", modelReportsVision("gpt-4o") === false);
    check("model id read from .id", extractModelId({ id: "a" }) === "a");
    check("model id falls back to .name", extractModelId({ name: "b" }) === "b");
    check("plain string id passes through", extractModelId("c") === "c");
}

// wllama model URLs: the three shapes people realistically paste, and the shapes that
// must be rejected with a hint rather than a mid-download failure.
section("7. GGUF URL normalization");
{
    check("hf: shorthand expands to a resolve link",
        normalizeGgufUrl("hf:Qwen/Qwen3-0.6B-GGUF/Qwen3-0.6B-Q4_K_M.gguf")
            === "https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q4_K_M.gguf",
        normalizeGgufUrl("hf:Qwen/Qwen3-0.6B-GGUF/Qwen3-0.6B-Q4_K_M.gguf"));
    check("blob page rewritten to a resolve link",
        normalizeGgufUrl("https://huggingface.co/u/r/blob/main/m.gguf")
            === "https://huggingface.co/u/r/resolve/main/m.gguf");
    check("direct link passes through",
        normalizeGgufUrl("https://example.com/models/m.gguf") === "https://example.com/models/m.gguf");
    check("query string preserved",
        normalizeGgufUrl("https://example.com/m.gguf?download=true") === "https://example.com/m.gguf?download=true");
    check("surrounding whitespace stripped",
        normalizeGgufUrl("  https://example.com/m.gguf  ") === "https://example.com/m.gguf");
    checkThrows("empty input rejected", () => normalizeGgufUrl(""), "Enter a model URL");
    checkThrows("non-URL rejected", () => normalizeGgufUrl("just some text"), "Not a URL");
    checkThrows("non-gguf target rejected", () => normalizeGgufUrl("https://example.com/model.bin"), ".gguf");
    checkThrows("split gguf rejected",
        () => normalizeGgufUrl("https://example.com/m-00001-of-00003.gguf"), "Split GGUFs");
}

section("8. chat template selection");
{
    check("qwen -> chatml", detectTemplateFromArch("qwen3") === "chatml");
    check("yi -> chatml", detectTemplateFromArch("yi") === "chatml");
    check("llama -> llama3", detectTemplateFromArch("llama") === "llama3");
    check("mixtral -> mistral", detectTemplateFromArch("mixtral") === "mistral");
    check("gemma -> gemma", detectTemplateFromArch("gemma3") === "gemma");
    check("phi -> phi3", detectTemplateFromArch("phi3") === "phi3");
    check("unknown arch falls back to zephyr", detectTemplateFromArch("something-else") === "zephyr");
    check("missing arch falls back to zephyr", detectTemplateFromArch(undefined) === "zephyr");
}

// A malformed prompt is not an error the user ever sees — it just makes the model
// answer badly — so the wrapping is asserted byte for byte.
section("9. wllama prompt building");
{
    const msgs = [
        { role: "system", content: "S" },
        { role: "user", content: "U" },
        { role: "assistant", content: "A" },
        { role: "user", content: "U2" },
    ];

    const chatml = buildWllamaPrompt("chatml", msgs);
    check("chatml wraps every turn and primes the assistant",
        chatml.prompt === "<|im_start|>system\nS<|im_end|>\n<|im_start|>user\nU<|im_end|>\n"
            + "<|im_start|>assistant\nA<|im_end|>\n<|im_start|>user\nU2<|im_end|>\n<|im_start|>assistant\n",
        JSON.stringify(chatml.prompt));
    check("chatml stop token", chatml.stop.join() === "<|im_end|>");

    const llama3 = buildWllamaPrompt("llama3", [{ role: "user", content: "U" }]);
    check("llama3 emits its own BOS", llama3.prompt.startsWith("<|begin_of_text|>"), llama3.prompt);
    check("llama3 primes the assistant header",
        llama3.prompt.endsWith("<|start_header_id|>assistant<|end_header_id|>\n\n"), llama3.prompt);

    // Gemma has no system role: it must be folded into the first user turn, once.
    const gemma = buildWllamaPrompt("gemma", msgs);
    check("gemma folds the system prompt into the first user turn",
        gemma.prompt.startsWith("<start_of_turn>user\nS\n\nU<end_of_turn>\n"), JSON.stringify(gemma.prompt));
    check("gemma does not repeat the system prompt", gemma.prompt.split("S\n\n").length === 2, gemma.prompt);
    check("gemma maps assistant to model", gemma.prompt.includes("<start_of_turn>model\nA<end_of_turn>"));
    check("gemma primes the model turn", gemma.prompt.endsWith("<start_of_turn>model\n"));

    // Mistral likewise has no system role.
    const mistral = buildWllamaPrompt("mistral", msgs);
    check("mistral folds system into the first [INST]",
        mistral.prompt.startsWith("<s>[INST] S\n\nU [/INST]"), JSON.stringify(mistral.prompt));
    check("mistral does not repeat the system prompt", mistral.prompt.split("S\n\n").length === 2, mistral.prompt);
    check("mistral closes the assistant turn with </s>", mistral.prompt.includes(" A</s>"), mistral.prompt);

    const raw = buildWllamaPrompt("raw", [{ role: "user", content: "U" }]);
    check("raw template emits content only", raw.prompt === "U\n", JSON.stringify(raw.prompt));
    check("raw template has no stop tokens", raw.stop.length === 0);

    const unknown = buildWllamaPrompt("no-such-template", [{ role: "user", content: "U" }]);
    check("unknown template key falls back to zephyr",
        unknown.prompt === "<|user|>\nU</s>\n<|assistant|>\n", JSON.stringify(unknown.prompt));

    check("empty history still primes the assistant",
        buildWllamaPrompt("chatml", []).prompt === "<|im_start|>assistant\n");
}

// The streaming renderer is throttled; a trailing call that fires after the final
// render would overwrite the finished message with a stale partial one.
section("10. render throttle");
{
    const calls = [];
    const t = createThrottle(60);
    t(() => calls.push("a"));
    check("first call runs immediately", calls.join() === "a", calls.join());
    t(() => calls.push("b"));
    t(() => calls.push("c"));
    check("calls inside the window are deferred", calls.join() === "a", calls.join());
    await sleep(140);
    check("only the latest deferred call runs", calls.join() === "a,c", calls.join());

    const cancelled = [];
    const t2 = createThrottle(60);
    t2(() => cancelled.push("a"));
    t2(() => cancelled.push("b"));
    t2.cancel();
    await sleep(140);
    check("cancel() drops the pending trailing call", cancelled.join() === "a", cancelled.join());
}

report();
