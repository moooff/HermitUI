// ask_llm (DESIGN §5.9): the tool and the tag, what runs next to what, the files a
// request attaches, the request itself, the guards, and the session schema.
// Run: node tests/askllm.test.mjs
import { check, section, report } from "./check.mjs";
import X from "./extract.mjs";

const F = "```";
const enc = new TextEncoder();
const call = (name, args, id) => ({ id: id === undefined ? "id_" + name : id, name, arguments: typeof args === "string" ? args : JSON.stringify(args) });

section("1. The tool and the system prompt");
{
    const def = X.agentToolDefs().find(d => d.function.name === "ask_llm");
    check("ask_llm(prompt, files, effort), prompt required", def && Object.keys(def.function.parameters.properties).join() === "prompt,files,effort" && def.function.parameters.required.join() === "prompt");
    check("effort is one of off, low, medium, high", JSON.stringify(def.function.parameters.properties.effort.enum) === '["off","low","medium","high"]');
    check("files is a list of at most llmMaxFiles strings", def.function.parameters.properties.files.type === "array" && def.function.parameters.properties.files.maxItems === X.LIMITS.llmMaxFiles);
    const tools = X.buildSystemPrompt("", [], "tools", 60), text = X.buildSystemPrompt("", [], "text", 60);
    check("the tools prompt describes ask_llm and that it runs alone", /- ask_llm: /.test(tools) && /one ask_llm call/.test(tools));
    check("both say that a file can go in part", /"report\.txt:120-180"/.test(tools) && /with :first-last only those lines/.test(text));
    check("both say when to reason less or more", /Set effort to "off" for extracting/.test(tools) && /effort \(optional\) sets how much it reasons: "off" for extracting/.test(text) && /<ask_llm files="[^"]*" effort="off">/.test(text));
    check("the text prompt shows the tag and lists it among the reply kinds", /<ask_llm files="/.test(text) && /3\. Short reasoning, then one <ask_llm> request/.test(text));
}

section("2. parseToolCalls — native calls");
{
    let r = X.parseToolCalls([call("ask_llm", { prompt: "  Summarise it.  ", files: ["notes.txt", "/workspace/docs/a.md", "notes.txt"] })], "", "tool_calls", 1);
    check("one ask_llm → llm, prompt trimmed", r.kind === "llm" && r.prompt === "Summarise it." && r.runId === "id_ask_llm" && !r.error, JSON.stringify(r));
    check("…files normalised and deduplicated", JSON.stringify(r.files) === '["notes.txt","docs/a.md"]');
    check("…stored for the history", r.stored.length === 1 && r.stored[0].name === "ask_llm");
    r = X.parseToolCalls([call("ask_llm", { prompt: "x", files: "a.txt, b.txt" })], "", "tool_calls", 1);
    check("files as one comma-separated string still work", JSON.stringify(r.files) === '["a.txt","b.txt"]' && !r.error);
    r = X.parseToolCalls([call("ask_llm", { prompt: "x", files: ["../etc/passwd"] })], "", "tool_calls", 1);
    check("an unsafe path is an error", r.kind === "llm" && /Unsafe path/.test(r.error));
    r = X.parseToolCalls([call("ask_llm", { files: ["a.txt"] })], "", "tool_calls", 1);
    check("no prompt is an error", r.kind === "llm" && /needs a prompt/.test(r.error));
    r = X.parseToolCalls([call("ask_llm", { prompt: "x", files: Array.from({ length: 21 }, (_, i) => `f${i}.txt`) })], "", "tool_calls", 1);
    check("more than llmMaxFiles files is an error", /more than the 20/.test(r.error));

    r = X.parseToolCalls([call("ask_llm", { prompt: "x" }, "a"), call("run_python", { code: "1" }, "b")], "", "tool_calls", 1);
    check("ask_llm then run_python: ask_llm runs, run_python waits", r.kind === "llm" && r.skipped.length === 1 && r.skipped[0][0] === "b" && /doesn't run in the same reply as ask_llm\. Call it again now that the answer is back/.test(r.skipped[0][1]), JSON.stringify(r.skipped));
    r = X.parseToolCalls([call("run_python", { code: "1" }, "a"), call("ask_llm", { prompt: "x" }, "b")], "", "tool_calls", 1);
    check("run_python then ask_llm: the code runs", r.kind === "code" && /ask_llm doesn't run in the same reply as run_python\. Call it again now that the code has run/.test(r.skipped[0][1]));
    r = X.parseToolCalls([call("read_file", { path: "a.txt" }, "a"), call("ask_llm", { prompt: "x" }, "b")], "", "tool_calls", 1);
    check("a file tool first: the file tools run, ask_llm waits", r.kind === "files" && r.actions.length === 1 && /ask_llm doesn't run in the same reply as file tools/.test(r.skipped[0][1]));
    r = X.parseToolCalls([call("ask_llm", { prompt: "x" }, "a"), call("read_file", { path: "a.txt" }, "b")], "", "tool_calls", 1);
    check("ask_llm first: a file tool after it waits", r.kind === "llm" && /read_file doesn't run in the same reply as ask_llm/.test(r.skipped[0][1]));
    r = X.parseToolCalls([call("ask_llm", { prompt: "x" }, "a"), call("ask_llm", { prompt: "y" }, "b")], "", "tool_calls", 1);
    check("two ask_llm calls: only the first runs", r.kind === "llm" && r.prompt === "x" && /only the first ask_llm call of a reply runs/.test(r.skipped[0][1]));
    r = X.parseToolCalls([call("run_python", { code: "1" }, "a"), call("run_python", { code: "2" }, "b")], "", "tool_calls", 1);
    check("two run_python calls keep their old reason", r.skipped[0][1] === "Not run: only the first run_python call of a reply runs. Send this one again if you still need it.");
    r = X.parseToolCalls([call("update_plan", { plan: [{ step: "read", status: "in_progress" }] }, "p"), call("ask_llm", { prompt: "x" }, "a")], "", "tool_calls", 1);
    check("a plan goes along with ask_llm", r.kind === "llm" && r.plan.length === 1 && r.planResults.length === 1 && !r.skipped.length);
    r = X.parseToolCalls([], "Let me ask.\n<ask_llm>\nSummarise.\n</ask_llm>", "stop", 1);
    check("natively, an <ask_llm> tag in the text runs nothing", r.kind === "textaction" && r.what === "llm");
    check("…and the advice says to call the tool", /Call ask_llm instead/.test(X.noActionAdvice(r, true)));
}

{
    let r = X.parseToolCalls([call("ask_llm", { prompt: "x", effort: "OFF" })], "", "tool_calls", 1);
    check("effort comes along, lower-cased", r.kind === "llm" && r.effort === "off" && !r.error, JSON.stringify(r));
    r = X.parseToolCalls([call("ask_llm", { prompt: "x" })], "", "tool_calls", 1);
    check("…left out: no effort", r.kind === "llm" && !("effort" in r) && !r.error);
    r = X.parseToolCalls([call("ask_llm", { prompt: "x", effort: "max" })], "", "tool_calls", 1);
    check("…an unknown level is an error that lists the valid ones", r.kind === "llm" && /effort must be one of off, low, medium, high/.test(r.error), r.error);
}

section("3. parseReply — the <ask_llm> tag");
{
    let r = X.parseReply(`I'll ask for a summary.\n<ask_llm files="notes.txt, docs/a.md">\nSummarise these.\n${F}python\nprint("not run")\n${F}\n</ask_llm>`, "stop");
    check("the tag → llm with its prompt and files", r.kind === "llm" && JSON.stringify(r.files) === '["notes.txt","docs/a.md"]' && r.count === 1, JSON.stringify(r));
    check("…a python fence inside the request is part of it, not code", r.prompt.includes('print("not run")') && r.prompt.startsWith("Summarise these."));
    check("…the prose is the text outside the tag", r.prose === "I'll ask for a summary.");
    r = X.parseReply("<ask_llm>\nTranslate: Hallo\n</ask_llm>", "stop");
    check("no files attribute → no files", r.kind === "llm" && r.files.length === 0 && r.prompt === "Translate: Hallo");
    r = X.parseReply("<ask_llm>\nfirst\n</ask_llm>\n<ask_llm>\nsecond\n</ask_llm>", "stop");
    check("two tags: the first counts, count says 2", r.kind === "llm" && r.prompt === "first" && r.count === 2);
    r = X.parseReply("<ask_llm>\nSummarise", "length");
    check("unclosed and cut off → cutoff", r.kind === "cutoff");
    r = X.parseReply("<ask_llm>\nSummarise", "stop");
    check("unclosed → broken, naming the tag", r.kind === "broken" && r.unclosed === "ask_llm");
    check("…and the advice names it", /<ask_llm> tag without its closing <\/ask_llm>/.test(X.noActionAdvice(r, false)));
    r = X.parseReply(`<ask_llm>\nx\n</ask_llm>\n${F}python\nprint(1)\n${F}`, "stop");
    check("with a python block → mixed, nothing runs", r.kind === "mixed" && r.with === "ask_llm");
    check("…and the advice says to send it alone", /Send <ask_llm> alone/.test(X.noActionAdvice(r, false)));
    r = X.parseReply(`<read_file path="a.txt"/>\n<ask_llm>\nx\n</ask_llm>`, "stop");
    check("with a file action → mixed", r.kind === "mixed" && r.with === "ask_llm");
    r = X.parseReply(`<write_file path="doc.md">\n<ask_llm>\nnot a request\n</ask_llm>\n</write_file>`, "stop");
    check("an <ask_llm> inside a written file's content is content", r.kind === "files" && r.actions[0].args.content.includes("<ask_llm>"));
    r = X.parseReply("<update_plan>\n- [>] summarise\n</update_plan>\n<ask_llm>\nx\n</ask_llm>", "stop");
    check("a plan goes along with the tag", r.kind === "llm" && r.plan.length === 1);
    r = X.parseReply('<ask_llm files="../secret.txt">\nx\n</ask_llm>', "stop");
    check("an unsafe path in files is an error", r.kind === "llm" && /Unsafe path/.test(r.error));
    r = X.parseReply("<ask_llm>\n</ask_llm>", "stop");
    check("an empty request is an error", r.kind === "llm" && /needs a prompt/.test(r.error));
    r = X.parseReply('<ask_llm files="a.txt" effort="high">\nJudge it.\n</ask_llm>', "stop");
    check("the tag's effort attribute", r.kind === "llm" && r.effort === "high" && JSON.stringify(r.files) === '["a.txt"]' && !r.error, JSON.stringify(r));
}

section("4. Both protocols carry the same request");
{
    const c = { id: "a", type: "function", function: { name: "ask_llm", arguments: JSON.stringify({ prompt: "Compare \"x\" & y.\nTwo lines.", files: ["a b.txt", "docs/c.md"] }) } };
    const text = X.toolCallAsText(c);
    const back = X.parseReply(text, "stop");
    check("a native call written as a tag parses back the same", back.kind === "llm" && back.prompt === "Compare \"x\" & y.\nTwo lines." && JSON.stringify(back.files) === '["a b.txt","docs/c.md"]', text);
    check("…without files, no attribute", X.toolCallAsText({ function: { name: "ask_llm", arguments: '{"prompt":"x"}' } }) === "<ask_llm>\nx\n</ask_llm>");
    const e = X.toolCallAsText({ function: { name: "ask_llm", arguments: '{"prompt":"x","files":["a.txt"],"effort":"off"}' } });
    check("…effort becomes an attribute and parses back", e === '<ask_llm files="a.txt" effort="off">\nx\n</ask_llm>' && X.parseReply(e, "stop").effort === "off", e);
}

section("5. The attached files");
{
    const spec = (raw) => X.parseLlmFileSpec(raw);
    check("a path alone is the whole file", JSON.stringify(spec(" /workspace/a.txt ")) === '{"path":"a.txt","start":1,"end":0,"spec":"a.txt"}');
    check("path:first-last", JSON.stringify(spec("r.txt:120-180")) === '{"path":"r.txt","start":120,"end":180,"spec":"r.txt:120-180"}');
    check("path:N is one line, path:N- runs to the end", spec("r.txt:7").end === 7 && spec("r.txt:7").spec === "r.txt:7" && spec("r.txt:400-").end === 0 && spec("r.txt:400-").spec === "r.txt:400-");
    check("a backwards or zero range is an error", /not a line range/.test(spec("r.txt:9-3").error) && /not a line range/.test(spec("r.txt:0-3").error));
    check("an unsafe path with a range is still refused", /Unsafe path/.test(spec("../r.txt:1-2").error));
    let c = X.llmCallFromArgs("x", ["r.txt:1-2", "r.txt:1-2", "r.txt:5-6", "r.txt"]);
    check("ranges of one file are separate entries, repeats dropped", JSON.stringify(c.files) === '["r.txt:1-2","r.txt:5-6","r.txt"]', JSON.stringify(c.files));
    c = X.extractLlmCall('<ask_llm files="r.txt:3-4, notes.txt">\nx\n</ask_llm>');
    check("the tag takes ranges too", JSON.stringify(c.files) === '["r.txt:3-4","notes.txt"]');
    const lines = { "r.txt": enc.encode("one\ntwo\nthree\nfour\nfive\n"), "n.txt": enc.encode("a\nb") };
    const rd = (p) => lines[p] || null;
    let g = X.gatherLlmFiles(["r.txt:2-3"], rd, 1000, 0);
    check("a range sends only those lines", g.files[0].text === "two\nthree\n" && g.files[0].start === 2 && g.files[0].end === 3 && g.files[0].total === 5 && g.chars === 10, JSON.stringify(g));
    g = X.gatherLlmFiles(["r.txt:4-99", "n.txt:2-"], rd, 1000, 0);
    check("an end past the file stops at its last line; N- runs to the end", g.files[0].text === "four\nfive\n" && g.files[0].end === 5 && g.files[1].text === "b\n" && g.files[1].total === 2, JSON.stringify(g));
    g = X.gatherLlmFiles(["r.txt:6-7"], rd, 1000, 0);
    check("a range that starts after the end is an error", g.error === "r.txt has 5 lines, so r.txt:6-7 starts after its end.", g.error);
    g = X.gatherLlmFiles(["r.txt:1-5"], rd, 12, 0);
    check("the size limit counts only the lines sent", /has 24 characters, more than the 12/.test(g.error) && !X.gatherLlmFiles(["r.txt:1-1"], rd, 12, 0).error);
    const files = { "a.txt": enc.encode("alpha\n"), "b.md": enc.encode("beta"), "img.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]) };
    const read = (p) => files[p] || null;
    g = X.gatherLlmFiles(["a.txt", "b.md"], read, 1000, 10);
    check("text files are read whole", !g.error && g.files.length === 2 && g.files[0].text === "alpha\n" && g.chars === 10 + 6 + 4, JSON.stringify(g));
    g = X.gatherLlmFiles(["nope.txt"], read, 1000, 0);
    check("a missing file is an error", /nope\.txt is not a file in \/workspace/.test(g.error));
    g = X.gatherLlmFiles(["img.png"], read, 1000, 0);
    check("a binary file is an error that says what to do", /binary file/.test(g.error) && /Extract its text with Python/.test(g.error));
    g = X.gatherLlmFiles(["a.txt", "b.md"], read, 12, 5);
    check("over the size limit, the error gives the total", /has 15 characters, more than the 12/.test(g.error), g.error);
    g = X.gatherLlmFiles([], read, 1000, 3);
    check("no files: just the prompt's size", !g.error && g.files.length === 0 && g.chars === 3);
}

section("6. The request and its answer");
{
    const m = X.buildLlmMessages("  Summarise.  ", [{ path: "a.txt", text: "alpha\n" }, { path: "code.md", text: `${F}python\nx\n${F}\n` }]);
    check("a system message, then one user message", m.length === 2 && m[0].role === "system" && m[0].content === X.LLM_SYSTEM_PROMPT && m[1].role === "user");
    check("the files come first, the prompt last", m[1].content.startsWith("File a.txt:\n```\nalpha\n```") && m[1].content.endsWith("\n\nSummarise."), m[1].content);
    check("a file holding a fence gets a longer one", m[1].content.includes("File code.md:\n````\n```python"));
    check("no files: the prompt alone", X.buildLlmMessages("Hi", [])[1].content === "Hi");
    check("a range is named in the file's heading", X.buildLlmMessages("x", [{ path: "r.txt", text: "two\n", start: 2, end: 2, total: 5 }])[1].content.startsWith("File r.txt, lines 2-2 of 5:\n```\ntwo\n```"));
    check("a short answer goes back whole", X.clipLlmAnswer("abc", 10) === "abc");
    const long = X.clipLlmAnswer("x".repeat(25), 10);
    check("a long one is cut, saying how much is missing", long.startsWith("x".repeat(10) + "\n[… 15 more characters") && /ask for a shorter answer/.test(long));
}

section("6b. Reasoning level and reply budget");
{
    const L = X.llmReasoningLevel;
    check("no level asked for: the session's", L(undefined, "low") === "low" && L(undefined, "default") === "default");
    check("a lower one than the session's: as asked", L("off", "low") === "off" && L("low", "high") === "low");
    check("a higher one: capped at the session's", L("high", "low") === "low" && L("medium", "off") === "off");
    check("a session at the model's default sets no cap", L("high", "default") === "high" && L("off", "default") === "off");
    const B = X.llmMaxTokens;
    check("twice the agent's budget", B(8192, 2, 0, 1000) === 16384);
    check("…but no more than the context leaves", B(8192, 2, 12000, 1000) === 12000 - 1100 - 256);
    check("…and never below what fits", B(8192, 2, 70144, 30000) === 16384);
    check("Max tokens 0 (none): none here either", B(0, 2, 70144, 1000) === 0);
    check("a request that leaves no room keeps the agent's budget", B(8192, 2, 4096, 5000) === 8192);
    check("the factor is a LIMITS entry", X.LIMITS.llmTokenFactor === 2);
    const R = X.llmRetryReason;
    check("cut off while reasoning → retry", /cut off at the token limit/.test(R("", "long thought", "length", "low", true)));
    check("ended inside the reasoning → retry", /ended inside the model's reasoning/.test(R("  ", "thought", "stop", "default", true)));
    check("an answer, even a cut one → no retry", R("partial", "t", "length", "low", true) === "");
    check("already off, or the endpoint can't turn it off → no retry", R("", "t", "length", "off", true) === "" && R("", "t", "length", "low", false) === "");
    check("empty with no reasoning at all → no retry (nothing to save)", R("", "", "stop", "low", true) === "");
}

section("7. The guards");
{
    const a = { kind: "llm", prompt: "x", files: ["a.txt"] };
    check("the loop guard tells requests apart", X.actionSignature(a) === X.actionSignature({ ...a }) && X.actionSignature(a) !== X.actionSignature({ ...a, prompt: "y" }) && X.actionSignature(a).startsWith("llm:"));
    check("…and names the request when it repeats", /same ask_llm request as your last 2 steps/.test(X.repeatAdvice("llm", 2, true)));
    const sig = X.errorSignature({ kind: "llm", status: "error", output: "notes.txt is not a file in /workspace.\nmore" });
    check("a failed request's error signature is its first line", sig === "llm:notes.txt is not a file in /workspace.");
    check("…and the advice talks about requests, not code", /Your ask_llm requests have now failed 3 times/.test(X.errorRepeatAdvice(sig, 3, true)));
    check("an answered request is no error", X.errorSignature({ kind: "llm", status: "ok", output: "fine" }) === "");
}

section("8. Session file and transcript");
{
    const step = { type: "step", n: 2, kind: "llm", status: "ok", phase: "done", llmPrompt: "Summarise.", llmFiles: ["a.txt", "../x", 3, "b.txt:5-9"], llmReasoning: "hm", llmEffort: "off", output: "Short.", llmStats: { prompt: 120, completion: 8, bogus: 1 } };
    const v = X.validateSession({ task: "t", messages: [], timeline: [step] }).timeline[0];
    check("the request, files, reasoning, level and stats survive an import", v.llmPrompt === "Summarise." && JSON.stringify(v.llmFiles) === '["a.txt","b.txt:5-9"]' && v.llmReasoning === "hm" && v.llmEffort === "off" && v.llmStats.prompt === 120 && !("bogus" in v.llmStats));
    const plain = X.validateSession({ task: "t", messages: [], timeline: [{ type: "step", n: 1, kind: "code" }] }).timeline[0];
    check("…other steps get no llmFiles or llmStats", !("llmFiles" in plain) && !("llmStats" in plain));
    const md = X.transcriptMarkdown({ timeline: [v] });
    check("the transcript shows the request, its files and the answer", md.includes("Asked the model (ask_llm, reasoning off), attaching a.txt, b.txt:5-9:") && md.includes("Summarise.") && md.includes("Answer:\n\n```text\nShort."), md);
}

report();
