#!/usr/bin/env python3
"""End-to-end 📤 Export / 📂 Import test against the real built app.

Drives dist/hermit-ui-standalone.html in headless Chromium through its own buttons —
attach a file, send, export, re-import — and asserts on the resulting DOM. `fetch` is
stubbed with a one-chunk SSE stream so no API server is needed.

Setup (reuses the benchmark harness's virtualenv):
    benchmark/.venv/bin/python -m playwright install chromium
Run:
    benchmark/.venv/bin/python tests/e2e_export_import.py
"""
import base64
import pathlib
import sys
import tempfile

sys.stdout.reconfigure(line_buffering=True)
from playwright.sync_api import sync_playwright

REPO = pathlib.Path(__file__).resolve().parent.parent
APP = (REPO / "dist" / "hermit-ui-standalone.html").as_uri()

# One-chunk SSE reply, plus a copy of the outgoing payload for inspection.
STUB = """
window.fetch = async (url, opts) => {
  const body = 'data: {"choices":[{"delta":{"content":"Acknowledged."}}]}\\n\\n' +
               'data: {"choices":[{"delta":{}}],"usage":{"total_tokens":10}}\\n\\n' +
               'data: [DONE]\\n\\n';
  window.__lastPayload = opts && opts.body ? JSON.parse(opts.body) : null;
  const enc = new TextEncoder();
  return new Response(new ReadableStream({start(c){c.enqueue(enc.encode(body)); c.close();}}),
                      {status: 200, headers: {"Content-Type": "text/event-stream"}});
};
"""

# Smallest valid 1x1 PNG.
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)

results = []


def check(name, cond, detail=""):
    results.append((bool(cond), name))
    print(("  PASS  " if cond else "  FAIL  ") + name + (("\n        " + str(detail)) if detail and not cond else ""))


def send_and_roundtrip(page, tmp, label, files, prompt):
    """Attach files, send, export to disk, re-import. Returns (export_text, bubbles_after)."""
    page.goto(APP)
    page.evaluate(STUB)
    page.click("#attach-context-btn")
    page.set_input_files("#file-upload", [str(f) for f in files])
    page.wait_for_selector(".file-chip", timeout=5000)
    if prompt:
        page.fill("#userInput", prompt)
    page.click("#sendBtn")
    page.wait_for_selector(".ai-response-body", timeout=10000)
    page.wait_for_timeout(700)

    out = tmp / f"{label}.md"
    with page.expect_download() as dl:
        page.click("#exportBtn")
    dl.value.save_as(str(out))

    page.set_input_files("#importFileInput", str(out))
    page.wait_for_timeout(300)
    if page.is_visible("#importConfirmModal"):
        page.click("#importConfirmBtn")
    page.wait_for_timeout(600)

    bubbles = page.eval_on_selector_all(".msg-wrapper.user .msg-content", "e => e.map(x => x.innerText)")
    return out.read_text(), bubbles


def main():
    tmp = pathlib.Path(tempfile.mkdtemp())
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(accept_downloads=True)
        page.add_init_script(STUB)

        print("\n=== text attachment + prompt text ===")
        notes = tmp / "notes.txt"
        notes.write_text("line one\nline two")
        md, after = send_and_roundtrip(page, tmp, "with-prompt", [notes], "Summarize this")
        check("export carries the attachment body", "line one\nline two" in md)
        check("imported bubble shows the collapsible context",
              page.locator("details.attached-context").count() > 0, after)
        check("no raw <file> tag leaked into the bubble", not any("<file name=" in t for t in after), after)
        page.click("details.attached-context summary")
        page.wait_for_timeout(200)
        check("disclosure holds the file content", "line one" in page.inner_text("details.attached-context"))
        page.hover(".msg-wrapper.user")
        page.wait_for_timeout(200)
        page.click(".msg-wrapper.user .action-btn")
        page.wait_for_timeout(400)
        chips = page.eval_on_selector_all(".file-chip .file-chip-name", "e => e.map(x => x.innerText)")
        check("Edit refills the file chip after import", any("notes.txt" in c for c in chips), chips)

        # Regression: an attachment sent with no prompt text used to come back as a raw
        # <file …> tag rendered as message text, with no chip and no disclosure.
        print("\n=== attachment with NO prompt text (regression) ===")
        csv = tmp / "data.csv"
        csv.write_text("a,b\n1,2")
        md, after = send_and_roundtrip(page, tmp, "no-prompt", [csv], "")
        check("export carries the attachment body", "a,b\n1,2" in md)
        check("imported bubble shows the collapsible context",
              page.locator("details.attached-context").count() > 0, after)
        check("no raw <file> tag rendered as message text",
              not any("<file name=" in t for t in after), after)
        page.hover(".msg-wrapper.user")
        page.wait_for_timeout(200)
        page.click(".msg-wrapper.user .action-btn")
        page.wait_for_timeout(400)
        chips = page.eval_on_selector_all(".file-chip .file-chip-name", "e => e.map(x => x.innerText)")
        check("Edit refills the file chip after import", any("data.csv" in c for c in chips), chips)

        print("\n=== image attachment is flattened, not exported ===")
        shot = tmp / "shot.png"
        shot.write_bytes(PNG)
        md, after = send_and_roundtrip(page, tmp, "image", [shot], "What is this?")
        check("image bytes absent from export", "iVBORw0KGgo" not in md)
        check("image filename absent from export", "shot.png" not in md)
        check("placeholder written to export", "[1 image attached]" in md, md[:300])
        check("no image preview after import", page.locator(".attached-image-preview").count() == 0)
        check("placeholder shown as literal text", any("[1 image attached]" in t for t in after), after)

        browser.close()

    failed = [n for ok, n in results if not ok]
    print(f"\n{len(results) - len(failed)} passed, {len(failed)} failed\n")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
