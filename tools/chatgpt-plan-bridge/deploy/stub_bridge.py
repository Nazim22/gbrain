# TEST-ONLY stand-in for the ChatGPT-plan bridge, used by batch-dryrun.test.sh. Never installed, never on a live port.
# Same status contract as the bridge (401 without the caller secret; 200 {halted, routes} with it), OpenAI-shaped chat
# completions, and the bridge's ledger row shape ({ts, status, finish, model}). <dir>/mode selects the behaviour per
# request: "ok" (one atom per call, served model gpt-6-luna) or "wrong-model" (served model gpt-4o, to fail H's gate).
# Usage: python3 -I stub_bridge.py <port> <secret-file> <ledger-file> <control-dir>
import datetime, hashlib, json, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
PORT, SECRET, LEDGER, CTL = int(sys.argv[1]), open(sys.argv[2]).read().strip(), sys.argv[3], sys.argv[4]

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code); self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def authed(self): return self.headers.get('Authorization') == f'Bearer {SECRET}'
    def do_GET(self):
        if self.path != '/v1/bridge/status': return self.send(404, {})
        if not self.authed(): return self.send(401, {'error': 'unauthorized'})
        self.send(200, {'halted': None, 'routes': ['gpt-6-luna@medium']})
    def do_POST(self):
        if not self.authed(): return self.send(401, {'error': 'unauthorized'})
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
        mode = open(f'{CTL}/mode').read().strip()
        served = 'gpt-4o' if mode == 'wrong-model' else 'gpt-6-luna'
        seed = hashlib.sha256(json.dumps(body.get('messages', ''), sort_keys=True).encode()).hexdigest()[:8]
        probe = any('Return exactly {"atoms":[]}' in str(m.get('content', '')) for m in body.get('messages', []))   # step B's real-call.ts prompt
        text = '{"atoms":[]}' if probe else json.dumps([{'title': f'Dry run lesson {seed}', 'atom_type': 'insight',
                            'body': f'A dry-run atom ({seed}) proves the batch pipeline end to end.'}])
        with open(LEDGER, 'a') as f:
            f.write(json.dumps({'ts': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'), 'status': 200, 'finish': 'stop', 'model': served}) + '\n')
        self.send(200, {'id': f'chatcmpl-{seed}', 'object': 'chat.completion', 'model': served,
                        'choices': [{'index': 0, 'finish_reason': 'stop', 'message': {'role': 'assistant', 'content': text}}],
                        'usage': {'prompt_tokens': 100, 'completion_tokens': 30, 'total_tokens': 130}})

ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
