// Stock phrases: finding them in each language, leaving ordinary words alone, naming
// them in the prompt, picking their sentences first, and not holding their removal
// against the model.
import m from "./extract.mjs";
import { check, section, report } from "./check.mjs";

const { STOCK_PATTERNS, stockPhraseRe, findStockPhrases, countStockPhrases, cutStockPhrases, isStockOnly, deletionRange, buildRewriteMessages,
    pickUnits, mulberry32, acceptRewrite, wordDiff, applyRewrites, findContrasts, retryNote, addressForms } = m;

const found = (text, lang) => findStockPhrases(text, lang).map(([s, e]) => text.slice(s, e));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

section("The pattern table");
{
    const langs = Object.keys(STOCK_PATTERNS);
    check("a list for every language the app detects", same(langs.sort(), ["de", "en", "es", "fr", "it", "nl", "pt"]), langs);
    let bad = [];
    for (const [lang, list] of Object.entries(STOCK_PATTERNS)) {
        for (const p of list) {
            try {
                const re = new RegExp("(?:" + p + ")", "iu");
                if (re.test("")) bad.push(`${lang}: matches nothing at all: ${p}`);
            } catch (e) { bad.push(`${lang}: ${e.message}`); }
            // An optional last part that ends with a space can never match: a phrase ends
            // at a word boundary.
            if (/ \)[?*]$/.test(p)) bad.push(`${lang}: optional last part ends with a space: ${p}`);
        }
    }
    check("every pattern compiles, and none matches an empty string", bad.length === 0, bad.join("\n"));
    check("the whole pattern compiles per language and for an unknown one", [...langs, null, "xx"].every(l => stockPhraseRe(l) instanceof RegExp));
    const t0 = Date.now();
    const long = "Moreover, the tool works well and it is a good thing for the team. ".repeat(2000);
    check("fast on a long text", findStockPhrases(long, "en").length === 2000 && Date.now() - t0 < 2000, Date.now() - t0);
}

section("English");
{
    check("transitions and signposting", same(found("Moreover, it is important to note that prices rose. Furthermore, we delve deeper into it.", "en"),
        ["Moreover", "it is important to note that", "Furthermore", "delve deeper into"]));
    check("case and curly apostrophes don't matter", same(found("IT\u2019S WORTH NOTING THAT it works.", "en"), ["IT\u2019S WORTH NOTING THAT"]));
    check("hype and vocabulary", same(found("We leverage AI to unlock the full potential of a seamless, cutting-edge platform.", "en"),
        ["leverage", "unlock the full potential", "seamless", "cutting-edge"]));
    check("framing current models overuse", same(found("It's not just a tool. The tool is not simply a gadget. This matters because time counts.", "en"),
        ["It's not just", "is not simply", "This matters"]));
    check("set-up contrasts, both halves", same(found("Training is not just a cost - it saves money. It didn't just feed us; it taught us. "
        + "The weak spot is not a piece of code, but a person.", "en"), ["not just a cost - it", "didn't just feed us; it", "not a piece of code, but"]));
    check("essay and e-mail cliches", same(found("This experience taught me that quiet resilience matters. Your input matters here, so we can get our momentum back and meet our high standards.", "en"),
        ["This experience taught me that", "quiet resilience", "Your input matters", "get our momentum back", "meet our high standards"]));
    check("business hype", same(found("It builds a culture of vigilance, a first line of defense and peace of mind.", "en"),
        ["culture of vigilance", "first line of defense", "peace of mind"]));
    check("inflated significance and trailing -ing", same(found("It plays a crucial role in shaping the market, ensuring growth.", "en"),
        ["plays a crucial role", "ensuring"]));
    check("letters and chat replies", same(found("I hope this email finds you well. Please do not hesitate to call. Certainly! I hope this helps.", "en"),
        ["I hope this email finds you well", "Please do not hesitate to", "Certainly", "I hope this helps"]));
    check("whole words only", found("The crucially placed delver showcased nothing.", "en").join() === "showcased");
    const plain = "She works in foster care. Yours truly, Tom. It is simply wrong. He spoke quietly. The landscape painting was nice. "
        + "In addition to costs, time counts. However, the results were mixed. The room serves as an office.";
    check("ordinary uses are left alone", found(plain, "en").length === 0, found(plain, "en").join(" | "));
}

section("Other languages");
{
    check("German, both word orders", same(found("Dar\u00fcber hinaus ist es wichtig zu beachten, dass es klappt. Es ist wichtig zu beachten, dass es geht.", "de"),
        ["Dar\u00fcber hinaus", "ist es wichtig zu beachten", "Es ist wichtig zu beachten"]));
    check("German vocabulary and frames", same(found("Die L\u00f6sung l\u00e4sst sich nahtlos integrieren und spielt eine entscheidende Rolle. Es geht nicht nur um Zeit.", "de"),
        ["nahtlos", "eine entscheidende Rolle", "Es geht nicht nur um"]));
    check("German business hype", same(found("Weiterbildung ist ein strategischer Hebel und der Schl\u00fcssel zur Wettbewerbsf\u00e4higkeit einer resilienten Organisation. Letztlich z\u00e4hlt das. Die gr\u00f6\u00dfte Lektion meines ersten Jahres? Zuh\u00f6ren.", "de"),
        ["strategischer Hebel", "der Schl\u00fcssel zur Wettbewerbsf\u00e4higkeit", "resilienten Organisation", "Letztlich", "Die gr\u00f6\u00dfte Lektion meines ersten Jahres?"]));
    check("German set-up contrasts", same(findContrasts("F\u00fchrung ist f\u00fcr mich kein Titel, sondern ein Dienst. Es ist nicht nur ein Kostenfaktor, sondern ein Hebel. "
        + "Es dreht sich nicht allein darum, Programme zu lernen. Sondern es ver\u00e4ndert die Kultur.", "de"),
        ["kein Titel, sondern", "nicht nur ein Kostenfaktor, sondern", "nicht allein darum, Programme zu lernen. Sondern"]));
    check("...but a plain correction is ordinary German", findContrasts("Das Treffen ist nicht am Montag, sondern am Dienstag. Kein Problem.", "de").length === 0);
    check("the contrast rule is in the passage's language only", /sondern/.test(buildRewriteMessages("Es ist kein Sprint.", "de", null, { level: "strong" })[0].content)
        && !/sondern/.test(buildRewriteMessages("It is a race.", "en", null, { level: "strong" })[0].content)
        && !/set-up contrast/.test(buildRewriteMessages("It is a race.", "en", null, { level: "light" })[0].content));
    check("German letters", same(found("Z\u00f6gern Sie nicht, mich anzurufen. Ich hoffe, diese Informationen helfen dir weiter!", "de"),
        ["Z\u00f6gern Sie nicht", "Ich hoffe, diese Informationen helfen"]));
    check("French", same(found("Par ailleurs, il convient de noter que le projet joue un r\u00f4le cl\u00e9. De plus en plus de gens.", "fr"),
        ["Par ailleurs", "il convient de noter", "joue un r\u00f4le cl\u00e9"]));
    check("Spanish", same(found("Adem\u00e1s, cabe destacar que juega un papel crucial. Adem\u00e1s de eso, nada.", "es"),
        ["Adem\u00e1s", "cabe destacar", "juega un papel crucial"]));
    check("Italian", same(found("Inoltre, \u00e8 importante sottolineare che gioca un ruolo cruciale.", "it"),
        ["Inoltre", "\u00e8 importante sottolineare", "gioca un ruolo cruciale"]));
    check("Dutch", same(found("Bovendien is het belangrijk om op te merken dat dit naadloos werkt.", "nl"),
        ["Bovendien", "is het belangrijk om op te merken", "naadloos"]));
    check("Portuguese", same(found("Al\u00e9m disso, vale ressaltar que desempenha um papel crucial.", "pt"),
        ["Al\u00e9m disso", "vale ressaltar", "desempenha um papel crucial"]));
    check("a known language uses only its own list", found("Moreover, dar\u00fcber hinaus.", "de").join() === "dar\u00fcber hinaus");
    check("an unknown language uses all of them", same(found("Moreover, dar\u00fcber hinaus.", null), ["Moreover", "dar\u00fcber hinaus"]));
}

section("countStockPhrases and cutStockPhrases");
{
    const text = "Moreover, it works.\n\n```\nmoreover = 1  # furthermore\n```\n\nDar\u00fcber hinaus ist das Ergebnis gut und die Kosten sind niedrig, wie die Zahlen zeigen.\n";
    check("counted per paragraph in its own language, code blocks skipped", countStockPhrases(text, "en") === 2, countStockPhrases(text, "en"));
    check("none in plain text", countStockPhrases("The cat sat on the mat.", "en") === 0);
    check("phrases cut, spacing tidied", cutStockPhrases("It is important to note that prices rose.", "en") === "prices rose.");
    check("nothing to cut: same words", wordDiff(cutStockPhrases("The cat sat on the mat.", "en"), "The cat sat on the mat.").ratio === 0);
}

section("The prompt names what it finds");
{
    const sys = (passage, lang, context, opts) => buildRewriteMessages(passage, lang, context, opts)[0].content;
    const s = sys("Moreover, it is important to note that the team tested it for 6 weeks.", "en", null, { level: "light" });
    check("the phrases, as written", s.includes("stock phrases that make it sound machine-written: \"Moreover\", \"it is important to note that\".") && /Cut each one/.test(s), s);
    check("no generic examples then", !/delve into/.test(s));
    check("none found: the general line with examples", /Cut or replace stock phrases, filler and hype, such as "moreover"/.test(sys("The team tested it for 6 weeks.", "en")));
    const many = "Moreover, moreover, MOREOVER the team tested " + ["furthermore", "additionally", "in conclusion", "notably", "seamless", "robust", "pivotal", "crucial", "vibrant"].join(" plus ") + " for six weeks.";
    const line = sys(many, "en").split("\n").find(l => /machine-written/.test(l));
    const named = line.split(". Cut each one")[0];
    check("each named once, at most eight", (named.match(/"/g) || []).length === 16 && (named.match(/moreover/gi) || []).length === 1, line);
    const ctx = sys("Prices rose.", "en", "Moreover, it is important to note that sales fell. Prices rose.");
    check("phrases in the context aren't named", !/machine-written/.test(ctx) && /The longer text:/.test(ctx), ctx);
    const de = sys("Dar\u00fcber hinaus ist es wichtig zu beachten, dass das Team es 6 Wochen getestet hat.", "de");
    check("German phrases for German text, nothing English", de.includes("\"Dar\u00fcber hinaus\", \"ist es wichtig zu beachten\"") && !/moreover/i.test(de), de);
    check("the passage itself goes unchanged", buildRewriteMessages("  Moreover, it works.\n", "en").at(-1).content === "Moreover, it works.");
    const mail = sys("I hope this email finds you well. Moreover, the review is on Thursday.", "en", null, { level: "light" });
    check("a sentence that is only stock phrases: to be left out, its phrase not named", mail.includes('Leave these sentences out entirely, they say nothing: "I hope this email finds you well."')
        && mail.includes('machine-written: "Moreover".'), mail);
    check("no such line without one", !/Leave these sentences out/.test(s));
    check("the sentence around a cut stays grammatical", /keep the sentence grammatical/.test(s));
    check("the form of address is kept", /address the reader as the passage does \(formal or informal\)/.test(sys("The team tested it.", "en")));
    const nur = found("Nur so kann gew\u00e4hrleistet werden, dass es klappt.", "de");
    check("German: the stilted passive is named, not the \"Nur so\" that carries meaning", nur.join() === "kann gew\u00e4hrleistet werden", nur.join());
}

section("Sentences that are nothing but stock phrases");
{
    for (const [t, lang] of [["I hope this email finds you well.", "en"], ["Let that sink in.", "en"], ["Certainly!", "en"], ["I hope this helps!", "en"],
        ["Ich hoffe, das hilft!", "de"], ["Gute Frage!", "de"]]) check(`only stock phrases: ${t}`, isStockOnly(t, lang));
    for (const [t, lang] of [["Moreover, the plan failed.", "en"], ["Let that sink in: 9 projects.", "en"], ["The team tested it.", "en"], ["", "en"]])
        check(`not only stock phrases: ${JSON.stringify(t)}`, !isStockOnly(t, lang));
    const del = (text, sentence) => {
        const s = text.indexOf(sentence);
        const [a, b] = deletionRange(text, s, s + sentence.length);
        return text.slice(0, a) + text.slice(b);
    };
    check("mid-line: the spaces after it go too", del("A one. Let that sink in. B two.", "Let that sink in.") === "A one. B two.");
    check("end of a line: the spaces before it", del("A one. Let that sink in.\nB two.", "Let that sink in.") === "A one.\nB two.");
    check("start of a line", del("Let that sink in. A one.\nB two.", "Let that sink in.") === "A one.\nB two.");
    check("a paragraph of its own: no blank line left doubled", del("A one.\n\nI hope this helps!\n\nB two.", "I hope this helps!") === "A one.\n\nB two.");
    check("the last paragraph: the blank line before it goes, the final line break stays", del("A one.\n\nI hope this helps!\n", "I hope this helps!") === "A one.\n");
    check("the first paragraph", del("Great question!\n\nA one.", "Great question!") === "A one.");
    check("a list item: the whole line", del("- A one.\n- Let that sink in.\n- B two.", "Let that sink in.") === "- A one.\n- B two.");
    const out = applyRewrites("A one. Let that sink in. B two.", [], [{ start: 7, end: 25, text: "", removed: "stock phrase \"Let that sink in.\"" }]);
    check("a removal leaves a removed mark, not a reword mark", out.text === "A one. B two." && out.marks.length === 1 && out.marks[0].kind === "removed"
        && out.marks[0].start === 7 && /Let that sink in/.test(out.marks[0].labels[0]), JSON.stringify(out));
}

section("pickUnits: stock phrases first");
{
    const first = new Set([7, 3]);
    let always = true;
    for (let seed = 1; seed <= 50; seed++) {
        const p = pickUnits(10, 0.2, mulberry32(seed), first);
        if (!same(p, [3, 7])) always = false;
    }
    check("the units with stock phrases are taken first", always);
    const p = pickUnits(10, 0.5, mulberry32(9), first);
    check("then the others, at random", p.length === 5 && p.includes(3) && p.includes(7));
    check("without them, the same picks as before", same(pickUnits(20, 0.3, mulberry32(2)), pickUnits(20, 0.3, mulberry32(2), new Set())));
    check("more stock units than the share: a random few of them", pickUnits(10, 0.1, mulberry32(4), new Set([1, 2, 5])).every(i => [1, 2, 5].includes(i)));
}

section("acceptRewrite: cutting stock phrases is the job");
{
    const o = "It is important to note that prices rose.";
    check("a cut stock phrase isn't 'much shorter'", acceptRewrite(o, "Prices rose.", "en", "light").ok);
    check("...nor too much change for a light edit", acceptRewrite("Moreover, it is important to note that the plan failed badly.", "The plan failed badly.", "en", "light").ok);
    const dense = acceptRewrite("Moreover, our innovative platform seamlessly enhances workflows.", "Our new platform makes work smoother.", "en", "light");
    check("hype replaced in a dense sentence: still a light edit", dense.ok && dense.change > 0.5, JSON.stringify(dense));
    const kept = acceptRewrite("Moreover, the committee reviewed the proposal in May and approved it.", "Moreover, members looked over this idea, then voted yes in spring.", "en", "light");
    check("the phrase kept, the rest rewritten: refused at Light", !kept.ok && /more than a light edit/.test(kept.reason), JSON.stringify(kept));
    check("still too short when real content goes", !acceptRewrite("Moreover, prices rose by 5 % in March and by 7 % in April this year.", "Prices rose.", "en", "light").ok);
    check("an original that starts like an introduction may keep it", acceptRewrite("Of course, we tested it for six weeks in the lab.", "Of course, we checked it for six weeks in the lab.", "en", "light").ok);
    check("an added introduction is still refused", !acceptRewrite("We tested it for six weeks in the lab.", "Sure! We checked it for six weeks in the lab.", "en", "light").ok);
    const added = acceptRewrite("I wanted to talk about the Q3 budget review next Thursday.", "Moreover, I wanted to talk about the Q3 budget review next Thursday.", "en", "light");
    check("a reply that brings in a stock phrase is refused, naming it", !added.ok && added.reason === 'the model added stock phrases ("Moreover")', added.reason);
    check("swapping one for another is not more of them", acceptRewrite("It is important to note that prices rose in May.", "Notably, prices rose in May.", "en", "light").ok);
    check("...also when the original starts like one, but differently", !acceptRewrite("Here's the thing: AI is quietly reshaping how small agencies work.",
        "Here is the revised passage: AI is quietly changing how small agencies work.", "en", "strong").ok);
}

section("German form of address");
{
    const forms = t => [...addressForms(t)].sort().join();
    check("du, ihr and Sie told apart", forms("Was war eure Lektion?") === "ihr" && forms("Was hat dich gepr\u00e4gt?") === "du"
        && forms("Melden Sie sich, wenn Ihnen etwas fehlt.") === "Sie", [forms("Was war eure Lektion?"), forms("Was hat dich gepr\u00e4gt?")].join(" / "));
    check("'Sie' at a sentence start may be 'they'", forms("Sie kamen gestern an. Ihr Auto war kaputt.") === "");
    check("a group turned into one reader: refused", !acceptRewrite("Was war eure gr\u00f6\u00dfte Lektion in eurer ersten F\u00fchrungsrolle?",
        "Welche Erfahrung hat dich in deiner ersten F\u00fchrungsrolle am meisten gepr\u00e4gt?", "de", "medium").ok);
    check("...and the second try is told which form to keep", /says "Sie"; keep exactly that form/.test(retryNote(acceptRewrite("Melden Sie sich, wenn Ihnen noch etwas fehlt.", "Melde dich, wenn dir noch etwas fehlt.", "de", "medium"), "x".repeat(30))));
    check("Sie turned into du: refused", /form of address/.test(acceptRewrite("Melden Sie sich, wenn Ihnen noch etwas fehlt.", "Melde dich, wenn dir noch etwas fehlt.", "de", "medium").reason || ""));
    check("same form, other words: accepted", acceptRewrite("Melden Sie sich, wenn Ihnen noch etwas fehlt.", "Sagen Sie Bescheid, falls Ihnen noch etwas fehlt.", "de", "medium").ok);
    check("German service phrases", same(found("Ihr Vertrauen ist uns sehr wichtig, und wir tun alles daf\u00fcr. Es ist mir wichtig, Sie weiterhin als Kunde zu haben.", "de"),
        ["Ihr Vertrauen ist uns sehr wichtig", "wir tun alles daf\u00fcr", "Es ist mir wichtig, Sie weiterhin als Kunde"]));
}

section("Set-up contrasts");
{
    check("found with both halves, whatever the adverb", same(findContrasts("It wasn't only about food; it was dignity. Service is not about charity, but about solidarity.", "en"),
        ["wasn't only about food; it", "not about charity, but"]));
    check("...also split into two sentences", same(findContrasts("Training isn't just a cost. It's survival. It isn't about charity. Instead, it's about solidarity.", "en"),
        ["isn't just a cost. It's", "isn't about charity. Instead, it's"]));
    check("...and without an adverb", same(findContrasts("The weak spot isn't code; it's people. Growth was not the goal, it was a side effect.", "en"),
        ["isn't code; it's", "was not the goal, it was"]));
    check("...'more than just', 'just' after a full stop, and reversed", same(findContrasts("It was more than just food; it was dignity. "
        + "Empathy isn't something you just feel. It is work. Training is needed, not just a cost.", "en"),
        ["more than just food; it was", "isn't something you just feel. It is", "not just"]));
    check("...with any verb in the second half", same(findContrasts("A meal is more than just calories; it offers stability. It went beyond just food. It was dignity.", "en"),
        ["more than just calories; it offers", "beyond just food. It was"]));
    check("...'just' with any verb after the full stop", same(findContrasts("The food bank didn't just feed the community. It helped me grow.", "en"),
        ["didn't just feed the community. It helped"]));
    check("an explanation after a full stop is not a contrast", findContrasts("The shop wasn't open. It was Sunday.", "en").length === 0);
    check("one half alone is not a contrast", findContrasts("It is not just me. It isn't late, and we can still go. It's not about money. It rained. I said so.", "en").length === 0);
    check("no list for the language: none", findContrasts("Ce n'est pas seulement le temps, mais l'argent.", "fr").length === 0);
    const o = "Training is not just an expense; it is an investment in the business.";
    const left = acceptRewrite(o, "Training isn't just a cost - it pays for itself in the business.", "en", "strong");
    check("left in past Light: a soft refusal that keeps the reply", !left.ok && left.soft && left.text && left.contrast === "isn't just a cost - it", JSON.stringify(left));
    check("...and the second try is told which one", /"isn't just a cost - it"/.test(retryNote(left, o)) && /directly/.test(retryNote(left, o)));
    check("at Light it is only the usual count", acceptRewrite("It isn't just a cost; it pays off over time.", "It isn't just a cost; it pays back over time.", "en", "light").ok);
    check("one brought into a plain original: refused outright", !acceptRewrite("Training costs money and it pays off.", "Training isn't just a cost - it pays off.", "en", "strong").soft);
    check("said directly: accepted", acceptRewrite(o, "Training costs money, and it pays for itself.", "en", "strong").ok);
}

report();
