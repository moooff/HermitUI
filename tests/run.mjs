// Runs every node-only test file and reports an aggregate result:
//   node tests/run.mjs
// The Playwright end-to-end test (e2e_export_import.py) is deliberately not included —
// it needs a build and a virtualenv. Run it separately; see tests/README.md.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here).filter(f => f.endsWith(".test.mjs")).sort();

let failed = [];
for (const f of files) {
    console.log(`\n──────── ${f} ────────`);
    const r = spawnSync(process.execPath, [join(here, f)], { stdio: "inherit" });
    if (r.status !== 0) failed.push(f);
}

console.log(`\n${files.length - failed.length}/${files.length} test files passed`);
if (failed.length) {
    console.log("failed: " + failed.join(", "));
    process.exit(1);
}
