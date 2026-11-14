"""App limits: what they are, how much of one is left, and which changes have to wait.

A limit covers some things (by name, `n:youtube`, or by category, `c:play`) and holds rules:

    {"kind": "day",     "minutes": 60, "days": [0..6]}                       up to 60 min a day
    {"kind": "every",   "minutes": 30, "hours": 4}                           up to 30 min in any 4 hours
    {"kind": "block",   "from": "22:00", "to": "07:00", "days": [...]}       closed between
    {"kind": "window",  "minutes": 20, "from": "09:00", "to": "17:00", "days": [...]}   up to 20 min between
    {"kind": "stretch", "minutes": 20, "rest": 30}                           20 min at a time, then 30 off

Days are Python weekdays (0 is Monday). A "day" rule follows lightcurve's day (04:00 to 04:00); a time
window belongs to the weekday it starts on. Time on every device counts, two at once counted once.

The phone keeps the limits (Limits.kt has the same rules as this file); the hub stores them, shows them,
and makes any change that loosens one wait (`changes_wait` minutes) before it takes effect.
"""

import json
import re
import secrets
import time
import datetime as dt

from . import core

KINDS = ("day", "every", "block", "window", "stretch")
ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]
HORIZON = 25 * 3600  # no rule looks further back than a day; an hour more for a stretch that began before it
REOPEN = 300  # a rolling limit opens again once this much (or the whole allowance, if smaller) is free
DEFAULT_UNLOCK = {"hold": 5, "wait": 3, "grant": 10, "per_day": None}
DEFAULT_SETTINGS = {"changes_wait": 15, "guard": True}
FRESH = 600  # a limit this new can still be changed at once: it hasn't held anything back yet
_TIME = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")


# ---- checking what is sent ----

def _int(v, lo, hi, what):
    try:
        n = int(v)
    except (TypeError, ValueError):
        raise ValueError(f"{what} should be a whole number") from None
    if not lo <= n <= hi:
        raise ValueError(f"{what} should be between {lo} and {hi}")
    return n


def _clock(v, what):
    if not isinstance(v, str) or not _TIME.match(v):
        raise ValueError(f"{what} should be a time like 07:30")
    return v


def _days(v):
    if v is None:
        return list(ALL_DAYS)
    days = sorted({_int(d, 0, 6, "a day") for d in v})
    if not days:
        raise ValueError("pick at least one day")
    return days


def clean_rule(r):
    if not isinstance(r, dict) or r.get("kind") not in KINDS:
        raise ValueError("a rule needs a kind: " + ", ".join(KINDS))
    k = r["kind"]
    if k == "day":
        return {"kind": k, "minutes": _int(r.get("minutes"), 0, 1440, "minutes"), "days": _days(r.get("days"))}
    if k == "every":
        return {"kind": k, "minutes": _int(r.get("minutes"), 0, 1440, "minutes"),
                "hours": _int(r.get("hours"), 1, 24, "hours")}
    if k == "block":
        a, b = _clock(r.get("from"), "from"), _clock(r.get("to"), "to")
        if a == b:
            raise ValueError("from and to are the same time")
        return {"kind": k, "from": a, "to": b, "days": _days(r.get("days"))}
    if k == "window":
        a, b = _clock(r.get("from"), "from"), _clock(r.get("to"), "to")
        if a == b:
            raise ValueError("from and to are the same time")
        return {"kind": k, "minutes": _int(r.get("minutes"), 0, 1440, "minutes"), "from": a, "to": b,
                "days": _days(r.get("days"))}
    return {"kind": k, "minutes": _int(r.get("minutes"), 1, 720, "minutes"),
            "rest": _int(r.get("rest"), 1, 720, "rest")}


def clean_unlock(u):
    if u is None:
        return None  # no unlocking at all
    if not isinstance(u, dict):
        raise ValueError("unlock should be an object or null")
    per_day = u.get("per_day")
    return {"hold": _int(u.get("hold", 5), 1, 60, "hold"), "wait": _int(u.get("wait", 3), 0, 120, "wait"),
            "grant": _int(u.get("grant", 10), 1, 240, "grant"),
            "per_day": None if per_day in (None, "", 0) else _int(per_day, 1, 50, "unlocks a day")}


def clean_target(t):
    t = str(t or "").strip()
    if t.startswith("c:") and t[2:] in core.CATEGORIES:
        return t
    if re.match(r"^n:.{1,200}$", t):
        return "n:" + t[2:].lower()
    raise ValueError("a target looks like n:<name> or c:<category>")


def clean(body):
    """A limit as it is kept, from what the dashboard sent."""
    if not isinstance(body, dict):
        raise ValueError("expected a limit")
    targets = []
    for t in body.get("targets") or []:
        t = clean_target(t)
        if t not in targets:
            targets.append(t)
    if not targets:
        raise ValueError("pick at least one app, site or kind")
    if len(targets) > 60:
        raise ValueError("too many targets")
    rules = [clean_rule(r) for r in (body.get("rules") or [])][:20]
    if not rules:
        raise ValueError("add at least one rule")
    lid = str(body.get("id") or "")
    if not re.match(r"^l-[a-z0-9]{4,16}$", lid):
        lid = "l-" + secrets.token_hex(4)
    name = str(body.get("name") or "").strip()[:60]
    given = body.get("labels") if isinstance(body.get("labels"), dict) else {}
    labels = {t: str(given.get(t) or "").strip()[:80] for t in targets if t.startswith("n:")}
    labels = {t: v for t, v in labels.items() if v}
    return {"id": lid, "name": name, "targets": targets, "labels": labels, "rules": rules,
            "unlock": clean_unlock(body.get("unlock", DEFAULT_UNLOCK))}


def clean_settings(body, current):
    out = dict(current)
    if "changes_wait" in body:
        out["changes_wait"] = _int(body["changes_wait"], 0, 24 * 60, "the wait for changes")
    if "guard" in body:
        out["guard"] = bool(body["guard"])
    return out


# ---- which changes loosen ----

def _minutes(hhmm):
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def _week_minutes(rule):
    """The minutes of the week a time window covers, Monday 00:00 being 0."""
    a, b = _minutes(rule["from"]), _minutes(rule["to"])
    length = (b - a) % 1440
    return {(d * 1440 + a + i) % 10080 for d in rule["days"] for i in range(length)}


def _rule_at_least(new, old):
    """Is `new` at least as strict as `old`?"""
    if new["kind"] != old["kind"]:
        return False
    k = new["kind"]
    if k == "day":
        return new["minutes"] <= old["minutes"] and set(new["days"]) >= set(old["days"])
    if k == "every":
        return new["minutes"] <= old["minutes"] and new["hours"] >= old["hours"]
    if k == "block":
        return _week_minutes(new) >= _week_minutes(old)
    if k == "window":
        return (new["from"], new["to"]) == (old["from"], old["to"]) and new["minutes"] <= old["minutes"] \
            and set(new["days"]) >= set(old["days"])
    return new["minutes"] <= old["minutes"] and new["rest"] >= old["rest"]


def loosens(old, new):
    """Would replacing `old` with `new` (None: deleting it) let anything through that `old` didn't?"""
    if new is None:
        return True
    if not set(new["targets"]) >= set(old["targets"]):
        return True
    ou, nu = old["unlock"], new["unlock"]
    if nu is not None:
        if ou is None:
            return True
        if nu["hold"] < ou["hold"] or nu["wait"] < ou["wait"] or nu["grant"] > ou["grant"]:
            return True
        if (nu["per_day"] or 10 ** 6) > (ou["per_day"] or 10 ** 6):
            return True
    return not all(any(_rule_at_least(n, o) for n in new["rules"]) for o in old["rules"])


def settings_loosen(old, new):
    return new["changes_wait"] < old["changes_wait"] or (old["guard"] and not new["guard"])


# ---- how much is left ----

def _local(date, hhmm):
    h, m = hhmm.split(":")
    return dt.datetime(date.year, date.month, date.day, int(h), int(m)).timestamp()


def _instances(rule, now):
    """The occurrences of a time window that start between yesterday and tomorrow, as (start, end)."""
    today = dt.datetime.fromtimestamp(now).date()
    out = []
    for back in (-1, 0, 1):
        d = today + dt.timedelta(days=back)
        if d.weekday() not in rule["days"]:
            continue
        a = _local(d, rule["from"])
        e_day = d if _minutes(rule["to"]) > _minutes(rule["from"]) else d + dt.timedelta(days=1)
        out.append((a, _local(e_day, rule["to"])))
    return out


def _used(usage, a, b):
    return core.total(core.clip(usage, a, b))


def _rule_state(rule, usage, now):
    """{"active", "used", "allowed", "blocked", "until", "left"} for one rule. `left` is how long until it
    blocks if nothing else changes; None when it can't block before something else happens."""
    k = rule["kind"]
    st = {"kind": k, "active": True, "used": 0, "allowed": None, "blocked": False, "until": None, "left": None}
    if k == "day":
        date = core.day_of(now)
        a, b = core.day_bounds(date)
        if dt.date.fromisoformat(date).weekday() not in rule["days"]:
            st["active"] = False
            return st
        st["used"], st["allowed"] = _used(usage, a, now), rule["minutes"] * 60
        st["left"] = st["allowed"] - st["used"]
        if st["left"] <= 0:
            st["blocked"], st["until"] = True, b
        return st
    if k == "every":
        span, allowed = rule["hours"] * 3600, rule["minutes"] * 60
        recent = core.clip(usage, now - span, now)
        st["used"], st["allowed"] = core.total(recent), allowed
        st["left"] = allowed - st["used"]
        if st["left"] <= 0:
            if allowed == 0:
                st["blocked"] = True  # nothing allowed, ever: no reopening time to give
                return st
            # Opens again once enough of the oldest time has slid out of the window.
            need, acc = st["used"] - allowed + min(allowed, REOPEN), 0
            for a, b in recent:
                if acc + (b - a) >= need:
                    st["until"] = a + (need - acc) + span
                    break
                acc += b - a
            st["blocked"] = True
        return st
    if k == "block":
        st["active"] = False
        starts = []
        for a, b in _instances(rule, now):
            if a <= now < b:
                st["active"] = st["blocked"] = True
                st["until"] = max(st["until"] or 0, b)
            elif a > now:
                starts.append(a)
        if not st["blocked"] and starts:
            st["left"] = min(starts) - now
        return st
    if k == "window":
        st["active"] = False
        for a, b in _instances(rule, now):
            if a <= now < b:
                st["active"] = True
                st["used"], st["allowed"] = _used(usage, a, now), rule["minutes"] * 60
                st["left"] = st["allowed"] - st["used"]
                if st["left"] <= 0:
                    st["blocked"], st["until"] = True, b
        return st
    # stretch: time joined across breaks shorter than the rest is one stretch
    rest, allowed = rule["rest"] * 60, rule["minutes"] * 60
    groups = core.merge(core.clip(usage, now - HORIZON, now), gap=rest)
    st["allowed"] = allowed
    if groups and now - groups[-1][1] < rest:
        g0, g1 = groups[-1]
        st["used"] = _used(usage, g0, g1)
        st["left"] = allowed - st["used"]
        if st["left"] <= 0:
            st["blocked"], st["until"] = True, g1 + rest
    else:
        st["left"] = allowed
    return st


def evaluate(limit, usage, now):
    """Where a limit stands. `usage` is the merged time on its targets, in seconds, over the last HORIZON."""
    rules = [_rule_state(r, usage, now) for r in limit["rules"]]
    blocking = [r for r in rules if r["blocked"]]
    out = {"rules": rules, "blocked": bool(blocking), "until": None, "left": None}
    if blocking:
        untils = [r["until"] for r in blocking]
        out["until"] = None if None in untils else max(untils)
    else:
        lefts = [r["left"] for r in rules if r["left"] is not None]
        out["left"] = max(0, min(lefts)) if lefts else None
    return out


# ---- what a limit covers ----

def matches(limit, namer, app, site):
    targets = limit["targets"]
    return namer.key(app, site) in targets or ("c:" + namer.category(app, site)) in targets


def usage_for(limit, spans, namer, exclude_device=None):
    """Merged [start, end] seconds on what the limit covers, from (device, a, b, app, site) spans."""
    return core.merge([[a, b] for d, a, b, app, site in spans
                       if d != exclude_device and matches(limit, namer, app, site)])


# ---- storage ----

def settings(db):
    raw = core.kv_get(db, "limit_settings")
    out = dict(DEFAULT_SETTINGS)
    if raw:
        out.update(json.loads(raw))
    return out


def settle(db, now=None):
    """Apply every waiting change whose time has come."""
    now = now if now is not None else time.time()
    ms_now = int(now * 1000)
    with db:
        for lid, pending in db.execute(
                "SELECT id, pending FROM limits WHERE pending IS NOT NULL AND pending_at <= ?", (ms_now,)).fetchall():
            if pending == "null":
                db.execute("DELETE FROM limits WHERE id = ?", (lid,))
            else:
                db.execute("UPDATE limits SET body = ?, pending = NULL, pending_at = NULL, updated = ? WHERE id = ?",
                           (pending, ms_now, lid))
        at = core.kv_get(db, "limit_settings_at")
        if at and int(at) <= ms_now:
            core.kv_set(db, "limit_settings", core.kv_get(db, "limit_settings_pending"))
            db.execute("DELETE FROM kv WHERE key IN ('limit_settings_pending', 'limit_settings_at')")


def rows(db, now=None):
    settle(db, now)
    out = []
    for lid, body, pending, pending_at, created in db.execute(
            "SELECT id, body, pending, pending_at, created FROM limits ORDER BY created"):
        out.append({"limit": json.loads(body), "pending": None if pending is None else json.loads(pending),
                    "pending_at": pending_at, "deleting": pending == "null", "created": created})
    return out


def would_wait(db, body, now=None):
    """Would saving this have to wait? For the dashboard, which asks for the hold only then."""
    now = now if now is not None else time.time()
    settle(db, now)
    new = clean(body)
    row = db.execute("SELECT body, created FROM limits WHERE id = ?", (new["id"],)).fetchone()
    wait = row is not None and int(now * 1000) - row[1] >= FRESH * 1000 and loosens(json.loads(row[0]), new)
    return {"wait": wait, "minutes": settings(db)["changes_wait"] if wait else 0}


def save(db, body, now=None):
    """Add or change a limit. Returns {"limit", "applied", "at"}: a change that loosens waits until `at`."""
    now = now if now is not None else time.time()
    ms_now = int(now * 1000)
    settle(db, now)
    new = clean(body)
    row = db.execute("SELECT body, created FROM limits WHERE id = ?", (new["id"],)).fetchone()
    with db:
        if not row:
            db.execute("INSERT INTO limits (id, body, created, updated) VALUES (?,?,?,?)",
                       (new["id"], json.dumps(new), ms_now, ms_now))
            return {"limit": new, "applied": True, "at": None}
        old, created = json.loads(row[0]), row[1]
        if ms_now - created < FRESH * 1000 or not loosens(old, new):
            db.execute("UPDATE limits SET body = ?, pending = NULL, pending_at = NULL, updated = ? WHERE id = ?",
                       (json.dumps(new), ms_now, new["id"]))
            return {"limit": new, "applied": True, "at": None}
        at = ms_now + settings(db)["changes_wait"] * 60_000
        db.execute("UPDATE limits SET pending = ?, pending_at = ? WHERE id = ?", (json.dumps(new), at, new["id"]))
        return {"limit": old, "applied": False, "at": at}


def delete(db, lid, now=None):
    now = now if now is not None else time.time()
    ms_now = int(now * 1000)
    settle(db, now)
    row = db.execute("SELECT created FROM limits WHERE id = ?", (lid,)).fetchone()
    if not row:
        raise ValueError("no such limit")
    with db:
        if ms_now - row[0] < FRESH * 1000:
            db.execute("DELETE FROM limits WHERE id = ?", (lid,))
            return {"applied": True, "at": None}
        at = ms_now + settings(db)["changes_wait"] * 60_000
        db.execute("UPDATE limits SET pending = 'null', pending_at = ? WHERE id = ?", (at, lid))
        return {"applied": False, "at": at}


def cancel(db, lid):
    """Drop a waiting change. Keeping a limit as it is never has to wait."""
    with db:
        db.execute("UPDATE limits SET pending = NULL, pending_at = NULL WHERE id = ?", (lid,))
    return {"ok": True}


def save_settings(db, body, now=None):
    now = now if now is not None else time.time()
    settle(db, now)
    old = settings(db)
    new = clean_settings(body, old)
    with db:
        if settings_loosen(old, new):
            at = int(now * 1000) + old["changes_wait"] * 60_000
            core.kv_set(db, "limit_settings_pending", json.dumps(new))
            core.kv_set(db, "limit_settings_at", at)
            return {"settings": old, "applied": False, "at": at}
        core.kv_set(db, "limit_settings", json.dumps(new))
        db.execute("DELETE FROM kv WHERE key IN ('limit_settings_pending', 'limit_settings_at')")
        return {"settings": new, "applied": True, "at": None}


def settings_would_wait(db, body):
    settle(db)
    old = settings(db)
    wait = settings_loosen(old, clean_settings(body, old))
    return {"wait": wait, "minutes": old["changes_wait"] if wait else 0}


def cancel_settings(db):
    with db:
        db.execute("DELETE FROM kv WHERE key IN ('limit_settings_pending', 'limit_settings_at')")
    return {"ok": True}


# ---- what the hub hands out ----

def report(db, now=None, device=None):
    """Every limit with where it stands. With `device`, also what that device needs to keep them: the apps
    and site domains each one covers, and the time other devices have spent on it lately."""
    now = now if now is not None else time.time()
    listing = rows(db, now)
    namer = core.Namer(db)
    spans = core.load_spans(db, now - HORIZON, now)
    out = []
    apps = sites = None
    if device:
        apps = {a for (a,) in db.execute("SELECT app FROM names")} | \
            {a for (a,) in db.execute("SELECT DISTINCT app FROM spans WHERE device = ?", (device,))}
        since = int((now - 60 * 86400) * 1000)
        sites = {s for (s,) in db.execute("SELECT DISTINCT site FROM spans WHERE site LIKE '%.%' AND end > ?",
                                          (since,))}
    for r in listing:
        lim = r["limit"]
        usage = usage_for(lim, spans, namer)
        item = {**r, "state": evaluate(lim, usage, now), "label": label(lim)}
        if device:
            item["match"] = {
                "apps": sorted(a for a in apps if matches(lim, namer, a, "")),
                "sites": sorted(s for s in sites if matches(lim, namer, "", s)),
                "names": [t[2:] for t in lim["targets"] if t.startswith("n:")],
            }
            item["others"] = [[int(a * 1000), int(b * 1000)] for a, b in usage_for(lim, spans, namer, device)]
        out.append(item)
    s = settings(db)
    pending_s = core.kv_get(db, "limit_settings_pending")
    return {"limits": out, "settings": s, "now": int(now * 1000),
            "settings_pending": json.loads(pending_s) if pending_s else None,
            "settings_at": int(core.kv_get(db, "limit_settings_at") or 0) or None,
            "day_start_hour": core.DAY_START_HOUR}


def label(limit):
    """What a limit is called when it hasn't been named: its targets, as they're shown."""
    if limit["name"]:
        return limit["name"]
    labels = limit.get("labels") or {}
    names = [t[2:].capitalize() if t.startswith("c:") else labels.get(t) or t[2:] for t in limit["targets"]]
    return ", ".join(names[:3]) + (f" and {len(names) - 3} more" if len(names) > 3 else "")
