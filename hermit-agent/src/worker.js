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
    let installed = [];     // bundled libraries unpacked into site-packages (Phase 3.5)

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
    // matplotlib draws off-screen (DESIGN §8). This backend is Agg whose show() hands every
    // open figure to the harness, which saves it under figures/ for the step card. It
    // lives outside /workspace, so it is neither a workspace file nor re-imported per step.
    const INLINE_BACKEND_PY = `
from matplotlib.backends.backend_agg import FigureCanvasAgg as FigureCanvas  # noqa: F401
import hermit_figures

def show(*args, **kwargs):
    hermit_figures.capture("show")
`;

    const HARNESS_PY = `
import os, sys, hashlib, importlib, json, types
os.makedirs("/workspace", exist_ok=True)
os.chdir("/workspace")
if "/workspace" not in sys.path:
    sys.path.insert(0, "/workspace")
os.makedirs("/hermit", exist_ok=True)
with open("/hermit/hermit_inline.py", "w") as fh:
    fh.write(INLINE_BACKEND_PY)
if "/hermit" not in sys.path:
    sys.path.append("/hermit")
os.environ["MPLBACKEND"] = "module://hermit_inline"

# ---- Figures (DESIGN §8): plt.show(), and figures still open when a step ends, are saved
# as figures/step-N-k.png and closed, like a notebook's inline backend. A figure the agent
# saved itself (savefig) isn't saved twice: its own file is shown instead.
_fig = {"step": 0, "count": 0, "saved": [], "errors": []}

def _fig_has_content(fig):
    return bool(fig.axes or fig.texts or fig.images or fig.lines or fig.patches or fig.artists)

def hermit_capture(reason):
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is None:
        return
    from matplotlib._pylab_helpers import Gcf
    for manager in list(Gcf.get_all_fig_managers()):
        fig = manager.canvas.figure
        try:
            if not getattr(fig, "_hermit_saved", False) and _fig_has_content(fig):
                _fig["count"] += 1
                path = "figures/step-%d-%d.png" % (_fig["step"], _fig["count"])
                os.makedirs("/workspace/figures", exist_ok=True)
                fig.savefig("/workspace/" + path, format="png")
                w, h = fig.canvas.get_width_height()
                _fig["saved"].append({"path": path, "width": int(w), "height": int(h), "how": reason})
        except Exception as e:
            _fig["errors"].append("%s: %s" % (type(e).__name__, str(e)[:300]))
        finally:
            plt.close(fig)

_figmod = types.ModuleType("hermit_figures")
_figmod.capture = hermit_capture
sys.modules["hermit_figures"] = _figmod

def _patch_savefig(module):
    F = getattr(module, "Figure", None)
    if F is None or getattr(F.savefig, "_hermit", False):
        return
    original = F.savefig
    def savefig(self, *args, **kwargs):
        self._hermit_saved = True
        return original(self, *args, **kwargs)
    savefig._hermit = True
    savefig.__doc__ = original.__doc__
    F.savefig = savefig

# Mark figures saved with savefig, from the moment matplotlib.figure is first imported
# (whichever backend the agent picks).
class _HermitFigureHook:
    def find_spec(self, name, path=None, target=None):
        if name != "matplotlib.figure":
            return None
        for finder in sys.meta_path:
            if finder is self or not hasattr(finder, "find_spec"):
                continue
            spec = finder.find_spec(name, path, target)
            if spec is not None:
                break
        else:
            return None
        loader = spec.loader
        original = loader.exec_module
        def exec_module(module):
            original(module)
            _patch_savefig(module)
        loader.exec_module = exec_module
        return spec

sys.meta_path.insert(0, _HermitFigureHook())

def hermit_figures_begin(step):
    _fig.update(step=int(step), count=0, saved=[], errors=[])

def hermit_figures_end():
    hermit_capture("end")
    return json.dumps({"saved": _fig["saved"], "errors": _fig["errors"]})

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

# ---- Bundled libraries (Phase 3.5): a pinned wheel, already checked by the main thread,
# unpacked into site-packages the way pip would (purelib/platlib data folders included,
# scripts and headers left out). It lives in memory, like everything in this interpreter.
def hermit_install_wheel(path):
    import site, zipfile
    sp = site.getsitepackages()[0]
    with zipfile.ZipFile(path) as z:
        for info in z.infolist():
            parts = info.filename.split("/")
            if parts[0].endswith(".data"):
                if len(parts) < 3 or parts[1] not in ("purelib", "platlib"):
                    continue
                parts = parts[2:]
            if info.is_dir() or not parts[-1] or ".." in parts or info.filename.startswith("/"):
                continue
            dest = os.path.join(sp, *parts)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with z.open(info) as src, open(dest, "wb") as fh:
                fh.write(src.read())
    importlib.invalidate_caches()

# ---- Syntax check (DESIGN §5.1): a .py file written by a file action is compiled, never
# run, so the agent hears about a syntax error in the same step.
def hermit_check_syntax(src, path):
    import warnings
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            compile(src, path, "exec", dont_inherit=True)
        return "null"
    except SyntaxError as e:
        return json.dumps({"line": e.lineno or 0, "col": e.offset or 0, "error": type(e).__name__ + ": " + str(e.msg), "text": (e.text or "").rstrip()[:200]})
    except (ValueError, TypeError) as e:
        return json.dumps({"line": 0, "col": 0, "error": type(e).__name__ + ": " + str(e), "text": ""})

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
        harness.set("INLINE_BACKEND_PY", INLINE_BACKEND_PY);
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
            // Folders the file leaves empty go too, as in the main thread's workspace.
            const segs = String(p).split("/");
            for (let i = segs.length - 1; i > 0; i--) {
                try { py.FS.rmdir("/workspace/" + segs.slice(0, i).join("/")); } catch (e) { break; }
            }
        }
        baseline = listing();
        return { count: paths.length };
    }

    // Compile (never run) each source; see hermit_check_syntax.
    function check({ sources }) {
        const results = {};
        for (const [path, src] of Object.entries(sources || {})) {
            results[path] = JSON.parse(harness.get("hermit_check_syntax")(String(src), String(path)));
        }
        return { results };
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
        return { imports: names.map(String), loaded: [...Object.keys(py.loadedPackages), ...installed] };
    }

    // Packages the code imports, loaded by the harness (never by agent code) from the
    // pinned CDN, in memory only (DESIGN §8). Pyodide doesn't throw when a package fails:
    // it reports "Loaded …" / "Failed to load …" and the reasons through the callbacks.
    // packages: Pyodide packages by name (what bundled libraries import); wheels: the
    // bundled libraries to install, [{ name, files: [{ file, bytes }] }], after those.
    async function load({ code, packages, wheels }) {
        const t0 = performance.now();
        const loaded = [], failed = [], errors = [], done = [];
        netAttempts = [];
        const names = (m, prefix) => m.slice(prefix.length).split(",").map(s => s.trim()).filter(Boolean);
        const options = {
            messageCallback: (m) => {
                if (/^Loaded /.test(m)) loaded.push(...names(m, "Loaded "));
                else if (/^Failed to load /.test(m)) failed.push(...names(m, "Failed to load "));
            },
            errorCallback: (m) => { if (errors.length < 20) errors.push(String(m).slice(0, 500)); },
        };
        netMode = "cdn";
        try {
            if (code) await py.loadPackagesFromImports(code, options);
            if (Array.isArray(packages) && packages.length) await py.loadPackage(packages.map(String), options);
        } catch (e) {
            errors.push(String(e && e.message || e).split("\n")[0].slice(0, 500));
            if (!failed.length) failed.push("(packages)");
        } finally {
            netMode = "closed";
        }
        // No network needed: the bytes came with the request. Not after a failed package:
        // a library counted as installed would never get its packages loaded again.
        for (const lib of !failed.length && Array.isArray(wheels) ? wheels : []) {
            const name = String(lib && lib.name);
            if (installed.includes(name)) continue;
            try {
                py.FS.mkdirTree("/hermit/wheels");
                for (const f of lib.files) {
                    const path = "/hermit/wheels/" + String(f.file).replace(/[^\w.+-]/g, "_");
                    py.FS.writeFile(path, f.bytes);
                    try { harness.get("hermit_install_wheel")(path); } finally { py.FS.unlink(path); }
                }
                installed.push(name);
                done.push(name);
            } catch (e) {
                failed.push(name);
                errors.push((name + ": " + String(e && e.message || e).split("\n").filter(Boolean).pop()).slice(0, 500));
            }
        }
        return { loaded, installed: done, failed, errors, netAttempts: netAttempts.slice(), ms: Math.round(performance.now() - t0) };
    }

    async function run({ code, allowNetwork, step }) {
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
        harness.get("hermit_figures_begin")(Number.isInteger(step) ? step : 0);
        try {
            harness.get("hermit_forget_workspace_modules")();
            await py.runPythonAsync(code, { globals: ns, filename: "<step>" });
        } catch (e) {
            status = "error";
            errorText = trimTraceback(e && e.message || e);
        }
        netMode = "closed";
        // Figures still open are saved too (a failed step's included), then closed.
        let figures = [];
        try {
            const f = JSON.parse(harness.get("hermit_figures_end")());
            figures = f.saved;
            for (const err of f.errors) notes.push("A figure couldn't be saved: " + err);
        } catch (e) {
            notes.push("Figures couldn't be captured: " + String(e && e.message || e).split("\n").pop().slice(0, 300));
        }

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
            status, output, notes, netAttempts: netAttempts.slice(), listing: after, files, figures,
            durationMs: Math.round(performance.now() - t0),
        };
    }

    const OPS = { boot, seed, write, remove, imports, load, run, check };

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
