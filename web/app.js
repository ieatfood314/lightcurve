/* lightcurve dashboard. No build step, no dependencies. One view at a time: day, weeks, apps, burns, devices. */
"use strict";

/* ---- small tools ---- */
const $ = (id) => document.getElementById(id);
const NS = "http://www.w3.org/2000/svg";
const CATS = ["make", "talk", "other", "browse", "watch", "play"]; // good to bad
const CAT_NAME = { make: "Make", watch: "Watch", talk: "Talk", play: "Play", browse: "Browse", other: "Other" };
const CAT_ABOUT = {
  make: "Writing, building, coding", watch: "Video, feeds, reading", talk: "Messages, mail, calls",
  play: "Games", browse: "Other web pages", other: "Settings, files, home screen",
};
const CAT_LETTER = { m: "make", w: "watch", t: "talk", p: "play", b: "browse", o: "other" };
const VIEWS = ["day", "weeks", "apps", "burns", "limits", "devices"];

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

/** 6h 05m, 42m, 30s */
function dur(s) {
  s = Math.round(s || 0);
  const m = Math.floor(s / 60), h = Math.floor(m / 60);
  if (h) return `${h}h ${pad2(m % 60)}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}
/** The big number: hours and minutes with small units. */
function bigDur(node, s) {
  const m = Math.floor(Math.round(s || 0) / 60), h = Math.floor(m / 60);
  clear(node);
  if (h) node.append(String(h), el("small", { text: "h" }), pad2(m % 60), el("small", { text: "m" }));
  else node.append(String(m), el("small", { text: "m" }));
}
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const parseDate = (d) => { const [y, m, dd] = d.split("-").map(Number); return new Date(Date.UTC(y, m - 1, dd)); };
const isoDate = (dt) => dt.toISOString().slice(0, 10);
const shiftDate = (d, n) => { const dt = parseDate(d); dt.setUTCDate(dt.getUTCDate() + n); return isoDate(dt); };
function dateLong(d) { const dt = parseDate(d); return `${WEEKDAYS[dt.getUTCDay()]} ${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()]}`; }
function dateShort(d) { const dt = parseDate(d); return `${WEEKDAYS[dt.getUTCDay()].slice(0, 3)} ${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()].slice(0, 3)}`; }
function ago(seconds) {
  if (seconds < 90) return "now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400 * 2) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} days ago`;
}
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
function luminance(hex) {
  const c = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const key = (cat) => el("i", { class: `key b-${cat}` });

/* ---- state ---- */
const state = {
  view: "day", date: null, device: null, days: Number(localStorage.getItem("lightcurve-days")) || 28,
  day: null, range: null, devices: null, limits: null, allDay: false, allApps: false, first: true,
};
const devName = (id) => (state.day && state.day.devices.find((d) => d.id === id) || {}).name || id;
const devKind = (id) => ((state.devices && state.devices.devices.find((d) => d.id === id)) || (state.day && state.day.devices.find((d) => d.id === id)) || {}).kind || "desktop";

/* ---- devices: an icon for each kind, and the row that picks one ---- */
const DEV_PATHS = {
  desktop: ["M3 4.5h14a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z", "M7.5 18h5M10 14.5V18"],
  laptop: ["M4.5 5h11a1 1 0 0 1 1 1v7.5h-13V6a1 1 0 0 1 1-1z", "M1.5 13.5h17l-1 2.5h-15z"],
  phone: ["M7 2h6a1.5 1.5 0 0 1 1.5 1.5v13A1.5 1.5 0 0 1 13 18H7a1.5 1.5 0 0 1-1.5-1.5v-13A1.5 1.5 0 0 1 7 2z", "M9 15.5h2"],
  tablet: ["M5 2.5h10a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 16V4A1.5 1.5 0 0 1 5 2.5z", "M9 15h2"],
};
function devIcon(kind, title) {
  const s = sv("svg", { class: "dev-icon", viewBox: "0 0 20 20", "aria-hidden": title ? null : "true" });
  if (title) s.append(sv("title", {}, title));
  for (const d of DEV_PATHS[kind] || DEV_PATHS.desktop) s.append(sv("path", { d }));
  return s;
}
/** Small icons for the devices something was used on, when more than one device is in play. */
function deviceIcons(ids) {
  if (!ids || state.device) return null;
  const known = (state.day ? state.day.devices : []).filter((d) => d.seconds > 0);
  if (known.length < 2 && !(state.range && state.range.devices.filter((d) => d.seconds > 0).length > 1)) return null;
  return el("span", { class: "devs" }, ids.map((id) => devIcon(devKind(id), devName(id))));
}
/** All, then each device with time in what's showing. Picking one narrows every view to it. */
function renderWho(list, allSeconds) {
  const shown = list.filter((d) => d.seconds > 0 || d.id === state.device);
  for (const host of document.querySelectorAll(`#v-${state.view} .who-row`)) {
    clear(host);
    if (shown.length < 2 && !state.device) continue;
    const pick = (id) => () => { if (state.device === id) return; state.device = id; state.allDay = state.allApps = false; load("all"); };
    host.append(el("button", { type: "button", class: "who", "aria-pressed": String(!state.device), onclick: pick(null) },
      "All", el("b", { text: dur(allSeconds) })));
    for (const d of shown) {
      host.append(el("button", { type: "button", class: "who", "aria-pressed": String(state.device === d.id), onclick: pick(d.id) },
        devIcon(d.kind), d.name, el("b", { text: dur(d.seconds) })));
    }
  }
}

async function api(path, opts) {
  const r = await fetch(path, opts && { method: opts.method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(opts.body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Hub answered ${r.status}`);
  return data;
}

async function load(what = "all") {
  document.body.classList.add("loading");
  try {
    const jobs = [];
    const dev = state.device ? `&device=${encodeURIComponent(state.device)}` : "";
    const q = (state.date ? `date=${state.date}` : "") + dev;
    if (what !== "range") jobs.push(api(`/api/day?${q}`).then((d) => { state.day = d; if (!state.date) state.date = d.date; }));
    if (what === "all" || what === "range") {
      jobs.push(api(`/api/range?days=${state.days}${state.date ? `&end=${state.date}` : ""}${dev}`).then((r) => { state.range = r; }));
    }
    if (what === "all") jobs.push(api("/api/devices").then((d) => { state.devices = d; }), loadLimits());
    await Promise.all(jobs);
    render();
  } catch (e) {
    $("versus").textContent = `Can't reach the hub`;
  } finally {
    document.body.classList.remove("loading");
  }
}

function setHash() {
  const today = state.day ? state.day.today : null;
  const h = state.view !== "day" ? `#${state.view}` : state.date && state.date !== today ? `#${state.date}` : "";
  history.replaceState(null, "", location.pathname + location.search + h);
}
function setDate(date) {
  const today = state.day ? state.day.today : null;
  if (today && date > today) date = today;
  state.date = date;
  state.view = "day";
  state.allDay = false;
  setHash();
  load("all");
  window.scrollTo(0, 0);
}
function setView(view) {
  state.view = view;
  setHash();
  if (state.day) render();
  window.scrollTo(0, 0);
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

// Most time first. The bars keep their good-to-bad order; the labels are read as a ranking.
const byTime = (cats) => CATS.filter((c) => cats[c] > 0).sort((a, b) => cats[b] - cats[a]);

function legend(host, cats, burn) {
  clear(host);
  for (const c of byTime(cats)) host.append(el("span", { title: CAT_ABOUT[c] }, key(c), CAT_NAME[c], el("b", { text: dur(cats[c]) })));
  if (burn) host.append(el("span", {}, el("i", { class: "burn-key" }), "Burn"));
}

/* ---- day ---- */
function clock(day, offset) {
  const t = new Date((day.t0 + offset + day.utc_offset) * 1000);
  return `${pad2(t.getUTCHours())}:${pad2(t.getUTCMinutes())}`;
}
/** Seconds counted for the day: what was recorded, plus any waytime total for a computer that kept no times. */
const dayTotal = (d) => (d.has_data ? d.lit : 0) + (d.legacy ? d.legacy.seconds : 0);

function renderHeadline() {
  const d = state.day;
  const isToday = d.date === d.today;
  $("date-label").textContent = isToday ? "Today" : d.date === shiftDate(d.today, -1) ? "Yesterday" : dateLong(d.date);
  $("next").disabled = isToday;
  $("today").hidden = isToday;
  $("date-input").max = d.today;
  $("date-input").value = d.date;
  document.title = isToday ? "lightcurve" : `${dateShort(d.date)}, lightcurve`;

  bigDur($("lit"), dayTotal(d));
  const u = d.usual || {};
  let versus = "";
  if (!d.has_data && d.legacy) versus = "waytime total";
  else if (!d.has_data) versus = d.in_progress ? "nothing yet" : "nothing recorded";
  else if (u.enough) {
    const base = d.in_progress ? u.lit_by_now : u.lit;
    const diff = d.lit - base;
    versus = Math.abs(diff) < Math.max(600, base * 0.1) ? "about usual" : `${dur(Math.abs(diff))} ${diff > 0 ? "over" : "under"} usual`;
  } else if (d.in_progress) versus = "so far";
  $("versus").textContent = versus;

  const notes = clear($("notes"));
  for (const n of d.notes || []) notes.append(el("div", { text: `${n.name} silent since ${clock(d, n.since)}` }));
  const live = d.ignition && d.ignition.live;
  if (isToday && live && live.phase === "burning") notes.append(el("div", { text: `Burn until ${clock(d, live.ends_at - d.t0)}` }));
}

function renderDayChart() {
  const d = state.day, host = clear($("curve"));
  $("day-figure").hidden = !d.has_data;
  if (!d.has_data) return;
  const W = Math.max(280, Math.floor(host.clientWidth));
  const span = d.t1 - d.t0;
  const x = (off) => (off / span) * W;
  const small = W < 560;
  const H = small ? 120 : 160, top = 22, base = top + H;
  const stripGap = 38, stripH = 14;
  const strips = d.strips;
  const stripsTop = base + 54;
  const height = stripsTop + strips.length * stripGap - (strips.length ? stripGap - stripH - 8 : 20);
  const svg = sv("svg", { viewBox: `0 0 ${W} ${height}`, height });
  const defs = sv("defs");
  const hatch = sv("pattern", { id: "hatch", width: 6, height: 6, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" });
  hatch.append(sv("rect", { width: 6, height: 6, fill: css("--well") }), sv("line", { x1: 0, y1: 0, x2: 0, y2: 6, stroke: css("--ink-3"), "stroke-width": 1.4 }));
  defs.append(hatch);
  svg.append(defs);

  for (const b of d.burns) {
    const a = Math.max(0, b.start), e = Math.min(span, b.live ? Math.max(b.start, d.now - d.t0) : b.end);
    if (e <= a) continue;
    const bx = x(a), bw = Math.max(2, x(e) - x(a));
    svg.append(sv("rect", { class: "burn", x: bx, y: top - 6, width: bw, height: height - top + 6 }));
    svg.append(sv("line", { class: "burn-edge", x1: bx, x2: bx, y1: top - 6, y2: height }));
    if (!b.live) svg.append(sv("line", { class: "burn-edge", x1: bx + bw, x2: bx + bw, y1: top - 6, y2: height }));
  }

  // an hour is full at the top line
  svg.append(sv("line", { class: "grid", x1: 0, x2: W, y1: top, y2: top }));
  svg.append(sv("line", { class: "grid", x1: 0, x2: W, y1: top + H / 2, y2: top + H / 2 }));
  svg.append(sv("text", { x: W, y: top - 6, "text-anchor": "end" }, "60m"));
  svg.append(sv("text", { x: W, y: top + H / 2 - 6, "text-anchor": "end" }, "30m"));
  svg.append(sv("line", { class: "axis", x1: 0, x2: W, y1: base, y2: base }));
  const step = small ? 6 : W < 900 ? 3 : 2;
  for (let hr = 0; hr <= 24; hr += step) {
    const px = x(hr * 3600);
    svg.append(sv("line", { class: "axis", x1: px, x2: px, y1: base, y2: base + 5 }));
    svg.append(sv("text", { x: px, y: base + 19, "text-anchor": hr === 0 ? "start" : hr === 24 ? "end" : "middle" }, clock(d, hr * 3600)));
  }

  // one column an hour, stacked by what it went to
  const n = d.curve.length, binS = span / n, per = Math.round(3600 / binS);
  const hours = [];
  for (let i = 0; i < n; i += per) {
    let lit = 0; const cats = {}, tops = {};
    for (let j = i; j < Math.min(n, i + per); j++) {
      const c = d.curve[j];
      if (!c) continue;
      lit += c.lit * binS;
      for (const [k, v] of Object.entries(c.cats)) cats[k] = (cats[k] || 0) + v;
      for (const [label, v] of c.top) tops[label] = (tops[label] || 0) + v;
    }
    hours.push({ from: i * binS, to: Math.min(n, i + per) * binS, lit: Math.min(lit, 3600), cats, top: Object.entries(tops).sort((a, b) => b[1] - a[1]).slice(0, 3) });
  }
  const cw = W / hours.length, gap = small ? 2 : 6;
  const cols = sv("g", { class: state.first ? "develop" : "" });
  hours.forEach((h, i) => {
    if (h.lit <= 0) return;
    const sum = CATS.reduce((a, c) => a + (h.cats[c] || 0), 0) || 1;
    let y = base;
    const full = (h.lit / 3600) * H;
    for (const c of CATS) {
      const part = ((h.cats[c] || 0) / sum) * full;
      if (part <= 0) continue;
      const hh = Math.max(1, part - (part > 4 ? 2 : 0));
      cols.append(sv("rect", { class: `c-${c}`, x: i * cw + gap / 2, y: y - part, width: Math.max(2, cw - gap), height: hh, rx: Math.min(3, hh / 2), style: `--i:${i}` }));
      y -= part;
    }
  });
  svg.append(cols);

  strips.forEach((st, k) => {
    const y = stripsTop + k * stripGap;
    const dev = d.devices.find((v) => v.id === st.device) || { name: st.device };
    const ic = devIcon(devKind(st.device));
    for (const [k3, v3] of Object.entries({ x: 0, y: y - 20, width: 15, height: 15 })) ic.setAttribute(k3, v3);
    ic.classList.add("strip-icon");
    svg.append(ic, sv("text", { class: "name", x: 21, y: y - 7 }, dev.name));
    svg.append(sv("text", { x: W, y: y - 7, "text-anchor": "end" }, dur(st.seconds)));
    svg.append(sv("rect", { class: "track", x: 0, y, width: W, height: stripH, rx: 3 }));
    const note = (d.notes || []).find((nn) => nn.device === st.device);
    const nowOff = d.in_progress ? d.now - d.t0 : null;
    if (note && nowOff != null) svg.append(sv("rect", { class: "unknown", x: x(note.since), y, width: Math.max(0, x(nowOff) - x(note.since)), height: stripH, rx: 3 }));
    for (const [a, b, k2] of st.spans) {
      const e = entity(k2);
      svg.append(sv("rect", { class: `c-${e ? e.cat : "other"}`, x: x(a), y, width: Math.max(0.6, x(b) - x(a)), height: stripH }));
    }
    for (const p of st.pickups || []) svg.append(sv("line", { class: "pickup", x1: x(p), x2: x(p), y1: y + stripH + 2, y2: y + stripH + 6 }));
  });

  if (d.in_progress) {
    const nx = x(d.now - d.t0);
    svg.append(sv("line", { class: "now", x1: nx, x2: nx, y1: top - 4, y2: height }));
  }

  const hover = sv("rect", { class: "hover", y: top, height: H, width: cw, visibility: "hidden" });
  svg.append(hover);
  const hit = sv("rect", { x: 0, y: 0, width: W, height, fill: "transparent", style: "touch-action: pan-y" });
  svg.append(hit);
  const catOf = {}; for (const e of d.entities) catOf[e.label] = e.cat;
  hit.addEventListener("pointermove", (ev) => {
    const box = svg.getBoundingClientRect();
    const px = ((ev.clientX - box.left) / box.width) * W, py = ((ev.clientY - box.top) / box.height) * height;
    const off = (px / W) * span;
    const k = Math.floor((py - stripsTop + 18) / stripGap);
    if (py > base + 30 && k >= 0 && k < strips.length) {
      hover.setAttribute("visibility", "hidden");
      const st = strips[k];
      const tol = (5 / W) * span;
      const best = st.spans.find((s) => s[0] <= off && off < s[1]) || st.spans.find((s) => Math.abs(s[0] - off) < tol || Math.abs(s[1] - off) < tol);
      if (!best) return hideTip();
      const e = entity(best[2]) || { label: best[2].slice(2), cat: "other" };
      return showTip(ev.clientX, ev.clientY, [
        el("div", { class: "t-head", text: `${clock(d, best[0])} to ${clock(d, best[1])}` }),
        tipRow(e.cat, e.label, dur(best[1] - best[0])),
      ]);
    }
    const i = Math.max(0, Math.min(hours.length - 1, Math.floor(px / cw)));
    const h = hours[i];
    hover.setAttribute("x", i * cw); hover.setAttribute("visibility", "visible");
    const rows = [el("div", { class: "t-head", text: `${clock(d, h.from)} to ${clock(d, h.to)}` }), el("div", { class: "t-big", text: dur(h.lit) })];
    for (const [label, secs] of h.top) rows.push(tipRow(catOf[label] || "other", label, dur(secs)));
    showTip(ev.clientX, ev.clientY, rows);
  });
  hit.addEventListener("pointerleave", () => { hideTip(); hover.setAttribute("visibility", "hidden"); });
  host.append(svg);
  legend($("legend"), d.categories, d.burns.length);
}
const entity = (k) => state.day._byKey[k];

function renderStats() {
  const d = state.day, a = d.attention, u = d.usual || {}, host = clear($("stats"));
  host.hidden = !d.has_data;
  if (!d.has_data) return;
  const add = (label, value, usual) => host.append(el("div", {}, el("dt", { text: label }),
    el("dd", {}, value, u.enough && usual != null ? el("small", { text: `usually ${usual}` }) : null)));
  if (a.longest_sitting) add("Longest sitting", dur(a.longest_sitting.seconds), u.longest_sitting != null ? dur(u.longest_sitting) : null);
  if (d.devices.some((v) => v.kind === "phone")) add("Pickups", String(a.pickups), u.pickups != null ? String(Math.round(u.pickups)) : null);
  if (a.switch_rate != null) add("Switches an hour", String(Math.round(a.switch_rate)), u.switch_rate != null ? String(Math.round(u.switch_rate)) : null);
  if (d.first && d.first.at != null) add("First", clock(d, d.first.at), u.first != null ? clock(d, u.first) : null);
  if (d.last && d.last.at != null && !d.in_progress) add("Last", clock(d, d.last.at), u.last != null ? clock(d, u.last) : null);
}

/** Rows for a list of apps: recorded ones, plus waytime totals folded in by name. */
function mergeApps(entities, legacyApps) {
  const rows = entities.map((e) => ({ ...e }));
  const by = Object.fromEntries(rows.map((e) => [e.label.toLowerCase(), e]));
  for (const [label, secs, cat] of legacyApps || []) {
    const hit = by[label.toLowerCase()];
    if (hit) hit.seconds += secs;
    else rows.push({ key: `n:${label.toLowerCase()}`, label, cat, seconds: secs, parts: [] });
  }
  return rows.sort((a, b) => b.seconds - a.seconds);
}
function appRows(list, rows, limit, scope) {
  clear(list);
  const max = rows[0] ? rows[0].seconds : 1;
  for (const e of rows.slice(0, limit)) {
    list.append(el("li", {}, el("button", { type: "button", class: "thing", onclick: () => openSheet(e, scope), "aria-label": `${e.label}, ${dur(e.seconds)}, ${CAT_NAME[e.cat]}` },
      el("span", { class: "nm" }, key(e.cat), el("span", { class: "label", text: e.label }), e.blocked ? lockIcon() : null, deviceIcons(e.devices)),
      el("span", {}, el("span", { class: `bar-fill b-${e.cat}`, style: `width:${Math.max(1, (e.seconds / max) * 100)}%` })),
      el("span", { class: "time", text: dur(e.seconds) }))));
  }
}
function moreButton(btn, total, limit, all) {
  btn.hidden = total <= limit;
  btn.textContent = all ? "Show fewer" : `Show all ${total}`;
}
function lockIcon() {
  const s = sv("svg", { class: "lock", viewBox: "0 0 12 12" });
  s.append(sv("title", {}, "Blocked by ignition"));
  s.append(sv("path", { d: "M3.2 5.2V3.8a2.8 2.8 0 0 1 5.6 0v1.4M2.4 5.2h7.2v5.2H2.4z", fill: "none", stroke: "currentColor", "stroke-width": 1.4, "stroke-linejoin": "round" }));
  return s;
}

function renderDayApps() {
  const d = state.day;
  const rows = mergeApps(d.has_data ? d.entities : [], d.legacy && d.legacy.apps);
  appRows($("things"), rows, state.allDay ? rows.length : 10, "this day");
  moreButton($("more-things"), rows.length, 10, state.allDay);
}

/* ---- weeks ---- */
function renderWeeks() {
  const r = state.range, host = clear($("record"));
  bigDur($("avg"), r.average);
  const W = Math.max(280, Math.floor(host.clientWidth));
  const small = W < 560;
  const left = small ? 52 : 74, right = small ? 50 : 66;
  const rowH = r.days <= 7 ? 26 : r.days <= 31 ? 15 : 7, gap = r.days <= 31 ? 3 : 2;
  const rows = r.rows.slice().reverse(), raster = r.raster.slice().reverse();
  let y = 0; const ys = [];
  rows.forEach((row) => { ys.push(y); y += rowH + gap + (row.weekday === 0 ? (r.days <= 31 ? 7 : 4) : 0); });
  const height = y;
  const dpr = Math.min(2, devicePixelRatio || 1);
  const cv = el("canvas", { width: W * dpr, height: height * dpr, style: `height:${height}px`, role: "img", "aria-label": `Screen time by time of day, ${r.days} days` });
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
      g.globalAlpha = 0.35 + 0.65 * ((Number(ch) + 1) / 10);
      g.fillStyle = col[CAT_LETTER[ras.cat[b]]] || col.other;
      g.fillRect(left + b * cw, ry, Math.ceil(cw * 10) / 10 + 0.3, rowH);
    }
    if (row.legacy && !row.has_data && row.lit > 0) {
      // a waytime total has a length and no time of day: a pale bar from the left
      g.globalAlpha = 0.34;
      g.fillStyle = ink3;
      g.fillRect(left, ry + rowH * 0.25, Math.min(1, row.lit / 86400) * plotW, rowH * 0.5);
    }
    g.globalAlpha = 1;
    const dt = parseDate(row.date);
    if (r.days <= 31 || row.weekday === 0 || selected) {
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
        g.fillStyle = selected ? ink : row.legacy && !row.has_data ? ink3 : ink2;
        g.fillText(dur(row.lit), W, ry + rowH / 2 + 0.5);
      } else {
        g.fillStyle = row.legacy ? ink3 : ink2;
        g.fillRect(left + plotW + 8, ry + 1, Math.max(1, (row.lit / maxLit) * (right - 10)), rowH - 2);
      }
    }
  });
  g.strokeStyle = burnC; g.lineWidth = 1.5;
  for (const burn of (r._burns || [])) {
    const i = rows.findIndex((row) => row.date === burn.date);
    if (i < 0) continue;
    const bx = left + (burn.start / 86400) * plotW, bw = Math.max(2, ((burn.end - burn.start) / 86400) * plotW);
    g.strokeRect(bx, ys[i] - 0.5, bw, rowH + 1);
  }
  host.append(cv);
  host.style.setProperty("--rec-left", `${left}px`);
  host.style.setProperty("--rec-right", `${right}px`);
  const axis = el("div", { class: "axis-row" });
  for (let hr = 0; hr <= 24; hr += small ? 6 : 3) axis.append(el("span", { style: `left:${(hr / 24) * 100}%`, text: pad2((hr + 4) % 24) + ":00" }));
  host.append(axis);
  legend($("weeks-legend"), r.categories, (r._burns || []).length);

  const at = (ev) => {
    const box = cv.getBoundingClientRect();
    const py = ev.clientY - box.top, px = ev.clientX - box.left;
    const i = ys.findIndex((yy) => py >= yy && py < yy + rowH + gap);
    if (i < 0) return null;
    return { row: rows[i], ras: raster[i], bin: Math.floor(((px - left) / plotW) * raster[i].lit.length) };
  };
  cv.addEventListener("pointermove", (ev) => {
    const h = at(ev);
    if (!h) return hideTip();
    const nodes = [el("div", { class: "t-head", text: dateShort(h.row.date) }), el("div", { class: "t-big", text: h.row.lit ? dur(h.row.lit) : "Nothing" })];
    if (h.row.legacy) nodes.push(tipRow(null, "waytime total", dur(h.row.legacy_seconds)));
    if (h.bin >= 0 && h.bin < h.ras.lit.length && h.ras.lit[h.bin] !== ".") {
      const mins = (h.bin * 10 + 240) % 1440, c = CAT_LETTER[h.ras.cat[h.bin]];
      nodes.push(tipRow(c, `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)} ${CAT_NAME[c]}`, `${Number(h.ras.lit[h.bin]) + 1} of 10 min`));
    }
    if (h.row.burn_seconds) nodes.push(tipRow(null, "Burns", dur(h.row.burn_seconds)));
    showTip(ev.clientX, ev.clientY, nodes);
  });
  cv.addEventListener("pointerleave", hideTip);
  cv.addEventListener("click", (ev) => { const h = at(ev); if (h) setDate(h.row.date); });
}

/* ---- apps ---- */
function splitBar(cats) {
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
  requestAnimationFrame(() => { for (const seg of bar.children) if (seg.clientWidth > 44) seg.textContent = seg.dataset.label; });
  return bar;
}

function renderApps() {
  const r = state.range;
  const rows = mergeApps(r.census, r.legacy_apps);
  const cats = Object.fromEntries(CATS.map((c) => [c, 0]));
  for (const e of rows) cats[e.cat] = (cats[e.cat] || 0) + e.seconds;
  bigDur($("apps-total"), rows.reduce((a, e) => a + e.seconds, 0));
  $("apps-count").textContent = `${rows.length} ${rows.length === 1 ? "app" : "apps and sites"}`;
  const split = clear($("apps-split"));
  if (rows.length) {
    const lg = el("div", { class: "legend" });
    legend(lg, cats);
    split.append(splitBar(cats), lg);
  }
  appRows($("apps-list"), rows, state.allApps ? rows.length : 15, `${r.days} days`);
  moreButton($("more-apps"), rows.length, 15, state.allApps);
}

/* ---- burns (ignition) ---- */
function renderBurns() {
  const r = state.range, ig = r.ignition, host = clear($("burns"));
  const st = ig.status || {};
  if (!st.connected) {
    host.append(el("p", { class: "empty" }, "ignition isn't connected. ", el("button", { type: "button", class: "btn", text: "Connect", onclick: () => setView("devices") })));
    return;
  }
  const fig = el("p", { class: "figure" }, el("span", { class: "num", text: String(ig.burns || 0) }),
    el("span", { class: "versus", text: ig.burns ? `${ig.burns === 1 ? "burn" : "burns"}, ${dur(ig.seconds)}` : "burns" }));
  host.append(fig);
  if (ig.burns) {
    const tot = (cats) => CATS.reduce((a, k) => a + (cats[k] || 0), 0);
    const triple = el("div", { class: "triple" });
    for (const [label, cats] of [["During burns", ig.during], ["30 min after", ig.after], ["All screen time", ig.overall]]) {
      if (!tot(cats)) continue;
      triple.append(el("div", {}, el("div", { class: "row-label" }, el("b", { text: label }), el("span", { text: dur(tot(cats)) })), splitBar(cats)));
    }
    if (triple.children.length) {
      const lg = el("div", { class: "legend", style: "margin-top:2px" });
      for (const c of byTime(ig.overall)) lg.append(el("span", {}, key(c), CAT_NAME[c]));
      triple.append(lg);
      host.append(triple);
    }
    if (ig.leaks.length) {
      host.append(el("h2", { text: "Got through" }));
      const t = el("table", { class: "table" }), tb = el("tbody");
      for (const [label, sec] of ig.leaks) tb.append(el("tr", {}, el("td", { text: label }), el("td", { text: dur(sec) })));
      t.append(tb);
      host.append(t);
    }
    if (ig.enough) {
      host.append(el("h2", { text: "A typical day" }));
      const t = el("table", { class: "table" });
      t.append(el("thead", {}, el("tr", {}, el("th"), el("th", { scope: "col", text: "Screen" }), el("th", { scope: "col", text: "Make" }), el("th", { scope: "col", text: "Watch + play" }))));
      const tb = el("tbody");
      for (const [label, side] of [["With a burn", ig.with], ["Without", ig.without]]) {
        tb.append(el("tr", {}, el("th", { scope: "row" }, label, el("small", { text: `${side.days} days` })), el("td", { text: dur(side.lit) }), el("td", { text: dur(side.make) }), el("td", { text: dur(side.drift) })));
      }
      t.append(tb);
      host.append(t);
    }
  }
  if (r.candidates.length) {
    host.append(el("h2", { text: "Not blocked" }));
    const ul = el("ul", { class: "cands" });
    for (const e of r.candidates.slice(0, 6)) ul.append(candidateRow(e));
    host.append(ul);
  }
}

function candidateRow(e) {
  const li = el("li");
  const open = el("button", { type: "button", class: "btn burnish", text: "Block" });
  li.append(el("span", { class: "nm" }, key(e.cat), el("span", { text: e.label })), el("span", { class: "time", text: dur(e.seconds) }), open);
  open.addEventListener("click", () => {
    open.remove();
    for (const p of e.parts.filter((x) => !x.blocked)) {
      const what = { sites: "Site", apps: "Phone app", programs: "Program" }[p.list];
      const input = el("input", { type: "text", value: p.value, "aria-label": what, spellcheck: "false", autocapitalize: "off" });
      const go = el("button", { type: "button", class: "btn burnish", text: "Add" });
      const msg = el("small", { class: "hint", text: what });
      const form = el("div", { class: "inline-form" }, msg, input, go);
      go.addEventListener("click", async () => {
        go.disabled = true;
        try {
          await api("/api/ignition/block", { method: "POST", body: { list: p.list, value: input.value.trim(), label: e.label } });
          clear(form).append(el("small", { class: "hint", text: `Blocked ${input.value.trim()}` }));
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
    const t = el("table", { class: "table" });
    const tb = el("tbody");
    for (const d of dv.devices) {
      const fresh = d.silent_for < 900;
      const rename = el("button", { type: "button", text: d.name, title: "Rename" });
      rename.addEventListener("click", async () => {
        const name = prompt("Name", d.name);
        if (name && name.trim() && name.trim() !== d.name) { await api(`/api/devices/${encodeURIComponent(d.id)}`, { method: "PATCH", body: { name: name.trim() } }); load("all"); }
      });
      const kind = el("select", { "aria-label": `Kind of device, ${d.name}` }, ["desktop", "laptop", "phone", "tablet"].map((k) => el("option", { value: k, selected: k === d.kind, text: k })));
      kind.addEventListener("change", async () => { await api(`/api/devices/${encodeURIComponent(d.id)}`, { method: "PATCH", body: { kind: kind.value } }); load("all"); });
      tb.append(el("tr", {},
        el("td", { class: "name" }, rename),
        el("td", {}, el("span", { class: `state ${fresh ? "live" : d.kind === "phone" && d.silent_for > 2700 ? "stale" : ""}`, text: ago(d.silent_for) })),
        el("td", { class: "wide" }, kind)));
    }
    t.append(tb);
    host.append(t);
  }

  const setup = el("div", { class: "setup" });
  setup.append(el("div", {}, el("h2", { text: "Add a computer" }),
    el("pre", { text: `curl -fsSL https://raw.githubusercontent.com/ieatfood314/lightcurve/main/install.sh | sh -s -- --hub ${origin}` })));
  const phone = el("div", {}, el("h2", { text: "Add a phone" }),
    el("p", {}, el("a", { href: "https://github.com/ieatfood314/lightcurve/releases/latest", text: "Get the app" }), ", then enter"),
    el("pre", { text: origin }));
  if (window.LightcurveNative) phone.append(el("p", { style: "margin-top:10px" }, el("button", { type: "button", class: "btn", text: "Phone settings", onclick: () => window.LightcurveNative.openSettings() })));
  setup.append(phone);

  const ig = dv.ignition || {};
  const input = el("input", { type: "text", value: ig.url || "", placeholder: "http://127.0.0.1:4580", "aria-label": "ignition address", spellcheck: "false", autocapitalize: "off" });
  const status = el("p", { class: "hint", text: ig.demo ? "Demo data" : ig.connected ? "Connected" : ig.url ? "No answer" : "" });
  const save = el("button", { type: "button", class: "btn", text: "Save" });
  save.addEventListener("click", async () => {
    save.disabled = true;
    try { await api("/api/settings", { method: "PUT", body: { ignition_url: input.value.trim() } }); await load("all"); }
    catch (e) { status.className = "error"; status.textContent = e.message; save.disabled = false; }
  });
  setup.append(el("div", {}, el("h2", { text: "ignition" }), el("div", { class: "field" }, input, save), status));
  host.append(setup, el("p", { class: "version", text: `lightcurve ${dv.version}` }));
}

/* ---- limits ---- */
const RULE_KINDS = { day: "A day", every: "In any", block: "Closed", window: "Between", stretch: "At a time" };
// Python's weekdays: 0 is Monday.
const LDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const ALL = [0, 1, 2, 3, 4, 5, 6];
const DEFAULT_UNLOCK = { hold: 5, wait: 3, grant: 10, per_day: null };
const hhmm = (ms) => { const t = new Date(ms); return `${pad2(t.getHours())}:${pad2(t.getMinutes())}`; };
function whenText(ms) {
  const t = new Date(ms), n = new Date();
  const days = Math.round((new Date(t.getFullYear(), t.getMonth(), t.getDate()) - new Date(n.getFullYear(), n.getMonth(), n.getDate())) / 864e5);
  if (days <= 0) return hhmm(ms);
  if (days === 1) return `tomorrow ${hhmm(ms)}`;
  return `${WEEKDAYS[t.getDay()].slice(0, 3)} ${hhmm(ms)}`;
}
function minText(m) {
  if (m < 60) return `${m} min`;
  return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`;
}
function daysText(days) {
  if (!days || days.length === 7) return "";
  const s = days.join("");
  if (s === "01234") return " on weekdays";
  if (s === "56") return " on weekends";
  return " on " + days.map((d) => LDAYS[d].slice(0, 3)).join(", ");
}
function ruleText(r) {
  const on = daysText(r.days);
  if (r.kind === "day") return r.minutes ? `${minText(r.minutes)} a day${on}` : `Closed all day${on}`;
  if (r.kind === "every") return `${minText(r.minutes)} in any ${r.hours} h`;
  if (r.kind === "block") return `Closed ${r.from} to ${r.to}${on}`;
  if (r.kind === "window") return `${minText(r.minutes)} from ${r.from} to ${r.to}${on}`;
  return `${minText(r.minutes)} at a time, then ${minText(r.rest)} off`;
}
function limitStatus(item) {
  const s = item.state;
  if (s.blocked) return { text: s.until ? `Closed until ${whenText(s.until * 1000)}` : "Closed", alert: true };
  if (s.left != null) return { text: `${dur(s.left)} left`, alert: false };
  return { text: "Open", alert: false };
}

/** A button that only acts once it has been held down for `seconds`. Letting go early starts it over. */
function holdButton(text, seconds, onDone, cls) {
  const b = el("button", { type: "button", class: `btn hold ${cls || ""}`, "aria-label": `${text}, hold ${seconds} seconds` },
    el("span", { class: "fill", "aria-hidden": "true" }), el("span", { class: "t", text }));
  let t0 = 0, raf = 0;
  const reset = () => { t0 = 0; cancelAnimationFrame(raf); b.style.setProperty("--p", 0); };
  const step = () => {
    const p = Math.min(1, (performance.now() - t0) / (seconds * 1000));
    b.style.setProperty("--p", p);
    if (p >= 1) { t0 = 0; onDone(b); } else raf = requestAnimationFrame(step);
  };
  const begin = () => { if (t0 || b.disabled) return; t0 = performance.now(); raf = requestAnimationFrame(step); };
  b.addEventListener("pointerdown", (ev) => { if (ev.button) return; b.setPointerCapture(ev.pointerId); begin(); });
  for (const t of ["pointerup", "pointercancel", "lostpointercapture"]) b.addEventListener(t, () => { if (t0) reset(); });
  b.addEventListener("keydown", (ev) => { if ((ev.key === " " || ev.key === "Enter") && !ev.repeat) { ev.preventDefault(); begin(); } });
  b.addEventListener("keyup", (ev) => { if ((ev.key === " " || ev.key === "Enter") && t0) reset(); });
  b.addEventListener("contextmenu", (ev) => ev.preventDefault());
  return b;
}

async function loadLimits() {
  try { state.limits = await api("/api/limits"); } catch (e) { state.limits = null; }
}

function renderLimits() {
  const L = state.limits, host = clear($("limits"));
  if (!L) { host.append(el("p", { class: "empty", text: "Can't reach the hub" })); return; }
  const n = L.limits.length;
  const add = el("button", { type: "button", class: "btn primary", text: "New limit", onclick: () => openLimit(null) });
  if (!n) {
    host.append(el("p", { class: "figure" }, el("span", { class: "num", text: "0" }), el("span", { class: "versus", text: "limits" })), el("p", { class: "limits-new" }, add));
  } else {
    host.append(el("p", { class: "figure" }, el("span", { class: "num", text: String(n) }), el("span", { class: "versus", text: n === 1 ? "limit" : "limits" })));
    const ul = el("ul", { class: "limits" });
    for (const item of L.limits) ul.append(limitRow(item));
    host.append(ul, el("p", { class: "limits-new" }, add));
  }
  host.append(limitSettings(L));
}

function limitRow(item) {
  const l = item.limit, st = limitStatus(item);
  const tight = item.state.rules.filter((r) => r.active && r.allowed).sort((a, b) => (a.allowed - a.used) - (b.allowed - b.used))[0];
  const kids = [
    el("span", { class: "l-head" }, el("span", { class: "l-name", text: item.label }), el("span", { class: `l-state${st.alert ? " alert" : ""}`, text: st.text })),
    el("span", { class: "l-rules", text: l.rules.map((r, i) => { const t = ruleText(r); return i ? t[0].toLowerCase() + t.slice(1) : t; }).join(", ") }),
  ];
  if (tight) {
    kids.push(el("span", { class: "l-bar", title: `${dur(tight.used)} of ${dur(tight.allowed)}` },
      el("span", { class: tight.used >= tight.allowed ? "over" : "", style: `width:${Math.min(100, (tight.used / tight.allowed) * 100)}%` })));
  }
  if (item.pending_at) kids.push(el("span", { class: "l-pending", text: item.deleting ? `Goes at ${whenText(item.pending_at)}` : `Change at ${whenText(item.pending_at)}` }));
  return el("li", {}, el("button", { type: "button", class: "limit", onclick: () => openLimit(item) }, kids));
}

function limitSettings(L) {
  const s = L.settings, box = el("div", { class: "limit-settings" });
  const wait = el("input", { type: "number", min: 0, max: 1440, value: s.changes_wait, inputmode: "numeric", "aria-label": "Minutes a loosening waits" });
  const guard = el("input", { type: "checkbox", checked: s.guard, id: "guard-box" });
  const msg = el("p", { class: "hint" });
  if (L.settings_pending && L.settings_at) msg.textContent = `Change at ${whenText(L.settings_at)}`;
  const body = () => ({ changes_wait: Number(wait.value), guard: guard.checked });
  const actions = el("div", { class: "row-actions" });
  const save = el("button", { type: "button", class: "btn", text: "Save" });
  const finish = async () => {
    try {
      const r = await api("/api/limits/settings", { method: "PUT", body: body() });
      await loadLimits(); renderLimits();
      if (!r.applied) { const p = $("limits").querySelector(".limit-settings .hint"); if (p) p.textContent = `Change at ${whenText(r.at)}`; }
    } catch (e) { msg.className = "error"; msg.textContent = e.message; }
  };
  save.addEventListener("click", async () => {
    try {
      const dry = await api("/api/limits/settings", { method: "PUT", body: { ...body(), dry: true } });
      if (!dry.wait) return finish();
      save.replaceWith(holdButton("Hold to save", 5, finish));
      msg.className = "hint"; msg.textContent = `Takes effect ${dry.minutes} min after`;
    } catch (e) { msg.className = "error"; msg.textContent = e.message; }
  });
  actions.append(save);
  if (L.settings_pending) actions.append(el("button", { type: "button", class: "quiet", text: "Keep as it is", onclick: async () => { await api("/api/limits/settings", { method: "PUT", body: { cancel: true } }); await loadLimits(); renderLimits(); } }));
  box.append(el("h2", { text: "Changes" }),
    el("label", { class: "line" }, "Loosening waits", wait, "min"),
    el("label", { class: "line", for: "guard-box" }, guard, "Cover lightcurve's settings on phones"),
    actions, msg);
  return box;
}

/* the editor */
function numIn(value, min, max, label, onset) {
  const i = el("input", { type: "number", class: "n", min, max, value: value == null ? "" : value, inputmode: "numeric", "aria-label": label });
  i.addEventListener("input", () => onset(i.value === "" ? null : Number(i.value)));
  return i;
}
function timeIn(value, label, onset) {
  const i = el("input", { type: "time", value, "aria-label": label, step: 60 });
  i.addEventListener("input", () => { if (i.value) onset(i.value.slice(0, 5)); });
  return i;
}
function dayPicker(r) {
  const box = el("span", { class: "days", role: "group", "aria-label": "Days" });
  for (const d of ALL) {
    const b = el("button", { type: "button", "aria-pressed": String(r.days.includes(d)), "aria-label": LDAYS[d], title: LDAYS[d], text: LDAYS[d][0] });
    b.addEventListener("click", () => {
      const on = r.days.includes(d);
      if (on && r.days.length === 1) return;
      r.days = on ? r.days.filter((x) => x !== d) : [...r.days, d].sort();
      b.setAttribute("aria-pressed", String(!on));
    });
    box.append(b);
  }
  return box;
}
const RULE_DEFAULTS = {
  day: { minutes: 60 }, every: { minutes: 30, hours: 4 }, block: { from: "22:00", to: "07:00" },
  window: { minutes: 20, from: "09:00", to: "17:00" }, stretch: { minutes: 20, rest: 30 },
};
function newRule(kind) {
  const r = { kind, ...RULE_DEFAULTS[kind] };
  if (["day", "block", "window"].includes(kind)) r.days = [...ALL];
  return r;
}
function ruleRow(r, onKind, onRemove) {
  const kind = el("select", { "aria-label": "Kind of rule" }, Object.entries(RULE_KINDS).map(([k, v]) => el("option", { value: k, selected: k === r.kind, text: v })));
  kind.addEventListener("change", () => onKind(kind.value));
  const set = (k) => (v) => { r[k] = v; };
  const f = [];
  if (r.kind === "day") f.push(numIn(r.minutes, 0, 1440, "Minutes", set("minutes")), "min");
  if (r.kind === "every") f.push(numIn(r.minutes, 0, 1440, "Minutes", set("minutes")), "min in", numIn(r.hours, 1, 24, "Hours", set("hours")), "h");
  if (r.kind === "block") f.push(timeIn(r.from, "From", set("from")), "to", timeIn(r.to, "To", set("to")));
  if (r.kind === "window") f.push(numIn(r.minutes, 0, 1440, "Minutes", set("minutes")), "min,", timeIn(r.from, "From", set("from")), "to", timeIn(r.to, "To", set("to")));
  if (r.kind === "stretch") f.push(numIn(r.minutes, 1, 720, "Minutes at a time", set("minutes")), "min, then", numIn(r.rest, 1, 720, "Minutes off", set("rest")), "off");
  const row = el("div", { class: "rule" }, el("div", { class: "rule-line" }, kind, ...f,
    el("button", { type: "button", class: "x", "aria-label": "Remove rule", title: "Remove", text: "×", onclick: onRemove })));
  if (r.days) row.append(dayPicker(r));
  return row;
}

function openLimit(item) {
  // The limit in force, not a change that's waiting: what's saved from here is measured against it.
  const draft = item ? JSON.parse(JSON.stringify(item.limit))
    : { targets: [], labels: {}, name: "", rules: [newRule("day")], unlock: { ...DEFAULT_UNLOCK } };
  draft.labels = draft.labels || {};
  const sheet = clear($("sheet"));
  const card = el("div", { class: "card wide", role: "dialog", "aria-modal": "true", "aria-label": item ? item.label : "New limit" });

  // what it covers
  const things = (state.range ? state.range.census : []).filter((e) => e.key);
  const byLabel = Object.fromEntries(things.map((e) => [e.label.toLowerCase(), e]));
  const chips = el("div", { class: "chips" });
  const listId = "limit-things";
  const pick = el("input", { type: "text", list: listId, placeholder: "Add an app or site", "aria-label": "Add an app or site", autocapitalize: "off", spellcheck: "false" });
  const data = el("datalist", { id: listId }, things.slice(0, 300).map((e) => el("option", { value: e.label })));
  const cats = el("div", { class: "cat-toggles", role: "group", "aria-label": "Every app of a kind" });
  const drawChips = () => {
    clear(chips);
    for (const t of draft.targets.filter((x) => x.startsWith("n:"))) {
      chips.append(el("span", { class: "chip" }, draft.labels[t] || t.slice(2),
        el("button", { type: "button", "aria-label": `Remove ${draft.labels[t] || t.slice(2)}`, text: "×", onclick: () => { draft.targets = draft.targets.filter((x) => x !== t); drawChips(); } })));
    }
    for (const b of cats.children) b.setAttribute("aria-pressed", String(draft.targets.includes(`c:${b.dataset.cat}`)));
  };
  const addThing = () => {
    const v = pick.value.trim();
    if (!v) return;
    const hit = byLabel[v.toLowerCase()];
    const k = hit ? hit.key : `n:${v.toLowerCase()}`;
    if (!draft.targets.includes(k)) draft.targets.push(k);
    draft.labels[k] = hit ? hit.label : v;
    pick.value = "";
    drawChips();
  };
  pick.addEventListener("change", addThing);
  pick.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); addThing(); } });
  for (const c of CATS) {
    const b = el("button", { type: "button", "data-cat": c, title: `Everything in ${CAT_NAME[c]}` }, key(c), CAT_NAME[c]);
    b.addEventListener("click", () => {
      const t = `c:${c}`;
      draft.targets = draft.targets.includes(t) ? draft.targets.filter((x) => x !== t) : [...draft.targets, t];
      drawChips();
    });
    cats.append(b);
  }
  drawChips();

  // the rules
  const rules = el("div", { class: "rules" });
  const drawRules = () => {
    clear(rules);
    draft.rules.forEach((r, i) => rules.append(ruleRow(r,
      (k) => { draft.rules[i] = newRule(k); drawRules(); },
      () => { draft.rules.splice(i, 1); drawRules(); })));
  };
  drawRules();
  const addRule = el("select", { class: "add-rule", "aria-label": "Add a rule" },
    el("option", { value: "", text: "Add a rule" }), Object.entries(RULE_KINDS).map(([k, v]) => el("option", { value: k, text: v })));
  addRule.addEventListener("change", () => { if (addRule.value) { draft.rules.push(newRule(addRule.value)); addRule.value = ""; drawRules(); } });

  // unlocking
  const u = draft.unlock || { ...DEFAULT_UNLOCK };
  const allow = el("input", { type: "checkbox", checked: !!draft.unlock, id: "allow-unlock" });
  const uset = (k) => (v) => { u[k] = v; };
  const unlockFields = el("div", { class: "unlock" },
    el("label", { class: "line" }, "Hold", numIn(u.hold, 1, 60, "Seconds to hold", uset("hold")), "s, then wait", numIn(u.wait, 0, 120, "Minutes to wait", uset("wait")), "min"),
    el("label", { class: "line" }, "Opens for", numIn(u.grant, 1, 240, "Minutes it opens for", uset("grant")), "min, up to", numIn(u.per_day, 1, 50, "Unlocks a day", uset("per_day")), "a day"));
  unlockFields.hidden = !draft.unlock;
  allow.addEventListener("change", () => { unlockFields.hidden = !allow.checked; });

  const name = el("input", { type: "text", value: draft.name || "", placeholder: "Name", "aria-label": "Name", maxlength: 60 });
  const msg = el("p", { class: "hint" });
  if (item && item.pending_at) msg.textContent = item.deleting ? `Goes at ${whenText(item.pending_at)}` : `A change waits until ${whenText(item.pending_at)}. Saving replaces it.`;

  const body = () => ({ ...draft, name: name.value.trim(), unlock: allow.checked ? { ...u, per_day: u.per_day || null } : null });
  const fail = (e) => { msg.className = "error"; msg.textContent = e.message; };
  const done = async (r) => {
    await loadLimits();
    closeSheet();
    renderLimits();
    if (r && r.applied === false) showTipNote(`Takes effect at ${whenText(r.at)}`);
  };
  const actions = el("div", { class: "row" });
  const save = el("button", { type: "button", class: "btn primary", text: "Save" });
  const commit = async () => { try { await done(await api("/api/limits", { method: "PUT", body: body() })); } catch (e) { fail(e); } };
  save.addEventListener("click", async () => {
    try {
      if (item) {
        const dry = await api("/api/limits", { method: "PUT", body: { ...body(), dry: true } });
        if (dry.wait) {
          save.replaceWith(holdButton("Hold to save", 5, commit, "primary"));
          msg.className = "hint"; msg.textContent = `Loosens it, so it takes effect ${dry.minutes} min after`;
          return;
        }
      }
      await commit();
    } catch (e) { fail(e); }
  });
  if (item) {
    actions.append(holdButton("Hold to delete", 5, async () => {
      try { await done(await api(`/api/limits/${encodeURIComponent(item.limit.id)}`, { method: "DELETE" })); } catch (e) { fail(e); }
    }, "danger"));
    if (item.pending_at) actions.append(el("button", { type: "button", class: "btn", text: "Keep as it is", onclick: async () => { await api(`/api/limits/${encodeURIComponent(item.limit.id)}/cancel`, { method: "POST", body: {} }); done(); } }));
  }
  actions.append(el("span", { class: "grow" }), el("button", { type: "button", class: "btn", text: "Close", onclick: closeSheet }), save);

  card.append(el("h3", { text: item ? item.label : "New limit" }), name,
    el("h4", { text: "What" }), chips, el("div", { class: "field" }, pick), data, cats,
    el("h4", { text: "Rules" }), rules, addRule,
    el("h4", { text: "Unlocking" }), el("label", { class: "line", for: "allow-unlock" }, allow, "Allow unlocking"), unlockFields,
    msg, actions);
  sheet.append(card);
  sheet.hidden = false;
  sheet._return = document.activeElement;
  (item ? name : pick).focus();
}

/** A short note in the corner, for a change that has been put off. */
function showTipNote(text) {
  const n = el("div", { class: "note-toast", role: "status", text });
  document.body.append(n);
  setTimeout(() => n.remove(), 4000);
}

/* ---- the sheet: what an app counts as ---- */
function openSheet(e, scope) {
  const sheet = clear($("sheet"));
  const cats = el("div", { class: "cats" });
  for (const c of CATS) {
    const b = el("button", { type: "button", "aria-pressed": String(c === e.cat), title: CAT_ABOUT[c] }, key(c), CAT_NAME[c]);
    b.addEventListener("click", async () => {
      await api("/api/category", { method: "PUT", body: { key: e.key, cat: c } });
      closeSheet();
      load("all");
    });
    cats.append(b);
  }
  const parts = el("div", { class: "parts" });
  for (const p of e.parts || []) parts.append(el("div", {}, el("code", { text: p.id }), p.blocked ? el("span", { class: "blocked", text: "blocked" }) : null));
  const meta = [dur(e.seconds)];
  if (e.sessions) meta.push(`${e.sessions} ${e.sessions === 1 ? "visit" : "visits"}`);
  meta.push(scope);
  const card = el("div", { class: "card", role: "dialog", "aria-modal": "true", "aria-label": e.label },
    el("h3", { text: e.label }),
    el("p", { class: "meta", text: meta.join(", ") }),
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
  for (const v of VIEWS) $(`v-${v}`).hidden = v !== state.view;
  for (const b of document.querySelectorAll("[data-view]")) {
    if (b.dataset.view === state.view) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  }
  for (const b of document.querySelectorAll(".seg button")) b.setAttribute("aria-pressed", String(Number(b.dataset.days) === state.days));
  if (state.view === "day") renderWho(d.devices, d.all_seconds);
  else if (r && state.view !== "devices" && state.view !== "limits") renderWho(r.devices, r.all_seconds);
  if (state.view === "day") { renderHeadline(); renderDayChart(); renderStats(); renderDayApps(); state.first = false; }
  else if (state.view === "weeks" && r) renderWeeks();
  else if (state.view === "apps" && r) renderApps();
  else if (state.view === "burns" && r) renderBurns();
  else if (state.view === "limits") renderLimits();
  else if (state.view === "devices" && state.devices) renderDevices();
}

for (const seg of document.querySelectorAll(".seg")) {
  for (const n of [7, 28, 90]) {
    seg.append(el("button", { type: "button", "data-days": n, text: `${n} days`, onclick: () => {
      state.days = n; localStorage.setItem("lightcurve-days", n); state.allApps = false; load("range");
    } }));
  }
}
for (const b of document.querySelectorAll("[data-view]")) b.addEventListener("click", () => setView(b.dataset.view));
$("prev").addEventListener("click", () => setDate(shiftDate(state.date, -1)));
$("next").addEventListener("click", () => setDate(shiftDate(state.date, 1)));
$("today").addEventListener("click", () => setDate(state.day.today));
$("home").addEventListener("click", (ev) => { ev.preventDefault(); if (state.day) setDate(state.day.today); });
$("pick").addEventListener("click", () => { const i = $("date-input"); if (i.showPicker) i.showPicker(); else i.click(); });
$("date-input").addEventListener("change", (ev) => { if (ev.target.value) setDate(ev.target.value); });
$("more-things").addEventListener("click", () => { state.allDay = !state.allDay; renderDayApps(); });
$("more-apps").addEventListener("click", () => { state.allApps = !state.allApps; renderApps(); });
$("theme").addEventListener("click", () => {
  const next = css("--dark") === "1" ? "plate" : "sky";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("lightcurve-theme", next);
  paintChrome();
  if (state.day) render();
});
function paintChrome() {
  document.querySelector('meta[name="theme-color"]').content = css("--field");
  if (window.LightcurveNative && window.LightcurveNative.setBars) window.LightcurveNative.setBars(css("--field"), css("--dark") === "1");
}
addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") return closeSheet();
  if (ev.target.matches("input, select, textarea") || ev.metaKey || ev.ctrlKey || ev.altKey || !$("sheet").hidden || state.view !== "day" || !state.day) return;
  if (ev.key === "ArrowLeft") setDate(shiftDate(state.date, -1));
  if (ev.key === "ArrowRight" && state.date < state.day.today) setDate(shiftDate(state.date, 1));
});
let resizeTimer, lastWidth = innerWidth;
addEventListener("resize", () => {
  if (innerWidth === lastWidth) return; // a phone's address bar sliding away isn't worth a redraw
  lastWidth = innerWidth;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => state.day && render(), 120);
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { paintChrome(); if (state.day) render(); });
// today keeps itself current while the page is open and in view
const fresh = () => { if (!document.hidden && state.day && state.date === state.day.today && $("sheet").hidden && !document.querySelector(".inline-form") && !(document.activeElement && document.activeElement.matches("input, select"))) load("all"); };
setInterval(fresh, 60000);
document.addEventListener("visibilitychange", fresh);

const h = location.hash.slice(1);
if (/^\d{4}-\d{2}-\d{2}$/.test(h)) state.date = h;
else if (VIEWS.includes(h)) state.view = h;
paintChrome();
(document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(() => load("all"));
