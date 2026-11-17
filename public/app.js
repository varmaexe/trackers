"use strict";

// ---------- date utils (local time) ----------
const pad = (n) => String(n).padStart(2, "0");
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return fmt(d); };
const today = () => fmt(new Date());
const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 86400e3);
const weekStart = (s) => addDays(s, -((parse(s).getDay() + 6) % 7));
const nice = (s, opts = { weekday: "short", day: "numeric", month: "short" }) => parse(s).toLocaleDateString(undefined, opts);
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0];
const LOAD_DAYS = 400;

// ---------- storage (per device, best effort) ----------
const store = {
  get(k, def) { try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch { return def; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

// ---------- state ----------
const S = {
  trackers: [], entries: [], books: [], totals: new Map(), first: new Map(),
  view: "today", date: today(), range: 30, authed: false,
  online: navigator.onLine, outbox: store.get("tr.outbox", []), vapidKey: null, push: null,
  user: null, diary: new Map(), invites: null,
};
const MOOD_COLORS = ["#ef4444", "#f97316", "#eab308", "#84cc16", "#22c55e"];
const MOOD_WORDS = ["Awful", "Meh", "Okay", "Good", "Great"];
// Diary mood behaves like a 1–5 rating tracker in insights.
const MOOD_T = { id: "__mood", name: "Mood", emoji: "🙂", kind: "rating", polarity: "build", period: "day", color: "#eab308", created_at: Date.now() };
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
const COLORS = ["#6366f1", "#0ea5e9", "#14b8a6", "#22c55e", "#eab308", "#f97316", "#ef4444", "#ec4899", "#a855f7", "#64748b"];
const RATE_FACES = ["😣", "😕", "😐", "🙂", "😄"];

const TEMPLATES = [
  { name: "Medicine", emoji: "💊", kind: "check", goal: 1, category: "Health", color: "#0ea5e9", reminders: ["09:00"] },
  { name: "Minoxidil", emoji: "🧴", kind: "check", goal: 2, category: "Hair & skin", color: "#14b8a6", reminders: ["09:00", "21:00"] },
  { name: "Skincare AM", emoji: "☀️", kind: "check", goal: 1, category: "Hair & skin", color: "#eab308" },
  { name: "Skincare PM", emoji: "🌙", kind: "check", goal: 1, category: "Hair & skin", color: "#a855f7", reminders: ["22:00"] },
  { name: "Hair oil", emoji: "🫒", kind: "check", goal: 2, period: "week", category: "Hair & skin", color: "#22c55e" },
  { name: "Skin condition", emoji: "✨", kind: "rating", goal: 4, category: "Hair & skin", color: "#ec4899" },
  { name: "Hair shedding", emoji: "💇", kind: "rating", polarity: "quit", goal: 2, category: "Hair & skin", color: "#64748b" },
  { name: "Study", emoji: "🧠", kind: "duration", goal: 60, category: "Learning", color: "#6366f1" },
  { name: "Reading", emoji: "📚", kind: "count", unit: "pages", goal: 20, category: "Learning", color: "#f97316" },
  { name: "Gym", emoji: "🏋️", kind: "check", goal: 1, days: "1,3,5", category: "Health", color: "#22c55e" },
  { name: "Water", emoji: "💧", kind: "count", unit: "glasses", goal: 8, category: "Health", color: "#0ea5e9" },
  { name: "Sleep quality", emoji: "😴", kind: "rating", goal: 4, category: "Health", color: "#a855f7" },
  { name: "Smoking", emoji: "🚬", kind: "count", unit: "cigs", polarity: "quit", goal: 0, category: "Bad habits", color: "#ef4444" },
  { name: "Doomscrolling", emoji: "📱", kind: "duration", polarity: "quit", goal: 30, category: "Bad habits", color: "#ec4899" },
  { name: "Junk food", emoji: "🍔", kind: "check", polarity: "quit", goal: 0, category: "Bad habits", color: "#f97316" },
];

// ---------- api ----------
async function api(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch("/api" + path, {
      method,
      headers: { "content-type": "application/json", "x-requested-with": "tracker" },
      body: body ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
    });
  } catch {
    setOnline(false);
    const err = new Error("You're offline — try again when connected");
    err.offline = true;
    throw err;
  }
  setOnline(true);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith("/auth/")) { showAuth(); const e = new Error("Please log in"); e.status = 401; throw e; }
  if (!res.ok) { const e = new Error(data.error || res.statusText); e.status = res.status; throw e; }
  return data;
}

function setOnline(v) {
  if (S.online === v) return;
  S.online = v;
  renderNet();
}

async function load() {
  const data = await api(`/state?since=${addDays(today(), -LOAD_DAYS)}`);
  // Never sync one person's queued offline entries into another person's account.
  if (store.get("tr.uid") !== data.user.id) { S.outbox = []; saveOutbox(); store.set("tr.uid", data.user.id); }
  S.authed = true;
  applyState(data);
  saveCache();
  syncTz();
}

function applyState(data) {
  S.trackers = data.trackers || [];
  S.books = data.books || [];
  S.vapidKey = data.vapidPublicKey || S.vapidKey;
  S.user = data.user || S.user;
  S.diary = new Map((data.diary || []).map((d) => [d.date, d]));
  for (const o of S.outbox) if (o.op === "diary") o.mood == null && !o.text ? S.diary.delete(o.date) : S.diary.set(o.date, o);
  const pendingDel = new Set(S.outbox.filter((o) => o.op === "del").map((o) => o.id));
  S.entries = (data.entries || []).filter((e) => !pendingDel.has(e.id));
  const have = new Set(S.entries.map((e) => e.id));
  for (const o of S.outbox) if (o.op === "add" && !have.has(o.entry.id)) S.entries.push(o.entry);
  sortEntries();
  reindex();
}

const saveCache = () =>
  store.set("tr.state", { user: S.user, trackers: S.trackers, entries: S.entries, books: S.books, diary: [...S.diary.values()], vapidPublicKey: S.vapidKey });
const saveOutbox = () => store.set("tr.outbox", S.outbox);
const sortEntries = () => S.entries.sort((a, b) => (a.date === b.date ? a.created_at - b.created_at : a.date < b.date ? -1 : 1));

function reindex() {
  S.totals = new Map();
  S.first = new Map();
  for (const e of S.entries) {
    const k = e.tracker_id + "|" + e.date;
    const x = S.totals.get(k) || { sum: 0, n: 0 };
    x.sum += e.value; x.n++;
    S.totals.set(k, x);
    if (!S.first.has(e.tracker_id)) S.first.set(e.tracker_id, e.date);
  }
  for (const d of S.diary.values()) {
    if (!d.mood) continue;
    S.totals.set(MOOD_T.id + "|" + d.date, { sum: d.mood, n: 1 });
    const f = S.first.get(MOOD_T.id);
    if (!f || d.date < f) S.first.set(MOOD_T.id, d.date);
  }
}

function syncTz() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const key = `${S.user?.id}:${tz}`;
  if (tz && store.get("tr.tz") !== key) api("/settings", { method: "POST", body: { tz } }).then(() => store.set("tr.tz", key)).catch(() => {});
}

// ---------- offline outbox ----------
let flushing = false;
async function flush() {
  if (flushing || !S.outbox.length) return renderNet();
  flushing = true;
  renderNet();
  try {
    while (S.outbox.length) {
      const o = S.outbox[0];
      try {
        if (o.op === "add") await api("/entries", { method: "POST", body: o.entry });
        else if (o.op === "diary") await api("/diary/" + o.date, { method: "PUT", body: { mood: o.mood, text: o.text, updated_at: o.updated_at } });
        else await api("/entries/" + o.id, { method: "DELETE" });
      } catch (e) {
        if (e.offline || e.status === 401 || e.status >= 500) break; // retry later
        toast("⚠️ Couldn't sync an entry: " + e.message); // permanent error: drop it
      }
      S.outbox.shift();
      saveOutbox();
    }
  } finally {
    flushing = false;
    renderNet();
  }
}

function renderNet() {
  const el = $("#net");
  if (!el) return;
  const n = S.outbox.length;
  if (S.online && !n) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = `${S.online ? "⟳ Syncing" : "⚡ Offline"}${n ? ` · ${n} pending` : ""}`;
}

addEventListener("online", () => { setOnline(true); flush(); if (S.authed) load().then(render).catch(() => {}); });
addEventListener("offline", () => setOnline(false));

// ---------- tracker math ----------
const isQuit = (t) => t.polarity === "quit";
const isRating = (t) => t.kind === "rating";
const isWeek = (t) => t.period === "week" && !isRating(t);
const schedDays = (t) => (t.days ? t.days.split(",").map(Number) : null);
const scheduled = (t, d) => isQuit(t) || isWeek(t) || !t.days || schedDays(t).includes(parse(d).getDay());
const rems = (t) => { try { const r = JSON.parse(t.reminders || "[]"); return Array.isArray(r) ? r : []; } catch { return []; } };
const logged = (t, d) => S.totals.has(t.id + "|" + d);
const dayVal = (t, d) => { const x = S.totals.get(t.id + "|" + d); return !x ? 0 : isRating(t) ? x.sum / x.n : x.sum; };
const periodVal = (t, d) => {
  if (!isWeek(t)) return dayVal(t, d);
  const s = weekStart(d);
  let v = 0;
  for (let i = 0; i < 7; i++) v += dayVal(t, addDays(s, i));
  return v;
};
const target = (t) => (isRating(t) ? t.goal : isQuit(t) ? t.goal ?? 0 : t.goal || 1);
const createdDate = (t) => fmt(new Date(t.created_at));
const startDate = (t) => { const c = createdDate(t), f = S.first.get(t.id); return f && f < c ? f : c; };
const bySort = (a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.created_at - b.created_at;
const active = () => S.trackers.filter((t) => !t.archived).sort(bySort);

/** Is the goal met for the day (or week) containing d? */
function ok(t, d) {
  if (isRating(t)) {
    if (!logged(t, d)) return false;
    if (!t.goal) return true;
    return isQuit(t) ? dayVal(t, d) <= t.goal : dayVal(t, d) >= t.goal;
  }
  const v = periodVal(t, d);
  return isQuit(t) ? v <= target(t) : v >= target(t);
}

function streak(t) {
  const end = today();
  if (isWeek(t)) {
    let w = weekStart(end), n = 0;
    const s0 = weekStart(startDate(t));
    if (!ok(t, w)) { if (isQuit(t)) return 0; w = addDays(w, -7); } // current week still in progress
    while (w >= s0 && ok(t, w) && n < 60) { n++; w = addDays(w, -7); }
    return n;
  }
  let d = end, n = 0;
  if (!ok(t, d)) { if (isQuit(t) && !isRating(t)) return 0; d = addDays(d, -1); } // today still in progress
  const stop = [startDate(t), addDays(end, -LOAD_DAYS)].sort()[1];
  for (; d >= stop; d = addDays(d, -1)) {
    if (!scheduled(t, d)) continue; // rest days neither count nor break
    if (!ok(t, d)) break;
    n++;
  }
  return n;
}

function bestStreak(t) {
  const end = today();
  let best = 0, cur = 0;
  if (isWeek(t)) {
    for (let w = weekStart(startDate(t)); w <= end; w = addDays(w, 7)) {
      const good = ok(t, w);
      if (w === weekStart(end) && !good) break;
      cur = good ? cur + 1 : 0;
      best = Math.max(best, cur);
    }
    return best;
  }
  const s = [startDate(t), addDays(end, -LOAD_DAYS)].sort()[1];
  for (let d = s; d <= end; d = addDays(d, 1)) {
    if (!scheduled(t, d)) continue;
    if (ok(t, d)) best = Math.max(best, ++cur);
    else if (d !== end) cur = 0;
  }
  return best;
}

/** [goodPeriods, totalPeriods] between start and end, skipping rest days and the in-progress period. */
function hitRate(t, start, end) {
  const s = startDate(t) > start ? startDate(t) : start;
  let good = 0, all = 0;
  if (isWeek(t)) {
    for (let w = weekStart(s); w <= end; w = addDays(w, 7)) {
      const g = ok(t, w);
      if (w === weekStart(end) && !g) continue;
      all++; if (g) good++;
    }
  } else {
    for (let d = s; d <= end; d = addDays(d, 1)) {
      if (!scheduled(t, d)) continue;
      const g = ok(t, d);
      if (d === end && !g && !isQuit(t)) continue;
      all++; if (g) good++;
    }
  }
  return [good, all];
}

function lastEntryDate(t) {
  for (let i = S.entries.length - 1; i >= 0; i--) if (S.entries[i].tracker_id === t.id) return S.entries[i].date;
  return null;
}

function fmtVal(t, v) {
  if (isRating(t)) return v ? `${Math.round(v * 10) / 10}/5` : "–";
  v = Math.round(v * 100) / 100;
  if (t.kind === "duration") {
    const h = Math.floor(v / 60), m = Math.round(v % 60);
    return h ? `${h}h${m ? " " + m + "m" : ""}` : `${m}m`;
  }
  if (t.kind === "check") return `${v}×`;
  return `${v}${t.unit ? " " + t.unit : ""}`;
}

const perLabel = (t) => (isWeek(t) ? "/week" : "/day");
const schedLabel = (t) =>
  isWeek(t) ? "per week" : t.days ? schedDays(t).sort((a, b) => DOW_ORDER.indexOf(a) - DOW_ORDER.indexOf(b)).map((d) => DOW[d]).join(" ") : "daily";

// ---------- books ----------
const isBookish = (t) => t.kind === "count" && (/page/i.test(t.unit || "") || S.books.some((b) => b.tracker_id === t.id));
const bookPages = (b) => b.start_page + S.entries.filter((e) => e.book_id === b.id).reduce((s, e) => s + e.value, 0);
function bookEta(b) {
  if (!b.total_pages) return null;
  const cut = addDays(today(), -13);
  const recent = S.entries.filter((e) => e.book_id === b.id && e.date >= cut).reduce((s, e) => s + e.value, 0);
  const left = b.total_pages - bookPages(b);
  if (!recent || left <= 0) return null;
  return addDays(today(), Math.ceil(left / (recent / 14)));
}
async function saveBook(b, patch) {
  const saved = await api("/books/" + b.id, { method: "PUT", body: { ...b, ...patch } });
  S.books = S.books.map((x) => (x.id === saved.id ? saved : x));
  saveCache();
  return saved;
}
function checkBookFinish(bookId) {
  const b = bookId && S.books.find((x) => x.id === bookId);
  if (!b || b.status !== "reading" || !b.total_pages || bookPages(b) < b.total_pages) return;
  saveBook(b, { status: "finished" })
    .then(() => { toast(`🎉 You finished “${b.title}”!`); refreshSheet(); })
    .catch(() => {});
}

// ---------- timers (per device) ----------
const getTimer = (t) => Number(store.get("timer:" + t.id, 0)) || 0;
const setTimer = (t, v) => (v ? store.set("timer:" + t.id, v) : store.del("timer:" + t.id));
const clock = (ms) => { const s = Math.floor(ms / 1000); const h = Math.floor(s / 3600); return `${h ? h + ":" : ""}${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`; };

setInterval(() => {
  document.querySelectorAll("[data-timer]").forEach((el) => {
    const t = S.trackers.find((x) => x.id === el.dataset.timer);
    const st = t && getTimer(t);
    if (st) el.textContent = clock(Date.now() - st);
  });
}, 1000);

// ---------- actions ----------
function addEntry(t, value, { date = S.date, note = null, book_id = null, quiet = false } = {}) {
  const e = { id: uid(), tracker_id: t.id, date, value, note, book_id, created_at: Date.now() };
  S.entries.push(e);
  sortEntries(); reindex(); saveCache();
  S.outbox.push({ op: "add", entry: e }); saveOutbox();
  flush();
  render(); refreshSheet();
  if (!quiet) {
    const what = isRating(t) ? `rated ${fmtVal(t, value)}` : isQuit(t) ? `logged ${fmtVal(t, value)}` : `nice! ${fmtVal(t, value)}`;
    toast(`${t.emoji} ${what}${date !== today() ? " on " + nice(date) : ""}`, () => removeEntry(e.id));
  }
  if (navigator.vibrate) navigator.vibrate(12);
  checkBookFinish(book_id);
  return e;
}

function removeEntry(id) {
  S.entries = S.entries.filter((e) => e.id !== id);
  reindex(); saveCache();
  const i = S.outbox.findIndex((o) => o.op === "add" && o.entry.id === id);
  if (i > 0 || (i === 0 && !flushing)) S.outbox.splice(i, 1); // never synced: just drop it
  else S.outbox.push({ op: "del", id });
  saveOutbox();
  flush();
  render(); refreshSheet();
}

function quickAction(t) {
  if (isRating(t)) return openSheet({ type: "detail", id: t.id });
  if (t.kind === "duration") {
    const st = getTimer(t);
    if (!st) { setTimer(t, Date.now()); render(); toast(`⏱ ${t.name} timer started`); return; }
    setTimer(t, 0);
    return addEntry(t, Math.max(1, Math.round((Date.now() - st) / 60000)));
  }
  addEntry(t, 1);
}

async function moveTracker(id, dir) {
  const list = active();
  const i = list.findIndex((t) => t.id === id), j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  list.forEach((t, k) => (t.sort = k + 1));
  saveCache(); render();
  await api("/trackers/reorder", { method: "POST", body: { ids: list.map((t) => t.id) } });
}

async function updateTracker(t, patch) {
  const saved = await api("/trackers/" + t.id, { method: "PUT", body: { ...t, reminders: rems(t), ...patch } });
  S.trackers = S.trackers.map((x) => (x.id === saved.id ? saved : x));
  saveCache();
  return saved;
}

// ---------- push notifications ----------
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

async function pushStatus() {
  if (!pushSupported()) { S.push = "unsupported"; return; }
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    S.push = !!sub && Notification.permission === "granted";
  } catch { S.push = false; }
  if (S.view === "settings" && !sheetState) render();
}

async function enablePush() {
  if (!pushSupported()) {
    throw new Error(isIOS && !isStandalone
      ? "On iPhone: tap Share → “Add to Home Screen”, open the app from your home screen, then turn notifications on."
      : "This browser doesn't support notifications.");
  }
  if (!S.vapidKey) throw new Error("Push isn't configured on the server yet.");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Notifications are blocked — allow them for this site in your browser settings.");
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const raw = atob(S.vapidKey.replace(/-/g, "+").replace(/_/g, "/"));
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(raw, (c) => c.charCodeAt(0)) });
  }
  await api("/push/subscribe", { method: "POST", body: { subscription: sub.toJSON(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone } });
  S.push = true;
}

async function disablePush() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await api("/push/unsubscribe", { method: "POST", body: { endpoint: sub.endpoint } }).catch(() => {});
    await sub.unsubscribe();
  }
  S.push = false;
}

// ---------- insights: connections ----------
function connections() {
  const list = [...active(), ...(S.first.has(MOOD_T.id) ? [MOOD_T] : [])];
  const end = today(), N = 90;
  const found = [];
  const avg = (arr) => arr.reduce((s, p) => s + p[1], 0) / arr.length;
  for (const a of list) for (const b of list) {
    if (a === b) continue;
    for (const lag of [0, 1]) {
      const pairs = [];
      for (let i = N; i >= 1; i--) {
        const d = addDays(end, -i), d2 = addDays(d, lag);
        if (d2 >= end || d < startDate(a) || d2 < startDate(b)) continue; // skip today (incomplete)
        if ((isRating(a) && !logged(a, d)) || (isRating(b) && !logged(b, d2))) continue;
        pairs.push([dayVal(a, d), dayVal(b, d2)]);
      }
      if (pairs.length < 14) continue;
      let hi, lo, how, med = 0;
      const zeros = pairs.filter((p) => p[0] === 0), some = pairs.filter((p) => p[0] > 0);
      if (!isRating(a) && zeros.length >= 5 && some.length >= 5) { hi = some; lo = zeros; how = "with"; }
      else {
        const xs = pairs.map((p) => p[0]).sort((x, y) => x - y);
        med = xs[Math.floor(xs.length / 2)];
        hi = pairs.filter((p) => p[0] > med); lo = pairs.filter((p) => p[0] <= med); how = "more";
        if (hi.length < 5 || lo.length < 5) continue;
      }
      const ys = pairs.map((p) => p[1]);
      const mean = ys.reduce((s, y) => s + y, 0) / ys.length;
      const sd = Math.sqrt(ys.reduce((s, y) => s + (y - mean) ** 2, 0) / ys.length);
      if (!sd) continue;
      const mh = avg(hi), ml = avg(lo), effect = (mh - ml) / sd;
      if (Math.abs(effect) < 0.5) continue;
      found.push({ a, b, lag, how, med, mh, ml, n: pairs.length, score: Math.abs(effect) * Math.sqrt(Math.min(hi.length, lo.length)) });
    }
  }
  found.sort((x, y) => y.score - x.score);
  const seen = new Set(), out = [];
  for (const c of found) {
    const key = [c.a.id, c.b.id].sort().join();
    if (seen.has(key)) continue;
    seen.add(key); out.push(c);
    if (out.length >= 6) break;
  }
  return out;
}

function connectionText(c) {
  const { a, b, lag, how, med, mh, ml } = c;
  const cond = how === "with" ? `On days with <b>${esc(a.emoji)} ${esc(a.name)}</b>` : `On days with more <b>${esc(a.emoji)} ${esc(a.name)}</b> (over ${fmtVal(a, med)})`;
  const up = mh > ml;
  const good = isQuit(b) ? !up : up;
  const change = ml ? `${Math.round(Math.abs((mh - ml) / ml) * 100)}% ${up ? "higher" : "lower"}` : up ? "higher" : "lower";
  return `<div class="conn ${good ? "good" : "bad"}"><span class="dot"></span><div>${cond}, <b>${esc(b.emoji)} ${esc(b.name)}</b>${lag ? " the next day" : ""} is <b>${change}</b>
    <small>${fmtVal(b, mh)} vs ${fmtVal(b, ml)} · ${c.n} days</small></div></div>`;
}

// ---------- rendering ----------
function render() {
  if (!S.authed) return;
  document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === S.view));
  $("#nav").hidden = false;
  const main = $("#main");
  main.innerHTML = { today: viewToday, diary: viewDiary, insights: viewInsights, settings: viewSettings }[S.view]();
  renderNet();
}

// ---------- diary ----------
const face = (m) => RATE_FACES[m - 1] || "";

function saveDiary(date, mood, text) {
  const entry = { date, mood: mood || null, text: (text || "").trim() || null, updated_at: Date.now() };
  if (entry.mood == null && !entry.text) S.diary.delete(date);
  else S.diary.set(date, entry);
  S.outbox = S.outbox.filter((o) => !(o.op === "diary" && o.date === date));
  S.outbox.push({ op: "diary", ...entry });
  saveOutbox(); reindex(); saveCache();
  flush();
}

const moodPicker = (cur, act, date) =>
  `<div class="moodpick">${RATE_FACES.map((f, i) => `<button type="button" class="${cur === i + 1 ? "on" : ""}" style="--m:${MOOD_COLORS[i]}" data-act="${act}" data-v="${i + 1}" data-date="${date}" aria-label="${MOOD_WORDS[i]}"><span>${f}</span><small>${MOOD_WORDS[i]}</small></button>`).join("")}</div>`;

function diaryCard(d) {
  const e = S.diary.get(d);
  const label = d === today() ? "today" : "on " + nice(d);
  if (!e) {
    return `<div class="diarycard"><div class="dh">📔 How was your day${d === today() ? "" : " " + esc(label)}?</div>${moodPicker(null, "mood-quick", d)}</div>`;
  }
  return `<div class="diarycard filled" data-act="diary" data-date="${d}" style="--m:${MOOD_COLORS[(e.mood || 3) - 1]}">
    <div class="dface">${e.mood ? face(e.mood) : "📔"}</div>
    <div class="dbody"><div class="dh">${e.mood ? `Feeling ${MOOD_WORDS[e.mood - 1].toLowerCase()} ${esc(label)}` : `Diary ${esc(label)}`}</div>
    <div class="dtext">${e.text ? esc(e.text) : `<span class="muted">Tap to write how your day went…</span>`}</div></div></div>`;
}

function viewDiary() {
  const end = today();
  const all = [...S.diary.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
  // last 30 days mood strip
  let strip = "", sum = 0, n = 0;
  for (let i = 29; i >= 0; i--) {
    const d = addDays(end, -i), m = S.diary.get(d)?.mood;
    if (m) { sum += m; n++; }
    strip += `<i title="${d}" style="${m ? `background:${MOOD_COLORS[m - 1]};height:${20 + m * 8}%` : ""}"></i>`;
  }
  let html = `<div class="topbar"><h1>Diary</h1><button class="btn small" data-act="diary" data-date="${end}">${S.diary.has(end) ? "Edit today" : "+ Today"}</button></div>
    <div class="ins"><div class="h">Mood · last 30 days<span class="r">${n ? `avg ${face(Math.round(sum / n))} ${Math.round((sum / n) * 10) / 10}/5` : "no moods yet"}</span></div>
    <div class="moodstrip">${strip}</div></div>`;
  if (!S.diary.has(end)) html += diaryCard(end);
  if (!all.length) return html + `<div class="empty">Your diary is empty. Start with how today went 👆<br><small>Only you can see your diary.</small></div>`;
  let month = "";
  for (const e of all) {
    const mo = nice(e.date, { month: "long", year: "numeric" });
    if (mo !== month) { month = mo; html += `<div class="section-title">${esc(mo)}</div>`; }
    html += `<div class="dentry" data-act="diary" data-date="${e.date}" style="--m:${MOOD_COLORS[(e.mood || 3) - 1]}">
      <div class="dd"><b>${esc(nice(e.date, { day: "numeric" }))}</b><small>${esc(nice(e.date, { weekday: "short" }))}</small></div>
      <div class="dbody">${e.mood ? `<div class="dm">${face(e.mood)} ${MOOD_WORDS[e.mood - 1]}</div>` : ""}<div class="dtext">${e.text ? esc(e.text) : '<span class="muted">No note</span>'}</div></div></div>`;
  }
  return html;
}

const PROMPTS = ["Best part of today:", "Something that bugged me:", "Grateful for:", "Tomorrow I want to:"];

function sheetDiary(st) {
  const e = S.diary.get(st.date);
  if (st.mood === undefined) st.mood = e?.mood ?? null;
  if (st.text === undefined) st.text = e?.text ?? "";
  return `<div class="sheet-head"><span class="emoji">📔</span><h2>${st.date === today() ? "Today" : esc(nice(st.date, { weekday: "long", day: "numeric", month: "short" }))}</h2>
      <button class="iconbtn" data-act="close" aria-label="Close">✕</button></div>
    <form data-form="diary">
      <label class="field"><span>First, how was your day?</span>${moodPicker(st.mood, "mood", st.date)}</label>
      ${st.mood || st.text ? `
      <label class="field"><span>How it went</span><textarea name="text" rows="9" maxlength="20000" placeholder="What happened? How did you feel? Anything you want to remember…">${esc(st.text)}</textarea></label>
      <div class="chips" style="justify-content:flex-start;margin:-4px 0 12px">${PROMPTS.map((p, i) => `<button type="button" class="chip" data-act="prompt" data-i="${i}">${esc(p)}</button>`).join("")}</div>
      <button class="btn" type="submit">Save</button>
      ${e ? `<button type="button" class="btn danger" style="margin-top:10px" data-act="diary-del">${st.confirmDelete ? "Tap again to delete" : "Delete entry"}</button>` : ""}` : `<p class="hint">Pick a mood to start writing.</p>`}
    </form>`;
}

function sheetPassword() {
  return `<div class="sheet-head"><h2>Change password</h2><button class="iconbtn" data-act="close" aria-label="Close">✕</button></div>
    <form data-form="password">
      <label class="field"><span>Current password</span><input type="password" name="current" autocomplete="current-password" required></label>
      <label class="field"><span>New password</span><input type="password" name="password" autocomplete="new-password" minlength="8" required></label>
      <button class="btn" type="submit">Change password</button><div class="err"></div>
      <p class="hint">Your other devices will be signed out.</p>
    </form>`;
}

// ---------- invites ----------
const inviteUrl = (code) => `${location.origin}/?invite=${encodeURIComponent(code)}`;
async function loadInvites() {
  try { S.invites = await api("/invites"); } catch { S.invites = { invites: [], users: [] }; }
  if (S.view === "settings" && !sheetState) render();
}
async function shareInvite(code, note) {
  const url = inviteUrl(code);
  const text = `${note ? note + ", here's" : "Here's"} your invite to my tracker app — track habits, meds, books, mood & a daily diary. Your data is private to you.`;
  if (navigator.share) {
    try { await navigator.share({ title: "Trackers invite", text, url }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  try { await navigator.clipboard.writeText(url); toast("🔗 Invite link copied"); }
  catch { prompt("Copy this invite link:", url); }
}

function invitesBox() {
  if (!S.user?.is_admin) return "";
  if (!S.invites) { loadInvites(); return `<div class="section-title">Friends & family</div><div class="ins"><p class="hint" style="margin:0">Loading…</p></div>`; }
  const now = Date.now();
  const open = S.invites.invites.filter((i) => !i.used_at && i.expires_at > now);
  const used = S.invites.invites.filter((i) => i.used_at);
  return `<div class="section-title">Friends & family</div><div class="ins">
    <p style="margin:0 0 10px">Invite people to make their own account. Everyone's trackers and diary are private to them.</p>
    <form data-form="invite" class="row"><input type="text" name="note" maxlength="40" placeholder="Who's it for? (optional)"><button class="btn small" type="submit" style="flex:0 0 auto">Create link</button></form>
    ${open.map((i) => `<div class="invrow"><span class="grow">🔗 ${esc(i.note || "Invite")}<br><small>expires ${esc(new Date(i.expires_at).toLocaleDateString(undefined, { day: "numeric", month: "short" }))} · one person</small></span>
      <button class="btn small secondary" data-act="inv-share" data-code="${esc(i.code)}" data-note="${esc(i.note || "")}">Share</button>
      <button class="mini" data-act="inv-del" data-code="${esc(i.code)}" aria-label="Cancel invite">×</button></div>`).join("")}
    ${used.length ? `<p class="hint">Joined: ${used.map((i) => `✅ @${esc(i.used_by_name || "?")}${i.note ? ` (${esc(i.note)})` : ""}`).join(" · ")}</p>` : ""}
    <p class="hint">${S.invites.users.length} account${S.invites.users.length === 1 ? "" : "s"} in total.</p></div>`;
}

function groupByCategory(list) {
  const groups = new Map();
  for (const t of list) {
    const c = t.category || (isQuit(t) ? "Bad habits" : "General");
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(t);
  }
  return [...groups.entries()];
}

const templateChips = (justify = "center") =>
  `<div class="chips" style="justify-content:${justify}">${TEMPLATES.map((x, i) => `<button class="chip" data-act="tpl" data-i="${i}">${x.emoji} ${esc(x.name)}</button>`).join("")}</div>`;

function viewToday() {
  const d = S.date, isToday = d === today();
  const list = active();
  const head = `
    <div class="topbar datebar">
      <button class="iconbtn" data-act="prev" aria-label="Previous day">‹</button>
      <div class="title"><h1>${isToday ? "Today" : esc(nice(d, { weekday: "long" }))}</h1><small>${esc(nice(d, { day: "numeric", month: "long", year: "numeric" }))}</small></div>
      <button class="iconbtn" data-act="next" aria-label="Next day" ${isToday ? "disabled" : ""}>›</button>
    </div>`;
  if (!list.length) {
    return head + `<div class="empty"><h2>Track anything</h2>Meds, skincare, study sessions, books — or the habits you want to quit.<br>Tap a starter or make your own.
      ${templateChips()}<p><button class="btn small" data-act="new">+ Custom tracker</button></p></div>`;
  }
  const goals = list.filter((t) => !isQuit(t) && scheduled(t, d) && (!isRating(t) || t.goal));
  const done = goals.filter((t) => ok(t, d)).length;
  const pct = goals.length ? Math.round((done / goals.length) * 100) : 100;
  let html = head + `
    <div class="summary"><div class="big">${done}/${goals.length}</div>
      <div class="bar"><div style="font-size:14px;margin-bottom:6px">${pct === 100 ? "All goals done 🎉" : "goals done"}</div><div class="progress"><i style="width:${pct}%"></i></div></div>
    </div>
    ${isToday ? "" : `<div class="banner">Logging for ${esc(nice(d))}<button data-act="today">Back to today</button></div>`}
    ${diaryCard(d)}`;
  const pinned = list.filter((t) => t.pinned);
  if (pinned.length) html += `<div class="section-title">📌 Pinned</div><div class="cards">${pinned.map((t) => card(t, d)).join("")}</div>`;
  for (const [cat, ts] of groupByCategory(list.filter((t) => !t.pinned))) {
    html += `<div class="section-title">${esc(cat)}</div><div class="cards">${ts.map((t) => card(t, d)).join("")}</div>`;
  }
  return html;
}

function card(t, d) {
  const quit = isQuit(t), week = isWeek(t), rest = !scheduled(t, d);
  const v = periodVal(t, d), goal = target(t), good = ok(t, d), st = streak(t);
  const when = week ? " this week" : "";
  const unitS = week ? "w" : "";
  let meta, pct = null;
  if (isRating(t)) {
    meta = logged(t, d) ? `<b>${RATE_FACES[Math.round(dayVal(t, d)) - 1] || ""} ${fmtVal(t, dayVal(t, d))}</b>` : "Not rated yet";
    if (t.goal) meta += ` · aim ${quit ? "≤" : "≥"} ${t.goal}`;
    if (st) meta += ` · 🔥 ${st}`;
  } else if (quit) {
    const last = lastEntryDate(t);
    const clean = daysBetween(last || startDate(t), today());
    meta = `${v ? `<b>${fmtVal(t, v)}</b>${when || (d === today() ? " today" : "")}` : "None ✓"}${goal ? ` · limit ${fmtVal(t, goal)}${perLabel(t)}` : ""} · ${clean}d ${last ? "since last" : "clean"}`;
    if (goal) pct = Math.min(100, (v / goal) * 100);
  } else {
    meta = `<b>${fmtVal(t, v)}</b> / ${fmtVal(t, goal)}${when}${st ? ` · 🔥 ${st}${unitS}` : ""}`;
    pct = Math.min(100, (v / goal) * 100);
  }
  if (rest) { meta = `💤 Rest day${v ? ` · <b>${fmtVal(t, v)}</b>` : ""}${st ? ` · 🔥 ${st}` : ""}`; pct = null; }
  const running = t.kind === "duration" && getTimer(t);
  let act;
  if (running) act = `<button class="act running" data-act="quick" data-id="${t.id}" aria-label="Stop timer">■</button>`;
  else if (t.kind === "duration") act = `<button class="act" data-act="quick" data-id="${t.id}" aria-label="Start timer">▶</button>`;
  else if (isRating(t)) act = `<button class="act" data-act="quick" data-id="${t.id}" aria-label="Rate">★</button>`;
  else act = `<button class="act" data-act="quick" data-id="${t.id}" aria-label="Log">${!quit && good && t.kind === "check" ? "✓" : "+"}</button>`;
  if (running) meta = `⏱ <b data-timer="${t.id}">${clock(Date.now() - running)}</b> · ${meta}`;
  const cls = `${!quit && good && !rest ? " done" : ""}${quit ? " quit" : ""}${rest ? " rest" : ""}`;
  return `<div class="card${cls}" style="--c:${t.color}" data-act="detail" data-id="${t.id}">
    <div class="emoji">${esc(t.emoji)}</div>
    <div class="body"><div class="name">${esc(t.name)}</div><div class="meta">${meta}</div>
      ${pct !== null ? `<div class="progress"><i style="width:${pct}%;${quit && v > goal ? "background:var(--bad)" : ""}"></i></div>` : ""}</div>
    ${act}</div>`;
}

function viewInsights() {
  const list = active();
  const n = S.range, end = today(), start = addDays(end, -(n - 1));
  let html = `<div class="topbar"><h1>Insights</h1></div>
    <div class="seg" style="margin-bottom:14px">${[7, 30, 90].map((r) => `<button class="${r === n ? "on" : ""}" data-act="range" data-r="${r}">${r} days</button>`).join("")}</div>`;
  if (!list.length) return html + `<div class="empty">Add a tracker to see insights.</div>`;

  const conns = connections();
  html += `<div class="section-title">🔗 Connections</div>`;
  html += conns.length
    ? `<div class="ins">${conns.map(connectionText).join("")}<p class="hint" style="margin-top:10px">Patterns from the last 90 days. They show what tends to happen together, not what causes what.</p></div>`
    : `<div class="ins"><p class="hint" style="margin:0">Keep logging. After 2–3 weeks of data, this shows patterns between your trackers, e.g. “On days with more 📱 Doomscrolling, 🧠 Study is 40% lower.” Ratings like mood or skin make this much more useful.</p></div>`;

  html += `<div class="section-title">Trackers</div>`;
  for (const t of list) {
    const days = [];
    for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
    const vals = days.map((d) => dayVal(t, d));
    const tStart = startDate(t) > start ? startDate(t) : start;
    const tracked = days.filter((d) => d >= tStart).length || 1;
    const sum = vals.reduce((a, b) => a + b, 0);
    const [hit, of] = hitRate(t, start, end);
    let nums;
    if (isRating(t)) {
      const rated = days.filter((d) => logged(t, d));
      const a = rated.length ? rated.reduce((s, d) => s + dayVal(t, d), 0) / rated.length : 0;
      const prev = []; for (let i = 1; i <= n; i++) { const d = addDays(start, -i); if (logged(t, d)) prev.push(dayVal(t, d)); }
      const pa = prev.length ? prev.reduce((s, x) => s + x, 0) / prev.length : 0;
      const diff = a && pa ? Math.round((a - pa) * 10) / 10 : null;
      const good = isQuit(t) ? diff < 0 : diff > 0;
      nums = `<span>Avg <b>${fmtVal(t, a)}</b></span><span>Rated <b>${rated.length}/${tracked}</b> days</span>
        ${t.goal ? `<span>On target <b>${hit}/${of}</b></span>` : ""}${diff ? `<span class="${good ? "trend-up" : "trend-down"}">${diff > 0 ? "▲" : "▼"} ${Math.abs(diff)} vs prev</span>` : ""}`;
    } else {
      let prevSum = 0; for (let i = 1; i <= n; i++) prevSum += dayVal(t, addDays(start, -i));
      const diff = prevSum ? Math.round(((sum - prevSum) / prevSum) * 100) : null;
      const good = isQuit(t) ? diff < 0 : diff > 0;
      nums = `<span>Total <b>${fmtVal(t, sum)}</b></span><span>Avg <b>${fmtVal(t, sum / tracked)}</b>/day</span>
        <span>${isQuit(t) ? "Within limit" : "Goal hit"} <b>${hit}/${of}</b> ${isWeek(t) ? "weeks" : "days"}</span>
        ${diff ? `<span class="${good ? "trend-up" : "trend-down"}">${diff > 0 ? "▲" : "▼"} ${Math.abs(diff)}% vs prev</span>` : ""}`;
    }
    const dailyGoal = isWeek(t) ? null : target(t);
    const max = isRating(t) ? 5 : Math.max(...vals, dailyGoal || 1);
    const w = 100 / n;
    const bars = vals.map((v, i) => {
      const h = v ? Math.max(2, (v / max) * 46) : 0;
      const dim = !isQuit(t) && !isWeek(t) && !ok(t, days[i]);
      return h ? `<rect x="${i * w + w * 0.15}" y="${48 - h}" width="${w * 0.7}" height="${h}" rx="${Math.min(1.5, w * 0.3)}" fill="${isQuit(t) && !isRating(t) ? "var(--bad)" : t.color}" opacity="${dim ? 0.45 : 1}"/>` : "";
    }).join("");
    const goalY = dailyGoal ? 48 - (dailyGoal / max) * 46 : null;
    const goalTxt = isRating(t) ? (t.goal ? `aim ${isQuit(t) ? "≤" : "≥"} ${t.goal}` : "rating") : `${isQuit(t) ? "limit" : "goal"} ${fmtVal(t, target(t))}${perLabel(t)}`;
    html += `<div class="ins" style="--c:${t.color}" data-act="detail" data-id="${t.id}">
      <div class="h">${esc(t.emoji)} ${esc(t.name)}<span class="r">${goalTxt}</span></div>
      <svg viewBox="0 0 100 48" preserveAspectRatio="none">${goalY !== null ? `<line x1="0" x2="100" y1="${goalY}" y2="${goalY}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>` : ""}${bars}</svg>
      <div class="nums">${nums}</div></div>`;
  }
  return html;
}

function viewSettings() {
  const act = active(), arch = S.trackers.filter((t) => t.archived);
  const row = (t, i, n) => `<div class="mrow" data-act="edit" data-id="${t.id}"><span style="font-size:22px">${esc(t.emoji)}</span>
    <span class="grow">${t.pinned ? "📌 " : ""}${esc(t.name)}${isQuit(t) ? '<span class="tag-quit">quit</span>' : ""}<br>
    <small>${{ check: "Check-off", count: "Count", duration: "Time", rating: "Rating" }[t.kind]} · ${schedLabel(t)}${target(t) != null ? ` · ${isQuit(t) ? "limit" : "goal"} ${isRating(t) ? t.goal : fmtVal(t, target(t))}` : ""}${rems(t).length ? ` · 🔔 ${rems(t).join(", ")}` : ""}</small></span>
    ${n != null ? `<button class="mini" data-act="up" data-id="${t.id}" aria-label="Move up" ${i === 0 ? "disabled" : ""}>↑</button><button class="mini" data-act="down" data-id="${t.id}" aria-label="Move down" ${i === n - 1 ? "disabled" : ""}>↓</button>` : ""}</div>`;
  const withRem = act.filter((t) => rems(t).length);
  let pushBox;
  if (S.push === true) {
    pushBox = `<p style="margin:0 0 10px">🔔 Notifications are <b>on</b> for this device.</p>
      <div class="row"><button class="btn secondary small" data-act="push-test">Send a test</button><button class="btn secondary small" data-act="push-off">Turn off</button></div>`;
  } else {
    pushBox = `<p style="margin:0 0 10px">Get a notification at the times you set on each tracker. It's skipped if you've already done it.</p>
      <button class="btn" data-act="push-on">🔔 Turn on notifications</button>
      ${isIOS && !isStandalone ? `<p class="hint">On iPhone, first tap Share → “Add to Home Screen”, then open the app from your home screen.</p>` : ""}`;
  }
  pushBox += withRem.length
    ? `<p class="hint">${withRem.map((t) => `${esc(t.emoji)} ${esc(t.name)} — ${rems(t).join(", ")}`).join("<br>")}</p>`
    : `<p class="hint">No reminders set yet. Open a tracker → Edit → Reminders.</p>`;
  return `<div class="topbar"><h1>Manage</h1><button class="btn small" data-act="new">+ New</button></div>
    ${act.length ? `<div class="list">${act.map((t, i) => row(t, i, act.length)).join("")}</div>` : `<div class="empty">No trackers yet.</div>`}
    <div class="section-title">Reminders</div><div class="ins">${pushBox}</div>
    <div class="section-title">Starters</div>${templateChips("flex-start")}
    ${arch.length ? `<div class="section-title">Archived</div><div class="list">${arch.map((t) => row(t)).join("")}</div>` : ""}
    ${invitesBox()}
    <div class="section-title">Account</div>
    <div class="ins"><p style="margin:0 0 10px">Signed in as <b>${esc(S.user?.name || S.user?.username || "")}</b> <span class="muted">@${esc(S.user?.username || "")}</span>${S.user?.is_admin ? ' <span class="tag-own">owner</span>' : ""}</p>
      <div class="row"><button class="btn secondary small" data-act="password">Change password</button><button class="btn secondary small" data-act="logout">Log out</button></div></div>
    <div class="section-title">Data</div>
    <a class="btn secondary" href="/api/export" download style="text-decoration:none">Export my data (JSON)</a>
    <p class="hint" style="text-align:center;margin-top:24px">Tip: “Add to Home Screen” in your browser menu to use this like an app. It works offline too.</p>`;
}

// ---------- sheets ----------
let sheetState = null;
function openSheet(state) { sheetState = state; refreshSheet(); $("#sheet").hidden = false; $("#sheet-backdrop").hidden = false; }
function closeSheet() { sheetState = null; $("#sheet").hidden = true; $("#sheet-backdrop").hidden = true; }
function refreshSheet() {
  if (!sheetState) return;
  const html = { detail: sheetDetail, edit: sheetEdit, diary: sheetDiary, password: sheetPassword }[sheetState.type](sheetState);
  if (!sheetState) return; // closed while rendering (tracker gone)
  $("#sheet").innerHTML = '<div class="grab"></div>' + html;
}

function heatmap(t, sel) {
  const end = today();
  const offset = (parse(end).getDay() + 6) % 7;
  const start = addDays(end, -(17 * 7 + offset)), last = addDays(end, 6 - offset);
  let cells = "";
  for (let d = start; d <= last; d = addDays(d, 1)) {
    if (d > end) { cells += `<i class="future"></i>`; continue; }
    const v = dayVal(t, d);
    let style = "";
    if (v) {
      const ratio = isRating(t) ? v / 5 : isQuit(t) || isWeek(t) ? 1 : Math.min(1, v / target(t));
      const col = isQuit(t) && !isRating(t) ? "var(--bad)" : t.color;
      style = `background:color-mix(in srgb, ${col} ${Math.round(25 + ratio * 75)}%, var(--card-2))`;
    }
    const cls = [d === sel ? "sel" : "", !scheduled(t, d) ? "rest" : ""].join(" ").trim();
    cells += `<i style="${style}" class="${cls}" title="${d}: ${fmtVal(t, v)}"></i>`;
  }
  return `<div class="heat-wrap"><div class="heat">${cells}</div></div>`;
}

function booksSection(t, logDate) {
  const mine = S.books.filter((b) => b.tracker_id === t.id);
  const reading = mine.filter((b) => b.status === "reading").reverse();
  const finished = mine.filter((b) => b.status === "finished").reverse();
  const conf = sheetState.confirmBook;
  const bookCard = (b) => {
    const p = bookPages(b), pct = b.total_pages ? Math.min(100, (p / b.total_pages) * 100) : null, eta = bookEta(b);
    return `<div class="book" style="--c:${t.color}">
      <div class="bt"><b>${esc(b.title)}</b>${b.author ? ` <small>${esc(b.author)}</small>` : ""}</div>
      ${pct !== null ? `<div class="progress"><i style="width:${pct}%"></i></div>` : ""}
      <div class="bm">Page ${Math.round(b.total_pages ? Math.min(p, b.total_pages) : p)}${b.total_pages ? ` of ${b.total_pages} · ${Math.round(pct)}%` : ""}${eta ? ` · done ~${esc(nice(eta, { day: "numeric", month: "short" }))}` : ""}</div>
      <form data-form="page" data-book="${b.id}" class="row bookrow">
        <input type="number" inputmode="numeric" name="page" min="1" placeholder="Now on page…" required>
        <button class="btn small" type="submit">Update</button>
        <button class="btn small secondary" type="button" data-act="book-done" data-id="${b.id}" title="Mark finished">✓</button>
        <button class="btn small danger" type="button" data-act="book-del" data-id="${b.id}">${conf === b.id ? "Delete?" : "×"}</button>
      </form></div>`;
  };
  return `<div class="section-title">📖 Books</div>
    ${reading.map(bookCard).join("") || `<p class="hint">Add the book you're reading to see progress and a finish date.</p>`}
    <details class="addbook"${reading.length ? "" : " open"}><summary>+ Add a book</summary>
      <form data-form="book" data-id="${t.id}">
        <label class="field"><span>Title</span><input type="text" name="title" maxlength="120" required></label>
        <div class="row"><label class="field"><span>Author</span><input type="text" name="author" maxlength="80"></label>
        <label class="field"><span>Total pages</span><input type="number" inputmode="numeric" name="total_pages" min="1"></label></div>
        <label class="field"><span>Already on page</span><input type="number" inputmode="numeric" name="start_page" min="0" value="0"></label>
        <button class="btn" type="submit">Add book</button>
      </form></details>
    ${finished.length ? `<p class="hint" style="margin-top:10px">Finished: ${finished.map((b) => `✅ ${esc(b.title)}${b.finished_at ? ` (${esc(new Date(b.finished_at).toLocaleDateString(undefined, { month: "short", year: "numeric" }))})` : ""}`).join(" · ")}</p>` : ""}`;
}

function sheetDetail(st) {
  const t = S.trackers.find((x) => x.id === st.id);
  if (!t) { closeSheet(); return ""; }
  const logDate = st.logDate || S.date;
  const end = today();
  const entries = S.entries.filter((e) => e.tracker_id === t.id).slice(-60).reverse();
  let last30 = 0, rated = 0;
  for (let i = 0; i < 30; i++) { const d = addDays(end, -i); last30 += dayVal(t, d); if (logged(t, d)) rated++; }
  const last = lastEntryDate(t);
  const readingBooks = S.books.filter((b) => b.tracker_id === t.id && b.status === "reading").reverse();
  const bookName = (id) => S.books.find((b) => b.id === id)?.title;

  let valueInput = "";
  if (t.kind === "count" || t.kind === "duration") {
    valueInput = `<label class="field"><span>${t.kind === "duration" ? "Minutes" : `Amount${t.unit ? " (" + esc(t.unit) + ")" : ""}`}</span>
      <input type="number" inputmode="decimal" step="any" name="value" value="${t.kind === "duration" ? 30 : 1}" required></label>`;
  }
  const submit = isRating(t)
    ? `<div class="rate">${RATE_FACES.map((f, i) => `<button type="submit" name="value" value="${i + 1}" style="--c:${t.color}"><span>${f}</span>${i + 1}</button>`).join("")}</div>`
    : `<button class="btn" type="submit" style="background:${isQuit(t) ? "var(--bad)" : t.color}">${isQuit(t) ? "Log it" : "Log"}</button>`;

  return `<div class="sheet-head"><span class="emoji">${esc(t.emoji)}</span><h2>${esc(t.name)}</h2>
      <button class="iconbtn${t.pinned ? " on" : ""}" data-act="pin" data-id="${t.id}" aria-label="${t.pinned ? "Unpin" : "Pin"}" title="${t.pinned ? "Unpin" : "Pin to top"}">📌</button>
      <button class="btn small secondary" data-act="edit" data-id="${t.id}">Edit</button><button class="iconbtn" data-act="close" aria-label="Close">✕</button></div>
    <div class="stats">
      <div class="stat"><b>${fmtVal(t, isRating(t) ? dayVal(t, logDate) : periodVal(t, logDate))}</b><small>${isWeek(t) ? "this week" : logDate === end ? "today" : esc(nice(logDate, { day: "numeric", month: "short" }))}</small></div>
      ${isQuit(t) && !isRating(t)
        ? `<div class="stat"><b>${daysBetween(last || startDate(t), end)}d</b><small>since last</small></div>`
        : `<div class="stat"><b>${streak(t)}${isWeek(t) ? "w" : ""}</b><small>streak</small></div>`}
      <div class="stat"><b>${bestStreak(t)}${isWeek(t) ? "w" : ""}</b><small>best</small></div>
      <div class="stat"><b>${isRating(t) ? fmtVal(t, rated ? last30 / rated : 0) : fmtVal(t, last30)}</b><small>30d ${isRating(t) ? "avg" : "total"}</small></div>
    </div>
    ${heatmap(t, logDate)}
    <form data-form="log" data-id="${t.id}">
      <div class="row"><label class="field"><span>Date</span><input type="date" name="date" value="${logDate}" max="${end}" required></label>${valueInput}</div>
      ${readingBooks.length ? `<label class="field"><span>Book</span><select name="book_id"><option value="">No book</option>${readingBooks.map((b, i) => `<option value="${b.id}" ${i === 0 ? "selected" : ""}>${esc(b.title)}</option>`).join("")}</select></label>` : ""}
      <label class="field"><span>Note (optional)</span><input type="text" name="note" maxlength="500" placeholder="${isQuit(t) ? "What triggered it?" : isRating(t) ? "Anything notable?" : "How it went, chapter, product used…"}"></label>
      ${isRating(t) ? `<span class="hint" style="display:block;margin:0 2px 6px">Tap a rating to log it</span>` : ""}
      ${submit}
    </form>
    ${isBookish(t) ? booksSection(t, logDate) : ""}
    <div class="section-title">History</div>
    ${entries.length ? `<ul class="entries">${entries.map((e) => `<li><span class="d">${esc(nice(e.date, { day: "numeric", month: "short", year: "2-digit" }))}</span><span class="v">${fmtVal(t, e.value)}</span><span class="n">${esc([e.book_id && bookName(e.book_id) ? "📖 " + bookName(e.book_id) : "", e.note || ""].filter(Boolean).join(" · "))}</span><button data-act="del-entry" data-id="${e.id}" aria-label="Delete entry">×</button></li>`).join("")}</ul>` : `<p class="hint">Nothing logged yet.</p>`}`;
}

function sheetEdit(st) {
  const t = st.draft;
  const rating = isRating(t), quit = t.polarity === "quit";
  if (rating && t.period === "week") t.period = "day";
  if (quit) t.days = null;
  const sched = t.period === "week" ? "week" : t.days ? "some" : "daily";
  const cats = [...new Set(S.trackers.map((x) => x.category).filter(Boolean))];
  const seg = (items, cur, act, key) =>
    `<div class="seg">${items.map(([k, l]) => `<button type="button" class="${cur === k ? "on" : ""}" data-act="${act}" ${key ? `data-k="${key}"` : ""} data-v="${k}">${l}</button>`).join("")}</div>`;
  const polItems = rating ? [["build", "⬆ Higher is better"], ["quit", "⬇ Lower is better"]] : [["build", "✅ Good habit"], ["quit", "🚫 Bad habit"]];
  const schedItems = quit ? [["daily", "Per day"], ["week", "Per week"]] : rating ? [["daily", "Every day"], ["some", "Some days"]] : [["daily", "Every day"], ["some", "Some days"], ["week", "Per week"]];
  const goalLabel = rating ? "Target rating (1–5)" : `${sched === "week" ? "Weekly" : "Daily"} ${quit ? "limit" : "goal"}`;
  const goalHint = rating
    ? quit ? "Days at or below this count as good." : "Days at or above this count as good. Leave empty to just track."
    : { check: "times", count: t.unit || "amount", duration: "minutes" }[t.kind] + (sched === "week" ? " per week" : " per day");
  const days = new Set(schedDays(t) || []);
  const reminders = t.reminders || [];
  return `<div class="sheet-head"><h2>${st.id ? "Edit tracker" : "New tracker"}</h2><button class="iconbtn" data-act="close" aria-label="Close">✕</button></div>
    <form data-form="edit">
      <div class="row">
        <label class="field" style="flex:0 0 76px"><span>Icon</span><input type="text" name="emoji" value="${esc(t.emoji)}" maxlength="16" style="text-align:center;font-size:22px;padding:8px"></label>
        <label class="field"><span>Name</span><input type="text" name="name" value="${esc(t.name)}" maxlength="60" required placeholder="e.g. Vitamin D"></label>
      </div>
      <label class="field"><span>How do you log it?</span>
        ${seg([["check", "Check"], ["count", "Count"], ["duration", "Time"], ["rating", "Rate 1–5"]], t.kind, "set", "kind")}
        <p class="hint">${{ check: "One tap = done. Great for meds, minoxidil, skincare.", count: "Tap +1 or enter an amount. Pages, glasses, cigarettes…", duration: "Start/stop a timer or enter minutes. Study, workouts, screen time.", rating: "Rate 1–5 each day. Skin, hair shedding, mood, sleep, energy…" }[t.kind]}</p></label>
      <label class="field"><span>${rating ? "Which way is good?" : "What is it?"}</span>${seg(polItems, t.polarity, "set", "polarity")}</label>
      <label class="field"><span>Schedule</span>${seg(schedItems, sched, "sched")}
        ${sched === "some" ? `<div class="daychips">${DOW_ORDER.map((d) => `<button type="button" class="chip ${days.has(d) ? "on" : ""}" data-act="day" data-v="${d}">${DOW[d]}</button>`).join("")}</div><p class="hint">Other days are rest days: they don't break your streak.</p>` : ""}
        ${sched === "week" ? `<p class="hint">Any days you like. The goal resets every Monday.</p>` : ""}</label>
      <div class="row">
        <label class="field"><span>${goalLabel}</span><input type="number" inputmode="decimal" step="any" min="${rating ? 1 : 0}" ${rating ? 'max="5"' : ""} name="goal" value="${t.goal ?? ""}" placeholder="${rating ? "" : quit ? "0" : "1"}"><p class="hint">${goalHint}</p></label>
        ${t.kind === "count" ? `<label class="field"><span>Unit</span><input type="text" name="unit" value="${esc(t.unit || "")}" maxlength="20" placeholder="pages"></label>` : ""}
      </div>
      <label class="field"><span>🔔 Reminders</span>
        ${reminders.map((r, i) => `<div class="row remrow"><input type="time" name="rem" value="${esc(r)}" required><button type="button" class="btn small secondary" data-act="rem-del" data-i="${i}" aria-label="Remove">×</button></div>`).join("")}
        <button type="button" class="btn small secondary" data-act="rem-add">+ Add a time</button>
        ${S.push !== true ? `<p class="hint">Turn on notifications in Manage to get these.</p>` : `<p class="hint">Skipped if you've already hit the goal.</p>`}</label>
      <label class="field"><span>Group</span><input type="text" name="category" value="${esc(t.category || "")}" maxlength="30" list="cats" placeholder="Health, Skin, Study…"><datalist id="cats">${cats.map((c) => `<option value="${esc(c)}">`).join("")}</datalist></label>
      <label class="field"><span>Color</span><div class="swatches">${COLORS.map((c) => `<button type="button" style="background:${c}" class="${t.color === c ? "on" : ""}" data-act="set" data-k="color" data-v="${c}" aria-label="${c}"></button>`).join("")}</div></label>
      <label class="field"><span>Today screen</span>${seg([["0", "Normal"], ["1", "📌 Pinned to top"]], String(t.pinned ? 1 : 0), "set", "pinned")}</label>
      <button class="btn" type="submit" style="margin-top:6px">${st.id ? "Save" : "Create"}</button>
      ${st.id ? `<div class="row" style="margin-top:10px">
        <button type="button" class="btn secondary" data-act="archive">${t.archived ? "Unarchive" : "Archive"}</button>
        <button type="button" class="btn danger" data-act="delete">${st.confirmDelete ? "Tap again to delete" : "Delete"}</button></div>` : ""}
    </form>`;
}

function readEditForm() {
  const f = $("#sheet form[data-form=edit]");
  if (!f || !sheetState?.draft) return;
  const fd = new FormData(f);
  for (const k of ["emoji", "name", "goal", "unit", "category"]) if (fd.has(k)) sheetState.draft[k] = fd.get(k);
  sheetState.draft.reminders = fd.getAll("rem").filter(Boolean);
}

function openEdit(id, preset) {
  const base = id
    ? { ...S.trackers.find((x) => x.id === id) }
    : { name: "", emoji: "✅", kind: "check", polarity: "build", period: "day", days: null, goal: "", color: COLORS[S.trackers.length % COLORS.length], category: "", pinned: 0, ...preset };
  base.reminders = id ? rems(base) : base.reminders || [];
  openSheet({ type: "edit", id, draft: base });
}

async function saveTracker() {
  readEditForm();
  const d = sheetState.draft;
  const body = { ...d, goal: d.goal === "" ? null : d.goal };
  const saved = sheetState.id
    ? await api("/trackers/" + sheetState.id, { method: "PUT", body })
    : await api("/trackers", { method: "POST", body });
  const i = S.trackers.findIndex((x) => x.id === saved.id);
  i >= 0 ? (S.trackers[i] = saved) : S.trackers.push(saved);
  saveCache();
  closeSheet();
  render();
  toast(`${saved.emoji} ${saved.name} saved`);
  if (rems(saved).length && S.push !== true) setTimeout(() => toast("🔔 Turn on notifications in Manage to get reminders"), 1500);
}

// ---------- toast ----------
let toastTimer;
function toast(msg, undo) {
  const el = $("#toast");
  el.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button type="button">Undo</button>' : ""}`;
  el.hidden = false;
  if (undo) el.querySelector("button").onclick = () => { el.hidden = true; Promise.resolve().then(undo).catch(showErr); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4500);
}
const showErr = (e) => toast("⚠️ " + (e.message || e));

// ---------- login / sign up ----------
const inviteParam = () => new URLSearchParams(location.search).get("invite") || "";

async function showAuth() {
  S.authed = false;
  store.del("tr.state");
  closeSheet();
  $("#nav").hidden = true;
  let mode = inviteParam() ? "signup" : "login";
  try { if ((await api("/auth/status")).setup) mode = "setup"; } catch {}
  renderAuth(mode);
}

function renderAuth(mode) {
  const inv = inviteParam();
  const user = `<input type="text" name="username" placeholder="Username" autocomplete="username" autocapitalize="none" spellcheck="false" required minlength="3" maxlength="30">`;
  const forms = {
    login: `<p class="sub">Welcome back 👋</p>
      <form data-form="login">${user}
        <input type="password" name="password" placeholder="Password" autocomplete="current-password" required>
        <button class="btn" type="submit">Log in</button><div class="err"></div></form>
      <p class="hint">Got an invite? <button class="link" data-act="auth" data-v="signup">Create an account</button></p>`,
    signup: `<p class="sub">${inv ? "You've been invited! 🎉 Create your account." : "Create your account"}</p>
      <form data-form="signup">
        ${inv ? `<input type="hidden" name="invite" value="${esc(inv)}">` : `<input type="text" name="invite" placeholder="Invite code or link" required autocapitalize="none">`}
        <input type="text" name="name" placeholder="Your name" maxlength="40" autocomplete="given-name">
        ${user}
        <input type="password" name="password" placeholder="Password (8+ characters)" autocomplete="new-password" minlength="8" required>
        <button class="btn" type="submit">Create account</button><div class="err"></div></form>
      <p class="hint">Your trackers and diary are private to you.</p>
      <p class="hint">Already have an account? <button class="link" data-act="auth" data-v="login">Log in</button></p>`,
    setup: `<p class="sub">Set up your account. Everything you've tracked so far moves into it.</p>
      <form data-form="setup">
        <input type="password" name="owner_password" placeholder="Setup password (APP_PASSWORD)" autocomplete="off" autocapitalize="none" spellcheck="false" required>
        <input type="text" name="name" placeholder="Your name" maxlength="40" autocomplete="given-name">
        ${user}
        <input type="password" name="password" placeholder="New password (8+ characters)" autocomplete="new-password" minlength="8" required>
        <button class="btn" type="submit">Create my account</button><div class="err"></div></form>
      <p class="hint">After this you log in with your username. You can then invite friends & family from Manage.</p>`,
  };
  $("#main").innerHTML = `<div class="login"><div class="logo">📈</div><h1>Trackers</h1>${forms[mode]}</div>`;
}

async function logout() {
  if (S.push === true) await disablePush().catch(() => {}); // stop this device getting your reminders
  await api("/auth/logout", { method: "POST" }).catch(() => {});
  for (const k of ["tr.state", "tr.outbox", "tr.tz", "tr.uid"]) store.del(k);
  Object.assign(S, { outbox: [], trackers: [], entries: [], books: [], diary: new Map(), user: null, invites: null, view: "today" });
  reindex();
  showAuth();
}

// ---------- events ----------
document.addEventListener("click", async (ev) => {
  const nav = ev.target.closest("#nav button");
  if (nav) { S.view = nav.dataset.view; closeSheet(); render(); scrollTo(0, 0); return; }
  if (ev.target.id === "sheet-backdrop") return closeSheet();
  const el = ev.target.closest("[data-act]");
  if (!el) return;
  const act = el.dataset.act;
  const t = el.dataset.id && S.trackers.find((x) => x.id === el.dataset.id);
  const draft = sheetState?.draft;
  try {
    switch (act) {
      case "prev": S.date = addDays(S.date, -1); render(); break;
      case "next": if (S.date < today()) { S.date = addDays(S.date, 1); render(); } break;
      case "today": S.date = today(); render(); break;
      case "quick": ev.stopPropagation(); quickAction(t); break;
      case "detail": if (t) openSheet({ type: "detail", id: t.id }); break;
      case "close": closeSheet(); break;
      case "range": S.range = Number(el.dataset.r); render(); break;
      case "new": openEdit(null); break;
      case "tpl": openEdit(null, TEMPLATES[Number(el.dataset.i)]); break;
      case "edit": openEdit(el.dataset.id); break;
      case "up": case "down": ev.stopPropagation(); await moveTracker(el.dataset.id, act === "up" ? -1 : 1); break;
      case "pin": await updateTracker(t, { pinned: t.pinned ? 0 : 1 }); render(); refreshSheet(); break;
      case "set":
        readEditForm();
        draft[el.dataset.k] = el.dataset.k === "pinned" ? Number(el.dataset.v) : el.dataset.v;
        if (el.dataset.k === "kind" && el.dataset.v === "rating") { draft.goal = ""; draft.period = "day"; }
        sheetState.confirmDelete = false;
        refreshSheet();
        break;
      case "sched":
        readEditForm();
        if (el.dataset.v === "week") { draft.period = "week"; draft.days = null; }
        else if (el.dataset.v === "some") { draft.period = "day"; draft.days = draft.days || "1,2,3,4,5"; }
        else { draft.period = "day"; draft.days = null; }
        refreshSheet();
        break;
      case "day": {
        readEditForm();
        const ds = new Set(schedDays(draft) || []);
        const v = Number(el.dataset.v);
        ds.has(v) ? ds.delete(v) : ds.add(v);
        if (ds.size) draft.days = [...ds].sort().join(",");
        refreshSheet();
        break;
      }
      case "rem-add": readEditForm(); draft.reminders.push(draft.reminders.length ? "21:00" : "09:00"); refreshSheet(); break;
      case "rem-del": readEditForm(); draft.reminders.splice(Number(el.dataset.i), 1); refreshSheet(); break;
      case "archive":
        readEditForm();
        draft.archived = draft.archived ? 0 : 1;
        await saveTracker();
        break;
      case "delete":
        if (!sheetState.confirmDelete) { readEditForm(); sheetState.confirmDelete = true; refreshSheet(); break; }
        await api("/trackers/" + sheetState.id, { method: "DELETE" });
        S.trackers = S.trackers.filter((x) => x.id !== sheetState.id);
        S.entries = S.entries.filter((e) => e.tracker_id !== sheetState.id);
        S.books = S.books.filter((b) => b.tracker_id !== sheetState.id);
        reindex(); saveCache(); closeSheet(); render(); toast("Tracker deleted");
        break;
      case "del-entry": removeEntry(el.dataset.id); break;
      case "book-done": {
        const b = S.books.find((x) => x.id === el.dataset.id);
        await saveBook(b, { status: "finished" });
        toast(`🎉 Finished “${b.title}”!`); refreshSheet();
        break;
      }
      case "book-del":
        if (sheetState.confirmBook !== el.dataset.id) { sheetState.confirmBook = el.dataset.id; refreshSheet(); break; }
        await api("/books/" + el.dataset.id, { method: "DELETE" });
        S.books = S.books.filter((b) => b.id !== el.dataset.id);
        S.entries.forEach((e) => { if (e.book_id === el.dataset.id) e.book_id = null; });
        saveCache(); sheetState.confirmBook = null; refreshSheet();
        break;
      case "push-on": el.disabled = true; await enablePush(); render(); toast("🔔 Notifications on"); break;
      case "push-off": await disablePush(); render(); toast("Notifications off for this device"); break;
      case "push-test": el.disabled = true; await api("/push/test", { method: "POST" }); toast("Sent! It should pop up in a few seconds."); el.disabled = false; break;
      case "logout": await logout(); break;
      case "auth": renderAuth(el.dataset.v); break;
      case "password": openSheet({ type: "password" }); break;
      case "mood-quick":
        saveDiary(el.dataset.date, Number(el.dataset.v), S.diary.get(el.dataset.date)?.text);
        render();
        openSheet({ type: "diary", date: el.dataset.date });
        break;
      case "diary": openSheet({ type: "diary", date: el.dataset.date }); break;
      case "mood": {
        const ta = $("#sheet textarea[name=text]");
        if (ta) sheetState.text = ta.value;
        sheetState.mood = Number(el.dataset.v);
        refreshSheet();
        const t2 = $("#sheet textarea[name=text]");
        if (t2 && !t2.value) t2.focus();
        break;
      }
      case "prompt": {
        const ta = $("#sheet textarea[name=text]");
        const p = PROMPTS[Number(el.dataset.i)];
        ta.value = (ta.value.trim() ? ta.value.replace(/\s*$/, "\n\n") : "") + p + " ";
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        break;
      }
      case "diary-del":
        if (!sheetState.confirmDelete) { sheetState.text = $("#sheet textarea[name=text]")?.value ?? sheetState.text; sheetState.confirmDelete = true; refreshSheet(); break; }
        saveDiary(sheetState.date, null, "");
        closeSheet(); render(); toast("Diary entry deleted");
        break;
      case "inv-share": await shareInvite(el.dataset.code, el.dataset.note); break;
      case "inv-del":
        await api("/invites/" + encodeURIComponent(el.dataset.code), { method: "DELETE" });
        await loadInvites(); toast("Invite cancelled");
        break;
    }
  } catch (e) {
    showErr(e);
    if (!sheetState) render();
    if (el.isConnected) el.disabled = false;
  }
});

document.addEventListener("change", (ev) => {
  if (ev.target.name === "date" && sheetState?.type === "detail") {
    sheetState.logDate = ev.target.value;
    refreshSheet();
  }
});

document.addEventListener("submit", async (ev) => {
  const f = ev.target;
  ev.preventDefault();
  const btn = ev.submitter || f.querySelector("[type=submit]");
  if (btn) btn.disabled = true;
  try {
    const kind = f.dataset.form;
    if (kind === "login" || kind === "signup" || kind === "setup") {
      const body = Object.fromEntries(new FormData(f));
      body.tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (body.invite) body.invite = body.invite.trim().replace(/^.*[?&]invite=([^&#]+).*$/, (_, c) => decodeURIComponent(c)); // accept pasted links
      await api("/auth/" + kind, { method: "POST", body });
      history.replaceState(null, "", "/");
      await start();
      if (kind !== "login") toast(kind === "setup" ? "🎉 Account ready — all your data is here" : "🎉 Welcome! Tap a starter to begin");
    } else if (kind === "diary") {
      const text = new FormData(f).get("text") || "";
      saveDiary(sheetState.date, sheetState.mood, text);
      closeSheet(); render();
      toast("📔 Saved");
    } else if (kind === "password") {
      const fd = new FormData(f);
      await api("/auth/password", { method: "POST", body: { current: fd.get("current"), password: fd.get("password") } });
      closeSheet(); toast("🔒 Password changed");
    } else if (kind === "invite") {
      const note = new FormData(f).get("note") || null;
      const inv = await api("/invites", { method: "POST", body: { note } });
      f.reset();
      await loadInvites();
      await shareInvite(inv.code, inv.note);
    } else if (kind === "edit") {
      await saveTracker();
    } else if (kind === "log") {
      const t = S.trackers.find((x) => x.id === f.dataset.id);
      const fd = new FormData(f);
      const value = t.kind === "check" ? 1 : Number(isRating(t) ? ev.submitter?.value : fd.get("value"));
      if (!(value > 0)) throw new Error("Enter an amount");
      sheetState.logDate = fd.get("date");
      addEntry(t, value, { date: fd.get("date"), note: fd.get("note") || null, book_id: fd.get("book_id") || null });
    } else if (kind === "page") {
      const b = S.books.find((x) => x.id === f.dataset.book);
      const t = S.trackers.find((x) => x.id === b.tracker_id);
      const page = Number(new FormData(f).get("page"));
      const delta = page - bookPages(b);
      if (!(delta > 0)) throw new Error(`You're already on page ${Math.round(bookPages(b))}`);
      addEntry(t, delta, { date: sheetState.logDate || S.date, book_id: b.id });
    } else if (kind === "book") {
      const fd = new FormData(f);
      const b = await api("/books", {
        method: "POST",
        body: { tracker_id: f.dataset.id, title: fd.get("title"), author: fd.get("author"), total_pages: fd.get("total_pages"), start_page: fd.get("start_page") || 0 },
      });
      S.books.push(b);
      saveCache(); refreshSheet();
      toast(`📖 Added “${b.title}”`);
    }
  } catch (e) {
    const err = f.querySelector(".err");
    if (err) err.textContent = e.message; else showErr(e);
  } finally {
    if (btn && btn.isConnected) btn.disabled = false;
  }
});

// Roll over to the new day if the app was left open overnight, and refresh on return.
let lastDay = today();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (today() !== lastDay) { if (S.date === lastDay) S.date = today(); lastDay = today(); render(); }
  if (S.authed && !sheetState) load().then(render).then(flush).catch(() => {});
});

function openFromUrl() {
  if (inviteParam()) toast("You're already signed in. Log out first to use this invite.");
  const id = new URLSearchParams(location.search).get("t");
  if (id && S.trackers.some((t) => t.id === id)) openSheet({ type: "detail", id });
  if (location.search) history.replaceState(null, "", "/");
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "refresh" && S.authed) load().then(() => { render(); refreshSheet(); }).catch(() => {});
    if (e.data?.type === "open" && e.data.tracker_id && S.trackers.some((t) => t.id === e.data.tracker_id)) {
      S.view = "today"; S.date = today(); render();
      openSheet({ type: "detail", id: e.data.tracker_id });
    }
  });
}

async function start() {
  const cached = store.get("tr.state", null);
  if (cached && !S.authed) { S.authed = true; applyState(cached); render(); } // instant + offline
  try {
    await load();
    render();
    openFromUrl();
    flush();
    pushStatus();
  } catch (e) {
    if (e.status === 401) return; // login screen shown
    if (e.offline && S.authed) { renderNet(); openFromUrl(); pushStatus(); return; }
    $("#main").innerHTML = `<div class="empty">⚠️ ${esc(e.message)}<p><button class="btn small" onclick="location.reload()">Retry</button></p></div>`;
  }
}
start();
