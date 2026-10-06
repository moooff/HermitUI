// Phase 3.5: the bundled pure-Python libraries — the manifest build.py inlines, which of
// them a step needs (planBundledLoad), and what the model is told.
//   node tests/bundled.test.mjs
import X from "./extract.mjs";
import { check, section, report } from "./check.mjs";

const LIBS = X.BUNDLED_LIBRARIES;

section("1. The manifest (BUNDLED_LIBRARIES)");
{
    const picked = ["openpyxl", "XlsxWriter", "python-docx", "python-pptx", "Markdown", "qrcode", "tabulate", "xmltodict", "markdownify", "seaborn"];
    check("Tier 1 and Tier 2 are bundled, nothing else", JSON.stringify(Object.keys(LIBS).sort()) === JSON.stringify([...picked].sort()), Object.keys(LIBS));
    const bad = [];
    for (const [name, lib] of Object.entries(LIBS)) {
        if (!Array.isArray(lib.imports) || !lib.imports.length || !lib.imports.every(i => /^[A-Za-z_]\w*$/.test(i))) bad.push(name + ": imports");
        for (const k of ["uses", "requires", "pyodide"]) if (!Array.isArray(lib[k])) bad.push(name + ": " + k);
        for (const r of lib.requires || []) if (!LIBS[r]) bad.push(name + ": requires unknown " + r);
        if (!Array.isArray(lib.wheels) || !lib.wheels.length) bad.push(name + ": wheels");
        for (const w of lib.wheels || []) {
            if (!/-none-any\.whl$/.test(w.file)) bad.push(w.file + ": not a pure wheel");
            if (!/^[0-9a-f]{64}$/.test(w.sha256)) bad.push(w.file + ": sha256");
            if (!w.url.startsWith("https://files.pythonhosted.org/") || !w.url.endsWith("/" + w.file)) bad.push(w.file + ": url");
        }
    }
    check("every library has import names, lists, and pinned pure wheels from PyPI", !bad.length, bad.join("; "));
    const idx = X.bundledImportIndex(LIBS);
    check("import names map to libraries (docx → python-docx, pptx → python-pptx, et_xmlfile → openpyxl)",
        idx.get("docx") === "python-docx" && idx.get("pptx") === "python-pptx" && idx.get("et_xmlfile") === "openpyxl" && idx.get("xlsxwriter") === "XlsxWriter" && idx.get("markdown") === "Markdown");
    check("garbage gives an empty index", X.bundledImportIndex(null).size === 0 && X.bundledImportIndex({ x: {} }).size === 0);
}

section("2. planBundledLoad — what a step needs");
{
    const plan = (imports, code, loaded) => X.planBundledLoad(imports, [code || ""], LIBS, loaded || []);
    const j = (v) => JSON.stringify(v);
    let p = plan(["docx"]);
    check("import docx → python-docx, with lxml and typing-extensions", j(p.bundles) === j(["python-docx"]) && j(p.pyodide) === j(["lxml", "typing-extensions"]), j(p));
    p = plan(["pptx"]);
    check("import pptx → XlsxWriter first (python-pptx's charts need it), then python-pptx; Pillow too",
        j(p.bundles) === j(["XlsxWriter", "python-pptx"]) && p.pyodide.includes("pillow") && p.pyodide.includes("lxml"), j(p));
    p = plan(["pptx"], "", ["XlsxWriter", "Pillow", "lxml"]);
    check("what is loaded already is skipped (Pillow matches pillow)", j(p.bundles) === j(["python-pptx"]) && j(p.pyodide) === j(["typing-extensions"]), j(p));
    check("an installed library isn't installed again", plan(["docx"], "", ["python-docx"]).bundles.length === 0);
    check("stdlib and Pyodide imports need nothing from the bundle", j(plan(["os", "numpy", "pandas"])) === j({ bundles: [], pyodide: [] }));
    p = plan(["pandas"], 'import pandas as pd\npd.DataFrame({"a": [1]}).to_excel("a.xlsx")');
    check("pandas to_excel without an Excel import → openpyxl (pandas imports it itself)", j(p.bundles) === j(["openpyxl"]), j(p));
    p = plan(["pandas"], 'df = pd.read_excel("a.xlsx")\nwith pd.ExcelWriter("b.xlsx", engine="xlsxwriter") as w: pass');
    check("…and engine=\"xlsxwriter\" → XlsxWriter too", p.bundles.includes("openpyxl") && p.bundles.includes("XlsxWriter"), j(p));
    check("df.to_markdown() → tabulate", j(plan(["pandas"], "print(df.to_markdown())").bundles) === j(["tabulate"]));
    check("a word inside a longer name is no use of it", plan([], "my_to_excel_helper = 1\nread_excelsior()").bundles.length === 0);
    p = plan(["seaborn", "pandas"], "", ["numpy", "pandas"]);
    check("seaborn loads matplotlib with it, not what is loaded or loading", j(p.bundles) === j(["seaborn"]) && j(p.pyodide) === j(["matplotlib"]), j(p));
    check("markdownify brings beautifulsoup4 and six", j(plan(["markdownify"]).pyodide) === j(["beautifulsoup4", "six"]));
    check("each library once, however many of its imports appear", j(plan(["openpyxl", "et_xmlfile"], "x.to_excel('a')").bundles) === j(["openpyxl"]));
    check("garbage input gives an empty plan", j(X.planBundledLoad(null, null, null, null)) === j({ bundles: [], pyodide: [] }));
    check("package names compare normalized", X.normalizePackageName("Typing_Extensions") === "typing-extensions" && X.normalizePackageName("python.docx") === "python-docx");
}

section("3. Notes and hints");
{
    check("a load note names both sources",
        X.packageLoadNote({ loaded: ["lxml"], installed: ["python-docx"], ms: 1234 }) === "Loaded lxml from the Pyodide CDN and python-docx from the libraries bundled with HermitUI Agent (1.2 s).");
    check("…or just the CDN, worded as before", X.packageLoadNote({ loaded: ["six"], installed: [], ms: 500 }) === "Loaded six from the Pyodide CDN (0.5 s).");
    check("…and nothing when nothing loaded", X.packageLoadNote({ loaded: [], installed: [] }) === "" && X.packageLoadNote(null) === "");
    const bundled = [...X.bundledImportIndex(LIBS).keys()];
    const h = X.moduleNotFoundHint("ModuleNotFoundError: No module named 'docx'", ["docx", "numpy"], bundled);
    check("a bundled library imported where the harness couldn't see it: import it in the step", /docx is available but wasn't loaded/.test(h) && /Add "import docx"/.test(h), h);
    const opt = X.moduleNotFoundHint("ImportError: Missing optional dependency 'openpyxl'.  Use pip or conda to install openpyxl.", ["openpyxl"], bundled);
    check("pandas' missing optional dependency, when bundled: import it", /openpyxl is available but wasn't loaded/.test(opt), opt);
    const odf = X.moduleNotFoundHint("ImportError: Missing optional dependency 'odfpy'.  Use pip or conda to install odfpy.", ["numpy"], bundled);
    check("…and when it isn't: it can't be installed", /odfpy isn't part of the Pyodide distribution/.test(odf), odf);
    check("the old two-argument call still works", X.moduleNotFoundHint("ModuleNotFoundError: No module named 'numpy.foo'", ["numpy"]) === "");
}

section("4. The system prompt names the bundled libraries for their formats");
{
    for (const pr of ["text", "tools"]) {
        const s = X.buildSystemPrompt("", ["numpy", "openpyxl"], pr);
        const want = [/openpyxl or xlsxwriter for Excel \.xlsx/, /pandas read_excel and to_excel/, /python-docx \(import docx\) for Word \.docx/,
            /python-pptx \(import pptx\) for PowerPoint \.pptx/, /pymupdf \(import pymupdf\) to create, read and edit PDFs/, /there is no reportlab or fpdf/,
            /matplotlib or seaborn for charts/, /markdown to turn Markdown into HTML, markdownify for HTML into Markdown/, /tabulate for plain-text tables/,
            /qrcode for QR codes/, /xmltodict/, /Don't assemble these file formats by hand/];
        const missing = want.filter(r => !r.test(s));
        check(`${pr}: each format names its library`, !missing.length, missing.join(" "));
        check(`${pr}: no longer says nothing writes .xlsx/.docx/.pptx`, !/Nothing here writes/.test(s));
    }
}

report();
