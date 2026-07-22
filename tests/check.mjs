// Minimal assertion helper shared by the unit test files. Deliberately not a test
// framework: no dependencies, no install step, no watch mode — just a pass/fail
// counter and a non-zero exit code, which is all CI (and a human) needs here.
let pass = 0, fail = 0;

export function check(name, cond, detail) {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else {
        fail++;
        console.log("  FAIL  " + name + (detail ? "\n        " + String(detail).replace(/\n/g, "\n        ") : ""));
    }
}

export function section(title) {
    console.log("\n=== " + title + " ===");
}

// Assert that fn() throws; `detail` is the message fragment expected, if any.
export function checkThrows(name, fn, fragment) {
    try {
        const got = fn();
        check(name, false, "did not throw, returned " + JSON.stringify(got));
    } catch (e) {
        check(name, !fragment || String(e.message).includes(fragment), e.message);
    }
}

// Print the tally and exit non-zero on any failure. Call once at the end of a file.
export function report() {
    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(fail === 0 ? 0 : 1);
}
