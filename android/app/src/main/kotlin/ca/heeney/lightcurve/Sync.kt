package ca.heeney.lightcurve

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/** Sends the phone's spans to the hub. Sending the same thing twice is harmless: the hub keys spans by their start. */
object Sync {
    private const val JOB = 4625
    private const val CHUNK = 4000
    /** 2: an app that opens behind a dark screen no longer counts until the screen comes on. */
    private const val RULES = 2
    private val lock = Any()

    class Outcome(val ok: Boolean, val message: String)

    fun schedule(ctx: Context) {
        val js = ctx.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler
        if (js.getPendingJob(JOB) != null) return
        js.schedule(
            JobInfo.Builder(JOB, ComponentName(ctx, SyncJob::class.java))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPeriodic(15 * 60 * 1000L)
                .setPersisted(true)
                .build()
        )
    }

    /** Blocking; call it off the main thread. */
    fun run(ctx: Context): Outcome = synchronized(lock) {
        val store = Store(ctx)
        val now = System.currentTimeMillis()
        store.lastAttempt = now
        val outcome = runCatching { push(ctx, store, now) }.getOrElse {
            Outcome(false, it.message ?: it.javaClass.simpleName)
        }
        store.lastError = if (outcome.ok) "" else outcome.message
        if (outcome.ok) Today.send(ctx, store.hub)
        outcome
    }

    private fun push(ctx: Context, store: Store, now: Long): Outcome {
        if (store.hub.isEmpty()) return Outcome(false, "No hub address yet.")
        if (!Collector.hasAccess(ctx)) return Outcome(false, "Usage access hasn't been allowed.")
        // When the counting rules change, everything the phone still remembers is rebuilt and replaces the hub's copy.
        val redo = store.rules < RULES
        val from = if (store.checkpoint > 0 && !redo) store.checkpoint else now - Collector.FIRST_REACH
        val built = buildSpans(Collector.read(ctx, from, now), now)
        // A day or two past the farthest a sync reaches back, in case the rules change and it all goes again.
        SiteLog.prune(ctx, now - Collector.FIRST_REACH - 2 * 24 * 3600 * 1000L)
        val spans = splitBySite(built.spans, SiteLog.since(ctx, from))

        val names = JSONObject()
        for (pkg in spans.map { it.pkg }.toSet()) {
            val (label, hint) = Collector.describe(ctx, pkg)
            if (label.isNotEmpty() || hint.isNotEmpty()) names.put(pkg, JSONObject().put("label", label).put("hint", hint))
        }
        val tablet = ctx.resources.configuration.smallestScreenWidthDp >= 600
        val device = JSONObject()
            .put("id", store.deviceId).put("name", store.name).put("kind", if (tablet) "tablet" else "phone")
            .put("platform", "Android " + Build.VERSION.RELEASE).put("version", BuildConfig.VERSION_NAME)

        val chunks = spans.chunked(CHUNK).ifEmpty { listOf(emptyList()) }
        for ((i, chunk) in chunks.withIndex()) {
            val final = i == chunks.lastIndex
            val body = JSONObject().put("device", device)
                .put("spans", JSONArray().also { arr ->
                    for (s in chunk) arr.put(JSONArray().put(s.start).put(s.end).put(s.pkg).put(s.site))
                })
                .put("complete", final)
                .put("active", built.active)
            if (final) body.put("pickups", JSONArray(built.pickups)).put("names", names)
            if (redo && i == 0 && spans.isNotEmpty()) body.put("replace_from", from)
            post(store.hub + "/api/ingest", body.toString())
        }
        built.checkpoint?.let { store.checkpoint = it }
        store.rules = RULES
        store.lastSync = now
        store.lastCount = spans.size
        return Outcome(true, "")
    }

    private fun post(url: String, body: String) {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.connectTimeout = 10_000
            conn.readTimeout = 30_000
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            conn.outputStream.use { it.write(body.toByteArray()) }
            val code = conn.responseCode
            if (code !in 200..299) {
                val text = runCatching { conn.errorStream?.bufferedReader()?.readText() }.getOrNull().orEmpty()
                val said = runCatching { JSONObject(text).optString("error") }.getOrDefault("")
                throw IllegalStateException(if (said.isNotEmpty()) "The hub said: $said" else "The hub answered $code.")
            }
            conn.inputStream.use { it.readBytes() }
        } finally {
            conn.disconnect()
        }
    }

    /** Is there a lightcurve hub at this address? Blocking. */
    fun ping(hub: String): Boolean = runCatching {
        val conn = URL("$hub/api/ping").openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = 8_000
            conn.readTimeout = 8_000
            JSONObject(conn.inputStream.bufferedReader().readText()).optString("name") == "lightcurve"
        } finally {
            conn.disconnect()
        }
    }.getOrDefault(false)
}

class SyncJob : JobService() {
    override fun onStartJob(params: JobParameters): Boolean {
        thread(name = "lightcurve-sync") {
            val outcome = Sync.run(applicationContext)
            // Only a hub that couldn't be reached is worth another go before the next period.
            val retry = !outcome.ok && Store(applicationContext).hub.isNotEmpty() && Collector.hasAccess(applicationContext)
            jobFinished(params, retry)
        }
        return true
    }

    override fun onStopJob(params: JobParameters): Boolean = true
}

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        Sync.schedule(ctx)
    }
}
