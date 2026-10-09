// Language detection, paragraph splitting and picking, the rewrite request, and the
// checks on the model's reply. Plus the helpers copied from HermitUI.
import m from "./extract.mjs";
import { check, section, report } from "./check.mjs";

const { detectLanguage, splitParagraphs, splitSentences, rewordUnits, groupUnits, applyRewrites, pickUnits, mulberry32, buildRewriteMessages, buildRewriteBody,
    stripThinking, acceptRewrite, addTypos, chatErrorHint, normalizeApiUrl, apiEndpoint } = m;

const EN = "The committee reviewed the proposal and decided that it was not ready for a vote this year.";
const DE = "Der Ausschuss hat den Vorschlag gepr\u00fcft und entschieden, dass er in diesem Jahr nicht zur Abstimmung kommt.";
const FR = "Le comit\u00e9 a examin\u00e9 la proposition et a d\u00e9cid\u00e9 qu'elle n'\u00e9tait pas pr\u00eate pour un vote cette ann\u00e9e.";
const ES = "El comit\u00e9 revis\u00f3 la propuesta y decidi\u00f3 que no estaba lista para una votaci\u00f3n este a\u00f1o, como se esperaba.";
const IT = "Il comitato ha esaminato la proposta e ha deciso che non era pronta per un voto in questo anno, come previsto.";
const NL = "De commissie heeft het voorstel bekeken en besloten dat het dit jaar niet klaar is voor een stemming, maar ook later.";

section("detectLanguage");
{
    check("English", detectLanguage(EN) === "en", detectLanguage(EN));
    check("German", detectLanguage(DE) === "de", detectLanguage(DE));
    check("French", detectLanguage(FR) === "fr", detectLanguage(FR));
    check("Spanish", detectLanguage(ES) === "es", detectLanguage(ES));
    check("Italian", detectLanguage(IT) === "it", detectLanguage(IT));
    check("Dutch", detectLanguage(NL) === "nl", detectLanguage(NL));
    check("too short to tell", detectLanguage("Hallo Welt") === null);
    check("no stopwords: unknown", detectLanguage("Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod") === null);
    check("German after cleanup (quotes plain)", detectLanguage("\"Das ist\" ein Test, und die Ergebnisse sind nicht schlecht, aber auch nicht gut.") === "de");
}

section("splitParagraphs");
{
    const text = "# Heading\n\nFirst paragraph is long enough to be reworded by the model, for sure it is.\nSecond line of it.\n\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n| a | b |\n| 1 | 2 |\n\nshort one\n\nhttps://example.com/a/very/long/url/that/keeps/going/and/going/forever\n\nLast paragraph that is also quite long enough to be reworded by the model.";
    const blocks = splitParagraphs(text);
    check("round-trips exactly", blocks.map(b => b.text).join("") === text);
    check("starts are offsets", blocks.every(b => text.slice(b.start, b.start + b.text.length) === b.text));
    const code = blocks.find(b => b.kind === "code");
    check("fence with a blank line stays one block", code && code.text === "```js\nconst a = 1;\n\nconst b = 2;\n```\n", JSON.stringify(code));
    const rw = blocks.filter(b => b.rewrite).map(b => b.text.trim().slice(0, 10));
    check("only the two prose paragraphs are rewritable", rw.length === 2 && rw[0] === "First para" && rw[1] === "Last parag", JSON.stringify(rw));
    check("unclosed fence runs to the end", splitParagraphs("text\n```\ncode\n\nmore").filter(b => b.kind === "code").length === 1);
    check("empty input", splitParagraphs("").length === 0);
}

section("pickUnits");
{
    check("none when share is 0", pickUnits(10, 0, mulberry32(1)).length === 0);
    check("at least one", pickUnits(10, 0.01, mulberry32(1)).length === 1);
    check("60% of 10", pickUnits(10, 0.6, mulberry32(1)).length === 6);
    const all = pickUnits(5, 1, mulberry32(1));
    check("all, sorted", JSON.stringify(all) === "[0,1,2,3,4]");
    const p = pickUnits(20, 0.3, mulberry32(2));
    check("distinct and in range", new Set(p).size === p.length && p.every(i => i >= 0 && i < 20));
}

section("splitSentences");
{
    const parts = s => splitSentences(s).map(([a, b]) => s.slice(a, b));
    const same = (s, want) => JSON.stringify(parts(s)) === JSON.stringify(want);
    check("three sentences", same("One thing is clear. Two things are not! Are three? Yes.", ["One thing is clear.", "Two things are not!", "Are three?", "Yes."]), JSON.stringify(parts("One thing is clear. Two things are not! Are three? Yes.")));
    check("ranges point into the paragraph", JSON.stringify(splitSentences("  A first one here. B second.\n")) === "[[2,19],[20,29]]");
    check("German abbreviations and ordinals", same("Das gilt z. B. f\u00fcr Dr. M\u00fcller ab dem 3. Mai. Danach nicht mehr.", ["Das gilt z. B. f\u00fcr Dr. M\u00fcller ab dem 3. Mai.", "Danach nicht mehr."]), JSON.stringify(parts("Das gilt z. B. f\u00fcr Dr. M\u00fcller ab dem 3. Mai. Danach nicht mehr.")));
    check("English abbreviations", same("Bring tools, e.g. a saw etc. and so on. Mr. Smith comes too.", ["Bring tools, e.g. a saw etc. and so on.", "Mr. Smith comes too."]), JSON.stringify(parts("Bring tools, e.g. a saw etc. and so on. Mr. Smith comes too.")));
    check("z.B. without spaces", parts("Zum Beispiel z.B. Obst. Und Gem\u00fcse.").length === 2);
    check("a full stop before lower case is no end", parts("He uses v. 2 of it. Then stops.").length === 2 && parts("The file.txt is here and it works.").length === 1);
    check("a year ends a sentence", parts("It started in 2024. Then it grew.").length === 2);
    check("quote after the stop stays with the sentence", same("He said \"stop.\" Then he left.", ["He said \"stop.\"", "Then he left."]));
    check("ellipsis", parts("Well... Maybe later.").length === 2);
    check("a line break ends a sentence", same("First line without stop\nsecond line here.", ["First line without stop", "second line here."]));
    check("list markers left out", same("- First item here.\n- Second item. With two.\n1. Numbered one.", ["First item here.", "Second item.", "With two.", "Numbered one."]), JSON.stringify(parts("- First item here.\n- Second item. With two.\n1. Numbered one.")));
    check("heading and table lines skipped", same("# Title\nText here.\n| a | b |", ["Text here."]));
    check("empty", splitSentences("").length === 0 && splitSentences("   \n ").length === 0);
}

section("rewordUnits");
{
    const p1 = "The first sentence is long enough to be sent. Short one. The third sentence is also long enough.";
    const p2 = "A second paragraph that holds only a single sentence, which is long enough.";
    const text = "# Heading\n\n" + p1 + "\n\n```\ncode that is long enough to count as text here\n```\n\n" + p2 + "\n";
    const paras = rewordUnits(text, "paragraph");
    check("paragraphs: the two prose blocks", paras.length === 2 && paras[0].text === p1 && paras[1].text === p2);
    check("paragraphs: ranges point at the text, no context", paras.every(u => text.slice(u.start, u.end) === u.text && u.context === null));
    const sents = rewordUnits(text, "sentence");
    check("sentences: short ones left out", sents.length === 3 && !sents.some(u => u.text === "Short one."), JSON.stringify(sents.map(u => u.text)));
    check("sentences: ranges point at the text", sents.every(u => text.slice(u.start, u.end) === u.text));
    check("sentences: the paragraph is the context", sents[0].context === p1 && sents[1].context === p1);
    check("a one-sentence paragraph needs no context", sents[2].context === null);
    check("blocks numbered", sents[0].block === sents[1].block && sents[2].block !== sents[0].block);
    check("nothing from the heading or code", !sents.some(u => /Heading|code/.test(u.text)));
}

section("groupUnits");
{
    const text = "First sentence of enough length here. Second sentence of enough length too. Third sentence of enough length now.\n\nOther paragraph sentence of quite enough length to be rewritten.";
    const units = rewordUnits(text, "sentence");
    check("four units", units.length === 4, units.length);
    const g1 = groupUnits(text, units, [0, 2]);
    check("apart: one request each", g1.length === 2 && g1.every(g => g.count === 1));
    const g2 = groupUnits(text, units, [0, 1]);
    check("neighbours go together", g2.length === 1 && g2[0].count === 2 && g2[0].text === text.slice(units[0].start, units[1].end) && g2[0].context);
    const g3 = groupUnits(text, units, [0, 1, 2, 3]);
    check("a whole paragraph drops its context", g3.length === 2 && g3[0].count === 3 && g3[0].context === null);
    check("never across paragraphs", g3[1].text.startsWith("Other"));
    check("at most maxRun", groupUnits(text, units, [0, 1, 2], 2).map(g => g.count).join() === "2,1");
    const lines = "- A list item of enough length here.\n- Another list item of enough length.";
    const lu = rewordUnits(lines, "sentence");
    check("never across a line break", groupUnits(lines, lu, [0, 1]).length === 2);
}

section("applyRewrites");
{
    const text = "Aaa bbb. Ccc ddd. Eee.";
    const marks = [
        { start: 1, end: 2, kind: "clean", labels: ["x"] },      // inside the first replacement: gone
        { start: 8, end: 8, kind: "removed", labels: ["y"] },    // at the end of it: moves
        { start: 13, end: 14, kind: "clean", labels: ["z"] },    // after: moves
        { start: 18, end: 18, kind: "removed", labels: ["w"] },  // at the start of the second: kept
    ];
    const r = applyRewrites(text, marks, [{ start: 0, end: 8, text: "Xx." }, { start: 18, end: 22, text: "Yyyyy." }]);
    check("text spliced", r.text === "Xx. Ccc ddd. Yyyyy.", r.text);
    const kinds = r.marks.map(m => `${m.kind}:${m.start}-${m.end}`).join(" ");
    check("marks moved or dropped", kinds === "removed:3-3 clean:8-9 removed:13-13 reword:0-3 reword:13-19", kinds);
    check("reword marks keep the original", r.marks.filter(m => m.kind === "reword").map(m => m.labels[0]).join("|") === "Aaa bbb.|Eee.");
    check("nothing to apply", applyRewrites(text, marks, []).text === text && applyRewrites(text, marks, []).marks.length === 4);
}

section("Rewrite request");
{
    const msgs = buildRewriteMessages("  " + DE + "\n", "de");
    check("system + user", msgs.length === 2 && msgs[0].role === "system" && msgs[1].role === "user");
    check("user is the trimmed paragraph", msgs[1].content === DE);
    check("language spelled out", /The passage is in German\. Write your rewrite in German\./.test(msgs[0].content));
    check("no language line when unknown", !/The passage is in/.test(buildRewriteMessages(EN, null)[0].content));
    check("German stock phrases listed", /dar\u00fcber hinaus/.test(msgs[0].content));
    const body = buildRewriteBody("qwen", EN, false, "en");
    check("OpenAI shape", body.model === "qwen" && body.stream === false && Array.isArray(body.messages));
    check("thinking off via kwargs", body.chat_template_kwargs && body.chat_template_kwargs.enable_thinking === false);
    check("kwargs dropped on request", !("chat_template_kwargs" in buildRewriteBody("qwen", EN, true, "en")));
    check("placeholder model name", buildRewriteBody("", EN, false).model === "local-model");
    const ctx = buildRewriteMessages("Second sentence.", "en", "First sentence. Second sentence. Third one.");
    check("context goes into the system message", /context only/.test(ctx[0].content) && ctx[0].content.endsWith("First sentence. Second sentence. Third one."));
    check("the user message holds only the sentence", ctx[1].content === "Second sentence.");
    check("no context line without context", !/context only/.test(msgs[0].content));
    check("body passes the context on", buildRewriteBody("q", "A.", false, "en", "A. B.").messages[0].content.includes("A. B."));
}

section("stripThinking");
{
    check("think block removed", stripThinking("<think>hmm</think>\nAnswer") === "Answer");
    check("thought and reasoning too", stripThinking("<thought>a</thought><reasoning>b</reasoning>Answer") === "Answer");
    check("only a closing tag", stripThinking("pondering...</think>Answer") === "Answer");
    check("unclosed: all trace, nothing left", stripThinking("<think>still going") === "");
    check("plain text untouched", stripThinking("  Answer  ") === "Answer");
}

section("acceptRewrite");
{
    const orig = EN;
    const good = "The committee looked at the proposal and found it was not ready for a vote this year.";
    check("a good rewrite passes", acceptRewrite(orig, good, "en").ok && acceptRewrite(orig, good, "en").text === good);
    check("empty", acceptRewrite(orig, "<think>x</think>", "en").reason === "empty reply");
    check("preamble", !acceptRewrite(orig, "Here is the rewritten text: " + good, "en").ok);
    check("German preamble", !acceptRewrite(DE, "Hier ist der umgeschriebene Text: " + DE, "de").ok);
    check("too short", !acceptRewrite(orig, "Not ready.", "en").ok);
    check("too long", !acceptRewrite(orig, good + " " + good + " " + good, "en").ok);
    check("a sentence comes back on one line", acceptRewrite(orig, "The committee looked at the proposal\nand found it was not ready for a vote this year.", "en").text === good);
    check("a paragraph keeps its line breaks", acceptRewrite("Line one is here.\nLine two is here.", "Line one now.\nLine two now.", null).text === "Line one now.\nLine two now.");
    check("wrapping quotes removed", acceptRewrite(orig, "\"" + good + "\"", "en").text === good);
    const wrong = acceptRewrite(DE, "The committee examined the proposal and decided it will not come to a vote this year.", "de");
    check("English answer to German text is refused", !wrong.ok && /English instead of German/.test(wrong.reason), wrong.reason);
    check("German answer to German text passes", acceptRewrite(DE, "Der Ausschuss hat sich den Vorschlag angesehen und will dieses Jahr nicht dar\u00fcber abstimmen.", "de").ok);
    check("unknown language: no language check", acceptRewrite(DE, "The committee examined the proposal and decided it will not come to a vote this year.", null).ok);
}

section("German typos");
{
    const de = ("Die Regierung hat gestern einen neuen Entwurf vorgelegt, der die Steuern f\u00fcr kleine Unternehmen senken soll. ").repeat(30);
    const words = new Set();
    for (let seed = 1; seed <= 50; seed++) addTypos(de, { rate: 1, minGap: 0, lang: "de" }, mulberry32(seed)).marks.forEach(mk => words.add(mk.labels[0]));
    check("capitalised nouns can get typos in German", words.has("Regierung") || words.has("Entwurf") || words.has("Steuern"), [...words].join(", "));
    const en = new Set();
    for (let seed = 1; seed <= 50; seed++) addTypos(de, { rate: 1, minGap: 0, lang: "en" }, mulberry32(seed)).marks.forEach(mk => en.add(mk.labels[0]));
    check("but not when the text isn't German", !en.has("Regierung") && !en.has("Entwurf"), [...en].join(", "));
    const r = addTypos(de, { rate: 1, minGap: 0, lang: "de" }, mulberry32(4));
    check("a typo keeps the first letter (case aside)", r.marks.filter(mk => /^\p{L}/u.test(mk.labels[0])).every(mk => { const t = r.text.slice(mk.start, mk.end); return mk.labels[0][0].toLowerCase() === t[0].toLowerCase(); }));
}

section("Copied from HermitUI");
{
    check("401 hint", /API key/.test(chatErrorHint("Server Error 401: nope")));
    check("network hint, local", /server is running/.test(chatErrorHint("Failed to fetch", { apiUrl: "http://localhost:8080/v1" })));
    check("context hint", /context/.test(chatErrorHint("the request exceeds the available context size")));
    check("normalizeApiUrl adds http for local", normalizeApiUrl("localhost:8080/v1") === "http://localhost:8080/v1");
    check("apiEndpoint", apiEndpoint("http://x/v1/", "/chat/completions") === "http://x/v1/chat/completions");
}

report();
