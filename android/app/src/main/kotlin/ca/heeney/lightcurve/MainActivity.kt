package ca.heeney.lightcurve

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.webkit.JavascriptInterface
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.text.DateFormat
import java.util.Date
import kotlin.concurrent.thread

/**
 * Two faces: the hub's dashboard in a WebView, and a native page for the three things only the phone
 * can do (say where the hub is, allow usage access, send now).
 */
class MainActivity : Activity() {
    private lateinit var store: Store
    private lateinit var root: FrameLayout
    private lateinit var web: WebView
    private lateinit var panel: ScrollView
    private lateinit var hubField: EditText
    private lateinit var hubStatus: TextView
    private lateinit var accessStatus: TextView
    private lateinit var accessButton: TextView
    private lateinit var syncStatus: TextView
    private lateinit var nameField: EditText
    private lateinit var dashboardButton: TextView
    private var webReady = false
    private var syncing = false

    private fun color(id: Int) = getColor(id)
    private fun dp(v: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, resources.displayMetrics).toInt()

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = Store(this)
        root = FrameLayout(this).apply { setBackgroundColor(color(R.color.field)) }

        web = WebView(this).apply {
            setBackgroundColor(color(R.color.field))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            overScrollMode = View.OVER_SCROLL_NEVER
            addJavascriptInterface(Bridge(), "LightcurveNative")
            webViewClient = Client()
            visibility = View.INVISIBLE
        }
        root.addView(web, FrameLayout.LayoutParams(-1, -1))
        panel = buildPanel()
        root.addView(panel, FrameLayout.LayoutParams(-1, -1))
        setContentView(root)

        // Android 15 draws behind the system bars; keep everything clear of them and of the keyboard.
        root.setOnApplyWindowInsetsListener { v, insets ->
            if (Build.VERSION.SDK_INT >= 30) {
                val i = insets.getInsets(
                    WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime()
                )
                v.setPadding(i.left, i.top, i.right, i.bottom)
            } else {
                @Suppress("DEPRECATION")
                v.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop,
                    insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
            }
            insets
        }
        setBars(color(R.color.field), !resources.getBoolean(R.bool.light_bars))

        Sync.schedule(this)
        if (store.hub.isEmpty()) showPanel() else openDashboard()
    }

    override fun onResume() {
        super.onResume()
        refreshPanel()
        if (store.hub.isNotEmpty() && Collector.hasAccess(this) &&
            System.currentTimeMillis() - store.lastAttempt > 30_000) sync(quiet = true)
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        when {
            panel.visibility == View.VISIBLE && webReady -> hidePanel()
            panel.visibility != View.VISIBLE && web.canGoBack() -> web.goBack()
            else -> @Suppress("DEPRECATION") super.onBackPressed()
        }
    }

    // ---- the dashboard ----

    private fun openDashboard() {
        webReady = false
        web.loadUrl(store.hub + "/")
    }

    private inner class Client : WebViewClient() {
        private var failed = false

        override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
            failed = false
        }

        override fun onPageFinished(view: WebView, url: String) {
            if (failed) return
            webReady = true
            web.visibility = View.VISIBLE
            if (store.hub.isNotEmpty() && Collector.hasAccess(this@MainActivity)) hidePanel()
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame) return
            failed = true
            webReady = false
            web.visibility = View.INVISIBLE
            showPanel()
            hubStatus.setTextColor(color(R.color.warn))
            hubStatus.text = "Hub not reachable. Check Tailscale."
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val hub = Uri.parse(store.hub)
            if (request.url.host == hub.host && request.url.port == hub.port) return false
            runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
            return true
        }
    }

    private inner class Bridge {
        @JavascriptInterface
        fun openSettings() = runOnUiThread { showPanel() }

        /** The dashboard has dark and light; the bars around it follow whichever is showing. */
        @JavascriptInterface
        fun setBars(css: String, dark: Boolean) = runOnUiThread {
            runCatching { Color.parseColor(css.trim()) }.getOrNull()?.let { if (panel.visibility != View.VISIBLE) setBars(it, dark) }
            webBars = (runCatching { Color.parseColor(css.trim()) }.getOrNull() ?: return@runOnUiThread) to dark
        }
    }

    private var webBars: Pair<Int, Boolean>? = null

    private fun setBars(background: Int, dark: Boolean) {
        root.setBackgroundColor(background)
        if (Build.VERSION.SDK_INT >= 30) {
            val light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or
                WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
            window.insetsController?.setSystemBarsAppearance(if (dark) 0 else light, light)
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = if (dark) 0 else
                View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        }
        if (Build.VERSION.SDK_INT < 35) {
            @Suppress("DEPRECATION")
            window.statusBarColor = background
            @Suppress("DEPRECATION")
            window.navigationBarColor = background
        }
    }

    private fun showPanel() {
        refreshPanel()
        panel.visibility = View.VISIBLE
        setBars(color(R.color.field), !resources.getBoolean(R.bool.light_bars))
    }

    private fun hidePanel() {
        panel.visibility = View.GONE
        (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(panel.windowToken, 0)
        webBars?.let { setBars(it.first, it.second) }
    }

    // ---- sending ----

    private fun sync(quiet: Boolean) {
        if (syncing) return
        syncing = true
        if (!quiet) syncStatus.text = "Sending…"
        thread(name = "lightcurve-sync") {
            val outcome = Sync.run(applicationContext)
            runOnUiThread {
                syncing = false
                refreshPanel()
                if (outcome.ok && webReady) web.evaluateJavascript("window.load && window.load('all')", null)
            }
        }
    }

    private fun connect() {
        var url = hubField.text.toString().trim().trimEnd('/')
        if (url.isEmpty()) {
            hubStatus.setTextColor(color(R.color.warn))
            hubStatus.text = "Enter the hub address."
            return
        }
        if (!url.startsWith("http://") && !url.startsWith("https://")) url = "http://$url"
        hubStatus.setTextColor(color(R.color.ink2))
        hubStatus.text = "Connecting…"
        thread {
            val ok = Sync.ping(url)
            runOnUiThread {
                if (!ok) {
                    hubStatus.setTextColor(color(R.color.warn))
                    hubStatus.text = "No hub at that address."
                    return@runOnUiThread
                }
                store.hub = url
                hubField.setText(url)
                refreshPanel()
                openDashboard()
                if (Collector.hasAccess(this)) sync(quiet = false)
            }
        }
    }

    // ---- the native page ----

    private fun text(s: String, size: Float, colorId: Int, serif: Boolean = false, bold: Boolean = false) =
        TextView(this).apply {
            text = s
            setTextSize(TypedValue.COMPLEX_UNIT_SP, size)
            setTextColor(color(colorId))
            typeface = Typeface.create(if (serif) Typeface.SERIF else Typeface.SANS_SERIF, if (bold) Typeface.BOLD else Typeface.NORMAL)
            setLineSpacing(0f, 1.25f)
        }

    private fun button(label: String, primary: Boolean, onClick: () -> Unit) = TextView(this).apply {
        text = label
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
        typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD)
        gravity = Gravity.CENTER
        minHeight = dp(52f)
        setPadding(dp(22f), dp(12f), dp(22f), dp(12f))
        setTextColor(color(if (primary) R.color.field else R.color.ink))
        background = GradientDrawable().apply {
            cornerRadius = dp(26f).toFloat()
            if (primary) setColor(color(R.color.ink)) else setStroke(dp(1.5f), color(R.color.ink))
        }
        isClickable = true
        isFocusable = true
        setOnClickListener { onClick() }
    }

    private fun field(hint: String, uri: Boolean) = EditText(this).apply {
        this.hint = hint
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f)
        setTextColor(color(R.color.ink))
        setHintTextColor(color(R.color.line))
        isSingleLine = true
        inputType = if (uri) InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
        else InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_WORDS
        imeOptions = EditorInfo.IME_ACTION_DONE
        setPadding(dp(16f), dp(14f), dp(16f), dp(14f))
        background = GradientDrawable().apply {
            cornerRadius = dp(12f).toFloat()
            setColor(color(R.color.well))
            setStroke(dp(1f), color(R.color.line))
        }
    }

    private fun LinearLayout.add(v: View, top: Float = 0f, wrap: Boolean = false) {
        addView(v, LinearLayout.LayoutParams(if (wrap) -2 else -1, -2).apply { topMargin = dp(top) })
    }

    private fun LinearLayout.section(title: String) {
        add(View(context).apply { setBackgroundColor(color(R.color.line)) }.also {
            it.layoutParams = LinearLayout.LayoutParams(-1, dp(1f))
        }, top = 30f)
        (getChildAt(childCount - 1).layoutParams as LinearLayout.LayoutParams).height = dp(1f)
        add(text(title, 21f, R.color.ink, bold = true), top = 22f)
    }

    private fun buildPanel(): ScrollView {
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24f), dp(28f), dp(24f), dp(48f))
        }
        col.add(Mark(this), wrap = true)
        col.section("Hub")
        hubField = field("http://hub:4625", uri = true)
        hubField.setOnEditorActionListener { _, action, _ -> if (action == EditorInfo.IME_ACTION_DONE) { connect(); true } else false }
        col.add(hubField, top = 14f)
        hubStatus = text("", 15f, R.color.ink2)
        hubStatus.visibility = View.GONE
        hubStatus.addTextChangedListener(object : android.text.TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun afterTextChanged(s: android.text.Editable?) {
                hubStatus.visibility = if (s.isNullOrEmpty()) View.GONE else View.VISIBLE
            }
        })
        col.add(hubStatus, top = 10f)
        col.add(button("Connect", primary = true) { connect() }, top = 14f)

        col.section("Usage access")
        accessStatus = text("", 15f, R.color.ink)
        col.add(accessStatus, top = 6f)
        accessButton = button("Allow", primary = true) {
            val specific = Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS, Uri.parse("package:$packageName"))
            runCatching { startActivity(specific) }.onFailure {
                runCatching { startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)) }
            }
        }
        col.add(accessButton, top = 14f)

        col.section("Sync")
        syncStatus = text("", 15f, R.color.ink2)
        col.add(syncStatus, top = 6f)
        col.add(button("Send now", primary = false) { sync(quiet = false) }, top = 14f)

        col.section("Name")
        nameField = field("phone", uri = false)
        nameField.setOnFocusChangeListener { _, focused -> if (!focused) saveName() }
        nameField.setOnEditorActionListener { v, action, _ ->
            if (action == EditorInfo.IME_ACTION_DONE) { saveName(); v.clearFocus() }
            false
        }
        col.add(nameField, top = 14f)

        dashboardButton = button("Dashboard", primary = false) {
            if (webReady) hidePanel() else openDashboard()
        }
        col.add(dashboardButton, top = 36f)
        col.add(text("lightcurve ${BuildConfig.VERSION_NAME}", 13f, R.color.ink2), top = 24f)

        return ScrollView(this).apply {
            setBackgroundColor(color(R.color.field))
            isFillViewport = true
            addView(col, ViewGroup.LayoutParams(-1, -2))
        }
    }

    private fun saveName() {
        val v = nameField.text.toString().trim()
        if (v.isNotEmpty() && v != store.name) store.name = v
    }

    private fun refreshPanel() {
        if (!hubField.hasFocus()) hubField.setText(store.hub)
        if (!nameField.hasFocus()) nameField.setText(store.name)
        if (store.hub.isNotEmpty() && hubStatus.currentTextColor != color(R.color.warn)) {
            hubStatus.setTextColor(color(R.color.ink2))
            hubStatus.text = "Connected"
        }
        val access = Collector.hasAccess(this)
        accessStatus.text = if (access) "Allowed" else "Not allowed"
        accessStatus.setTextColor(color(if (access) R.color.ink else R.color.warn))
        accessButton.visibility = if (access) View.GONE else View.VISIBLE
        val time = DateFormat.getTimeInstance(DateFormat.SHORT)
        val day = DateFormat.getDateInstance(DateFormat.MEDIUM)
        syncStatus.text = when {
            store.hub.isEmpty() -> "No hub yet"
            !access -> "Needs usage access"
            store.lastError.isNotEmpty() && store.lastSync > 0 ->
                "Failed: ${store.lastError}\nLast sent ${day.format(Date(store.lastSync))}, ${time.format(Date(store.lastSync))}"
            store.lastError.isNotEmpty() -> "Failed: ${store.lastError}"
            store.lastSync > 0 -> "Sent ${time.format(Date(store.lastSync))}"
            else -> "Not sent yet"
        }
        dashboardButton.visibility = if (store.hub.isNotEmpty()) View.VISIBLE else View.GONE
    }

    /** The mark: a light curve with a dip in it. */
    private class Mark(ctx: Activity) : View(ctx) {
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        private val ink = ctx.getColor(R.color.ink)
        private val dip = ctx.getColor(R.color.mark)
        private val d = ctx.resources.displayMetrics.density
        private val ys = floatArrayOf(5f, 4f, 6f, 15f, 16f, 7f, 4f)

        override fun onMeasure(w: Int, h: Int) = setMeasuredDimension((66 * d).toInt(), (22 * d).toInt())

        override fun onDraw(c: Canvas) {
            for ((i, y) in ys.withIndex()) {
                paint.color = if (i == 3 || i == 4) dip else ink
                c.drawCircle((4 + i * 9.5f) * d, y * d, 3f * d, paint)
            }
        }
    }
}
