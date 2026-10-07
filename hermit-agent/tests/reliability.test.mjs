// Phase 2a: line diffs, observation elision, retry classification, the context gauge,
// upload warnings, the package list and package errors, folder walking for uploads.
// Run: node tests/reliability.test.mjs
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { check, section, report } from "./check.mjs";
import X from "./extract.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const apply = (ops, side) => ops.filter(o => o.op !== side).map(o => o.text).join("\n");

section("1. lineDiff — correct and minimal");
{
    const same = X.lineDiff("a\nb\nc", "a\nb\nc");
    check("identical text: only context lines", same.length === 3 && same.every(o => o.op === " "));
    const ins = X.lineDiff("a\nc", "a\nb\nc");
    check("one inserted line", JSON.stringify(ins) === JSON.stringify([{ op: " ", text: "a" }, { op: "+", text: "b" }, { op: " ", text: "c" }]), JSON.stringify(ins));
    const del = X.lineDiff("a\nb\nc", "a\nc");
    check("one deleted line", del.filter(o => o.op === "-").map(o => o.text).join() === "b" && del.filter(o => o.op === "+").length === 0);
    const rep = X.lineDiff("x = 1\ny = 2\n", "x = 1\ny = 3\n");
    check("a changed line is removed and added", rep.filter(o => o.op === "-")[0].text === "y = 2" && rep.filter(o => o.op === "+")[0].text === "y = 3");
    check("empty to text", apply(X.lineDiff("", "a\nb"), "-") === "a\nb" && apply(X.lineDiff("", "a\nb"), "+") === "");
    check("text to empty", apply(X.lineDiff("a\nb", ""), "+") === "a\nb");
    check("a newline both texts end with is no extra line", X.lineDiff("a\nb\n", "a\nc\n").length === 3);
    check("…but a newline only one side has is a difference", X.lineDiff("a\n", "a").some(o => o.op !== " "));

    // Fuzz: the ops always rebuild both sides; on small inputs the number of kept lines
    // equals the longest common subsequence (Myers is minimal).
    let seed = 7;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const lcs = (a, b) => {
        const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
        for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
        return dp[a.length][b.length];
    };
    let rebuilt = true, minimal = true;
    for (let t = 0; t < 300; t++) {
        const a = Array.from({ length: rnd(12) }, () => "abcde"[rnd(5)]);
        const b = Array.from({ length: rnd(12) }, () => "abcde"[rnd(5)]);
        const ops = X.lineDiff(a.join("\n"), b.join("\n"));
        if (apply(ops, "+") !== a.join("\n") || apply(ops, "-") !== b.join("\n")) rebuilt = false;
        if (a.length && b.length && ops.filter(o => o.op === " ").length !== lcs(a, b)) minimal = false;
    }
    check("fuzz: ops rebuild the old and the new text (300 cases)", rebuilt);
    check("fuzz: the diff is minimal (kept lines = LCS)", minimal);
    const big = X.lineDiff("a\n".repeat(50) + "x", "b\n".repeat(50) + "x", 10);
    check("past maxD: still correct, as remove + add", apply(big, "+") === "a\n".repeat(50) + "x" && apply(big, "-") === "b\n".repeat(50) + "x");
}

section("2. diffHunks — context, merging, line numbers");
{
    const old = Array.from({ length: 30 }, (_, i) => "line " + (i + 1)).join("\n");
    const neu = old.replace("line 5\n", "line five\n").replace("line 25\n", "");
    const h = X.diffHunks(X.lineDiff(old, neu), 3);
    check("two far-apart changes make two hunks", h.hunks.length === 2, h.hunks.length);
    check("counts", h.added === 1 && h.removed === 2, [h.added, h.removed]);
    check("first hunk starts 3 lines before the change", h.hunks[0].oldStart === 2 && h.hunks[0].newStart === 2, [h.hunks[0].oldStart, h.hunks[0].newStart]);
    const first = h.hunks[0].lines;
    check("context, -, +, context", first.map(l => l.op).join("") === "   -+   ", first.map(l => l.op).join(""));
    check("line numbers follow each side", first[3].oldNo === 5 && first[3].newNo === 0 && first[4].newNo === 5 && first[4].oldNo === 0);
    const second = h.hunks[1].lines.find(l => l.op === "-");
    check("…and stay right after the first change", second.oldNo === 25, second.oldNo);
    const near = X.diffHunks(X.lineDiff(old, old.replace("line 5\n", "5\n").replace("line 9\n", "9\n")), 3);
    check("changes within 2·context merge into one hunk", near.hunks.length === 1, near.hunks.length);
    check("no changes: no hunks", X.diffHunks(X.lineDiff("a", "a")).hunks.length === 0);
    const atStart = X.diffHunks(X.lineDiff("b\nc", "a\nb\nc"), 3);
    check("an addition at line 1 starts at 1", atStart.hunks[0].oldStart === 1 && atStart.hunks[0].newStart === 1);
}

section("3. elideHistory — old outputs shortened in blocks, the history untouched");
{
    const obs = (n, body, extra) => `<observation step="${n}" status="ok">\n${body}\nfiles changed: +f${n}.txt\nnote: note ${n}\n</observation>` + (extra || "");
    const big = (n) => `HEAD${n}` + "x".repeat(5000) + `TAIL${n}`;
    const build = (steps) => {
        const m = [{ role: "system", content: "sys" }, { role: "user", content: "Task: t" }];
        for (let i = 1; i <= steps; i++) {
            m.push({ role: "assistant", content: i === 1 ? `Writing.\n<write_file path="data.txt">\n${"y".repeat(3000)}\n</write_file>\n<write_file path="s.txt">\nshort\n</write_file>` : "```python\nprint(1)\n```" });
            m.push({ role: "user", content: obs(i, big(i), i === 2 ? "\n\nfollow-up from the user" : "") });
        }
        return m;
    };
    for (const [steps, elided] of [[4, 0], [7, 0], [8, 4], [11, 4], [12, 8]]) {
        const out = X.elideHistory(build(steps), 4, 2000);
        const n = out.filter(m => m.content.includes("elided to save context")).length;
        check(`${steps} steps → the oldest ${elided} observations elided`, n === elided, n);
    }
    const m = build(8);
    const before = JSON.stringify(m);
    const out = X.elideHistory(m, 4, 2000);
    check("the history itself is not changed", JSON.stringify(m) === before);
    const o1 = out[3].content;
    check("an elided observation keeps its envelope, head and tail", o1.startsWith('<observation step="1" status="ok">\nHEAD1') && o1.endsWith("</observation>") && o1.includes("TAIL1"), o1.slice(0, 80));
    check("…its files-changed line and notes (in the tail)", o1.includes("files changed: +f1.txt") && o1.includes("note: note 1"));
    check("…and says which step and how much", /of step 1's output elided/.test(o1) && o1.length < 1600, o1.length);
    check("text after the envelope (a follow-up) stays", out[5].content.endsWith("follow-up from the user"));
    check("a long write_file body in an old step is elided", out[2].content.includes("lines (2.9 KB) elided") && !out[2].content.includes("y".repeat(2500)), out[2].content.slice(0, 200));
    check("…a short one stays", out[2].content.includes("<write_file path=\"s.txt\">\nshort\n</write_file>"));
    check("recent steps are sent in full", out[out.length - 1].content.includes("x".repeat(5000)));
    check("roles and count unchanged", out.length === m.length && out.every((x, i) => x.role === m[i].role));
    const smallObs = X.elideHistory([{ role: "system", content: "s" }, { role: "user", content: "t" }, ...Array.from({ length: 8 }, (_, i) => [{ role: "assistant", content: "a" }, { role: "user", content: obs(i + 1, "short output") }]).flat()], 4, 2000);
    check("short observations are never elided", !smallObs.some(x => x.content.includes("elided")));
}

section("4. Retry: what is worth retrying, and how long to wait");
{
    for (const m of ["Failed to fetch", "NetworkError when attempting to fetch resource.", "Load failed", "network error", "TypeError: Error in input stream",
        "Server Error 500: boom", "Server Error 502: Bad Gateway", "Server Error 503: Loading model", "Server Error 429: slow down", "Server Error 408: timeout",
        "The stream ended before the reply finished: the connection dropped.", "The connection closed before the server replied.",
        "The stream stalled: no data for 180 s in the middle of the reply."]) {
        check(`retry: ${m}`, X.isRetryableError(m));
    }
    for (const m of ["Server Error 400: bad", "Server Error 401: key", "Server Error 404: nope", "Server Error 501: Not Implemented",
        "Server Error 400: the request exceeds the available context size", "Unexpected token < in JSON at position 0", "weird"]) {
        check(`no retry: ${m}`, !X.isRetryableError(m));
    }
    const delays = [1, 2, 3, 4, 5, 6, 7].map(n => X.retryDelayMs(n, 2000, 30000));
    check("waits double from the first and cap", JSON.stringify(delays) === JSON.stringify([2000, 4000, 8000, 16000, 30000, 30000, 30000]), delays);
}

section("5. chatErrorHint — agent wording");
{
    const local = { apiUrl: "http://localhost:8080/v1" };
    const down = X.chatErrorHint("Failed to fetch", { ...local, retriedMs: 120000 });
    check("down after retries: how long, and that the run is paused", /retried for 2 min/.test(down) && /paused and nothing is lost/.test(down) && /server is running/.test(down), down);
    check("…not said without retries", !/paused/.test(X.chatErrorHint("Failed to fetch", local)));
    check("5xx after retries", /retried for 45 s/.test(X.chatErrorHint("Server Error 503: Loading model", { retriedMs: 45000 })));
    check("a dropped stream after retries", /kept dropping/.test(X.chatErrorHint("The stream ended before the reply finished: the connection dropped.", { ...local, retriedMs: 90000 })));
    check("overflow with auto-compaction off: Compact or turn it on", /Compact/.test(X.chatErrorHint("Server Error 400: exceeds the available context size", { autoCompact: false })));
    check("overflow even after compacting: lower max tokens", /even after compacting/.test(X.chatErrorHint("Server Error 400: exceeds the available context size", { autoCompact: true })));
}

section("6. contextGauge");
{
    const u = X.contextGauge(3200, 0, 85, 8192);
    check("unknown size: just the estimate", u.level === "unknown" && u.text === "~3.2k tok", u);
    const g = X.contextGauge(12500, 50000, 85, 8192);
    check("a quarter full: low, text with the share", g.level === "low" && g.text === "~12.5k / 50.0k · 25%" && g.frac === 0.25, g);
    check("compaction point: the reply reserve wins over 85 %", g.compactAt === 50000 - 8192, g.compactAt);
    check("the reserve is capped at half the context", X.contextGauge(1000, 16000, 85, 100000).compactAt === 8000);
    check("past the compaction point: high", X.contextGauge(45000, 50000, 85, 8192).level === "high");
    check("over 60 %: mid", X.contextGauge(31000, 50000, 85, 8192).level === "mid");
    check("auto-compaction off: no marker", X.contextGauge(1000, 50000, 0, 8192).compactAt === 0);
    check("over 100 %: the bar stays full", X.contextGauge(60000, 50000, 85, 0).frac === 1);
}

section("7. uploadWarning");
{
    const MB = 1024 * 1024;
    check("small files: no warning", X.uploadWarning([{ path: "a.csv", size: 5 * MB }], 0) === "");
    const total = X.uploadWarning([{ path: "a.bin", size: 20 * MB }, { path: "b.bin", size: 40 * MB }], 0);
    check("60 MB in total warns with the total", /60\.0 MB in 2 files/.test(total), total);
    const one = X.uploadWarning([{ path: "huge.parquet", size: 30 * MB }], 0);
    check("one 30 MB file warns by name", /huge\.parquet is 30\.0 MB/.test(one), one);
    check("many small files warn", /600 files/.test(X.uploadWarning(Array.from({ length: 600 }, (_, i) => ({ path: i + ".txt", size: 10 })), 0)));
    check("past the workspace limit: says not all will fit", /not all of it will fit/.test(X.uploadWarning([{ path: "x", size: 60 * MB }], 220 * MB)));
}

section("8. Packages: the list, the index, failures");
{
    const lock = { packages: {
        numpy: { name: "numpy", package_type: "package", imports: ["numpy"] },
        "scikit-learn": { name: "scikit-learn", package_type: "package", imports: ["sklearn"] },
        "numpy-tests": { name: "numpy-tests", package_type: "package", imports: ["numpy_tests"] },
        libhdf5: { name: "libhdf5", package_type: "shared_library", imports: [] },
        sqlite3: { name: "sqlite3", package_type: "cpython_module", imports: ["sqlite3"] },
        pytest: { name: "pytest", package_type: "package", imports: ["pytest", "_pytest"] },
        Pillow: { name: "Pillow", package_type: "package", imports: ["PIL"] },
        micropip: { name: "micropip", package_type: "package", imports: ["micropip"] },
    } };
    const names = X.packageImportNames(lock);
    check("import names of real packages, sorted case-insensitively", JSON.stringify(names) === JSON.stringify(["numpy", "PIL", "pytest", "sklearn"]), names);
    const idx = X.importPackageIndex(lock);
    check("the index maps imports to packages, stdlib modules included", idx.get("sklearn") === "scikit-learn" && idx.get("sqlite3") === "sqlite3" && idx.get("PIL") === "Pillow" && !idx.has("libhdf5"));
    check("micropip is neither listed nor loadable for agent code", !names.includes("micropip") && !idx.has("micropip"));
    check("garbage lock files give nothing", X.packageImportNames(null).length === 0 && X.importPackageIndex({ packages: 5 }).size === 0);
    const real = join(here, "..", "libs", "pyodide-0.29.5", "pyodide-lock.json");
    if (existsSync(real)) {
        const r = X.packageImportNames(JSON.parse(readFileSync(real, "utf8")));
        check(`the real lock file lists ${r.length} import names, numpy, pandas and sklearn among them`, r.length > 200 && ["numpy", "pandas", "sklearn", "matplotlib"].every(n => r.includes(n)));
        check("…and the prompt that lists them stays under 4 KB of names", r.join(", ").length < 4000, r.join(", ").length);
        check("…without micropip", !r.includes("micropip"));
    }
    const p = X.buildSystemPrompt("", ["numpy", "pandas"]);
    check("system prompt lists the packages", p.includes("Besides the standard library and your own modules, only these packages can be imported (the Pyodide distribution plus a few bundled libraries): numpy, pandas.\n"));
    for (const pr of ["text", "tools"]) {
        const s = X.buildSystemPrompt("", ["numpy", "pandas"], pr), at = s.indexOf("only these packages can be imported");
        const next = pr === "tools" ? "You act only through tool calls" : "Every reply must be exactly ONE of";
        check(`${pr}: the list is the environment's last line, after its rules`, at > s.indexOf("Don't install anything") && at > s.indexOf("is killed, and the interpreter restarts") && at < s.indexOf(next) && /listed at the end of this section/.test(s));
    }
    check("…and names examples without a list", X.buildSystemPrompt("").includes("(numpy, pandas, matplotlib") && !X.buildSystemPrompt("").includes("only these packages") && !X.buildSystemPrompt("").includes("listed at the end"));
    check("HTTP clients are listed, but said not to connect", /no network access[^.]*\(requests and other HTTP clients import, but can't connect\)/.test(p));

    const CDN = "https://cdn.jsdelivr.net/pyodide/v0.29.5/full/";
    const off = X.packageFailureMessage({ failed: ["numpy"], errors: ["Failed to load 'x': request failed."], netAttempts: [] }, false, CDN);
    check("offline: says so, nothing ran", /browser is offline/.test(off) && /Nothing ran/.test(off) && /numpy/.test(off), off);
    const cdn = X.packageFailureMessage({ failed: ["numpy"], errors: ["Failed to load 'x': request failed."], netAttempts: [] }, true, CDN);
    check("online but the CDN fails: names the host", /cdn\.jsdelivr\.net\) couldn't be reached/.test(cdn), cdn);
    const evil = X.packageFailureMessage({ failed: ["six"], errors: [], netAttempts: ["fetch http://127.0.0.1:9/exfil/poisoned-six.whl"] }, true, CDN);
    check("a download outside the CDN: blocked, with the URL", /outside the pinned package CDN/.test(evil) && /poisoned-six/.test(evil), evil);
    check("another error: its first line", /bad wheel/.test(X.packageFailureMessage({ failed: ["x"], errors: ["The following error occurred while loading x:", "bad wheel"], netAttempts: [] }, true, CDN)));
    const hint = X.moduleNotFoundHint("Traceback…\nModuleNotFoundError: No module named 'requests_oauthlib'", ["numpy"]);
    check("unknown module: no pip here", /requests_oauthlib isn't part of the Pyodide distribution/.test(hint), hint);
    check("a known module (submodule typo): no hint", X.moduleNotFoundHint("ModuleNotFoundError: No module named 'numpy.foo'", ["numpy"]) === "");
    check("no error: no hint", X.moduleNotFoundHint("all good", []) === "");
    const mp = X.moduleNotFoundHint("ModuleNotFoundError: No module named 'micropip'", ["numpy"]);
    check("import micropip: just import the package instead", /no micropip here/.test(mp) && /Just import it/.test(mp), mp);
    check("the prompt points to libraries for common formats, PDFs via pymupdf, in both protocols",
        ["", "tools"].every(pr => /Use a library for common jobs/.test(X.buildSystemPrompt("", ["numpy"], pr || undefined)) && /pymupdf \(import pymupdf\) to create, read and edit PDFs/.test(X.buildSystemPrompt("", ["numpy"], pr || undefined))));

    // Packages imported by the workspace modules a step uses (runpy, import) load too.
    const files = {
        "make_report.py": "import pandas as pd\nfrom helpers.fmt import money\n",
        "helpers/__init__.py": "",
        "helpers/fmt.py": "import numpy\ndef money(x): return x\n",
        "unused.py": "import scipy\n",
        "data.csv": "a,b\n",
        "notes.txt": "mentions unused but not as a file",
    };
    const rd = (p) => (p in files ? files[p] : null);
    const ref = (code) => X.referencedPythonFiles(code, Object.keys(files), rd).sort().join();
    check("runpy of a script: the script and the modules it imports, transitively", ref('import runpy\nrunpy.run_path("make_report.py")') === "helpers/__init__.py,helpers/fmt.py,make_report.py", ref('import runpy\nrunpy.run_path("make_report.py")'));
    check("from-import of a module", ref("from helpers.fmt import money") === "helpers/__init__.py,helpers/fmt.py");
    check("import of a module by name", ref("import make_report") === "helpers/__init__.py,helpers/fmt.py,make_report.py");
    check("a mere word that matches a module name is not a reference", ref("unused = 1\nprint(unused)") === "");
    check("a stdlib import doesn't pull in workspace files", ref("import os, json") === "");
    check("the number of files is capped", X.referencedPythonFiles('exec(open("make_report.py").read())', Object.keys(files), rd, 1).length === 1);
    const pyNote = "ModuleNotFoundError: No module named 'pandas'\nThe module 'pandas' is included in the Pyodide distribution, but it is not installed.\nYou can install it by calling:\n  await micropip.install(\"pandas\") in Python, or\n  await pyodide.loadPackage(\"pandas\") in JavaScript\nSee https://pyodide.org/en/stable/usage/loading-packages.html for more details.";
    const rewritten = X.rewritePyodideInstallAdvice(pyNote);
    check("Pyodide's micropip advice is replaced in the output", !/micropip\.install|loadPackage/.test(rewritten) && /no micropip here\. pandas loads by itself/.test(rewritten) && rewritten.startsWith("ModuleNotFoundError"), rewritten);
    const pil = X.rewritePyodideInstallAdvice(pyNote.replace("No module named 'pandas'", "No module named 'PIL'").replace(/"pandas"/g, '"pillow"'));
    check("…naming the module to import (PIL), not the package (pillow)", /has "import PIL"/.test(pil), pil);
    const mpNote = pyNote.replace(/pandas/g, "micropip");
    check("…and for micropip it says micropip isn't available", /micropip isn't available to agent code/.test(X.rewritePyodideInstallAdvice(mpNote)) && /no micropip here/.test(X.moduleNotFoundHint(mpNote, [])));
    const notLoaded = X.moduleNotFoundHint(pyNote, ["pandas"]);
    check("a package that exists but wasn't loaded: import it in the step's own code", /pandas is available but wasn't loaded/.test(notLoaded) && /Add "import pandas"/.test(notLoaded), notLoaded);
    check("the prompt says not to install anything", /Don't install anything: there is no pip or micropip/.test(X.buildSystemPrompt("", ["numpy"])) && /no pip or micropip/.test(X.buildSystemPrompt("", ["numpy"], "tools")));
}

section("9. readEntry — dropped folders, read in batches");
{
    const file = (name, text) => ({ isFile: true, file: (res) => res(new File([text], name)) });
    const dir = (name, children, batch = 2) => ({
        isDirectory: true, name,
        createReader() { let i = 0; return { readEntries: (res) => { res(children.slice(i, i + batch)); i += batch; } }; },
    });
    const tree = dir("proj", [file("a.txt", "A"), dir("src", [file("m.py", "M"), file("n.py", "N"), file("o.py", "O")]), file("b.txt", "B")]);
    const out = [];
    await X.readEntry(tree, "", out);
    check("every file, with its folder path, across batches", JSON.stringify(out.map(o => o.path)) === JSON.stringify(["proj/a.txt", "proj/src/m.py", "proj/src/n.py", "proj/src/o.py", "proj/b.txt"]), out.map(o => o.path));
    check("files are not read yet (sizes come first)", out.every(o => o.file instanceof File && !("bytes" in o)) && out[1].file.size === 1);
}

section("10. Export: the retry note survives");
{
    const s = X.validateSession({ task: "t", messages: [], timeline: [{ type: "step", n: 1, kind: "code", retryNote: "🔌 The endpoint answered again after 2 retries (about 6 s without a reply)." }] });
    check("validateSession keeps retryNote", s.timeline[0].retryNote.includes("answered again"));
    check("the transcript shows it", X.transcriptMarkdown(s).includes("> 🔌 The endpoint answered again"));
}

report();
