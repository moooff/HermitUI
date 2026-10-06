"""A scripted OpenAI-compatible endpoint for the end-to-end tests.

Replies are picked by a keyword in the task (the first user message) and by how many
assistant messages the request already holds, so a test is a list of model turns.
Every request is recorded, and so is every hit on /exfil/…, which the network-guard
probes in the e2e test aim at: a non-empty `exfil` list means something got out.

History compaction: the summariser's request (recognised by its system prompt) gets
SUMMARY back, and a compacted history's `<history_summary steps="1-K">` adds K to the
turn count, since those K assistant messages are gone. A reply marked
`overflow_unless_compacted` answers a 400 context-size error until the history has
been compacted. A reply's `usage` replaces the default 100 prompt + 20 completion tokens
(the mock's /props reports n_ctx 4096). Under /vllm/v1 it acts like vLLM: no /props,
the context size (2048) only in the model list's `max_model_len`, models `owned_by`
"vllm", and tool calling not enabled (any request with `tools` gets vLLM's 400).

Outages: `state.down = "refuse"` closes every connection without an answer (the page
sees "Failed to fetch"), `"503"` answers chat requests with a 503; `state.fail_next` is a
list of modes ("refuse", "503", "drop", "stall") consumed one per chat request, where
"drop" streams part of the reply and then closes the connection without finishing it,
and "stall" streams part of it and then goes silent for 3 s. A reply
with `then_down` sets `state.down` to that mode once it has been sent. A reply with
`alt: [substring, reply]` is replaced by that reply when the last user message contains
the substring (a note sent with ⚡ Send now, say).

Native tool calls (Phase 3): a reply's `tool_calls` ([{name, arguments}], arguments a dict
or a raw string; `id` optional, `no_id` leaves it out) are streamed as OpenAI deltas,
arguments in pieces, finish_reason "tool_calls". Under /tools/v1 the mock's /props reports
tool support (chat_template_caps); under /notools/v1 it reports support too but answers
any request with `tools` like llama.cpp without --jinja (a 500 naming the tools param).
Every request's history is checked like a strict server would: each assistant
tool_calls entry answered by exactly one tool message right after it, arguments valid
JSON, and no tool messages at all in a request without `tools` (a 400 otherwise).
"""
import json
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


SUMMARY = "## Task\nMock task.\n## Done so far\nMOCK-SUMMARY of the earlier steps."
SUMMARISER_MARK = "You compress the history of an AI agent's session"


class MockState:
    def __init__(self, scripts):
        self.scripts = scripts          # keyword -> [ {reasoning, content, finish} ]
        self.requests = []              # chat request bodies
        self.exfil = []                 # (method, path) of every /exfil hit
        self.lock = threading.Lock()
        self.down = None                # None | "refuse" | "503"
        self.fail_next = []             # one mode per chat request: "refuse" | "503" | "drop"


def tool_sequence_error(body):
    """What a strict OpenAI server would refuse in this history, or None."""
    msgs = body.get("messages", [])
    has_tools = bool(body.get("tools"))
    i = 0
    while i < len(msgs):
        m = msgs[i]
        if m["role"] == "tool":
            return f"messages[{i}]: a tool message that answers no tool call"
        if m.get("tool_calls"):
            if not has_tools:
                return f"messages[{i}]: tool_calls in a request without tools"
            ids = []
            for c in m["tool_calls"]:
                try:
                    json.loads(c["function"]["arguments"])
                except (KeyError, TypeError, ValueError):
                    return f"messages[{i}]: tool call arguments are not valid JSON"
                ids.append(c["id"])
            j, got = i + 1, []
            while j < len(msgs) and msgs[j]["role"] == "tool":
                got.append(msgs[j].get("tool_call_id"))
                j += 1
            if sorted(got) != sorted(ids):
                return f"messages[{i}]: tool calls {ids} answered by {got}"
            i = j
            continue
        i += 1
    return None


def make_handler(state):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def cors(self):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

        def send_json(self, code, obj):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def record_exfil(self):
            if self.path.startswith("/exfil"):
                with state.lock:
                    state.exfil.append((self.command, self.path))
                return True
            return False

        def do_OPTIONS(self):
            self.record_exfil()
            self.send_response(204)
            self.cors()
            self.send_header("Content-Length", "0")
            self.end_headers()

        def refuse(self):
            # Close without a byte of answer: the browser reports a network error.
            self.close_connection = True
            try:
                self.connection.shutdown(2)
            except OSError:
                pass

        def do_GET(self):
            if state.down == "refuse":
                return self.refuse()
            if self.record_exfil():
                return self.send_json(200, {"got": "it"})
            if self.path.startswith("/vllm/"):   # vLLM: no /props, the size is in the model list
                if self.path.endswith("/models"):
                    return self.send_json(200, {"object": "list", "data": [{"id": "mock-model", "object": "model", "owned_by": "vllm", "max_model_len": 2048}]})
                return self.send_json(404, {"error": {"message": "not found"}})
            if self.path == "/props":   # llama.cpp's: context size only, no template
                return self.send_json(200, {"default_generation_settings": {"n_ctx": 4096}})
            if self.path in ("/tools/props", "/notools/props"):   # llama.cpp --jinja with a tool-capable template
                return self.send_json(200, {"default_generation_settings": {"n_ctx": 4096},
                                            "chat_template_caps": {"supports_tools": True, "supports_tool_calls": True}})
            if self.path.endswith("/models"):
                return self.send_json(200, {"data": [{"id": "mock-model"}]})
            self.send_json(404, {"error": {"message": "not found"}})

        def do_POST(self):
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b""
            if self.record_exfil():
                return self.send_json(200, {"got": "it"})
            if not self.path.endswith("/chat/completions"):
                return self.send_json(404, {"error": {"message": "not found"}})
            body = json.loads(raw or b"{}")
            with state.lock:
                mode = state.fail_next.pop(0) if state.fail_next else state.down
                if mode not in ("refuse", "503", "stall"):
                    state.requests.append(body)
            if mode == "refuse":
                return self.refuse()
            if mode == "503":
                return self.send_json(503, {"error": {"message": "Loading model"}})
            if body.get("tools") and self.path.startswith("/notools/"):
                return self.send_json(500, {"error": {"message": "tools param requires --jinja flag"}})
            if body.get("tools") and self.path.startswith("/vllm/"):   # vLLM without --enable-auto-tool-choice
                return self.send_json(400, {"error": {"message": '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set'}})
            bad = tool_sequence_error(body)
            if bad:
                return self.send_json(400, {"error": {"message": "invalid history: " + bad}})
            msgs = body.get("messages", [])
            first_user = next((m["content"] for m in msgs if m["role"] == "user"), "")
            if msgs and SUMMARISER_MARK in msgs[0]["content"]:
                reply = {"content": SUMMARY}
            else:
                compacted = re.search(r'<history_summary steps="1-(\d+)">', first_user)
                turn = sum(1 for m in msgs if m["role"] == "assistant") + (int(compacted.group(1)) if compacted else 0)
                script = next((v for k, v in state.scripts.items() if k in first_user), None)
                if script is None or turn >= len(script):
                    return self.send_json(500, {"error": {"message": f"mock has no reply for turn {turn}"}})
                reply = script[turn]
                if reply.get("alt") and reply["alt"][0] in msgs[-1]["content"]:
                    reply = reply["alt"][1]
                if reply.get("overflow_unless_compacted") and not compacted:
                    return self.send_json(400, {"error": {"message": "the request exceeds the available context size, try increasing it"}})
            self.send_response(200)
            self.cors()
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.end_headers()

            def chunk(delta, finish=None, usage=None, timings=None):
                d = {"choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
                if usage:
                    d["usage"] = usage
                if timings:
                    d["timings"] = timings
                self.wfile.write(b"data: " + json.dumps(d).encode() + b"\n\n")
                self.wfile.flush()
                if reply.get("delay"):
                    time.sleep(reply["delay"])   # stream slowly, like a real model

            reasoning = reply.get("reasoning", "")
            content = reply.get("content", "")
            if mode == "drop":   # half a reply, then the connection just ends
                chunk({"content": content[:max(1, len(content) // 2)]})
                self.close_connection = True
                return
            if mode == "stall":  # half a reply, then silence (the page gives up on it)
                chunk({"content": content[:max(1, len(content) // 2)]})
                time.sleep(3)
                self.close_connection = True
                return
            calls = reply.get("tool_calls") or []
            try:
                for i in range(0, len(reasoning), 40):
                    chunk({"reasoning_content": reasoning[i:i + 40]})
                for i in range(0, len(content), 40):
                    chunk({"content": content[i:i + 40]})
                for k, c in enumerate(calls):
                    args = c["arguments"] if isinstance(c["arguments"], str) else json.dumps(c["arguments"])
                    head = {"index": k, "type": "function", "function": {"name": c["name"], "arguments": ""}}
                    if not c.get("no_id"):
                        head["id"] = c.get("id", f"call_{len(state.requests)}_{k}")
                    chunk({"tool_calls": [head]})
                    for i in range(0, len(args), 30):
                        chunk({"tool_calls": [{"index": k, "function": {"arguments": args[i:i + 30]}}]})
            except (BrokenPipeError, ConnectionResetError):
                return   # the page aborted the request (Stop, ⚡ Send now)
            chunk({}, reply.get("finish", "tool_calls" if calls else "stop"), reply.get("usage", {"prompt_tokens": 100, "completion_tokens": 20}),
                  {"cache_n": 60, "prompt_n": 40, "prompt_per_second": 500.0, "predicted_n": 20, "predicted_per_second": 33.3})
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            self.close_connection = True
            if reply.get("then_down"):
                state.down = reply["then_down"]

    return Handler


class QuietServer(ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        pass   # refused and aborted connections are part of the tests


def serve(scripts):
    """Start the mock on a free port; returns (server, port, state)."""
    state = MockState(scripts)
    server = QuietServer(("127.0.0.1", 0), make_handler(state))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1], state
