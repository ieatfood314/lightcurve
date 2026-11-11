"""The hub: takes spans in from every device, keeps them, and serves the dashboard and its API.

Python standard library only. Run one of these on a machine your devices can
reach (a tailnet is ideal); it listens on loopback unless told otherwise.
"""

import gzip
import json
import mimetypes
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from . import core
from .ignition import Ignition

WEB = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web")
DEFAULT_PORT = 4625
DEFAULT_IGNITION = "http://127.0.0.1:4580"


class Hub:
    def __init__(self, db_path, ignition_url=None, demo=False):
        self.db = core.open_db(db_path)
        self.lock = threading.RLock()
        self.cache = core.Cache()
        self.demo = demo
        url = ignition_url if ignition_url is not None else core.kv_get(self.db, "ignition_url", DEFAULT_IGNITION)
        self.ignition = Ignition(url)
        if demo:
            raw = core.kv_get(self.db, "demo_ignition")
            self.ignition.demo = json.loads(raw) if raw else {"burns": [], "block": {}}

    # -- reads --

    def _date(self, q, key="date"):
        v = (q.get(key) or [""])[0]
        if re.match(r"^\d{4}-\d{2}-\d{2}$", v):
            return v
        return core.today()

    def day(self, q):
        date = self._date(q)
        with self.lock:
            r = core.day_report(self.db, date, self.cache, burns=self.ignition.burns(),
                                blocked=self.ignition.blocked_test() if self.ignition.connected else None)
        r["ignition"] = self.ignition_status()
        r["first_day"] = self.first_day()
        return r

    def range(self, q):
        end = self._date(q, "end")
        try:
            days = max(1, min(366, int((q.get("days") or ["28"])[0])))
        except ValueError:
            days = 28
        with self.lock:
            r = core.range_report(self.db, end, days, self.cache, burns=self.ignition.burns(),
                                  blocked=self.ignition.blocked_test() if self.ignition.connected else None)
        for e in r["candidates"]:
            for p in e["parts"]:
                p["list"], p["value"] = self.ignition.suggest(p)
        r["ignition"]["status"] = self.ignition_status()
        return r

    def first_day(self):
        with self.lock:
            row = self.db.execute("SELECT MIN(start) FROM spans").fetchone()
            legacy = self.db.execute("SELECT MIN(date) FROM legacy").fetchone()
        first = core.day_of(row[0] / 1000) if row and row[0] else None
        return {"spans": first, "legacy": legacy[0] if legacy else None}

    def ignition_status(self):
        ig = self.ignition
        ig.refresh()
        return {"url": ig.url, "connected": ig.connected, "error": None if ig.connected else ig.error,
                "live": ig.live() if ig.connected else None, "demo": ig.demo is not None}

    def devices(self):
        now = time.time()
        with self.lock:
            devs = core.devices(self.db)
            counts = dict(self.db.execute("SELECT device, COUNT(*) FROM spans GROUP BY device"))
            legacy = dict(self.db.execute("SELECT device, COUNT(DISTINCT date) FROM legacy GROUP BY device"))
        for d in devs:
            d["spans"] = counts.get(d["id"], 0)
            d["legacy_days"] = legacy.get(d["id"], 0)
            d["silent_for"] = round(now - d["last_seen"] / 1000)
        return {"devices": devs, "now": now, "version": core.VERSION, "ignition": self.ignition_status(),
                "demo": self.demo, "day_start_hour": core.DAY_START_HOUR}

    def summary(self, q):
        """A small account of a day and the week before it, for the terminal and the phone widget."""
        date = self._date(q)
        try:
            days = max(1, min(366, int((q.get("days") or ["7"])[0])))
        except ValueError:
            days = 7
        with self.lock:
            day = core.day_report(self.db, date, self.cache, burns=self.ignition.burns())
            week = core.range_report(self.db, date, days, self.cache, burns=self.ignition.burns())
        return {
            "date": date, "lit": day["lit"], "summed": day["summed"], "devices": day["devices"],
            "categories": day["categories"], "first": day["first"], "last": day["last"],
            "entities": [{k: e[k] for k in ("label", "cat", "seconds", "sessions", "devices")}
                         for e in day["entities"][:40]],
            "curve": [round(c["lit"], 2) if c else 0 for c in day["curve"]],
            "curve_cat": "".join(c["cat"][0] if c else "." for c in day["curve"]),
            "attention": {k: day["attention"][k] for k in ("switches", "pickups", "sittings")},
            "usual": {k: day["usual"].get(k) for k in ("lit", "lit_by_now", "enough", "days")},
            "burns": [{k: b[k] for k in ("start", "end", "minutes", "live")} for b in day["burns"]],
            "notes": day["notes"], "in_progress": day["in_progress"], "legacy": day["legacy"],
            "week": [{k: r[k] for k in ("date", "lit", "has_data", "legacy", "cats", "burn_seconds")}
                     for r in week["rows"]],
            "utc_offset": day["utc_offset"], "t0": day["t0"], "now": day["now"],
        }

    def apps(self, q, kind):
        """Totals per app or per site over the last N days, for the terminal."""
        end = self._date(q, "end")
        try:
            days = max(1, min(366, int((q.get("days") or ["7"])[0])))
        except ValueError:
            days = 7
        with self.lock:
            r = core.range_report(self.db, end, days, self.cache)
        rows = [e for e in r["census"] if any(p["kind"] == kind for p in e["parts"])] if kind else r["census"]
        return {"days": days, "end": end, "lit": r["lit"], "rows": rows[:60]}

    # -- writes --

    def ingest(self, body):
        with self.lock:
            result, touched = core.ingest(self.db, body)
            self.cache.drop(touched)
        return result

    def set_category(self, body):
        key, cat = str(body.get("key") or ""), body.get("cat")
        if not re.match(r"^n:.{1,200}$", key):
            raise ValueError("key must look like n:<name>")
        with self.lock, self.db:
            if cat in core.CATEGORIES:
                self.db.execute("INSERT INTO categories (key, cat) VALUES (?, ?) "
                                "ON CONFLICT(key) DO UPDATE SET cat = excluded.cat", (key, cat))
            else:
                self.db.execute("DELETE FROM categories WHERE key = ?", (key,))
            self.cache.drop()
        return {"ok": True, "key": key, "cat": cat if cat in core.CATEGORIES else None}

    def patch_device(self, dev_id, body):
        with self.lock, self.db:
            if "name" in body:
                name = str(body["name"] or "").strip()[:60]
                if name:
                    self.db.execute("UPDATE devices SET name = ?, renamed = 1 WHERE id = ?", (name, dev_id))
            if body.get("kind") in ("desktop", "laptop", "phone", "tablet"):
                self.db.execute("UPDATE devices SET kind = ? WHERE id = ?", (body["kind"], dev_id))
            self.cache.drop()
        return self.devices()

    def put_settings(self, body):
        if "ignition_url" in body:
            url = str(body["ignition_url"] or "").strip().rstrip("/")
            if url and not re.match(r"^https?://[^\s/]+", url):
                raise ValueError("The ignition address should start with http:// or https://")
            with self.lock, self.db:
                core.kv_set(self.db, "ignition_url", url)
            demo = self.ignition.demo
            self.ignition = Ignition(url)
            self.ignition.demo = demo
            self.ignition.refresh(force=True)
        return {"ok": True, "ignition": self.ignition_status()}

    def block(self, body):
        block = self.ignition.add_block(body.get("list"), body.get("value"), str(body.get("label") or "")[:80])
        return {"ok": True, "block": block}


def make_handler(hub):
    class Handler(BaseHTTPRequestHandler):
        server_version = "lightcurve/" + core.VERSION
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):  # quiet: the journal doesn't need every request
            pass

        def send(self, status, body, ctype="application/json", cache="no-cache"):
            if isinstance(body, (dict, list)):
                body = json.dumps(body, separators=(",", ":")).encode()
            elif isinstance(body, str):
                body = body.encode()
            headers = [("Content-Type", ctype), ("Cache-Control", cache)]
            if len(body) > 1024 and "gzip" in (self.headers.get("Accept-Encoding") or "") \
                    and not ctype.startswith(("image/png", "font/")):
                body = gzip.compress(body, 5)
                headers.append(("Content-Encoding", "gzip"))
            self.send_response(status)
            for k, v in headers:
                self.send_header(k, v)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def body(self):
            n = int(self.headers.get("Content-Length") or 0)
            if n > 64 * 1024 * 1024:
                raise ValueError("too large")
            raw = self.rfile.read(n) if n else b"{}"
            # A web page elsewhere can't send this header without asking first, and nothing here says yes.
            if "json" not in (self.headers.get("Content-Type") or "").lower():
                raise ValueError("send JSON, with Content-Type: application/json")
            if self.headers.get("Content-Encoding") == "gzip":
                raw = gzip.decompress(raw)
            data = json.loads(raw.decode() or "{}")
            if not isinstance(data, dict):
                raise ValueError("expected a JSON object")
            return data

        def static(self, path):
            rel = "index.html" if path in ("", "/") else path.lstrip("/")
            full = os.path.normpath(os.path.join(WEB, rel))
            if not full.startswith(WEB + os.sep) or not os.path.isfile(full):
                return self.send(404, {"error": "not found"})
            ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
            if full.endswith(".woff2"):
                ctype = "font/woff2"
            if full.endswith(".webmanifest"):
                ctype = "application/manifest+json"
            with open(full, "rb") as f:
                data = f.read()
            cache = "public, max-age=31536000, immutable" if "/fonts/" in full else "no-cache"
            self.send(200, data, ctype + ("; charset=utf-8" if ctype.startswith(("text/", "application/javascript"))
                                          else ""), cache)

        def route(self, method):
            url = urlparse(self.path)
            parts = [p for p in url.path.split("/") if p]
            q = parse_qs(url.query)
            if not parts or parts[0] != "api":
                if method in ("GET", "HEAD"):
                    return self.static(url.path)
                return self.send(405, {"error": "method not allowed"})
            r = parts[1:]
            if method == "GET":
                if r == ["ping"]:
                    return self.send(200, {"ok": True, "name": "lightcurve", "version": core.VERSION,
                                           "now": int(time.time() * 1000)})
                if r == ["day"]:
                    return self.send(200, hub.day(q))
                if r == ["range"]:
                    return self.send(200, hub.range(q))
                if r == ["devices"]:
                    return self.send(200, hub.devices())
                if r == ["summary"]:
                    return self.send(200, hub.summary(q))
                if r == ["apps"]:
                    return self.send(200, hub.apps(q, "app"))
                if r == ["sites"]:
                    return self.send(200, hub.apps(q, "site"))
                if r == ["things"]:
                    return self.send(200, hub.apps(q, None))
            elif method == "POST":
                if r == ["ingest"]:
                    return self.send(200, hub.ingest(self.body()))
                if r == ["ignition", "block"]:
                    return self.send(200, hub.block(self.body()))
            elif method == "PUT":
                if r == ["category"]:
                    return self.send(200, hub.set_category(self.body()))
                if r == ["settings"]:
                    return self.send(200, hub.put_settings(self.body()))
            elif method == "PATCH":
                if len(r) == 2 and r[0] == "devices":
                    return self.send(200, hub.patch_device(r[1], self.body()))
            return self.send(404, {"error": "not found"})

        def handle_method(self, method):
            try:
                self.route(method)
            except (ValueError, KeyError) as e:
                self.send(400, {"error": str(e)})
            except RuntimeError as e:
                self.send(409, {"error": str(e)})
            except BrokenPipeError:
                pass
            except Exception as e:  # noqa: BLE001
                print(f"{method} {self.path} failed: {e!r}", flush=True)
                try:
                    self.send(500, {"error": "The hub hit an error. Its log has the details."})
                except OSError:
                    pass

        def do_GET(self):
            self.handle_method("GET")

        def do_HEAD(self):
            self.handle_method("GET")

        def do_POST(self):
            self.handle_method("POST")

        def do_PUT(self):
            self.handle_method("PUT")

        def do_PATCH(self):
            self.handle_method("PATCH")

    return Handler


def serve(db_path=None, host="127.0.0.1", port=DEFAULT_PORT, ignition_url=None, demo=False):
    if demo:
        from . import demo as demo_mod
        db_path = db_path or os.path.join(os.environ.get("XDG_RUNTIME_DIR") or "/tmp", "lightcurve-demo.db")
        demo_mod.build(db_path)
    db_path = db_path or os.path.join(core.data_dir(), "hub.db")
    hub = Hub(db_path, ignition_url, demo=demo)
    server = ThreadingHTTPServer((host, port), make_handler(hub))
    server.daemon_threads = True

    def tidy():
        # Fold the write-ahead log into the main file now and then, so a plain file copy of it is a whole backup.
        while True:
            time.sleep(600)
            try:
                with hub.lock:
                    hub.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            except Exception as e:  # noqa: BLE001
                print(f"checkpoint failed: {e!r}", flush=True)

    threading.Thread(target=tidy, daemon=True, name="tidy").start()
    print(f"lightcurve hub {core.VERSION} on http://{host}:{port}  (data: {db_path})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
