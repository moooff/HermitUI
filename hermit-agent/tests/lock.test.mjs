// The connection lock (DESIGN §10): the connect-src policy inserted when the first task
// starts, and the hint for an endpoint on another origin afterwards. Run: node tests/lock.test.mjs
import { check, section, report } from "./check.mjs";
import X from "./extract.mjs";

const CDN = "https://cdn.jsdelivr.net/pyodide/v0.29.5/full/";

section("1. connectionLockPolicy");
{
    check("the endpoint's origin, not its path, plus the extra sources",
        X.connectionLockPolicy("http://localhost:9931/v1", [CDN]) === `connect-src http://localhost:9931 ${CDN} blob: data:`);
    check("a default port drops out of the origin", X.connectionLockPolicy("https://api.example.com:443/v1", []) === "connect-src https://api.example.com blob: data:");
    check("offline: the endpoint only", X.connectionLockPolicy("http://192.168.1.20:8080/v1") === "connect-src http://192.168.1.20:8080 blob: data:");
    check("the unbuilt source: PyPI too, duplicates and empties dropped",
        X.connectionLockPolicy("http://127.0.0.1:1/v1", [CDN, "https://files.pythonhosted.org", CDN, ""]) === `connect-src http://127.0.0.1:1 ${CDN} https://files.pythonhosted.org blob: data:`);
    check("no credentials or query in the source", X.connectionLockPolicy("http://u:p@host:5/v1?x=1", []) === "connect-src http://host:5 blob: data:");
    check("an IPv6 endpoint can't be written as a CSP source: no policy", X.connectionLockPolicy("http://[::1]:8080/v1", [CDN]) === "");
    let threw = 0;
    for (const bad of ["ftp://host/v1", "not a url", ""]) { try { X.connectionLockPolicy(bad, []); } catch (e) { threw++; } }
    check("a non-http(s) or unparsable URL throws", threw === 3);
}

section("2. lockedEndpointHint");
{
    check("nothing locked: no hint", X.lockedEndpointHint("", "http://other:1/v1") === "");
    check("same origin, another path: no hint", X.lockedEndpointHint("http://localhost:9931", "http://localhost:9931/other/v1") === "");
    const h = X.lockedEndpointHint("http://localhost:9931", "https://api.example.com/v1");
    check("another origin: names both and says export, reload, import", h.includes("http://localhost:9931") && h.includes("https://api.example.com") && /export/.test(h) && /reload/.test(h) && /import/.test(h));
    check("another port is another origin", X.lockedEndpointHint("http://localhost:9931", "http://localhost:9932/v1") !== "");
    check("an unparsable URL: no hint (saving reports it)", X.lockedEndpointHint("http://localhost:9931", "::") === "");
}

section("3. externalLinkInfo");
{
    const plain = X.externalLinkInfo("https://example.org/docs/page.html");
    check("a plain link: shown, not heavy", plain && plain.url === "https://example.org/docs/page.html" && plain.host === "example.org" && !plain.heavy && plain.carried === 0, JSON.stringify(plain));
    check("a short query isn't heavy", !X.externalLinkInfo("https://example.org/search?q=pandas").heavy);
    const leak = X.externalLinkInfo("https://evil.example/c?d=" + "name,amount;alice,120.5;bob,80;carol,99.5");
    check("data in the query: heavy, counted", leak.heavy && leak.carried > 40, JSON.stringify(leak));
    check("an encoded blob in the path: heavy", X.externalLinkInfo("https://evil.example/x/" + "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0MjQy").heavy);
    check("data in the fragment counts too", X.externalLinkInfo("https://evil.example/#" + "a".repeat(50)).heavy);
    check("not a web link: null", X.externalLinkInfo("mailto:a@b.c") === null && X.externalLinkInfo("../data.csv") === null && X.externalLinkInfo("javascript:alert(1)") === null);
}

section("4. agentsFileNote");
{
    check("an AGENTS.md at the top: the note", X.agentsFileNote(["data.csv", "AGENTS.md"]).includes("AGENTS.md"));
    check("none, or only in a subfolder: no note", X.agentsFileNote(["data.csv"]) === "" && X.agentsFileNote(["docs/AGENTS.md"]) === "" && X.agentsFileNote() === "");
}

report();
