package ca.heeney.lightcurve

import android.accessibilityservice.AccessibilityService
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.TextUtils
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import java.io.File

/**
 * Notes which site a browser shows, by reading its address bar. Only browsers are listened to, only their
 * own toolbar is read (never the page), and only the domain is kept. The usage log still says when the
 * browser was in front; this only says what it was showing, so time is never counted from here.
 */
class SiteWatcher : AccessibilityService() {
    private val main = Handler(Looper.getMainLooper())
    private val last = HashMap<String, String>()
    private var pending: String? = null
    private val look = Runnable { pending?.let { look(it) }; pending = null }

    private val installs = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context, intent: Intent) = listenToBrowsers()
    }

    override fun onServiceConnected() {
        listenToBrowsers()
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_PACKAGE_ADDED)
            addAction(Intent.ACTION_PACKAGE_REMOVED)
            addDataScheme("package")
        }
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(installs, filter, RECEIVER_EXPORTED)
        else registerReceiver(installs, filter)
    }

    override fun onDestroy() {
        runCatching { unregisterReceiver(installs) }
        main.removeCallbacks(look)
        super.onDestroy()
    }

    override fun onInterrupt() {}

    /** Only browsers send events here; every other app goes unread. */
    private fun listenToBrowsers() {
        val info = serviceInfo ?: return
        info.packageNames = browsers(this).toTypedArray().ifEmpty { arrayOf(packageName) }
        serviceInfo = info
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        val pkg = event.packageName?.toString() ?: return
        // A page fires events all the time while it loads, scrolls or plays: look once things settle.
        if (pending == null) main.postDelayed(look, 1000)
        pending = pkg
    }

    private fun look(pkg: String) {
        val root = rootInActiveWindow ?: return
        try {
            if (root.packageName?.toString() != pkg) return
            // While you type, the bar holds suggestions, not where you are.
            if (root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)?.isEditable == true) return
            val host = addressBar(root)?.let { Sites.hostIn(it) } ?: return
            // The limits want to know what is showing now, even when it is the site noted last time.
            if (showing.put(pkg, host) != host) LimitKeeper.recheck()
            if (last[pkg] == host) return
            last[pkg] = host
            SiteLog.add(this, Mark(System.currentTimeMillis(), pkg, host))
        } finally {
            @Suppress("DEPRECATION") root.recycle()
        }
    }

    /**
     * The browser's own views (not the web page, not list rows such as suggestions or top sites), looking
     * for an address bar: first anything whose view id says it is one (Firefox keeps the address in the
     * content description of ADDRESSBAR_URL_BOX, Chrome in the text of url_bar), then any unfocused text
     * field, for browsers that name theirs something else.
     */
    private fun addressBar(root: AccessibilityNodeInfo): String? {
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        var seen = 0
        var field: String? = null
        while (queue.isNotEmpty() && seen < 800) {
            val n = queue.removeFirst()
            seen++
            if (n.collectionItemInfo != null || n.className?.contains("WebView") == true) continue
            val text = (n.text?.takeIf { it.isNotBlank() } ?: n.contentDescription)?.toString()
            if (!text.isNullOrBlank() && !n.isFocused && Sites.hostIn(text) != null) {
                if (Sites.isUrlBarId(n.viewIdResourceName)) return text
                if (field == null && (n.isEditable || n.className?.contains("EditText") == true)) field = text
            }
            for (i in 0 until n.childCount) n.getChild(i)?.let { queue.add(it) }
        }
        return field
    }

    companion object {
        /** The site each browser showed last, for the limits. */
        val showing = java.util.concurrent.ConcurrentHashMap<String, String>()

        /** Apps that open any web link. Apps that only open their own site's links (YouTube, Reddit) aren't. */
        fun browsers(ctx: Context): Set<String> {
            val probe = Intent(Intent.ACTION_VIEW, Uri.parse("https://example.com")).addCategory(Intent.CATEGORY_BROWSABLE)
            return ctx.packageManager.queryIntentActivities(probe, PackageManager.MATCH_ALL)
                .map { it.activityInfo.packageName }.filter { it != ctx.packageName }.toSet()
        }

        fun enabled(ctx: Context): Boolean {
            val flat = Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
            val me = ComponentName(ctx, SiteWatcher::class.java)
            val split = TextUtils.SimpleStringSplitter(':').apply { setString(flat) }
            return split.any { ComponentName.unflattenFromString(it) == me }
        }
    }
}

/** The marks, one a line: time, package, domain. Kept on the phone only as long as a sync could need them. */
object SiteLog {
    private val lock = Any()
    private fun file(ctx: Context) = File(ctx.applicationContext.filesDir, "sites.tsv")

    fun add(ctx: Context, m: Mark) = synchronized(lock) {
        file(ctx).appendText("${m.time}\t${m.pkg}\t${m.site}\n")
    }

    private fun all(ctx: Context): List<Mark> = synchronized(lock) {
        val f = file(ctx)
        if (!f.exists()) return emptyList()
        f.readLines().mapNotNull { line ->
            val p = line.split('\t')
            val t = p.getOrNull(0)?.toLongOrNull()
            if (p.size == 3 && t != null) Mark(t, p[1], p[2]) else null
        }
    }

    /** Marks from [from] on, plus each browser's last one before it: the tab a browser was left on. */
    fun since(ctx: Context, from: Long): List<Mark> {
        val marks = all(ctx)
        val before = marks.filter { it.time < from }.groupBy { it.pkg }.values.map { it.maxBy { m -> m.time } }
        return before + marks.filter { it.time >= from }
    }

    /** Forgets what no sync can need any more. */
    fun prune(ctx: Context, before: Long) {
        synchronized(lock) {
            val keep = since(ctx, before)
            if (keep.size == all(ctx).size) return
            val f = file(ctx)
            val tmp = File(f.path + ".tmp")
            tmp.writeText(keep.sortedBy { it.time }.joinToString("") { "${it.time}\t${it.pkg}\t${it.site}\n" })
            tmp.renameTo(f)
        }
    }
}
