package ca.heeney.lightcurve

import android.accessibilityservice.AccessibilityService
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.text.TextUtils
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.inputmethod.InputMethodManager
import android.widget.Toast
import java.util.concurrent.ConcurrentHashMap
import kotlin.concurrent.thread

/**
 * Keeps the limits. It is told which app comes to the front; when that app (or the site a browser shows,
 * from [SiteWatcher]) is over a limit, it sends you home and shows [BlockActivity] in its place.
 *
 * While limits are on it also stands in front of the pages that would switch it off: lightcurve's App
 * info (uninstall, force stop, clear storage), its accessibility and usage access switches and the
 * uninstall dialog. Those open after the same hold and wait. Only the window's text is checked, for the
 * word lightcurve; nothing is kept.
 */
class LimitKeeper : AccessibilityService() {
    private val main = Handler(Looper.getMainLooper())
    private val worker = Handler(android.os.HandlerThread("lightcurve-keeper").apply { start() }.looper)
    private var front = ""
    private var keyboards: Set<String> = emptySet()
    private var lastFetch = 0L
    private val warned = ConcurrentHashMap<String, Long>()
    private val tick = Runnable { check() }
    private var pendingGuard: String? = null
    private val lookGuard = Runnable { pendingGuard?.let { guardCheck(it) }; pendingGuard = null }

    override fun onServiceConnected() {
        instance = this
        keyboards = runCatching {
            (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager).inputMethodList.map { it.packageName }.toSet()
        }.getOrDefault(emptySet())
        fetchSoon()
        check()
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        main.removeCallbacksAndMessages(null)
        worker.looper.quitSafely()
        super.onDestroy()
    }

    override fun onInterrupt() {}

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        val pkg = event.packageName?.toString() ?: return
        if (pkg in GUARDED) {
            if (pendingGuard == null) main.postDelayed(lookGuard, 350)
            pendingGuard = pkg
        }
        if (event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return
        if (pkg == "com.android.systemui" || pkg in keyboards) return
        if (pkg == front && pkg != packageName) return
        front = pkg
        check()
    }

    private fun fetchSoon() {
        val now = SystemClock.elapsedRealtime()
        if (now - lastFetch < 5 * 60_000L && lastFetch > 0) return
        lastFetch = now
        thread(name = "lightcurve-limits") { LimitStore.fetch(applicationContext) }
    }

    /** Is what's in front over a limit? If not, look again when the nearest one could run out. */
    private fun check() {
        main.removeCallbacks(tick)
        val pkg = front
        if (pkg.isEmpty() || pkg == packageName) return
        val snap = LimitStore.get(this)
        if (snap.limits.isEmpty()) return
        fetchSoon()
        val site = SiteWatcher.showing[pkg] ?: ""
        val covering = snap.limits.filter { Limits.covers(it, pkg, site) }
        if (covering.isEmpty()) return
        // Reading the usage log takes a moment: not on the thread that hears about windows.
        worker.post {
            val now = System.currentTimeMillis()
            val own = LimitStore.ownSpans(this)
            var next = 60_000L
            var over: Pair<Limit, LimitState>? = null
            var warn: Limit? = null
            for (limit in covering) {
                val granted = LimitStore.grantLeft(this, limit.id)
                if (granted > 0) {
                    next = minOf(next, granted + 500)
                    continue
                }
                val state = Limits.evaluate(limit, Limits.usage(limit, own), now)
                if (state.blocked) {
                    over = limit to state
                    break
                }
                val left = state.left ?: continue
                next = minOf(next, left + 500)
                if (left in 1..60_000L && now - (warned[limit.id] ?: 0) > 10 * 60_000L) warn = limit
            }
            main.post {
                if (front != pkg) return@post
                over?.let { block(it.first, it.second, pkg); return@post }
                warn?.let {
                    warned[it.id] = now
                    Toast.makeText(this, "${it.label}: 1 minute left", Toast.LENGTH_SHORT).show()
                }
                main.removeCallbacks(tick)
                main.postDelayed(tick, next.coerceIn(2_000L, 60_000L))
            }
        }
    }

    private fun block(limit: Limit, state: LimitState, pkg: String) {
        if (BlockActivity.showing) return
        // Not home first: a video app sent home goes on playing in a little window. Covering it stops it.
        front = ""
        // The site a browser showed is only trusted until it is read again, or the browser would stay
        // blocked for whatever tab it opens on next.
        SiteWatcher.showing.remove(pkg)
        startActivity(BlockActivity.forLimit(this, limit, state, pkg))
    }

    // ---- standing in front of the off switches ----

    private fun guardCheck(pkg: String) {
        if (BlockActivity.showing || !LimitStore.guarded(this)) return
        val root = rootInActiveWindow ?: return
        try {
            if (root.packageName?.toString() != pkg) return
            val words = textOf(root).lowercase()
            val clock = CLOCK.any { it in words }
            if (!clock && ("lightcurve" !in words || DANGER.none { it in words })) return
            startActivity(BlockActivity.forGuard(this))
        } finally {
            @Suppress("DEPRECATION") root.recycle()
        }
    }

    private fun textOf(root: AccessibilityNodeInfo): String {
        val sb = StringBuilder()
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        var seen = 0
        while (queue.isNotEmpty() && seen < 600) {
            val n = queue.removeFirst()
            seen++
            n.text?.let { sb.append(it).append('\n') }
            n.contentDescription?.let { sb.append(it).append('\n') }
            for (i in 0 until n.childCount) n.getChild(i)?.let { queue.add(it) }
        }
        return sb.toString()
    }

    companion object {
        @Volatile private var instance: LimitKeeper? = null
        private val main = Handler(Looper.getMainLooper())

        /** Settings, and the dialogs that uninstall an app. */
        private val GUARDED = setOf(
            "com.android.settings", "com.google.android.packageinstaller", "com.android.packageinstaller",
            "com.google.android.permissioncontroller", "com.android.permissioncontroller",
        )
        /** Words on the pages that would switch lightcurve off (App info, its accessibility and usage switches). */
        private val DANGER = listOf(
            "uninstall", "force stop", "clear storage", "clear data", "clear cache", "use lightcurve limits",
            "lightcurve limits shortcut", "permit usage", "deactivate",
        )
        /** The phone's clock: moved, it would open every limit that goes by the time of day. */
        private val CLOCK = listOf("set time automatically", "automatic date", "use network-provided time", "set date")

        /** Look again at what's in front, now: the limits or an unlock changed. Safe from any thread. */
        fun recheck() {
            main.post { instance?.check() }
        }

        fun enabled(ctx: Context): Boolean {
            val flat = Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
            val me = ComponentName(ctx, LimitKeeper::class.java)
            val split = TextUtils.SimpleStringSplitter(':').apply { setString(flat) }
            return split.any { ComponentName.unflattenFromString(it) == me }
        }

        /** Brings back the app a limit stood in front of, once it has been unlocked. */
        fun reopen(ctx: Context, pkg: String) {
            if (pkg.isEmpty()) return
            val launch = ctx.packageManager.getLaunchIntentForPackage(pkg) ?: return
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
            runCatching { ctx.startActivity(launch) }
        }
    }
}
