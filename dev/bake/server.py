#!/usr/bin/env python3
"""Static server for the repo root + POST /__save?path=... used by the grip bake tool.
Writes are restricted to assets/weapons/ and src/data/."""
import os, sys, urllib.parse
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
ALLOWED = ('assets/weapons/', 'src/data/')

class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a): pass
    def do_POST(self):
        u = urllib.parse.urlparse(self.path); q = urllib.parse.parse_qs(u.query)
        rel = os.path.normpath(q.get('path', [''])[0]).replace('\\', '/')
        if u.path != '/__save' or not rel.startswith(ALLOWED):
            self.send_response(403); self.end_headers(); return
        data = self.rfile.read(int(self.headers['Content-Length']))
        dst = os.path.join(ROOT, rel); os.makedirs(os.path.dirname(dst), exist_ok=True)
        open(dst, 'wb').write(data)
        print('saved', rel, len(data), flush=True)
        self.send_response(200); self.end_headers(); self.wfile.write(b'ok')

ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1]) if len(sys.argv) > 1 else 8130), H).serve_forever()
