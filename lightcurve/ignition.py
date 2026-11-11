"""The link to ignition (https://github.com/ieatfood314/ignition).

Reads its burns and block list, and can add to the block list. ignition knows
nothing about lightcurve: this only uses its ordinary API.
"""

import json
import re
import threading
import time
import urllib.error
import urllib.request

TTL = 45

# Site names come from window titles, the block list wants addresses. These are the ones worth knowing
# by heart; anything else gets a guess the user can correct before it's sent.
DOMAINS = {
    "youtube": "youtube.com", "reddit": "reddit.com", "twitch": "twitch.tv", "netflix": "netflix.com",
    "x": "x.com", "twitter": "x.com", "instagram": "instagram.com", "tiktok": "tiktok.com",
    "facebook": "facebook.com", "hacker news": "news.ycombinator.com", "wikipedia": "wikipedia.org",
    "discord": "discord.com", "prime video": "primevideo.com", "disney+": "disneyplus.com",
    "bluesky": "bsky.app", "tumblr": "tumblr.com", "pinterest": "pinterest.com", "imgur": "imgur.com",
    "monkeytype": "monkeytype.com", "chess.com": "chess.com", "lichess": "lichess.org",
    "artificial analysis": "artificialanalysis.ai", "printables": "printables.com",
    "makerworld": "makerworld.com", "thingiverse": "thingiverse.com", "youtube music": "music.youtube.com",
    "crunchyroll": "crunchyroll.com", "threads": "threads.net", "9gag": "9gag.com",
}


def slug(s):
    return re.sub(r"[^a-z0-9]", "", s.lower())


def guess_domain(site):
    s = site.lower().strip()
    if s in DOMAINS:
        return DOMAINS[s]
    if re.match(r"^[a-z0-9-]+(\.[a-z0-9-]+)+$", s):
        return s
    return (slug(s) or "example") + ".com"


class Ignition:
    def __init__(self, url):
        self.url = (url or "").rstrip("/")
        self.lock = threading.Lock()
        self._at = 0
        self._burns = []
        self._settings = None
        self._state = None
        self.error = None if self.url else "not set"
        self.demo = None  # demo data stands in for a real ignition

    def _get(self, path, timeout=4):
        with urllib.request.urlopen(self.url + path, timeout=timeout) as r:
            return json.loads(r.read().decode())

    def refresh(self, force=False):
        if self.demo is not None or not self.url:
            return
        with self.lock:
            if not force and time.time() - self._at < TTL:
                return
            self._at = time.time()
            try:
                self._burns = self._get("/api/burns").get("burns") or []
                self._settings = self._get("/api/settings")
                self._state = self._get("/api/ignite")
                self.error = None
            except (OSError, ValueError, urllib.error.URLError) as e:
                self.error = str(getattr(e, "reason", e))[:120]

    @property
    def connected(self):
        return self.demo is not None or (bool(self.url) and self.error is None and self._settings is not None)

    def burns(self):
        """Every burn, as {id, start, end, minutes, early, live} in unix seconds."""
        if self.demo is not None:
            return self.demo["burns"]
        self.refresh()
        return self._burns

    def block(self):
        if self.demo is not None:
            return self.demo["block"]
        self.refresh()
        return (self._settings or {}).get("block") or {"sites": [], "apps": [], "programs": [], "games": False}

    def live(self):
        """The burn or countdown running right now, if any."""
        if self.demo is not None:
            return None
        self.refresh()
        s = self._state or {}
        if s.get("phase") in ("burning", "countdown") and s.get("session"):
            sess = s["session"]
            return {"phase": s["phase"], "starts_at": sess.get("starts_at"), "ends_at": sess.get("ends_at")}
        return None

    def blocked_test(self):
        """A function saying whether an app or site is already on ignition's block list."""
        block = self.block()
        sites = {slug(s.split(".")[0] if s.count(".") == 1 else s.rsplit(".", 2)[-2]) for s in block.get("sites", [])}
        full = {s.lower() for s in block.get("sites", [])}
        apps = {a["id"] if isinstance(a, dict) else a for a in block.get("apps", [])}
        programs = {p.lower() for p in block.get("programs", [])}
        games = bool(block.get("games"))

        def test(p):
            if p["kind"] == "site":
                name = p["id"].lower()
                return name in full or guess_domain(name) in full or slug(name) in sites
            app = p["id"]
            if app in apps or app.lower() in programs:
                return True
            return games and p.get("cat") == "play"
        return test

    def suggest(self, p):
        """How one form of a thing would go onto the block list: (list, value)."""
        if p["kind"] == "site":
            return "sites", guess_domain(p["id"])
        # Android package ids go on the phone's app list; anything else is a program on a computer.
        if re.match(r"^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$", p["id"]) and not p["id"].startswith(("org.kde.", "org.freedesktop.")):
            return "apps", p["id"]
        return "programs", p["id"].lower()

    def add_block(self, kind, value, label=""):
        """Add one thing to ignition's block list. ignition's own rules apply (nothing comes off mid-burn)."""
        if self.demo is not None:
            raise RuntimeError("This is demo data, so there is no ignition to change.")
        if not self.url:
            raise RuntimeError("No ignition address is set.")
        if kind not in ("sites", "apps", "programs"):
            raise ValueError("kind must be sites, apps or programs")
        value = str(value or "").strip()
        if not value:
            raise ValueError("Nothing to block.")
        settings = self._get("/api/settings")
        block = settings.setdefault("block", {})
        current = block.setdefault(kind, [])
        if kind == "apps":
            if not any((a.get("id") if isinstance(a, dict) else a) == value for a in current):
                current.append({"id": value, "label": label or value})
        elif value not in current:
            current.append(value)
        req = urllib.request.Request(self.url + "/api/settings", data=json.dumps(settings).encode(),
                                     headers={"Content-Type": "application/json"}, method="PUT")
        with urllib.request.urlopen(req, timeout=6) as r:
            saved = json.loads(r.read().decode())
        self.refresh(force=True)
        saved_block = (saved.get("settings") or saved).get("block") or self.block()
        kept = saved_block.get(kind, [])
        ok = any((a.get("id") if isinstance(a, dict) else a) == value for a in kept) if kind == "apps" else value in kept
        if not ok:
            raise RuntimeError(f"ignition didn't accept “{value}”. Check the spelling: sites need an address "
                               "like example.com, programs a command name.")
        return saved_block
