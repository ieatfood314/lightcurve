package ca.heeney.lightcurve

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/** Hands today's screen time (the hub's "lit": every screen, two at once counted once) to doppler, whose 2x2
 * widget shows it. Sent after every good sync, so it is never newer than what the hub was just told. */
object Today {
    private const val DOPPLER = "ca.heeney.doppler"
    const val TODAY = "ca.heeney.lightcurve.TODAY"

    /** Blocking; call it off the main thread. Does nothing if doppler isn't installed. */
    fun send(ctx: Context, hub: String) {
        if (hub.isEmpty()) return
        if (runCatching { ctx.packageManager.getPackageInfo(DOPPLER, 0) }.isFailure) return
        runCatching {
            val conn = URL("$hub/api/day").openConnection() as HttpURLConnection
            val day = try {
                conn.connectTimeout = 8_000
                conn.readTimeout = 15_000
                JSONObject(conn.inputStream.bufferedReader().readText())
            } finally {
                conn.disconnect()
            }
            val date = day.optString("date")
            if (date.isEmpty() || !day.has("lit")) return
            ctx.sendBroadcast(Intent(TODAY).setPackage(DOPPLER).putExtra("lit", day.optDouble("lit").toLong()).putExtra("date", date))
        }
    }
}

/** doppler asks for a fresh number when its widget goes back to the 1 and 2: sync now, then answer. */
class RefreshReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != "ca.heeney.lightcurve.REFRESH") return
        val app = ctx.applicationContext
        val pending = goAsync()
        thread(name = "lightcurve-refresh") {
            try {
                // A sync that just happened has already answered.
                if (System.currentTimeMillis() - Store(app).lastSync > 30_000) Sync.run(app)
                else Today.send(app, Store(app).hub)
            } finally {
                pending.finish()
            }
        }
    }
}
