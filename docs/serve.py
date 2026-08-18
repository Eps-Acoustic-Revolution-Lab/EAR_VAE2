#!/usr/bin/env python3
"""Dev server for the εar-VAE2 demo page.

Why not `python3 -m http.server`: the stdlib server does not support HTTP
Range requests. Audio seeking / A-B switching at a preserved position relies
on ranges — without them some browsers restart playback from 0 on seek.
This server adds minimal single-range support on top of the stdlib handler.

Usage:
    python3 serve.py [port]        # default port 8000
"""
import os
import re
import sys
import http.server

ROOT = os.path.dirname(os.path.abspath(__file__))
RANGE_RE = re.compile(r"bytes=(\d+)-(\d*)")


class DemoHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):  # quieter logs
        pass

    def _serve_file_with_range(self, path):
        size = os.path.getsize(path)
        ctype = self.guess_type(path)
        start, end = 0, size - 1
        status = 200
        rng = self.headers.get("Range")
        if rng:
            m = RANGE_RE.match(rng.strip())
            if m:
                start = int(m.group(1))
                if m.group(2):
                    end = min(int(m.group(2)), size - 1)
                if start >= size or start > end:
                    self.send_response(416)
                    self.send_header("Content-Range", "bytes */%d" % size)
                    self.end_headers()
                    return
                status = 206
        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-cache")
        if status == 206:
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        self.end_headers()
        with open(path, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(256 * 1024, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    return
                remaining -= len(chunk)

    def do_GET(self):
        path = self.translate_path(self.path)
        if os.path.isfile(path) and self.headers.get("Range"):
            self._serve_file_with_range(path)
            return
        # default behavior, but always advertise range support
        if os.path.isfile(path):
            self._serve_file_with_range(path)
            return
        super().do_GET()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), DemoHandler)
    print("serving %s at http://127.0.0.1:%d" % (ROOT, port))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
