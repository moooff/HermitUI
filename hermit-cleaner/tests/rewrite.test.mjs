// Language detection, paragraph splitting and picking, the rewrite request, and the
// checks on the model's reply. Plus the helpers copied from HermitUI.
import m from "./extract.mjs";
import { check, section, report } from "./check.mjs";

const { detectLanguage, splitParagraphs, splitSentences, rewordUnits, groupUnits, applyRewrites, pickUnits, mulberry32, buildRewriteMessages, buildRewriteBody,
    stripThinking, acceptRewrite, addTypos, chatErrorHint, normalizeApiUrl, apiEndpoint, buildRewriteSystem, wordDiff, REWORD_LEVELS,
    normalizeGgufUrl, ggufFileName, wllamaMaxTokens, retryNote, MIN_LETTERS } = m;

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
    const blocks = splitParagraphs(text, 40);
    check("round-trips exactly", blocks.map(b => b.text).join("") === text);
    check("starts are offsets", blocks.every(b => text.slice(b.start, b.start + b.text.length) === b.text));
    const code = blocks.find(b => b.kind === "code");
    check("fence with a blank line stays one block", code && code.text === "```js\nconst a = 1;\n\nconst b = 2;\n```\n", JSON.stringify(code));
    const rw = blocks.filter(b => b.rewrite).map(b => b.text.trim().slice(0, 10));
    check("only the two prose paragraphs are rewritable (40 letters)", rw.length === 2 && rw[0] === "First para" && rw[1] === "Last parag", JSON.stringify(rw));
    const rwDefault = splitParagraphs(text).filter(b => b.rewrite).map(b => b.text.trim());
    check("the default limit is low: \"short one\" is sent too, heading, table and URL still not", MIN_LETTERS === 6
        && rwDefault.length === 3 && rwDefault.includes("short one"), JSON.stringify(rwDefault));
    check("a short line passes the default, a bare name doesn't", splitParagraphs("Call me later.\n\nTom\n").filter(b => b.rewrite).map(b => b.text.trim()).join() === "Call me later.");
    const letter = "Sehr geehrter Herr Becker,\n\nDie Lieferung kommt am Donnerstag.\n\nMit freundlichen Gr\u00fc\u00dfen\n\nHi Sarah,\n\nBest regards,\n\nCheers!\n\nThanks again for your patience and hard work.";
    const kept = splitParagraphs(letter).filter(b => b.rewrite).map(b => b.text.trim());
    check("greetings and sign-offs are never reworded", kept.join(" | ") === "Die Lieferung kommt am Donnerstag. | Thanks again for your patience and hard work.", kept.join(" | "));
    check("a sign-off with the name under it is not reworded", !splitParagraphs("Danke.\n\nMit freundlichen Gr\u00fc\u00dfen\nJonas Becker").filter(b => b.rewrite).some(b => /Gr\u00fc\u00dfen/.test(b.text)));
    const units = rewordUnits("Hallo zusammen,\nich wollte fragen, ob das am Montag passt.\nViele Gr\u00fc\u00dfe", "sentence").map(u => u.text);
    check("by sentence: greeting and sign-off lines inside a paragraph are left out", units.join(" | ") === "ich wollte fragen, ob das am Montag passt.", units.join(" | "));
    check("...but a sentence that starts like one is", splitParagraphs("Hallo zusammen, die Lieferung kommt am Donnerstag.").some(b => b.rewrite));
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
    const sents = rewordUnits(text, "sentence", 20);
    check("sentences: short ones left out (20 letters)", sents.length === 3 && !sents.some(u => u.text === "Short one."), JSON.stringify(sents.map(u => u.text)));
    check("sentences: the default limit sends the short one", rewordUnits(text, "sentence").some(u => u.text === "Short one."));
    check("the limit is configurable", rewordUnits(text, "sentence", 100).length === 0 && rewordUnits(text, "paragraph", 100).length === 0
        && rewordUnits(text, "sentence", 1).length === 4);
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
    const c = applyRewrites("Aa bb. Cc.", [], [{ start: 0, end: 6, text: "Aa dd ee.", changed: [[3, 8]] }]);
    const ch = c.marks.filter(mk => mk.kind === "changed");
    check("changed words become marks in the new text", ch.length === 1 && c.text.slice(ch[0].start, ch[0].end) === "dd ee", JSON.stringify(c.marks));
}

section("wordDiff");
{
    check("identical: no change", wordDiff("The cat sat.", "The cat sat.").ratio === 0);
    check("case and punctuation don't count", wordDiff("The cat sat.", "the cat sat!").ratio === 0);
    const d = wordDiff("The cat sat on the mat.", "The dog sat on the mat.");
    check("one word of six", Math.abs(d.ratio - 1 / 6) < 1e-9, d.ratio);
    check("its range in the rewrite", JSON.stringify(d.changed) === "[[4,7]]", JSON.stringify(d.changed));
    const n = wordDiff("one two three four", "one five six four");
    check("neighbouring changes merge", JSON.stringify(n.changed) === "[[4,12]]", JSON.stringify(n.changed));
    check("nothing in common", wordDiff("alpha beta", "gamma delta").ratio === 1);
    check("added words count against the longer side", Math.abs(wordDiff("a b", "a b c d").ratio - 0.5) < 1e-9);
    check("reordering counts as change", wordDiff("a b c d", "d c b a").ratio > 0.5);
    check("German letters are words", Math.abs(wordDiff("Gr\u00fc\u00dfe aus M\u00fcnchen", "Gr\u00fc\u00dfe aus K\u00f6ln").ratio - 1 / 3) < 1e-9);
    const long = Array.from({ length: 3000 }, (_, i) => "w" + i).join(" ");
    const t0 = Date.now();
    check("very long texts fall back to counting words", wordDiff(long, long + " extra").ratio < 0.01 && Date.now() - t0 < 2000);
}

section("Rewrite request");
{
    const msgs = buildRewriteMessages("  " + DE + "\n", "de");
    check("system, example exchange, then the passage", msgs.map(x => x.role).join(",") === "system,user,assistant,user");
    check("user is the trimmed paragraph", msgs[3].content === DE);
    check("the example is in German for German text", /Dar\u00fcber hinaus/.test(msgs[1].content) && /6 Wochen/.test(msgs[2].content));
    check("English example for English text", /Moreover/.test(buildRewriteMessages(EN, "en")[1].content));
    check("no example for other languages", buildRewriteMessages(FR, "fr").length === 2 && buildRewriteMessages(EN, null).length === 2);
    const exLight = buildRewriteMessages(EN, "en", null, { level: "light" })[2].content, exStrong = buildRewriteMessages(EN, "en", null, { level: "strong" })[2].content;
    check("the example follows the level", exLight !== exStrong && wordDiff(buildRewriteMessages(EN, "en")[1].content, exLight).ratio < wordDiff(buildRewriteMessages(EN, "en")[1].content, exStrong).ratio);
    check("language spelled out", /The passage is in German\. Write your rewrite in German\./.test(msgs[0].content));
    check("no language line when unknown", !/The passage is in/.test(buildRewriteMessages(EN, null)[0].content));
    check("German stock phrases listed", /dar\u00fcber hinaus/.test(msgs[0].content));
    const enSys = buildRewriteMessages(EN, "en")[0].content;
    check("an English prompt never mentions German", !/German|dar\u00fcber/.test(enSys) && /moreover/.test(enSys), enSys);
    check("a German prompt lists only German stock phrases", !/moreover/.test(msgs[0].content));
    check("unknown language: generic line, English examples of stock phrases", /language of the passage/.test(buildRewriteMessages(EN, null)[0].content)
        && /their equivalents in the passage's language/.test(buildRewriteMessages(EN, null)[0].content));
    check("French gets French stock phrases", /par ailleurs/.test(buildRewriteMessages(FR, "fr")[0].content) && !/German/.test(buildRewriteMessages(FR, "fr")[0].content));
    const body = buildRewriteBody("qwen", EN, false, "en");
    check("OpenAI shape", body.model === "qwen" && body.stream === false && Array.isArray(body.messages));
    check("thinking off via kwargs", body.chat_template_kwargs && body.chat_template_kwargs.enable_thinking === false);
    check("kwargs dropped on request", !("chat_template_kwargs" in buildRewriteBody("qwen", EN, true, "en")));
    check("placeholder model name", buildRewriteBody("", EN, false).model === "local-model");
    const ctx = buildRewriteMessages("Second sentence.", "en", "First sentence. Second sentence. Third one.");
    check("context goes into the system message", /context only/.test(ctx[0].content) && ctx[0].content.endsWith("First sentence. Second sentence. Third one."));
    check("the user message holds only the sentence", ctx[ctx.length - 1].content === "Second sentence.");
    check("no context line without context", !/context only/.test(msgs[0].content));
    check("body passes the context on", buildRewriteBody("q", "A.", false, "en", "A. B.").messages[0].content.includes("A. B."));
    check("default level is strong (as before levels)", buildRewriteBody("q", EN, false, "en").temperature === 0.9 && /Rewrite the passage freely/.test(msgs[0].content));
    const light = buildRewriteBody("q", EN, false, "en", null, { level: "light" });
    check("light: its rules and lower temperature", /Make light edits/.test(light.messages[0].content) && !/Rewrite the passage freely/.test(light.messages[0].content) && light.temperature === REWORD_LEVELS.light.temperature);
    check("medium rules", /Rephrase every sentence/.test(buildRewriteSystem("medium")));
    check("tone line", /more casual/.test(buildRewriteSystem("light", "casual")) && !/tone/.test(buildRewriteSystem("light", "keep")));
    const extra = buildRewriteSystem("light", "keep", "  Use \"du\".\n Not \"Sie\".  ");
    check("extra instruction on one line, before the reply rule", /\n- Use "du"\. Not "Sie"\.\n- Reply with/.test(extra), extra);
    check("extra instruction capped", buildRewriteSystem("light", "keep", "x".repeat(1000)).includes("x".repeat(300) + "\n"));
    check("reply rule stays last", /Reply with the edited passage only[^\n]*$/.test(buildRewriteSystem("strong", "formal", "Be brief.")));
    check("level goes through to the language and context lines", /Make light edits[\s\S]*The passage is in English[\s\S]*The longer text/.test(
        buildRewriteMessages("A b c.", "en", "Z. A b c.", { level: "light" })[0].content));
}

section("stripThinking");
{
    check("think block removed", stripThinking("<think>hmm</think>\nAnswer") === "Answer");
    check("thought and reasoning too", stripThinking("<thought>a</thought><reasoning>b</reasoning>Answer") === "Answer");
    check("only a closing tag", stripThinking("pondering...</think>Answer") === "Answer");
    check("unclosed: all trace, nothing left", stripThinking("<think>still going") === "");
    check("plain text untouched", stripThinking("  Answer  ") === "Answer");
    check("Gemma 4 empty thought channel removed", stripThinking("<|channel>thought\n<channel|>Answer") === "Answer");
    check("Gemma 4 thought channel with a trace", stripThinking("<|channel>thought\nhmm, maybe\n<channel|>\nAnswer") === "Answer");
    check("Gemma 4: only the closing marker", stripThinking("pondering<channel|>Answer") === "Answer");
    check("Gemma 4: unclosed channel, nothing left", stripThinking("<|channel>thought\nstill going") === "");
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
    const same = acceptRewrite(orig, "  " + orig + " ", "en", "light");
    check("an identical reply is 'unchanged', not an error", !same.ok && same.unchanged, JSON.stringify(same));
    check("only spacing or punctuation changed: unchanged too", acceptRewrite("It rose 23 % in 2021.", "It rose 23% in 2021!", "en", "light").unchanged === true);
    check("the share of changed words comes back", Math.abs(acceptRewrite(orig, good, "en").change - wordDiff(orig, good).ratio) < 1e-9);
    const lightEdit = "The committee reviewed the plan and decided that it was not ready for a vote this year.";
    check("light: a small edit passes", acceptRewrite(orig, lightEdit, "en", "light").ok);
    const heavy = "Members looked over this idea, then concluded voting must wait until next spring at earliest.";
    const lr = acceptRewrite(orig, heavy, "en", "light");
    check("light: a rewrite of most words is refused", !lr.ok && /changed \d+ % of the words/.test(lr.reason), lr.reason);
    check("strong: the same rewrite passes", acceptRewrite(orig, heavy, "en", "strong").ok);
    check("light: tighter length bounds", !acceptRewrite(orig, orig + " It was a long and difficult meeting for all of the people involved.", "en", "light").ok
        && acceptRewrite(orig, orig + " It was a long and difficult meeting for all of the people involved.", "en", "strong").ok);
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
    check("hf: shorthand", normalizeGgufUrl("hf:unsloth/Qwen3-1.7B-GGUF/Qwen3-1.7B-Q4_K_M.gguf") === "https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf");
    check("blob page becomes resolve", normalizeGgufUrl("https://huggingface.co/a/b/blob/main/m.gguf") === "https://huggingface.co/a/b/resolve/main/m.gguf");
    let threw = 0;
    for (const bad of ["", "model.gguf", "https://x/y.bin", "https://x/m-00001-of-00003.gguf"]) { try { normalizeGgufUrl(bad); } catch { threw++; } }
    check("bad model URLs are refused", threw === 4, threw);
    check("file name from URL", ggufFileName("https://x/a/Qwen%203.gguf?download=1") === "Qwen 3.gguf" && ggufFileName("https://x/%E0.gguf") === "%E0.gguf");
}

section("retryNote and the second try");
{
    check("an accepted reply needs no second try", retryNote({ ok: true, text: "x" }, EN) === "");
    check("unchanged: ask for real changes", /word for word/.test(retryNote({ ok: false, unchanged: true }, EN)));
    check("a short unchanged unit is left alone", retryNote({ ok: false, unchanged: true }, "Best regards,") === "");
    check("a refusal is named", /refused \(the model added an introduction\)/.test(retryNote({ ok: false, reason: "the model added an introduction" }, EN)));
    check("empty reply", /was empty/.test(retryNote({ ok: false, reason: "empty reply" }, EN)));
    const first = buildRewriteBody("q", EN, false, "en", null, { level: "light" });
    const second = buildRewriteBody("q", EN, false, "en", null, { level: "light", retry: "Your first answer repeated the passage word for word." });
    check("the note goes into the rules, before the reply rule", /word for word\.\n- Reply with/.test(second.messages[0].content) && !/word for word/.test(first.messages[0].content));
    check("a second try samples a little more freely", first.temperature === 0.7 && second.temperature === 0.9, [first.temperature, second.temperature]);
}

section("wllamaMaxTokens");
{
    check("grows with the passage", wllamaMaxTokens("a".repeat(400)) === 364 && wllamaMaxTokens("") === 64);
    check("capped", wllamaMaxTokens("a".repeat(100000)) === 2048);
}

report();
