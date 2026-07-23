#!/usr/bin/env python3
"""Check whether a local OpenAI-compatible server reuses its KV cache across a
HermitUI conversation.

HermitUI's history is append-only (`messages.push(...)` in src/script.js), so every
turn should be a pure extension of the previous prompt and the server should only
have to evaluate the new tokens. This replays that exact payload shape and reports,
per turn, how many prompt tokens were actually evaluated versus the prompt total.

Requires a server that reports `timings.prompt_n` (llama.cpp does). Servers that
don't are still probed via wall-clock prompt time, which is a weaker but usable
signal. Stdlib only — no venv needed.

    python3 prompt_cache_probe.py --url http://127.0.0.1:8081/v1

Reference (Qwen3-8B-Q4_K_M, llama-server b10068, -c 8192 -np 1 -ngl 99): a 3k-token
attachment costs 2914 evaluated tokens on its own turn and 13-16 on each following
turn; flipping the system prompt mid-chat re-evaluates 3021 of 3027.
"""
import argparse
import json
import sys
import time
import urllib.error
import urllib.request

sys.stdout.reconfigure(line_buffering=True)

SYSTEM_PROMPT = "You are a technical assistant. Answer concisely."
SWITCHED_PROMPT = "You are a pirate. Answer concisely, matey."


class Conversation:
    """Append-only message list, mirroring how the app builds its payload."""

    def __init__(self, args):
        self.args = args
        self.messages = [{"role": "system", "content": SYSTEM_PROMPT}]
        self.rows = []

    def post(self, messages):
        body = json.dumps({
            "model": self.args.model,
            "messages": messages,
            "temperature": 0,
            "max_tokens": self.args.max_tokens,
            "stream": False,
        }).encode()
        headers = {"Content-Type": "application/json"}
        if self.args.api_key:
            headers["Authorization"] = f"Bearer {self.args.api_key}"
        req = urllib.request.Request(self.args.url.rstrip("/") + "/chat/completions",
                                     body, headers)
        started = time.time()
        with urllib.request.urlopen(req, timeout=self.args.timeout) as resp:
            payload = json.load(resp)
        return payload, time.time() - started

    def ask(self, text, label, record=True):
        self.messages.append({"role": "user", "content": text})
        payload, wall = self.post(self.messages)
        self.messages.append({
            "role": "assistant",
            "content": payload["choices"][0]["message"]["content"],
        })
        return self.report(payload, wall, label, record)

    def report(self, payload, wall, label, record=True):
        total = payload.get("usage", {}).get("prompt_tokens")
        timings = payload.get("timings", {})
        evaluated = timings.get("prompt_n")
        prompt_ms = timings.get("prompt_ms")
        cached = None if (evaluated is None or total is None) else total - evaluated
        print("{:<26} prompt_total={:<7} evaluated={:<7} cached={:<7} "
              "prompt_ms={:>8}  wall={:5.2f}s".format(
                  label,
                  "?" if total is None else total,
                  "?" if evaluated is None else evaluated,
                  "?" if cached is None else cached,
                  "?" if prompt_ms is None else f"{prompt_ms:.1f}",
                  wall))
        row = {"label": label, "prompt_total": total, "evaluated": evaluated,
               "cached": cached, "prompt_ms": prompt_ms, "wall_s": round(wall, 3)}
        if record:
            self.rows.append(row)
        return row


def build_attachment(path, chars):
    """Reproduce the <file> block processFiles() bakes into the user turn."""
    with open(path, encoding="utf-8", errors="replace") as fh:
        content = fh.read()[:chars]
    name = path.rsplit("/", 1)[-1]
    return f'<file name="{name}">\n{content}\n</file>\n\nWhat does this file do?'


def main():
    here = __file__.rsplit("/", 1)[0]
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default="http://127.0.0.1:8081/v1",
                    help="API base URL (default: %(default)s)")
    ap.add_argument("--model", default="local", help="model name sent in the payload")
    ap.add_argument("--api-key", default="", help="bearer token, if the server wants one")
    ap.add_argument("--attachment", default=f"{here}/../src/script.js",
                    help="file inlined as a context attachment (default: src/script.js)")
    ap.add_argument("--attachment-chars", type=int, default=14000,
                    help="how much of it to inline (default: %(default)s ≈ 3k tokens)")
    ap.add_argument("--max-tokens", type=int, default=32,
                    help="cap replies so decode time stays out of the way")
    ap.add_argument("--timeout", type=int, default=300)
    ap.add_argument("--json", metavar="PATH", help="also write the raw rows here")
    args = ap.parse_args()

    convo = Conversation(args)

    print("--- append-only conversation (what HermitUI does) ---")
    convo.ask("Explain what a KV cache is in one sentence.", "turn 1 (cold)")
    convo.ask("And why does it grow with context?", "turn 2 (append)")
    convo.ask("Give one practical downside.", "turn 3 (append)")

    print(f"\n--- a context attachment enters the history ({args.attachment}) ---")
    convo.ask(build_attachment(args.attachment, args.attachment_chars),
              "turn 4 (attachment)")
    convo.ask("Name one function in it.", "turn 5 (append)")
    reused = convo.ask("And another.", "turn 6 (append)")

    print("\n--- mutate messages[0]: persona switch mid-chat (script.js:402) ---")
    convo.messages[0]["content"] = SWITCHED_PROMPT
    invalidated = convo.ask("Name a third.", "turn 7 (system changed)")
    convo.ask("Continue.", "turn 8 (append again)")

    print("\n--- one-off side request, i.e. the 📋 summarize button ---")
    side = [{"role": "system", "content": "You are a concise summarization assistant."},
            {"role": "user", "content": "Summarize: the sky is blue because of "
                                        "Rayleigh scattering."}]
    payload, wall = convo.post(side)
    convo.report(payload, wall, "side request")
    resumed = convo.ask("And what else?", "turn 9 (after side req)")

    print("\n--- verdict ---")
    if reused["evaluated"] is None:
        print("Server does not report timings.prompt_n — compare prompt_ms/wall instead: "
              "a cache hit keeps them flat as the prompt grows.")
        return 0
    hit = reused["evaluated"] < reused["prompt_total"] / 2
    print(f"append-only turn evaluated {reused['evaluated']}/{reused['prompt_total']} "
          f"prompt tokens -> cache {'REUSED' if hit else 'NOT reused'}")
    print(f"after system-prompt change  {invalidated['evaluated']}/"
          f"{invalidated['prompt_total']} -> prefix invalidated as expected"
          if invalidated["evaluated"] > invalidated["prompt_total"] / 2 else
          f"after system-prompt change  {invalidated['evaluated']}/"
          f"{invalidated['prompt_total']} -> unexpectedly still cached")
    print(f"resuming after a side request {resumed['evaluated']}/"
          f"{resumed['prompt_total']} -> "
          f"{'prefix survived (server keeps evicted prompts)' if resumed['evaluated'] < resumed['prompt_total'] / 2 else 'prefix lost'}")

    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(convo.rows, fh, indent=2)
        print(f"rows written to {args.json}")
    return 0 if hit else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except urllib.error.URLError as exc:
        sys.exit(f"cannot reach the server: {exc}")
