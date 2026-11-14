import datetime as dt
import json
import os
import tempfile
import unittest

from lightcurve import core, limits


def at(date, hh, mm=0, ss=0):
    d = dt.date.fromisoformat(date)
    return dt.datetime(d.year, d.month, d.day, hh, mm, ss).timestamp()


# 2026-03-09 is a Monday.
MON = "2026-03-09"
M = 60


def lim(*rules, unlock=limits.DEFAULT_UNLOCK, targets=("n:youtube",)):
    return limits.clean({"targets": list(targets), "rules": list(rules), "unlock": unlock})


class Rules(unittest.TestCase):
    def test_day_allowance(self):
        l = lim({"kind": "day", "minutes": 60})
        use = [[at(MON, 9), at(MON, 9, 40)]]
        s = limits.evaluate(l, use, at(MON, 12))
        self.assertFalse(s["blocked"])
        self.assertEqual(s["left"], 20 * M)
        use.append([at(MON, 13), at(MON, 13, 20)])
        s = limits.evaluate(l, use, at(MON, 13, 20))
        self.assertTrue(s["blocked"])
        self.assertEqual(s["until"], at("2026-03-10", 4))

    def test_day_counts_from_four(self):
        l = lim({"kind": "day", "minutes": 30})
        # 03:00 on Tuesday still belongs to Monday
        use = [[at(MON, 23), at("2026-03-10", 3)]]
        self.assertTrue(limits.evaluate(l, use, at("2026-03-10", 3))["blocked"])
        self.assertFalse(limits.evaluate(l, use, at("2026-03-10", 5))["blocked"])

    def test_day_only_on_its_days(self):
        l = lim({"kind": "day", "minutes": 0, "days": [5, 6]})
        self.assertFalse(limits.evaluate(l, [], at(MON, 12))["blocked"])
        self.assertTrue(limits.evaluate(l, [], at("2026-03-14", 12))["blocked"])

    def test_rolling_window(self):
        l = lim({"kind": "every", "minutes": 30, "hours": 4})
        use = [[at(MON, 8), at(MON, 8, 20)], [at(MON, 10), at(MON, 10, 10)]]
        s = limits.evaluate(l, use, at(MON, 10, 10))
        self.assertTrue(s["blocked"])
        # five minutes have to slide out: 08:05 + 4h
        self.assertEqual(s["until"], at(MON, 12, 5))
        self.assertFalse(limits.evaluate(l, use, at(MON, 12, 6))["blocked"])

    def test_closed_hours_across_midnight(self):
        l = lim({"kind": "block", "from": "22:00", "to": "07:00"})
        s = limits.evaluate(l, [], at(MON, 23))
        self.assertTrue(s["blocked"])
        self.assertEqual(s["until"], at("2026-03-10", 7))
        self.assertTrue(limits.evaluate(l, [], at("2026-03-10", 6, 59))["blocked"])
        s = limits.evaluate(l, [], at(MON, 21))
        self.assertFalse(s["blocked"])
        self.assertEqual(s["left"], 3600)

    def test_closed_belongs_to_the_day_it_starts(self):
        l = lim({"kind": "block", "from": "22:00", "to": "07:00", "days": [4]})  # Friday nights
        self.assertTrue(limits.evaluate(l, [], at("2026-03-14", 2))["blocked"])  # early Saturday
        self.assertFalse(limits.evaluate(l, [], at("2026-03-15", 2))["blocked"])  # early Sunday

    def test_window_allowance(self):
        l = lim({"kind": "window", "minutes": 20, "from": "09:00", "to": "17:00", "days": [0, 1, 2, 3, 4]})
        use = [[at(MON, 8), at(MON, 9, 10)], [at(MON, 12), at(MON, 12, 10)]]
        s = limits.evaluate(l, use, at(MON, 12, 10))
        self.assertTrue(s["blocked"])
        self.assertEqual(s["until"], at(MON, 17))
        self.assertFalse(limits.evaluate(l, use, at(MON, 17, 30))["blocked"])

    def test_stretch_needs_a_real_break(self):
        l = lim({"kind": "stretch", "minutes": 20, "rest": 30})
        # 15 min, a 10 min pause (too short to count), 5 more: one stretch of 20
        use = [[at(MON, 9), at(MON, 9, 15)], [at(MON, 9, 25), at(MON, 9, 30)]]
        s = limits.evaluate(l, use, at(MON, 9, 30))
        self.assertTrue(s["blocked"])
        self.assertEqual(s["until"], at(MON, 10))
        s = limits.evaluate(l, use, at(MON, 10))
        self.assertFalse(s["blocked"])
        self.assertEqual(s["left"], 20 * M)

    def test_tightest_rule_wins(self):
        l = lim({"kind": "day", "minutes": 120}, {"kind": "every", "minutes": 30, "hours": 2})
        use = [[at(MON, 9), at(MON, 9, 10)]]
        self.assertEqual(limits.evaluate(l, use, at(MON, 9, 10))["left"], 20 * M)

    def test_bad_input(self):
        for bad in ({"targets": [], "rules": [{"kind": "day", "minutes": 5}]},
                    {"targets": ["n:x"], "rules": []},
                    {"targets": ["n:x"], "rules": [{"kind": "block", "from": "25:00", "to": "07:00"}]},
                    {"targets": ["c:nope"], "rules": [{"kind": "day", "minutes": 5}]}):
            with self.assertRaises(ValueError):
                limits.clean(bad)


class Loosening(unittest.TestCase):
    def test_tighter_is_not_loosening(self):
        old = lim({"kind": "day", "minutes": 60})
        new = dict(old, rules=[{"kind": "day", "minutes": 30, "days": limits.ALL_DAYS},
                               {"kind": "stretch", "minutes": 10, "rest": 10}])
        self.assertFalse(limits.loosens(old, new))

    def test_more_minutes_loosens(self):
        old = lim({"kind": "day", "minutes": 60})
        self.assertTrue(limits.loosens(old, dict(old, rules=[{"kind": "day", "minutes": 61, "days": limits.ALL_DAYS}])))

    def test_fewer_targets_or_easier_unlock_loosens(self):
        old = lim({"kind": "day", "minutes": 60}, targets=("n:youtube", "n:reddit"))
        self.assertTrue(limits.loosens(old, dict(old, targets=["n:youtube"])))
        self.assertTrue(limits.loosens(old, dict(old, unlock=dict(old["unlock"], wait=1))))
        strict = dict(old, unlock=None)
        self.assertTrue(limits.loosens(strict, old))
        self.assertFalse(limits.loosens(old, strict))

    def test_closed_hours_must_still_be_covered(self):
        old = lim({"kind": "block", "from": "22:00", "to": "07:00"})
        wider = dict(old, rules=[{"kind": "block", "from": "21:00", "to": "08:00", "days": limits.ALL_DAYS}])
        narrower = dict(old, rules=[{"kind": "block", "from": "23:00", "to": "07:00", "days": limits.ALL_DAYS}])
        self.assertFalse(limits.loosens(old, wider))
        self.assertTrue(limits.loosens(old, narrower))

    def test_deleting_loosens(self):
        self.assertTrue(limits.loosens(lim({"kind": "day", "minutes": 60}), None))


class Storage(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = core.open_db(os.path.join(self.tmp.name, "t.db"))

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def test_loosening_waits_and_tightening_does_not(self):
        t = at(MON, 9)
        made = limits.save(self.db, {"targets": ["n:youtube"], "rules": [{"kind": "day", "minutes": 60}]}, now=t)
        lid = made["limit"]["id"]
        later = t + 3600
        looser = limits.save(self.db, {"id": lid, "targets": ["n:youtube"], "rules": [{"kind": "day", "minutes": 90}]},
                             now=later)
        self.assertFalse(looser["applied"])
        self.assertEqual(looser["at"], int((later + 15 * 60) * 1000))
        row = limits.rows(self.db, later + 60)[0]
        self.assertEqual(row["limit"]["rules"][0]["minutes"], 60)
        self.assertEqual(row["pending"]["rules"][0]["minutes"], 90)
        row = limits.rows(self.db, later + 16 * 60)[0]
        self.assertEqual(row["limit"]["rules"][0]["minutes"], 90)
        self.assertIsNone(row["pending"])
        tighter = limits.save(self.db, {"id": lid, "targets": ["n:youtube"], "rules": [{"kind": "day", "minutes": 10}]},
                              now=later + 20 * 60)
        self.assertTrue(tighter["applied"])

    def test_a_new_limit_can_be_fixed_at_once(self):
        t = at(MON, 9)
        lid = limits.save(self.db, {"targets": ["n:x"], "rules": [{"kind": "day", "minutes": 5}]}, now=t)["limit"]["id"]
        self.assertTrue(limits.delete(self.db, lid, now=t + 60)["applied"])
        self.assertEqual(limits.rows(self.db, t + 61), [])

    def test_delete_waits_and_can_be_cancelled(self):
        t = at(MON, 9)
        lid = limits.save(self.db, {"targets": ["n:x"], "rules": [{"kind": "day", "minutes": 5}]}, now=t)["limit"]["id"]
        self.assertFalse(limits.delete(self.db, lid, now=t + 3600)["applied"])
        self.assertTrue(limits.rows(self.db, t + 3660)[0]["deleting"])
        limits.cancel(self.db, lid)
        self.assertEqual(len(limits.rows(self.db, t + 7200)), 1)

    def test_settings_shorter_wait_waits(self):
        t = at(MON, 9)
        r = limits.save_settings(self.db, {"changes_wait": 5}, now=t)
        self.assertFalse(r["applied"])
        self.assertEqual(limits.settings(self.db)["changes_wait"], 15)
        limits.settle(self.db, t + 15 * 60)
        self.assertEqual(limits.settings(self.db)["changes_wait"], 5)
        self.assertTrue(limits.save_settings(self.db, {"changes_wait": 30}, now=t + 3600)["applied"])

    def test_report_counts_every_device_and_tells_a_phone_what_to_match(self):
        now = at(MON, 12)
        body = lambda dev, kind, spans, names=None: {
            "device": {"id": dev, "name": dev, "kind": kind}, "names": names or {},
            "spans": [[int(a * 1000), int(b * 1000), app, site] for a, b, app, site in spans]}
        core.ingest(self.db, body("pc-1234", "desktop", [(at(MON, 9), at(MON, 9, 30), "firefox", "YouTube")]), now=now)
        core.ingest(self.db, body("phone-1234", "phone", [
            (at(MON, 9, 20), at(MON, 9, 50), "com.google.android.youtube", ""),
            (at(MON, 10), at(MON, 10, 5), "org.mozilla.firefox", "m.youtube.com"),
        ], {"com.google.android.youtube": {"label": "YouTube"}}), now=now)
        limits.save(self.db, {"targets": ["n:youtube"], "rules": [{"kind": "day", "minutes": 60}]}, now=now)
        r = limits.report(self.db, now=now, device="phone-1234")["limits"][0]
        # 09:00 to 09:50 with two screens overlapping, plus 10:00 to 10:05
        self.assertEqual(r["state"]["rules"][0]["used"], 55 * M)
        self.assertEqual(r["match"]["apps"], ["com.google.android.youtube"])
        self.assertEqual(r["match"]["sites"], ["m.youtube.com"])
        self.assertEqual(r["others"], [[int(at(MON, 9) * 1000), int(at(MON, 9, 30) * 1000)]])
        json.dumps(r)


if __name__ == "__main__":
    unittest.main()
