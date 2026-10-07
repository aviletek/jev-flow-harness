#!/usr/bin/env python3
"""Local Laya evaluator shim for the Jev flow harness.

Wraps `laya.Agent.system_one` behind a tiny HTTP endpoint on localhost so the
Node harness (server.js) can call it exactly like it calls TypeSafe's cloud
`/v1/systemone` — same {state, questions} in, same {model, answers, usage} out
(laya's answers already nest under `answers[qid]` with choice/score/noul +
probabilities + confidence, matching what index.html expects).

First run downloads model weights from Hugging Face (convaiinnovations/laya,
Apache-2.0) — needs internet once, then runs fully offline, CPU-only if no
CUDA is available.

Run:  python laya_server.py
Then in the harness, set "Jev" to "Laya (local, no key)" and hit Run.
"""
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = '127.0.0.1'
PORT = 7879

# Hugging Face's cache normally hardlinks/symlinks blobs into place, which
# needs Developer Mode (or admin) on Windows. Fall back to plain copies so
# this works out of the box there too.
os.environ.setdefault('HF_HUB_DISABLE_SYMLINKS', '1')

print('Loading Laya model (first run downloads weights from Hugging Face)...', file=sys.stderr)
import laya
_agent = laya.load('convaiinnovations/laya')
print('Laya ready.', file=sys.stderr)

# Serialize inference: this is a single-model prototyping shim, not a service
# meant to handle concurrent requests.
_lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write('%s - %s\n' % (self.address_string(), fmt % args))

    def _send(self, code, obj):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path not in ('/systemone', '/v1/systemone'):
            self._send(404, {'error': 'not found'})
            return

        length = int(self.headers.get('Content-Length', 0) or 0)
        raw = self.rfile.read(length) if length else b''
        try:
            payload = json.loads(raw or b'{}')
        except json.JSONDecodeError:
            self._send(400, {'error': 'bad request JSON'})
            return

        questions = payload.get('questions')
        if not questions:
            self._send(400, {'error': 'missing questions'})
            return
        state = payload.get('state', '')

        try:
            with _lock:
                result = _agent.system_one(state, questions)
        except Exception as e:
            self._send(500, {'error': str(e)})
            return

        self._send(200, result)


if __name__ == '__main__':
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print('\n  Laya local shim  ->  http://%s:%d\n  (Ctrl+C to stop)\n' % (HOST, PORT), file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
