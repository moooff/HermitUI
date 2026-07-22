// Round-trip tests for 📤 Export / 📂 Import, with an emphasis on how file
// attachments survive the trip. Run with:  node tests/export-import.test.mjs
import H from "./extract.mjs";
const { SUMMARY_PREFIX, escapeHtml, parseChatExport, splitContextBlocks, exportMd } = H;

// Mirror of the payload the submit handler builds for a user turn (src/script.js,
// "Send Message" handler). Kept in step with it by hand — if the wrapping format
// changes there, change it here too and the round-trip assertions stay meaningful.
function userMsg(text, contextText, files = []) {
    const textFiles = files.filter(f => f.kind !== "image");
    const imageFiles = files.filter(f => f.kind === "image");
    const blocks = [];
    if (contextText) blocks.push(`<context>\n${contextText}\n</context>`);
    textFiles.forEach(f => blocks.push(`<file name="${escapeHtml(f.name)}">\n${f.content}\n</file>`));
    const payloadText = blocks.length ? blocks.join("\n\n") + "\n\n" + text : text;
    if (imageFiles.length) {
        return {
            role: "user",
            content: [
                { type: "text", text: payloadText },
                ...imageFiles.map(f => ({ type: "image_url", image_url: { url: f.dataUrl } })),
            ],
        };
    }
    return { role: "user", content: payloadText };
}

const SYS = { role: "system", content: "You are a helpful assistant." };
const AI = t => ({ role: "assistant", content: t });

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else {
        fail++;
        console.log("  FAIL  " + name + (detail ? "\n        " + String(detail).replace(/\n/g, "\n        ") : ""));
    }
}
const roundtrip = msgs => {
    const md = exportMd(msgs);
    return { md, parsed: parseChatExport(md) };
};

console.log("\n=== 1. plain text conversation ===");
{
    const msgs = [SYS, userMsg("Hello there", ""), AI("Hi! How can I help?")];
    const { parsed } = roundtrip(msgs);
    check("system prompt restored", parsed.system === SYS.content, parsed.system);
    check("two turns", parsed.turns.length === 2);
    check("user text intact", parsed.turns[0].content === "Hello there", parsed.turns[0].content);
    check("ai text intact", parsed.turns[1].content === "Hi! How can I help?");
}

console.log("\n=== 2. text attachment + prompt text ===");
{
    const f = { name: "notes.txt", kind: "text", content: "line one\nline two" };
    const msgs = [SYS, userMsg("Summarize this", "", [f]), AI("Sure.")];
    const { md, parsed } = roundtrip(msgs);
    check("attachment body written to the export", md.includes("line one\nline two"));
    check("file tag written to the export", md.includes('<file name="notes.txt">'));
    const s = splitContextBlocks(parsed.turns[0].content);
    check("prompt text peeled back", s.text === "Summarize this", JSON.stringify(s.text));
    check("one file restored", s.files.length === 1, JSON.stringify(s.files));
    check("filename restored", s.files[0]?.name === "notes.txt");
    check("file content restored", s.files[0]?.content === f.content, JSON.stringify(s.files[0]?.content));
    check("payload byte-identical", parsed.turns[0].content === msgs[1].content);
}

// Regression: submit allows an attachment with no prompt text, which leaves the payload
// ending in "\n\n"; parseChatExport trims it, so splitContextBlocks must also accept
// end-of-string as a block terminator. Previously the raw <file …> tag rendered as text.
console.log("\n=== 3. attachment with NO prompt text (regression) ===");
{
    const f = { name: "data.csv", kind: "text", content: "a,b\n1,2" };
    const msgs = [SYS, userMsg("", "", [f]), AI("ok")];
    const { parsed } = roundtrip(msgs);
    const s = splitContextBlocks(parsed.turns[0].content);
    check("file restored", s.files.length === 1, "files=" + JSON.stringify(s.files) + " rest=" + JSON.stringify(s.text));
    check("filename restored", s.files[0]?.name === "data.csv");
    check("content restored", s.files[0]?.content === f.content, JSON.stringify(s.files[0]?.content));
    check("no raw tag left as message text", s.text === "", JSON.stringify(s.text));
    // Export trims the payload's trailing blank line; only whitespace differs.
    check("payload identical up to trailing whitespace",
        parsed.turns[0].content.trim() === msgs[1].content.trim());
}

console.log("\n=== 4. context-pane text with NO prompt text (regression) ===");
{
    const msgs = [SYS, userMsg("", "pasted context blob"), AI("ok")];
    const { parsed } = roundtrip(msgs);
    const s = splitContextBlocks(parsed.turns[0].content);
    check("context restored", s.contextText === "pasted context blob", JSON.stringify(s.contextText));
    check("no raw tag left as message text", s.text === "", JSON.stringify(s.text));
}

console.log("\n=== 5. context + multiple files + text ===");
{
    const files = [
        { name: "a.txt", kind: "text", content: "AAA" },
        { name: "b.json", kind: "text", content: '{"k": "v"}' },
    ];
    const msgs = [SYS, userMsg("Compare them", "some context", files), AI("done")];
    const { parsed } = roundtrip(msgs);
    const s = splitContextBlocks(parsed.turns[0].content);
    check("context restored", s.contextText === "some context", JSON.stringify(s.contextText));
    check("both files restored", s.files.length === 2, JSON.stringify(s.files));
    check("file order preserved", s.files[0]?.name === "a.txt" && s.files[1]?.name === "b.json");
    check("text restored", s.text === "Compare them", JSON.stringify(s.text));
}

// Images are deliberately not exported: contentToText flattens them to a placeholder,
// so no image bytes and no filenames leave the browser in the .md.
console.log("\n=== 6. image attachment is flattened, not exported ===");
{
    const img = { name: "shot.png", kind: "image", dataUrl: "data:image/png;base64,iVBORw0KGgoAAA" };
    const msgs = [SYS, userMsg("What is this?", "", [img]), AI("A picture.")];
    const { md, parsed } = roundtrip(msgs);
    check("image bytes absent from export", !md.includes("iVBORw0KGgoAAA"));
    check("image filename absent from export", !md.includes("shot.png"));
    check("placeholder written", md.includes("[1 image attached]"));
    check("placeholder comes back as literal text",
        parsed.turns[0].content === "What is this? [1 image attached]", JSON.stringify(parsed.turns[0].content));
    check("re-sent payload is a plain string, not a multimodal array",
        typeof parsed.turns[0].content === "string");
}

console.log("\n=== 7. image + text file together ===");
{
    const files = [
        { name: "notes.txt", kind: "text", content: "keep me" },
        { name: "a.png", kind: "image", dataUrl: "data:image/png;base64,ZZZ" },
    ];
    const msgs = [SYS, userMsg("both", "", files), AI("ok")];
    const { md, parsed } = roundtrip(msgs);
    check("text file survives", md.includes("keep me"));
    const s = splitContextBlocks(parsed.turns[0].content);
    check("text file restored", s.files.length === 1 && s.files[0].content === "keep me", JSON.stringify(s));
    check("image reduced to placeholder", s.text === "both [1 image attached]", JSON.stringify(s.text));
}

console.log("\n=== 8. filename needing HTML escaping ===");
{
    const f = { name: 'we"ird & <name>.txt', kind: "text", content: "x" };
    const msgs = [SYS, userMsg("t", "", [f]), AI("ok")];
    const { parsed } = roundtrip(msgs);
    const s = splitContextBlocks(parsed.turns[0].content);
    check("filename round-trips through escape/unescape", s.files[0]?.name === f.name, JSON.stringify(s.files[0]?.name));
}

// Accepted format limitations, asserted so a future change to the wrapping format is a
// deliberate decision rather than a surprise. Attachment bodies are inlined unescaped,
// so content that reproduces a closing delimiter truncates the block.
console.log("\n=== 9. documented limitation: content containing the closing sequences ===");
{
    const f1 = { name: "evil.md", kind: "text", content: "text\n\n</div>\n\nmore" };
    const { parsed: p1 } = roundtrip([SYS, userMsg("look", "", [f1]), AI("ok")]);
    check("turn count unaffected by an embedded </div>", p1.turns.length === 2, "got " + p1.turns.length);
    check("embedded </div> truncates the turn (known)", p1.turns[0].content !== `<file name="evil.md">\n${f1.content}\n</file>\n\nlook`);

    const f2 = { name: "meta.txt", kind: "text", content: "a\n</file>\n\nb" };
    const { parsed: p2 } = roundtrip([SYS, userMsg("look", "", [f2]), AI("ok")]);
    const s2 = splitContextBlocks(p2.turns[0].content);
    check("embedded </file> truncates the attachment (known)", s2.files[0]?.content === "a", JSON.stringify(s2.files[0]?.content));
}

console.log("\n=== 10. empty and malformed input ===");
{
    const { parsed } = roundtrip([SYS]);
    check("system-only export still parses", parsed !== null && parsed.turns.length === 0, JSON.stringify(parsed));
    check("unrelated markdown rejected", parseChatExport("# Some notes\n\nhello world") === null);
    check("empty file rejected", parseChatExport("") === null);
}

// A 📋 summary is a session artifact that is deliberately filtered out of every request
// payload. Before it got its own wrapper it exported as a normal `ai-message`, so an
// import turned it into a genuine assistant turn that the model then saw.
console.log("\n=== 11. summary keeps its status across the round trip ===");
{
    const summary = {
        role: "assistant",
        content: SUMMARY_PREFIX + "## TL;DR\nThey greeted each other.",
        isSummary: true,
    };
    const msgs = [SYS, userMsg("hi", ""), AI("hello"), summary];
    const { md, parsed } = roundtrip(msgs);
    check("exported under its own wrapper", md.includes('<div class="summary-message">'), md);
    check("not exported as a normal AI turn", (md.match(/ai-message/g) || []).length === 1);
    check("redundant stored heading stripped from the body", !md.includes("\n## Summary\n"), md);
    check("three turns", parsed.turns.length === 3, JSON.stringify(parsed.turns));
    check("summary flagged on import", parsed.turns[2].isSummary === true, JSON.stringify(parsed.turns[2]));
    check("real answer not flagged", parsed.turns[1].isSummary === false);
    check("user turn not flagged", parsed.turns[0].isSummary === false);
    check("summary body restored", parsed.turns[2].content === "## TL;DR\nThey greeted each other.",
        JSON.stringify(parsed.turns[2].content));
    check("history entry rebuilds byte-identically",
        SUMMARY_PREFIX + parsed.turns[2].content === summary.content);
}

// The System block distinguishes "absent" (old/other export — keep the current prompt)
// from "present but empty" (exported with the prompt deliberately cleared).
console.log("\n=== 12. empty vs absent system prompt ===");
{
    const { parsed } = roundtrip([{ role: "system", content: "" }, userMsg("q", "")]);
    check("empty system prompt parses as \"\", not null", parsed.system === "", JSON.stringify(parsed.system));

    const noSys = parseChatExport('# Chat Export\n\n## 🧑‍💻 You\n\n<div class="user-message">\n\nq\n\n</div>\n\n');
    check("missing system block parses as null", noSys.system === null, JSON.stringify(noSys.system));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
