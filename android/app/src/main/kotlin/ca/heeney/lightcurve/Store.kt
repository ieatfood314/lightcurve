package ca.heeney.lightcurve

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.provider.Settings
import java.security.SecureRandom

/** The few things the app remembers. */
class Store(ctx: Context) {
    private val app = ctx.applicationContext
    private val prefs: SharedPreferences = app.getSharedPreferences("lightcurve", Context.MODE_PRIVATE)

    var hub: String
        get() = prefs.getString("hub", "") ?: ""
        set(v) = prefs.edit().putString("hub", v.trim().trimEnd('/')).apply()

    /** Made once. The hub knows this phone by it, whatever the phone is later called. */
    val deviceId: String
        get() {
            prefs.getString("device_id", null)?.let { return it }
            val bytes = ByteArray(4).also { SecureRandom().nextBytes(it) }
            val slug = Build.MODEL.lowercase().replace(Regex("[^a-z0-9]+"), "-").trim('-').take(30).ifEmpty { "phone" }
            val id = slug + "-" + bytes.joinToString("") { "%02x".format(it) }
            prefs.edit().putString("device_id", id).apply()
            return id
        }

    var name: String
        get() = prefs.getString("name", null)?.takeIf { it.isNotBlank() } ?: defaultName()
        set(v) = prefs.edit().putString("name", v.trim().take(60)).apply()

    private fun defaultName(): String =
        runCatching { Settings.Global.getString(app.contentResolver, Settings.Global.DEVICE_NAME) }.getOrNull()
            ?.takeIf { it.isNotBlank() } ?: Build.MODEL

    /** Everything in the usage log before this has been sent and can't change. */
    var checkpoint: Long
        get() = prefs.getLong("checkpoint", 0)
        set(v) = prefs.edit().putLong("checkpoint", v).apply()

    var lastSync: Long
        get() = prefs.getLong("last_sync", 0)
        set(v) = prefs.edit().putLong("last_sync", v).apply()

    var lastAttempt: Long
        get() = prefs.getLong("last_attempt", 0)
        set(v) = prefs.edit().putLong("last_attempt", v).apply()

    var lastError: String
        get() = prefs.getString("last_error", "") ?: ""
        set(v) = prefs.edit().putString("last_error", v).apply()

    var lastCount: Int
        get() = prefs.getInt("last_count", 0)
        set(v) = prefs.edit().putInt("last_count", v).apply()
}
