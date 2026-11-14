package ca.heeney.lightcurve

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.WindowInsets
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import java.text.DateFormat
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.util.Date

/**
 * What stands in front of an app that is over its limit, or of lightcurve's own settings while limits
 * are on. To get through: hold the ring for the limit's hold time, then stay on this screen for its
 * wait. Leaving the screen, or letting go too soon, starts it over. Both are timed by the clock that
 * counts from boot, so neither the phone's clock nor its animation speed can hurry them.
 */
class BlockActivity : Activity() {
    private enum class Phase { HOLD, WAIT, READY, NONE }

    private lateinit var title: TextView
    private lateinit var reason: TextView
    private lateinit var ring: HoldRing
    private lateinit var below: TextView
    private var phase = Phase.HOLD
    private var waitEnds = 0L

    private var id = ""
    private var label = ""
    private var pkg = ""
    private var until = 0L
    private var unlock: Unlock? = null

    private fun dp(v: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, resources.displayMetrics)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setBackgroundColor(getColor(R.color.field))
            setPadding(dp(28f).toInt(), dp(56f).toInt(), dp(28f).toInt(), dp(36f).toInt())
        }
        title = TextView(this).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 40f)
            setTextColor(getColor(R.color.ink))
            typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD)
            gravity = Gravity.CENTER
        }
        reason = TextView(this).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
            setTextColor(getColor(R.color.ink2))
            gravity = Gravity.CENTER
            setLineSpacing(0f, 1.2f)
        }
        ring = HoldRing(this).apply {
            onHeld = { held() }
            onTap = { if (phase == Phase.READY) open() }
        }
        below = TextView(this).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            setTextColor(getColor(R.color.ink2))
            gravity = Gravity.CENTER
        }
        val close = TextView(this).apply {
            text = "Close"
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD)
            gravity = Gravity.CENTER
            minHeight = dp(52f).toInt()
            setPadding(dp(30f).toInt(), 0, dp(30f).toInt(), 0)
            setTextColor(getColor(R.color.ink))
            background = GradientDrawable().apply {
                cornerRadius = dp(26f)
                setStroke(dp(1.5f).toInt(), getColor(R.color.ink))
            }
            isClickable = true
            isFocusable = true
            setOnClickListener { leave() }
        }
        val lp = { top: Float -> LinearLayout.LayoutParams(-2, -2).apply { topMargin = dp(top).toInt() } }
        col.addView(View(this), LinearLayout.LayoutParams(0, 0, 1f))
        col.addView(title, LinearLayout.LayoutParams(-1, -2))
        col.addView(reason, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(10f).toInt() })
        col.addView(ring, LinearLayout.LayoutParams(dp(220f).toInt(), dp(220f).toInt()).apply { topMargin = dp(48f).toInt() })
        col.addView(below, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(18f).toInt() })
        col.addView(View(this), LinearLayout.LayoutParams(0, 0, 1.4f))
        col.addView(close, lp(0f))
        col.setOnApplyWindowInsetsListener { v, insets ->
            if (Build.VERSION.SDK_INT >= 30) {
                val i = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
                v.setPadding(dp(28f).toInt() + i.left, dp(56f).toInt() + i.top, dp(28f).toInt() + i.right, dp(36f).toInt() + i.bottom)
            }
            insets
        }
        setContentView(col)
        take(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        take(intent)
    }

    private fun take(i: Intent) {
        id = i.getStringExtra("id") ?: ""
        label = i.getStringExtra("label") ?: ""
        pkg = i.getStringExtra("pkg") ?: ""
        until = i.getLongExtra("until", 0)
        unlock = if (i.getBooleanExtra("unlockable", false))
            Unlock(i.getIntExtra("hold", 5), i.getIntExtra("wait", 3), i.getIntExtra("grant", 10),
                i.getIntExtra("per_day", 0).takeIf { it > 0 })
        else null
        title.text = label
        reason.text = if (id == LimitStore.GUARD) "Limits are on" else opens(until)
        start()
    }

    private fun opens(at: Long): String {
        if (at <= 0) return "Over the limit"
        val zone = ZoneId.systemDefault()
        val day = Instant.ofEpochMilli(at).atZone(zone).toLocalDate()
        val time = DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(at))
        val today = LocalDate.now(zone)
        return when (day) {
            today -> "Opens at $time"
            today.plusDays(1) -> "Opens tomorrow at $time"
            else -> "Opens ${DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(at))}"
        }
    }

    /** Back to the start: the hold, if there is one to be had. */
    private fun start() {
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val u = unlock
        val left = u?.perDay?.let { it - Limits.unlocksToday(LimitStore.unlockTimes(this, id), System.currentTimeMillis()) }
        when {
            u == null -> {
                phase = Phase.NONE
                ring.visibility = View.INVISIBLE
                below.text = "No unlocking"
            }
            left != null && left <= 0 -> {
                phase = Phase.NONE
                ring.visibility = View.INVISIBLE
                below.text = "No unlocks left today"
            }
            else -> {
                phase = Phase.HOLD
                ring.visibility = View.VISIBLE
                ring.hold(u.hold * 1000L)
                below.text = if (left != null) "$left of ${u.perDay} unlocks left today" else "Hold ${u.hold} seconds"
            }
        }
    }

    private fun held() {
        val u = unlock ?: return
        ring.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
        if (u.wait <= 0) return ready()
        phase = Phase.WAIT
        waitEnds = SystemClock.elapsedRealtime() + u.wait * 60_000L
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        below.text = "Stay on this screen"
        countdown.run()
    }

    private val countdown = object : Runnable {
        override fun run() {
            if (phase != Phase.WAIT) return
            // Sharing the screen with another app is leaving it.
            if (isInMultiWindowMode) return start()
            val left = waitEnds - SystemClock.elapsedRealtime()
            if (left <= 0) return ready()
            val total = (unlock?.wait ?: 1) * 60_000f
            val s = ((left + 999) / 1000).toInt()
            ring.waiting(1f - left / total, "%d:%02d".format(s / 60, s % 60))
            ring.postDelayed(this, 250)
        }
    }

    private fun ready() {
        val u = unlock ?: return
        phase = Phase.READY
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        ring.ready("Open")
        below.text = "For ${u.grant} minutes"
        if (Build.VERSION.SDK_INT >= 30) ring.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
    }

    private fun open() {
        val u = unlock ?: return
        LimitStore.grant(this, id, u.grant)
        finish()
        if (id != LimitStore.GUARD) LimitKeeper.reopen(this, pkg)
    }

    private fun leave() {
        startActivity(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        finish()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() = leave()

    override fun onResume() {
        super.onResume()
        showing = true
    }

    /** Looking away starts it over. */
    override fun onPause() {
        super.onPause()
        showing = false
        if (phase != Phase.NONE) start()
    }

    companion object {
        @Volatile var showing = false

        fun forLimit(ctx: Context, limit: Limit, state: LimitState, pkg: String): Intent =
            base(ctx, limit.id, limit.label, limit.unlock).putExtra("pkg", pkg).putExtra("until", state.until ?: 0L)

        fun forGuard(ctx: Context): Intent =
            base(ctx, LimitStore.GUARD, "lightcurve settings", LimitStore.guardUnlock(ctx))

        private fun base(ctx: Context, id: String, label: String, u: Unlock?): Intent =
            Intent(ctx, BlockActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION)
                .putExtra("id", id).putExtra("label", label)
                .putExtra("unlockable", u != null)
                .putExtra("hold", u?.hold ?: 0).putExtra("wait", u?.wait ?: 0).putExtra("grant", u?.grant ?: 0)
                .putExtra("per_day", u?.perDay ?: 0)
    }
}

/**
 * The big ring. Press and keep pressing: it fills over the hold time, and lifting early empties it. Then it
 * shows the wait, then becomes the button that opens.
 */
class HoldRing(ctx: Context) : View(ctx) {
    var onHeld: () -> Unit = {}
    var onTap: () -> Unit = {}

    private enum class Mode { HOLD, WAIT, READY }
    private var mode = Mode.HOLD
    private var holdMs = 5000L
    private var pressedAt = 0L
    private var progress = 0f
    private var text = "Hold"
    /** The press that finished a hold mustn't also be the tap that opens. */
    private var tapStarted = false

    private val density = resources.displayMetrics.density
    private val track = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE; strokeWidth = 7 * density; color = ctx.getColor(R.color.line)
    }
    private val arc = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE; strokeWidth = 7 * density; strokeCap = Paint.Cap.ROUND; color = ctx.getColor(R.color.mark)
    }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = ctx.getColor(R.color.ink) }
    private val label = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textAlign = Paint.Align.CENTER
        typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD)
        color = ctx.getColor(R.color.ink)
    }
    private val box = RectF()

    init {
        isClickable = true
        isFocusable = true
        contentDescription = "Hold to unlock"
    }

    fun hold(ms: Long) {
        mode = Mode.HOLD
        holdMs = ms
        pressedAt = 0
        progress = 0f
        text = "Hold"
        contentDescription = "Hold to unlock"
        invalidate()
    }

    fun waiting(p: Float, t: String) {
        mode = Mode.WAIT
        progress = p.coerceIn(0f, 1f)
        text = t
        contentDescription = "Wait $t"
        invalidate()
    }

    fun ready(t: String) {
        mode = Mode.READY
        tapStarted = false
        progress = 1f
        text = t
        contentDescription = t
        invalidate()
    }

    private val step = object : Runnable {
        override fun run() {
            if (mode != Mode.HOLD || pressedAt == 0L) return
            progress = ((SystemClock.elapsedRealtime() - pressedAt).toFloat() / holdMs).coerceAtMost(1f)
            invalidate()
            if (progress >= 1f) {
                pressedAt = 0
                onHeld()
            } else postOnAnimation(this)
        }
    }

    override fun onTouchEvent(e: MotionEvent): Boolean {
        when (mode) {
            Mode.HOLD -> when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    parent?.requestDisallowInterceptTouchEvent(true)
                    pressedAt = SystemClock.elapsedRealtime()
                    postOnAnimation(step)
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> if (pressedAt != 0L) {
                    pressedAt = 0
                    progress = 0f
                    invalidate()
                }
            }
            Mode.READY -> when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> tapStarted = true
                MotionEvent.ACTION_UP -> if (tapStarted) { tapStarted = false; onTap() }
                MotionEvent.ACTION_CANCEL -> tapStarted = false
            }
            Mode.WAIT -> {}
        }
        return true
    }

    override fun onDraw(c: Canvas) {
        val r = minOf(width, height) / 2f - track.strokeWidth
        val cx = width / 2f
        val cy = height / 2f
        box.set(cx - r, cy - r, cx + r, cy + r)
        if (mode == Mode.READY) {
            c.drawCircle(cx, cy, r + track.strokeWidth / 2, fill)
            label.color = context.getColor(R.color.field)
        } else {
            c.drawCircle(cx, cy, r, track)
            if (progress > 0f) c.drawArc(box, -90f, 360f * progress, false, arc)
            label.color = context.getColor(R.color.ink)
        }
        label.textSize = (if (mode == Mode.WAIT) 46 else 26) * density
        c.drawText(text, cx, cy - (label.descent() + label.ascent()) / 2, label)
    }
}
