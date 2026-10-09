"""A minimal OpenAI-compatible endpoint for the end-to-end tests (non-streamed, which
is all the Cleaner uses). Every chat request body is recorded in `state.requests`.

`state.mode` picks the behaviour of the next chat requests:
  "ok"         reword: the paragraph comes back prefixed with typographic junk (curly
               quotes, an em dash, a zero-width space), which the second cleanup pass
               must remove
  "english"    always answers in English (the language check must refuse it for German)
  "kwargs400"  400 for any request carrying chat_template_kwargs, like a strict server
  "401"        401 for every request
  "slow"       like "ok", but each answer takes 1.5 s (for Stop)
  "same"       answers with the passage unchanged
"""
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PREFIX = "\u201cNew\u201d \u2014 \u200b"
ENGLISH = "The committee looked at the plan again and decided that it will not be put to a vote this year at all."


class MockState:
    def __init__(self):
        self.mode = "ok"
        self.requests = []
        self.lock = threading.Lock()


def make_handler(state):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def send_json(self, code, obj):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self):
            if state.mode == "401":
                return self.send_json(401, {"error": {"message": "Invalid API key"}})
            if self.path.endswith("/models"):
                return self.send_json(200, {"object": "list", "data": [{"id": "mock-model", "object": "model"}]})
            self.send_json(404, {"error": {"message": "not found"}})

        def do_POST(self):
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
            if not self.path.endswith("/chat/completions"):
                return self.send_json(404, {"error": {"message": "not found"}})
            with state.lock:
                state.requests.append(body)
                mode = state.mode
            if mode == "401":
                return self.send_json(401, {"error": {"message": "Invalid API key"}})
            if mode == "kwargs400" and "chat_template_kwargs" in body:
                return self.send_json(400, {"error": {"message": "Unrecognized request argument: chat_template_kwargs"}})
            if mode == "slow":
                time.sleep(1.5)
            paragraph = body["messages"][-1]["content"]
            content = ENGLISH if mode == "english" else paragraph if mode == "same" else PREFIX + paragraph
            try:
                self.send_json(200, {"id": "x", "object": "chat.completion", "model": body.get("model"),
                                     "choices": [{"index": 0, "finish_reason": "stop",
                                                  "message": {"role": "assistant", "content": content}}]})
            except (BrokenPipeError, ConnectionResetError):
                pass   # the page aborted (Stop)

    return Handler


class QuietServer(ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        pass


def serve():
    """Start the mock on a free port; returns (server, port, state)."""
    state = MockState()
    server = QuietServer(("127.0.0.1", 0), make_handler(state))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1], state
