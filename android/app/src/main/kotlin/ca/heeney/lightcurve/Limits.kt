package ca.heeney.lightcurve

import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId

/**
 * App limits: how much of one is left. The same rules as the hub's lightcurve/limits.py, which has the
 * long description; keep the two in step. Plain Kotlin with no Android in it, so it can be tested on a desk.
 *
 * Times are milliseconds. Days are 0 for Monday to 6 for Sunday. A "day" rule follows lightcurve's day
 * (04:00 to 04:00); a time window belongs to the weekday it starts on.
 */
data class Iv(val a: Long, val b: Long)

data class Rule(
    val kind: String,
    val minutes: Int = 0,
    val hours: Int = 0,
    val from: String = "",
    val to: String = "",
    val days: Set<Int> = ALL_DAYS,
    val rest: Int = 0,
)

/** Hold the button [hold] seconds, then stay on the screen [wait] minutes, for [grant] minutes of use. */
data class Unlock(val hold: Int, val wait: Int, val grant: Int, val perDay: Int?)

data class Limit(
    val id: String,
    val label: String,
    val rules: List<Rule>,
    /** null: no unlocking. */
    val unlock: Unlock?,
    /** Package ids this limit covers when they show no site. */
    val apps: Set<String>,
    /** Domains it covers in a browser. */
    val sites: Set<String>,
    /** The names it covers ("youtube"), for domains the hub hasn't seen yet. */
    val names: List<String>,
    /** Time other devices have spent on it lately, as the hub last said. */
    val others: List<Iv>,
)

data class RuleState(val blocked: Boolean, val until: Long?, val left: Long?)

/** [until] is when it opens again (null: not before something changes); [left] is how long until it closes. */
data class LimitState(val blocked: Boolean, val until: Long?, val left: Long?)

val ALL_DAYS = setOf(0, 1, 2, 3, 4, 5, 6)
const val DAY_START_HOUR = 4
const val HORIZON = 25L * 3600 * 1000
/** A rolling limit opens again once this much (or the whole allowance, if smaller) is free. */
const val REOPEN = 300_000L
private const val MIN = 60_000L

object Limits {
    fun merge(ivs: List<Iv>, gap: Long = 0): List<Iv> {
        val out = ArrayList<Iv>()
        for (iv in ivs.sortedBy { it.a }) {
            if (iv.b <= iv.a) continue
            val last = out.lastOrNull()
            if (last != null && iv.a <= last.b + gap) {
                if (iv.b > last.b) out[out.lastIndex] = Iv(last.a, iv.b)
            } else out.add(iv)
        }
        return out
    }

    fun clip(ivs: List<Iv>, lo: Long, hi: Long) = ivs.filter { it.b > lo && it.a < hi }.map { Iv(maxOf(it.a, lo), minOf(it.b, hi)) }

    fun total(ivs: List<Iv>) = ivs.sumOf { it.b - it.a }

    private fun used(usage: List<Iv>, a: Long, b: Long) = total(clip(usage, a, b))

    private fun minutesOf(hhmm: String): Int = hhmm.substringBefore(':').toInt() * 60 + hhmm.substringAfter(':').toInt()

    private fun at(date: LocalDate, hhmm: String, zone: ZoneId): Long =
        LocalDateTime.of(date, LocalTime.of(minutesOf(hhmm) / 60, minutesOf(hhmm) % 60)).atZone(zone).toInstant().toEpochMilli()

    private fun weekday(d: LocalDate) = d.dayOfWeek.value - 1

    /** The lightcurve day a moment belongs to. */
    fun dayOf(now: Long, zone: ZoneId): LocalDate =
        LocalDateTime.ofInstant(Instant.ofEpochMilli(now), zone).minusHours(DAY_START_HOUR.toLong()).toLocalDate()

    fun dayStart(date: LocalDate, zone: ZoneId): Long =
        date.atTime(DAY_START_HOUR, 0).atZone(zone).toInstant().toEpochMilli()

    /** The occurrences of a time window that start between yesterday and tomorrow. */
    private fun instances(r: Rule, now: Long, zone: ZoneId): List<Iv> {
        val today = LocalDateTime.ofInstant(Instant.ofEpochMilli(now), zone).toLocalDate()
        val out = ArrayList<Iv>()
        for (back in -1L..1L) {
            val d = today.plusDays(back)
            if (weekday(d) !in r.days) continue
            val endDay = if (minutesOf(r.to) > minutesOf(r.from)) d else d.plusDays(1)
            out.add(Iv(at(d, r.from, zone), at(endDay, r.to, zone)))
        }
        return out
    }

    fun rule(r: Rule, usage: List<Iv>, now: Long, zone: ZoneId): RuleState {
        when (r.kind) {
            "day" -> {
                val date = dayOf(now, zone)
                if (weekday(date) !in r.days) return RuleState(false, null, null)
                val left = r.minutes * MIN - used(usage, dayStart(date, zone), now)
                return if (left <= 0) RuleState(true, dayStart(date.plusDays(1), zone), null) else RuleState(false, null, left)
            }
            "every" -> {
                val span = r.hours * 3600_000L
                val allowed = r.minutes * MIN
                val recent = clip(usage, now - span, now)
                val usedNow = total(recent)
                if (usedNow < allowed) return RuleState(false, null, allowed - usedNow)
                if (allowed == 0L) return RuleState(true, null, null)
                val need = usedNow - allowed + minOf(allowed, REOPEN)
                var acc = 0L
                for (iv in recent) {
                    if (acc + (iv.b - iv.a) >= need) return RuleState(true, iv.a + (need - acc) + span, null)
                    acc += iv.b - iv.a
                }
                return RuleState(true, null, null)
            }
            "block" -> {
                var until: Long? = null
                var next: Long? = null
                for (iv in instances(r, now, zone)) {
                    if (now >= iv.a && now < iv.b) until = maxOf(until ?: 0L, iv.b)
                    else if (iv.a > now) next = minOf(next ?: Long.MAX_VALUE, iv.a)
                }
                return if (until != null) RuleState(true, until, null) else RuleState(false, null, next?.let { it - now })
            }
            "window" -> {
                var state = RuleState(false, null, null)
                for (iv in instances(r, now, zone)) {
                    if (now < iv.a || now >= iv.b) continue
                    val left = r.minutes * MIN - used(usage, iv.a, now)
                    state = if (left <= 0) RuleState(true, iv.b, null) else RuleState(false, null, left)
                }
                return state
            }
            "stretch" -> {
                val rest = r.rest * MIN
                val allowed = r.minutes * MIN
                val last = merge(clip(usage, now - HORIZON, now), rest).lastOrNull()
                if (last == null || now - last.b >= rest) return RuleState(false, null, allowed)
                val left = allowed - used(usage, last.a, last.b)
                return if (left <= 0) RuleState(true, last.b + rest, null) else RuleState(false, null, left)
            }
        }
        return RuleState(false, null, null)
    }

    /** [usage] is the merged time on what the limit covers, across devices, over the last [HORIZON]. */
    fun evaluate(limit: Limit, usage: List<Iv>, now: Long, zone: ZoneId = ZoneId.systemDefault()): LimitState {
        val states = limit.rules.map { rule(it, usage, now, zone) }
        val blocking = states.filter { it.blocked }
        if (blocking.isNotEmpty()) {
            val untils = blocking.map { it.until }
            return LimitState(true, if (null in untils) null else untils.maxOf { it!! }, null)
        }
        val left = states.mapNotNull { it.left }.minOrNull()
        return LimitState(false, null, left?.coerceAtLeast(0))
    }

    private val NOT_LETTERS = Regex("[^a-z0-9]")

    /** Does a span of [pkg] showing [site] ("" for none) count towards [limit]? */
    fun covers(limit: Limit, pkg: String, site: String): Boolean {
        if (site.isEmpty()) return pkg in limit.apps
        if (site in limit.sites) return true
        val labels = site.lowercase().split('.').dropLast(1)
        return limit.names.any { n -> NOT_LETTERS.replace(n.lowercase(), "").let { it.isNotEmpty() && it in labels } }
    }

    /** The phone's own spans that count towards [limit], with the other devices' time, merged. */
    fun usage(limit: Limit, own: List<Span>): List<Iv> =
        merge(own.filter { covers(limit, it.pkg, it.site) }.map { Iv(it.start, it.end) } + limit.others)

    /** How many unlocks of [limit] were used in the lightcurve day of [now], from their times. */
    fun unlocksToday(times: List<Long>, now: Long, zone: ZoneId = ZoneId.systemDefault()): Int {
        val start = dayStart(dayOf(now, zone), zone)
        return times.count { it in start..now }
    }
}
