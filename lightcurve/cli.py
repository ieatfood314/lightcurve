"""The `lightcurve` command."""

import argparse
import datetime as dt
import json
import os
import re
import shutil
import sys
import urllib.error
import urllib.parse
import urllib.request

from . import core

HELP = """\
lightcurve: when your screens were lit, and what was on them

  lightcurve                 today so far
  lightcurve yesterday       or any day: 2026-11-08, -3 (three days ago), monday
  lightcurve week [N]        the last 7 (or N) days, a line each
  lightcurve things [N]      apps and sites over the last 7 (or N) days
  lightcurve apps|sites [N]  just the apps, or just the sites
  lightcurve devices         every device the hub knows, and when it last reported
  lightcurve status          this machine's tracker: what it's recording, what's waiting to send
  lightcurve sync            send what's waiting, now
  lightcurve connect URL     point this machine's tracker at a hub (connect none to stop)
  lightcurve name NAME       what this machine is called on the dashboard
  lightcurve open            the dashboard, in your browser

  lightcurve track           run the tracker (the systemd unit does this)
  lightcurve serve           run a hub (--host, --port, --db, --ignition URL, --demo)

Add --json to any report for the numbers behind it.
"""

SKY = {"make": (55, 108, 219), "talk": (47, 166, 175), "other": (130, 130, 130), "browse": (169, 146, 1),
       "watch": (180, 79, 0), "play": (237, 88, 122)}
INITIAL = {c[0]: c for c in core.CATEGORIES}
BLOCKS = " ▁▂▃▄▅▆▇█"
WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]


class Out:
    def __init__(self):
        self.color = sys.stdout.isatty() and not os.environ.get("NO_COLOR") and os.environ.get("TERM") != "dumb"
        self.width = min(shutil.get_terminal_size((80, 24)).columns, 100)

    def paint(self, text, rgb=None, dim=False, bold=False):
        if not self.color:
            return text
        codes = []
        if bold:
            codes.append("1")
        if dim:
            codes.append("2")
        if rgb:
            codes.append("38;2;%d;%d;%d" % rgb)
        return f"\033[{';'.join(codes)}m{text}\033[0m" if codes else text

    def cat(self, text, cat):
        return self.paint(text, SKY.get(cat))


def dur(seconds):
    return core.fmt_duration(seconds)


def clock(t0, offset):
    return dt.datetime.fromtimestamp(t0 + offset).strftime("%H:%M")


# ---- where the numbers come from ----

class Source:
    """A hub over HTTP if this machine has one, otherwise the tracker's own database."""

    def __init__(self):
        from . import tracker
        self.cfg = tracker.load_config()
        self.hub_url = (self.cfg.get("hub") or "").rstrip("/")
        self.note = None
        self._local = None
        self.mode = None
        candidates = [self.hub_url] if self.hub_url else []
        candidates.append("http://127.0.0.1:4625")  # a hub on this very machine
        for url in candidates:
            try:
                with urllib.request.urlopen(url + "/api/ping", timeout=3) as r:
                    if json.loads(r.read().decode()).get("name") == "lightcurve":
                        self.mode, self.url = "hub", url
                        return
            except (OSError, ValueError, urllib.error.URLError):
                continue
        path = tracker.local_db_path()
        if os.path.exists(path):
            from .hub import Hub
            self._local = Hub(path, ignition_url="")
            self.mode = "local"
            if self.hub_url:
                self.note = f"The hub at {self.hub_url} can't be reached, so this is this machine only."
            return
        if self.hub_url:
            sys.exit(f"The hub at {self.hub_url} can't be reached, and nothing has been recorded on this machine.")
        sys.exit("Nothing to show yet: no hub is set and no tracker has run here.\n"
                 "Start one with the install script, or see: lightcurve help")

    def get(self, name, **params):
        if self.mode == "hub":
            q = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
            with urllib.request.urlopen(f"{self.url}/api/{name}?{q}", timeout=20) as r:
                return json.loads(r.read().decode())
        q = {k: [str(v)] for k, v in params.items() if v is not None}
        if name == "summary":
            return self._local.summary(q)
        if name in ("apps", "sites", "things"):
            return self._local.apps(q, {"apps": "app", "sites": "site"}.get(name))
        if name == "devices":
            return self._local.devices()
        raise KeyError(name)


def parse_day(word):
    """today, yesterday, -3, monday (the most recent one), or a date."""
    today = dt.date.fromisoformat(core.today())
    w = (word or "today").lower()
    if w == "today":
        return today.isoformat()
    if w == "yesterday":
        return (today - dt.timedelta(days=1)).isoformat()
    if re.match(r"^-\d{1,4}$", w):
        return (today + dt.timedelta(days=int(w))).isoformat()
    for i, name in enumerate(WEEKDAYS):
        if name.startswith(w) and len(w) >= 3:
            back = (today.weekday() - i) % 7 or 7
            return (today - dt.timedelta(days=back)).isoformat()
    try:
        return dt.date.fromisoformat(w).isoformat()
    except ValueError:
        sys.exit(f"“{word}” isn't a day I understand. Try yesterday, -3, monday or 2026-11-08.")


# ---- reports ----

def curve_lines(out, s):
    """The day's light curve in two rows of text: 144 ten-minute points, two to a column."""
    curve, cats = s["curve"], s["curve_cat"]
    row = ""
    for i in range(0, len(curve), 2):
        pair = curve[i:i + 2]
        v = max(pair)
        cat = INITIAL.get(cats[i + pair.index(v)], "other")
        ch = BLOCKS[min(8, max(1, round(v * 8)))] if v > 0.02 else (out.paint("·", dim=True) if out.color else "·")
        row += out.cat(ch, cat) if v > 0.02 else ch
    axis = [" "] * 72
    for h in range(0, 24, 4):
        label = "%02d" % ((core.DAY_START_HOUR + h) % 24)
        axis[h * 3:h * 3 + 2] = label
    return row, out.paint("".join(axis), dim=True)


def show_day(out, s):
    date = dt.date.fromisoformat(s["date"])
    title = date.strftime("%A %-d %B")
    if s["date"] == core.today():
        title += ", so far"
    print(out.paint(title, bold=True))
    if s.get("legacy") and not s["lit"]:
        legacy = s["legacy"]
        print(f"{dur(legacy['seconds'])} on screen " + out.paint("(a total carried over from waytime; no timeline)", dim=True))
        for label, seconds, cat in legacy["apps"][:12]:
            print(f"  {out.cat('●', cat)} {label[:34]:<34} {dur(seconds):>8}")
        return
    if not s["lit"]:
        print("Nothing recorded.")
        for n in s.get("notes") or []:
            print(out.paint(f"  {n['name']} hasn't reported since {clock(s['t0'], n['since'])}.", dim=True))
        return
    line = f"{dur(s['lit'])} lit"
    usual = s.get("usual") or {}
    if usual.get("enough"):
        base = usual.get("lit_by_now") if s.get("in_progress") else usual.get("lit")
        if base:
            diff = s["lit"] - base
            word = "about the usual" if abs(diff) < max(600, base * 0.1) else \
                (f"{dur(abs(diff))} {'over' if diff > 0 else 'under'} your usual" +
                 (" by this time" if s.get("in_progress") else ""))
            line += out.paint(f"   {word}", dim=True)
    if s["summed"] > s["lit"] + 60:
        line += out.paint(f"   ({dur(s['summed'] - s['lit'])} of it on two screens at once)", dim=True)
    print(line)
    print()
    row, axis = curve_lines(out, s)
    print(row)
    print(axis)
    print()
    cats = [(c, v) for c, v in s["categories"].items() if v >= 30]
    print("   ".join(f"{out.cat('●', c)} {c} {dur(v)}" for c, v in sorted(cats, key=lambda r: -r[1])))
    devs = [d for d in s["devices"] if d["seconds"] >= 30]
    if len(devs) > 1:
        print(out.paint("   ".join(f"{d['name']} {dur(d['seconds'])}" for d in devs), dim=True))
    print()
    top = s["entities"][:10]
    most = max((e["seconds"] for e in top), default=1) or 1
    for e in top:
        bar = "█" * max(1, round(18 * e["seconds"] / most))
        visits = f"{e['sessions']} visit{'' if e['sessions'] == 1 else 's'}"
        print(f"  {e['label'][:28]:<28} {dur(e['seconds']):>8}  {out.cat(bar, e['cat'])}{' ' * (18 - len(bar))}"
              + out.paint(f"  {visits}", dim=True))
    att = s["attention"]
    bits = [f"{att['switches']} switches", f"{att['sittings']} sittings"]
    if att.get("pickups"):
        bits.append(f"{att['pickups']} phone pickups")
    if s.get("first", {}).get("at") is not None:
        bits.append(f"first light {clock(s['t0'], s['first']['at'])}")
    print()
    print(out.paint(" · ".join(bits), dim=True))
    for b in s.get("burns") or []:
        state = "burning now" if b.get("live") else "burn"
        print(out.paint(f"{state} {clock(s['t0'], b['start'])} to {clock(s['t0'], b['end'])}", (235, 235, 235)))
    for n in s.get("notes") or []:
        print(out.paint(f"{n['name']} hasn't reported since {clock(s['t0'], max(0, n['since']))}, "
                        "so this may be short.", dim=True))


def show_week(out, s, rows):
    most = max((r["lit"] for r in rows), default=1) or 1
    width = max(10, min(40, out.width - 36))
    for r in rows:
        date = dt.date.fromisoformat(r["date"])
        label = date.strftime("%a %-d %b")
        if not r["has_data"] and not r["legacy"]:
            print(f"{label:<11} {out.paint('nothing recorded', dim=True)}")
            continue
        bar = ""
        if r["legacy"]:
            bar = out.paint("░" * max(1, round(width * r["lit"] / most)), dim=True)
        else:
            for c in core.CATEGORIES:
                n = round(width * r["cats"].get(c, 0) / most)
                bar += out.cat("█" * n, c)
        tail = "  waytime total" if r["legacy"] else ("  burn " + dur(r["burn_seconds"]) if r["burn_seconds"] else "")
        print(f"{label:<11} {dur(r['lit']):>8}  {bar}{out.paint(tail, dim=True)}")
    counted = [r["lit"] for r in rows if (r["has_data"] or r["legacy"]) and r["date"] != core.today()]
    if counted:
        print(out.paint(f"\n{dur(sum(counted) / len(counted))} a day across {len(counted)} finished "
                        f"day{'' if len(counted) == 1 else 's'} with a record", dim=True))


def show_things(out, r):
    rows = r["rows"][:25]
    if not rows:
        print("Nothing recorded in that stretch.")
        return
    print(out.paint(f"The last {r['days']} days: {dur(r['lit'])} lit", bold=True))
    print(out.paint(f"  {'':<28} {'total':>8}  {'visits':>6}  {'typical':>8}  {'longest':>8}", dim=True))
    for e in rows:
        print(f"  {out.cat('●', e['cat'])} {e['label'][:26]:<26} {dur(e['seconds']):>8}  {e['sessions']:>6}  "
              f"{dur(e['median']):>8}  {dur(e['longest']):>8}")


def show_devices(out, r):
    if not r["devices"]:
        print("No device has reported yet.")
    for d in r["devices"]:
        silent = d["silent_for"]
        seen = "reporting now" if silent < 180 else f"last heard {dur(silent)} ago"
        print(f"{out.paint(d['name'], bold=True):<20} {d['kind']:<8} {d['platform'] or '?':<10} "
              f"{d['spans']:>7} spans   {seen}")
    ig = r.get("ignition") or {}
    if ig.get("url"):
        print(out.paint(f"\nignition at {ig['url']}: " + ("connected" if ig.get("connected") else
                                                          f"not reachable ({ig.get('error')})"), dim=True))


# ---- this machine's tracker ----

def tracker_call(method):
    try:
        import dbus
        obj = dbus.SessionBus().get_object("org.lightcurve.Tracker", "/org/lightcurve/Tracker")
        return getattr(obj, method)(dbus_interface="org.lightcurve.Tracker", timeout=20)
    except ImportError:
        return None
    except Exception:  # noqa: BLE001 (not running, or no session bus)
        return None


def cmd_status(out, as_json):
    from . import tracker
    raw = tracker_call("Status")
    if raw is None:
        cfg = tracker.load_config()
        if as_json:
            print(json.dumps({"running": False, "hub": cfg.get("hub", "")}))
            return 1
        print("The tracker isn't running in this session.")
        print(out.paint("Start it with: systemctl --user start lightcurve-tracker", dim=True))
        return 1
    st = json.loads(str(raw))
    if as_json:
        print(json.dumps(st, indent=2))
        return 0
    print(f"{out.paint(st['name'], bold=True)}  tracker {st['version']}")
    if st["now"]:
        what = st["now"]["site"] or core.pretty_app(st["now"]["app"])
        print(f"recording: {what}")
    else:
        why = "screen locked" if st["locked"] else "nobody at the keys" if st["idle"] else "nothing has focus"
        print(f"not recording: {why}")
    if not st["hub"]:
        print("no hub set: this machine keeps its own record (lightcurve connect URL to change that)")
    elif st["hub_error"]:
        print(f"hub {st['hub']}: can't be reached ({st['hub_error']}); {st['waiting']} spans waiting here")
    else:
        when = dt.datetime.fromtimestamp(st["last_push"]).strftime("%H:%M:%S") if st["last_push"] else "not yet"
        print(f"hub {st['hub']}: last sent {when}, {st['waiting']} waiting")
    return 0


def cmd_connect(args):
    from . import tracker
    if not args:
        cfg = tracker.load_config()
        print(cfg.get("hub") or "No hub set.")
        return 0
    url = args[0].strip().rstrip("/")
    cfg = tracker.load_config()
    if url.lower() in ("none", "off", "-"):
        cfg.pop("hub", None)
        tracker.save_config(cfg)
        print("Hub removed. This machine keeps its own record from here on.")
    else:
        if not re.match(r"^https?://", url):
            url = "http://" + url
        try:
            with urllib.request.urlopen(url + "/api/ping", timeout=6) as r:
                ok = json.loads(r.read().decode()).get("name") == "lightcurve"
        except (OSError, ValueError, urllib.error.URLError) as e:
            ok = False
            print(f"Couldn't reach a hub at {url} ({getattr(e, 'reason', e)}). Saved anyway; "
                  "spans wait here until it answers.")
        else:
            if not ok:
                sys.exit(f"{url} answered, but it isn't a lightcurve hub.")
            print(f"Connected to {url}.")
        cfg["hub"] = url
        tracker.save_config(cfg)
    restart_tracker()
    return 0


def restart_tracker():
    import subprocess
    try:
        active = subprocess.run(["systemctl", "--user", "is-active", "--quiet", "lightcurve-tracker"]).returncode == 0
        if active:
            subprocess.run(["systemctl", "--user", "restart", "lightcurve-tracker"], check=False)
    except OSError:
        pass


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    as_json = "--json" in argv
    argv = [a for a in argv if a != "--json"]
    cmd = argv[0] if argv else "today"
    rest = argv[1:]
    out = Out()

    if cmd in ("help", "-h", "--help"):
        print(HELP, end="")
        return 0
    if cmd in ("version", "--version", "-V"):
        print(core.VERSION)
        return 0
    if cmd in ("serve", "hub"):
        from . import hub
        p = argparse.ArgumentParser(prog="lightcurve serve")
        p.add_argument("--host", default="127.0.0.1")
        p.add_argument("--port", type=int, default=hub.DEFAULT_PORT)
        p.add_argument("--db")
        p.add_argument("--ignition", help="ignition's address; an empty string turns the link off")
        p.add_argument("--demo", action="store_true", help="serve made-up data, for a look around")
        a = p.parse_args(rest)
        return hub.serve(a.db, a.host, a.port, a.ignition, a.demo)
    if cmd == "track":
        from . import tracker
        return tracker.run()
    if cmd == "status":
        return cmd_status(out, as_json)
    if cmd == "sync":
        ok = tracker_call("Push")
        if ok is None:
            sys.exit("The tracker isn't running in this session.")
        print("Sent." if ok else "The hub couldn't be reached; everything is still waiting here.")
        return 0 if ok else 1
    if cmd == "connect":
        return cmd_connect(rest)
    if cmd == "name":
        from . import tracker
        cfg = tracker.load_config()
        if not rest:
            print(cfg.get("name") or "(the hostname)")
            return 0
        cfg["name"] = " ".join(rest)[:60]
        tracker.save_config(cfg)
        restart_tracker()
        print(f"This machine is now “{cfg['name']}”. If you renamed it on the dashboard, that name still wins.")
        return 0

    src = Source()
    if cmd == "open":
        import subprocess
        if src.mode != "hub":
            sys.exit("The dashboard lives on a hub, and this machine isn't connected to one.")
        print(src.url)
        if os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"):
            subprocess.Popen(["xdg-open", src.url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return 0

    def count(default):
        if rest and rest[0].isdigit():
            return max(1, min(366, int(rest[0])))
        return default

    try:
        if cmd in ("week", "history"):
            data = src.get("summary", date=core.today(), days=count(7))
            rows = data["week"]
            if as_json:
                print(json.dumps(rows, indent=2))
            else:
                show_week(out, data, rows)
        elif cmd in ("things", "apps", "sites"):
            data = src.get(cmd, days=count(7))
            print(json.dumps(data, indent=2)) if as_json else show_things(out, data)
        elif cmd == "devices":
            data = src.get("devices")
            print(json.dumps(data, indent=2)) if as_json else show_devices(out, data)
        else:
            data = src.get("summary", date=parse_day(cmd))
            print(json.dumps(data, indent=2)) if as_json else show_day(out, data)
    except (urllib.error.URLError, OSError) as e:
        sys.exit(f"The hub stopped answering: {getattr(e, 'reason', e)}")
    if src.note and not as_json:
        print(out.paint("\n" + src.note, dim=True))
    return 0
