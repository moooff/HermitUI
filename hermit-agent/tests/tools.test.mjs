// Native tool calls (DESIGN §5.6): tool definitions, support detection, parsing a reply's
// calls, the history in both protocols, and the session schema for tool messages.
// Run: node tests/tools.test.mjs
import { check, section, report } from "./check.mjs";
import X from "./extract.mjs";

const F = "```";
const enc = new TextEncoder();
const call = (name, args, id) => ({ id: id === undefined ? "id_" + name : id, name, arguments: typeof args === "string" ? args : JSON.stringify(args) });
const asMsg = (calls) => ({ role: "assistant", content: "", tool_calls: calls.map(c => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) });

section("1. Tool definitions");
{
    const defs = X.agentToolDefs();
    check("one definition per tool name", JSON.stringify(defs.map(d => d.function.name)) === JSON.stringify(X.AGENT_TOOL_NAMES));
    check("every definition is an OpenAI function with an object schema", defs.every(d => d.type === "function" && d.function.parameters.type === "object" && Array.isArray(d.function.parameters.required)));
    const p = (n) => Object.keys(defs.find(d => d.function.name === n).function.parameters.properties);
    check("file tools take DESIGN §5.6's arguments", p("read_file").join() === "path,start_line,end_line" && p("write_file").join() === "path,content" && p("edit_file").join() === "path,edits");
    check("run_python(code), ask_user(question, options), finish(answer)", p("run_python").join() === "code" && p("ask_user").join() === "question,options" && p("finish").join() === "answer");
    check("search_files(pattern, path, glob, ignore_case), all optional", p("search_files").join() === "pattern,path,glob,ignore_case" && defs.find(d => d.function.name === "search_files").function.parameters.required.length === 0);
    check("delete_file(path), move_file(path, new_path)", p("delete_file").join() === "path" && p("move_file").join() === "path,new_path");
}

section("2. Which protocol, and support detection");
{
    check("auto + supported → tools", X.resolveProtocol("auto", "supported", false) === "tools");
    check("auto + unknown → text", X.resolveProtocol("auto", "unknown", false) === "text");
    check("auto + unsupported → text", X.resolveProtocol("auto", "unsupported", false) === "text");
    check("native + unknown → tools", X.resolveProtocol("native", "unknown", false) === "tools");
    check("native but refused → text", X.resolveProtocol("native", "supported", true) === "text");
    check("text → text", X.resolveProtocol("text", "supported", false) === "text");

    check("llama.cpp caps (Qwen3.8's /props) → supported", X.toolSupportFromProps({ chat_template_caps: { supports_tools: true, supports_tool_calls: true } }) === "supported");
    check("caps: no tool calls → unsupported", X.toolSupportFromProps({ chat_template_caps: { supports_tools: true, supports_tool_calls: false } }) === "unsupported");
    check("no caps, template handles tools → supported", X.toolSupportFromProps({ chat_template: "{%- if tools %}x{% endif %}" }) === "supported");
    check("no caps, template without tools → unsupported", X.toolSupportFromProps({ chat_template: "{{ messages }}" }) === "unsupported");
    check("/props without either → unknown", X.toolSupportFromProps({ default_generation_settings: { n_ctx: 4096 } }) === "unknown");
    check("Ollama capabilities with tools → supported", X.toolSupportFromOllamaShow({ capabilities: ["completion", "tools"] }) === "supported");
    check("Ollama capabilities without → unsupported", X.toolSupportFromOllamaShow({ capabilities: ["completion"] }) === "unsupported");
    check("older Ollama: template with .Tools → supported", X.toolSupportFromOllamaShow({ template: "{{ if .Tools }}…{{ end }}" }) === "supported");
    check("model list supported_parameters → supported", X.toolSupportFromModelList({ data: [{ id: "m", supported_parameters: ["tools", "max_tokens"] }] }, "m") === "supported");
    check("model list without the field → unknown", X.toolSupportFromModelList({ data: [{ id: "m" }] }, "m") === "unknown");
    check("vLLM's model list (owned_by vllm) → supported", X.toolSupportFromModelList({ object: "list", data: [{ id: "Qwen/Qwen3-32B", object: "model", owned_by: "vllm", max_model_len: 32768 }] }, "Qwen/Qwen3-32B") === "supported");
    check("…another owner without the field stays unknown", X.toolSupportFromModelList({ data: [{ id: "m", owned_by: "organization_owner" }] }, "m") === "unknown");
    check("context size still read from the model list", X.contextSizeFromModelList({ data: [{ id: "m", max_model_len: 2048 }] }, "m") === 2048);

    check("llama.cpp without --jinja is a tool rejection", X.looksLikeToolRejection(500, "tools param requires --jinja flag"));
    check("vLLM without auto tool choice", X.looksLikeToolRejection(400, '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set'));
    check("Ollama model without tools", X.looksLikeToolRejection(400, "registry.ollama.ai/library/gemma:2b does not support tools"));
    check("OpenRouter route without tool use", X.looksLikeToolRejection(404, "No endpoints found that support tool use."));
    check("a context overflow is not", !X.looksLikeToolRejection(400, "the request exceeds the available context size"));
    check("a 503 is not", !X.looksLikeToolRejection(503, "tools are loading"));
}

section("3. parseToolCalls — what runs");
{
    let r = X.parseToolCalls([call("run_python", { code: "print(1)" })], "", "tool_calls", 3);
    check("one run_python → code", r.kind === "code" && r.code === "print(1)\n" && r.runId === "id_run_python" && !r.skipped.length, JSON.stringify(r));
    check("…stored for the history", r.stored.length === 1 && r.stored[0].arguments === '{"code":"print(1)"}');

    r = X.parseToolCalls([call("read_file", { path: "/workspace/a.csv", start_line: 2 }, "a"), call("write_file", { path: "./b.txt", content: "hi" }, "b")], "Reading.", "tool_calls", 1);
    check("file calls → one batch", r.kind === "files" && r.actions.length === 2 && r.actions.map(a => a.id).join() === "a,b", JSON.stringify(r));
    check("…paths normalised, fields mapped", r.actions[0].args.path === "a.csv" && r.actions[0].args.start_line === 2 && r.actions[1].args.path === "b.txt" && r.actions[1].args.content === "hi");
    check("…prose kept", r.prose === "Reading.");

    r = X.parseToolCalls([call("write_file", { path: "a.py", content: "x" }, "w1"), call("run_python", { code: "import a" }, "py"), call("write_file", { path: "b.py", content: "y" }, "w2")], "", "tool_calls", 1);
    check("write, run_python, write → only the first write runs", r.kind === "files" && r.actions.length === 1 && r.actions[0].id === "w1");
    check("…the others get reasons", r.skipped.length === 2 && /doesn't run in the same reply as file tools/.test(r.skipped.find(s => s[0] === "py")[1]) && /Call write_file again/.test(r.skipped.find(s => s[0] === "w2")[1]), JSON.stringify(r.skipped));

    r = X.parseToolCalls([call("run_python", { code: "a=1" }, "p1"), call("run_python", { code: "print(a)" }, "p2"), call("finish", { answer: "done" }, "f")], "", "tool_calls", 1);
    check("two run_python + finish → the first runs", r.kind === "code" && r.code === "a=1\n");
    check("…second told only the first runs, finish not processed", /only the first run_python/.test(r.skipped.find(s => s[0] === "p2")[1]) && /Not processed: finish/.test(r.skipped.find(s => s[0] === "f")[1]));

    r = X.parseToolCalls([call("finish", { answer: "All **done**." }, "f")], "", "tool_calls", 1);
    check("finish alone → final", r.kind === "final" && r.answer === "All **done**." && r.stored.length === 1);
    r = X.parseToolCalls([call("finish", { answer: "" }, "f")], "The answer is 42.", "tool_calls", 1);
    check("finish without an answer but with text → final (the text is the answer)", r.kind === "final" && r.answer === "" && r.prose === "The answer is 42.");
    r = X.parseToolCalls([call("finish", {}, "f")], "", "tool_calls", 1);
    check("finish with nothing at all → badcall", r.kind === "badcall" && /needs an answer/.test(r.skipped[0][1]));
    r = X.parseToolCalls([call("ask_user", { question: "Which column?" }, "q"), call("bash", { cmd: "ls" }, "b")], "", "tool_calls", 1);
    check("ask_user (plus an unknown tool) → ask, only ask_user kept", r.kind === "ask" && r.question === "Which column?" && r.stored.map(c => c.id).join() === "q", JSON.stringify(r));

    r = X.parseToolCalls([call("bash", { cmd: "python x.py" }, "b")], "", "tool_calls", 1);
    check("unknown tool → badcall, with no-shell advice", r.kind === "badcall" && /no shell/.test(r.skipped[0][1]) && r.stored.length === 1);
    r = X.parseToolCalls([call("run_python", { code: "  " }, "p"), call("read_file", { path: "a" }, "r")], "", "tool_calls", 1);
    check("run_python without code → nothing runs", r.kind === "badcall" && /needs code/.test(r.skipped[0][1]) && /had no code/.test(r.skipped[1][1]));

    r = X.parseToolCalls([call("run_python", '{"code": "print(1)', "p")], "", "length", 1);
    check("arguments cut by the token limit → cutoff, nothing stored", r.kind === "cutoff" && r.stored.length === 0, JSON.stringify(r));
    r = X.parseToolCalls([call("run_python", '{"code": oops}', "p")], "", "tool_calls", 1);
    check("invalid JSON otherwise → badcall, dropped from the history, named in notes", r.kind === "badcall" && r.stored.length === 0 && /not a valid JSON object/.test(r.notes[0]));
    r = X.parseToolCalls([call("run_python", '{"code": oops}', "bad"), call("run_python", { code: "print(2)" }, "good")], "", "tool_calls", 1);
    check("one bad, one good → the good one runs, the bad one is noted", r.kind === "code" && r.code === "print(2)\n" && r.stored.length === 1 && r.notes.length === 1);
    r = X.parseToolCalls([{ id: "o", name: "write_file", arguments: { path: "x.txt", content: "obj" } }], "", "tool_calls", 1);
    check("arguments sent as an object are accepted", r.kind === "files" && r.actions[0].args.content === "obj" && JSON.parse(r.stored[0].arguments).content === "obj");

    r = X.parseToolCalls([call("read_file", { path: "a" }, ""), call("read_file", { path: "b" }, "")], "", "tool_calls", 7);
    const ids = r.stored.map(c => c.id);
    check("missing ids → generated, unique, 9 alphanumerics", ids.length === 2 && ids[0] !== ids[1] && ids.every(i => /^[A-Za-z0-9]{9}$/.test(i)), ids.join());
    r = X.parseToolCalls([call("read_file", { path: "a" }, "same"), call("read_file", { path: "b" }, "same")], "", "tool_calls", 7);
    check("duplicate ids → the second gets a new one", r.stored[0].id === "same" && r.stored[1].id !== "same");
}

section("4. parseToolCalls — replies without calls");
{
    check("plain text → final answer", X.parseToolCalls([], "The total is 5.", "stop", 1).kind === "final");
    let r = X.parseToolCalls([], `Let me run it.\n${F}python\nprint(1)\n${F}`, "stop", 1);
    check("a python fence in text → textaction (runs nothing)", r.kind === "textaction" && r.what === "code");
    r = X.parseToolCalls([], `<write_file path="a.txt">\nx\n</write_file>`, "stop", 1);
    check("a file tag in text → textaction (files)", r.kind === "textaction" && r.what === "files");
    r = X.parseToolCalls([], `<tool_call>\n{"name": "run_python"}\n</tool_call>`, "stop", 1);
    check("a tool call written as text → textaction (toolcall)", r.kind === "textaction" && r.what === "toolcall");
    check("ask: line → ask", X.parseToolCalls([], "ask: Which file?", "stop", 1).kind === "ask");
    check("empty → empty", X.parseToolCalls([], "  ", "stop", 1).kind === "empty");
    check("cut off text → cutoff", X.parseToolCalls([], "I will now", "length", 1).kind === "cutoff");
    check("advice names the tools in native mode", /Call run_python instead/.test(X.noActionAdvice({ kind: "textaction", what: "code" }, true, false)));
    check("cut-off advice: tool wording native, fence wording text", /tool call/.test(X.noActionAdvice({ kind: "cutoff" }, true, false)) && /```python/.test(X.noActionAdvice({ kind: "cutoff" }, false, false)));
    check("context-cut advice says the context filled up", /context window filled up/.test(X.noActionAdvice({ kind: "cutoff" }, true, true)));
}

section("5. Native file batches through the executor");
{
    const files = { "app.py": "x = 1\n" };
    const ws = { paths: Object.keys(files), read: (p) => (p in files ? enc.encode(files[p]) : null) };
    let r = X.parseToolCalls([call("write_file", { path: "new.txt", content: "hello\n" }, "w"), call("read_file", { path: "new.txt" }, "r")], "", "tool_calls", 1);
    let a = X.applyFileActions(r.actions, ws);
    check("a read sees the write before it", a.results[1].ok && a.results[1].output.includes("hello"));
    let texts = X.fileCallResults(a.results, a.failed);
    check("one result per call", texts.length === 2 && texts[0].startsWith("write_file new.txt: created") && texts[1].startsWith("read_file new.txt: lines 1–1 of 1"), texts.join(" | "));

    r = X.parseToolCalls([call("write_file", { path: "b.txt", content: "b" }, "w"), call("edit_file", { path: "app.py", edits: [{ old_text: "y = 2", new_text: "z" }] }, "e")], "", "tool_calls", 1);
    a = X.applyFileActions(r.actions, ws);
    texts = X.fileCallResults(a.results, a.failed);
    check("failed batch: nothing written", a.failed && a.writes.size === 0);
    check("…the earlier write says it wasn't applied", /not applied, because the edit_file call for app\.py failed/.test(texts[0]), texts[0]);
    check("…the failing edit uses the tool's field names", /ERROR: the old_text text was not found/.test(texts[1]) && !/<old>/.test(texts[1]), texts[1]);

    r = X.parseToolCalls([call("edit_file", { path: "../x", edits: [] }, "e"), call("write_file", { path: "c.txt" }, "w")], "", "tool_calls", 1);
    check("unsafe path and missing content become action errors", /Unsafe path/.test(r.actions[0].error) && /needs content/.test(r.actions[1].error));
}

section("6. History: pending calls, text form, elision, compaction");
{
    // ask_user waits for the user: the answer is its result.
    let msgs = [{ role: "system", content: "s" }, { role: "user", content: "Task" }, asMsg([call("ask_user", { question: "Which?" }, "q")])];
    check("an unanswered ask_user → the model isn't due", !X.awaitsModel(msgs));
    X.appendToLastUserMessage(msgs, "The second one.");
    check("the answer becomes ask_user's tool result", msgs.length === 4 && msgs[3].role === "tool" && msgs[3].tool_call_id === "q" && msgs[3].content === "The second one.");
    check("…and the model is due", X.awaitsModel(msgs));
    X.appendToLastUserMessage(msgs, "Note: hurry.");
    check("a note after a tool result is a user message", msgs.length === 5 && msgs[4].role === "user");
    X.appendToLastUserMessage(msgs, "More.");
    check("…and later text joins it", msgs.length === 5 && msgs[4].content.endsWith("More."));

    msgs = [{ role: "system", content: "s" }, { role: "user", content: "Task" }, asMsg([call("finish", { answer: "Done." }, "f")])];
    X.appendToLastUserMessage(msgs, "Now add a chart.");
    check("a follow-up after finish: finish acknowledged, then the user message", msgs.length === 5 && msgs[3].role === "tool" && msgs[3].tool_call_id === "f" && msgs[4].role === "user" && msgs[4].content === "Now add a chart.");

    msgs = [{ role: "system", content: "s" }, { role: "user", content: "Task" }, { role: "assistant", content: "Answer." }];
    X.appendToLastUserMessage(msgs, "Follow-up");
    check("text mode unchanged: a user message after the answer", msgs.length === 4 && msgs[3].role === "user");

    const hist = [
        { role: "system", content: "s" }, { role: "user", content: "Task" },
        { ...asMsg([call("run_python", { code: "print(1)" }, "p")]), content: "Running." },
        { role: "tool", tool_call_id: "p", content: '<observation step="1" status="ok">\n1\n</observation>' },
        { role: "user", content: "Note: also b" },
        asMsg([call("write_file", { path: "a.txt", content: "x\n" }, "w"), call("edit_file", { path: "a.txt", edits: [{ old_text: "x", new_text: "y" }] }, "e")]),
        { role: "tool", tool_call_id: "w", content: "obs w" }, { role: "tool", tool_call_id: "e", content: "obs e" },
        asMsg([call("ask_user", { question: "Ok?" }, "q")]),
    ];
    const text = X.toolHistoryAsText(hist);
    check("text form: no tool roles or calls left", text.every(m => ["system", "user", "assistant"].includes(m.role) && !m.tool_calls));
    check("…run_python became a fence after the prose", text[2].content === `Running.\n\n${F}python\nprint(1)\n${F}`, JSON.stringify(text[2].content));
    check("…a tool result and the note after it merged into one user message", text[3].role === "user" && text[3].content.includes("<observation") && text[3].content.endsWith("Note: also b") && text[4].role === "assistant");
    const back = X.extractFileActions(text[4].content);
    check("…file calls became tags that parse back to the same actions", back.actions.length === 2 && back.actions[0].args.content === "x\n" && back.actions[1].args.edits[0].old_text === "x" && back.actions[1].args.edits[0].new_text === "y", JSON.stringify(back.actions));
    check("…ask_user became an ask: line", X.parseReply(text[6].content, "stop").kind === "ask");
    check("…roles alternate", text.slice(1).every((m, i) => m.role === (i % 2 ? "assistant" : "user")), text.map(m => m.role).join());
    check("messageChars counts call arguments", X.messageChars([hist[5]]) > 40);

    // Elision: an old native write_file keeps valid JSON with its content shortened.
    const big = "line\n".repeat(1000);
    const long = [{ role: "system", content: "s" }, { role: "user", content: "Task" }];
    long.push(asMsg([call("write_file", { path: "big.txt", content: big }, "w0")]));
    long.push({ role: "tool", tool_call_id: "w0", content: `<observation step="1" status="ok">\n${"o".repeat(5000)}\n</observation>` });
    for (let i = 2; i <= 9; i++) { long.push(asMsg([call("run_python", { code: "print(" + i + ")" }, "p" + i)])); long.push({ role: "tool", tool_call_id: "p" + i, content: "ok" }); }
    const el = X.elideHistory(long, 4, 2000);
    const args = JSON.parse(el[2].tool_calls[0].function.arguments);
    check("elided write_file call: still valid JSON, content replaced", args.path === "big.txt" && /elided from this old step/.test(args.content) && args.content.length < 200);
    check("…its tool result elided too, id kept", el[3].tool_call_id === "w0" && /elided to save context/.test(el[3].content));
    check("…the history itself untouched", JSON.parse(long[2].tool_calls[0].function.arguments).content === big);

    const plan = X.planCompaction(long, 4, 2);
    const req = X.buildCompactionRequest(long, plan.cut);
    check("summariser sees calls written out", req[1].content.includes("<write_file path=\"big.txt\">"));
    const comp = X.buildCompactedMessages(long, plan.cut, "SUMMARY", plan.steps, []);
    check("compacted tail keeps tool calls and ids", comp[2].role === "assistant" && comp[2].tool_calls.length === 1 && comp[3].tool_call_id === comp[2].tool_calls[0].id);
    check("copyMessage is deep", (() => { const c = X.copyMessage(long[2]); c.tool_calls[0].function.arguments = "{}"; return long[2].tool_calls[0].function.arguments !== "{}"; })());
}

section("7. Prompts and hints");
{
    const t = X.buildSystemPrompt("", [], "tools");
    check("native prompt describes the tools, not fences", /run_python/.test(t) && /finish/.test(t) && !/exactly ONE \\?`\\?`\\?`python code block/.test(t) && !t.includes("<write_file path="));
    check("text prompt unchanged without a protocol", X.buildSystemPrompt("x", []) === X.buildSystemPrompt("x", [], "text") && X.buildSystemPrompt("x", []).includes("<write_file path="));
    check("filename hint names write_file in native mode", /write_file with path "reader.py"/.test(X.filenameCommentHint("# reader.py\nprint(1)", [], true)));
    check("…and the tag in text mode", /<write_file path="reader.py">/.test(X.filenameCommentHint("# reader.py\nprint(1)", [])));
}

section("8. Session schema (format 2)");
{
    const base = { task: "t", timeline: [], messages: [{ role: "system", content: "s" }, { role: "user", content: "Task" }] };
    const s = X.validateSession({ ...base, protocol: "tools", messages: [...base.messages, asMsg([call("run_python", { code: "1" }, "p")]), { role: "tool", tool_call_id: "p", content: "ok", extra: "<b>" }],
        timeline: [{ type: "step", n: 1, protocol: "tools", skippedCalls: ["finish: Not processed", 5] }], settings: { toolMode: "native" } });
    check("tool calls and tool messages kept", s.messages[2].tool_calls[0].function.name === "run_python" && s.messages[3].tool_call_id === "p" && !("extra" in s.messages[3]));
    check("session protocol, step protocol, skipped calls, toolMode kept", s.protocol === "tools" && s.timeline[0].protocol === "tools" && s.timeline[0].skippedCalls.length === 1 && s.settings.toolMode === "native");
    check("format 1 sessions read as text protocol, auto mode", X.validateSession(base).protocol === "text" && X.validateSession(base).settings.toolMode === "auto");
    const bad = (msgs) => { try { X.validateSession({ ...base, messages: msgs }); return false; } catch (e) { return /malformed/.test(e.message); } };
    check("a tool message without an id is refused", bad([{ role: "tool", content: "x" }]));
    check("malformed tool_calls are refused", bad([{ role: "assistant", content: "", tool_calls: [{ id: "a", function: { name: "x", arguments: {} } }] }]));
    check("an unknown role is refused", bad([{ role: "function", content: "x" }]));
    check("format version is 2", X.SESSION_FORMAT_VERSION === 2);
}

report();
