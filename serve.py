#!/usr/bin/env python3
"""Small local server for the Mannequin Viewer (standard library only)."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from threading import Timer
import webbrowser

HOST = "0.0.0.0"  # allow a phone on the same LAN to open the viewer
PORT = 8000
ROOT = Path(__file__).resolve().parent

class QuietHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        print("[viewer] " + (fmt % args))

if __name__ == "__main__":
    try:
        server = ThreadingHTTPServer((HOST, PORT), QuietHandler)
    except OSError as exc:
        raise SystemExit(f"Could not start the viewer on port {PORT}: {exc}\nClose the other app using port {PORT}, then run this again.")
    url = f"http://127.0.0.1:{PORT}/"
    print("Mannequin Viewer is ready.")
    print(f"Open: {url}")
    print("For a phone on the same Wi-Fi, open this PC's LAN IP on port 8000.")
    Timer(0.8, lambda: webbrowser.open_new_tab(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nViewer server stopped.")
    finally:
        server.server_close()
