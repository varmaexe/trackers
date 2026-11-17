// Tracker API — Cloudflare Worker + D1. Static UI is served from ./public.
import { sendPush, b64u } from "./push.js";

const SESSION_DAYS = 180;
const INVITE_DAYS = 14;
const PBKDF2_ITERATIONS = 100000; // Workers' maximum
const KINDS = ["check", "count", "duration", "rating"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const ID_RE = /^[\w-]{8,64}$/;
const USERNAME_RE = /^[a-z0-9_.-]{3,30}$/i;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      return await handleApi(request, env, url);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: "Server error" }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env, event.scheduledTime).catch((e) => console.error("reminders failed", e)));
  },
};

// ---------- crypto helpers ----------

const enc = new TextEncoder();
const randomToken = (bytes = 32) => b64u.enc(crypto.getRandomValues(new Uint8Array(bytes)));
const sha256 = async (s) => b64u.enc(await crypto.subtle.digest("SHA-256", enc.encode(s)));

async function safeEqual(a, b) {
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(da, db);
}

async function hashPassword(password, saltB64) {
  const salt = saltB64 ? b64u.dec(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS }, key, 256);
  return { hash: b64u.enc(bits), salt: b64u.enc(salt) };
}

const slowFail = () => new Promise((r) => setTimeout(r, 700)); // slow down guessing

// ---------- sessions ----------

const sessionCookie = (value, maxAge) => `sid=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

async function startSession(db, userId) {
  const token = randomToken();
  const now = Date.now();
  await db
    .prepare("INSERT INTO sessions (id,user_id,expires_at,created_at) VALUES (?,?,?,?)")
    .bind(await sha256(token), userId, now + SESSION_DAYS * 86400e3, now)
    .run();
  return sessionCookie(token, SESSION_DAYS * 86400);
}

const cookieToken = (request) => (request.headers.get("cookie") || "").match(/(?:^|;\s*)sid=([^;]+)/)?.[1];

async function currentUser(request, db) {
  const token = cookieToken(request);
  if (!token) return null;
  return db
    .prepare("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?")
    .bind(await sha256(token), Date.now())
    .first();
}

const publicUser = (u) => ({ id: u.id, username: u.username, name: u.name, is_admin: !!u.is_admin });

// ---------- input helpers ----------

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

const str = (v, max) => {
  const s = String(v ?? "").trim().slice(0, max);
  return s || null;
};

function num(v, { min = -1e7, max = 1e7, allowNull = false } = {}) {
  if (allowNull && (v === null || v === undefined || v === "")) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, "Invalid number");
  return n;
}

function cleanDays(v) {
  const days = [...new Set(String(v ?? "").split(",").filter((x) => /^[0-6]$/.test(x.trim())).map(Number))].sort();
  return days.length && days.length < 7 ? days.join(",") : null;
}

function cleanReminders(v) {
  if (!Array.isArray(v)) return null;
  const times = [...new Set(v.filter((x) => TIME_RE.test(x)))].sort().slice(0, 8);
  return times.length ? JSON.stringify(times) : null;
}

function cleanTracker(b) {
  const name = str(b.name, 60);
  if (!name) throw new HttpError(400, "Name is required");
  const kind = KINDS.includes(b.kind) ? b.kind : "check";
  const polarity = b.polarity === "quit" ? "quit" : "build";
  const period = b.period === "week" && kind !== "rating" ? "week" : "day";
  let goal = num(b.goal, { min: 0, allowNull: true });
  if (kind === "rating" && goal !== null) goal = Math.min(5, Math.max(1, goal));
  return {
    name,
    emoji: str(b.emoji, 16) || "•",
    color: /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : "#6366f1",
    kind,
    polarity,
    goal,
    unit: kind === "count" ? str(b.unit, 20) : null,
    category: str(b.category, 30),
    archived: Number(b.archived) ? 1 : 0,
    period,
    days: period === "day" && polarity === "build" ? cleanDays(b.days) : null,
    reminders: cleanReminders(b.reminders),
    pinned: Number(b.pinned) ? 1 : 0,
  };
}

function cleanBook(b) {
  const title = str(b.title, 120);
  if (!title) throw new HttpError(400, "Title is required");
  return {
    title,
    author: str(b.author, 80),
    total_pages: num(b.total_pages, { min: 1, max: 100000, allowNull: true }),
    start_page: num(b.start_page ?? 0, { min: 0, max: 100000 }),
    status: b.status === "finished" ? "finished" : "reading",
  };
}

function cleanAccount(b) {
  const username = String(b.username ?? "").trim();
  if (!USERNAME_RE.test(username)) throw new HttpError(400, "Username: 3–30 letters, numbers, . _ or -");
  const password = String(b.password ?? "");
  if (password.length < 8) throw new HttpError(400, "Password must be at least 8 characters");
  if (password.length > 200) throw new HttpError(400, "Password is too long");
  return { username, password, name: str(b.name, 40) };
}

function validTz(tz) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return typeof tz === "string" && tz.length < 64;
  } catch {
    return false;
  }
}

const setSetting = (db, key, value) =>
  db.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(key, value);

async function createUser(db, { username, password, name }, { isAdmin = false, tz = null } = {}) {
  if (await db.prepare("SELECT 1 FROM users WHERE username = ?").bind(username).first()) {
    throw new HttpError(409, "That username is taken");
  }
  const { hash, salt } = await hashPassword(password);
  const id = crypto.randomUUID();
  await db
    .prepare("INSERT INTO users (id,username,name,pass_hash,salt,is_admin,tz,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .bind(id, username, name, hash, salt, isAdmin ? 1 : 0, validTz(tz) ? tz : null, Date.now())
    .run();
  return id;
}

// ---------- routes ----------

async function handleApi(request, env, url) {
  const path = url.pathname.slice(4); // strip "/api"
  const method = request.method;
  const db = env.DB;

  // CSRF guard: browsers can't add custom headers to cross-site form posts.
  if (method !== "GET" && request.headers.get("x-requested-with") !== "tracker") throw new HttpError(403, "Forbidden");

  // ----- auth (no session needed) -----

  if (path === "/auth/status" && method === "GET") {
    const user = await currentUser(request, db);
    const hasUsers = !!(await db.prepare("SELECT 1 FROM users LIMIT 1").first());
    return json({ setup: !hasUsers, user: user ? publicUser(user) : null });
  }

  if (path === "/auth/setup" && method === "POST") {
    // First account = owner. Proves ownership with the old APP_PASSWORD and adopts all existing data.
    const b = await readJson(request);
    if (await db.prepare("SELECT 1 FROM users LIMIT 1").first()) throw new HttpError(400, "Already set up — log in instead");
    if (!env.APP_PASSWORD || typeof b.owner_password !== "string" || !(await safeEqual(b.owner_password.trim(), String(env.APP_PASSWORD).trim()))) {
      await slowFail();
      throw new HttpError(401, "Old app password is wrong");
    }
    const acct = cleanAccount(b);
    const tz = (await db.prepare("SELECT value FROM settings WHERE key='tz'").first())?.value || b.tz;
    const id = await createUser(db, acct, { isAdmin: true, tz });
    await db.batch(["trackers", "entries", "books", "push_subs"].map((t) => db.prepare(`UPDATE ${t} SET user_id=? WHERE user_id IS NULL`).bind(id)));
    return json({ ok: true }, 200, { "set-cookie": await startSession(db, id) });
  }

  if (path === "/auth/signup" && method === "POST") {
    const b = await readJson(request);
    const code = String(b.invite ?? "").trim();
    const invite = code && (await db.prepare("SELECT * FROM invites WHERE code=?").bind(code).first());
    if (!invite || invite.used_by || invite.expires_at < Date.now()) {
      await slowFail();
      throw new HttpError(400, "This invite link is invalid, used, or expired. Ask for a new one.");
    }
    const acct = cleanAccount(b);
    const id = await createUser(db, acct, { tz: b.tz });
    const r = await db.prepare("UPDATE invites SET used_by=?, used_at=? WHERE code=? AND used_by IS NULL").bind(id, Date.now(), code).run();
    if (!r.meta.changes) {
      await db.prepare("DELETE FROM users WHERE id=?").bind(id).run(); // lost a race for the same invite
      throw new HttpError(400, "This invite was just used");
    }
    return json({ ok: true }, 200, { "set-cookie": await startSession(db, id) });
  }

  if (path === "/auth/login" && method === "POST") {
    const b = await readJson(request);
    const u = await db.prepare("SELECT * FROM users WHERE username=?").bind(String(b.username ?? "").trim()).first();
    const { hash } = await hashPassword(String(b.password ?? ""), u?.salt); // hash even if user is unknown (timing)
    if (!u || !(await safeEqual(hash, u.pass_hash))) {
      await slowFail();
      throw new HttpError(401, "Wrong username or password");
    }
    return json({ ok: true }, 200, { "set-cookie": await startSession(db, u.id) });
  }

  if (path === "/auth/logout" && method === "POST") {
    const token = cookieToken(request);
    if (token) await db.prepare("DELETE FROM sessions WHERE id=?").bind(await sha256(token)).run();
    return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
  }

  // ----- everything below needs a session -----

  const user = await currentUser(request, db);
  if (!user) throw new HttpError(401, "Unauthorized");
  const uid = user.id;
  let m;

  if (path === "/auth/password" && method === "POST") {
    const b = await readJson(request);
    const { hash } = await hashPassword(String(b.current ?? ""), user.salt);
    if (!(await safeEqual(hash, user.pass_hash))) { await slowFail(); throw new HttpError(401, "Current password is wrong"); }
    const { password } = cleanAccount({ username: user.username, password: b.password });
    const next = await hashPassword(password);
    const token = cookieToken(request);
    await db.batch([
      db.prepare("UPDATE users SET pass_hash=?, salt=? WHERE id=?").bind(next.hash, next.salt, uid),
      // sign out every other device
      db.prepare("DELETE FROM sessions WHERE user_id=? AND id<>?").bind(uid, await sha256(token)),
    ]);
    return json({ ok: true });
  }

  if (path === "/state" && method === "GET") {
    const since = url.searchParams.get("since");
    if (since && !DATE_RE.test(since)) throw new HttpError(400, "Bad date");
    const s = since || "0000-00-00";
    const [trackers, entries, books, diary] = await db.batch([
      db.prepare("SELECT * FROM trackers WHERE user_id=? ORDER BY sort, created_at").bind(uid),
      // Recent entries, plus all entries tied to a book so book progress is complete.
      db.prepare("SELECT * FROM entries WHERE user_id=? AND (date >= ? OR book_id IS NOT NULL) ORDER BY date, created_at").bind(uid, s),
      db.prepare("SELECT * FROM books WHERE user_id=? ORDER BY created_at").bind(uid),
      db.prepare("SELECT date, mood, text, updated_at FROM diary WHERE user_id=? AND date >= ? ORDER BY date").bind(uid, s),
    ]);
    return json({
      user: publicUser(user),
      trackers: trackers.results,
      entries: entries.results,
      books: books.results,
      diary: diary.results,
      vapidPublicKey: env.VAPID_PUBLIC_KEY || null,
    });
  }

  if (path === "/export" && method === "GET") {
    const [trackers, entries, books, diary] = await db.batch([
      db.prepare("SELECT * FROM trackers WHERE user_id=? ORDER BY sort, created_at").bind(uid),
      db.prepare("SELECT * FROM entries WHERE user_id=? ORDER BY date, created_at").bind(uid),
      db.prepare("SELECT * FROM books WHERE user_id=? ORDER BY created_at").bind(uid),
      db.prepare("SELECT date, mood, text, updated_at FROM diary WHERE user_id=? ORDER BY date").bind(uid),
    ]);
    return json(
      { exported_at: new Date().toISOString(), user: user.username, trackers: trackers.results, entries: entries.results, books: books.results, diary: diary.results },
      200,
      { "content-disposition": `attachment; filename="trackers-${new Date().toISOString().slice(0, 10)}.json"` }
    );
  }

  if (path === "/settings" && method === "POST") {
    const { tz } = await readJson(request);
    if (!validTz(tz)) throw new HttpError(400, "Bad timezone");
    await db.prepare("UPDATE users SET tz=? WHERE id=?").bind(tz, uid).run();
    return json({ ok: true });
  }

  // ----- invites (owner only) -----

  if (path === "/invites" && method === "GET") {
    if (!user.is_admin) throw new HttpError(403, "Only the owner can invite people");
    const [invites, users] = await db.batch([
      db.prepare("SELECT i.code, i.note, i.created_at, i.expires_at, i.used_at, u.username AS used_by_name FROM invites i LEFT JOIN users u ON u.id=i.used_by ORDER BY i.created_at DESC LIMIT 50"),
      db.prepare("SELECT username, name, is_admin, created_at FROM users ORDER BY created_at"),
    ]);
    return json({ invites: invites.results, users: users.results });
  }

  if (path === "/invites" && method === "POST") {
    if (!user.is_admin) throw new HttpError(403, "Only the owner can invite people");
    const b = await readJson(request);
    const invite = { code: randomToken(12), note: str(b.note, 40), created_at: Date.now(), expires_at: Date.now() + INVITE_DAYS * 86400e3 };
    await db
      .prepare("INSERT INTO invites (code,created_by,note,created_at,expires_at) VALUES (?,?,?,?,?)")
      .bind(invite.code, uid, invite.note, invite.created_at, invite.expires_at)
      .run();
    return json(invite, 201);
  }

  if ((m = path.match(/^\/invites\/([\w-]+)$/)) && method === "DELETE") {
    if (!user.is_admin) throw new HttpError(403, "Only the owner can invite people");
    await db.prepare("DELETE FROM invites WHERE code=? AND used_by IS NULL").bind(m[1]).run();
    return json({ ok: true });
  }

  // ----- trackers -----

  const ownTracker = (id) => db.prepare("SELECT 1 FROM trackers WHERE id=? AND user_id=?").bind(String(id), uid).first();

  if (path === "/trackers" && method === "POST") {
    const t = cleanTracker(await readJson(request));
    const id = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO trackers (id,user_id,name,emoji,color,kind,polarity,goal,unit,category,archived,period,days,reminders,pinned,sort,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,(SELECT COALESCE(MAX(sort),0)+1 FROM trackers WHERE user_id=?),?)`
      )
      .bind(id, uid, t.name, t.emoji, t.color, t.kind, t.polarity, t.goal, t.unit, t.category, t.archived, t.period, t.days, t.reminders, t.pinned, uid, Date.now())
      .run();
    return json(await db.prepare("SELECT * FROM trackers WHERE id=?").bind(id).first(), 201);
  }

  if (path === "/trackers/reorder" && method === "POST") {
    const { ids } = await readJson(request);
    if (!Array.isArray(ids) || ids.length > 500) throw new HttpError(400, "Bad ids");
    const stmts = ids
      .filter((id) => ID_RE.test(id))
      .map((id, i) => db.prepare("UPDATE trackers SET sort=? WHERE id=? AND user_id=?").bind(i + 1, id, uid));
    if (stmts.length) await db.batch(stmts);
    return json({ ok: true });
  }

  if ((m = path.match(/^\/trackers\/([\w-]+)$/))) {
    const id = m[1];
    if (method === "PUT") {
      const t = cleanTracker(await readJson(request));
      const r = await db
        .prepare(
          "UPDATE trackers SET name=?,emoji=?,color=?,kind=?,polarity=?,goal=?,unit=?,category=?,archived=?,period=?,days=?,reminders=?,pinned=? WHERE id=? AND user_id=?"
        )
        .bind(t.name, t.emoji, t.color, t.kind, t.polarity, t.goal, t.unit, t.category, t.archived, t.period, t.days, t.reminders, t.pinned, id, uid)
        .run();
      if (!r.meta.changes) throw new HttpError(404, "Not found");
      return json(await db.prepare("SELECT * FROM trackers WHERE id=?").bind(id).first());
    }
    if (method === "DELETE") {
      if (!(await ownTracker(id))) throw new HttpError(404, "Not found");
      await db.batch([
        db.prepare("DELETE FROM entries WHERE tracker_id=? AND user_id=?").bind(id, uid),
        db.prepare("DELETE FROM books WHERE tracker_id=? AND user_id=?").bind(id, uid),
        db.prepare("DELETE FROM trackers WHERE id=? AND user_id=?").bind(id, uid),
      ]);
      return json({ ok: true });
    }
  }

  // ----- entries -----

  if (path === "/entries" && method === "POST") {
    const b = await readJson(request);
    if (!DATE_RE.test(b.date || "")) throw new HttpError(400, "Bad date");
    if (!(await ownTracker(b.tracker_id))) throw new HttpError(404, "Tracker not found");
    const e = {
      // Client-generated ids make offline retries idempotent.
      id: ID_RE.test(b.id || "") ? b.id : crypto.randomUUID(),
      tracker_id: String(b.tracker_id),
      date: b.date,
      value: num(b.value ?? 1),
      note: str(b.note, 500),
      book_id: b.book_id && ID_RE.test(b.book_id) ? b.book_id : null,
      created_at: Number.isFinite(b.created_at) ? b.created_at : Date.now(),
    };
    await db
      .prepare("INSERT OR IGNORE INTO entries (id,user_id,tracker_id,date,value,note,book_id,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .bind(e.id, uid, e.tracker_id, e.date, e.value, e.note, e.book_id, e.created_at)
      .run();
    return json(e, 201);
  }

  if ((m = path.match(/^\/entries\/([\w-]+)$/)) && method === "DELETE") {
    await db.prepare("DELETE FROM entries WHERE id=? AND user_id=?").bind(m[1], uid).run();
    return json({ ok: true });
  }

  // ----- diary -----

  if ((m = path.match(/^\/diary\/(\d{4}-\d{2}-\d{2})$/))) {
    const date = m[1];
    if (method === "PUT") {
      const b = await readJson(request);
      const mood = b.mood == null || b.mood === "" ? null : Math.round(num(b.mood, { min: 1, max: 5 }));
      const text = str(b.text, 20000);
      if (mood === null && !text) {
        await db.prepare("DELETE FROM diary WHERE user_id=? AND date=?").bind(uid, date).run();
        return json({ ok: true, deleted: true });
      }
      const updated = Number.isFinite(b.updated_at) ? b.updated_at : Date.now();
      // Last write wins, so a stale offline save can't overwrite a newer one.
      await db
        .prepare(
          `INSERT INTO diary (user_id,date,mood,text,updated_at) VALUES (?,?,?,?,?)
           ON CONFLICT(user_id,date) DO UPDATE SET mood=excluded.mood, text=excluded.text, updated_at=excluded.updated_at
           WHERE excluded.updated_at >= diary.updated_at`
        )
        .bind(uid, date, mood, text, updated)
        .run();
      return json({ date, mood, text, updated_at: updated });
    }
  }

  // ----- books -----

  const ownBook = (id) => db.prepare("SELECT 1 FROM books WHERE id=? AND user_id=?").bind(id, uid).first();

  if (path === "/books" && method === "POST") {
    const raw = await readJson(request);
    if (!(await ownTracker(raw.tracker_id))) throw new HttpError(404, "Tracker not found");
    const b = { id: crypto.randomUUID(), tracker_id: String(raw.tracker_id), ...cleanBook(raw), created_at: Date.now(), finished_at: null };
    await db
      .prepare("INSERT INTO books (id,user_id,tracker_id,title,author,total_pages,start_page,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(b.id, uid, b.tracker_id, b.title, b.author, b.total_pages, b.start_page, b.status, b.created_at)
      .run();
    return json(b, 201);
  }

  if ((m = path.match(/^\/books\/([\w-]+)$/))) {
    const id = m[1];
    if (method === "PUT") {
      const b = cleanBook(await readJson(request));
      const r = await db
        .prepare(
          `UPDATE books SET title=?,author=?,total_pages=?,start_page=?,status=?,
           finished_at = CASE WHEN ?='finished' THEN COALESCE(finished_at, ?) ELSE NULL END WHERE id=? AND user_id=?`
        )
        .bind(b.title, b.author, b.total_pages, b.start_page, b.status, b.status, Date.now(), id, uid)
        .run();
      if (!r.meta.changes) throw new HttpError(404, "Not found");
      return json(await db.prepare("SELECT * FROM books WHERE id=?").bind(id).first());
    }
    if (method === "DELETE") {
      if (!(await ownBook(id))) throw new HttpError(404, "Not found");
      await db.batch([
        db.prepare("UPDATE entries SET book_id=NULL WHERE book_id=? AND user_id=?").bind(id, uid),
        db.prepare("DELETE FROM books WHERE id=? AND user_id=?").bind(id, uid),
      ]);
      return json({ ok: true });
    }
  }

  // ----- push -----

  if (path === "/push/subscribe" && method === "POST") {
    const { subscription: s, tz } = await readJson(request);
    const endpoint = s?.endpoint;
    if (typeof endpoint !== "string" || !endpoint.startsWith("https://") || endpoint.length > 1000) throw new HttpError(400, "Bad subscription");
    const p256dh = str(s.keys?.p256dh, 200), auth = str(s.keys?.auth, 100);
    if (!p256dh || !auth) throw new HttpError(400, "Bad subscription keys");
    const stmts = [
      db.prepare("INSERT OR REPLACE INTO push_subs (endpoint,user_id,p256dh,auth,created_at) VALUES (?,?,?,?,?)").bind(endpoint, uid, p256dh, auth, Date.now()),
    ];
    if (validTz(tz)) stmts.push(db.prepare("UPDATE users SET tz=? WHERE id=?").bind(tz, uid));
    await db.batch(stmts);
    return json({ ok: true });
  }

  if (path === "/push/unsubscribe" && method === "POST") {
    const { endpoint } = await readJson(request);
    await db.prepare("DELETE FROM push_subs WHERE endpoint=? AND user_id=?").bind(String(endpoint), uid).run();
    return json({ ok: true });
  }

  if (path === "/push/test" && method === "POST") {
    if (!env.VAPID_PRIVATE_JWK || !env.VAPID_PUBLIC_KEY) throw new HttpError(500, "Push keys are not configured on the server");
    const subs = (await db.prepare("SELECT * FROM push_subs WHERE user_id=?").bind(uid).all()).results;
    if (!subs.length) throw new HttpError(400, "No devices have notifications turned on");
    const statuses = await pushAll(env, db, subs, { title: "📈 Trackers", body: "Notifications are working! 🎉", tag: "test", data: {} });
    const ok = statuses.filter((s) => s >= 200 && s < 300).length;
    if (!ok) throw new HttpError(502, `Push service rejected it (${statuses.join(", ")})`);
    return json({ sent: ok, devices: subs.length });
  }

  throw new HttpError(404, "Not found");
}

// ---------- reminders (cron) ----------

async function pushAll(env, db, subs, message) {
  return Promise.all(
    subs.map(async (s) => {
      const status = await sendPush(env, s, message).catch((e) => (console.error("push error", e), 0));
      if (status === 404 || status === 410) await db.prepare("DELETE FROM push_subs WHERE endpoint=?").bind(s.endpoint).run();
      return status;
    })
  );
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function weekStartOf(date) {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
  return dt.toISOString().slice(0, 10);
}

const fmtNum = (n) => String(Math.round(n * 10) / 10);
const unitOf = (t) => (t.kind === "duration" ? " min" : t.kind === "count" ? (t.unit ? " " + t.unit : "") : "");

async function reminderMessage(db, t, date, dow) {
  const quit = t.polarity === "quit";
  const week = t.period === "week" && t.kind !== "rating";
  if (!quit && !week && t.days && !t.days.split(",").map(Number).includes(dow)) return null; // rest day
  const r = await db
    .prepare("SELECT COALESCE(SUM(value),0) AS s, COUNT(*) AS n FROM entries WHERE tracker_id=? AND date>=? AND date<=?")
    .bind(t.id, week ? weekStartOf(date) : date, date)
    .first();
  const target = quit ? t.goal ?? 0 : t.goal || 1;
  let body;
  if (t.kind === "rating") {
    if (r.n) return null;
    body = `How's ${t.name} today? Tap to rate it 1–5.`;
  } else if (quit) {
    body = `Check-in: ${fmtNum(r.s)}${unitOf(t)} ${week ? "this week" : "today"}${t.goal ? ` (limit ${fmtNum(target)})` : ""}. Log it honestly 💪`;
  } else {
    if (r.s >= target) return null; // already done
    body = `${fmtNum(r.s)}/${fmtNum(target)}${unitOf(t)} ${week ? "this week" : "today"} — time for ${t.name}!`;
  }
  const quick = !quit && (t.kind === "check" || t.kind === "count");
  return {
    title: `${t.emoji} ${t.name}`,
    body,
    tag: `r-${t.id}`,
    data: { tracker_id: t.id, date },
    actions: quick ? [{ action: "done", title: t.kind === "check" ? "✓ Done" : "+1" }] : [],
  };
}

async function runReminders(env, scheduledTime) {
  if (!env.VAPID_PRIVATE_JWK || !env.VAPID_PUBLIC_KEY) return;
  const db = env.DB;
  const now = Math.floor(scheduledTime / 60000) * 60000;
  const last = Number((await db.prepare("SELECT value FROM settings WHERE key='last_reminder'").first())?.value) || now - 60000;
  // Catch up on minutes missed by a late/skipped cron run (max 15), never repeat one.
  const from = Math.max(last + 60000, now - 15 * 60000);
  await setSetting(db, "last_reminder", String(now)).run();
  if (from > now) return;

  const trackers = (
    await db.prepare("SELECT t.*, u.tz AS user_tz FROM trackers t JOIN users u ON u.id = t.user_id WHERE t.archived=0 AND t.reminders IS NOT NULL").all()
  ).results;
  if (!trackers.length) return;

  const formatters = new Map();
  const localParts = (tz, ms) => {
    if (!formatters.has(tz)) {
      formatters.set(tz, new Intl.DateTimeFormat("en-CA", {
        timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
      }));
    }
    const p = Object.fromEntries(formatters.get(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}`, dow: DOW.indexOf(p.weekday) };
  };

  const due = [];
  for (const t of trackers) {
    let times;
    try { times = JSON.parse(t.reminders); } catch { continue; }
    if (!Array.isArray(times) || !times.length) continue;
    const tz = validTz(t.user_tz) ? t.user_tz : "UTC";
    for (let ms = from; ms <= now; ms += 60000) {
      const lp = localParts(tz, ms);
      if (times.includes(lp.hm)) due.push({ t, ...lp });
    }
  }
  if (!due.length) return;

  const subsByUser = new Map();
  for (const { t, date, dow } of due) {
    if (!subsByUser.has(t.user_id)) {
      subsByUser.set(t.user_id, (await db.prepare("SELECT * FROM push_subs WHERE user_id=?").bind(t.user_id).all()).results);
    }
    const subs = subsByUser.get(t.user_id);
    if (!subs.length) continue;
    const msg = await reminderMessage(db, t, date, dow);
    if (msg) await pushAll(env, db, subs, msg);
  }
}
