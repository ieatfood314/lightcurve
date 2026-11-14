package ca.heeney.lightcurve

import android.content.Context
import android.os.SystemClock
import android.provider.Settings
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * The limits as the hub last gave them, kept on the phone so they hold with no hub in reach, plus the
 * unlocks this phone has given. An unlock runs on the clock that counts from boot, so moving the phone's
 * clock doesn't stretch it, and a restart ends it.
 */
object LimitStore {
    /** The unlock that opens lightcurve's own settings pages while limits are on. */
    const val GUARD = "guard"
    const val GUARD_GRANT = 5

    class Snapshot(val limits: List<Limit>, val guard: Boolean, val changesWait: Int, val fetched: Long)

    private val lock = Any()
    @Volatile private var cached: Snapshot? = null

    private fun file(ctx: Context) = File(ctx.applicationContext.filesDir, "limits.json")
    private fun prefs(ctx: Context) = ctx.applicationContext.getSharedPreferences("limits", Context.MODE_PRIVATE)

    fun get(ctx: Context): Snapshot {
        cached?.let { return it }
        synchronized(lock) {
            cached?.let { return it }
            val f = file(ctx)
            val snap = runCatching { if (f.exists()) parse(JSONObject(f.readText()), f.lastModified()) else null }.getOrNull()
                ?: Snapshot(emptyList(), true, 15, 0)
            cached = snap
            return snap
        }
    }

    /** Asks the hub for the limits. Blocking; call it off the main thread. Keeps the old ones if it can't. */
    fun fetch(ctx: Context): Boolean {
        val store = Store(ctx)
        if (store.hub.isEmpty()) return false
        return runCatching {
            val conn = URL("${store.hub}/api/limits?device=${store.deviceId}").openConnection() as HttpURLConnection
            val text = try {
                conn.connectTimeout = 8_000
                conn.readTimeout = 15_000
                if (conn.responseCode != 200) return false
                conn.inputStream.bufferedReader().readText()
            } finally {
                conn.disconnect()
            }
            val snap = parse(JSONObject(text), System.currentTimeMillis())
            synchronized(lock) {
                val f = file(ctx)
                val tmp = File(f.path + ".tmp")
                tmp.writeText(text)
                tmp.renameTo(f)
                cached = snap
            }
            LimitKeeper.recheck()
            true
        }.getOrDefault(false)
    }

    private fun parse(o: JSONObject, fetched: Long): Snapshot {
        val out = ArrayList<Limit>()
        val arr = o.optJSONArray("limits") ?: JSONArray()
        for (i in 0 until arr.length()) {
            val item = arr.getJSONObject(i)
            val l = item.getJSONObject("limit")
            val rules = ArrayList<Rule>()
            val rs = l.optJSONArray("rules") ?: JSONArray()
            for (j in 0 until rs.length()) {
                val r = rs.getJSONObject(j)
                val days = r.optJSONArray("days")?.let { d -> (0 until d.length()).map { d.getInt(it) }.toSet() } ?: ALL_DAYS
                rules.add(Rule(r.getString("kind"), r.optInt("minutes"), r.optInt("hours"), r.optString("from"),
                    r.optString("to"), days, r.optInt("rest")))
            }
            val u = l.optJSONObject("unlock")
            val unlock = u?.let { Unlock(it.optInt("hold", 5), it.optInt("wait", 3), it.optInt("grant", 10),
                if (it.isNull("per_day")) null else it.optInt("per_day")) }
            val m = item.optJSONObject("match") ?: JSONObject()
            fun strings(a: JSONArray?) = a?.let { x -> (0 until x.length()).map { x.getString(it) } } ?: emptyList()
            val others = item.optJSONArray("others")?.let { x ->
                (0 until x.length()).map { x.getJSONArray(it).let { p -> Iv(p.getLong(0), p.getLong(1)) } }
            } ?: emptyList()
            out.add(Limit(l.getString("id"), item.optString("label").ifEmpty { "This app" }, rules, unlock,
                strings(m.optJSONArray("apps")).toSet(), strings(m.optJSONArray("sites")).toSet(),
                strings(m.optJSONArray("names")), others))
        }
        val s = o.optJSONObject("settings") ?: JSONObject()
        return Snapshot(out, s.optBoolean("guard", true), s.optInt("changes_wait", 15), fetched)
    }

    // ---- unlocks ----

    private fun bootCount(ctx: Context): Int =
        runCatching { Settings.Global.getInt(ctx.contentResolver, Settings.Global.BOOT_COUNT) }.getOrDefault(-1)

    /** Milliseconds of the unlock still to run, or 0. */
    fun grantLeft(ctx: Context, id: String): Long {
        val p = prefs(ctx)
        val now = SystemClock.elapsedRealtime()
        // A restart ends it: the boot count changed, or the clock since boot is behind where it was.
        if (p.getInt("boot_$id", -2) != bootCount(ctx) || now < p.getLong("at_$id", Long.MAX_VALUE)) return 0
        return (p.getLong("until_$id", 0) - now).coerceAtLeast(0)
    }

    fun grant(ctx: Context, id: String, minutes: Int) {
        val p = prefs(ctx)
        val times = unlockTimes(ctx, id).filter { System.currentTimeMillis() - it < 2 * 86_400_000L } + System.currentTimeMillis()
        p.edit()
            .putInt("boot_$id", bootCount(ctx))
            .putLong("at_$id", SystemClock.elapsedRealtime())
            .putLong("until_$id", SystemClock.elapsedRealtime() + minutes * 60_000L)
            .putString("times_$id", times.joinToString(","))
            .apply()
        LimitKeeper.recheck()
    }

    fun unlockTimes(ctx: Context, id: String): List<Long> =
        (prefs(ctx).getString("times_$id", "") ?: "").split(',').mapNotNull { it.toLongOrNull() }

    /** Whether changing what keeps the limits (the hub, the accessibility service) needs the hold first. */
    fun guarded(ctx: Context): Boolean {
        val s = get(ctx)
        return s.guard && s.limits.isNotEmpty() && grantLeft(ctx, GUARD) == 0L
    }

    /** The unlock for lightcurve's own settings: as hard as the hardest limit, and never easier than a change. */
    fun guardUnlock(ctx: Context): Unlock {
        val s = get(ctx)
        val wait = maxOf(s.changesWait, s.limits.maxOfOrNull { it.unlock?.wait ?: s.changesWait } ?: 0)
        val hold = maxOf(5, s.limits.maxOfOrNull { it.unlock?.hold ?: 5 } ?: 5)
        return Unlock(hold, wait, GUARD_GRANT, null)
    }

    // ---- the phone's own time ----

    @Volatile private var ownAt = 0L
    @Volatile private var own: List<Span> = emptyList()

    /** This phone's spans over the last [HORIZON], read at most every few seconds unless [fresh]. */
    fun ownSpans(ctx: Context, fresh: Boolean = false): List<Span> {
        val now = System.currentTimeMillis()
        if (!fresh && now - ownAt < 5_000) return own
        if (!Collector.hasAccess(ctx)) return emptyList()
        val from = now - HORIZON
        // From an hour earlier, so an app that was already open when the horizon begins is still seen.
        val built = buildSpans(Collector.read(ctx, from - 3600_000L, now), now)
        own = splitBySite(built.spans, SiteLog.since(ctx, from - 3600_000L)).filter { it.end > from }
        ownAt = now
        return own
    }
}
