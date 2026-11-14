"""Made-up data for trying lightcurve out and for the screenshots: `lightcurve hub --demo`.

It invents a person with a desktop, a laptop and a phone, ten weeks of
believable days, and a focus-timer habit. Every run gives the same history.
"""

import datetime as dt
import json
import math
import os
import random
import time

from . import core, limits

DESK, LAPTOP, PHONE = "demo-desk", "demo-laptop", "demo-phone"
DAYS = 70
LEGACY_DAYS = 40

MAKE = [("kitty", ""), ("dev.zed.Zed", ""), ("zen", "GitHub"), ("zen", "Stack Overflow"),
        ("md.obsidian.Obsidian", ""), ("zen", "MDN Web Docs"), ("org.freecad.FreeCAD", "")]
MAKE_W = [30, 34, 12, 6, 8, 5, 5]
DRIFT = [("zen", "YouTube"), ("zen", "Reddit"), ("zen", "Hacker News"), ("vesktop", ""), ("zen", "Wikipedia"),
         ("zen", "Printables"), ("spotify", "")]
DRIFT_W = [36, 22, 9, 16, 6, 6, 5]
GAMES = [("steam_app_1145360", ""), ("steam_app_367520", ""), ("org.prismlauncher.PrismLauncher", "")]
UTIL = [("org.kde.dolphin", ""), ("systemsettings", ""), ("org.kde.spectacle", "")]
PHONE_APPS = [
    ("com.google.android.apps.messaging", 20, (15, 90)), ("com.google.android.youtube", 13, (60, 900)),
    ("com.reddit.frontpage", 12, (40, 500)), ("com.instagram.android", 9, (30, 400)),
    ("com.android.chrome", 9, (20, 240)), ("com.spotify.music", 6, (8, 40)),
    ("org.thoughtcrime.securesms", 8, (15, 120)), ("com.google.android.gm", 5, (10, 80)),
    ("com.google.android.apps.maps", 2, (30, 200)), ("com.android.camera", 2, (10, 60)),
    ("com.google.android.deskclock", 2, (5, 20)), ("md.obsidian", 2, (20, 200)),
]
NAMES = {
    "com.google.android.apps.messaging": "Messages", "com.google.android.youtube": "YouTube",
    "com.reddit.frontpage": "Reddit", "com.instagram.android": "Instagram", "com.android.chrome": "Chrome",
    "com.spotify.music": "Spotify", "org.thoughtcrime.securesms": "Signal", "com.google.android.gm": "Gmail",
    "com.google.android.apps.maps": "Maps", "com.android.camera": "Camera",
    "com.google.android.deskclock": "Clock", "md.obsidian": "Obsidian", "com.demo.launcher": "Home screen",
    "steam_app_1145360": "Hades", "steam_app_367520": "Hollow Knight", "org.prismlauncher.PrismLauncher": "Minecraft",
    "dev.zed.Zed": "Zed", "vesktop": "Discord", "spotify": "Spotify", "org.freecad.FreeCAD": "FreeCAD",
}


def build(path):
    for suffix in ("", "-wal", "-shm"):
        if os.path.exists(path + suffix):
            os.remove(path + suffix)
    db = core.open_db(path)
    rng = random.Random(314)
    now = time.time()
    today = dt.date.fromisoformat(core.today(now))
    spans = {DESK: [], LAPTOP: [], PHONE: []}
    pickups, burns = [], []

    def add(device, a, b, app, site=""):
        if b - a >= 1 and a < now:
            spans[device].append([int(a * 1000), int(min(b, now) * 1000), app, site])

    def sitting(device, a, b, mood, burn=None):
        """Fill [a, b) with app spans. mood is the chance any given stretch is work."""
        t = a
        while t < b:
            in_burn = burn and burn[0] <= t < burn[1]
            after_burn = burn and burn[1] <= t < burn[1] + 1500
            p_make = 0.96 if in_burn else (0.25 if after_burn else mood)
            r = rng.random()
            if r < p_make:
                app, site = rng.choices(MAKE, MAKE_W)[0]
                length = rng.lognormvariate(5.3, 1.0)
            elif r < p_make + (1 - p_make) * 0.93:
                app, site = rng.choices(DRIFT, DRIFT_W)[0]
                length = rng.lognormvariate(4.6, 1.2)
            else:
                app, site = rng.choice(UTIL)
                length = rng.uniform(8, 70)
            length = max(4, min(length, 3000, b - t))
            add(device, t, t + length, app, site)
            t += length
            if rng.random() < 0.07:  # looked away, got a drink
                t += rng.uniform(190, 700)

    for i in range(DAYS - 1, -1, -1):
        date = today - dt.timedelta(days=i)
        t0 = core.day_bounds(date)[0] - core.DAY_START_HOUR * 3600  # midnight
        weekend = date.weekday() >= 5
        late = rng.random() < (0.45 if date.weekday() in (4, 5) else 0.12)
        wake = t0 + (rng.gauss(9.4, 0.8) if weekend else rng.gauss(7.2, 0.35)) * 3600
        sleep = t0 + (rng.gauss(25.2, 0.7) if late else rng.gauss(23.1, 0.5)) * 3600

        desk_ivs, burn = [], None
        if weekend:
            a = wake + rng.uniform(1.0, 2.5) * 3600
            for _ in range(rng.choice((2, 3))):
                length = rng.uniform(1.0, 3.2) * 3600
                if a + length > sleep - 600:
                    break
                desk_ivs.append((a, a + length))
                a += length + rng.uniform(0.6, 2.2) * 3600
        else:
            a = t0 + rng.gauss(16.3, 0.4) * 3600
            first = rng.uniform(1.3, 2.6) * 3600
            desk_ivs.append((a, a + first))
            a2 = a + first + rng.uniform(0.7, 1.4) * 3600
            if a2 < sleep - 3000:
                desk_ivs.append((a2, min(sleep - rng.uniform(300, 2400), a2 + rng.uniform(1.2, 3.4) * 3600)))
            if rng.random() < 0.62:
                ba = desk_ivs[0][0] + rng.uniform(200, 1500)
                minutes = rng.choice((30, 50, 50, 50, 60, 90))
                burn = (ba, ba + minutes * 60)
                burns.append({"id": f"demo{len(burns)}", "start": int(ba), "end": int(ba + minutes * 60),
                              "minutes": minutes, "planned": minutes, "source": "manual", "early": False,
                              "live": False})
        for k, (a, b) in enumerate(desk_ivs):
            gaming = (weekend or k == len(desk_ivs) - 1) and rng.random() < (0.5 if weekend else 0.28)
            if gaming and b - a > 3000:
                split = a + (b - a) * rng.uniform(0.3, 0.6)
                sitting(DESK, a, split, 0.45, burn)
                game = rng.choice(GAMES)
                add(DESK, split, b, game[0])
            else:
                sitting(DESK, a, b, 0.7 if not weekend else 0.4, burn)

        if not weekend and rng.random() < 0.7:  # the laptop goes to class
            a = t0 + rng.uniform(9.2, 10.5) * 3600
            for _ in range(rng.choice((1, 2, 2))):
                length = rng.uniform(25, 70) * 60
                sitting(LAPTOP, a, a + length, 0.78)
                a += length + rng.uniform(40, 110) * 60

        # the phone: all day, in small pieces
        t = wake
        add(PHONE, t, t + rng.uniform(120, 900), rng.choice(("com.reddit.frontpage", "com.google.android.youtube",
                                                             "com.google.android.apps.messaging")))
        pickups.append(int(t * 1000))
        t += rng.uniform(600, 2400)
        while t < sleep:
            at_desk = any(a <= t < b for a, b in desk_ivs)
            in_burn = burn and burn[0] <= t < burn[1]
            if in_burn and rng.random() < 0.85:
                t += rng.uniform(600, 1500)
                continue
            pickups.append(int(t * 1000))
            p = t
            add(PHONE, p, p + rng.uniform(2, 6), "com.demo.launcher")
            p += rng.uniform(2, 6)
            for _ in range(rng.choices((1, 2, 3), (62, 28, 10))[0]):
                app, _, (lo, hi) = rng.choices(PHONE_APPS, [w for _, w, _ in PHONE_APPS])[0]
                length = min(rng.lognormvariate(math.log((lo * hi) ** 0.5), 0.7), hi * 2)
                if in_burn and app in ("com.google.android.youtube", "com.reddit.frontpage", "com.instagram.android"):
                    continue
                add(PHONE, p, p + length, app)
                p += length + rng.uniform(0, 2)
            t = p + rng.expovariate(1 / (1500 if at_desk else 1000))
        # last look before sleep
        add(PHONE, sleep, sleep + rng.uniform(200, 1500), rng.choice(("com.google.android.youtube", "com.reddit.frontpage")))
        pickups.append(int(sleep * 1000))

    ms = int(now * 1000)
    first = min(s[0] for d in spans.values() for s in d)
    with db:
        for dev, name, kind, platform in ((DESK, "tycho", "desktop", "Plasma"), (LAPTOP, "kepler", "laptop", "Plasma"),
                                          (PHONE, "comet", "phone", "Android")):
            db.execute("INSERT INTO devices (id, name, kind, platform, version, first_seen, last_seen, synced_to) "
                       "VALUES (?,?,?,?,?,?,?,?)", (dev, name, kind, platform, core.VERSION, first, ms, ms))
            db.executemany("INSERT OR REPLACE INTO spans (device, start, end, app, site) VALUES (?,?,?,?,?)",
                           [(dev, *s) for s in spans[dev] if s[1] > s[0]])
        db.executemany("INSERT OR IGNORE INTO pickups (device, ts) VALUES (?,?)",
                       [(PHONE, p) for p in pickups if p < ms])
        for app, label in NAMES.items():
            db.execute("INSERT OR REPLACE INTO names (app, label, hint) VALUES (?,?,'')", (app, label))
        # before the spans begin: totals carried over from an older tracker
        for i in range(DAYS, DAYS + LEGACY_DAYS):
            date = (today - dt.timedelta(days=i)).isoformat()
            for app, lo, hi in (("zen", 3000, 9000), ("kitty", 1500, 6000), ("dev.zed.Zed", 1000, 7000),
                                ("steam_app_1145360", 0, 4000)):
                s = rng.uniform(lo, hi)
                if s > 600:
                    db.execute("INSERT OR REPLACE INTO legacy (device, date, app, seconds) VALUES (?,?,?,?)",
                               (DESK, date, app, s))
        block = {"sites": ["youtube.com", "reddit.com"], "apps": [{"id": "com.instagram.android", "label": "Instagram"}],
                 "programs": [], "games": True}
        core.kv_set(db, "demo_ignition", json.dumps({"burns": [b for b in burns if b["start"] < now], "block": block}))
    old = now - 3 * 86400
    for body in (
        {"targets": ["n:youtube"], "labels": {"n:youtube": "YouTube"},
         "rules": [{"kind": "day", "minutes": 60}, {"kind": "stretch", "minutes": 25, "rest": 20}]},
        {"name": "Feeds", "targets": ["n:reddit", "n:instagram", "n:hacker news"],
         "labels": {"n:reddit": "Reddit", "n:instagram": "Instagram", "n:hacker news": "Hacker News"},
         "rules": [{"kind": "every", "minutes": 20, "hours": 4}, {"kind": "block", "from": "22:30", "to": "07:00"}],
         "unlock": {"hold": 10, "wait": 5, "grant": 5, "per_day": 2}},
        {"name": "Games", "targets": ["c:play"],
         "rules": [{"kind": "block", "from": "08:00", "to": "17:00", "days": [0, 1, 2, 3, 4]},
                   {"kind": "day", "minutes": 90, "days": [5, 6]}], "unlock": None},
    ):
        limits.save(db, body, now=old)
    db.close()
    return path
