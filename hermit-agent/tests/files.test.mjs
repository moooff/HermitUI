// File actions: tag parsing, how they combine with ```python, and the executor that
// reads, writes and edits against a workspace without changing it.
// Run: node tests/files.test.mjs
import { check, section, report } from "./check.mjs";
import X from "./extract.mjs";

const F = "```";
const enc = new TextEncoder();
// A workspace stub in the shape applyFileActions expects.
const wsOf = (files) => ({
    paths: Object.keys(files),
    read: (p) => (p in files ? (files[p] instanceof Uint8Array ? files[p] : enc.encode(files[p])) : null),
});
const run = (text, files, opts) => X.applyFileActions(X.extractFileActions(text).actions, wsOf(files || {}), opts);

section("1. extractFileActions — tags, paths, content");
{
    let r = X.extractFileActions(`I'll look first.\n<read_file path="data.csv"/>\nthen this:\n<read_file path='src/app.py' start="10" end="20" />`);
    check("two reads found", r.actions.length === 2 && r.actions.every(a => a.tool === "read_file"), JSON.stringify(r.actions));
    check("double-quoted path", r.actions[0].args.path === "data.csv");
    check("single quotes and a line range", r.actions[1].args.path === "src/app.py" && r.actions[1].args.start_line === 10 && r.actions[1].args.end_line === 20);
    check("rest keeps the prose without the tags", r.rest.includes("I'll look first.") && r.rest.includes("then this:") && !r.rest.includes("<read_file"));
    check("nothing unclosed", r.unclosed === "");

    r = X.extractFileActions(`<read_file path="a.txt"></read_file>`);
    check("read with a closing tag", r.actions.length === 1 && !r.actions[0].error && r.rest.trim() === "");

    r = X.extractFileActions(`<write_file path="/workspace/README.md">\n# Title\n\n${F}python\nprint(1)\n${F}\n</write_file>\nDone.`);
    check("write: /workspace/ prefix stripped", r.actions[0].args.path === "README.md");
    check("write: fences inside content are content", r.actions[0].args.content === `# Title\n\n${F}python\nprint(1)\n${F}\n`, JSON.stringify(r.actions[0].args.content));
    check("write: prose after the tag kept", r.rest.trim() === "Done.");

    r = X.extractFileActions(`<write_file path="./x.txt">hello</write_file>`);
    check("write: ./ stripped, inline content", r.actions[0].args.path === "x.txt" && r.actions[0].args.content === "hello");

    r = X.extractFileActions(`<edit_file path="app.py">\n<old>\n    return 1\n</old>\n<new>\n    return 2\n</new>\n<old>a = 1</old>\n<new></new>\n</edit_file>`);
    const e = r.actions[0].args.edits;
    check("edit: two pairs", e.length === 2, JSON.stringify(e));
    check("edit: one newline trimmed at each end, indentation kept", e[0].old_text === "    return 1" && e[0].new_text === "    return 2");
    check("edit: empty <new> deletes", e[1].old_text === "a = 1" && e[1].new_text === "");

    r = X.extractFileActions(`Use <read_file path="x"/> to read.`);
    check("a tag mid-line is prose, not an action", r.actions.length === 0);

    r = X.extractFileActions(`<write_file path="a.py">\nprint(1)\n`);
    check("unclosed write is flagged", r.unclosed === "write_file" && r.actions.length === 0);

    r = X.extractFileActions(`<write_file path="a.txt"/>\nafter`);
    check("self-closing write → error, not 'unclosed'", r.unclosed === "" && /no content/.test(r.actions[0].error || "") && r.rest.trim() === "after", JSON.stringify(r));

    r = X.extractFileActions(`<write_file path="../etc/passwd">x</write_file>\n<read_file/>\n<edit_file path="a.py">\nno pairs\n</edit_file>\n<read_file path="a" start="0"/>`);
    check("unsafe path → error", /Unsafe path/.test(r.actions[0].error || ""), r.actions[0].error);
    check("missing path → error", /needs a path/.test(r.actions[1].error || ""));
    check("edit without pairs → error", /old/.test(r.actions[2].error || ""));
    check("start=0 → error", /line number/.test(r.actions[3].error || ""));
}

section("2. parseReply — files, mixed, broken");
{
    let r = X.parseReply(`Writing it.\n<write_file path="a.py">\nx = 1\n</write_file>`, "stop");
    check("file actions → kind files", r.kind === "files" && r.actions.length === 1 && r.prose === "Writing it.", JSON.stringify(r));
    r = X.parseReply(`<write_file path="a.py">\nx = 1\n</write_file>\n${F}python\nimport a\n${F}`, "stop");
    check("file actions + python → mixed", r.kind === "mixed", r.kind);
    r = X.parseReply(`<write_file path="a.py">\nx = 1\n</write_file>\n${F}python\nimport a`, "stop");
    check("file actions + unclosed python → mixed too", r.kind === "mixed", r.kind);
    r = X.parseReply(`<write_file path="doc.md">\n${F}python\nprint(1)\n${F}\n</write_file>`, "stop");
    check("a python fence inside a written file doesn't run", r.kind === "files", r.kind);
    r = X.parseReply(`<write_file path="a.py">\nx = 1\n`, "stop");
    check("unclosed tag → broken, naming the tag", r.kind === "broken" && r.unclosed === "write_file");
    check("unclosed tag at the token limit → cutoff", X.parseReply(`<edit_file path="a.py">\n<old>`, "length").kind === "cutoff");
    check("plain python still runs", X.parseReply(`${F}python\nprint(1)\n${F}`, "stop").kind === "code");
    check("a final answer still ends", X.parseReply("All done.", "stop").kind === "final");
}

section("3. applyFileActions — read");
{
    const files = { "a.txt": "one\ntwo\nthree\n", "crlf.txt": "x\r\ny\r\n", "empty.txt": "", "bin.dat": new Uint8Array([0x89, 0x50, 0x00, 0x01]) };
    let r = run(`<read_file path="a.txt"/>`, files);
    check("numbered lines", r.results[0].ok && r.results[0].output === "1\tone\n2\ttwo\n3\tthree", JSON.stringify(r.results[0]));
    check("message names the range", r.results[0].message === "lines 1–3 of 3");
    check("a read writes nothing", r.writes.size === 0 && !r.failed);
    r = run(`<read_file path="a.txt" start="2" end="2"/>`, files);
    check("line range", r.results[0].output === "2\ttwo" && r.results[0].startLine === 2 && r.results[0].endLine === 2);
    check("CRLF read without \\r", run(`<read_file path="crlf.txt"/>`, files).results[0].output === "1\tx\n2\ty");
    check("empty file", run(`<read_file path="empty.txt"/>`, files).results[0].output === "(empty file)");
    r = run(`<read_file path="bin.dat"/>`, files);
    check("binary refused", !r.results[0].ok && /binary/.test(r.results[0].message));
    r = run(`<read_file path="nope.txt"/>`, files);
    check("missing file", !r.results[0].ok && /no file nope.txt/.test(r.results[0].message));
    check("a failed read doesn't fail the batch", !r.failed);
    check("start past the end", /only 3 lines/.test(run(`<read_file path="a.txt" start="9"/>`, files).results[0].message));

    const big = Array.from({ length: 1000 }, (_, i) => "line " + (i + 1)).join("\n") + "\n";
    r = run(`<read_file path="big.txt"/>`, { "big.txt": big });
    check("capped at readMaxLines", r.results[0].endLine === 400 && /1000 lines in total; continue with start="401"/.test(r.results[0].output), r.results[0].message);
    check("line numbers padded to the widest", r.results[0].output.startsWith("  1\tline 1"));
    r = run(`<read_file path="big.txt" start="990"/>`, { "big.txt": big });
    check("reading to the end has no continuation note", r.results[0].endLine === 1000 && !/continue/.test(r.results[0].output));
    r = run(`<read_file path="big.txt"/>`, { "big.txt": big }, { readMaxChars: 100 });
    check("capped at readMaxChars", r.results[0].endLine < 20 && /continue with start/.test(r.results[0].output), r.results[0].message);
    r = run(`<read_file path="big.txt"/>\n<read_file path="big.txt" start="500"/>\n<read_file path="a.txt"/>`, { ...files, "big.txt": big }, { readMaxTotalChars: 120 });
    check("the reply's read budget runs out", r.results[0].ok && !r.results[2].ok && /budget/.test(r.results[2].message), JSON.stringify(r.results.map(x => x.message)));
    r = run(`<read_file path="long.txt"/>`, { "long.txt": "x".repeat(5000) });
    check("very long lines are cut", r.results[0].output.length < 2100 && /3000 more characters/.test(r.results[0].output));
}

section("4. applyFileActions — write");
{
    const files = { "a.txt": "old\n", "dir/inner.txt": "x" };
    let r = run(`<write_file path="new.py">\nprint(1)\n</write_file>`, files);
    check("create", r.results[0].ok && r.writes.get("new.py") === "print(1)\n" && /created \(1 line/.test(r.results[0].message), r.results[0].message);
    r = run(`<write_file path="a.txt">\nnew\n</write_file>`, files);
    check("replace", r.writes.get("a.txt") === "new\n" && /replaced/.test(r.results[0].message));
    r = run(`<write_file path="a.txt">\nold\n</write_file>`, files);
    check("same content → unchanged, no write", r.results[0].ok && r.writes.size === 0 && /unchanged/.test(r.results[0].message));
    r = run(`<write_file path="dir">x</write_file>`, files);
    check("a folder can't be overwritten", r.failed && /folder/.test(r.results[0].message));
    r = run(`<write_file path="a.txt/b.txt">x</write_file>`, files);
    check("a file can't be a folder", r.failed && /a.txt is a file/.test(r.results[0].message));
    r = run(`<write_file path="n.txt">\n1\n</write_file>\n<read_file path="n.txt"/>`, files);
    check("a read sees an earlier write in the same reply", r.results[1].output === "1\t1");
    r = run(`<write_file path="deep/er/f.md">\nx\n</write_file>`, files);
    check("new folders are fine", r.writes.has("deep/er/f.md"));
}

section("5. applyFileActions — edit");
{
    const src = "def f():\n    return 1\n\ndef g():\n    return 1\n";
    const files = { "m.py": src, "w.txt": "a\r\nb\r\n", "bin.dat": new Uint8Array([0, 1, 2]) };
    let r = run(`<edit_file path="m.py">\n<old>\ndef f():\n    return 1\n</old>\n<new>\ndef f():\n    return 42\n</new>\n</edit_file>`, files);
    check("unique match replaced", r.results[0].ok && r.writes.get("m.py") === src.replace("return 1", "return 42"), r.results[0].message);
    r = run(`<edit_file path="m.py">\n<old>\n    return 1\n</old>\n<new>\n    return 2\n</new>\n</edit_file>`, files);
    check("two matches → error asking for more context", r.failed && /matches 2 times/.test(r.results[0].message));
    r = run(`<edit_file path="m.py">\n<old>\nreturn 7\n</old>\n<new>\nx\n</new>\n</edit_file>`, files);
    check("no match → error", r.failed && /not found/.test(r.results[0].message));
    r = run(`<edit_file path="m.py">\n<old>\ndef f():\nreturn 1\n</old>\n<new>\nx\n</new>\n</edit_file>`, files);
    check("whitespace-only mismatch gets a hint", r.failed && /whitespace or indentation/.test(r.results[0].message), r.results[0].message);
    r = run(`<edit_file path="m.py">\n<old>\ndef g():\n</old>\n<new>\ndef g():\n</new>\n</edit_file>`, files);
    check("identical old/new → error", r.failed && /identical/.test(r.results[0].message));
    r = run(`<edit_file path="m.py">\n<old>\ndef f():\n    return 1\n</old>\n<new>\ndef f():\n    return 2\n</new>\n<old>\ndef f():\n    return 2\n</old>\n<new>\ndef f():\n    return 3\n</new>\n</edit_file>`, files);
    check("pairs apply in order", r.writes.get("m.py").startsWith("def f():\n    return 3\n") && /2 changes/.test(r.results[0].message));
    r = run(`<edit_file path="w.txt">\n<old>\na\nb\n</old>\n<new>\nc\nd\n</new>\n</edit_file>`, files);
    check("CRLF file: LF old/new adapted", r.results[0].ok && r.writes.get("w.txt") === "c\r\nd\r\n", JSON.stringify(r.writes.get("w.txt")));
    r = run(`<edit_file path="m.py">\n<old>\nreturn 1\n\ndef g\n</old>\n<new>$&$1</new>\n</edit_file>`, files);
    check("replacement text is literal ($& isn't a pattern)", r.writes.get("m.py") === src.replace("return 1\n\ndef g", () => "$&$1"));
    check("missing file → error", run(`<edit_file path="x.py">\n<old>a</old><new>b</new>\n</edit_file>`, files).failed);
    check("binary file → error", /binary/.test(run(`<edit_file path="bin.dat">\n<old>a</old><new>b</new>\n</edit_file>`, files).results[0].message));
}

section("5b. edit — relaxed matching, closest text on a miss");
{
    const edit = (path, pairs) => `<edit_file path="${path}">\n` + pairs.map(([o, n]) => `<old>\n${o}\n</old>\n<new>\n${n}\n</new>`).join("\n") + "\n</edit_file>";
    const files = {
        "curly.py": "print(“hi”)\nx = 1\n",
        "plain.py": "s = \"it's\"\nx = 1\n",
        "q.py": "print(\"hi\")\nx = 1\n",
        "esc.js": "log(\"say \\\"hi\\\"\");\nx = 1;\n",
        "trail.py": "a = 1   \nb = 2\n",
        "two.py": "a(“q”)\nb(“q”)\n",
        "mix.py": "a(\"q\")\nb(“q”)\n",
        "m.py": "def f():\n    return 1\n\ndef g():\n    return 1\n",
        "tag.py": "x = '<old>'\ny = 2\n",
        "nbsp.md": "Price:\u00A010\u2009€ \u2013 ok  \nend\n",
    };
    let r = run(edit("curly.py", [["print(\"hi\")", "print(\"bye\")"]]), files);
    check("ASCII <old> matches curly quotes in the file", r.results[0].ok && r.writes.get("curly.py") === "print(\"bye\")\nx = 1\n", r.results[0].message);
    check("…and the result says how it matched", /matched only after reading curly quotes/.test(r.results[0].message) && /copy <old> exactly/.test(r.results[0].message), r.results[0].message);
    r = run(edit("plain.py", [["s = \"it’s\"", "s = \"it’s ok\""]]), files);
    check("curly quotes <old> made up aren't carried into <new>", r.writes.get("plain.py") === "s = \"it's ok\"\nx = 1\n", JSON.stringify(r.writes.get("plain.py")));
    r = run(edit("q.py", [["print(\\\"hi\\\")", "print(\\\"bye\\\")"]]), files);
    check("over-escaped <old> matches, <new> is unescaped too", r.results[0].ok && r.writes.get("q.py") === "print(\"bye\")\nx = 1\n" && /backslashes/.test(r.results[0].message), r.results[0].message);
    r = run(edit("trail.py", [["a = 1\nb = 2", "a = 3\nb = 2"]]), files);
    check("trailing spaces in the file are ignored", r.writes.get("trail.py") === "a = 3\nb = 2\n" && /trailing spaces/.test(r.results[0].message), JSON.stringify(r.writes.get("trail.py")));
    r = run(edit("two.py", [["(\"q\")", "(\"z\")"]]), files);
    check("two relaxed matches → error, nothing written", r.failed && r.writes.size === 0 && /matches 2 times when reading curly quotes/.test(r.results[0].message), r.results[0].message);
    r = run(edit("nbsp.md", [["Price: 10 € - ok\nend", "Price: 12 € - ok\nend"]]), files);
    check("Unicode spaces and dashes read as plain ones, offsets kept", r.writes.get("nbsp.md") === "Price: 12 € - ok\nend\n", JSON.stringify(r.writes.get("nbsp.md")));
    r = run(edit("mix.py", [["a(\"q\")", "a(\"z\")"]]), files);
    check("an exact match wins, with the plain message", r.writes.get("mix.py") === "a(\"z\")\nb(“q”)\n" && r.results[0].message === "edited (1 change)", r.results[0].message);

    r = run(edit("m.py", [["def f():\n    return 7", "def f():\n    return 8"]]), files);
    check("a miss names the closest lines", r.failed && /not found in m\.py\. The closest text is lines 1–2/.test(r.results[0].message), r.results[0].message);
    check("…and shows them like read_file", r.results[0].excerpt === "1\tdef f():\n2\t    return 1", JSON.stringify(r.results[0].excerpt));
    check("the excerpt is in the text-protocol observation", X.formatFileResults(r.results, r.failed).includes("ERROR: the <old> text was not found in m.py. The closest text is lines 1–2, below: copy <old> exactly from there.\n1\tdef f():\n2\t    return 1"));
    r = run(edit("esc.js", [["log(\"say \"hi\"\");", "log(\"bye\");"]]), files);
    check("file escapes quotes, <old> doesn't → escaping hint", r.failed && /only in how quotes are escaped/.test(r.results[0].message) && r.results[0].excerpt === "1\tlog(\"say \\\"hi\\\"\");", r.results[0].message);
    r = run(edit("m.py", [["zzzz qqqq wwww", "x"]]), files);
    check("nothing similar → no excerpt, the old advice", r.failed && r.results[0].excerpt === undefined && /Read the file and copy the text exactly/.test(r.results[0].message), r.results[0].message);
    r = run(edit("m.py", [["def f():\n    return 1", "def f():\n    return 42"], ["def g():\n    return 9", "x"]]), files);
    check("a later change's miss says it's after the earlier ones", /change 2 of 2: .*after the earlier changes of this edit/.test(r.results[0].message), r.results[0].message);
    r = run(edit("tag.py", [["x = '<old>!'\ny = 2", "x = 1"]]), files);
    const native = X.fileCallResults(r.results, r.failed)[0];
    check("native results: tags renamed in the message, not in the file's text", /copy old_text exactly/.test(native) && native.includes("1\tx = '<old>'"), native);

    check("closestExcerpt: blank lines at <old>'s ends don't count", JSON.stringify(X.closestExcerpt("a\nbcd\ne\n", "\nbce\n\n")) === JSON.stringify({ from: 2, to: 2, lines: ["bcd"] }));
    check("closestExcerpt: <old> longer than the file → null", X.closestExcerpt("abc", "abc\nabc") === null);
    check("matchEditText: no relaxed match → null", X.matchEditText("abc\n", "xyz", "q") === null);
}

section("6. atomic batches and the observation text");
{
    const files = { "a.txt": "a\n", "b.txt": "b\n" };
    const r = run(`<write_file path="new.txt">\nn\n</write_file>\n<read_file path="a.txt"/>\n<edit_file path="b.txt">\n<old>zzz</old><new>y</new>\n</edit_file>\n<write_file path="later.txt">\nl\n</write_file>`, files);
    check("one failed edit → nothing written", r.failed && r.writes.size === 0);
    check("the read before it kept its output", r.results[1].ok && r.results[1].output === "1\ta");
    check("later actions are not run", !r.results[3].ok && /not run/.test(r.results[3].message));
    const text = X.formatFileResults(r.results, r.failed);
    check("observation numbers the actions", text.startsWith("[1] write_file new.txt: created") && text.includes("[2] read_file a.txt: lines 1–1 of 1\n1\ta"), text);
    check("observation names the failed action", text.includes("[3] edit_file b.txt: ERROR:") && /No file changes were applied, because action 3 failed/.test(text));
    const ok = run(`<read_file path="a.txt"/>`, files);
    check("a clean batch has no failure line", !/No file changes/.test(X.formatFileResults(ok.results, ok.failed)));

    const long = "x".repeat(20000);
    const obs = X.buildObservation({ step: 1, status: "ok", output: long, truncate: false });
    check("buildObservation truncate:false keeps a long read whole", obs.includes(long));
    check("…and still truncates by default", !X.buildObservation({ step: 1, status: "ok", output: long }).includes(long));
}

section("7. session schema");
{
    const v = X.validateSession({
        task: "t", messages: [], timeline: [
            { type: "step", n: 1, kind: "files", fileActions: [
                { tool: "edit_file", path: "a.py", ok: true, message: "edited (1 change)", edits: [{ old: "a", new: "b" }, "junk"] },
                { tool: "read_file", path: "b.txt", ok: true, message: "lines 1–2 of 2", startLine: 1, endLine: 2, extra: "<b>x</b>" },
                { tool: "rm_rf", path: "/" }, null,
            ] },
            { type: "step", n: 2, kind: "code" },
        ],
    });
    const fa = v.timeline[0].fileActions;
    check("known actions kept, unknown ones dropped", fa.length === 2 && fa[0].tool === "edit_file" && fa[1].tool === "read_file");
    check("edits kept as string pairs", fa[0].edits.length === 1 && fa[0].edits[0].old === "a" && fa[0].edits[0].new === "b");
    check("line numbers kept, unknown fields dropped", fa[1].startLine === 1 && fa[1].endLine === 2 && !("extra" in fa[1]));
    check("code steps have no fileActions", !("fileActions" in v.timeline[1]));
    const md = X.transcriptMarkdown({ timeline: [{ type: "step", n: 1, kind: "files", fileActions: fa }] });
    check("transcript lists the actions", md.includes("- `edit_file` a.py: edited (1 change)") && md.includes("- `read_file` b.txt"));
    check("system prompt documents the tags", ["<read_file", "<write_file", "<edit_file", "<old>", "<new>"].every(t => X.buildSystemPrompt("").includes(t)));
}

report();
