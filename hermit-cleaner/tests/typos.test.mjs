// addTypos, makeTypo, keyNeighbors, shiftMarks.
import m from "./extract.mjs";
import { check, section, report } from "./check.mjs";

const { addTypos, makeTypo, keyNeighbors, shiftMarks, mulberry32, KEEP_RE, TYPO_WEIGHTS, TYPO_NAMES } = m;

const prose = ("The quick brown foxes jumped over several lazy sleeping dogs before running across "
    + "the meadow toward distant hills where nobody would ever think about looking for them. ").repeat(60);

section("keyNeighbors");
{
    const g = keyNeighbors("g", "qwertz");
    check("g on QWERTZ: f h t z v b", ["f", "h", "t", "z", "v", "b"].every(k => g.includes(k)) && g.length === 6, g.join(""));
    check("z differs between layouts", keyNeighbors("t", "qwertz").includes("z") && keyNeighbors("t", "qwerty").includes("y"));
    check("umlauts on QWERTZ", keyNeighbors("l", "qwertz").includes("\u00f6") && keyNeighbors("\u00e4", "qwertz").includes("\u00f6"));
    check("upper case input", keyNeighbors("G", "qwertz").includes("f"));
    check("unknown key", keyNeighbors("7", "qwertz").length === 0);
}

section("makeTypo");
{
    const rng = mulberry32(1);
    for (const kind of ["neighbor", "swap", "drop", "double"]) {
        const t = makeTypo("keyboard", kind, "qwertz", rng, false);
        check(`${kind} changes the word`, t && t !== "keyboard", t);
        check(`${kind} keeps the first letter`, t && t[0] === "k", t);
    }
    check("drop is one shorter", makeTypo("keyboard", "drop", "qwertz", rng, false).length === 7);
    check("double is one longer", makeTypo("keyboard", "double", "qwertz", rng, false).length === 9);
    check("case only at a sentence start", makeTypo("Sentence", "case", "qwertz", rng, true) === "sentence" && makeTypo("Sentence", "case", "qwertz", rng, false) === null);
    check("neighbor keeps upper case", /^[A-Z]+$/.test(makeTypo("WORDS", "neighbor", "qwertz", rng, false)));
}

section("addTypos: deterministic and bounded");
{
    const a = addTypos(prose, { rate: 0.05 }, mulberry32(42));
    const b = addTypos(prose, { rate: 0.05 }, mulberry32(42));
    const c = addTypos(prose, { rate: 0.05 }, mulberry32(43));
    check("same seed, same output", a.text === b.text);
    check("another seed, another output", a.text !== c.text);
    check("rate 0 changes nothing", addTypos(prose, { rate: 0 }, mulberry32(1)).text === prose);
    const words = prose.match(/\p{L}+/gu).length;
    const hi = addTypos(prose, { rate: 1, minGap: 0 }, mulberry32(7));
    check("rate 1 without a gap hits most long words", hi.marks.length > words * 0.5, `${hi.marks.length} of ${words}`);
    const gap = addTypos(prose, { rate: 1, minGap: 12 }, mulberry32(7));
    check("minGap spaces typos out", gap.marks.length <= Math.ceil(words / 12) + 1, `${gap.marks.length} of ${words}`);
    const low = addTypos(prose, { rate: 0.02, minGap: 0 }, mulberry32(9));
    const eligible = prose.match(/\p{L}{4,}/gu).filter(w => w[0] === w[0].toLowerCase()).length;
    check("about the asked rate", low.marks.length > eligible * 0.005 && low.marks.length < eligible * 0.05, `${low.marks.length} of ~${eligible}`);
}

section("addTypos: marks and edits");
{
    const r = addTypos(prose, { rate: 0.05 }, mulberry32(5));
    check("some typos made", r.marks.length > 3);
    check("each mark covers its typo in the output", r.marks.every(mk => r.text.slice(mk.start, mk.end) !== mk.labels[0] && mk.end > mk.start));
    // Undo the edits from the marks: the input comes back.
    let undone = "", lastEnd = 0;
    for (const mk of r.marks) { undone += r.text.slice(lastEnd, mk.start) + mk.labels[0]; lastEnd = mk.end; }
    undone += r.text.slice(lastEnd);
    check("nothing changed outside the marks", undone === prose);
    check("edits match marks", r.edits.length === r.marks.length && r.edits.every((e, i) => e.removed === r.marks[i].labels[0].length && e.inserted === r.marks[i].end - r.marks[i].start));
    const de = "Die Gr\u00f6\u00dfe der K\u00e4ufer \u00e4ndert \u00fcberhaupt nichts an dieser Geschichte. ".repeat(40);
    const g = addTypos(de, { rate: 0.5, minGap: 0 }, mulberry32(3));
    check("German text stays in the kept set", Array.from(g.text).every(ch => KEEP_RE.test(ch)));
}

section("addTypos: never touches");
{
    const text = [
        "Visit https://example.com/some/longer/path and www.another-example.org today.",
        "Mail someone.important@example.com about it.",
        "Use `inlinecode` and run:",
        "```",
        "function somethinglong() { return valuevalue; }",
        "```",
        "Numbers like abc123def and version2 stay; NASA and UNESCO stay.",
        "Then Berlin and Microsoft are names inside a sentence.",
        "Filenames like readme.markdown stay too, and snake_case_words.",
    ].join("\n");
    let touched = new Set();
    for (let seed = 1; seed <= 200; seed++) {
        const r = addTypos(text, { rate: 1, minGap: 0 }, mulberry32(seed));
        r.marks.forEach(mk => touched.add(mk.labels[0]));
    }
    const forbidden = ["https", "example", "path", "another", "someone", "important", "inlinecode", "function",
        "somethinglong", "return", "valuevalue", "abc", "def", "version", "NASA", "UNESCO", "Berlin", "Microsoft",
        "readme", "markdown", "snake", "case", "words"];
    const hit = forbidden.filter(w => touched.has(w));
    check("protected words never get a typo", hit.length === 0, hit.join(", "));
    check("but ordinary words do", touched.has("Visit") || touched.has("today") || touched.has("about") || touched.has("Numbers"), [...touched].join(", "));
    let shortOk = true;
    for (let seed = 1; seed <= 100; seed++) {
        const r = addTypos(text, { rate: 1, minGap: 0 }, mulberry32(seed));
        for (const mk of r.marks) {
            const was = mk.labels[0], now = r.text.slice(mk.start, mk.end);
            if (/^\p{L}{1,3}$/u.test(was) && !(now === was + " " + was || mk.typo === "case" || mk.typo === "shift")) shortOk = false;
        }
    }
    check("short words keep their letters", shortOk);
}

section("More slips, all languages");
{
    const rng = mulberry32(3);
    check("shift held too long", makeTypo("Diese", "shift", "qwertz", rng, true) === "DIese");
    check("shift needs a capital", makeTypo("diese", "shift", "qwertz", rng, false) === null);
    const words = "we went to the market and then we walked home along the river in the evening light".repeat(1);
    const text = (words + ". ").repeat(40);
    const kinds = new Set(), samples = {};
    for (let seed = 1; seed <= 60; seed++) {
        const r = addTypos(text, { rate: 0.3, minGap: 0, lang: "en" }, mulberry32(seed));
        r.marks.forEach(mk => { kinds.add(mk.typo); samples[mk.typo] = [mk.labels[0], r.text.slice(mk.start, mk.end)]; });
    }
    check("a repeated word appears", kinds.has("repeat") && samples.repeat[1] === samples.repeat[0] + " " + samples.repeat[0], JSON.stringify(samples.repeat));
    check("a missing space appears", kinds.has("space") && samples.space[1] === samples.space[0].replace(" ", ""), JSON.stringify(samples.space));
    const german = ["nounCase", "ending", "nTail", "dass", "comma", "eszett"];
    check("no German kinds in English text", !german.some(k => kinds.has(k)), [...kinds].join(", "));
    check("every kind has a name", Object.values(TYPO_WEIGHTS).every(w => Object.keys(w).every(k => TYPO_NAMES[k])));
}

section("German slips");
{
    const rng = mulberry32(5);
    check("noun in lower case", makeTypo("Regierung", "nounCase", "qwertz", rng, false) === "regierung");
    check("not at a sentence start", makeTypo("Regierung", "nounCase", "qwertz", rng, true) === null);
    check("einem -> einen", makeTypo("einem", "ending", "qwertz", rng, false) === "einen");
    check("den -> dem", makeTypo("den", "ending", "qwertz", rng, false) === "dem");
    check("diesen -> diesem", makeTypo("diesen", "ending", "qwertz", rng, false) === "diesem");
    check("ending only on articles and pronouns", makeTypo("Atem", "ending", "qwertz", rng, false) === null);
    check("an n too many: habe -> haben", makeTypo("habe", "nTail", "qwertz", rng, false) === "haben");
    check("an n missing: keinen -> keine", makeTypo("keinen", "nTail", "qwertz", rng, false) === "keine");
    check("dass -> das", makeTypo("dass", "dass", "qwertz", rng, false) === "das");
    check("Das -> Dass", makeTypo("Das", "dass", "qwertz", rng, true) === "Dass");
    check("\u00df -> ss", makeTypo("Stra\u00dfe", "eszett", "qwertz", rng, false) === "Strasse");

    const de = ("Ich habe gestern mit einem Freund gesprochen, weil ich wissen wollte, dass die Stra\u00dfe "
        + "wieder offen ist. Er sagte, dass er keinen Bescheid bekommen hat, aber den Weg kennt. ").repeat(30);
    const kinds = new Set(), samples = {};
    for (let seed = 1; seed <= 150; seed++) {
        const r = addTypos(de, { rate: 0.4, minGap: 0, lang: "de" }, mulberry32(seed));
        r.marks.forEach(mk => { kinds.add(mk.typo); (samples[mk.typo] = samples[mk.typo] || []).push([mk.labels[0], r.text.slice(mk.start, mk.end)]); });
    }
    for (const k of ["nounCase", "ending", "nTail", "dass", "comma", "eszett", "shift", "repeat", "space", "neighbor"]) {
        check(`German text gets "${TYPO_NAMES[k]}"`, kinds.has(k), [...kinds].join(", "));
    }
    check("missing comma: \", dass\" -> \" dass\"", (samples.comma || []).every(([was, now]) => /^, \p{L}+$/u.test(was) && now === was.slice(1)), JSON.stringify((samples.comma || []).slice(0, 3)));
    check("das/dass only on das and dass", (samples.dass || []).every(([was]) => /^das{1,2}$/i.test(was)));
    check("-em/-en only swaps the last letter", (samples.ending || []).every(([was, now]) => was.slice(0, -1) === now.slice(0, -1) && /[mn]$/.test(now)));
}

section("shiftMarks");
{
    const marks = [
        { start: 2, end: 4, kind: "clean" },     // before the edit
        { start: 12, end: 14, kind: "clean" },   // after it
        { start: 6, end: 6, kind: "removed" },   // inside it, zero-width
        { start: 6, end: 7, kind: "clean" },     // inside it
    ];
    const edits = [{ at: 5, removed: 4, inserted: 5 }];
    const s = shiftMarks(marks, edits);
    check("before: unchanged", s[0].start === 2 && s[0].end === 4);
    check("after: shifted by the length change", s[1].start === 13 && s[1].end === 15);
    check("inside, zero-width: snaps to the word start", s[2].start === 5 && s[2].end === 5);
    check("inside: covers the new word", s[3].start === 5 && s[3].end === 10);
    const real = addTypos(prose, { rate: 0.05 }, mulberry32(11));
    const all = prose.split("").map((_, i) => ({ start: i, end: i + 1, kind: "clean" })).filter(mk => /[.,]/.test(prose[mk.start]));
    const moved = shiftMarks(all, real.edits);
    check("punctuation marks still point at punctuation", moved.every(mk => /[.,]/.test(real.text[mk.start])));
}

report();
