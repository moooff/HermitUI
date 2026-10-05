// Phase 2b: binary summaries, what the model is told about figures and binary files, the
// periodic file listing, and the new step fields in an export.
// Run: node tests/richoutput.test.mjs
import { check, section, report } from "./check.mjs";
import X from "./extract.mjs";

const enc = new TextEncoder();
const cat = (...parts) => {
    const arrs = parts.map(p => (typeof p === "string" ? enc.encode(p) : p instanceof Uint8Array ? p : new Uint8Array(p)));
    const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
    let o = 0;
    for (const a of arrs) { out.set(a, o); o += a.length; }
    return out;
};
const be32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const be16 = (v) => [(v >>> 8) & 255, v & 255];
const le32 = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
const le16 = (v) => [v & 255, (v >>> 8) & 255];
const gunzip = async (b64) => new Uint8Array(await new Response(new Blob([Buffer.from(b64, "base64")]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
const d = (bytes) => X.describeBinary(bytes);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Real files, made with Python's sqlite3 (page size 512; tables customers and "orders")
// and gzip (a member named data.tar).
const SQLITE_GZ = "H4sIAAAAAAAC/wsO9MksSVVIyy/KTSxRMGZgYmBkZHBQUGBgYGCGYhhgAmIWJD4jA2HAzKBXVcgL0syYycC4CUiMVODOxCYuKcmYXZKYlJOaX5SSWlQMIZmdg1wdQ1wVQhydfFwVlCCCSgoamSkKnn4hru6uQToKibn5pXklCkCFPpo+jGzi8vKMmWCDkkuLS/JzgRrgDCYU4+DCqOblJeamKoS4RoRoguKGkfEHAxCNghEE2BiZOYUd8/J4YTl7FIxIAAB1/3AQAAYAAA==";
const GZIP_TAR = new Uint8Array(Buffer.from("H4sICAAAAAAC/2RhdGEudGFyAO3BMQEAAADCoNqLbw0PoAAAgHcD5xfumLgLAAA=", "base64"));
const PICKLE = new Uint8Array([128, 4, 149, 16, 0, 0, 0, 0, 0, 0, 0, 125, 148, 140, 1, 97, 148, 93, 148, 40, 75, 1, 75, 2, 101, 115, 46]);

const PNG = cat([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], be32(13), "IHDR", be32(640), be32(480), [8, 6, 0, 0, 0], [1, 2, 3, 4]);
const JPEG = cat([0xFF, 0xD8], [0xFF, 0xE0], be16(16), "JFIF\0", [1, 1, 0, 0, 1, 0, 1, 0, 0],
    [0xFF, 0xC4], be16(5), [0, 0, 0],                         // a DHT segment before the frame
    [0xFF, 0xC2], be16(17), [8], be16(480), be16(640), [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1], [0xFF, 0xDA]);
const npy = (header) => {
    let h = header;
    while ((10 + h.length + 1) % 64) h += " ";
    return cat([0x93], "NUMPY", [1, 0], le16(h.length + 1), h + "\n", new Uint8Array(96));
};
const tarHeader = (name, size) => {
    const h = new Uint8Array(512);
    h.set(enc.encode(name), 0);
    h.set(enc.encode(size.toString(8).padStart(11, "0") + "\0"), 124);
    h.set(enc.encode("ustar\0"), 257);
    return h;
};

section("1. describeBinary — images");
{
    check("PNG: size and color type", same(d(PNG), { kind: "image", type: "PNG image", details: ["640×480 px", "RGBA"] }), JSON.stringify(d(PNG)));
    check("JPEG: the frame header after other segments, progressive", same(d(JPEG), { kind: "image", type: "JPEG image", details: ["640×480 px", "color"] }), JSON.stringify(d(JPEG)));
    check("JPEG without a frame header: just the type", same(d(cat([0xFF, 0xD8, 0xFF, 0xDA, 0, 0, 0, 0, 0, 0, 0, 0])), { kind: "image", type: "JPEG image", details: [] }));
    check("GIF", same(d(cat("GIF89a", le16(10), le16(20), [0, 0, 0])).details, ["10×20 px"]));
    const vp8x = cat("RIFF", le32(30), "WEBP", "VP8X", le32(10), [0x12, 0, 0, 0], [43, 1, 0], [199, 0, 0]);
    check("WebP (VP8X, animated)", same(d(vp8x).details, ["300×200 px", "animated"]), JSON.stringify(d(vp8x)));
    const vp8l = cat("RIFF", le32(30), "WEBP", "VP8L", le32(10), [0x2F], le32((99) | (49 << 14)));
    check("WebP (VP8L, lossless)", same(d(vp8l).details, ["100×50 px"]), JSON.stringify(d(vp8l)));
    const vp8 = cat("RIFF", le32(30), "WEBP", "VP8 ", le32(10), [0, 0, 0, 0x9D, 0x01, 0x2A], le16(64), le16(32));
    check("WebP (VP8, lossy)", same(d(vp8).details, ["64×32 px"]), JSON.stringify(d(vp8)));
    const bmp = cat("BM", le32(70), le32(0), le32(54), le32(40), le32(40), le32(-30 >>> 0), new Uint8Array(30));
    check("BMP, a top-down one's negative height", same(d(bmp).details, ["40×30 px"]), JSON.stringify(d(bmp)));
    check("a truncated PNG is still a PNG, without made-up details", same(d(PNG.subarray(0, 8)), { kind: "image", type: "PNG image", details: [] }));
}

section("2. describeBinary — data, documents, archives, audio");
{
    const db = d(await gunzip(SQLITE_GZ));
    check("SQLite: its tables and pages", db.type === "SQLite database" && same(db.details, ["tables: customers, orders", "3 pages of 512 B"]), JSON.stringify(db));
    check(".npy: dtype and shape", same(d(npy("{'descr': '<f8', 'fortran_order': False, 'shape': (3, 4), }")), { kind: "data", type: "NumPy array (.npy)", details: ["dtype float64", "shape (3, 4)"] }));
    check(".npy: a 1-d bool array", same(d(npy("{'descr': '|b1', 'fortran_order': False, 'shape': (5,), }")).details, ["dtype bool", "shape (5,)"]));
    check(".npy: int32", d(npy("{'descr': '<i4', 'fortran_order': False, 'shape': (2,), }")).details[0] === "dtype int32");
    check("pickle and its protocol", same(d(PICKLE), { kind: "data", type: "Python pickle", details: ["protocol 4"] }));
    const pdf = enc.encode("%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>\nendobj\n%%EOF\n");
    check("PDF: version and page count", same(d(pdf), { kind: "document", type: "PDF document", details: ["version 1.7", "3 pages"] }), JSON.stringify(d(pdf)));
    check("PDF without a readable page tree: no count", same(d(enc.encode("%PDF-1.4\n%garbage")).details, ["version 1.4"]));
    const xlsx = await X.zipWrite([{ path: "[Content_Types].xml", data: enc.encode("<Types/>") }, { path: "xl/workbook.xml", data: enc.encode("<workbook/>") }]);
    check("a zip with xl/ is an Excel workbook", same(d(xlsx), { kind: "document", type: "Excel workbook (.xlsx)", details: ["2 entries", "unpacks to 19 B"] }), JSON.stringify(d(xlsx)));
    const npz = await X.zipWrite([{ path: "x.npy", data: npy("{'descr': '<f8', 'fortran_order': False, 'shape': (1,), }") }, { path: "y.npy", data: new Uint8Array(3) }]);
    check("a zip of .npy files is an .npz", d(npz).type === "NumPy archive (.npz)" && d(npz).details[0] === "arrays: x, y", JSON.stringify(d(npz)));
    const zip = await X.zipWrite([{ path: "a.txt", data: enc.encode("hello") }]);
    check("any other zip", same(d(zip), { kind: "archive", type: "ZIP archive", details: ["1 entry", "unpacks to 5 B"] }), JSON.stringify(d(zip)));
    check("gzip: the member's name and unpacked size", same(d(GZIP_TAR), { kind: "archive", type: "gzip-compressed tar archive", details: ["of data.tar", "unpacks to 2.9 KB"] }), JSON.stringify(d(GZIP_TAR)));
    const tar = cat(tarHeader("a.txt", 5), new Uint8Array(512), tarHeader("dir/b.bin", 600), new Uint8Array(1024), new Uint8Array(1024));
    check("tar: entries counted", same(d(tar), { kind: "archive", type: "tar archive", details: ["2 entries"] }), JSON.stringify(d(tar)));
    const wav = cat("RIFF", le32(36 + 16000), "WAVE", "fmt ", le32(16), le16(1), le16(1), le32(8000), le32(16000), le16(2), le16(16), "data", le32(16000), new Uint8Array(16000));
    check("WAV: rate, channels, bits, length", same(d(wav), { kind: "audio", type: "WAV audio", details: ["8,000 Hz", "mono", "16-bit", "1.00 s"] }), JSON.stringify(d(wav)));
    check("wasm", same(d(cat([0, 0x61, 0x73, 0x6D], le32(1))).details, ["version 1"]));
    check("TrueType: a table directory", d(cat([0, 1, 0, 0], be16(12), new Uint8Array(6), "cmap", new Uint8Array(12))).type === "TrueType font");
    check("…raw int32 data with the same first bytes isn't one", d(cat(le32(256), le32(5), le32(7), le32(9), le32(11))).type === "binary data");
    const pe = new Uint8Array(200); pe.set(enc.encode("MZ")); pe.set(le32(128), 60); pe.set(enc.encode("PE\0\0"), 128);
    check("Windows executable: MZ pointing at a PE header", d(pe).type === "Windows executable");
    check("…'MZ' alone isn't one", d(cat("MZ", new Uint8Array(100))).type === "binary data");
    check("unknown bytes are 'binary data'", same(d(new Uint8Array([1, 2, 3, 0, 9])), { kind: "binary", type: "binary data", details: [] }));
    check("empty input too", d(new Uint8Array(0)).type === "binary data" && d(undefined).type === "binary data");
    check("zipCentralDirectory: garbage is null", X.zipCentralDirectory(new Uint8Array(40), 10) === null && X.zipCentralDirectory(new Uint8Array(3), 10) === null);
}

section("3. describeBinary never throws on cut or corrupt files");
{
    const samples = [PNG, JPEG, PICKLE, GZIP_TAR, await gunzip(SQLITE_GZ), npy("{'descr': '<f8', 'shape': (3,), }"),
        await X.zipWrite([{ path: "[Content_Types].xml", data: enc.encode("x") }, { path: "word/document.xml", data: enc.encode("y") }])];
    let seed = 11;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    let threw = "";
    for (let t = 0; t < 2000 && !threw; t++) {
        const src = samples[rnd(samples.length)];
        const cut = src.slice(0, rnd(src.length + 1));
        if (cut.length && rnd(2)) cut[rnd(cut.length)] = rnd(256);   // and a flipped byte
        try { X.describeBinary(cut); X.binarySummary(cut); } catch (e) { threw = `${e.message} (sample of ${cut.length} bytes)`; }
    }
    check("2,000 truncated and corrupted samples", !threw, threw);
}

section("4. What the model is told");
{
    check("binarySummary: type, details, size", X.binarySummary(PNG) === "PNG image, 640×480 px, RGBA, 33 B", X.binarySummary(PNG));
    const notes = X.binaryFileNotes(
        [{ path: "figures/step-3-1.png", bytes: PNG }, { path: "figures/step-3-2.png", bytes: PNG }, { path: "out.db", bytes: await gunzip(SQLITE_GZ) }, { path: "notes.txt", bytes: enc.encode("text") }],
        [{ path: "figures/step-3-1.png", width: 640, height: 480, how: "show" }, { path: "figures/step-3-2.png", width: 800, height: 600, how: "end" }]);
    check("figures: one note, how each was captured, and that the model can't see them",
        notes[0] === "Figures saved and shown to the user: figures/step-3-1.png (640×480 px, from plt.show()), figures/step-3-2.png (800×600 px, still open at the end of the step). You can't see images; the user can.", notes[0]);
    check("other binary files: their summary", notes[1] === "Binary file written: out.db: SQLite database, tables: customers, orders, 3 pages of 512 B, 1.5 KB.", notes[1]);
    check("text files: nothing", notes.length === 2);
    const many = X.binaryFileNotes(Array.from({ length: 13 }, (_, i) => ({ path: `b${i}.bin`, bytes: new Uint8Array([0, i]) })), []);
    check("past 10 binary files, the rest are counted", many.length === 1 && many[0].endsWith("; and 3 more.") && (many[0].match(/binary data/g) || []).length === 10, many[0]);
    check("nothing written, no notes", X.binaryFileNotes([], []).length === 0 && X.binaryFileNotes(undefined, undefined).length === 0);

    const files = [{ path: "b.csv", size: 2048, hash: "h2" }, { path: "a.py", size: 10, hash: "h1" }];
    check("periodic list: not before its step", X.periodicFileListing(4, 5, "", files) === null);
    const due = X.periodicFileListing(5, 5, "", files);
    check("…due on every 5th step, sorted, with sizes", due && due.note === "Files in /workspace now: a.py (10 B), b.csv (2.0 KB)", due && due.note);
    check("…not when nothing changed since the last list", X.periodicFileListing(10, 5, due.key, [...files].reverse()) === null);
    check("…again once a file changed", X.periodicFileListing(10, 5, due.key, [files[0], { ...files[1], hash: "h9" }]) !== null);
    check("…an empty workspace is a list too", X.periodicFileListing(5, 5, due.key, []).note === "Files in /workspace now: (empty)");
    check("…every 0 turns it off", X.periodicFileListing(5, 0, "", files) === null);
    check("fileListingKey ignores order", X.fileListingKey(files) === X.fileListingKey([...files].reverse()));

    const ws = { paths: ["chart.png"], read: () => PNG };
    const r = X.applyFileActions([{ tool: "read_file", args: { path: "chart.png" } }], ws);
    check("read_file of a binary says what it is", r.results[0].message === "chart.png is a binary file (PNG image, 640×480 px, RGBA, 33 B); inspect it with python.", r.results[0].message);
    const e = X.applyFileActions([{ tool: "edit_file", args: { path: "chart.png", edits: [{ old_text: "a", new_text: "b" }] } }], ws);
    check("edit_file of a binary names its type", e.results[0].message === "chart.png is a binary file (PNG image); it can't be edited as text.", e.results[0].message);
    const prompt = X.buildSystemPrompt("");
    check("the system prompt explains figure capture", prompt.includes("plt.show() saves each open figure as figures/step-N-K.png") && prompt.includes("savefig") && !prompt.includes("Agg backend"));
}

section("5. Export: figures and the file-list mark");
{
    const raw = {
        task: "t", messages: [{ role: "system", content: "s" }],
        timeline: [{ type: "step", n: 1, kind: "code", phase: "done", fileListSent: 3,
            figures: [{ path: "figures/step-1-1.png", width: 640, height: 480, how: "show" }, { path: "../evil.png", width: 1, height: 1 }, { path: "f.png", width: -5, height: "x", how: "<script>" }],
            changes: { added: [{ path: "figures/step-1-1.png", hash: "a".repeat(64), size: 10 }], modified: [], deleted: [] } }],
    };
    const s = X.validateSession(raw).timeline[0];
    check("figures kept, unsafe paths dropped, junk coerced", same(s.figures, [{ path: "figures/step-1-1.png", width: 640, height: 480, how: "show" }, { path: "f.png", width: 0, height: 0, how: "end" }]), JSON.stringify(s.figures));
    check("fileListSent kept", s.fileListSent === 3);
    const old = X.validateSession({ task: "t", messages: [], timeline: [{ type: "step", n: 1 }] }).timeline[0];
    check("older exports: no figures, no list", same(old.figures, []) && old.fileListSent === 0);
    const md = X.transcriptMarkdown({ timeline: [s] });
    check("the transcript names the figures and the list", md.includes("Figures shown: figures/step-1-1.png (640×480 px)") && md.includes("The current file list (3 files) was sent with this step."), md);
}

report();
