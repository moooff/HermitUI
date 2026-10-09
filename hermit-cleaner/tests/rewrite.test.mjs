// Language detection, paragraph splitting and picking, the rewrite request, and the
// checks on the model's reply. Plus the helpers copied from HermitUI.
import m from "./extract.mjs";
import { check, section, report } from "./check.mjs";

const { detectLanguage, splitParagraphs, pickParagraphs, mulberry32, buildRewriteMessages, buildRewriteBody,
    stripThinking, acceptRewrite, keepWhitespace, addTypos, chatErrorHint, normalizeApiUrl, apiEndpoint } = m;

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

section("pickParagraphs");
{
    check("none when share is 0", pickParagraphs(10, 0, mulberry32(1)).length === 0);
    check("at least one", pickParagraphs(10, 0.01, mulberry32(1)).length === 1);
    check("60% of 10", pickParagraphs(10, 0.6, mulberry32(1)).length === 6);
    const all = pickParagraphs(5, 1, mulberry32(1));
    check("all, sorted", JSON.stringify(all) === "[0,1,2,3,4]");
    const p = pickParagraphs(20, 0.3, mulberry32(2));
    check("distinct and in range", new Set(p).size === p.length && p.every(i => i >= 0 && i < 20));
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
    check("wrapping quotes removed", acceptRewrite(orig, "\"" + good + "\"", "en").text === good);
    const wrong = acceptRewrite(DE, "The committee examined the proposal and decided it will not come to a vote this year.", "de");
    check("English answer to German text is refused", !wrong.ok && /English instead of German/.test(wrong.reason), wrong.reason);
    check("German answer to German text passes", acceptRewrite(DE, "Der Ausschuss hat sich den Vorschlag angesehen und will dieses Jahr nicht dar\u00fcber abstimmen.", "de").ok);
    check("unknown language: no language check", acceptRewrite(DE, "The committee examined the proposal and decided it will not come to a vote this year.", null).ok);
    check("keepWhitespace", keepWhitespace("\n  old text\n\n", "new") === "\n  new\n\n");
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
    check("a noun keeps its capital", r.marks.every(mk => { const t = r.text.slice(mk.start, mk.end); return mk.labels[0][0] === t[0] || mk.labels[0][0].toLowerCase() === t[0]; }));
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
