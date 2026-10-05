// ========== Python worker (DESIGN §4.2) ==========
// Everything the worker runs lives inside hermitWorkerMain. script.js serialises it with
// Function.prototype.toString() and starts it as a *classic* Blob-URL worker: Chromium
// refuses Blob module workers on file://, and Pyodide 0.29.x is the last line that still
// boots in a classic worker (PHASE0_FINDINGS.md, "Offline boot findings"). On the main
// thread this file only defines the function; it must not reference anything outside
// its own body.
//
// Protocol: the main thread sends { id, op, ... }; the worker answers { id, ok, result }
// or { id, ok: false, error }. Agent code can reach this worker's JS globals through
// Pyodide's `js` module and could post forged answers, so the main thread validates
// every message and never evaluates anything it receives (DESIGN §4.1).
function hermitWorkerMain() {
    "use strict";
    const VIRT = "https://pyodide.invalid/";
    const OUTPUT_HEAD_BYTES = 1 << 20;     // keep the first 1 MB of a step's output…
    const OUTPUT_TAIL_BYTES = 64 << 10;    // …and the last 64 KB
    let py = null;
    let ns = null;          // the agent's persistent namespace (notebook-like)
    let harness = null;     // the harness's own namespace, out of the agent's sight
    let baseline = {};      // path -> sha256 of the workspace the main thread knows about

    // ---------- Network guard (DESIGN §10) ----------
    // Best effort, not a sandbox: while agent code runs, the network APIs reachable from
    // Python via `js` are closed and every attempt is recorded, so the step can be held
    // for approval. The real functions are kept only in this closure, and every copy
    // reachable from the global object or its prototype chain is replaced. Dynamic
    // import() can't be patched from JS; the page's CSP (script-src without remote
    // hosts) is what stops it.
    // netMode: "closed" while agent code runs; "cdn" while the harness loads packages —
    // only the pinned Pyodide CDN, because agent code from an earlier step could have
    // pointed Pyodide's package registry at any URL; "open" only for a step the user
    // explicitly allowed network for; "boot" serves just the inlined core.
    let netMode = "boot";
    let packageBase = "";
    let netAttempts = [];
    let virtualFiles = {};
    const realFetch = self.fetch.bind(self);
    const realImportScripts = self.importScripts.bind(self);

    function recordAttempt(kind, target) {
        const t = target === undefined ? "" : " " + String(target).slice(0, 200);
        if (netAttempts.length < 50) netAttempts.push(kind + t);
        return new TypeError("Network access is blocked in HermitUI Agent (" + kind + ").");
    }

    function replaceEverywhere(name, value) {
        for (let o = self; o; o = Object.getPrototypeOf(o)) {
            if (Object.prototype.hasOwnProperty.call(o, name)) {
                try { Object.defineProperty(o, name, { value, writable: false, configurable: false }); } catch (e) { /* locked already */ }
            }
        }
        if (!Object.prototype.hasOwnProperty.call(self, name)) {
            try { Object.defineProperty(self, name, { value, writable: false, configurable: false }); } catch (e) { /* ignore */ }
        }
    }

    function serveVirtual(url) {
        const hit = virtualFiles[url.slice(VIRT.length)];
        if (!hit) return Promise.reject(new TypeError("not inlined: " + url));
        return Promise.resolve(new Response(hit[0], { headers: { "Content-Type": hit[1] } }));
    }

    function gatedFetch(input, init) {
        const url = typeof input === "string" ? input : (input && input.url) || String(input);
        if (url.startsWith(VIRT)) return serveVirtual(url);
        if (netMode === "open" || (netMode === "cdn" && packageBase && url.startsWith(packageBase))) return realFetch(input, init);
        return Promise.reject(recordAttempt("fetch", url));
    }

    function installNetworkGuard() {
        replaceEverywhere("fetch", gatedFetch);
        replaceEverywhere("importScripts", function (...urls) {
            for (const u of urls) {
                if (!String(u).startsWith("blob:") && netMode !== "open") throw recordAttempt("importScripts", u);
            }
            return realImportScripts(...urls);
        });
        if (self.XMLHttpRequest) {
            const proto = self.XMLHttpRequest.prototype;
            const realOpen = proto.open;
            Object.defineProperty(proto, "open", {
                value: function (method, url, ...rest) {
                    if (netMode !== "open") throw recordAttempt("XMLHttpRequest", url);
                    return realOpen.call(this, method, url, ...rest);
                },
                writable: false, configurable: false,
            });
        }
        // Nothing the harness needs; blocked for good. The prototype's `constructor`
        // back-reference is replaced too, or `WebSocket.prototype.constructor` would
        // hand the real class straight back.
        for (const name of ["WebSocket", "WebSocketStream", "EventSource", "WebTransport", "Worker", "SharedWorker", "BroadcastChannel"]) {
            const Real = self[name];
            if (typeof Real !== "function") continue;
            const blocker = function () { throw recordAttempt(name, arguments[0]); };
            try { Object.defineProperty(Real.prototype, "constructor", { value: blocker, writable: false, configurable: false }); } catch (e) { /* ignore */ }
            replaceEverywhere(name, blocker);
        }
        // Persistent browser storage is off-limits (ephemerality rule), and the Cache API
        // can also fetch (cache.add(url)).
        for (const name of ["caches", "indexedDB"]) replaceEverywhere(name, undefined);
        try {
            if (self.StorageManager) {
                for (const m of ["getDirectory", "persist", "estimate"]) {
                    Object.defineProperty(self.StorageManager.prototype, m, {
                        value: function () { return Promise.reject(recordAttempt("navigator.storage." + m)); },
                        writable: false, configurable: false,
                    });
                }
            }
        } catch (e) { /* ignore */ }
    }

    // ---------- Python harness ----------
    const HARNESS_PY = `
import os, sys, hashlib, importlib, json
os.makedirs("/workspace", exist_ok=True)
os.chdir("/workspace")
if "/workspace" not in sys.path:
    sys.path.insert(0, "/workspace")
os.environ["MPLBACKEND"] = "Agg"

def hermit_listing():
    out = {}
    for root, dirs, files in os.walk("/workspace"):
        for f in files:
            p = os.path.join(root, f)
            if os.path.islink(p) or not os.path.isfile(p):
                continue
            h = hashlib.sha256()
            with open(p, "rb") as fh:
                for chunk in iter(lambda: fh.read(1 << 20), b""):
                    h.update(chunk)
            out[os.path.relpath(p, "/workspace")] = h.hexdigest()
    return json.dumps(out)

def hermit_forget_workspace_modules():
    # A module the agent edited must be re-read on the next import; otherwise the
    # persistent namespace keeps running the old version (spike finding).
    for name, mod in list(sys.modules.items()):
        f = getattr(mod, "__file__", None) or ""
        if f.startswith("/workspace/"):
            del sys.modules[name]
    importlib.invalidate_caches()

def hermit_clear_workspace():
    import shutil
    for entry in os.listdir("/workspace"):
        p = os.path.join("/workspace", entry)
        if os.path.isdir(p) and not os.path.islink(p):
            shutil.rmtree(p)
        else:
            os.remove(p)
`;

    function listing() {
        return JSON.parse(harness.get("hermit_listing")());
    }

    function writeFile(path, bytes) {
        const full = "/workspace/" + path;
        const dir = full.slice(0, full.lastIndexOf("/"));
        py.FS.mkdirTree(dir);
        py.FS.writeFile(full, bytes);
    }

    // Keep a traceback from the agent's own code onwards, not Pyodide's internals.
    function trimTraceback(msg) {
        const lines = String(msg).split("\n");
        const i = lines.findIndex(l => l.includes('File "<step>"'));
        return i > 0 ? ["Traceback (most recent call last):", ...lines.slice(i)].join("\n") : String(msg).trim();
    }

    function outputCollector() {
        const head = [];
        let headBytes = 0, dropped = 0, tail = "";
        const decoders = { out: new TextDecoder(), err: new TextDecoder() };
        const push = (s) => {
            if (!s) return;
            if (headBytes < OUTPUT_HEAD_BYTES) {
                const room = OUTPUT_HEAD_BYTES - headBytes;
                head.push(s.slice(0, room));
                headBytes += Math.min(s.length, room);
                s = s.slice(room);
                if (!s) return;
            }
            dropped += s.length;
            tail = (tail + s).slice(-OUTPUT_TAIL_BYTES);
        };
        return {
            write: (which) => (buf) => { push(decoders[which].decode(buf, { stream: true })); return buf.length; },
            text() {
                push(decoders.out.decode()); push(decoders.err.decode());
                if (!dropped) return head.join("");
                const omitted = dropped - tail.length;
                return head.join("") + (omitted > 0 ? `\n[… ${omitted} characters of output dropped …]\n` : "") + tail;
            },
        };
    }

    // ---------- Operations ----------
    async function boot({ core, packageBaseUrl }) {
        const t0 = performance.now();
        virtualFiles = {
            "pyodide.asm.wasm": [core.wasm, "application/wasm"],
            "python_stdlib.zip": [core.stdlib, "application/zip"],
            "pyodide-lock.json": [core.lock, "application/json"],
        };
        packageBase = String(packageBaseUrl || "");
        installNetworkGuard();
        // The loader skips its own importScripts() of pyodide.asm.js when
        // _createPyodideModule already exists. The appended line exports the names,
        // because a top-level var stays local if this ever falls back to eval.
        for (const [text, name] of [[core.loaderJs, "loadPyodide"], [core.asmJs, "_createPyodideModule"]]) {
            const src = text + "\n;globalThis." + name + " = " + name + ";";
            const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
            try { realImportScripts(url); } finally { URL.revokeObjectURL(url); }
        }
        py = await self.loadPyodide({ indexURL: VIRT, packageBaseUrl, stdin: undefined });
        py.setStdin({ error: true });   // input() raises instead of hanging
        harness = py.globals.get("dict")();
        py.runPython(HARNESS_PY, { globals: harness });
        ns = py.globals.get("dict")();
        ns.set("__name__", "__main__");
        baseline = {};
        netMode = "closed";
        return {
            bootMs: Math.round(performance.now() - t0),
            pyVersion: py.runPython("import sys; sys.version.split()[0]"),
            pyodideVersion: py.version,
        };
    }

    // Replace /workspace with exactly these files (re-seed after a kill/reject/import).
    function seed({ files }) {
        harness.get("hermit_clear_workspace")();
        for (const [path, bytes] of Object.entries(files)) writeFile(path, bytes);
        baseline = listing();
        return { count: Object.keys(baseline).length };
    }

    // Add or replace files between steps (uploads); not a step, so no diff is reported.
    function write({ files }) {
        for (const [path, bytes] of Object.entries(files)) writeFile(path, bytes);
        baseline = listing();
        return { count: Object.keys(files).length };
    }

    function remove({ paths }) {
        for (const p of paths) {
            try { py.FS.unlink("/workspace/" + p); } catch (e) { /* already gone */ }
        }
        baseline = listing();
        return { count: paths.length };
    }

    // What the code imports (top-level names) and which packages are loaded already, so
    // the main thread can say what is about to be downloaded before it starts.
    function imports({ code }) {
        let names = [];
        try {
            const found = py.pyodide_py.code.find_imports(code);
            names = found.toJs();
            found.destroy();
        } catch (e) { /* a syntax error: the run reports it */ }
        return { imports: names.map(String), loaded: Object.keys(py.loadedPackages) };
    }

    // Packages the code imports, loaded by the harness (never by agent code) from the
    // pinned CDN, in memory only (DESIGN §8). Pyodide doesn't throw when a package fails:
    // it reports "Loaded …" / "Failed to load …" and the reasons through the callbacks.
    async function load({ code }) {
        const t0 = performance.now();
        const loaded = [], failed = [], errors = [];
        netAttempts = [];
        const names = (m, prefix) => m.slice(prefix.length).split(",").map(s => s.trim()).filter(Boolean);
        netMode = "cdn";
        try {
            await py.loadPackagesFromImports(code, {
                messageCallback: (m) => {
                    if (/^Loaded /.test(m)) loaded.push(...names(m, "Loaded "));
                    else if (/^Failed to load /.test(m)) failed.push(...names(m, "Failed to load "));
                },
                errorCallback: (m) => { if (errors.length < 20) errors.push(String(m).slice(0, 500)); },
            });
        } catch (e) {
            errors.push(String(e && e.message || e).split("\n")[0].slice(0, 500));
            if (!failed.length) failed.push("(packages)");
        } finally {
            netMode = "closed";
        }
        return { loaded, failed, errors, netAttempts: netAttempts.slice(), ms: Math.round(performance.now() - t0) };
    }

    async function run({ code, allowNetwork }) {
        const t0 = performance.now();
        const notes = [];
        netAttempts = [];
        const out = outputCollector();
        py.setStdout({ write: out.write("out") });
        py.setStderr({ write: out.write("err") });
        let status = "ok";
        let errorText = "";

        // The step itself, in the persistent namespace. Its packages were loaded before
        // (the load op), with the network limited to the pinned CDN.
        netMode = allowNetwork ? "open" : "closed";
        try {
            harness.get("hermit_forget_workspace_modules")();
            await py.runPythonAsync(code, { globals: ns, filename: "<step>" });
        } catch (e) {
            status = "error";
            errorText = trimTraceback(e && e.message || e);
        }
        netMode = "closed";

        // What changed, relative to the workspace the main thread knows about.
        const after = listing();
        const files = {};
        for (const [p, h] of Object.entries(after)) {
            if (baseline[p] !== h) files[p] = py.FS.readFile("/workspace/" + p);
        }
        baseline = after;
        let output = out.text();
        if (errorText) output += (output && !output.endsWith("\n") ? "\n" : "") + errorText;
        return {
            status, output, notes, netAttempts: netAttempts.slice(), listing: after, files,
            durationMs: Math.round(performance.now() - t0),
        };
    }

    const OPS = { boot, seed, write, remove, imports, load, run };

    self.onmessage = async (e) => {
        const { id, op } = e.data || {};
        const fn = OPS[op];
        if (!fn) { self.postMessage({ id, ok: false, error: "unknown op " + op }); return; }
        try {
            const result = await fn(e.data);
            const transfer = op === "run" ? Object.values(result.files).map(b => b.buffer) : [];
            self.postMessage({ id, ok: true, result }, transfer);
        } catch (err) {
            self.postMessage({ id, ok: false, error: String(err && (err.message || err)) });
        }
    };
}
