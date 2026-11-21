#!/usr/bin/env python3
"""Сервер отметок для табло артефактов.

Один endpoint: GET — текущее состояние, POST — влить отметки и получить слитое.
Слияние по задачам: для каждого id побеждает запись с бо́льшим ts (мс, часы
устройства). Так галочки с телефона и с компьютера не затирают друг друга.

Хранилище: <STATE_DIR>/state.json, снимки каждые 20 ревизий в <STATE_DIR>/history.
Ключ доступа: systemd LoadCredential (файл /etc/board-sync/key), передаётся
заголовком X-Board-Key. Без ключа — 401 на всё, кроме /health.

Состояние:
  {"rev": 12, "updatedAt": 1795269045720,
   "marks": {"w1-01": {"done": true, "doneAt": "2026-10-08T10:01:25.398Z", "ts": 1795269045720}}}
"""
import hmac
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATE_DIR = os.environ.get("STATE_DIR", "/var/lib/board-sync")
STATE_FILE = os.path.join(STATE_DIR, "state.json")
HISTORY_DIR = os.path.join(STATE_DIR, "history")
MAX_BODY = 512 * 1024
MAX_HISTORY = 30


def read_key():
    env = os.environ.get("BOARD_SYNC_KEY", "").strip()
    if env:
        return env
    for base in (os.environ.get("CREDENTIALS_DIRECTORY"), "/etc/board-sync"):
        if not base:
            continue
        path = os.path.join(base, "key")
        try:
            with open(path, encoding="utf-8") as f:
                key = f.read().strip()
            if key:
                return key
        except OSError:
            continue
    sys.exit("key not found: expected $CREDENTIALS_DIRECTORY/key or /etc/board-sync/key")


KEY = read_key()
LOCK = threading.Lock()


def now_ms():
    return int(time.time() * 1000)


def load():
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            st = json.load(f)
    except (OSError, ValueError):
        st = {"rev": 0, "marks": {}}
    st.setdefault("marks", {})
    st.setdefault("rev", 0)
    return st


def snapshot(st):
    try:
        os.makedirs(HISTORY_DIR, exist_ok=True)
        with open(os.path.join(HISTORY_DIR, "state-%08d.json" % st["rev"]), "w", encoding="utf-8") as f:
            json.dump(st, f, ensure_ascii=False, separators=(",", ":"))
        old = sorted(os.listdir(HISTORY_DIR))[:-MAX_HISTORY]
        for name in old:
            os.remove(os.path.join(HISTORY_DIR, name))
    except OSError:
        pass


def save(st):
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(st, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, STATE_FILE)
    if st["rev"] % 20 == 0:
        snapshot(st)


def merge(st, incoming):
    """Вливает отметки. Возвращает True, если состояние изменилось."""
    marks = st["marks"]
    changed = False
    for tid, rec in (incoming or {}).items():
        if not isinstance(rec, dict) or not isinstance(tid, str) or len(tid) > 64:
            continue
        done = bool(rec.get("done"))
        done_at = rec.get("doneAt") or None
        if not isinstance(done_at, str) or len(done_at) > 40:
            done_at = None
        try:
            ts = int(rec.get("ts") or 0)
        except (TypeError, ValueError):
            ts = 0
        cur = marks.get(tid)
        if cur is not None:
            cur_ts = int(cur.get("ts") or 0)
            # старее — не трогаем; на равном ts выигрывает «выполнено»
            if ts < cur_ts or (ts == cur_ts and (not done or cur.get("done"))):
                continue
        new = {"done": done, "doneAt": done_at if done else None, "ts": ts}
        if cur != new:
            marks[tid] = new
            changed = True
    if changed:
        st["rev"] = int(st.get("rev") or 0) + 1
        st["updatedAt"] = now_ms()
    return changed


class Handler(BaseHTTPRequestHandler):
    server_version = "board-sync/1"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    # ── helpers ──
    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Board-Key")
        self.send_header("Access-Control-Max-Age", "86400")
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Vary", "Origin")

    def reply(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(code)
        self.cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authorized(self):
        got = self.headers.get("X-Board-Key", "")
        return hmac.compare_digest(got.encode(), KEY.encode())

    def path_only(self):
        return self.path.split("?", 1)[0].rstrip("/") or "/"

    # ── methods ──
    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        path = self.path_only()
        if path.endswith("/health"):
            with LOCK:
                st = load()
            self.reply(200, {"ok": True, "rev": st["rev"], "marks": len(st["marks"]), "serverTime": now_ms()})
            return
        if not self.authorized():
            self.reply(401, {"error": "bad key"})
            return
        with LOCK:
            st = load()
        self.reply(200, {"rev": st["rev"], "updatedAt": st.get("updatedAt"), "marks": st["marks"], "serverTime": now_ms()})

    def do_POST(self):
        if self.path_only().endswith("/health"):
            self.reply(405, {"error": "use GET"})
            return
        if not self.authorized():
            self.reply(401, {"error": "bad key"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY:
            self.reply(413, {"error": "bad body size"})
            return
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self.reply(400, {"error": "bad json"})
            return
        if not isinstance(payload, dict) or not isinstance(payload.get("marks", {}), dict):
            self.reply(400, {"error": "bad payload"})
            return
        with LOCK:
            st = load()
            merge(st, payload.get("marks"))
            if st["rev"]:
                save(st)
        self.reply(200, {"rev": st["rev"], "updatedAt": st.get("updatedAt"), "marks": st["marks"], "serverTime": now_ms()})


def main():
    os.makedirs(STATE_DIR, exist_ok=True)
    port = int(os.environ.get("PORT", "8791"))
    host = os.environ.get("HOST", "127.0.0.1")
    srv = ThreadingHTTPServer((host, port), Handler)
    srv.daemon_threads = True
    sys.stderr.write("board-sync listening on %s:%d, state=%s\n" % (host, port, STATE_FILE))
    srv.serve_forever()


if __name__ == "__main__":
    main()
