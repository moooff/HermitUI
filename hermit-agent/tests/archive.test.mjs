// Zip writer/reader and the session archive (DESIGN §3): round-trips, the untrusted-input
// rules on import, and the version policy. Run: node tests/archive.test.mjs
import { check, section, report } from "./check.mjs";
import X from "./extract.mjs";

const enc = new TextEncoder(), dec = new TextDecoder();
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
async function rejects(name, promise, fragment) {
    try { await promise; check(name, false, "did not throw"); }
    catch (e) { check(name, !fragment || String(e.message).includes(fragment), e.message); }
}

// A hand-built single-entry zip (stored), for archives the writer would never produce.
function rawZip(name, data, { crc } = {}) {
    const n = enc.encode(name);
    const c = crc ?? X.crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint32(14, c, true);
    lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, n.length, true);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint32(16, c, true);
    ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, n.length, true);
    const cdOff = 30 + n.length + data.length;
    const eo = new DataView(new ArrayBuffer(22));
    eo.setUint32(0, 0x06054b50, true); eo.setUint16(8, 1, true); eo.setUint16(10, 1, true);
    eo.setUint32(12, 46 + n.length, true); eo.setUint32(16, cdOff, true);
    const parts = [new Uint8Array(lh.buffer), n, data, new Uint8Array(ch.buffer), n, new Uint8Array(eo.buffer)];
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}

section("1. crc32");
check("known vector", X.crc32(enc.encode("123456789")) === 0xCBF43926);

section("2. zip round-trip");
{
    const binary = new Uint8Array(4096).map((_, i) => (i * 131) & 255);
    const entries = [
        { path: "hello.txt", data: enc.encode("hello world\n".repeat(200)) },
        { path: "bin/data.bin", data: binary },
        { path: "ünïcödé/日本語.md", data: enc.encode("# hi") },
        { path: "empty.txt", data: new Uint8Array(0) },
    ];
    const zip = await X.zipWrite(entries, new Date(2026, 9, 3, 14, 30, 10));
    check("compressible text is deflated", zip.length < 2400 + 4096 + 400, zip.length);
    const back = await X.zipRead(zip);
    check("same entry count", back.length === entries.length);
    for (const e of entries) {
        const b = back.find(x => x.path === e.path);
        check(`round-trips ${e.path}`, b && eq(b.data, e.data));
    }
}

section("3. zipRead treats archives as untrusted (DESIGN §3.3)");
{
    await rejects("traversal path", X.zipRead(rawZip("../evil.txt", enc.encode("x"))), "Unsafe path");
    await rejects("absolute path", X.zipRead(rawZip("/etc/passwd", enc.encode("x"))), "Unsafe path");
    await rejects("backslash path", X.zipRead(rawZip("a\\..\\b", enc.encode("x"))), "Unsafe path");
    await rejects("CRC mismatch", X.zipRead(rawZip("a.txt", enc.encode("x"), { crc: 1234 })), "CRC mismatch");
    await rejects("not a zip", X.zipRead(enc.encode("definitely not a zip file, just text that is long enough")), "Not a zip");
    const zip = await X.zipWrite([{ path: "a", data: new Uint8Array(5000) }, { path: "b", data: new Uint8Array(5000) }]);
    await rejects("total size limit (zip bomb guard)", X.zipRead(zip, { maxBytes: 8000 }), "unpacks to more than");
    await rejects("entry count limit", X.zipRead(zip, { maxEntries: 1 }), "entries");
    // A deflated entry that inflates beyond its declared size must not be trusted.
    const big = await X.zipWrite([{ path: "z", data: new Uint8Array(100000) }]);
    const dv = new DataView(big.buffer);
    const eocd = big.length - 22, cd = dv.getUint32(eocd + 16, true);
    dv.setUint32(cd + 24, 10, true);   // central directory now claims 10 bytes
    await rejects("lying uncompressed size", X.zipRead(big), "declared size");
    const dirs = await X.zipRead(rawZip("folder/", new Uint8Array(0)));
    check("directory entries are skipped", dirs.length === 0);
}

section("4. Session archive round-trip (DESIGN §3.1)");
{
    const files = {
        "data.csv": { bytes: enc.encode("a,b\n1,2\n"), origin: "user" },
        "out/report.md": { bytes: enc.encode("# Report ```"), origin: "agent" },
        "bin.dat": { bytes: new Uint8Array([0, 255, 1, 254]), origin: "agent" },
    };
    const blobs = new Map(), fileMap = new Map();
    for (const [p, f] of Object.entries(files)) {
        const h = await X.sha256Hex(f.bytes);
        blobs.set(h, f.bytes);
        fileMap.set(p, { hash: h, origin: f.origin });
    }
    const oldBytes = enc.encode("old version of the report");
    const oldHash = await X.sha256Hex(oldBytes);
    blobs.set(oldHash, oldBytes);
    const checkpoints = [
        { timelineLength: 1, msgCount: 2, stepCount: 0, label: "start", files: { "data.csv": { hash: fileMap.get("data.csv").hash, origin: "user" } } },
        { timelineLength: 2, msgCount: 4, stepCount: 1, label: "step 1", files: { "data.csv": { hash: fileMap.get("data.csv").hash, origin: "user" }, "out/report.md": { hash: oldHash, origin: "agent" } } },
    ];
    const session = {
        task: "Summarise data.csv", createdAt: "2026-10-03T12:00:00.000Z", status: "done",
        messages: [{ role: "system", content: "sys" }, { role: "user", content: "Task: x" }, { role: "assistant", content: "```python\nprint(1)\n```" }, { role: "user", content: "<observation>" }],
        timeline: [
            { type: "task", text: "Summarise data.csv", files: ["data.csv"], ts: "t0", checkpoint: 0 },
            { type: "step", n: 1, kind: "code", phase: "done", reasoning: "think", proposedCode: "print(1)\n", output: "1\n", status: "ok",
              changes: { added: [{ path: "out/report.md", hash: oldHash, size: 25 }], modified: [], deleted: [] },
              risk: { verdict: "auto", reasons: [] }, decision: "auto", decidedBy: "auto", notes: ["Loaded numpy"], checkpoint: 1, _held: ["x"], _draft: "secret draft" },
            { type: "user", kind: "guidance", text: "use pandas" },
            { type: "note", text: "⏪ rewound", tone: "info" },
        ],
        stepCount: 1, tokens: { prompt: 100, completion: 20 }, activeMs: 1234,
        settings: { apiUrl: "http://localhost:8080/v1", model: "qwen", autonomy: "risk", stepLimit: 20, stepTimeoutSec: 60, maxTokens: 8192, effort: "low" },
    };
    const state = { session, files: fileMap, blobs, checkpoints };

    const entries = X.buildSessionArchive(state, { includeCheckpoints: true, now: "2026-10-03T13:00:00.000Z" });
    const names = entries.map(e => e.path);
    check("archive layout", ["manifest.json", "session.json", "transcript.md", "workspace/data.csv", "workspace/out/report.md", "workspace/bin.dat", "checkpoints/index.json", "checkpoints/blobs/" + oldHash].every(n => names.includes(n)), names);
    check("checkpoint blobs already in workspace/ aren't repeated", names.filter(n => n.startsWith("checkpoints/blobs/")).length === 1);
    const sessionText = dec.decode(entries.find(e => e.path === "session.json").data);
    check("runtime-only fields are stripped", !sessionText.includes("secret draft") && !sessionText.includes("_held"));
    check("no API key field is ever written", !/apiKey/i.test(sessionText));
    const transcript = dec.decode(entries.find(e => e.path === "transcript.md").data);
    check("transcript is readable Markdown", transcript.includes("## Task") && transcript.includes("## Step 1 — code · ok · auto"));

    const zip = await X.zipWrite(entries);
    const back = await X.parseSessionArchive(await X.zipRead(zip));
    check("task and messages survive", back.session.task === session.task && JSON.stringify(back.session.messages) === JSON.stringify(session.messages));
    check("timeline survives (minus runtime fields)", back.session.timeline.length === 4 && back.session.timeline[1].output === "1\n" && back.session.timeline[1]._draft === undefined);
    check("checkpoint links survive", back.session.timeline[0].checkpoint === 0 && back.session.timeline[1].checkpoint === 1);
    check("step changes survive", back.session.timeline[1].changes.added[0].path === "out/report.md");
    check("workspace files and origins", back.files.size === 3 && back.files.get("data.csv").origin === "user" && back.files.get("bin.dat").origin === "agent");
    check("binary content intact", eq(back.blobs.get(back.files.get("bin.dat").hash), files["bin.dat"].bytes));
    check("checkpoints restored with their blobs", back.checkpoints.length === 2 && eq(back.blobs.get(back.checkpoints[1].files["out/report.md"].hash), oldBytes));
    check("settings restored", back.session.settings.autonomy === "risk" && back.session.settings.model === "qwen");

    const noCp = await X.parseSessionArchive(await X.zipRead(await X.zipWrite(X.buildSessionArchive(state, { includeCheckpoints: false }))));
    check("export without checkpoints imports", noCp.checkpoints.length === 0 && noCp.files.size === 3);

    // Tampering
    const tamper = async (mutate) => {
        const es = X.buildSessionArchive(state, { includeCheckpoints: true }).map(e => ({ ...e }));
        mutate(es);
        return X.parseSessionArchive(await X.zipRead(await X.zipWrite(es)));
    };
    await rejects("checkpoint blob with wrong content", tamper(es => { es.find(e => e.path.startsWith("checkpoints/blobs/")).data = enc.encode("evil"); }), "does not match");
    await rejects("checkpoint pointing at missing content", tamper(es => { es.splice(es.findIndex(e => e.path.startsWith("checkpoints/blobs/")), 1); }), "missing content");
    await rejects("checkpoint past the end of the session", tamper(es => {
        const i = es.findIndex(e => e.path === "checkpoints/index.json");
        const cps = JSON.parse(dec.decode(es[i].data)); cps[0].timelineLength = 99; es[i].data = enc.encode(JSON.stringify(cps));
    }), "past the end");
    await rejects("missing manifest", tamper(es => { es.splice(es.findIndex(e => e.path === "manifest.json"), 1); }), "not a HermitUI Agent session");
    await rejects("newer format version", tamper(es => {
        const i = es.findIndex(e => e.path === "manifest.json");
        es[i].data = enc.encode(JSON.stringify({ format: "hermit-agent-session", formatVersion: 99 }));
    }), "newer HermitUI Agent");
    await rejects("session.json not JSON", tamper(es => { es.find(e => e.path === "session.json").data = enc.encode("{nope"); }), "not valid JSON");
}

section("5. validateSession");
{
    const base = { task: "t", messages: [], timeline: [] };
    const bad = (name, v, frag) => { try { X.validateSession(v); check(name, false, "accepted"); } catch (e) { check(name, e.message.includes(frag), e.message); } };
    bad("missing task", { messages: [], timeline: [] }, "'task'");
    bad("missing messages", { task: "t", timeline: [] }, "'messages'");
    bad("bad role", { ...base, messages: [{ role: "tool", content: "x" }] }, "message 0");
    bad("unknown timeline type", { ...base, timeline: [{ type: "script" }] }, "unknown type");
    const v = X.validateSession({ ...base, extra: "ignored", timeline: [{ type: "step", n: 1, phase: "pending-approval", output: 42, notes: ["a", 3], onclick: "x" }], origins: { "../x": "user", "ok.txt": "agent", "y": "root" } });
    check("unknown fields ignored", !("extra" in v) && !("onclick" in v.timeline[0]));
    check("a step waiting at export time restores as interrupted", v.timeline[0].phase === "done" && v.timeline[0].status === "interrupted");
    check("fields coerced to their types", v.timeline[0].output === "42" && JSON.stringify(v.timeline[0].notes) === '["a"]');
    check("unsafe or invalid origins dropped", JSON.stringify(v.origins) === '{"ok.txt":"agent"}');
    check("defaults filled in", v.status === "paused" && v.settings.autonomy === "risk" && v.settings.stepLimit === 20);
    // Numeric settings are clamped to the Settings → Save bounds, so a crafted or old
    // session can't carry e.g. a step timeout of 0 (which would disable the watchdog).
    const clamp = (s) => X.validateSession({ ...base, settings: s }).settings;
    check("step timeout clamped to >= 1 (0 or negative would disable the watchdog)", clamp({ stepTimeoutSec: 0 }).stepTimeoutSec === 1 && clamp({ stepTimeoutSec: -5 }).stepTimeoutSec === 1);
    check("step timeout capped, step limit and max tokens clamped, non-integers rounded", clamp({ stepTimeoutSec: 1e12 }).stepTimeoutSec === 3600 && clamp({ stepLimit: 1e9 }).stepLimit === 500 && clamp({ maxTokens: -1 }).maxTokens === 0 && clamp({ stepLimit: 2.5 }).stepLimit === 3);
    const w = X.validateSession({ ...base, timeline: [{ type: "step", n: 1, stats: { tps: 40, ctxUsed: 900, html: "<b>" } }, { type: "step", n: 2 }] });
    check("step stats survive import, cleaned", w.timeline[0].stats.tps === 40 && w.timeline[0].stats.ctxUsed === 900 && !("html" in w.timeline[0].stats));
    check("a step without stats imports with none", w.timeline[1].stats === null);
}

section("6. Compactions survive export and keep rewind possible");
{
    const bytes = enc.encode("a,b\n");
    const h = await X.sha256Hex(bytes);
    const full = [{ role: "system", content: "sys" }, { role: "user", content: "Task: x" }, { role: "assistant", content: "s1" }, { role: "user", content: "o1" }, { role: "assistant", content: "s2" }, { role: "user", content: "o2" }];
    const session = {
        task: "x", createdAt: "t", status: "paused",
        messages: [{ role: "system", content: "sys" }, { role: "user", content: 'Task: x\n\n<history_summary steps="1-1">…</history_summary>' }, { role: "assistant", content: "s2" }, { role: "user", content: "o2" }],
        compactions: [{ before: full, fromStep: 1, toStep: 1 }],
        timeline: [{ type: "task", text: "x", checkpoint: 0 }, { type: "compaction", reason: "threshold", fromStep: 1, toStep: 1, summary: "## Task\nx", tokensBefore: 900, tokensAfter: 300 }],
        stepCount: 2, settings: { autoCompactPct: 60, contextSize: 8192 },
    };
    const files = new Map([["a.csv", { hash: h, origin: "user" }]]);
    const checkpoints = [
        { timelineLength: 1, msgCount: 4, stepCount: 1, epoch: 0, label: "step 1", files: { "a.csv": { hash: h, origin: "user" } } },
        { timelineLength: 2, msgCount: 4, stepCount: 2, epoch: 1, label: "step 2", files: { "a.csv": { hash: h, origin: "user" } } },
    ];
    const es = X.buildSessionArchive({ session, files, blobs: new Map([[h, bytes]]), checkpoints }, { includeCheckpoints: true });
    const back = await X.parseSessionArchive(await X.zipRead(await X.zipWrite(es)));
    check("compactions round-trip", JSON.stringify(back.session.compactions) === JSON.stringify(session.compactions));
    check("checkpoint epochs round-trip", back.checkpoints[0].epoch === 0 && back.checkpoints[1].epoch === 1);
    check("compaction card round-trips", back.session.timeline[1].type === "compaction" && back.session.timeline[1].summary === "## Task\nx");
    check("compaction settings round-trip", back.session.settings.autoCompactPct === 60 && back.session.settings.contextSize === 8192);
    check("transcript notes the compaction", dec.decode(es.find(e => e.path === "transcript.md").data).includes("History compacted — steps 1–1"));

    const tamperCp = async (mutate) => {
        const copy = es.map(e => ({ ...e }));
        const i = copy.findIndex(e => e.path === "checkpoints/index.json");
        const cps = JSON.parse(dec.decode(copy[i].data)); mutate(cps); copy[i].data = enc.encode(JSON.stringify(cps));
        return X.parseSessionArchive(await X.zipRead(await X.zipWrite(copy)));
    };
    await rejects("epoch beyond the compactions", tamperCp(cps => { cps[0].epoch = 5; }), "epoch");
    await rejects("msgCount checked against that epoch's history", tamperCp(cps => { cps[0].msgCount = 7; }), "past the end");
    const old = await tamperCp(cps => { delete cps[0].epoch; delete cps[1].epoch; });
    check("an export without epochs counts as the latest epoch", old.checkpoints[0].epoch === 1);

    // A checkpoint dropped to save memory exports as null and comes back as null.
    const gap = X.buildSessionArchive({ session, files, blobs: new Map([[h, bytes]]), checkpoints: [null, checkpoints[1]] }, { includeCheckpoints: true });
    const gapBack = await X.parseSessionArchive(await X.zipRead(await X.zipWrite(gap)));
    check("dropped checkpoints round-trip as gaps", gapBack.checkpoints.length === 2 && gapBack.checkpoints[0] === null && gapBack.checkpoints[1].label === "step 2");
    check("…and the timeline link keeps its index", gapBack.session.timeline[0].checkpoint === 0);
    await rejects("a non-null bad entry is still rejected", tamperCp(cps => { cps[0] = "x"; }), "malformed");

    const bad = (name, v, frag) => { try { X.validateSession(v); check(name, false, "accepted"); } catch (e) { check(name, e.message.includes(frag), e.message); } };
    bad("compactions not a list", { task: "t", messages: [], timeline: [], compactions: {} }, "'compactions'");
    bad("compaction with a bad message", { task: "t", messages: [], timeline: [], compactions: [{ before: [{ role: "tool", content: "x" }], fromStep: 1, toStep: 1 }] }, "compaction 0 message 0");
    bad("compaction with bad steps", { task: "t", messages: [], timeline: [], compactions: [{ before: [], fromStep: 3, toStep: 1 }] }, "compaction 0");
    const v = X.validateSession({ task: "t", messages: [], timeline: [] });
    check("older sessions: no compactions, defaults", v.compactions.length === 0 && v.settings.autoCompactPct === 85 && v.settings.contextSize === 0);
    check("compaction threshold clamped", X.validateSession({ task: "t", messages: [], timeline: [], settings: { autoCompactPct: 500 } }).settings.autoCompactPct === 95);
}

section("7. workspaceEntriesFromZip — importing a workspace from a zip");
{
    const pick = async (entries) => X.workspaceEntriesFromZip(await X.zipRead(await X.zipWrite(entries)));
    // A workspace zip, as the ⬇️ Zip button writes it.
    let r = await pick([{ path: "data.csv", data: enc.encode("a\n") }, { path: "out/report.md", data: enc.encode("# r") }]);
    check("plain zip: every file, paths kept", !r.fromSession && r.files.map(f => f.path).join() === "data.csv,out/report.md" && dec.decode(r.files[1].data) === "# r", JSON.stringify(r.files.map(f => f.path)));

    r = await pick([{ path: "a.txt", data: enc.encode("x") }, { path: "__MACOSX/._a.txt", data: enc.encode("junk") }, { path: "sub/.DS_Store", data: enc.encode("junk") }, { path: "Thumbs.db", data: enc.encode("junk") }]);
    check("OS archive junk skipped", r.files.map(f => f.path).join() === "a.txt", JSON.stringify(r.files.map(f => f.path)));

    // A session export: only workspace/, prefix stripped.
    const data = enc.encode("a,b\n");
    const h = await X.sha256Hex(data);
    const session = { task: "t", createdAt: "2026-10-05T00:00:00.000Z", status: "done", messages: [], timeline: [], stepCount: 0, tokens: { prompt: 0, completion: 0 }, activeMs: 0, settings: {} };
    const entries = X.buildSessionArchive({ session, files: new Map([["in/data.csv", { hash: h, origin: "user" }]]), blobs: new Map([[h, data]]), checkpoints: [] }, {});
    r = await pick(entries);
    check("session export: only its workspace files", r.fromSession && r.files.map(f => f.path).join() === "in/data.csv" && dec.decode(r.files[0].data) === "a,b\n", JSON.stringify(r.files.map(f => f.path)));

    // A user's own manifest.json is just a file.
    r = await pick([{ path: "manifest.json", data: enc.encode('{"name":"mine"}') }, { path: "workspace/x.txt", data: enc.encode("x") }]);
    check("foreign manifest.json: a plain zip", !r.fromSession && r.files.length === 2);
    r = await pick([{ path: "manifest.json", data: enc.encode("not json") }]);
    check("broken manifest.json: a plain zip", !r.fromSession && r.files.length === 1);

    r = await pick([{ path: "manifest.json", data: enc.encode(JSON.stringify({ format: X.SESSION_FORMAT, formatVersion: 1 })) }, { path: "session.json", data: enc.encode("{}") }]);
    check("session without workspace files: nothing to import", r.fromSession && r.files.length === 0);
}

report();
