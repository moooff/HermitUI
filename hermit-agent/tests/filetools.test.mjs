// Phase 3.6 file tools and ask options: search_files, delete_file, move_file (both
// protocols, the executor, gating), the syntax-check plumbing around the worker, and
// ask_user's choices.
// Run: node tests/filetools.test.mjs
import { check, section, report } from "./check.mjs";
import X from "./extract.mjs";

const enc = new TextEncoder();
const wsOf = (files) => ({
    paths: Object.keys(files),
    read: (p) => (p in files ? (files[p] instanceof Uint8Array ? files[p] : enc.encode(files[p])) : null),
});
const run = (text, files, opts) => X.applyFileActions(X.extractFileActions(text).actions, wsOf(files || {}), opts);
const runCalls = (calls, files, opts) => X.applyFileActions(calls.map(([n, a]) => X.toolCallToFileAction(n, a)), wsOf(files || {}), opts);

const PROJECT = {
    "app.py": "import util\n\ndef main():\n    print(util.load('data.csv'))\n",
    "util.py": "def load(path):\n    return open(path).read()  # TODO: csv\n",
    "src/a.js": "// TODO later\nconst x = 1 -> 2;\n",
    "src/deep/b.md": "# Notes\nnothing to do\n",
    "README.md": "Run app.py. todo: docs\n",
    "logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
};

section("1. Tags: search_files, delete_file, move_file");
{
    let r = X.extractFileActions(`<search_files pattern="def load" path="src" glob="*.py"/>`);
    check("search with every attribute", r.actions.length === 1 && r.actions[0].args.pattern === "def load" && r.actions[0].args.path === "src" && r.actions[0].args.glob === "*.py" && !r.actions[0].error, JSON.stringify(r.actions));
    r = X.extractFileActions(`<search_files pattern="->" ignore_case="true"/>`);
    check("a quoted '>' stays in the pattern", r.actions[0].args.pattern === "->" && r.actions[0].args.ignore_case === true && r.rest.trim() === "", JSON.stringify(r));
    r = X.extractFileActions(`<search_files pattern='say "hi"'/>`);
    check("single quotes hold double quotes", r.actions[0].args.pattern === 'say "hi"');
    r = X.extractFileActions(`<search_files/>\n<search_files path="/workspace"/>\n<search_files path="."/>`);
    check("no path, /workspace and . all mean the whole workspace", r.actions.every(a => a.args.path === "" && !a.error && a.args.pattern === undefined), JSON.stringify(r.actions));
    r = X.extractFileActions(`<search_files path="../etc"/>`);
    check("unsafe search path → error", /Unsafe path/.test(r.actions[0].error || ""));
    r = X.extractFileActions(`<delete_file path="tmp/"/>\n<move_file path="a.txt" new_path="docs/a.txt"></move_file>\n<move_file path="b" to="c"/>`);
    check("delete: a trailing slash is a folder name", r.actions[0].tool === "delete_file" && r.actions[0].args.path === "tmp" && !r.actions[0].error);
    check("move with a closing tag", r.actions[1].args.path === "a.txt" && r.actions[1].args.new_path === "docs/a.txt" && !r.actions[1].error && r.rest.trim() === "", JSON.stringify(r));
    check("move: to= is accepted for new_path", r.actions[2].args.new_path === "c");
    r = X.extractFileActions(`<move_file path="a.txt"/>\n<move_file path="a.txt" new_path="../x"/>\n<delete_file/>`);
    check("move without new_path → error", /needs a new_path/.test(r.actions[0].error || ""));
    check("move to an unsafe path → error", /Unsafe new_path/.test(r.actions[1].error || ""));
    check("delete without path → error", /needs a path/.test(r.actions[2].error || ""));
    const p = X.parseReply(`Let me look.\n<search_files pattern="TODO"/>`, "stop");
    check("parseReply: a search is a files step", p.kind === "files" && p.actions[0].tool === "search_files");
    const mixed = X.parseReply(`<delete_file path="a"/>\n\`\`\`python\nprint(1)\n\`\`\``, "stop");
    check("…and can't be mixed with code", mixed.kind === "mixed");
}

section("2. Globs and patterns");
{
    const g = (glob, path) => X.globToRegExp(glob).test(path);
    check("*.py matches in every folder", g("*.py", "app.py") && g("*.py", "src/x/app.py") && !g("*.py", "app.pyc"));
    check("a glob with / matches whole paths", g("src/*.js", "src/a.js") && !g("src/*.js", "src/deep/a.js") && !g("src/*.js", "lib/src/a.js"));
    check("** spans folders, also none", g("src/**/*.md", "src/deep/b.md") && g("src/**/*.md", "src/b.md") && g("**/*.md", "README.md"));
    check("? is one character, braces are alternatives, brackets classes", g("?.py", "a.py") && !g("?.py", "ab.py") && g("*.{js,md}", "x.md") && g("*.{js,md}", "x.js") && !g("*.{js,md}", "x.py") && g("[ab].py", "b.py") && !g("[ab].py", "c.py"));
    check("dots and parentheses are literal", g("a.(1).txt", "a.(1).txt") && !g("a.txt", "abtxt"));
    check("empty and unbalanced globs → null", X.globToRegExp("") === null && X.globToRegExp("*.{js") === null);
    let s = X.searchRegExp("TODO|FIXME", false);
    check("a regex is a regex", !s.literal && s.re.test("x FIXME") && !s.re.test("todo"));
    s = X.searchRegExp("(?i)todo", false);
    check("a leading (?i) ignores case", s.re.test("TODO") && s.re.flags.includes("i"));
    s = X.searchRegExp("print(", false);
    check("an invalid regex is searched as plain text", s.literal && s.re.test("x = print(1)") && !s.re.test("printer"));
    for (const bad of ["(a+)+$", "(\\w+\\s?)*", "(?:x*)+y", "((ab)+c)*", "(a{2,})+", "([a-z]+)*end"]) {
        check(`refused, can backtrack without end: ${bad}`, !!X.searchRegExp(bad, false).error && X.hasNestedQuantifier(bad));
    }
    for (const ok of ["(ab)+", "(a|b)*c", "\\(x+\\)+", "[(a+)]+", "(def|class) \\w+", "a+b*", "(x{1})+", "(\\d)+", "(?:a?)+"]) {
        check(`allowed: ${ok}`, !X.hasNestedQuantifier(ok));
    }
}

section("3. search_files — listing, matching, limits");
{
    let r = run(`<search_files/>`, PROJECT);
    check("no pattern lists every file, sorted, with sizes", r.results[0].ok && r.results[0].message === "6 files" && r.results[0].output.split("\n")[0] === "README.md (23 B)" && r.results[0].output.includes("logo.png (12 B)"), r.results[0].output);
    r = run(`<search_files path="src"/>`, PROJECT);
    check("a folder narrows the listing", r.results[0].message === "2 files" && r.results[0].output.includes("src/deep/b.md"));
    r = run(`<search_files glob="*.py"/>`, PROJECT);
    check("a glob narrows the listing", r.results[0].output === "app.py (58 B)\nutil.py (58 B)", r.results[0].output);
    r = run(`<search_files pattern="TODO"/>`, PROJECT);
    check("matches as path:line: text", r.results[0].output.split("\n").slice(0, 2).join("\n") === "src/a.js:1: // TODO later\nutil.py:2:     return open(path).read()  # TODO: csv", r.results[0].output);
    check("…counted in the message", r.results[0].message === "2 matches in 2 files", r.results[0].message);
    check("…and the binary file is named as skipped", r.results[0].output.includes("(1 binary file not searched"), r.results[0].output);
    r = run(`<search_files pattern="todo" ignore_case="true" glob="*.md"/>`, PROJECT);
    check("ignore_case and a glob", r.results[0].message === "1 match in 1 file" && r.results[0].output.startsWith("README.md:1: Run app.py. todo: docs"), r.results[0].output);
    r = run(`<search_files pattern="nothing here at all"/>`, PROJECT);
    check("no match is ok, not an error", r.results[0].ok && /^no matches in 5 files$/.test(r.results[0].message), r.results[0].message);
    r = run(`<search_files pattern="x" path="nope"/>`, PROJECT);
    check("a missing path is an error that doesn't fail the batch", !r.results[0].ok && /no file or folder nope/.test(r.results[0].message) && !r.failed);
    r = run(`<search_files pattern="x" glob="*.{a"/>`, PROJECT);
    check("an invalid glob is an error", !r.results[0].ok && /glob/.test(r.results[0].message));
    r = run(`<search_files pattern="load(" path="app.py"/>`, PROJECT);
    check("a single file as path; invalid regex as plain text, said so", r.results[0].ok && r.results[0].output.startsWith("app.py:4:") && r.results[0].output.includes("searched as plain text"), r.results[0].output);

    const many = {};
    for (let i = 0; i < 30; i++) many[`f${String(i).padStart(2, "0")}.txt`] = "hit\n".repeat(5);
    r = run(`<search_files pattern="hit"/>`, many, { searchMaxMatches: 100 });
    check("at most searchMaxMatches lines, the rest counted", r.results[0].output.split("\n").filter(l => /:\d+: hit$/.test(l)).length === 100 && r.results[0].output.includes("[… 50 more matches") && r.results[0].message === "150 matches in 30 files", r.results[0].message);
    r = run(`<search_files/>`, many, { searchMaxFiles: 10 });
    check("the listing is capped too", r.results[0].output.split("\n").length === 11 && r.results[0].output.endsWith("[… 20 more files; narrow it down with path or glob …]"));
    const long = { "min.js": "a".repeat(5000) + "NEEDLE" + "b".repeat(5000) + "\n" };
    r = run(`<search_files pattern="NEEDLE"/>`, long);
    const line = r.results[0].output.split("\n")[0];
    check("a long line is cut around the match", line.includes("NEEDLE") && line.length < 400 && line.startsWith("min.js:1: …"), line.slice(0, 80));
    // A line longer than searchMaxScanChars is searched only up to the cap: one re.exec
    // over a very long line can't be interrupted by the deadline, so it must be bounded.
    const capped = { "one-line.json": "x".repeat(50) + "EARLY" + "y".repeat(500) + "LATE" + "z".repeat(50) + "\n" };
    r = run(`<search_files pattern="EARLY"/>`, capped, { searchMaxScanChars: 100 });
    check("a match within the scan cap is found, the cap noted", r.results[0].ok && r.results[0].output.includes("one-line.json:1:") && /1 line longer than 100 characters searched only up to there/.test(r.results[0].output), r.results[0].output);
    r = run(`<search_files pattern="LATE"/>`, capped, { searchMaxScanChars: 100 });
    check("a match past the scan cap is not found", r.results[0].message.startsWith("no matches") && /longer than 100 characters/.test(r.results[0].output), r.results[0].output);
    // The cap also bounds a backtracking pattern on one long line: this must return fast.
    const nasty = { "data.json": "[" + '{"k":"v"},'.repeat(4000) + "]\n" };   // ~40 KB, one line
    const t0 = Date.now();
    r = run(`<search_files pattern="\\"k\\":.*ADMIN"/>`, nasty, { searchMaxScanChars: 2000 });
    check("a backtracking pattern on a long line returns promptly", r.results[0].ok && Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
    r = run(`<search_files pattern="(\\w+\\s?)+$"/>\n<read_file path="app.py"/>`, PROJECT);
    check("a runaway pattern is an error that doesn't fail the batch", !r.results[0].ok && /repeats a group/.test(r.results[0].message) && r.results[1].ok && !r.failed);
    r = run(`<search_files pattern="x"/>`, { "a.txt": "x\n", "b.txt": "x\n" }, { searchMaxMs: -1 });
    check("the time budget stops a search, and says so", r.results[0].ok && /stopped after/.test(r.results[0].output) && /0 of 2 files searched/.test(r.results[0].output), r.results[0].output);
    r = run(`<search_files pattern="x"/>`, { "big.txt": "x\n" }, { searchMaxFileBytes: 1 });
    check("files over the size cap are named as skipped", r.results[0].output.includes("(1 file over 1 B not searched: use python)"), r.results[0].output);
    r = run(`<search_files pattern="."/>\n<read_file path="app.py"/>`, PROJECT, { readMaxTotalChars: 100, readMaxChars: 100 });
    check("searches share the reply's read budget", /more matches/.test(r.results[0].output) && r.results[1].output.split("\n").length < 4, JSON.stringify(r.results.map(x => x.output)));
    r = run(`<write_file path="new.py">\n# TODO new\n</write_file>\n<search_files pattern="TODO" glob="*.py"/>`, PROJECT);
    check("a search sees the reply's earlier write", r.results[1].output.includes("new.py:1: # TODO new") && r.writes.has("new.py"));
    check("…and changes nothing itself", r.writes.size === 1 && r.deletes.length === 0);
}

section("4. delete_file and move_file");
{
    let r = run(`<delete_file path="README.md"/>`, PROJECT);
    check("delete a file", r.results[0].ok && r.results[0].message === "deleted (23 B)" && JSON.stringify(r.deletes) === '["README.md"]' && r.writes.size === 0);
    r = run(`<delete_file path="src"/>`, PROJECT);
    check("delete a folder with everything in it", r.results[0].message === "deleted the folder (2 files)" && JSON.stringify(r.deletes) === '["src/a.js","src/deep/b.md"]', JSON.stringify(r));
    r = run(`<delete_file path="nope.txt"/>\n<write_file path="w.txt">\nw\n</write_file>`, PROJECT);
    check("deleting what isn't there fails the batch", r.failed && !r.results[0].ok && /no file or folder/.test(r.results[0].message) && r.writes.size === 0 && r.deletes.length === 0);
    r = run(`<delete_file path="util.py"/>\n<read_file path="util.py"/>\n<search_files glob="*.py"/>`, PROJECT);
    check("later reads and searches don't see a deleted file", !r.results[1].ok && r.results[2].output === "app.py (58 B)", JSON.stringify(r.results.map(x => x.output || x.message)));
    r = run(`<delete_file path="a.txt"/>\n<write_file path="a.txt">\nnew\n</write_file>`, { "a.txt": "old\n" });
    check("delete then write is a replaced file, not a delete", r.deletes.length === 0 && r.writes.get("a.txt") === "new\n");
    r = run(`<write_file path="tmp.txt">\nx\n</write_file>\n<delete_file path="tmp.txt"/>`, {});
    check("a file written and deleted in one reply leaves nothing", r.writes.size === 0 && r.deletes.length === 0 && !r.failed);

    r = run(`<move_file path="logo.png" new_path="img/logo.png"/>`, PROJECT);
    const moved = r.writes.get("img/logo.png");
    check("move a binary file: the same bytes", moved instanceof Uint8Array && moved.length === 12 && moved[1] === 0x50 && JSON.stringify(r.deletes) === '["logo.png"]', JSON.stringify(r.results));
    check("…recorded as a move", JSON.stringify(r.moves) === '[["logo.png","img/logo.png"]]' && r.results[0].message === "moved to img/logo.png" && r.results[0].newPath === "img/logo.png");
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x0a]);
    r = run(`<move_file path="b.txt" new_path="c.txt"/>`, { "b.txt": bom });
    check("a moved text file keeps its exact bytes (BOM included)", r.writes.get("c.txt").length === 5 && r.writes.get("c.txt")[0] === 0xef);
    r = run(`<move_file path="src" new_path="lib/js"/>`, PROJECT);
    check("move a folder", r.results[0].message === "moved the folder to lib/js (2 files)" && r.writes.has("lib/js/a.js") && r.writes.has("lib/js/deep/b.md") && r.deletes.length === 2 && r.moves.length === 2, JSON.stringify(r.results));
    r = run(`<move_file path="app.py" new_path="util.py"/>`, PROJECT);
    check("moving onto an existing file fails, and says to delete first", r.failed && /already exists. Delete it first/.test(r.results[0].message));
    r = run(`<delete_file path="util.py"/>\n<move_file path="app.py" new_path="util.py"/>`, PROJECT);
    check("…which works in the same reply: the target is replaced", !r.failed && r.writes.get("util.py").length === 58 && JSON.stringify(r.deletes) === '["app.py"]', JSON.stringify(r));
    r = run(`<move_file path="app.py" new_path="src"/>`, PROJECT);
    check("moving onto a folder fails with the full-path advice", r.failed && /src is a folder that already exists/.test(r.results[0].message) && /src\/app\.py/.test(r.results[0].message));
    r = run(`<move_file path="src" new_path="src/inner"/>`, PROJECT);
    check("a folder can't move into itself", r.failed && /into itself/.test(r.results[0].message));
    r = run(`<move_file path="app.py" new_path="README.md/app.py"/>`, PROJECT);
    check("a file can't go under a file", r.failed && /README.md is a file/.test(r.results[0].message));
    r = run(`<move_file path="ghost" new_path="x"/>`, PROJECT);
    check("moving what isn't there fails", r.failed && /no file or folder ghost/.test(r.results[0].message));
    r = run(`<move_file path="app.py" new_path="main.py"/>\n<edit_file path="main.py">\n<old>def main():</old>\n<new>def run():</new>\n</edit_file>`, PROJECT);
    check("move then edit the new path", !r.failed && r.writes.get("main.py").includes("def run():") && JSON.stringify(r.moves) === '[["app.py","main.py"]]');
    r = run(`<move_file path="a.txt" new_path="b.txt"/>\n<write_file path="a.txt">\nagain\n</write_file>`, { "a.txt": "a\n" });
    check("a source written again isn't a move any more", r.moves.length === 0 && r.deletes.length === 0 && r.writes.has("b.txt"));
    r = run(`<read_file path="src"/>`, PROJECT);
    check("reading a folder points to search_files", /folder. List it with search_files/.test(r.results[0].message));

    const fr = X.formatFileResults(run(`<move_file path="app.py" new_path="main.py"/>\n<search_files pattern="TODO" glob="*.py"/>`, PROJECT).results, false);
    check("observation names a move's target and a search's pattern", fr.includes("[1] move_file app.py → main.py: moved to main.py") && fr.includes('[2] search_files "TODO" · glob *.py in .: 1 match in 1 file'), fr);
}

section("5. Native calls → the same actions");
{
    let a = X.toolCallToFileAction("search_files", {});
    check("search with no arguments: all of /workspace, no pattern", !a.error && a.args.path === "" && a.args.pattern === undefined && a.args.ignore_case === false);
    a = X.toolCallToFileAction("search_files", { pattern: "x", path: "/workspace/src", glob: "*.py", ignore_case: true });
    check("search arguments carried over", a.args.path === "src" && a.args.pattern === "x" && a.args.glob === "*.py" && a.args.ignore_case === true);
    check("a non-string pattern is an error", /pattern must be a string/.test(X.toolCallToFileAction("search_files", { pattern: 3 }).error || ""));
    check("an unsafe search path is an error", /Unsafe path/.test(X.toolCallToFileAction("search_files", { path: "../x" }).error || ""));
    a = X.toolCallToFileAction("move_file", { path: "a", new_path: "b/" });
    check("move arguments, a trailing slash dropped", !a.error && a.args.path === "a" && a.args.new_path === "b");
    check("move without new_path names the field", /move_file needs new_path/.test(X.toolCallToFileAction("move_file", { path: "a" }).error || ""));
    check("delete without path", /delete_file needs a path/.test(X.toolCallToFileAction("delete_file", {}).error || ""));

    const p = X.parseToolCalls([{ id: "s1", name: "search_files", arguments: '{"pattern":"TODO"}' }, { id: "d1", name: "delete_file", arguments: '{"path":"README.md"}' }], "", "tool_calls", 1);
    check("search and delete calls batch like other file tools", p.kind === "files" && p.actions.length === 2 && p.actions[0].id === "s1" && p.actions[1].tool === "delete_file");
    const r = runCalls([["search_files", { pattern: "TODO" }], ["delete_file", { path: "README.md" }]], PROJECT);
    const texts = X.fileCallResults(r.results, r.failed);
    check("each call gets its own result", texts[0].startsWith('search_files "TODO" in .: 2 matches in 2 files') && texts[1] === "delete_file README.md: deleted (23 B)", JSON.stringify(texts));
    const bad = runCalls([["search_files", { pattern: "TODO" }], ["move_file", { path: "nope", new_path: "x" }], ["delete_file", { path: "README.md" }]], PROJECT);
    const bt = X.fileCallResults(bad.results, bad.failed);
    check("a failed move stops the batch; the search before it still reports", bad.failed && bt[0].startsWith("search_files") && /ERROR/.test(bt[1]) && /not run/.test(bt[2]), JSON.stringify(bt));
    const grep = X.parseToolCalls([{ id: "g", name: "grep", arguments: '{"pattern":"x"}' }], "", "tool_calls", 1);
    check("a guessed grep tool is pointed to search_files", grep.kind === "badcall" && /use search_files/.test(grep.skipped[0][1]));

    const asText = (name, args) => X.toolCallAsText({ function: { name, arguments: JSON.stringify(args) } });
    for (const [name, args] of [["search_files", { pattern: 'say "hi"', path: "src", glob: "*.py", ignore_case: true }], ["search_files", {}], ["delete_file", { path: "tmp" }], ["move_file", { path: "a.txt", new_path: "b/a.txt" }]]) {
        const back = X.extractFileActions(asText(name, args)).actions[0];
        const want = X.toolCallToFileAction(name, args);
        check(`${name} written as text parses back to the same action`, JSON.stringify(back) === JSON.stringify(want), asText(name, args) + " → " + JSON.stringify(back));
    }
}

section("6. Gating: deletes and moves of your files");
{
    const origins = { "data.csv": "user", "tmp.txt": "agent" };
    let v = X.classifyEffect({ added: [], modified: [], deleted: ["tmp.txt"] }, origins);
    check("deleting the agent's own file runs", v.verdict === "auto");
    v = X.classifyEffect({ added: [], modified: [], deleted: ["data.csv"] }, origins);
    check("deleting your file asks", v.verdict === "ask" && v.reasons[0] === "deletes your file data.csv");
    v = X.classifyEffect({ added: ["in/data.csv"], modified: [], deleted: ["data.csv"] }, origins, { moves: [["data.csv", "in/data.csv"]] });
    check("moving your file asks, and says it's a move", v.verdict === "ask" && v.reasons[0] === "moves your file data.csv to in/data.csv", v.reasons);
}

section("7. Syntax check results (validated like every worker message)");
{
    const ok = X.validateSyntaxResult({ results: { "a.py": null, "b.py": { line: 3, col: 9, error: "SyntaxError: expected ':'", text: "def f()" }, "evil.py": { line: 1, error: "x" } } }, ["a.py", "b.py"]);
    check("null = compiles; an error keeps line, column, message, text", ok["a.py"] === null && ok["b.py"].line === 3 && ok["b.py"].col === 9 && ok["b.py"].text === "def f()");
    check("paths not asked about are dropped", !("evil.py" in ok));
    const junk = X.validateSyntaxResult({ results: { "a.py": { line: -1, col: "x", error: "E".repeat(1000), text: 5 }, "b.py": { line: 1 }, "c.py": "str" } }, ["a.py", "b.py", "c.py", "d.py"]);
    check("bad numbers become 0, long messages are clipped", junk["a.py"].line === 0 && junk["a.py"].col === 0 && junk["a.py"].error.length === 300 && junk["a.py"].text === "");
    check("entries without an error message, and missing ones, are dropped", !("b.py" in junk) && !("c.py" in junk) && !("d.py" in junk));
    check("garbage → nothing", JSON.stringify(X.validateSyntaxResult(null, ["a.py"])) === "{}" && JSON.stringify(X.validateSyntaxResult({ results: "x" }, ["a.py"])) === "{}");
    check("__proto__ can't sneak in", Object.keys(X.validateSyntaxResult(JSON.parse('{"results":{"__proto__":{"error":"x"}}}'), ["__proto__"])).length <= 1);
    const note = X.syntaxErrorNote("app.py", { line: 3, col: 9, error: "SyntaxError: expected ':'", text: "  def f()" });
    check("the note names file, place, error and line, and that it was saved", note === "app.py doesn't compile at line 3, column 9: SyntaxError: expected ':' (def f()). The file was saved as written; fix it before you run it.", note);
    check("…without a place when there is none", X.syntaxErrorNote("x.py", { line: 0, col: 0, error: "ValueError: source code string cannot contain null bytes", text: "" }).startsWith("x.py doesn't compile: ValueError"));
}

section("8. ask_user options");
{
    check("cleanAskOptions: trimmed, deduplicated, at most askMaxOptions", JSON.stringify(X.cleanAskOptions([" CSV ", "Excel", "CSV", "", 3, null, "a", "b", "c", "d", "e"])) === '["CSV","Excel","3","a","b","c"]');
    check("…fewer than two is none", X.cleanAskOptions(["only"]).length === 0 && X.cleanAskOptions("CSV, Excel").length === 0);
    check("…long options are clipped", X.cleanAskOptions(["x".repeat(500), "y"])[0].length === 200);
    let a = X.splitAskOptions("Which format?\n- CSV\n- Excel (.xlsx)");
    check("text: trailing '- ' lines are the options", a.question === "Which format?" && JSON.stringify(a.options) === '["CSV","Excel (.xlsx)"]', JSON.stringify(a));
    a = X.splitAskOptions("Pick one:\n\n1. fast\n2) thorough\n* both");
    check("…numbered and starred too, a blank line between", a.question === "Pick one:" && a.options.length === 3);
    a = X.splitAskOptions("Which of these?\n- a\n- b\n- c\n- d\n- e\n- f\n- g");
    check("…more than the maximum: no options, the text stays whole", a.options.length === 0 && a.question.endsWith("- g"));
    a = X.splitAskOptions("- just a list item");
    check("…a question that is only a list item stays a question", a.options.length === 0 && a.question === "- just a list item");
    a = X.splitAskOptions("Which delimiter does the file use?");
    check("…a plain question has none", a.options.length === 0 && a.question === "Which delimiter does the file use?");
    let p = X.parseReply("I need to know.\nask: Which format?\n- CSV\n- Excel", "stop");
    check("parseReply: ask with options", p.kind === "ask" && p.question === "Which format?" && p.options.length === 2 && p.prose === "I need to know.");
    p = X.parseToolCalls([{ id: "q", name: "ask_user", arguments: JSON.stringify({ question: "Which format?", options: ["CSV", "Excel"] }) }], "", "tool_calls", 1);
    check("parseToolCalls: ask_user options", p.kind === "ask" && JSON.stringify(p.options) === '["CSV","Excel"]');
    p = X.parseToolCalls([{ id: "q", name: "ask_user", arguments: JSON.stringify({ question: "Sure?", options: "yes/no" }) }], "", "tool_calls", 1);
    check("…a malformed options field is ignored, the question still asked", p.kind === "ask" && p.options.length === 0);
    const t = X.toolCallAsText({ function: { name: "ask_user", arguments: JSON.stringify({ question: "Which?", options: ["A", "B"] }) } });
    check("ask_user as text round-trips through parseReply", t === "ask: Which?\n- A\n- B" && JSON.stringify(X.parseReply(t, "stop").options) === '["A","B"]');
    const v = X.validateSession({ task: "t", messages: [], timeline: [{ type: "step", n: 1, kind: "ask", question: "Q?", options: ["A", "<b>B</b>", 7, "A"] }, { type: "step", n: 2, kind: "files", fileActions: [{ tool: "move_file", path: "a", newPath: "b", ok: true, message: "moved to b" }, { tool: "search_files", path: ".", query: '"x"', ok: true, message: "no matches" }] }] });
    check("session import keeps options (as text) and the new file actions", JSON.stringify(v.timeline[0].options) === '["A","<b>B</b>","7"]' && v.timeline[1].fileActions[0].newPath === "b" && v.timeline[1].fileActions[1].query === '"x"', JSON.stringify(v.timeline));
    const md = X.transcriptMarkdown({ timeline: v.timeline });
    check("the transcript lists options, moves and searches", md.includes("**Question:** Q?\n\n- A\n- <b>B</b>") && md.includes("- `move_file` a → b: moved to b") && md.includes('- `search_files` "x" in .: no matches'), md);
}

section("9. System prompts");
{
    const text = X.buildSystemPrompt("", [], "text"), tools = X.buildSystemPrompt("", [], "tools");
    check("code-as-action documents the new tags", ["<search_files", "<delete_file", "<move_file", "new_path=", "glob="].every(s => text.includes(s)));
    check("…and options after ask:", /ask:[\s\S]*starting with "- "/.test(text));
    check("both say a .py file is syntax-checked", [text, tools].every(s => s.includes("checked for syntax errors")));
    check("native names the new tools", ["search_files", "delete_file", "move_file"].every(s => tools.includes(s)) && !tools.includes("<search_files"));
}

report();
