package ca.heeney.lightcurve

import android.app.AppOpsManager
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.pm.ApplicationInfo
import android.os.Process

/** Reads the phone's own usage log. Nothing is watched live; Android keeps the log whether or not this app runs. */
object Collector {
    /** How far back to look the first time. Android keeps roughly this much. */
    const val FIRST_REACH = 10L * 24 * 3600 * 1000

    fun hasAccess(ctx: Context): Boolean {
        val ops = ctx.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
        val mode = ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), ctx.packageName)
        return mode == AppOpsManager.MODE_ALLOWED
    }

    private val wanted = setOf(
        Ev.RESUMED, Ev.PAUSED, Ev.SCREEN_ON, Ev.SCREEN_OFF, Ev.KEYGUARD_HIDDEN, Ev.SHUTDOWN, Ev.STARTUP,
    )

    fun read(ctx: Context, from: Long, to: Long): List<Event> {
        val usm = ctx.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
        val events = usm.queryEvents(from, to) ?: return emptyList()
        val out = ArrayList<Event>()
        val e = UsageEvents.Event()
        while (events.getNextEvent(e)) {
            if (e.eventType in wanted) out.add(Event(e.timeStamp, e.eventType, e.packageName ?: "", e.className ?: ""))
        }
        return out
    }

    /** An app's proper name, and a first guess at what kind of thing it is. The hub's own rules come first. */
    fun describe(ctx: Context, pkg: String): Pair<String, String> {
        val pm = ctx.packageManager
        val info = runCatching { pm.getApplicationInfo(pkg, 0) }.getOrNull() ?: return "" to ""
        val label = runCatching { pm.getApplicationLabel(info).toString() }.getOrDefault("")
        @Suppress("DEPRECATION")
        val game = info.flags and ApplicationInfo.FLAG_IS_GAME != 0
        val hint = when {
            game || info.category == ApplicationInfo.CATEGORY_GAME -> "play"
            info.category == ApplicationInfo.CATEGORY_VIDEO || info.category == ApplicationInfo.CATEGORY_AUDIO ||
                info.category == ApplicationInfo.CATEGORY_NEWS -> "watch"
            info.category == ApplicationInfo.CATEGORY_SOCIAL -> "talk"
            info.category == ApplicationInfo.CATEGORY_PRODUCTIVITY -> "make"
            else -> ""
        }
        return label to hint
    }
}
