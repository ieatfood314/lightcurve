/* lightcurve dashboard. No build step, no dependencies. Sections are marked with ---- banners. */
"use strict";

/* ---- small tools ---- */
const $ = (id) => document.getElementById(id);
const NS = "http://www.w3.org/2000/svg";
const CATS = ["make", "watch", "talk", "play", "browse", "other"];
const CAT_NAME = { make: "Make", watch: "Watch", talk: "Talk", play: "Play", browse: "Browse", other: "Other" };
const CAT_ABOUT = {
  make: "writing, building, coding", watch: "video, feeds, reading", talk: "messages, mail, calls",
  play: "games", browse: "web pages that fit nowhere else", other: "settings, files, the home screen",
};
const CAT_LETTER = { m: "make", w: "watch", t: "talk", p: "play", b: "browse", o: "other" };

function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k === "text") n.textContent = v;
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid);
  return n;
}
function sv(tag, attrs, text) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
}
const clear = (n) => { while (n.firstChild) n.firstChild.remove(); return n; };
const pad2 = (n) => String(n).padStart(2, "0");

/** 6h 05m, 42m, 30s: for columns and labels. */
function dur(s) {
  s = Math.round(s || 0);
  const m = Math.floor(s / 60), h = Math.floor(m / 60);
  if (h) return `${h}h ${pad2(m % 60)}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}
/** 6 h 5 min: for sentences. */
function durWords(s) {
  s = Math.round(s || 0);
  const m = Math.round(s / 60), h = Math.floor(m / 60);
  if (s < 60) return `${s} s`;
  if (!h) return `${m} min`;
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const parseDate = (d) => { const [y, m, dd] = d.split("-").map(Number); return new Date(Date.UTC(y, m - 1, dd)); };
const isoDate = (dt) => dt.toISOString().slice(0, 10);
const shiftDate = (d, n) => { const dt = parseDate(d); dt.setUTCDate(dt.getUTCDate() + n); return isoDate(dt); };
function dateLong(d) { const dt = parseDate(d); return `${WEEKDAYS[dt.getUTCDay()]}, ${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()]}`; }
function dateShort(d) { const dt = parseDate(d); return `${WEEKDAYS[dt.getUTCDay()].slice(0, 3)} ${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()].slice(0, 3)}`; }
function ago(seconds) {
  if (seconds < 90) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400 * 2) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} days ago`;
}
function listWords(xs) {
  if (xs.length < 2) return xs.join("");
  return xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1];
}
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
function luminance(hex) {
  const c = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/* ---- state ---- */
const state = {
  date: null, days: Number(localStorage.getItem("lightcurve-days")) || 28,
  day: null, range: null, devices: null, showAll: false, first: true,
};
const devName = (id) => (state.day && state.day.devices.find((d) => d.id === id) || {}).name || id;

async function api(path, opts) {
  const r = await fetch(path, opts && { method: opts.method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(opts.body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `The hub answered ${r.status}.`);
  return data;
}

async function load(what = "all") {
  document.body.classList.add("loading");
  try {
    const jobs = [];
    const q = state.date ? `date=${state.date}` : "";
    if (what !== "range") jobs.push(api(`/api/day?${q}`).then((d) => { state.day = d; if (!state.date) state.date = d.date; }));
    if (what === "all" || what === "range") {
      jobs.push(api(`/api/range?days=${state.days}${state.date ? `&end=${state.date}` : ""}`).then((r) => { state.range = r; }));
    }
    if (what === "all") jobs.push(api("/api/devices").then((d) => { state.devices = d; }));
    await Promise.all(jobs);
    render();
  } catch (e) {
    $("finding").textContent = `Couldn't reach the hub: ${e.message}`;
  } finally {
    document.body.classList.remove("loading");
  }
}

function setDate(date, push = true) {
  const today = state.day ? state.day.today : null;
  if (today && date > today) date = today;
  state.date = date;
  state.showAll = false;
  if (push) history.replaceState(null, "", date === today ? location.pathname + location.search : `#${date}`);
  load("all");
  window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
}

/* ---- tooltip ---- */
const tip = $("tip");
function showTip(x, y, nodes) {
  clear(tip).append(...nodes);
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let left = x + 14, top = y + 16;
  if (left + r.width > innerWidth - 8) left = x - r.width - 14;
  if (left < 8) left = 8;
  if (top + r.height > innerHeight - 8) top = y - r.height - 12;
  tip.style.left = `${left}px`;
  tip.style.top = `${Math.max(8, top)}px`;
}
const hideTip = () => { tip.hidden = true; };
const tipRow = (cat, label, value) => el("div", { class: "t-row" }, el("span", {}, cat ? el("i", { class: `b-${cat}` }) : null, label), el("b", { text: value }));
addEventListener("scroll", hideTip, { passive: true });

/* ---- the day: headline ---- */
function clock(day, offset) {
  const t = new Date((day.t0 + offset + day.utc_offset) * 1000);
  return `${pad2(t.getUTCHours())}:${pad2(t.getUTCMinutes())}`;
}

function renderHeadline() {
  const d = state.day;
  const isToday = d.date === d.today;
  $("date-label").textContent = isToday ? "Today" : d.date === shiftDate(d.today, -1) ? "Yesterday" : dateShort(d.date);
  $("day-title").textContent = dateLong(d.date) + (parseDate(d.date).getUTCFullYear() !== parseDate(d.today).getUTCFullYear() ? ` ${d.date.slice(0, 4)}` : "");
  $("next").disabled = isToday;
  $("today").hidden = isToday;
  $("date-input").max = d.today;
  $("date-input").value = d.date;
  document.title = isToday ? "lightcurve" : `${dateShort(d.date)} · lightcurve`;

  const lit = d.has_data ? d.lit : d.legacy ? d.legacy.seconds : 0;
  const m = Math.floor(lit / 60), h = Math.floor(m / 60);
  const fig = clear($("lit"));
  if (h) fig.append(String(h), el("small", { text: "h" }), " ", pad2(m % 60), el("small", { text: "m" }));
  else fig.append(String(m), el("small", { text: "m" }));
  $("lit-unit").textContent = !d.has_data && d.legacy ? "by waytime's count" : d.in_progress ? "lit so far" : "lit";

  const s = [];
  const u = d.usual || {};
  if (!d.has_data && d.legacy) {
    s.push("This day comes from waytime's old totals, which kept how long each app was open and nothing finer. There is no curve to draw for it.");
  } else if (!d.has_data) {
    s.push(d.in_progress ? "No screen has been lit yet today." : "Nothing was recorded on this day.");
  } else {
    if (u.enough) {
      const base = d.in_progress ? u.lit_by_now : u.lit;
      const diff = d.lit - base;
      const when = d.in_progress ? "by this time of day" : "";
      if (Math.abs(diff) < Math.max(600, base * 0.1)) s.push(d.in_progress ? "About the usual for this time of day." : "About a usual day.");
      else s.push(`${durWords(Math.abs(diff))} ${diff > 0 ? "more" : "less"} than usual${when ? " " + when : ""}.`);
    }
    const f = d.first, l = d.last;
    let first = `First light at ${clock(d, f.at)} on ${devName(f.device)}, with ${f.label}`;
    if (!d.in_progress) first += `; last light at ${clock(d, l.at)}`;
    s.push(first + ".");
    if (d.both >= 300) s.push(`For ${durWords(d.both)} a phone and a computer were lit at once.`);
    const live = d.ignition && d.ignition.live;
    if (isToday && live && live.phase === "burning") s.push(`A burn is running until ${clock(d, live.ends_at - d.t0)}.`);
  }
  $("finding").textContent = s.join(" ");

  const notes = clear($("notes"));
  for (const n of d.notes || []) {
    notes.append(el("div", { class: "note", text:
      `${n.name} hasn't reported since ${clock(d, n.since)}. ${n.kind === "phone" ? "Anything on it after that isn't counted yet, so this day's total may be short." : "It was in use when it went quiet, so some of its time may be missing."}` }));
  }
}

/* ---- the day: light curve and device strips ---- */
function renderCurve() {
  const d = state.day, host = clear($("curve"));
  const W = Math.max(280, Math.floor(host.clientWidth));
  const span = d.t1 - d.t0;
  const x = (off) => (off / span) * W;
  const small = W < 560;
  const H = small ? 120 : 176, top = 26, base = top + H;
  const stripGap = 40, stripH = 16;
  const strips = d.strips;
  const stripsTop = base + 56;
  const height = stripsTop + Math.max(strips.length, 0) * stripGap + 4;
  const svg = sv("svg", { viewBox: `0 0 ${W} ${height}`, height });
  const defs = sv("defs");
  const hatch = sv("pattern", { id: "hatch", width: 6, height: 6, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" });
  hatch.append(sv("rect", { width: 6, height: 6, fill: css("--well") }), sv("line", { x1: 0, y1: 0, x2: 0, y2: 6, stroke: css("--ink-3"), "stroke-width": 1.4 }));
  defs.append(hatch);
  svg.append(defs);

  // burns sit behind everything
  for (const b of d.burns) {
    const a = Math.max(0, b.start), e = Math.min(span, b.live ? Math.max(b.start, (d.now - d.t0)) : b.end);
    if (e <= a) continue;
    const bx = x(a), bw = Math.max(2, x(e) - x(a));
    svg.append(sv("rect", { class: "burn", x: bx, y: top - 6, width: bw, height: height - top + 2 }));
    svg.append(sv("line", { class: "burn-edge", x1: bx, x2: bx, y1: top - 6, y2: height - 4 }));
    if (!b.live) svg.append(sv("line", { class: "burn-edge", x1: bx + bw, x2: bx + bw, y1: top - 6, y2: height - 4 }));
    const label = bw > 64 ? `burn, ${b.minutes} min` : bw > 30 ? "burn" : "";
    if (label) svg.append(sv("text", { class: "burn-l", x: bx + 5, y: top - 11 }, label));
  }

  // grid: fully lit, half lit, dark
  svg.append(sv("line", { class: "grid", x1: 0, x2: W, y1: top, y2: top }));
  svg.append(sv("line", { class: "grid", x1: 0, x2: W, y1: top + H / 2, y2: top + H / 2 }));
  svg.append(sv("line", { class: "axis", x1: 0, x2: W, y1: base, y2: base }));
  const step = small ? 6 : W < 900 ? 3 : 2;
  for (let hr = 0; hr <= 24; hr += step) {
    const px = x(hr * 3600);
    svg.append(sv("line", { class: "axis", x1: px, x2: px, y1: base, y2: base + 5 }));
    const anchor = hr === 0 ? "start" : hr === 24 ? "end" : "middle";
    svg.append(sv("text", { x: px, y: base + 19, "text-anchor": anchor }, clock(d, hr * 3600)));
  }

  // group bins so neighbouring points never crowd
  const n = d.curve.length;
  const g = Math.min(6, Math.max(1, Math.ceil(6.6 / (W / n))));
  const groups = [];
  for (let i = 0; i < n; i += g) {
    let lit = 0; const cats = {}; const tops = {};
    const size = Math.min(g, n - i);
    for (let j = i; j < i + size; j++) {
      const c = d.curve[j];
      if (!c) continue;
      lit += c.lit;
      for (const [k, v] of Object.entries(c.cats)) cats[k] = (cats[k] || 0) + v;
      for (const [label, v] of c.top) tops[label] = (tops[label] || 0) + v;
    }
    const minutes = (size * span) / n / 60;
    groups.push({
      from: (i / n) * span, to: ((i + size) / n) * span, lit: lit / size, minutes,
      cat: Object.keys(cats).sort((a, b) => cats[b] - cats[a])[0], cats,
      top: Object.entries(tops).sort((a, b) => b[1] - a[1]).slice(0, 3),
    });
  }
  const nowOff = d.in_progress ? d.now - d.t0 : null;
  const marks = sv("g", { class: state.first ? "develop" : "" });
  const r = g === 1 && W / n < 7 ? 3.4 : 4;
  groups.forEach((p, i) => {
    if (p.lit <= 0) return;
    const cx = x((p.from + p.to) / 2), cy = base - p.lit * H;
    const style = `--i:${i}`;
    marks.append(sv("line", { class: `stem s-${p.cat}`, x1: cx, x2: cx, y1: base, y2: cy, style }));
    if (p.lit > 0.6) marks.append(sv("circle", { class: `halo c-${p.cat}`, cx, cy, r: r + 5, style }));
    marks.append(sv("circle", { class: `dot c-${p.cat}`, cx, cy, r, style }));
  });
  svg.append(marks);
  svg.append(sv("text", { class: "aside", x: W, y: top - 6, "text-anchor": "end" }, g === 1 ? "every minute of the ten lit" : `all ${Math.round(groups[0].minutes)} minutes lit`));

  // strips
  strips.forEach((st, k) => {
    const y = stripsTop + k * stripGap;
    const dev = d.devices.find((v) => v.id === st.device) || { name: st.device, kind: "desktop" };
    svg.append(sv("text", { class: "name", x: 0, y: y - 7 }, dev.name));
    svg.append(sv("text", { x: W, y: y - 7, "text-anchor": "end" }, dur(st.seconds)));
    svg.append(sv("rect", { class: "track", x: 0, y, width: W, height: stripH, rx: 3 }));
    const note = (d.notes || []).find((nn) => nn.device === st.device);
    if (note && nowOff != null) svg.append(sv("rect", { class: "unknown", x: x(note.since), y, width: Math.max(0, x(nowOff) - x(note.since)), height: stripH, rx: 3 }));
    const cg = sv("g", { class: state.first ? "develop" : "" });
    for (const [a, b, key] of st.spans) {
      const e = entity(key);
      const w = Math.max(0.6, x(b) - x(a));
      cg.append(sv("rect", { class: `span c-${e ? e.cat : "other"}`, x: x(a), y, width: w, height: stripH, style: `--i:${Math.round((a / span) * groups.length)}` }));
    }
    svg.append(cg);
    for (const p of st.pickups || []) svg.append(sv("line", { class: "pickup", x1: x(p), x2: x(p), y1: y + stripH + 2, y2: y + stripH + 6 }));
  });

  if (nowOff != null) {
    svg.append(sv("line", { class: "now", x1: x(nowOff), x2: x(nowOff), y1: top - 4, y2: height - 4 }));
    svg.append(sv("text", { class: "name", x: Math.min(W - 2, x(nowOff) + 5), y: top + 12, "text-anchor": x(nowOff) > W - 40 ? "end" : "start", dx: x(nowOff) > W - 40 ? -10 : 0 }, "now"));
  }

  const cross = sv("line", { class: "cross", y1: top, y2: base, visibility: "hidden" });
  svg.append(cross);
  const hit = sv("rect", { x: 0, y: 0, width: W, height, fill: "transparent", style: "touch-action: pan-y" });
  svg.append(hit);
  hit.addEventListener("pointermove", (ev) => {
    const box = svg.getBoundingClientRect();
    const px = ((ev.clientX - box.left) / box.width) * W, py = ((ev.clientY - box.top) / box.height) * height;
    const off = (px / W) * span;
    const k = Math.floor((py - stripsTop + 18) / stripGap);
    if (py > base + 30 && k >= 0 && k < strips.length) {
      cross.setAttribute("visibility", "hidden");
      const st = strips[k];
      let best = null;
      for (const s of st.spans) { if (s[0] <= off && off < s[1]) { best = s; break; } }
      if (!best) { // nearest within a few pixels
        const tol = (6 / W) * span;
        for (const s of st.spans) if (Math.abs(s[0] - off) < tol || Math.abs(s[1] - off) < tol) { best = s; break; }
      }
      if (!best) return hideTip();
      const e = entity(best[2]) || { label: best[2].slice(2), cat: "other" };
      return showTip(ev.clientX, ev.clientY, [
        el("div", { class: "t-head", text: `${clock(d, best[0])} to ${clock(d, best[1])} on ${devName(st.device)}` }),
        tipRow(e.cat, e.label, dur(best[1] - best[0])),
      ]);
    }
    const gi = Math.max(0, Math.min(groups.length - 1, Math.floor((off / span) * groups.length)));
    const p = groups[gi];
    const cx = x((p.from + p.to) / 2);
    cross.setAttribute("x1", cx); cross.setAttribute("x2", cx); cross.setAttribute("visibility", "visible");
    const rows = [el("div", { class: "t-head", text: `${clock(d, p.from)} to ${clock(d, p.to)}` })];
    if (p.lit <= 0) rows.push(el("div", { text: nowOff != null && p.from > nowOff ? "Hasn't happened yet" : "Dark" }));
    else {
      rows.push(el("div", { class: "t-big", text: `${dur(p.lit * p.minutes * 60)} of ${Math.round(p.minutes)} min lit` }));
      const catOf = {}; for (const e of d.entities) catOf[e.label] = e.cat;
      for (const [label, secs] of p.top) rows.push(tipRow(catOf[label] || "other", label, dur(secs)));
    }
    showTip(ev.clientX, ev.clientY, rows);
  });
  hit.addEventListener("pointerleave", () => { hideTip(); cross.setAttribute("visibility", "hidden"); });
  host.append(svg);

  const legend = clear($("legend"));
  const used = CATS.filter((c) => d.categories[c] > 0);
  for (const c of used) legend.append(el("span", { title: CAT_ABOUT[c] }, el("i", { class: `b-${c}` }), CAT_NAME[c]));
  if (d.burns.length) legend.append(el("span", {}, el("i", { class: "burn-key" }), "burn"));
  $("curve-caption").textContent = !d.has_data ? "" :
    `Each point is ${g === 1 ? "ten minutes" : Math.round(groups[0].minutes) + " minutes"}: the higher it sits, the more of them a screen was lit, on any device. Its colour is what most of that time went to. The strips underneath show each device on its own${strips.some((s) => (d.devices.find((v) => v.id === s.device) || {}).kind === "phone") ? ", with a tick for every time the phone was unlocked" : ""}.`;
  host.parentElement.hidden = !d.has_data;
}
const entity = (key) => state.day._byKey[key];

/* ---- where it went ---- */
function splitBar(cats, opts = {}) {
  const total = CATS.reduce((a, c) => a + (cats[c] || 0), 0);
  const bar = el("div", { class: "splitbar", role: "img", "aria-label": CATS.filter((c) => cats[c] > 0).map((c) => `${CAT_NAME[c]} ${Math.round((cats[c] / total) * 100)}%`).join(", ") });
  if (!total) return bar;
  for (const c of CATS) {
    const v = cats[c] || 0;
    if (v <= 0) continue;
    const share = v / total;
    const seg = el("div", { class: `b-${c} ${luminance(css(`--${c}`)) > 0.4 ? "on-light" : "on-dark"}`, style: `flex: ${share} 1 0` });
    seg.dataset.label = `${Math.round(share * 100)}%`;
    seg.addEventListener("pointermove", (ev) => showTip(ev.clientX, ev.clientY, [tipRow(c, CAT_NAME[c], `${dur(v)}, ${Math.round(share * 100)}%`)]));
    seg.addEventListener("pointerleave", hideTip);
    bar.append(seg);
  }
  // print a share only where it fits
  requestAnimationFrame(() => { for (const seg of bar.children) if (seg.clientWidth > 44) seg.textContent = seg.dataset.label; });
  return bar;
}

function renderWhere() {
  const d = state.day, split = clear($("split")), list = clear($("things"));
  const cats = d.has_data ? d.categories : null;
  if (!d.has_data) {
    $("more-things").hidden = true;
    if (d.legacy) {
      const max = d.legacy.apps[0] ? d.legacy.apps[0][1] : 1;
      for (const [label, secs, cat] of d.legacy.apps.slice(0, 14)) {
        list.append(el("li", {}, el("div", { class: "thing" },
          el("span", { class: "who" }, el("i", { class: `key b-${cat}` }), el("span", { class: "label", text: label })),
          el("span", { class: "bar-track" }, el("span", { class: `bar-fill b-${cat}`, style: `display:block;width:${Math.max(1, (secs / max) * 100)}%` })),
          el("span", { class: "time", text: dur(secs) }))));
      }
    } else split.append(el("p", { class: "empty", text: "Nothing to show for this day." }));
    return;
  }
  split.append(splitBar(cats));
  const legend = el("div", { class: "split-legend" });
  for (const c of CATS) if (cats[c] > 0) legend.append(el("span", { title: CAT_ABOUT[c] }, el("i", { class: `key b-${c}` }), CAT_NAME[c], el("b", { text: dur(cats[c]) })));
  split.append(legend);

  const shown = state.showAll ? d.entities : d.entities.slice(0, 10);
  const max = d.entities[0] ? d.entities[0].seconds : 1;
  const many = d.devices.filter((v) => v.seconds > 0).length > 1;
  for (const e of shown) {
    const sub = `${e.sessions} ${e.sessions === 1 ? "visit" : "visits"}${many ? " on " + listWords(e.devices.map(devName)) : ""}`;
    const row = el("button", { type: "button", class: "thing", onclick: () => openSheet(e, "this day"), "aria-label": `${e.label}, ${dur(e.seconds)}, ${CAT_NAME[e.cat]}. Change what it counts as.` },
      el("span", { class: "who" }, el("i", { class: `key b-${e.cat}` }),
        el("span", { style: "min-width:0" }, el("span", { class: "label", text: e.label }), el("span", { class: "sub", text: sub })),
        e.blocked ? lockIcon() : null),
      el("span", { class: "bar-track" }, el("span", { class: `bar-fill b-${e.cat}`, style: `display:block;width:${Math.max(1, (e.seconds / max) * 100)}%` })),
      el("span", { class: "time", text: dur(e.seconds) }));
    list.append(el("li", {}, row));
  }
  const more = $("more-things");
  more.hidden = d.entities.length <= 10;
  more.textContent = state.showAll ? "Show the top ten" : `Show all ${d.entities.length}`;
}
function lockIcon() {
  const s = sv("svg", { class: "lock", viewBox: "0 0 12 12" });
  s.append(sv("title", {}, "On ignition's block list"));
  s.append(sv("path", { d: "M3.2 5.2V3.8a2.8 2.8 0 0 1 5.6 0v1.4M2.4 5.2h7.2v5.2H2.4z", fill: "none", stroke: "currentColor", "stroke-width": 1.4, "stroke-linejoin": "round" }));
  return s;
}

/* ---- attention ---- */
function spark(values, current, usual) {
  const pts = values.concat([current]);
  const real = pts.filter((v) => v != null);
  const s = sv("svg", { viewBox: "0 0 96 24", "aria-hidden": "true" });
  if (real.length < 2) return s;
  const lo = Math.min(...real, usual ?? Infinity), hi = Math.max(...real, usual ?? -Infinity);
  const y = (v) => (hi === lo ? 12 : 21 - ((v - lo) / (hi - lo)) * 18);
  const x = (i) => 3 + (i / (pts.length - 1)) * 90;
  if (usual != null) s.append(sv("line", { class: "spark-usual", x1: 0, x2: 96, y1: y(usual), y2: y(usual) }));
  let dpath = "", pen = false;
  pts.forEach((v, i) => { if (v == null) { pen = false; return; } dpath += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`; pen = true; });
  s.append(sv("path", { class: "spark", d: dpath }));
  if (current != null) s.append(sv("circle", { class: "spark-now", cx: x(pts.length - 1), cy: y(current), r: 3.5 }));
  return s;
}

function renderAttention() {
  const d = state.day, a = d.attention, u = d.usual || {}, body = clear($("ledger").tBodies[0]);
  $("ledger-day").textContent = d.date === d.today ? "Today" : "This day";
  $("attention").hidden = !d.has_data;
  if (!d.has_data) return;
  const rec = u.recent || {};
  const row = (name, sub, value, usual, trendKey, current) => {
    body.append(el("tr", {},
      el("th", { scope: "row" }, name, sub ? el("small", { text: sub }) : null),
      el("td", { class: "val", text: value }),
      el("td", { class: "usual", text: u.enough && usual != null ? usual : "" }),
      el("td", { class: "trend" }, trendKey && rec[trendKey] ? spark(rec[trendKey], current, u.enough ? u[trendKey] : null) : null)));
  };
  if (a.longest_sitting) row("Longest sitting", `${clock(d, a.longest_sitting.start)} to ${clock(d, a.longest_sitting.end)}, without a five-minute break`, dur(a.longest_sitting.seconds), u.longest_sitting != null ? dur(u.longest_sitting) : null, "longest_sitting", a.longest_sitting.seconds);
  if (a.stretch) row("Longest stretch on one thing", `${a.stretch.label}, from ${clock(d, a.stretch.start)}`, dur(a.stretch.seconds), null);
  if (a.switch_rate != null) row("Switches an hour", `${a.switches} in all, from one thing straight to another`, String(Math.round(a.switch_rate)), u.switch_rate != null ? String(Math.round(u.switch_rate)) : null, "switch_rate", a.switch_rate);
  if (d.devices.some((v) => v.kind === "phone")) row("Phone pickups", a.pickups ? `${a.pickups_while_desk} with a computer already in use` : "", String(a.pickups), u.pickups != null ? String(Math.round(u.pickups)) : null, "pickups", a.pickups);
  if (d.first) row("First light", `${devName(d.first.device)}, ${d.first.label}`, clock(d, d.first.at), u.first != null ? clock(d, u.first) : null, "first", d.first.at);
  if (d.last && !d.in_progress) row("Last light", `${devName(d.last.device)}, ${d.last.label}`, clock(d, d.last.at), u.last != null ? clock(d, u.last) : null, "last", d.last.at);
  const cap = clear($("attention-caption"));
  if (u.enough) cap.append(`Usual is the middle value of the ${u.days} days before this one that have data.`, el("span", { class: "trend-note", text: " The line in each trend marks it." }));
  else cap.append(`Usual shows up after five days of history. There ${u.days === 1 ? "is 1 day" : `are ${u.days || 0} days`} so far.`);
}

/* ---- the record ---- */
function renderRecord() {
  const r = state.range, host = clear($("record"));
  $("record-title").textContent = `The record, ${r.days} days`;
  const withData = r.rows.filter((x) => x.has_data);
  const s = [];
  if (withData.length) {
    s.push(`Lit for ${durWords(r.average)} on an average day, ${durWords(r.lit)} in all.`);
    const hi = withData.reduce((a, b) => (b.lit > a.lit ? b : a)), lo = withData.reduce((a, b) => (b.lit < a.lit ? b : a));
    if (withData.length > 2) s.push(`The longest day was ${dateShort(hi.date)} at ${durWords(hi.lit)}, the shortest ${dateShort(lo.date)} at ${durWords(lo.lit)}.`);
    const lates = withData.filter((x) => x.last != null && x.last > 21 * 3600).length; // past 01:00
    if (lates) s.push(`${lates === 1 ? "One night" : `${lates} nights`} ran past one in the morning.`);
  }
  const old = r.rows.filter((x) => x.legacy && !x.has_data);
  if (old.length) s.push(`${old.length === 1 ? "One day is a total" : `${old.length} days are totals`} carried over from waytime, ${durWords(old.reduce((a, b) => a + b.lit, 0) / old.length)} a day; they have a length and no time of day.`);
  if (!s.length) s.push("Nothing recorded in these days yet.");
  $("record-finding").textContent = s.join(" ");

  const W = Math.max(280, Math.floor(host.clientWidth));
  const small = W < 560;
  const left = small ? 52 : 74, right = small ? 50 : 66;
  const rowH = r.days <= 7 ? 26 : r.days <= 31 ? 15 : 7, gap = r.days <= 31 ? 3 : 2;
  const rows = r.rows.slice().reverse(), raster = r.raster.slice().reverse();
  let y = 0; const ys = [];
  rows.forEach((row) => { ys.push(y); y += rowH + gap + (row.weekday === 0 ? (r.days <= 31 ? 7 : 4) : 0); });
  const height = y;
  const dpr = Math.min(2, devicePixelRatio || 1);
  const cv = el("canvas", { width: W * dpr, height: height * dpr, style: `height:${height}px`, role: "img", "aria-label": `Screen time by time of day for ${r.days} days` });
  const g = cv.getContext("2d");
  g.scale(dpr, dpr);
  const col = Object.fromEntries(CATS.map((c) => [c, css(`--${c}`)]));
  const ink2 = css("--ink-2"), ink3 = css("--ink-3"), ink = css("--ink"), well = css("--well"), burnC = css("--burn");
  const plotW = W - left - right;
  const maxLit = Math.max(1, ...rows.map((x) => x.lit));
  g.textBaseline = "middle";
  rows.forEach((row, i) => {
    const ry = ys[i], ras = raster[i], nb = ras.lit.length, cw = plotW / nb;
    const selected = row.date === state.date;
    g.globalAlpha = 1;
    g.fillStyle = well;
    g.fillRect(left, ry, plotW, rowH);
    for (let b = 0; b < nb; b++) {
      const ch = ras.lit[b];
      if (ch === ".") continue;
      g.globalAlpha = 0.3 + 0.7 * ((Number(ch) + 1) / 10);
      g.fillStyle = col[CAT_LETTER[ras.cat[b]]] || col.other;
      g.fillRect(left + b * cw, ry, Math.ceil(cw * 10) / 10 + 0.3, rowH);
    }
    if (row.legacy && !row.has_data && row.lit > 0) {
      // a waytime total: how long, with no idea when, so it's a pale bar laid from the left edge
      g.globalAlpha = 0.34;
      g.fillStyle = ink3;
      g.fillRect(left, ry + rowH * 0.25, Math.min(1, row.lit / 86400) * plotW, rowH * 0.5);
    }
    g.globalAlpha = 1;
    // labels: every row when there's room, otherwise Mondays and the chosen day
    const dt = parseDate(row.date);
    const label = r.days <= 31 || row.weekday === 0 || selected;
    if (label) {
      g.font = `${selected ? 640 : 500} ${r.days <= 31 ? 12 : 11}px Archivo, sans-serif`;
      g.fillStyle = selected ? ink : row.weekday >= 5 ? ink2 : ink3;
      g.textAlign = "left";
      const txt = small || r.days > 31 ? `${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()].slice(0, 3)}` : `${WEEKDAYS[dt.getUTCDay()].slice(0, 3)} ${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()].slice(0, 3)}`;
      g.fillText(txt, 0, ry + rowH / 2 + 0.5);
    }
    if (selected) { g.fillStyle = ink; g.fillRect(left - 5, ry, 2, rowH); }
    if (row.lit > 0) {
      if (r.days <= 31) {
        g.textAlign = "right"; g.font = `${selected ? 640 : 500} 12px Archivo, sans-serif`;
        g.fillStyle = selected ? ink : ink2;
        g.fillText(dur(row.lit) + (row.legacy ? "*" : ""), W, ry + rowH / 2 + 0.5);
      } else {
        g.fillStyle = row.legacy ? ink3 : ink2;
        g.fillRect(left + plotW + 8, ry + 1, Math.max(1, (row.lit / maxLit) * (right - 10)), rowH - 2);
      }
    }
  });
  // burns, outlined on top
  g.strokeStyle = burnC; g.lineWidth = 1.5;
  for (const burn of (state.range._burns || [])) {
    const i = rows.findIndex((row) => row.date === burn.date);
    if (i < 0) continue;
    const bx = left + (burn.start / 86400) * plotW, bw = Math.max(2, ((burn.end - burn.start) / 86400) * plotW);
    g.strokeRect(bx, ys[i] - 0.5, bw, rowH + 1);
  }
  host.append(cv);
  host.style.setProperty("--rec-left", `${left}px`);
  host.style.setProperty("--rec-right", `${right}px`);
  const axis = el("div", { class: "axis-row" });
  const step = small ? 6 : 3;
  for (let hr = 0; hr <= 24; hr += step) axis.append(el("span", { style: `left:${(hr / 24) * 100}%`, text: pad2((hr + 4) % 24) + ":00" }));
  host.append(axis);
  if (rows.some((x) => x.legacy)) host.append(el("p", { class: "hint", text: "* A total carried over from waytime. No time of day was kept, so its bar only shows how long, starting from the left." }));

  const at = (ev) => {
    const box = cv.getBoundingClientRect();
    const py = ev.clientY - box.top, px = ev.clientX - box.left;
    let i = ys.findIndex((yy) => py >= yy && py < yy + rowH + gap);
    if (i < 0) return null;
    return { i, row: rows[i], ras: raster[i], bin: Math.floor(((px - left) / plotW) * raster[i].lit.length) };
  };
  cv.addEventListener("pointermove", (ev) => {
    const h = at(ev);
    if (!h) return hideTip();
    const nodes = [el("div", { class: "t-head", text: dateShort(h.row.date) }), el("div", { class: "t-big", text: h.row.lit ? `${dur(h.row.lit)} lit` : "Nothing recorded" })];
    if (h.bin >= 0 && h.bin < h.ras.lit.length && h.ras.lit[h.bin] !== ".") {
      const mins = (h.bin * 10 + 240) % 1440, c = CAT_LETTER[h.ras.cat[h.bin]];
      nodes.push(tipRow(c, `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}, mostly ${CAT_NAME[c]}`, `${Number(h.ras.lit[h.bin]) + 1} of 10 min`));
    }
    if (h.row.burn_seconds) nodes.push(tipRow(null, "In burns", dur(h.row.burn_seconds)));
    showTip(ev.clientX, ev.clientY, nodes);
  });
  cv.addEventListener("pointerleave", hideTip);
  cv.addEventListener("click", (ev) => { const h = at(ev); if (h && h.row.date !== state.date) setDate(h.row.date); });
}

/* ---- the census ---- */
function renderCensus() {
  const r = state.range, host = clear($("census"));
  const items = r.census.filter((e) => e.seconds >= 60 && e.median > 0);
  $("census-section").hidden = items.length < 3;
  if (items.length < 3) return;
  const W = Math.max(280, Math.floor(host.clientWidth));
  const small = W < 560;
  const H = small ? 320 : 400, m = { l: 44, r: 16, t: 26, b: 34 };
  const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, height: H });
  const xs = items.map((e) => e.median), ysv = items.map((e) => e.seconds);
  const x0 = Math.log10(Math.max(2, Math.min(...xs) * 0.45)), x1 = Math.log10(Math.max(...xs) * 1.6);
  const y0 = Math.log10(60), y1 = Math.log10(Math.max(...ysv) * 1.6);
  const X = (v) => m.l + ((Math.log10(v) - x0) / (x1 - x0)) * (W - m.l - m.r);
  const Y = (v) => H - m.b - ((Math.log10(v) - y0) / (y1 - y0)) * (H - m.t - m.b);
  for (const [v, label] of [[10, "10 s"], [60, "1 min"], [600, "10 min"], [3600, "1 h"], [3 * 3600, "3 h"]]) {
    if (Math.log10(v) < x0 || Math.log10(v) > x1) continue;
    svg.append(sv("line", { class: "grid", x1: X(v), x2: X(v), y1: m.t, y2: H - m.b }));
    svg.append(sv("text", { x: X(v), y: H - m.b + 17, "text-anchor": "middle" }, label));
  }
  for (const [v, label] of [[60, "1 min"], [600, "10 min"], [3600, "1 h"], [36000, "10 h"], [360000, "100 h"]]) {
    if (Math.log10(v) > y1) continue;
    svg.append(sv("line", { class: v === 60 ? "axis" : "grid", x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v) }));
    svg.append(sv("text", { x: m.l - 7, y: Y(v) + 4, "text-anchor": "end" }, label));
  }
  svg.append(sv("text", { class: "aside", x: m.l + 4, y: m.t - 9 }, "opened often, left quickly"));
  svg.append(sv("text", { class: "aside", x: W - m.r, y: m.t - 9, "text-anchor": "end" }, "long sittings"));

  const pts = items.map((e) => ({ e, x: X(e.median), y: Y(e.seconds), r: Math.min(15, 4 + Math.sqrt(e.sessions) * 0.5) }));
  pts.slice().sort((a, b) => b.r - a.r).forEach((p) => svg.append(sv("circle", { class: `dot c-${p.e.cat}`, cx: p.x, cy: p.y, r: p.r, "fill-opacity": 0.92 })));
  // name the ones that matter, where a name fits
  const placed = [];
  const want = new Set(items.slice(0, small ? 5 : 9).map((e) => e.key));
  const far = items.reduce((a, b) => (b.median > a.median ? b : a)); want.add(far.key);
  const busy = items.reduce((a, b) => (b.sessions > a.sessions ? b : a)); want.add(busy.key);
  for (const p of pts.slice().sort((a, b) => b.e.seconds - a.e.seconds)) {
    if (!want.has(p.e.key)) continue;
    const w = p.e.label.length * 6.8 + 6;
    // try beside it, then the other side, then above and below
    const tries = [
      { lx: p.x + p.r + 5, ly: p.y + 4.5, anchor: "start" }, { lx: p.x - p.r - 5, ly: p.y + 4.5, anchor: "end" },
      { lx: p.x, ly: p.y - p.r - 6, anchor: "middle" }, { lx: p.x, ly: p.y + p.r + 15, anchor: "middle" },
    ];
    for (const t of tries) {
      const bx0 = t.anchor === "start" ? t.lx : t.anchor === "end" ? t.lx - w : t.lx - w / 2;
      const box = { x0: bx0, x1: bx0 + w, y0: t.ly - 12, y1: t.ly + 4 };
      if (box.x0 < m.l || box.x1 > W - 2 || box.y0 < m.t - 4 || box.y1 > H - m.b) continue;
      if (placed.some((b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0)) continue;
      if (pts.some((q) => q !== p && q.x + q.r > box.x0 && q.x - q.r < box.x1 && q.y + q.r > box.y0 && q.y - q.r < box.y1)) continue;
      placed.push(box);
      svg.append(sv("text", { class: "star", x: t.lx, y: t.ly, "text-anchor": t.anchor }, p.e.label));
      break;
    }
  }
  const ring = sv("circle", { fill: "none", stroke: css("--ink"), "stroke-width": 1.5, visibility: "hidden" });
  svg.append(ring);
  const hit = sv("rect", { x: 0, y: 0, width: W, height: H, fill: "transparent", style: "touch-action: pan-y; cursor: pointer" });
  svg.append(hit);
  const nearest = (ev) => {
    const box = svg.getBoundingClientRect();
    const px = ((ev.clientX - box.left) / box.width) * W, py = ((ev.clientY - box.top) / box.height) * H;
    let best = null, bd = 34;
    for (const p of pts) { const dd = Math.hypot(p.x - px, p.y - py) - p.r; if (dd < bd) { bd = dd; best = p; } }
    return best;
  };
  hit.addEventListener("pointermove", (ev) => {
    const p = nearest(ev);
    if (!p) { ring.setAttribute("visibility", "hidden"); return hideTip(); }
    ring.setAttribute("cx", p.x); ring.setAttribute("cy", p.y); ring.setAttribute("r", p.r + 3); ring.setAttribute("visibility", "visible");
    showTip(ev.clientX, ev.clientY, [
      el("div", { class: "t-big", text: p.e.label }),
      tipRow(p.e.cat, CAT_NAME[p.e.cat], dur(p.e.seconds)),
      tipRow(null, "Visits", String(p.e.sessions)),
      tipRow(null, "A typical visit", dur(p.e.median)),
      tipRow(null, "The longest", dur(p.e.longest)),
      tipRow(null, "Days it showed up", `${p.e.days} of ${r.data_days}`),
    ]);
  });
  hit.addEventListener("pointerleave", () => { hideTip(); ring.setAttribute("visibility", "hidden"); });
  hit.addEventListener("click", (ev) => { const p = nearest(ev); if (p) openSheet(p.e, `these ${r.days} days`); });
  host.append(svg);

  const s = [];
  const swarm = items.filter((e) => e.median < 90 && e.sessions >= 20).sort((a, b) => b.seconds - a.seconds)[0];
  if (swarm) s.push(`${swarm.label} was opened ${swarm.sessions} times for about ${durWords(swarm.median)} a go, which still came to ${durWords(swarm.seconds)}.`);
  const giant = items.filter((e) => e.sessions >= 3 && e.median >= 900).sort((a, b) => b.median - a.median)[0];
  if (giant) s.push(`A sitting of ${giant.label} typically ran ${durWords(giant.median)}.`);
  if (!s.length) s.push(`${items.length} apps and sites over these ${r.days} days.`);
  $("census-finding").textContent = s.join(" ");
}

/* ---- burns (ignition) ---- */
function renderBurns() {
  const r = state.range, ig = r.ignition, host = clear($("burns"));
  const st = ig.status || {};
  if (!st.connected) {
    host.append(el("p", { class: "empty", text: st.url
      ? `ignition didn't answer at ${st.url}${st.error ? ` (${st.error})` : ""}. Set its address under Devices and the burns show up here and on the light curve.`
      : "Connect ignition under Devices and its burns show up here and on the light curve." }));
    return;
  }
  if (!ig.burns) {
    host.append(el("p", { class: "empty", text: `No burns in these ${r.days} days.` }));
  } else {
    const share = (cats, c) => { const t = CATS.reduce((a, k) => a + (cats[k] || 0), 0); return t ? Math.round(((cats[c] || 0) / t) * 100) : 0; };
    const s = [`${ig.burns === 1 ? "One burn" : `${ig.burns} burns`}, ${durWords(ig.seconds)} in all. A screen was lit for ${Math.round((ig.lit_during / Math.max(1, ig.seconds)) * 100)}% of that, and ${share(ig.during, "make")}% of what was lit went to making things.`];
    if (ig.after_windows) {
      const a = share(ig.after, "watch") + share(ig.after, "play"), o = share(ig.overall, "watch") + share(ig.overall, "play");
      if (Math.abs(a - o) >= 5) s.push(`In the half hour after a burn, watching and playing take ${a}% of screen time, against ${o}% the rest of the time.`);
      else s.push(`The half hour after a burn looks like any other: ${a}% watching and playing, against ${o}% overall.`);
    }
    host.append(el("p", { class: "finding small", text: s.join(" ") }));
    const grid = el("div", { class: "burn-grid" });
    const triple = el("div", { class: "triple" });
    const tot = (cats) => CATS.reduce((a, k) => a + (cats[k] || 0), 0);
    for (const [label, cats] of [["During burns", ig.during], ["The half hour after", ig.after], ["All screen time", ig.overall]]) {
      if (!tot(cats)) continue;
      triple.append(el("div", {}, el("div", { class: "row-label" }, el("b", { text: label }), el("span", { text: dur(tot(cats)) })), splitBar(cats)));
    }
    const legend = el("div", { class: "split-legend", style: "margin:0" });
    for (const c of CATS) if (ig.overall[c] > 0) legend.append(el("span", {}, el("i", { class: `key b-${c}` }), CAT_NAME[c]));
    triple.append(legend);
    if (ig.leaks.length) triple.append(el("p", { class: "caption", style: "margin-top:4px", text: `What got through during burns: ${listWords(ig.leaks.map(([l, sec]) => `${l} (${durWords(sec)})`))}.` }));
    grid.append(triple);

    const right = el("div");
    if (ig.enough) {
      const t = el("table", { class: "compare" });
      t.append(el("thead", {}, el("tr", {}, el("th"), el("th", { scope: "col", text: "Lit" }), el("th", { scope: "col", text: "Make" }), el("th", { scope: "col", text: "Watch and play" }))));
      const tb = el("tbody");
      for (const [label, side] of [["Days with a burn", ig.with], ["Days without", ig.without]]) {
        tb.append(el("tr", {}, el("th", { scope: "row" }, label, el("small", { text: `${side.days} days` })), el("td", { text: dur(side.lit) }), el("td", { text: dur(side.make) }), el("td", { text: dur(side.drift) })));
      }
      t.append(tb);
      right.append(t, el("p", { class: "caption", text: "The middle day of each kind. Burn days aren't picked at random, so read this as what tends to go together and not as what a burn causes." }));
    } else {
      right.append(el("p", { class: "caption", style: "margin-top:0", text: `Comparing days with and without a burn needs at least three of each. So far: ${ig.with.days} with, ${ig.without.days} without.` }));
    }
    grid.append(right);
    host.append(grid);
  }

  if (r.candidates.length) {
    host.append(el("h3", { style: "margin-top:34px", text: "Watching, playing and browsing that isn't on the block list" }));
    const ul = el("ul", { class: "cands" });
    for (const e of r.candidates.slice(0, 6)) ul.append(candidateRow(e));
    host.append(ul);
  }
}

function candidateRow(e) {
  const li = el("li");
  const open = el("button", { type: "button", class: "btn burnish", text: "Block in ignition" });
  li.append(el("span", { class: "who" }, el("i", { class: `key b-${e.cat}` }), el("span", { text: e.label })),
    el("span", { class: "time", text: `${dur(e.seconds)} in ${state.range.days} days` }), open);
  open.addEventListener("click", () => {
    open.remove();
    for (const p of e.parts.filter((x) => !x.blocked)) {
      const what = { sites: "Site address, blocked in every browser", apps: "Phone app", programs: "Program name, closed on your computers" }[p.list];
      const input = el("input", { type: "text", value: p.value, "aria-label": what, spellcheck: "false", autocapitalize: "off" });
      const go = el("button", { type: "button", class: "btn burnish", text: "Add to block list" });
      const msg = el("small", { text: what + (p.list === "programs" ? ". Check it matches the command that starts it." : p.list === "sites" ? ". Guessed from the page title, so check it." : ".") });
      const form = el("div", { class: "inline-form" }, input, go, msg);
      go.addEventListener("click", async () => {
        go.disabled = true;
        try {
          await api("/api/ignition/block", { method: "POST", body: { list: p.list, value: input.value.trim(), label: e.label } });
          clear(form).append(el("small", { text: `Added ${input.value.trim()} to ignition's block list.` }));
        } catch (err) {
          go.disabled = false;
          msg.className = "error"; msg.textContent = err.message;
        }
      });
      li.append(form);
    }
  });
  return li;
}

/* ---- devices ---- */
function renderDevices() {
  const dv = state.devices, host = clear($("devices"));
  const origin = location.origin;
  if (dv.devices.length) {
    const t = el("table", { class: "devs" });
    t.append(el("thead", {}, el("tr", {}, el("th", { scope: "col", text: "Name" }), el("th", { scope: "col", text: "Reporting" }), el("th", { scope: "col", class: "wide", text: "Kind" }), el("th", { scope: "col", class: "wide", text: "On record" }))));
    const tb = el("tbody");
    for (const d of dv.devices) {
      const fresh = d.silent_for < 900;
      const rename = el("button", { type: "button", text: d.name, title: "Rename" });
      rename.addEventListener("click", async () => {
        const name = prompt(`A new name for ${d.name}`, d.name);
        if (name && name.trim() && name.trim() !== d.name) { await api(`/api/devices/${encodeURIComponent(d.id)}`, { method: "PATCH", body: { name: name.trim() } }); load("all"); }
      });
      const kind = el("select", { "aria-label": `What kind of device ${d.name} is` }, ["desktop", "laptop", "phone", "tablet"].map((k) => el("option", { value: k, selected: k === d.kind, text: k })));
      kind.addEventListener("change", async () => { await api(`/api/devices/${encodeURIComponent(d.id)}`, { method: "PATCH", body: { kind: kind.value } }); load("all"); });
      tb.append(el("tr", {},
        el("td", { class: "name" }, rename, el("small", { text: `${d.platform || "unknown"}${d.version ? ", tracker " + d.version : ""}` })),
        el("td", {}, el("span", { class: `state ${fresh ? "live" : d.kind === "phone" && d.silent_for > 2700 ? "stale" : ""}`, text: fresh ? "now" : ago(d.silent_for) })),
        el("td", { class: "wide" }, kind),
        el("td", { class: "wide" }, `${d.spans.toLocaleString()} spans`, d.legacy_days ? el("small", { text: `and ${d.legacy_days} days of waytime totals` }) : null)));
    }
    t.append(tb);
    host.append(t);
  } else {
    host.append(el("p", { class: "empty", text: "No device has reported yet. Add one below and its time shows up within a minute." }));
  }

  const setup = el("div", { class: "setup" });
  setup.append(el("div", {}, el("h3", { text: "Add a Linux computer" }),
    el("p", { text: "KDE Plasma 6 on Wayland. Paste this in a terminal on it:" }),
    el("pre", { text: `curl -fsSL https://raw.githubusercontent.com/ieatfood314/lightcurve/main/install.sh | sh -s -- --hub ${origin}` })));
  const phone = el("div", {}, el("h3", { text: "Add an Android phone" }),
    el("p", {}, "Install the app from the ", el("a", { href: "https://github.com/ieatfood314/lightcurve/releases/latest", text: "latest release", style: "color:inherit" }), ", allow usage access when it asks, and give it this address:"),
    el("pre", { text: origin }));
  if (window.LightcurveNative) phone.append(el("p", { style: "margin-top:10px" }, el("button", { type: "button", class: "btn", text: "Open phone settings", onclick: () => window.LightcurveNative.openSettings() })));
  setup.append(phone);

  const ig = dv.ignition || {};
  const input = el("input", { type: "text", value: ig.url || "", placeholder: "http://127.0.0.1:4580", "aria-label": "ignition address", spellcheck: "false", autocapitalize: "off" });
  const status = el("p", { class: "hint", style: "margin-top:8px", text: ig.demo ? "Demo data is standing in for ignition." : ig.connected ? "Connected. Burns and the block list are read from here." : ig.url ? `No answer: ${ig.error || "unknown error"}.` : "Not set." });
  const save = el("button", { type: "button", class: "btn", text: "Save address" });
  save.addEventListener("click", async () => {
    save.disabled = true;
    try { await api("/api/settings", { method: "PUT", body: { ignition_url: input.value.trim() } }); await load("all"); }
    catch (e) { status.className = "error"; status.textContent = e.message; save.disabled = false; }
  });
  setup.append(el("div", {}, el("h3", { text: "ignition" }),
    el("p", { text: "Where your ignition server answers, so burns can be laid over the record." }),
    el("div", { class: "field" }, input, save), status));
  host.append(setup);

  $("foot").textContent = `lightcurve ${dv.version}. A day runs from ${pad2(dv.day_start_hour)}:00 to ${pad2(dv.day_start_hour)}:00, so a late night stays with the day it belongs to. Site names are read from window titles, which makes them good guesses and not facts. A computer counts as lit while a window has focus and you're there: leave it for more than five minutes and the count stops at your last touch, unless a video is keeping the screen awake. A phone counts while an app is in front with the screen on.`;
}

/* ---- the sheet: what a thing counts as ---- */
function openSheet(e, scope) {
  const sheet = clear($("sheet"));
  const cats = el("div", { class: "cats" });
  for (const c of CATS) {
    const b = el("button", { type: "button", "aria-pressed": String(c === e.cat) }, el("i", { class: `key b-${c}` }), el("span", {}, CAT_NAME[c], el("small", { text: CAT_ABOUT[c] })));
    b.addEventListener("click", async () => {
      await api("/api/category", { method: "PUT", body: { key: e.key, cat: c } });
      closeSheet();
      load("all");
    });
    cats.append(b);
  }
  const parts = el("div", { class: "parts" });
  for (const p of e.parts || []) {
    parts.append(el("div", {}, el("span", {}, p.kind === "site" ? "Site, by its title: " : "App: ", el("code", { text: p.id })), p.blocked ? el("span", { text: "on ignition's block list" }) : null));
  }
  const card = el("div", { class: "card", role: "dialog", "aria-modal": "true", "aria-label": e.label },
    el("h3", { text: e.label }),
    el("p", { class: "meta", text: `${durWords(e.seconds)} over ${e.sessions} ${e.sessions === 1 ? "visit" : "visits"}, ${scope}. It counts as:` }),
    cats, parts,
    el("div", { class: "row" }, el("button", { type: "button", class: "btn", text: "Close", onclick: closeSheet })));
  sheet.append(card);
  sheet.hidden = false;
  sheet._return = document.activeElement;
  (cats.querySelector('[aria-pressed="true"]') || card.querySelector("button")).focus();
}
function closeSheet() {
  const sheet = $("sheet");
  if (sheet.hidden) return;
  sheet.hidden = true;
  if (sheet._return && sheet._return.isConnected) sheet._return.focus();
}
$("sheet").addEventListener("click", (ev) => { if (ev.target === $("sheet")) closeSheet(); });

/* ---- putting it together ---- */
function render() {
  const d = state.day, r = state.range;
  d._byKey = Object.fromEntries(d.entities.map((e) => [e.key, e]));
  if (r) r._burns = (r.ignition && r.ignition.list) || [];
  renderHeadline();
  renderCurve();
  renderWhere();
  renderAttention();
  if (r) { renderRecord(); renderCensus(); renderBurns(); }
  if (state.devices) renderDevices();
  for (const b of document.querySelectorAll(".seg button")) b.setAttribute("aria-pressed", String(Number(b.dataset.days) === state.days));
  state.first = false;
}

$("prev").addEventListener("click", () => setDate(shiftDate(state.date, -1)));
$("next").addEventListener("click", () => setDate(shiftDate(state.date, 1)));
$("today").addEventListener("click", () => setDate(state.day.today));
$("home").addEventListener("click", (ev) => { ev.preventDefault(); setDate(state.day.today); });
$("pick").addEventListener("click", () => { const i = $("date-input"); if (i.showPicker) i.showPicker(); else i.click(); });
$("date-input").addEventListener("change", (ev) => { if (ev.target.value) setDate(ev.target.value); });
$("more-things").addEventListener("click", () => { state.showAll = !state.showAll; renderWhere(); });
for (const b of document.querySelectorAll(".seg button")) {
  b.addEventListener("click", () => { state.days = Number(b.dataset.days); localStorage.setItem("lightcurve-days", state.days); load("range"); });
}
$("theme").addEventListener("click", () => {
  const dark = css("--glow") === "1";
  const next = dark ? "plate" : "sky";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("lightcurve-theme", next);
  paintChrome();
  render();
});
function paintChrome() {
  document.querySelector('meta[name="theme-color"]').content = css("--field");
  if (window.LightcurveNative && window.LightcurveNative.setBars) window.LightcurveNative.setBars(css("--field"), css("--glow") === "1");
}
addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") return closeSheet();
  if (ev.target.matches("input, select, textarea") || ev.metaKey || ev.ctrlKey || ev.altKey || !$("sheet").hidden) return;
  if (ev.key === "ArrowLeft") setDate(shiftDate(state.date, -1));
  if (ev.key === "ArrowRight" && state.date < state.day.today) setDate(shiftDate(state.date, 1));
});
let resizeTimer, lastWidth = innerWidth;
addEventListener("resize", () => {
  if (innerWidth === lastWidth) return; // a phone's address bar sliding away isn't a resize worth redrawing for
  lastWidth = innerWidth;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => state.day && render(), 120);
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { paintChrome(); if (state.day) render(); });
// today keeps itself current while the page is open and in view
setInterval(() => { if (!document.hidden && state.day && state.date === state.day.today && $("sheet").hidden) load("all"); }, 60000);
document.addEventListener("visibilitychange", () => { if (!document.hidden && state.day && state.date === state.day.today) load("all"); });

const m = location.hash.match(/^#(\d{4}-\d{2}-\d{2})$/);
if (m) state.date = m[1];
paintChrome();
(document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(() => load("all"));
