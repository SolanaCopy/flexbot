const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Public base URL for self-calls inside automation endpoints.
// On Render you can set PUBLIC_BASE_URL=https://flexbot-qpf2.onrender.com
const BASE_URL = (process.env.PUBLIC_BASE_URL || "https://flexbot-qpf2.onrender.com").trim();

// --- Master broadcast gate (prevents other EA instances from posting to your Telegram group) ---
// Configure in Render env:
// - MASTER_LOGIN=1521125881
// - MASTER_SERVER=FTMO-Demo2
function isMasterBroadcaster(body) {
  const login = String(body?.account_login ?? "").trim();
  const server = String(body?.server ?? "").trim();
  const masterLogin = String(process.env.MASTER_LOGIN ?? "").trim();
  const masterServer = String(process.env.MASTER_SERVER ?? "").trim();

  // If not configured, allow broadcasting (older behavior). Use MASTER_LOGIN/MASTER_SERVER to pin posting to one account.
  if (!masterLogin || !masterServer) return true;
  // If configured but EA didn't send account info, deny.
  if (!login || !server) return false;

  return login === masterLogin && server === masterServer;
}

// Market close guard (NL time). Goal: avoid opening new trades near 23:00 NL close,
// especially on Friday to prevent weekend-hanging positions.
// Defaults:
// - Block new signals Friday from 22:30 Europe/Amsterdam until Sunday 23:05.
// - Also block every day from 22:55–23:05 as a safety window.
function inAmsterdamParts(tsMs = Date.now()) {
  const fmt = new Intl.DateTimeFormat("nl-NL", {
    timeZone: "Europe/Amsterdam",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(tsMs));
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const weekday = (get("weekday") || "").toLowerCase(); // e.g., "vr", "za", "zo"
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  return { weekday, hour, minute, minutesOfDay: hour * 60 + minute };
}

function marketBlockedNow(tsMs = Date.now()) {
  const { weekday, minutesOfDay } = inAmsterdamParts(tsMs);

  // Weekend: no trading/signals.
  // Block from Friday 23:00 until Monday 00:10 (NL time).
  if (weekday.startsWith("vr") && minutesOfDay >= (23 * 60 + 0)) {
    return { blocked: true, reason: "market_closed_weekend" };
  }
  if (weekday.startsWith("za")) {
    return { blocked: true, reason: "market_closed_weekend" };
  }
  if (weekday.startsWith("zo")) {
    return { blocked: true, reason: "market_closed_weekend" };
  }
  if (weekday.startsWith("ma") && minutesOfDay < 10) {
    return { blocked: true, reason: "market_close_window" };
  }

  // Daily block window: 23:00 → 00:10 (NL time)
  // This spans midnight, so we block when >= 23:00 OR < 00:10.
  if (minutesOfDay >= (23 * 60 + 0) || minutesOfDay < 10) {
    return { blocked: true, reason: "market_close_window" };
  }

  return { blocked: false, reason: null };
}

// ---- Risk helpers (equity daily-loss + consecutive-loss + trend regime) ----
function dayKeyInTz(tz = "Europe/Prague", tsMs = Date.now()) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(new Date(tsMs));
}

// Start-of-day timestamp in a given IANA timezone (best-effort, DST-safe).
// We compute YYYY-MM-DD in tz, then attach the tz offset at noon (same day) and build an ISO string.
function startOfDayMsInTz(tz = "Europe/Amsterdam", tsMs = Date.now()) {
  const d = new Date(tsMs);

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const y = get("year");
  const m = get("month");
  const day = get("day");
  if (!y || !m || !day) return NaN;

  // Get offset for this local day (use noon local time to avoid DST edge at midnight).
  const noonUtcGuess = Date.UTC(Number(y), Number(m) - 1, Number(day), 12, 0, 0);
  const offParts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "shortOffset",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(noonUtcGuess));
  const off = offParts.find((p) => p.type === "timeZoneName")?.value || "GMT";
  // off looks like "GMT+1" / "GMT+01:00" / "GMT-5".
  const mOff = String(off).match(/^GMT([+-]\d{1,2})(?::?(\d{2}))?$/);
  const hh = mOff ? mOff[1].padStart(3, mOff[1].startsWith("-") ? "-" : "+0") : "+00";
  const mm = mOff && mOff[2] ? mOff[2] : "00";
  const offset = `${hh}:${mm}`;

  const iso = `${y}-${m}-${day}T00:00:00${offset}`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : NaN;
}

function readJsonFileSafe(fp, fallback) {
  try {
    const raw = fs.readFileSync(fp, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJsonFileSafe(fp, obj) {
  try {
    const dir = path.dirname(fp);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(obj, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

function ema(values, period) {
  if (!Array.isArray(values) || values.length === 0) return NaN;
  const p = Math.max(1, Math.floor(period));
  const k = 2 / (p + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function trendBiasFromCandles(candles, fast = 20, slow = 50) {
  if (!Array.isArray(candles) || candles.length < slow + 2) return { ok: false, bias: "none" };
  const closes = candles.map((c) => Number(c.close)).filter((x) => Number.isFinite(x));
  if (closes.length < slow + 2) return { ok: false, bias: "none" };
  const eFast = ema(closes.slice(-Math.max(fast * 3, slow + 2)), fast);
  const eSlow = ema(closes.slice(-Math.max(slow * 3, slow + 2)), slow);
  if (!Number.isFinite(eFast) || !Number.isFinite(eSlow)) return { ok: false, bias: "none" };
  return { ok: true, bias: eFast >= eSlow ? "BUY" : "SELL" };
}

function riskStatePath(kind, symbol) {
  const sym = String(symbol || "XAUUSD").toUpperCase();
  return path.join(__dirname, "state", `${kind}-${sym}.json`);
}

function getAndUpdateDailyEquityStart({ symbol, tz, equityUsd }) {
  const dayKey = dayKeyInTz(tz);
  const fp = riskStatePath("risk-day", symbol);
  const st = readJsonFileSafe(fp, { dayKey: "", tz, startEquity: null, updatedAtMs: 0 });
  if (st.dayKey !== dayKey || !Number.isFinite(Number(st.startEquity)) || Number(st.startEquity) <= 0) {
    const next = { dayKey, tz, startEquity: equityUsd, updatedAtMs: Date.now() };
    writeJsonFileSafe(fp, next);
    return next;
  }
  st.updatedAtMs = Date.now();
  writeJsonFileSafe(fp, st);
  return st;
}

function getConsecutiveLosses({ symbol, tz }) {
  const dayKey = dayKeyInTz(tz);
  const fp = riskStatePath("consec", symbol);
  const st = readJsonFileSafe(fp, { dayKey: "", tz, losses: 0, lastSignalId: "" });
  if (st.dayKey !== dayKey) {
    const next = { dayKey, tz, losses: 0, lastSignalId: "" };
    writeJsonFileSafe(fp, next);
    return next;
  }
  return st;
}

function bumpConsecutiveLosses({ symbol, tz, signalId, outcome }) {
  const fp = riskStatePath("consec", symbol);
  const dayKey = dayKeyInTz(tz);
  const st = readJsonFileSafe(fp, { dayKey, tz, losses: 0, lastSignalId: "" });
  if (st.dayKey !== dayKey) {
    st.dayKey = dayKey;
    st.tz = tz;
    st.losses = 0;
    st.lastSignalId = "";
  }
  if (signalId && st.lastSignalId === signalId) return st;

  const out = String(outcome || "").toLowerCase();
  const isTp = out.includes("tp");
  const isSl = out.includes("sl");
  if (isSl) st.losses = Math.max(0, Number(st.losses) || 0) + 1;
  else if (isTp) st.losses = 0;
  st.lastSignalId = String(signalId || "");
  writeJsonFileSafe(fp, st);
  return st;
}

// Optional persistence (Turso/libSQL). Enable by setting TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in env.
let libsqlClient = null;
async function getDb() {
  if (libsqlClient) return libsqlClient;

  let url = process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN || process.env.DATABASE_AUTH_TOKEN;
  if (!url || !authToken) return null;

  // Render UI sometimes adds whitespace/newlines; also users may paste https://... instead of libsql://...
  url = String(url).trim();
  if (url.startsWith("https://")) url = "libsql://" + url.slice("https://".length);
  if (url.startsWith("http://")) url = "libsql://" + url.slice("http://".length);

  const { createClient } = require("@libsql/client");
  libsqlClient = createClient({ url, authToken });

  // Basic schema: store closed candles for history across restarts.
  await libsqlClient.execute(
    "CREATE TABLE IF NOT EXISTS candles (" +
      "symbol TEXT NOT NULL," +
      "interval TEXT NOT NULL," +
      "start_ms INTEGER NOT NULL," +
      "end_ms INTEGER NOT NULL," +
      "start_iso TEXT NOT NULL," +
      "end_iso TEXT NOT NULL," +
      "open REAL NOT NULL," +
      "high REAL NOT NULL," +
      "low REAL NOT NULL," +
      "close REAL NOT NULL," +
      "last_ts INTEGER," +
      "gap INTEGER DEFAULT 0," +
      "seeded INTEGER DEFAULT 0," +
      "created_at INTEGER NOT NULL," +
      "PRIMARY KEY (symbol, interval, start_ms)" +
    ")"
  );

  // Signals schema: minimal market-entry signals + executions (for MT5 EA integration)
  await libsqlClient.execute(
    "CREATE TABLE IF NOT EXISTS signals (" +
      "id TEXT PRIMARY KEY," +
      "symbol TEXT NOT NULL," +
      "direction TEXT NOT NULL," +
      "sl REAL NOT NULL," +
      "tp_json TEXT NOT NULL," +
      "risk_pct REAL NOT NULL," +
      "comment TEXT," +
      "status TEXT NOT NULL," +
      "created_at_ms INTEGER NOT NULL," +
      "created_at_mt5 TEXT NOT NULL," +
      // Telegram bookkeeping for public group teaser -> edit on close
      "tg_open_chat_id TEXT," +
      "tg_open_message_id INTEGER," +
      // Simple close metadata (optional)
      "closed_at_ms INTEGER," +
      "close_outcome TEXT," +
      "close_result TEXT" +
    ")"
  );

  // Best-effort migrations for older DBs (ignore 'duplicate column name')
  const alterCols = [
    "ALTER TABLE signals ADD COLUMN tg_open_chat_id TEXT",
    "ALTER TABLE signals ADD COLUMN tg_open_message_id INTEGER",
    "ALTER TABLE signals ADD COLUMN closed_at_ms INTEGER",
    "ALTER TABLE signals ADD COLUMN close_outcome TEXT",
    "ALTER TABLE signals ADD COLUMN close_result TEXT",
  ];
  for (const sql of alterCols) {
    try {
      await libsqlClient.execute(sql);
    } catch {
      // ignore
    }
  }

  await libsqlClient.execute(
    "CREATE TABLE IF NOT EXISTS signal_exec (" +
      "signal_id TEXT PRIMARY KEY," +
      "ticket TEXT," +
      "fill_price REAL," +
      "filled_at_ms INTEGER," +
      "filled_at_mt5 TEXT," +
      "raw_json TEXT," +
      "FOREIGN KEY(signal_id) REFERENCES signals(id)" +
    ")"
  );

  // NEW: per-account executions (broadcast support)
  await libsqlClient.execute(
    "CREATE TABLE IF NOT EXISTS signal_exec2 (" +
      "signal_id TEXT NOT NULL," +
      "account_login TEXT NOT NULL," +
      "server TEXT NOT NULL," +
      "ticket TEXT," +
      "fill_price REAL," +
      "filled_at_ms INTEGER," +
      "filled_at_mt5 TEXT," +
      "ok_mod INTEGER DEFAULT 0," +
      "raw_json TEXT," +
      "PRIMARY KEY (signal_id, account_login, server)" +
    ")"
  );
  await libsqlClient.execute("CREATE INDEX IF NOT EXISTS idx_exec2_signal ON signal_exec2(signal_id)");
  await libsqlClient.execute("CREATE INDEX IF NOT EXISTS idx_exec2_account ON signal_exec2(account_login, server)");

  // Best-effort migration from legacy table (safe to ignore failures)
  try {
    await libsqlClient.execute(
      "INSERT OR IGNORE INTO signal_exec2 (signal_id,account_login,server,ticket,fill_price,filled_at_ms,filled_at_mt5,ok_mod,raw_json) " +
        "SELECT signal_id,'legacy','legacy',ticket,fill_price,filled_at_ms,filled_at_mt5,1,raw_json FROM signal_exec"
    );
  } catch {
    // ignore
  }

  // De-dupe posting side-effects (Telegram OPEN/CLOSED) across multiple EA accounts.
  await libsqlClient.execute(
    "CREATE TABLE IF NOT EXISTS signal_posts (" +
      "signal_id TEXT NOT NULL," +
      "kind TEXT NOT NULL," +
      "created_at_ms INTEGER NOT NULL," +
      "PRIMARY KEY (signal_id, kind)" +
    ")"
  );

  await libsqlClient.execute(
    "CREATE INDEX IF NOT EXISTS idx_signals_symbol_created ON signals(symbol, created_at_ms DESC)"
  );
  await libsqlClient.execute(
    "CREATE INDEX IF NOT EXISTS idx_signals_symbol_status ON signals(symbol, status)"
  );

  // EA notification de-dupe (so we only post once per cooldown window)
  await libsqlClient.execute(
    "CREATE TABLE IF NOT EXISTS ea_notifs (" +
      "symbol TEXT NOT NULL," +
      "kind TEXT NOT NULL," +
      "ref_ms INTEGER NOT NULL," +
      "created_at_ms INTEGER NOT NULL," +
      "PRIMARY KEY (symbol, kind, ref_ms)" +
    ")"
  );

  // Track last EA execution per symbol for cooldown-aware automations
  await libsqlClient.execute(
    "CREATE TABLE IF NOT EXISTS ea_state (" +
      "symbol TEXT NOT NULL PRIMARY KEY," +
      "last_executed_ms INTEGER NOT NULL," +
      "last_signal_id TEXT," +
      "last_ticket TEXT" +
    ")"
  );

  // EA live status (open position flag) per account/server/magic/symbol
  // Used by backend/bot to know if EA already has a trade open.
  await libsqlClient.execute(
    "CREATE TABLE IF NOT EXISTS ea_positions (" +
      "account_login TEXT NOT NULL," +
      "server TEXT NOT NULL," +
      "magic INTEGER NOT NULL," +
      "symbol TEXT NOT NULL," +
      "has_position INTEGER NOT NULL," +
      "tickets_json TEXT," +
      "equity REAL," +
      "updated_at_ms INTEGER NOT NULL," +
      "PRIMARY KEY (account_login, server, magic, symbol)" +
    ")"
  );

  // Explicit EA cooldown state (written by EA, read by Flexbot cron/bot)
  await libsqlClient.execute(
    "CREATE TABLE IF NOT EXISTS ea_cooldown (" +
      "symbol TEXT NOT NULL PRIMARY KEY," +
      "active INTEGER NOT NULL," +
      "until_ms INTEGER NOT NULL," +
      "updated_at_ms INTEGER NOT NULL," +
      "reason TEXT" +
    ")"
  );

  // TP streak state (persistent across restarts / multiple instances)
  await libsqlClient.execute(
    "CREATE TABLE IF NOT EXISTS tp_streak (" +
      "symbol TEXT NOT NULL PRIMARY KEY," +
      "streak INTEGER NOT NULL," +
      "last_signal_id TEXT," +
      "updated_at_ms INTEGER NOT NULL" +
    ")"
  );

  return libsqlClient;
}

async function claimSignalPostOnce({ db, signalId, kind }) {
  if (!db || !signalId || !kind) return { ok: false, claimed: false };
  const created_at_ms = Date.now();
  try {
    const r = await db.execute({
      sql: "INSERT OR IGNORE INTO signal_posts (signal_id, kind, created_at_ms) VALUES (?,?,?)",
      args: [String(signalId), String(kind), created_at_ms],
    });
    const rowsAffected = r?.rowsAffected != null ? Number(r.rowsAffected) : NaN;
    if (Number.isFinite(rowsAffected)) return { ok: true, claimed: rowsAffected > 0 };
  } catch {
    // best effort (e.g. older DB without table) — fall through
  }

  // Fallback: best-effort select check (non-atomic, but avoids spam if insert path isn't available)
  try {
    const chk = await db.execute({
      sql: "SELECT 1 AS ok FROM signal_posts WHERE signal_id=? AND kind=? LIMIT 1",
      args: [String(signalId), String(kind)],
    });
    const exists = (chk?.rows || chk?.rowsAffected) ? (chk?.rows?.length || 0) > 0 : false;
    if (exists) return { ok: true, claimed: false };

    await db.execute({
      sql: "INSERT OR IGNORE INTO signal_posts (signal_id, kind, created_at_ms) VALUES (?,?,?)",
      args: [String(signalId), String(kind), created_at_ms],
    });
    return { ok: true, claimed: true };
  } catch {
    return { ok: false, claimed: false };
  }
}

async function isMainAccountLocked(symbol) {
  const db = await getDb();
  if (!db) return { ok: false, locked: false, reason: "db_required" };

  const account_login = String(process.env.MAIN_ACCOUNT_LOGIN || "").trim();
  const server = String(process.env.MAIN_ACCOUNT_SERVER || "").trim();
  const magicRaw = Number(process.env.MAIN_MAGIC || 0);
  const magic = Number.isFinite(magicRaw) ? Math.floor(magicRaw) : 0;

  const maxAgeRaw = Number(process.env.MAIN_EA_STATUS_MAX_AGE_MS || 0);
  const maxAgeMs = Number.isFinite(maxAgeRaw) && maxAgeRaw > 0 ? maxAgeRaw : 2 * 60 * 1000;

  if (!account_login || !server) {
    return { ok: false, locked: false, reason: "main_lock_not_configured" };
  }

  const rows = await db.execute({
    sql:
      "SELECT has_position,updated_at_ms FROM ea_positions WHERE account_login=? AND server=? AND magic=? AND symbol=? LIMIT 1",
    args: [account_login, server, magic, String(symbol).toUpperCase()],
  });
  const r = rows.rows?.[0] || null;
  if (!r) return { ok: true, locked: false, reason: "no_status" };

  const hasPos = Number(r.has_position) === 1;
  const updatedAt = r.updated_at_ms != null ? Number(r.updated_at_ms) : NaN;
  const fresh = Number.isFinite(updatedAt) ? Date.now() - updatedAt <= maxAgeMs : false;

  if (fresh && hasPos) return { ok: true, locked: true, reason: "open_position_lock" };
  return { ok: true, locked: false, reason: fresh ? "no_open_position" : "stale_status" };
}

function globalOpenTradeLockEnabled() {
  // Boss request: "Globaal" = only 1 open trade at a time (per symbol).
  // Default: enabled. Disable by setting GLOBAL_OPEN_TRADE_LOCK=0/false/off.
  const v = String(process.env.GLOBAL_OPEN_TRADE_LOCK || "1").toLowerCase();
  return !["0", "false", "no", "off"].includes(v);
}

function openTradeLockMode() {
  // Which source defines "already open"?
  // - "main" (default): ONLY the main account status (ea_positions) can lock.
  // - "any": any executed signal in DB locks.
  const m = String(process.env.OPEN_TRADE_LOCK_MODE || "main").toLowerCase();
  return m === "any" ? "any" : "main";
}

async function getAnyOpenSignalRow(db, symbol) {
  if (!db) return null;
  const sym = String(symbol || "").toUpperCase();
  const rows = await db.execute({
    sql:
      "SELECT id,symbol,status,tg_open_chat_id,tg_open_message_id,created_at_ms FROM signals " +
      "WHERE symbol=? AND status IN ('active') ORDER BY created_at_ms DESC LIMIT 1", 
    args: [sym],
  });
  return rows.rows?.[0] || null;
}

async function isOpenTradeLocked({ db, symbol }) {
  if (!globalOpenTradeLockEnabled()) return { ok: true, locked: false, reason: "disabled" };

  const mode = openTradeLockMode();
  if (mode === "main") {
    const r = await isMainAccountLocked(symbol);
    if (!r.ok) return { ok: false, locked: false, reason: r.reason || "main_status_error" };
    if (r.locked) return { ok: true, locked: true, reason: "main_open_position_lock" };
    return { ok: true, locked: false, reason: r.reason || "not_locked" };
  }

  // mode === "any"
  const open = await getAnyOpenSignalRow(db, symbol);
  if (open?.id) return { ok: true, locked: true, reason: "db_open_signal_lock", locked_by: String(open.id) };
  return { ok: true, locked: false, reason: "no_open" };
}

async function shouldSuppressOpenTeaserDueToGlobalLock({ db, symbol, chatId, currentSignalId }) {
  const lk = await isOpenTradeLocked({ db, symbol });
  if (!lk.locked) return { suppress: false, reason: lk.reason };

  // If DB already has a different open signal with a TG message in this chat, suppress.
  const open = await getAnyOpenSignalRow(db, symbol);
  const openId = open?.id != null ? String(open.id) : "";
  if (openId && currentSignalId && openId === String(currentSignalId)) return { suppress: false, reason: "same_signal" };

  const openChat = open?.tg_open_chat_id != null ? String(open.tg_open_chat_id) : null;
  const openMsg = open?.tg_open_message_id != null ? Number(open.tg_open_message_id) : null;
  if (openChat && openMsg && String(openChat) === String(chatId)) {
    return { suppress: true, reason: lk.reason, locked_by: openId || lk.locked_by || null, locked_msg_id: openMsg };
  }

  return { suppress: true, reason: lk.reason, locked_by: openId || lk.locked_by || null };
}

// Debug helper (optional)
// (moved) app.get("/ea/main/lock", async (req, res) => {
//  try {
//    const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : "XAUUSD";
//    const r = await isMainAccountLocked(symbol);
//    return res.json({ ok: true, symbol, ...r });
//  } catch (e) {
//    return res.status(500).json({ ok: false, error: String(e?.message || e) });
//  }
//});

async function persistCandle(c) {
  try {
    const db = await getDb();
    if (!db) return;

    const startMs = Date.parse(c.start);
    const endMs = Date.parse(c.end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return;

    await db.execute({
      sql:
        "INSERT OR REPLACE INTO candles (symbol,interval,start_ms,end_ms,start_iso,end_iso,open,high,low,close,last_ts,gap,seeded,created_at) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      args: [
        String(c.symbol),
        String(c.interval),
        startMs,
        endMs,
        String(c.start),
        String(c.end),
        Number(c.open),
        Number(c.high),
        Number(c.low),
        Number(c.close),
        c.lastTs != null ? Number(c.lastTs) : null,
        c.gap ? 1 : 0,
        c.seeded ? 1 : 0,
        Date.now(),
      ],
    });
  } catch {
    // best-effort persistence
  }
}

const app = express();
app.use(express.text({ type: "*/*" }));

// Debug: check main-account open-position lock state
app.get("/ea/main/lock", async (req, res) => {
  try {
    const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : "XAUUSD";
    const r = await isMainAccountLocked(symbol);
    return res.json({ ok: true, symbol, ...r });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Node 18+ heeft fetch standaard. Voor oudere Node versies: npm i node-fetch
const fetchFn =
  globalThis.fetch?.bind(globalThis) ||
  ((...args) => import("node-fetch").then(({ default: f }) => f(...args)));

let last = null;

// Laatste succesvolle chart per symbol+interval+format (fallback als QuickChart faalt)
const lastChartBuf = new Map(); // key -> { buf, tsMs, mime }

// ForexFactory calendar feed (JSON)
const FF_JSON_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
let ffCache = { ts: 0, events: [] };
// Calendar changes slowly; cache more aggressively to avoid 429s.
const FF_CACHE_MS = 60 * 60 * 1000; // 1 hour
const NEWS_BLACKOUT_MIN_DEFAULT = 15;
// Default no-signal window around high-impact news (minutes before AND after)
// Set in Render env: NEWS_BLACKOUT_WINDOW_MIN=30
const NEWS_BLACKOUT_WINDOW_MIN_DEFAULT = 30;

// --- Timezone handling (MT5 server time) ---
// Many brokers run MT5 server time on EET/EEST (UTC+2 / UTC+3). Default to Europe/Athens.
const MT5_TZ = process.env.MT5_TZ || "Europe/Athens";

function formatMt5(tsMs) {
  try {
    const d = new Date(tsMs);
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: MT5_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(d);

    const get = (t) => parts.find((p) => p.type === t)?.value;
    // en-CA gives YYYY-MM-DD parts
    return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get(
      "minute"
    )}:${get("second")}`;
  } catch {
    return new Date(tsMs).toISOString();
  }
}

// Probeert de eerste "echte" JSON object string uit een tekst te halen.
function firstJsonObject(raw) {
  const s = String(raw || "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a === -1 || b === -1 || b <= a) return null;
  return s.slice(a, b + 1);
}

// Time parsing (fallback)
function parseTimeToMs(input) {
  if (input == null) return NaN;

  if (typeof input === "number" && Number.isFinite(input)) {
    return input < 1e12 ? input * 1000 : input;
  }

  const s = String(input).trim();
  if (!s) return NaN;

  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n)) return NaN;
    return n < 1e12 ? n * 1000 : n;
  }

  // MetaTrader format: "YYYY.MM.DD HH:MM:SS"
  const m = s.match(/^(\d{4})\.(\d{2})\.(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (m) {
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  }

  const p = Date.parse(s);
  return Number.isFinite(p) ? p : NaN;
}

// Candle aggregation (1m/5m/15m)
const INTERVALS = {
  "1m": 1 * 60 * 1000,
  "5m": 5 * 60 * 1000,
  "15m": 15 * 60 * 1000,
};

// symbol -> interval -> { current, history }
const candleStore = new Map();
const MAX_HISTORY_PER_SYMBOL = 4000;

function floorToBucketStart(tsMs, intervalMs) {
  return Math.floor(tsMs / intervalMs) * intervalMs;
}

function getOrCreateStore(symbol, interval) {
  const sym = String(symbol);
  if (!candleStore.has(sym)) candleStore.set(sym, new Map());
  const m = candleStore.get(sym);
  if (!m.has(interval)) m.set(interval, { current: null, history: [] });
  return m.get(interval);
}

function getStoreIfExists(symbol, interval) {
  const symMap = candleStore.get(String(symbol));
  return symMap ? symMap.get(interval) : null;
}

function pushHistoryCapped(store, candle) {
  store.history.push(candle);
  if (store.history.length > MAX_HISTORY_PER_SYMBOL) {
    store.history.splice(0, store.history.length - MAX_HISTORY_PER_SYMBOL);
  }
}

function pushHistoryCappedAsync(store, candle) {
  pushHistoryCapped(store, candle);
  // persist closed candles best-effort
  persistCandle(candle);
}

function updateCandle({ symbol, interval, price, tsMs }) {
  const intervalMs = INTERVALS[interval];
  if (!intervalMs) return;

  const store = getOrCreateStore(symbol, interval);

  const bucketStart = floorToBucketStart(tsMs, intervalMs);
  const bucketEnd = bucketStart + intervalMs;

  if (!store.current) {
    store.current = {
      symbol: String(symbol),
      interval,
      start: new Date(bucketStart).toISOString(),
      end: new Date(bucketEnd).toISOString(),
      open: price,
      high: price,
      low: price,
      close: price,
      lastTs: tsMs,
    };
    return;
  }

  const currentStartMs = Date.parse(store.current.start);
  if (tsMs < currentStartMs) return;

  if (currentStartMs === bucketStart) {
    store.current.high = Math.max(store.current.high, price);
    store.current.low = Math.min(store.current.low, price);
    store.current.close = price;
    store.current.lastTs = tsMs;
    return;
  }

  // sluit candle
  const finished = store.current;
  store.current = null;
  pushHistoryCappedAsync(store, finished);

  // gaps vullen (flat candles)
  const prevClose = finished.close;
  let nextStart = currentStartMs + intervalMs;
  while (nextStart < bucketStart) {
    pushHistoryCappedAsync(store, {
      symbol: String(symbol),
      interval,
      start: new Date(nextStart).toISOString(),
      end: new Date(nextStart + intervalMs).toISOString(),
      open: prevClose,
      high: prevClose,
      low: prevClose,
      close: prevClose,
      lastTs: nextStart,
      gap: true,
    });
    nextStart += intervalMs;
  }

  // start nieuwe candle
  store.current = {
    symbol: String(symbol),
    interval,
    start: new Date(bucketStart).toISOString(),
    end: new Date(bucketEnd).toISOString(),
    open: price,
    high: price,
    low: price,
    close: price,
    lastTs: tsMs,
  };
}

// Helpers
function setNoCacheImageHeaders(res, mime, symbol, interval, ext) {
  res.setHeader("Content-Type", mime);
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="chart-${symbol}-${interval}-${Date.now()}.${ext}"`
  );
}

// ForexFactory JSON helpers
function normImpact(x) {
  const s = String(x ?? "").toLowerCase();
  if (s.includes("high")) return "high";
  if (s.includes("medium")) return "medium";
  if (s.includes("low")) return "low";
  return s || "unknown";
}

function getEventTsMs(e) {
  if (e && e.timestamp != null) {
    const n = Number(e.timestamp);
    if (Number.isFinite(n)) return n * 1000;
  }
  const date = e?.date ?? "";
  const time = e?.time ?? "";
  const p = Date.parse(`${date} ${time}`.trim());
  return Number.isFinite(p) ? p : null;
}

function normalizeFfEvent(e) {
  const title = e?.title ?? e?.name ?? "";
  const currency = (e?.currency ?? e?.country ?? "").toString().toUpperCase();
  const impact = normImpact(e?.impact);
  const date = e?.date ?? "";
  const time = e?.time ?? "";
  const ts = getEventTsMs(e);
  const actual = e?.actual ?? null;
  const forecast = e?.forecast ?? null;
  const previous = e?.previous ?? null;
  const url = e?.url ?? null;

  return {
    title: String(title),
    currency: String(currency),
    impact,
    date: String(date),
    time: String(time),
    ts,
    mt5_time: ts ? formatMt5(ts) : null,
    actual,
    forecast,
    previous,
    url,
  };
}

async function getFfEvents() {
  const now = Date.now();
  if (now - ffCache.ts < FF_CACHE_MS && ffCache.events.length) return ffCache.events;

  const r = await fetchFn(FF_JSON_URL, {
    method: "GET",
    headers: { "User-Agent": "flexbot/1.0", Accept: "application/json,*/*" },
  });

  if (!r.ok) throw new Error(`ff_fetch_failed_${r.status}`);

  const arr = await r.json();
  const list = Array.isArray(arr) ? arr : [];
  const events = list.map(normalizeFfEvent);

  ffCache = { ts: now, events };
  return events;
}

async function getRedNews(req) {
  const currency = req.query.currency ? String(req.query.currency).toUpperCase() : null;
  const limit = req.query.limit ? Number(req.query.limit) : 20;
  const minutes = req.query.minutes ? Number(req.query.minutes) : null;

  const all = await getFfEvents();

  let events = all.filter((e) => e.impact === "high");
  if (currency) events = events.filter((e) => e.currency === currency);

  if (Number.isFinite(minutes) && minutes > 0) {
    const now = Date.now();
    const until = now + minutes * 60 * 1000;
    events = events.filter((e) => e.ts == null || (e.ts >= now && e.ts <= until));
  }

  const hardCap = Math.min(Math.max(Number.isFinite(limit) ? limit : 20, 1), 200);
  events = events.slice(0, hardCap);

  return { currency, events };
}

function computeBlackout(events, nowMs, windowMin) {
  const w = (Number.isFinite(windowMin) && windowMin > 0 ? windowMin : NEWS_BLACKOUT_MIN_DEFAULT) * 60 * 1000;
  // consider only events with ts
  const withTs = events.filter((e) => Number.isFinite(e.ts));
  let blackout = false;
  let next = null;

  for (const e of withTs) {
    const start = e.ts - w;
    const end = e.ts + w;
    if (nowMs >= start && nowMs <= end) blackout = true;
    if (e.ts >= nowMs && (!next || e.ts < next.ts)) next = e;
  }

  return { blackout, next_event: next };
}

function formatNewsText(events, currency) {
  if (!events.length) return "Geen red news gevonden.";

  const cur = currency ? ` (${currency})` : "";
  const lines = [`🟥 ForexFactory RED news${cur} (top ${events.length})`];

  for (const e of events) {
    const when = e?.mt5_time || (e.ts ? formatMt5(e.ts) : `${e.date} ${e.time}`);
    lines.push(`• ${when} — ${e.currency} — ${e.title}`);
  }
  return lines.join("\n");
}

// Routes

// --- Signals API (market entries) ---

async function globalCooldownGate({ db, symbol }) {
  const cdMinRaw = Number(process.env.GLOBAL_COOLDOWN_MIN || 0);
  const cdMin = Number.isFinite(cdMinRaw) && cdMinRaw > 0 ? cdMinRaw : 0;
  if (cdMin <= 0) return { active: false, cooldown_min: 0, until_ms: 0, last_created_at_ms: 0 };

  const rows = await db.execute({
    sql: "SELECT created_at_ms FROM signals WHERE symbol=? ORDER BY created_at_ms DESC LIMIT 1",
    args: [symbol],
  });
  const lastMsRaw = rows.rows?.[0]?.created_at_ms;
  const lastCreatedAtMs = lastMsRaw != null ? Number(lastMsRaw) : 0;
  if (!Number.isFinite(lastCreatedAtMs) || lastCreatedAtMs <= 0) {
    return { active: false, cooldown_min: cdMin, until_ms: 0, last_created_at_ms: 0 };
  }

  const untilMs = lastCreatedAtMs + cdMin * 60 * 1000;
  const nowMs = Date.now();
  if (nowMs < untilMs) {
    return { active: true, cooldown_min: cdMin, until_ms: untilMs, last_created_at_ms: lastCreatedAtMs };
  }
  return { active: false, cooldown_min: cdMin, until_ms: untilMs, last_created_at_ms: lastCreatedAtMs };
}

// GET /signal/create?secret=...&symbol=XAUUSD&direction=BUY&sl=...&tp=...&risk_pct=0.5&comment=...
// NOTE: This is designed for bot/web_fetch usage (no POST needed). Keep secret in Render env: SIGNAL_SECRET.
app.get("/signal/create", async (req, res) => {
  try {
    const secret = req.query.secret != null ? String(req.query.secret) : "";
    const expected = process.env.SIGNAL_SECRET ? String(process.env.SIGNAL_SECRET) : "";
    if (!expected || secret !== expected) return res.status(401).json({ ok: false, error: "unauthorized" });

    // Market pause guard (NL time): block creating signals during 23:00–00:10 and weekends.
    const m = marketBlockedNow();
    if (m.blocked) return res.status(409).json({ ok: false, error: "market_blocked", reason: m.reason });

    // News blackout guard: block creating signals X minutes BEFORE and AFTER HIGH impact news.
    // Configure in Render env:
    // - NEWS_BLACKOUT_WINDOW_MIN=30
    // - NEWS_BLACKOUT_CURRENCIES=USD (comma-separated)
    try {
      const wRaw = Number(process.env.NEWS_BLACKOUT_WINDOW_MIN || NEWS_BLACKOUT_WINDOW_MIN_DEFAULT);
      const windowMin = Number.isFinite(wRaw) && wRaw > 0 ? wRaw : NEWS_BLACKOUT_WINDOW_MIN_DEFAULT;
      const curList = String(process.env.NEWS_BLACKOUT_CURRENCIES || "USD")
        .toUpperCase()
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const all = await getFfEvents();
      const ev = all
        .filter((e) => String(e.impact) === "high")
        .filter((e) => (curList.length ? curList.includes(String(e.currency || "").toUpperCase()) : true));
      const blk = computeBlackout(ev, Date.now(), windowMin);
      if (blk.blackout) {
        return res.status(409).json({
          ok: false,
          error: "news_blackout",
          window_min: windowMin,
          currencies: curList,
          next_event: blk.next_event || null,
        });
      }
    } catch {
      // best-effort: if feed fails, don't block signal creation
    }

    const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : "";
    const direction = req.query.direction ? String(req.query.direction).toUpperCase() : "";
    const sl = Number(req.query.sl);

    // Risk cap: never create signals above this risk % (default 1.0)
    let risk_pct = req.query.risk_pct != null ? Number(req.query.risk_pct) : 0.5;
    const maxRiskEnv = Number(process.env.SIGNAL_MAX_RISK_PCT || 1.0);
    const maxRiskPct = Number.isFinite(maxRiskEnv) && maxRiskEnv > 0 ? maxRiskEnv : 1.0;
    if (!Number.isFinite(risk_pct) || risk_pct <= 0) risk_pct = 0.5;
    risk_pct = Math.min(risk_pct, maxRiskPct);

    const comment = req.query.comment != null ? String(req.query.comment) : null;

    const tp = String(req.query.tp || "")
      .split(",")
      .map((x) => Number(String(x).trim()))
      .filter((n) => Number.isFinite(n) && n > 0);

    if (!symbol || !["XAUUSD"].includes(symbol)) return res.status(400).json({ ok: false, error: "bad_symbol" });
    if (!["BUY", "SELL"].includes(direction)) return res.status(400).json({ ok: false, error: "bad_direction" });
    if (!Number.isFinite(sl) || sl <= 0) return res.status(400).json({ ok: false, error: "bad_sl" });
    if (!tp.length) return res.status(400).json({ ok: false, error: "bad_tp" });

    const db = await getDb();
    if (!db) return res.status(503).json({ ok: false, error: "db_required" });

    // Global cooldown gate: block creating ANY new signal until GLOBAL_COOLDOWN_MIN has elapsed
    // since the last created signal (per symbol). This ensures cooldown is identical for ALL accounts.
    {
      const cd = await globalCooldownGate({ db, symbol });
      if (cd.active) {
        return res.status(409).json({
          ok: false,
          error: "cooldown_active",
          symbol,
          cooldown_min: cd.cooldown_min,
          last_created_at_ms: cd.last_created_at_ms,
          until_ms: cd.until_ms,
          until: cd.until_ms ? formatMt5(cd.until_ms) : null,
        });
      }
    }

    // Global open-trade lock (Boss: "Globaal"): block creating any new signal while MAIN account has an open position.
    // (or, if OPEN_TRADE_LOCK_MODE=any, while any executed signal exists)
    {
      const lk = await isOpenTradeLocked({ db, symbol });
      if (lk.locked) {
        return res.status(409).json({ ok: false, error: "open_trade_lock", symbol, reason: lk.reason, locked_by: lk.locked_by || null });
      }
      // If main status is not configured / stale, we don't lock (fail-open).
    }

    const id = `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${Math.random()
      .toString(16)
      .slice(2)}`;

    const nowMs = Date.now();
    const created_at_mt5 = formatMt5(nowMs);

    await db.execute({
      sql: "INSERT OR REPLACE INTO signals (id,symbol,direction,sl,tp_json,risk_pct,comment,status,created_at_ms,created_at_mt5) VALUES (?,?,?,?,?,?,?,?,?,?)",
      args: [id, symbol, direction, sl, JSON.stringify(tp), Number.isFinite(risk_pct) ? risk_pct : 0.5, comment, "new", nowMs, created_at_mt5],
    });

    return res.json({ ok: true, id, symbol, direction, sl, tp, risk_pct, created_at: created_at_mt5 });
  } catch {
    return res.status(500).json({ ok: false, error: "error" });
  }
});

// GET /signal/auto/create?token=...&symbol=XAUUSD&direction=BUY&sl=...&tp=...&risk_pct=0.5&comment=...
// For OpenClaw cron automations: token is stored in Render env AUTO_SIGNAL_TOKEN.
// Optional gate: block creating new signals when EA already has an open position.
// Enable by setting EA_GATE_ENABLED=1.
// Gate lookup keys can be provided via query params or env defaults:
// - account_login (or env EA_GATE_ACCOUNT_LOGIN)
// - server        (or env EA_GATE_SERVER)
// - magic         (or env EA_GATE_MAGIC, default 0)
// Staleness: env EA_STATUS_MAX_AGE_MS (default 5 minutes). If status is older, gate won't block.
app.get("/signal/auto/create", async (req, res) => {
  try {
    const token = req.query.token != null ? String(req.query.token).trim() : "";
    const expected = process.env.AUTO_SIGNAL_TOKEN ? String(process.env.AUTO_SIGNAL_TOKEN).trim() : "";
    if (!expected || token !== expected) return res.status(401).json({ ok: false, error: "unauthorized" });

    // Market pause guard (NL time): block creating signals during 23:00–00:10 and weekends.
    const m = marketBlockedNow();
    if (m.blocked) return res.status(409).json({ ok: false, error: "market_blocked", reason: m.reason });

    // News blackout guard: block creating signals X minutes BEFORE and AFTER HIGH impact news.
    // Configure in Render env:
    // - NEWS_BLACKOUT_WINDOW_MIN=30
    // - NEWS_BLACKOUT_CURRENCIES=USD (comma-separated)
    try {
      const wRaw = Number(process.env.NEWS_BLACKOUT_WINDOW_MIN || NEWS_BLACKOUT_WINDOW_MIN_DEFAULT);
      const windowMin = Number.isFinite(wRaw) && wRaw > 0 ? wRaw : NEWS_BLACKOUT_WINDOW_MIN_DEFAULT;
      const curList = String(process.env.NEWS_BLACKOUT_CURRENCIES || "USD")
        .toUpperCase()
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const all = await getFfEvents();
      const ev = all
        .filter((e) => String(e.impact) === "high")
        .filter((e) => (curList.length ? curList.includes(String(e.currency || "").toUpperCase()) : true));
      const blk = computeBlackout(ev, Date.now(), windowMin);
      if (blk.blackout) {
        return res.status(409).json({
          ok: false,
          error: "news_blackout",
          window_min: windowMin,
          currencies: curList,
          next_event: blk.next_event || null,
        });
      }
    } catch {
      // best-effort: if feed fails, don't block signal creation
    }

    const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : "";
    const direction = req.query.direction ? String(req.query.direction).toUpperCase() : "";
    const sl = Number(req.query.sl);

    // Risk cap: never create signals above this risk % (default 1.0)
    let risk_pct = req.query.risk_pct != null ? Number(req.query.risk_pct) : 0.5;
    const maxRiskEnv = Number(process.env.SIGNAL_MAX_RISK_PCT || 1.0);
    const maxRiskPct = Number.isFinite(maxRiskEnv) && maxRiskEnv > 0 ? maxRiskEnv : 1.0;
    if (!Number.isFinite(risk_pct) || risk_pct <= 0) risk_pct = 0.5;
    risk_pct = Math.min(risk_pct, maxRiskPct);

    const comment = req.query.comment != null ? String(req.query.comment) : null;

    const tp = String(req.query.tp || "")
      .split(",")
      .map((x) => Number(String(x).trim()))
      .filter((n) => Number.isFinite(n) && n > 0);

    if (!symbol || !["XAUUSD"].includes(symbol)) return res.status(400).json({ ok: false, error: "bad_symbol" });
    if (!["BUY", "SELL"].includes(direction)) return res.status(400).json({ ok: false, error: "bad_direction" });
    if (!Number.isFinite(sl) || sl <= 0) return res.status(400).json({ ok: false, error: "bad_sl" });
    if (!tp.length) return res.status(400).json({ ok: false, error: "bad_tp" });

    // Validate SL vs current market if we have a fresh local price snapshot.
    let curMid = NaN;
    try {
      if (last && String(last.symbol || "").toUpperCase() === symbol) {
        const age = last.ts != null ? Date.now() - Number(last.ts) : Infinity;
        if (Number.isFinite(age) && age <= 10 * 60 * 1000) {
          const bid = Number(last.bid);
          const ask = Number(last.ask);
          if (Number.isFinite(bid) && Number.isFinite(ask)) curMid = (bid + ask) / 2;
        }
      }
    } catch {
      curMid = NaN;
    }
    if (Number.isFinite(curMid)) {
      const invalidByPrice =
        (direction === "SELL" && curMid >= sl) ||
        (direction === "BUY" && curMid <= sl);
      if (invalidByPrice) {
        return res.status(400).json({ ok: false, error: "invalid_sl_vs_price", direction, sl, cur: Number(curMid.toFixed(3)) });
      }
    }

    const db = await getDb();
    if (!db) return res.status(503).json({ ok: false, error: "db_required" });

    // Global cooldown gate: block creating ANY new signal until GLOBAL_COOLDOWN_MIN has elapsed
    // since the last created signal (per symbol). This ensures cooldown is identical for ALL accounts.
    {
      const cd = await globalCooldownGate({ db, symbol });
      if (cd.active) {
        return res.status(409).json({
          ok: false,
          error: "cooldown_active",
          symbol,
          cooldown_min: cd.cooldown_min,
          last_created_at_ms: cd.last_created_at_ms,
          until_ms: cd.until_ms,
          until: cd.until_ms ? formatMt5(cd.until_ms) : null,
        });
      }
    }

    // Global open-trade lock (Boss: "Globaal"): block creating any new signal while MAIN account has an open position.
    // (or, if OPEN_TRADE_LOCK_MODE=any, while any executed signal exists)
    {
      const lk = await isOpenTradeLocked({ db, symbol });
      if (lk.locked) {
        return res.status(409).json({ ok: false, error: "open_trade_lock", symbol, reason: lk.reason, locked_by: lk.locked_by || null });
      }
      // If main status is not configured / stale, we don't lock (fail-open).
    }

    // --- EA position gate ---
    const gateEnabled = ["1", "true", "yes", "on"].includes(String(process.env.EA_GATE_ENABLED || "").toLowerCase());
    if (gateEnabled) {
      const account_login = (req.query.account_login != null ? String(req.query.account_login) : String(process.env.EA_GATE_ACCOUNT_LOGIN || "")).trim();
      const server = (req.query.server != null ? String(req.query.server) : String(process.env.EA_GATE_SERVER || "")).trim();
      const magicRaw = req.query.magic != null ? Number(req.query.magic) : Number(process.env.EA_GATE_MAGIC || 0);
      const magic = Number.isFinite(magicRaw) ? Math.floor(magicRaw) : 0;

      const maxAgeRaw = Number(process.env.EA_STATUS_MAX_AGE_MS || 0);
      const maxAgeMs = Number.isFinite(maxAgeRaw) && maxAgeRaw > 0 ? maxAgeRaw : 5 * 60 * 1000;

      if (account_login && server) {
        const rows = await db.execute({
          sql:
            "SELECT has_position,updated_at_ms FROM ea_positions WHERE account_login=? AND server=? AND magic=? AND symbol=? LIMIT 1",
          args: [account_login, server, magic, symbol],
        });
        const r = rows.rows?.[0] || null;
        if (r) {
          const hasPos = Number(r.has_position) === 1;
          const updatedAt = r.updated_at_ms != null ? Number(r.updated_at_ms) : NaN;
          const fresh = Number.isFinite(updatedAt) ? Date.now() - updatedAt <= maxAgeMs : false;

          if (fresh && hasPos) {
            return res.status(409).json({
              ok: false,
              error: "ea_has_open_position",
              symbol,
              account_login,
              server,
              magic,
              updated_at_ms: updatedAt,
              updated_at: Number.isFinite(updatedAt) ? formatMt5(updatedAt) : null,
            });
          }
        }
      }
      // If no account/server configured, we don't block (safe default)
    }

    // --- Cooldown gate (optional) ---
    // Prevent creating new signals if the EA is still in cooldown.
    // Enable by setting EA_COOLDOWN_GATE_ENABLED=1.
    // Priority:
    //  1) Explicit EA cooldown state written to /ea/cooldown (table ea_cooldown)
    //  2) Fallback: last_executed_ms in ea_state + fixed EA_COOLDOWN_MIN duration
    const cdGateEnabled = ["1", "true", "yes", "on"].includes(String(process.env.EA_COOLDOWN_GATE_ENABLED || "").toLowerCase());
    if (cdGateEnabled) {
      // 1) explicit cooldown
      try {
        const rows = await db.execute({
          sql: "SELECT active,until_ms,updated_at_ms,reason FROM ea_cooldown WHERE symbol=? LIMIT 1",
          args: [symbol],
        });
        const r = rows.rows?.[0] || null;
        if (r) {
          const active = Number(r.active) === 1;
          const untilMs = r.until_ms != null ? Number(r.until_ms) : 0;
          if (active && Number.isFinite(untilMs) && untilMs > Date.now()) {
            const remainingMs = untilMs - Date.now();
            return res.status(409).json({
              ok: false,
              error: "ea_cooldown_active",
              symbol,
              remaining_ms: remainingMs,
              remaining_min: Math.max(0, Math.ceil(remainingMs / 60000)),
              until_ms: untilMs,
              until: formatMt5(untilMs),
              updated_at_ms: r.updated_at_ms != null ? Number(r.updated_at_ms) : null,
              reason: r.reason != null ? String(r.reason) : null,
              source: "ea_cooldown",
            });
          }
        }
      } catch {
        // ignore, fall back
      }

      // 2) fallback cooldown duration based on last execution
      const cdMinRaw = Number(process.env.EA_COOLDOWN_MIN || 0);
      const cdMin = Number.isFinite(cdMinRaw) && cdMinRaw > 0 ? cdMinRaw : 30;
      const cooldownMs = cdMin * 60 * 1000;

      const st = await db.execute({
        sql: "SELECT last_executed_ms FROM ea_state WHERE symbol=? LIMIT 1",
        args: [symbol],
      });

      const refMs = st.rows?.[0]?.last_executed_ms != null ? Number(st.rows[0].last_executed_ms) : NaN;
      if (Number.isFinite(refMs)) {
        const remainingMs = cooldownMs - (Date.now() - refMs);
        if (remainingMs > 0) {
          return res.status(409).json({
            ok: false,
            error: "ea_cooldown_active",
            symbol,
            cooldown_min: cdMin,
            remaining_ms: remainingMs,
            remaining_min: Math.max(0, Math.ceil(remainingMs / 60000)),
            last_executed_ms: refMs,
            last_executed: formatMt5(refMs),
            source: "ea_state",
          });
        }
      }
    }

    const id = `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${Math.random()
      .toString(16)
      .slice(2)}`;

    const nowMs = Date.now();
    const created_at_mt5 = formatMt5(nowMs);

    await db.execute({
      sql: "INSERT OR REPLACE INTO signals (id,symbol,direction,sl,tp_json,risk_pct,comment,status,created_at_ms,created_at_mt5) VALUES (?,?,?,?,?,?,?,?,?,?)",
      args: [id, symbol, direction, sl, JSON.stringify(tp), Number.isFinite(risk_pct) ? risk_pct : 0.5, comment, "new", nowMs, created_at_mt5],
    });

    return res.json({ ok: true, id, symbol, direction, sl, tp, risk_pct, created_at: created_at_mt5 });
  } catch {
    return res.status(500).json({ ok: false, error: "error" });
  }
});

// POST /signal/manual/open
// Auth: X-API-Key = EA_API_KEY
// Body (JSON): { symbol:"XAUUSD", direction:"BUY"|"SELL", sl:number, tp:[..] or "tp":"a,b,c", risk_pct?:number, comment?:string, ticket?:string|number, fill_price?:number, time?:ms|string }
// Purpose: when a manual trade is opened in MT5 while the EA is running, register it as a signal and post the OPEN teaser.
app.post("/signal/manual/open", async (req, res) => {
  try {
    const apiKey = req.header("x-api-key");
    const expectedKey = process.env.EA_API_KEY ? String(process.env.EA_API_KEY) : "";
    if (!expectedKey || !apiKey || String(apiKey) !== expectedKey) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    // Market pause guard
    const m = marketBlockedNow();
    if (m.blocked) return res.status(409).json({ ok: false, error: "market_blocked", reason: m.reason });

    let body = req.body;
    if (typeof body === "string") body = JSON.parse(firstJsonObject(body) || body);

    const symbol = body?.symbol ? String(body.symbol).toUpperCase() : "";
    const direction = body?.direction ? String(body.direction).toUpperCase() : "";
    const sl = Number(body?.sl);
    let risk_pct = body?.risk_pct != null ? Number(body.risk_pct) : 1.0;
    if (!Number.isFinite(risk_pct) || risk_pct <= 0) risk_pct = 1.0;

    const comment = body?.comment != null ? String(body.comment) : "manual";

    let tp = body?.tp;
    if (typeof tp === "string") {
      tp = tp
        .split(",")
        .map((x) => Number(String(x).trim()))
        .filter((n) => Number.isFinite(n) && n > 0);
    }
    if (!Array.isArray(tp)) tp = [];

    const ticket = body?.ticket != null ? String(body.ticket) : null;
    const fill_price = body?.fill_price != null ? Number(body.fill_price) : null;

    const tsMs = body?.time != null ? parseTimeToMs(body.time) : Date.now();
    const executed_at_ms = Number.isFinite(tsMs) ? tsMs : Date.now();
    const executed_at_mt5 = formatMt5(executed_at_ms);

    if (!symbol || !["XAUUSD"].includes(symbol)) return res.status(400).json({ ok: false, error: "bad_symbol" });
    if (!["BUY", "SELL"].includes(direction)) return res.status(400).json({ ok: false, error: "bad_direction" });
    if (!Number.isFinite(sl) || sl <= 0) return res.status(400).json({ ok: false, error: "bad_sl" });
    if (!tp.length) return res.status(400).json({ ok: false, error: "bad_tp" });

    const db = await getDb();
    if (!db) return res.status(503).json({ ok: false, error: "db_required" });

    const id =
      body?.id && String(body.id).length > 8
        ? String(body.id)
        : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
    const nowMs = Date.now();
    const created_at_mt5 = formatMt5(nowMs);

    // Insert as active (trade is already open)
    await db.execute({
      sql: "INSERT OR REPLACE INTO signals (id,symbol,direction,sl,tp_json,risk_pct,comment,status,created_at_ms,created_at_mt5) VALUES (?,?,?,?,?,?,?,?,?,?)",
      args: [id, symbol, direction, sl, JSON.stringify(tp), risk_pct, comment, "active", nowMs, created_at_mt5],
    });

    // Record execution (legacy/manual)
    await db.execute({
      sql: "INSERT OR REPLACE INTO signal_exec2 (signal_id,account_login,server,ticket,fill_price,filled_at_ms,filled_at_mt5,ok_mod,raw_json) VALUES (?,?,?,?,?,?,?,?,?)",
      args: [
        id,
        "legacy",
        "legacy",
        ticket,
        Number.isFinite(fill_price) ? fill_price : null,
        executed_at_ms,
        executed_at_mt5,
        1,
        JSON.stringify(body),
      ],
    });

    // Post Telegram OPEN teaser (same style as /signal/executed) — master only
    if (isMasterBroadcaster(body)) {
      try {
        const chatId = process.env.TELEGRAM_CHAT_ID || "-1003611276978";
        const photoUrl = new URL(`${BASE_URL}/chart.png`);
        photoUrl.searchParams.set("symbol", symbol);
        photoUrl.searchParams.set("interval", "1m");
        photoUrl.searchParams.set("hours", "3");

        const caption = formatSignalCaption({ id, symbol, direction, riskPct: risk_pct, comment });
        const tgPosted = await tgSendPhoto({ chatId, photo: photoUrl.toString(), caption });
        const mid = tgPosted?.result?.message_id;
        if (mid != null) {
          await db.execute({
            sql: "UPDATE signals SET tg_open_chat_id=?, tg_open_message_id=? WHERE id=?",
            args: [String(chatId), Number(mid), String(id)],
          });
        }
      } catch (e) {
        const msg = String(e?.message || e);
        console.error("tg_open_manual_send_failed", msg);
        // Fallback: at least send text, so the group still sees the OPEN.
        try {
          const chatId2 = process.env.TELEGRAM_CHAT_ID || "-1003611276978";
          const caption2 = formatSignalCaption({ id, symbol, direction, riskPct: risk_pct, comment });
          await tgSendMessage({ chatId: chatId2, text: caption2 });
        } catch {
          // best effort
        }
      }
    }

    return res.json({ ok: true, id, symbol, direction });
  } catch {
    return res.status(400).json({ ok: false, error: "bad_json" });
  }
});

// POST /signal
// Body (JSON): { symbol:"XAUUSD", direction:"BUY"|"SELL", sl:number, tp:[..] or "tp":"a,b,c", risk_pct?:number, comment?:string }
app.post("/signal", async (req, res) => { 
  try {
    // Market pause guard (NL time): block creating signals during 23:00–00:10 and weekends.
    const m = marketBlockedNow();
    if (m.blocked) return res.status(409).json({ ok: false, error: "market_blocked", reason: m.reason });

    // News blackout guard: block creating signals X minutes BEFORE and AFTER HIGH impact news.
    // Configure in Render env:
    // - NEWS_BLACKOUT_WINDOW_MIN=30
    // - NEWS_BLACKOUT_CURRENCIES=USD (comma-separated)
    try {
      const wRaw = Number(process.env.NEWS_BLACKOUT_WINDOW_MIN || NEWS_BLACKOUT_WINDOW_MIN_DEFAULT);
      const windowMin = Number.isFinite(wRaw) && wRaw > 0 ? wRaw : NEWS_BLACKOUT_WINDOW_MIN_DEFAULT;
      const curList = String(process.env.NEWS_BLACKOUT_CURRENCIES || "USD")
        .toUpperCase()
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const all = await getFfEvents();
      const ev = all
        .filter((e) => String(e.impact) === "high")
        .filter((e) => (curList.length ? curList.includes(String(e.currency || "").toUpperCase()) : true));
      const blk = computeBlackout(ev, Date.now(), windowMin);
      if (blk.blackout) {
        return res.status(409).json({
          ok: false,
          error: "news_blackout",
          window_min: windowMin,
          currencies: curList,
          next_event: blk.next_event || null,
        });
      }
    } catch {
      // best-effort: if feed fails, don't block signal creation
    }

    let body = req.body;
    if (typeof body === "string") body = JSON.parse(firstJsonObject(body) || body);

    const symbol = body?.symbol ? String(body.symbol).toUpperCase() : "";
    const direction = body?.direction ? String(body.direction).toUpperCase() : "";
    const sl = Number(body?.sl);
    const risk_pct = body?.risk_pct != null ? Number(body.risk_pct) : 0.5;
    const comment = body?.comment != null ? String(body.comment) : null;

    let tp = body?.tp;
    if (typeof tp === "string") {
      tp = tp
        .split(",")
        .map((x) => Number(String(x).trim()))
        .filter((n) => Number.isFinite(n));
    }

    if (!symbol || !["XAUUSD"].includes(symbol)) return res.status(400).json({ ok: false, error: "bad_symbol" });
    if (!["BUY", "SELL"].includes(direction)) return res.status(400).json({ ok: false, error: "bad_direction" });
    if (!Number.isFinite(sl) || sl <= 0) return res.status(400).json({ ok: false, error: "bad_sl" });
    if (!Array.isArray(tp) || tp.length < 1 || !tp.every((n) => Number.isFinite(n) && n > 0)) {
      return res.status(400).json({ ok: false, error: "bad_tp" });
    }

    const db = await getDb();
    if (!db) return res.status(503).json({ ok: false, error: "db_required" });

    // Global cooldown gate: block creating ANY new signal until GLOBAL_COOLDOWN_MIN has elapsed
    // since the last created signal (per symbol). This ensures cooldown is identical for ALL accounts.
    {
      const cd = await globalCooldownGate({ db, symbol });
      if (cd.active) {
        return res.status(409).json({
          ok: false,
          error: "cooldown_active",
          symbol,
          cooldown_min: cd.cooldown_min,
          last_created_at_ms: cd.last_created_at_ms,
          until_ms: cd.until_ms,
          until: cd.until_ms ? formatMt5(cd.until_ms) : null,
        });
      }
    }

    // Global open-trade lock (Boss: "Globaal"): block creating any new signal while MAIN account has an open position.
    // (or, if OPEN_TRADE_LOCK_MODE=any, while any executed signal exists)
    {
      const lk = await isOpenTradeLocked({ db, symbol });
      if (lk.locked) {
        return res.status(409).json({ ok: false, error: "open_trade_lock", symbol, reason: lk.reason, locked_by: lk.locked_by || null });
      }
      // If main status is not configured / stale, we don't lock (fail-open).
    }

    // uuid-ish without dep
    const id =
      body?.id && String(body.id).length > 8
        ? String(body.id)
        : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${Math.random()
            .toString(16)
            .slice(2)}`;

    const nowMs = Date.now();
    const created_at_mt5 = formatMt5(nowMs);

    await db.execute({
      sql: "INSERT OR REPLACE INTO signals (id,symbol,direction,sl,tp_json,risk_pct,comment,status,created_at_ms,created_at_mt5) VALUES (?,?,?,?,?,?,?,?,?,?)",
      args: [
        id,
        symbol,
        direction,
        sl,
        JSON.stringify(tp),
        Number.isFinite(risk_pct) ? risk_pct : 0.5,
        comment,
        "new",
        nowMs,
        created_at_mt5,
      ],
    });

    return res.json({ ok: true, id, symbol, direction, sl, tp, risk_pct, created_at: created_at_mt5 });
  } catch {
    return res.status(400).json({ ok: false, error: "bad_json" });
  }
});

// GET /signal/next?symbol=XAUUSD&since_ms=<unix_ms>
// - since_ms is optional; when present, only returns signals created at/after since_ms.
// - This lets MT5 EAs avoid executing old pending signals when first attached.
function renderSvgToPngBuffer(svg) {
  // Lazy-require to keep server boot safe even if optional deps fail.
  const { Resvg } = require("@resvg/resvg-js");
  const r = new Resvg(svg, {
    fitTo: { mode: "width", value: 1080 },
    font: {
      // Let system fonts resolve; we avoid custom font files to keep deploy simple.
      loadSystemFonts: true,
    },
  });
  const pngData = r.render();
  return Buffer.from(pngData.asPng());
}

// POST /signal/closed
// Body (JSON): { secret?:string, signal_id:string, outcome:"TP"|"SL"|string, result?:string, closed_at_ms?:number }
// Purpose: public group recap AFTER trade is closed (includes full details)
app.post("/signal/closed", async (req, res) => {
  try {
    let body = req.body;
    if (typeof body === "string") body = JSON.parse(firstJsonObject(body) || body);

    const secret = (body?.secret != null ? String(body.secret) : (req.query.secret != null ? String(req.query.secret) : "")).trim();
    const expected = process.env.SIGNAL_SECRET ? String(process.env.SIGNAL_SECRET) : "";
    if (!expected || secret !== expected) return res.status(401).json({ ok: false, error: "unauthorized" });

    const signal_id = body?.signal_id ? String(body.signal_id) : "";
    const outcome = body?.outcome != null ? String(body.outcome) : null;
    const result = body?.result != null ? String(body.result) : null;
    const closedDirection = body?.direction != null ? String(body.direction).toUpperCase() : null;
    const closedAtMsRaw = body?.closed_at_ms != null ? Number(body.closed_at_ms) : Date.now();
    const closed_at_ms = Number.isFinite(closedAtMsRaw) ? closedAtMsRaw : Date.now();

    if (!signal_id) return res.status(400).json({ ok: false, error: "bad_signal_id" });

    const db = await getDb();
    if (!db) return res.status(503).json({ ok: false, error: "db_required" });

    const sigRow = await db.execute({
      sql: "SELECT id,symbol,direction,sl,tp_json,risk_pct,comment,status,tg_open_chat_id,tg_open_message_id FROM signals WHERE id=? LIMIT 1",
      args: [signal_id],
    });
    const dbSymbol = sigRow.rows?.[0]?.symbol != null ? String(sigRow.rows[0].symbol) : "XAUUSD";
    const sig = sigRow.rows?.[0] || null;
    if (!sig) return res.status(404).json({ ok: false, error: "signal_not_found" });

    let tp = [];
    try { tp = JSON.parse(String(sig.tp_json || "[]")); } catch { tp = []; }

    const exRow = await db.execute({
      sql: "SELECT fill_price FROM signal_exec2 WHERE signal_id=? AND ok_mod=1 ORDER BY filled_at_ms ASC LIMIT 1",
      args: [signal_id],
    });
    const entry = exRow.rows?.[0]?.fill_price != null ? Number(exRow.rows[0].fill_price) : null;

    const chatId = process.env.TELEGRAM_CHAT_ID || "-1003611276978";
    const canBroadcast = isMasterBroadcaster(body);

    // De-dupe CLOSED posting across multiple EA accounts.
    // Only one request should do Telegram side-effects (edit open + post closed card + streak).
    const closeClaim = await claimSignalPostOnce({ db, signalId: signal_id, kind: "tg_closed" });
    if (!closeClaim.claimed) {
      // Still update DB metadata (idempotent) and return.
      await db.execute({
        sql: "UPDATE signals SET status='closed', closed_at_ms=?, close_outcome=?, close_result=? WHERE id=?",
        args: [closed_at_ms, outcome, result, signal_id],
      });
      return res.json({ ok: true, signal_id, posted: false, dedup: true });
    }

    // Update consecutive-loss counter (used by autoScalpRunHandler guard)
    try {
      const riskTz = String(process.env.RISK_TZ || "Europe/Prague");
      bumpConsecutiveLosses({ symbol: dbSymbol, tz: riskTz, signalId: signal_id, outcome });
    } catch {
      // ignore
    }

    // 1) Edit the original OPEN teaser (best effort)
    const openChatId = sig.tg_open_chat_id != null ? String(sig.tg_open_chat_id) : null;
    const openMsgId = sig.tg_open_message_id != null ? Number(sig.tg_open_message_id) : null;
    if (canBroadcast && openChatId && openMsgId) {
      const editedText =
        `✅ SIGNAL CLOSED (#${signal_id})\n` +
        `${String(sig.symbol).toUpperCase()} ${String(sig.direction).toUpperCase()}\n` +
        `Outcome: ${outcome || "-"} | Result: ${result || "-"}\n` +
        `\n` +
        `(Full details posted below)`;
      try {
        await tgEditMessageText({ chatId: openChatId, messageId: openMsgId, text: editedText });
      } catch {
        // ignore edit failures
      }
    }

    // If EA includes direction on close and it differs from stored direction, correct it.
    if (closedDirection && ["BUY", "SELL"].includes(closedDirection) && sig?.direction != null) {
      const storedDir2 = String(sig.direction).toUpperCase();
      if (storedDir2 && storedDir2 !== closedDirection) {
        try {
          await db.execute({
            sql: "UPDATE signals SET direction=? WHERE id=?",
            args: [closedDirection, signal_id],
          });
          sig.direction = closedDirection;
        } catch {
          // best effort
        }
      }
    }

    // 2) Post a NEW CLOSED recap as an IMAGE card (preferred)
    const closedPayload = {
      id: signal_id,
      symbol: String(sig.symbol),
      direction: String(sig.direction),
      entry: entry != null && Number.isFinite(entry) ? entry : "market",
      sl: sig.sl != null ? Number(sig.sl) : null,
      tp,
      outcome,
      result,
    };

    const closedText = formatSignalClosedText(closedPayload);

    // Try PNG card first, fallback to text.
    // Add a human-style recap line on SL hits (rotate variants).
    const slVariants = [
      "Stoploss geraakt. Dat hoort bij het plan. Risk managed, door naar de volgende.",
      "SL hit. Alles volgens plan, risico onder controle. We blijven consistent.",
      "Stoploss gepakt. Geen emotie, gewoon business. Volgende kans komt.",
      "Stoploss hit. Risico gecontroleerd, proces intact.",
      "SL gepakt. Kapitaal beschermd, focus blijft scherp.",
      "Stoploss. Dat is onderdeel van het spel. Geen stress.",
      "Eentje tegen ons. Structuur blijft staan.",
      "SL hit team. Alles volgens plan — we wachten op de volgende kans.",
      "Stoploss geraakt. Risk managed. We pakken de volgende samen.",
      "Verlies hoort erbij. We blijven bouwen.",
      "Verlies genomen binnen de regels. Alles onder controle.",
      "SL hit. Daily risk veilig.",
      "SL geraakt, regels gevolgd. Dat is wat telt.",
      "Kapitaal eerst, winst volgt.",
      "Stoploss is geen fout, het is bescherming. Door naar de volgende.",
      "SL hit. Dit is waarom we risk management hebben.",
      "Wij volgen regels, niet gevoelens.",
      "Dit is waarom we met vaste risk werken.",
      "SL voorkomt grote schade. Zonder SL geen lange termijn.",
      "Controle over risico = controle over emotie. Drawdown gecontroleerd.",
    ];

    const out2 = String(outcome || "").toLowerCase();
    const isSl2 = out2.includes("sl");
    const slMsg = (() => {
      if (!isSl2) return null;
      const seed = `${signal_id}:${closed_at_ms}`;
      let h = 0;
      for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
      const idx = Math.abs(h) % slVariants.length;
      return slVariants[idx];
    })();

    if (canBroadcast) {
      try {
        const svg = createClosedCardSvgV3(closedPayload);
        const pngBuf = renderSvgToPngBuffer(svg);
        // Caption should be short; avoid full internal IDs in public posts.
        const ref8 = String(signal_id || "").slice(-8);
        const outLabel = String(outcome || "CLOSED");
        const caption = slMsg ? `❌ ${slMsg}` : `✅ ${outLabel}${ref8 ? ` (Ref ${ref8})` : ""}`;
        await tgSendPhoto({ chatId, photo: pngBuf, caption });
      } catch (e) {
        const msg = String(e?.message || e);
        console.error("tg_closed_send_failed", msg, { signal_id, chatId });
        await tgSendMessage({ chatId, text: slMsg ? `❌ ${slMsg}\n\n${closedText}` : closedText });
      }

      // 3) TP streak message (persistent; safe across restarts / multiple instances)
      try {
        const sym2 = String(sig.symbol || "XAUUSD").toUpperCase();

        const out = String(outcome || "").toLowerCase();
        const rawNum = Number(String(result || "").replace(/[^0-9.+-]/g, ""));
        const hasNum = Number.isFinite(rawNum);

        // Treat TP as either explicit "tp" outcome OR positive numeric result (more robust)
        const isTp = out.includes("tp") || (hasNum && rawNum > 0);
        const isSl = out.includes("sl") || (hasNum && rawNum < 0);

        // Load current state from DB
        const stRow = await db.execute({
          sql: "SELECT streak,last_signal_id FROM tp_streak WHERE symbol=? LIMIT 1",
          args: [sym2],
        });
        const curStreak = stRow.rows?.[0]?.streak != null ? Number(stRow.rows[0].streak) : 0;
        const lastSignalId = stRow.rows?.[0]?.last_signal_id != null ? String(stRow.rows[0].last_signal_id) : "";

        // de-dupe per signal
        if (String(lastSignalId) !== String(signal_id)) {
          let next = Number.isFinite(curStreak) ? Math.max(0, curStreak) : 0;
          if (isTp) next = next + 1;
          else if (isSl) next = 0;

          await db.execute({
            sql: "INSERT OR REPLACE INTO tp_streak (symbol,streak,last_signal_id,updated_at_ms) VALUES (?,?,?,?)",
            args: [sym2, next, String(signal_id), Date.now()],
          });

          if (isTp && next === 1) {
            await tgSendMessage({ chatId, text: "✅ TP geraakt — netjes.\nhttps://www.fxflexbot.com/" });
          } else if (isTp && next === 2) {
            // Send streak-2 VIDEO (Boss request)
            const videoPath = path.join(__dirname, "assets", "streak_tp2.mp4");
            if (fs.existsSync(videoPath)) {
              const buf = fs.readFileSync(videoPath);
              await tgSendVideo({ chatId, video: buf, caption: "🔥 2 TP’s op rij — momentum.\nhttps://www.fxflexbot.com/" });
            } else {
              await tgSendMessage({ chatId, text: "🔥 2 TP’s op rij — momentum.\nhttps://www.fxflexbot.com/" });
            }
          } else if (isTp && next === 3) {
            // Send streak-3 VIDEO (Boss request)
            const videoPath = path.join(__dirname, "assets", "streak_tp3.mp4");
            if (fs.existsSync(videoPath)) {
              const buf = fs.readFileSync(videoPath);
              await tgSendVideo({ chatId, video: buf, caption: "🏆 3 TP’s op rij — win streak.\nhttps://www.fxflexbot.com/" });
            } else {
              await tgSendMessage({ chatId, text: "🏆 3 TP’s op rij — win streak.\nhttps://www.fxflexbot.com/" });
            }
          }
        }
      } catch {
        // best-effort
      }
    }

    // Update DB
    await db.execute({
      sql: "UPDATE signals SET status='closed', closed_at_ms=?, close_outcome=?, close_result=? WHERE id=?",
      args: [closed_at_ms, outcome, result, signal_id],
    });

    return res.json({ ok: true, signal_id, posted: canBroadcast });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "signal_closed_failed", message: String(e?.message || e) });
  }
});

app.get("/signal/next", async (req, res) => {
  try {
    const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : "XAUUSD";

    // NEW: identify requester account (required for broadcast)
    const account_login = req.query.account_login != null ? String(req.query.account_login).trim() : "";
    const server = req.query.server != null ? String(req.query.server).trim() : "";
    if (!account_login || !server) {
      return res.status(400).json({ ok: false, error: "missing_account_identity" });
    }

    const sinceRaw = req.query.since_ms != null ? String(req.query.since_ms) : null;
    const sinceMs = sinceRaw && /^\d+$/.test(sinceRaw) ? Number(sinceRaw) : 0;
    const sinceMsSafe = Number.isFinite(sinceMs) && sinceMs > 0 ? sinceMs : 0;

    // TTL guard: never serve very old pending signals (prevents stale/ghost backlog).
    // Env: SIGNAL_TTL_MIN (default 120 minutes). Set to 0 to disable.
    const ttlMinRaw = Number(process.env.SIGNAL_TTL_MIN || 120);
    const ttlMin = Number.isFinite(ttlMinRaw) && ttlMinRaw > 0 ? ttlMinRaw : 0;
    const ttlMs = ttlMin > 0 ? ttlMin * 60 * 1000 : 0;
    const minByTtl = ttlMs > 0 ? (Date.now() - ttlMs) : 0;
    const minCreatedAtMs = Math.max(sinceMsSafe, minByTtl);

    const db = await getDb();
    if (!db) return res.status(503).json({ ok: false, error: "db_required" });

    // We may need to skip/cancel stale/invalid signals (e.g., SELL signal where current price already crossed below SL).
    // To avoid the EA looping forever on an impossible signal, we cancel it server-side and try the next one.
    const MAX_SKIP = 5;
    for (let attempt = 0; attempt < MAX_SKIP; attempt++) {
      const rows = await db.execute({
        sql:
          "SELECT id,symbol,direction,sl,tp_json,risk_pct,comment,status,created_at_ms,created_at_mt5 " +
          "FROM signals " +
          "WHERE symbol=? AND status IN ('new','active') AND created_at_ms >= ? " +
          "AND NOT EXISTS (" +
          "  SELECT 1 FROM signal_exec2 e " +
          "  WHERE e.signal_id = signals.id " +
          "    AND e.account_login = ? " +
          "    AND e.server = ? " +
          "    AND e.ok_mod = 1" +
          ") " +
          "ORDER BY created_at_ms ASC LIMIT 1",
        args: [symbol, minCreatedAtMs, account_login, server],
      });

      const r = rows.rows?.[0];
      if (!r) return res.json({ ok: true, signal: null });

      // If we have a fresh local price for this symbol, validate SL vs current price.
      // If not available, serve the signal as-is (best effort).
      let curMid = NaN;
      try {
        if (last && String(last.symbol || "").toUpperCase() === symbol) {
          const age = last.ts != null ? Date.now() - Number(last.ts) : Infinity;
          if (Number.isFinite(age) && age <= 10 * 60 * 1000) {
            const bid = Number(last.bid);
            const ask = Number(last.ask);
            if (Number.isFinite(bid) && Number.isFinite(ask)) curMid = (bid + ask) / 2;
          }
        }
      } catch {
        curMid = NaN;
      }

      const dir = String(r.direction || "").toUpperCase();
      const sl = Number(r.sl);
      const slOk = Number.isFinite(sl) && sl > 0;

      const invalidByPrice =
        Number.isFinite(curMid) && slOk &&
        ((dir === "SELL" && curMid >= sl) || (dir === "BUY" && curMid <= sl));

      if (invalidByPrice) {
        // Cancel signal so EA won't keep re-fetching it.
        const nowMs2 = Date.now();
        await db.execute({
          sql: "UPDATE signals SET status='canceled', closed_at_ms=?, close_outcome=?, close_result=? WHERE id=?",
          args: [nowMs2, "CANCEL", `invalid_sl (cur=${curMid.toFixed(2)} sl=${sl})`, String(r.id)],
        });
        continue;
      }

      let tp = [];
      try {
        tp = JSON.parse(String(r.tp_json || "[]"));
      } catch {
        tp = [];
      }

      return res.json({
        ok: true,
        signal: {
          id: String(r.id),
          symbol: String(r.symbol),
          direction: String(r.direction),
          sl: Number(r.sl),
          tp,
          risk_pct: Number(r.risk_pct),
          created_at_ms: Number(r.created_at_ms),
          created_at: String(r.created_at_mt5),
          comment: r.comment != null ? String(r.comment) : null,
        },
      });
    }

    // If we skipped too many, fail safe.
    return res.json({ ok: true, signal: null, skipped: true });
  } catch {
    return res.status(500).json({ ok: false, error: "error" });
  }
});

// GET /debug/signal?id=...&secret=...
// Returns signal row + last execution callback (raw_json) for troubleshooting.
app.get("/debug/signal", async (req, res) => {
  try {
    const secret = (req.query.secret != null ? String(req.query.secret) : "").trim();
    const expected = process.env.SIGNAL_SECRET ? String(process.env.SIGNAL_SECRET) : "";
    if (!expected || secret !== expected) return res.status(401).json({ ok: false, error: "unauthorized" });

    const id = req.query.id != null ? String(req.query.id) : "";
    if (!id) return res.status(400).json({ ok: false, error: "missing_id" });

    const db = await getDb();
    if (!db) return res.status(503).json({ ok: false, error: "db_required" });

    const sigRow = await db.execute({
      sql: "SELECT * FROM signals WHERE id=? LIMIT 1",
      args: [id],
    });
    const sig = sigRow.rows?.[0] || null;

    const exRow = await db.execute({
      sql: "SELECT signal_id,account_login,server,ticket,fill_price,filled_at_ms,filled_at_mt5,ok_mod,raw_json FROM signal_exec2 WHERE signal_id=? ORDER BY filled_at_ms ASC LIMIT 1",
      args: [id],
    });
    const ex = exRow.rows?.[0] || null;

    let exJson = null;
    try { exJson = ex?.raw_json != null ? JSON.parse(String(ex.raw_json)) : null; } catch { exJson = { raw: ex?.raw_json }; }

    const okModRaw = exJson?.ok_mod ?? exJson?.okMod ?? exJson?.okmod;
    const ok_mod = okModRaw === true || okModRaw === 1 || okModRaw === "1" || okModRaw === "true";

    return res.json({ ok: true, signal: sig, exec: ex, exec_json: exJson, ok_mod });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "debug_failed", message: String(e?.message || e) });
  }
});

// GET /debug/signal/ref?ref=775571e5&secret=...
// Lookup by the last 8 chars shown on the card ("Ref XXXXXXXX"). Returns up to a few matches.
app.get("/debug/signal/ref", async (req, res) => {
  try {
    const secret = (req.query.secret != null ? String(req.query.secret) : "").trim();
    const expected = process.env.SIGNAL_SECRET ? String(process.env.SIGNAL_SECRET) : "";
    if (!expected || secret !== expected) return res.status(401).json({ ok: false, error: "unauthorized" });

    const ref = req.query.ref != null ? String(req.query.ref).trim() : "";
    if (!ref || ref.length < 4) return res.status(400).json({ ok: false, error: "bad_ref" });

    const db = await getDb();
    if (!db) return res.status(503).json({ ok: false, error: "db_required" });

    const like = `%${ref}`;
    const rows = await db.execute({
      sql: "SELECT * FROM signals WHERE id LIKE ? ORDER BY created_at_ms DESC LIMIT 5",
      args: [like],
    });

    const list = rows.rows || [];

    // Also attach exec rows when unique.
    let exec = null;
    if (list.length === 1) {
      const id = String(list[0].id);
      const exRow = await db.execute({
        sql: "SELECT signal_id,account_login,server,ticket,fill_price,filled_at_ms,filled_at_mt5,ok_mod,raw_json FROM signal_exec2 WHERE signal_id=? ORDER BY filled_at_ms ASC LIMIT 1",
        args: [id],
      });
      exec = exRow.rows?.[0] || null;
    }

    return res.json({ ok: true, ref, matches: list.length, signals: list, exec });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "debug_failed", message: String(e?.message || e) });
  }
});

// POST /signal/executed
// Body (JSON): { signal_id, ticket, fill_price, time?:string|ms, ok_mod?:boolean|0|1 }
// NOTE: We only start server-side cooldown + Telegram posting when ok_mod is true (EA confirms it actually placed/modified).
app.post("/signal/executed", async (req, res) => {
  try {
    let body = req.body;
    if (typeof body === "string") body = JSON.parse(firstJsonObject(body) || body);

    const signal_id = body?.signal_id ? String(body.signal_id) : "";
    const ticket = body?.ticket != null ? String(body.ticket) : null;
    const fill_price = body?.fill_price != null ? Number(body.fill_price) : null;
    const execDirection = body?.direction != null ? String(body.direction).toUpperCase() : null;

    // NEW: which account executed it (broadcast support)
    const account_login = body?.account_login != null ? String(body.account_login).trim() : "";
    const server = body?.server != null ? String(body.server).trim() : "";
    if (!account_login || !server) {
      return res.status(400).json({ ok: false, error: "missing_account_identity" });
    }

    const okModRaw = body?.ok_mod ?? body?.okMod ?? body?.okmod;
    const ok_mod = okModRaw === true || okModRaw === 1 || okModRaw === "1" || okModRaw === "true";

    const tsMs = body?.time != null ? parseTimeToMs(body.time) : Date.now();
    const executed_at_ms = Number.isFinite(tsMs) ? tsMs : Date.now();
    const executed_at_mt5 = formatMt5(executed_at_ms);

    if (!signal_id) return res.status(400).json({ ok: false, error: "bad_signal_id" });

    const db = await getDb();
    if (!db) return res.status(503).json({ ok: false, error: "db_required" });

    // NEW: record per-account execution callback (broadcast support)
    await db.execute({
      sql: "INSERT OR REPLACE INTO signal_exec2 (signal_id,account_login,server,ticket,fill_price,filled_at_ms,filled_at_mt5,ok_mod,raw_json) VALUES (?,?,?,?,?,?,?,?,?)",
      args: [
        signal_id,
        account_login,
        server,
        ticket,
        fill_price,
        executed_at_ms,
        executed_at_mt5,
        ok_mod ? 1 : 0,
        JSON.stringify(body),
      ],
    });

    // IMPORTANT: keep signal available for OTHER accounts until they execute too.
    // Use status='active' to represent "open / in-flight".
    await db.execute({
      sql: "UPDATE signals SET status='active' WHERE id=?",
      args: [signal_id],
    });

    // Update EA cooldown state ONLY when EA confirms success.
    // Prefer symbol from signals table (authoritative)
    const sigRow = await db.execute({
      sql: "SELECT symbol,direction,sl,tp_json,risk_pct,comment,tg_open_chat_id,tg_open_message_id FROM signals WHERE id=? LIMIT 1",
      args: [signal_id],
    });
    const sig = sigRow.rows?.[0] || null;
    const sym = sig?.symbol != null ? String(sig.symbol).toUpperCase() : null;

    // If EA reports the executed direction and it differs from stored direction, correct it.
    if (execDirection && ["BUY", "SELL"].includes(execDirection) && sig?.direction != null) {
      const storedDir = String(sig.direction).toUpperCase();
      if (storedDir && storedDir !== execDirection) {
        try {
          await db.execute({
            sql: "UPDATE signals SET direction=? WHERE id=?",
            args: [execDirection, signal_id],
          });
          // keep local copy consistent for this request
          sig.direction = execDirection;
        } catch {
          // best effort
        }
      }
    }

    if (sym) {
      // Update EA cooldown state only when EA confirms success.
      if (ok_mod) {
        await db.execute({
          sql: "INSERT OR REPLACE INTO ea_state (symbol,last_executed_ms,last_signal_id,last_ticket) VALUES (?,?,?,?)",
          args: [sym, executed_at_ms, signal_id, ticket],
        });
      }

      // Telegram OPEN teaser
      // - Default: post only when ok_mod=true (execution-confirmed)
      // - Migration override: FORCE_TG_OPEN_ON_EXEC=1 will post even if ok_mod parsing fails.
      const forceOpen = ["1", "true", "yes", "on"].includes(String(process.env.FORCE_TG_OPEN_ON_EXEC || "").toLowerCase());
      if (ok_mod || forceOpen) {
        const openChatIdExisting = sig?.tg_open_chat_id != null ? String(sig.tg_open_chat_id) : null;
        const openMsgIdExisting = sig?.tg_open_message_id != null ? Number(sig.tg_open_message_id) : null;

        if (forceOpen || !openChatIdExisting || !openMsgIdExisting) {
          const chatId = process.env.TELEGRAM_CHAT_ID || "-1003611276978";
          const canBroadcast = isMasterBroadcaster(body);

          if (canBroadcast) {
            // Global lock (Boss: "Globaal"): if there is already an open trade signal for this symbol,
            // suppress additional OPEN teasers to avoid group spam from multiple connected accounts.
            const sup = await shouldSuppressOpenTeaserDueToGlobalLock({ db, symbol: sym, chatId, currentSignalId: signal_id });
            if (sup.suppress) {
              // best-effort: do nothing (trade is already open; teaser already posted or another account is leading)
              return res.json({ ok: true, signal_id, ticket, fill_price, executed_at: executed_at_mt5, ok_mod, tg_open_suppressed: true, tg_open_reason: sup.reason, locked_by: sup.locked_by || null });
            }

            const photoUrl = new URL(`${BASE_URL}/chart.png`);
            photoUrl.searchParams.set("symbol", sym);
            photoUrl.searchParams.set("interval", "1m");
            photoUrl.searchParams.set("hours", "3");
            // NOTE: do NOT include entry/sl/tp on public group chart (prevents free-riding)

            const dir = sig?.direction != null ? String(sig.direction).toUpperCase() : null;
            const riskPct = sig?.risk_pct != null ? Number(sig.risk_pct) : 1.0;
            const comment = sig?.comment != null ? String(sig.comment) : null;

            if (dir && ["BUY", "SELL"].includes(dir)) {
              // Hard de-dupe across multiple EA accounts: only 1 request may post the OPEN teaser.
              const claim = await claimSignalPostOnce({ db, signalId: signal_id, kind: "tg_open" });
              if (!claim.claimed) {
                return res.json({ ok: true, signal_id, ticket, fill_price, executed_at: executed_at_mt5, ok_mod, tg_open_dedup: true });
              }

              try {
                const caption = formatSignalCaption({ id: signal_id, symbol: sym, direction: dir, riskPct, comment });
                const tgPosted = await tgSendPhoto({ chatId, photo: photoUrl.toString(), caption });
                const mid = tgPosted?.result?.message_id;
                if (mid != null) {
                  await db.execute({
                    sql: "UPDATE signals SET tg_open_chat_id=?, tg_open_message_id=? WHERE id=?",
                    args: [String(chatId), Number(mid), String(signal_id)],
                  });
                }
              } catch (e) {
                const msg = String(e?.message || e);
                console.error("tg_open_send_failed", msg, { signal_id, sym, chatId });
                // Fallback: at least send a text notice so the group sees it.
                try {
                  const caption2 = formatSignalCaption({ id: signal_id, symbol: sym, direction: dir, riskPct, comment });
                  await tgSendMessage({ chatId, text: caption2 });
                } catch {
                  // best effort
                }
              }
            }
          }
        }
      }
    }

    return res.json({ ok: true, signal_id, ticket, fill_price, executed_at: executed_at_mt5, ok_mod, account_login, server });
  } catch {
    return res.status(400).json({ ok: false, error: "bad_json" });
  }
});

// POST /signal/reject
// Header: X-API-Key: <EA_API_KEY>
// Body (JSON): { signal_id:string, reason?:string, meta?:object }
// Purpose: let EA permanently skip impossible signals (e.g. invalid SL) so /signal/next won't keep returning them.
app.post("/signal/reject", async (req, res) => {
  try {
    const apiKey = req.header("x-api-key");
    const expected = process.env.EA_API_KEY ? String(process.env.EA_API_KEY) : "";
    if (!expected || !apiKey || String(apiKey) !== expected) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    let body = req.body;
    if (typeof body === "string") body = JSON.parse(firstJsonObject(body) || body);

    const signal_id = body?.signal_id ? String(body.signal_id) : "";
    const reason = body?.reason != null ? String(body.reason) : "rejected";
    const meta = body?.meta != null ? body.meta : null;
    if (!signal_id) return res.status(400).json({ ok: false, error: "bad_signal_id" });

    const db = await getDb();
    if (!db) return res.status(503).json({ ok: false, error: "db_required" });

    const nowMs = Date.now();
    await db.execute({
      sql: "UPDATE signals SET status='rejected', closed_at_ms=?, close_outcome=?, close_result=? WHERE id=?",
      args: [nowMs, "REJECT", reason, signal_id],
    });

    // best-effort: store meta into signal_exec2 for debugging (as a non-ok_mod row)
    try {
      await db.execute({
        sql: "INSERT OR REPLACE INTO signal_exec2 (signal_id,account_login,server,ticket,fill_price,filled_at_ms,filled_at_mt5,ok_mod,raw_json) VALUES (?,?,?,?,?,?,?,?,?)",
        args: [
          signal_id,
          "reject",
          "reject",
          null,
          null,
          nowMs,
          formatMt5(nowMs),
          0,
          JSON.stringify({ kind: "reject", reason, meta }),
        ],
      });
    } catch {
      // ignore
    }

    return res.json({ ok: true, signal_id, status: "rejected" });
  } catch {
    return res.status(400).json({ ok: false, error: "bad_json" });
  }
});

// GET /ea/cooldown/status?symbol=XAUUSD&cooldown_min=15
// Returns remaining time based on last executed trade.
app.get("/ea/cooldown/status", async (req, res) => {
  try {
    const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : "XAUUSD";
    const cooldownMinRaw = req.query.cooldown_min != null ? Number(req.query.cooldown_min) : 15;
    const cooldownMin = Number.isFinite(cooldownMinRaw) && cooldownMinRaw > 0 ? cooldownMinRaw : 15;

    const db = await getDb();
    if (!db) return res.status(503).json({ ok: false, error: "db_required" });

    // Prefer ea_state (fast), fall back to signal_exec join
    let refMs = NaN;
    const st = await db.execute({
      sql: "SELECT last_executed_ms FROM ea_state WHERE symbol=? LIMIT 1",
      args: [symbol],
    });
    if (st.rows?.[0]?.last_executed_ms != null) refMs = Number(st.rows[0].last_executed_ms);

    if (!Number.isFinite(refMs)) {
      const latest = await db.execute({
        sql:
          "SELECT se.filled_at_ms AS filled_at_ms " +
          "FROM signal_exec2 se JOIN signals s ON s.id = se.signal_id " +
          "WHERE s.symbol=? AND se.filled_at_ms IS NOT NULL AND se.ok_mod=1 " +
          "ORDER BY se.filled_at_ms DESC LIMIT 1", 
        args: [symbol],
      });
      refMs = latest.rows?.[0]?.filled_at_ms != null ? Number(latest.rows[0].filled_at_ms) : NaN;
    }

    if (!Number.isFinite(refMs)) {
      return res.json({ ok: true, symbol, cooldown_min: cooldownMin, has_last_trade: false });
    }

    const now = Date.now();
    const cooldownMs = cooldownMin * 60 * 1000;
    const remainingMs = cooldownMs - (now - refMs);

    return res.json({
      ok: true,
      symbol,
      cooldown_min: cooldownMin,
      has_last_trade: true,
      last_executed_ms: refMs,
      last_executed: formatMt5(refMs),
      now_ms: now,
      now: formatMt5(now),
      cooldown_until_ms: refMs + cooldownMs,
      cooldown_until: formatMt5(refMs + cooldownMs),
      remaining_ms: remainingMs,
      remaining_min: Math.max(0, Math.round(remainingMs / 60000)),
      cooldown_active: remainingMs > 0,
    });
  } catch {
    return res.status(500).json({ ok: false, error: "error" });
  }
});

// GET /ea/cooldown/claim5m?symbol=XAUUSD&cooldown_min=30
// Returns notify=true once per cooldown when ~5 minutes remain.
// GET /ea/auto/claim?symbol=XAUUSD&kind=auto_trade&ref_ms=<number>
// Generic de-dupe claim helper for automations (returns notify=true only once per (symbol,kind,ref_ms)).
app.get("/ea/auto/claim", async (req, res) => {
  try {
    const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : "XAUUSD";
    const kind = req.query.kind ? String(req.query.kind) : "auto";
    const refRaw = req.query.ref_ms != null ? Number(req.query.ref_ms) : NaN;
    const refMs = Number.isFinite(refRaw) ? Math.floor(refRaw) : NaN;

    if (!Number.isFinite(refMs) || refMs <= 0) return res.status(400).json({ ok: false, error: "bad_ref_ms" });

    const db = await getDb();
    if (!db) return res.status(503).json({ ok: false, error: "db_required" });

    const now = Date.now();
    await db.execute({
      sql: "INSERT OR IGNORE INTO ea_notifs (symbol,kind,ref_ms,created_at_ms) VALUES (?,?,?,?)",
      args: [symbol, kind, refMs, now],
    });

    const chk = await db.execute({
      sql: "SELECT created_at_ms FROM ea_notifs WHERE symbol=? AND kind=? AND ref_ms=?",
      args: [symbol, kind, refMs],
    });

    const createdAt = chk.rows?.[0]?.created_at_ms != null ? Number(chk.rows[0].created_at_ms) : NaN;
    const notify = Number.isFinite(createdAt) && createdAt === now;

    return res.json({ ok: true, notify, symbol, kind, ref_ms: refMs });
  } catch {
    return res.status(500).json({ ok: false, error: "error" });
  }
});

// GET /ea/cooldown/claim5m?symbol=XAUUSD&cooldown_min=30
// Returns notify=true once per cooldown when ~5 minutes remain.
app.get("/ea/cooldown/claim5m", async (req, res) => {
  try {
    const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : "XAUUSD";
    const cooldownMinRaw = req.query.cooldown_min != null ? Number(req.query.cooldown_min) : 15;
    const cooldownMin = Number.isFinite(cooldownMinRaw) && cooldownMinRaw > 0 ? cooldownMinRaw : 15;

    const db = await getDb();
    if (!db) return res.status(503).json({ ok: false, error: "db_required" });

    const latest = await db.execute({
      sql:
        "SELECT se.filled_at_ms AS filled_at_ms " +
        "FROM signal_exec2 se JOIN signals s ON s.id = se.signal_id " +
        "WHERE s.symbol=? AND se.filled_at_ms IS NOT NULL AND se.ok_mod=1 " +
        "ORDER BY se.filled_at_ms DESC LIMIT 1",
      args: [symbol],
    });

    const refMs = latest.rows?.[0]?.filled_at_ms != null ? Number(latest.rows[0].filled_at_ms) : NaN;
    if (!Number.isFinite(refMs)) {
      return res.json({ ok: true, notify: false, reason: "no_last_trade" });
    }

    const now = Date.now();
    const cooldownMs = cooldownMin * 60 * 1000;
    const remainingMs = cooldownMs - (now - refMs);

    // Only fire in a ~70s window around exactly 5 minutes remaining.
    const target = 5 * 60 * 1000;
    const windowMs = 70 * 1000;
    const inWindow = remainingMs <= target && remainingMs >= target - windowMs;
    if (!inWindow) {
      return res.json({
        ok: true,
        notify: false,
        remaining_ms: remainingMs,
        remaining_min: Math.max(0, Math.round(remainingMs / 60000)),
      });
    }

    // De-dupe: only one notify per (symbol, kind, refMs)
    const kind = "cooldown_5m";
    const insertedAt = now;

    await db.execute({
      sql: "INSERT OR IGNORE INTO ea_notifs (symbol,kind,ref_ms,created_at_ms) VALUES (?,?,?,?)",
      args: [symbol, kind, refMs, insertedAt],
    });

    const chk = await db.execute({
      sql: "SELECT created_at_ms FROM ea_notifs WHERE symbol=? AND kind=? AND ref_ms=?",
      args: [symbol, kind, refMs],
    });

    const createdAt = chk.rows?.[0]?.created_at_ms != null ? Number(chk.rows[0].created_at_ms) : NaN;
    const notify = Number.isFinite(createdAt) && createdAt === insertedAt;

    if (!notify) {
      return res.json({ ok: true, notify: false, reason: "already_notified" });
    }

    const variants = [
      "⏳ Nog 5 min… daarna kan de EA weer een nieuwe trade pakken ✅",
      "👀 5 minuten nog — EA is zo weer ready ✅",
      "Even chill… nog 5 min cooldown en dan zijn we back 🔥",
      "⏱️ Cooldown bijna klaar: nog 5 min, dan mag de EA weer handelen ✅",
    ];
    const idx = Math.abs(Math.floor(refMs / 1000)) % variants.length;
    const message = variants[idx];

    return res.json({ ok: true, notify: true, message, symbol, remaining_ms: remainingMs });
  } catch {
    return res.status(500).json({ ok: false, error: "error" });
  }
});

// --- EA live status (has open trade) ---
// POST /ea/status
// Header: X-API-Key: <EA_API_KEY>
// Body JSON: { account_login, server, magic, symbol, has_position, tickets?:[], equity?:number, time?:ms|string }
app.post("/ea/status", async (req, res) => {
  try {
    const apiKey = req.header("x-api-key");
    const expected = process.env.EA_API_KEY ? String(process.env.EA_API_KEY) : "";
    if (!expected || !apiKey || String(apiKey) !== expected) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    let body = req.body;
    if (typeof body === "string") body = JSON.parse(firstJsonObject(body) || body);

    const account_login = body?.account_login != null ? String(body.account_login) : "";
    const server = body?.server != null ? String(body.server) : "";
    const magicRaw = body?.magic != null ? Number(body.magic) : 0;
    const magic = Number.isFinite(magicRaw) ? Math.floor(magicRaw) : 0;
    const symbol = body?.symbol != null ? String(body.symbol).toUpperCase() : "";

    const has_position = body?.has_position === true || body?.has_position === 1 || body?.has_position === "1";
    const tickets = Array.isArray(body?.tickets) ? body.tickets.map((x) => String(x)) : [];
    const equity = body?.equity != null ? Number(body.equity) : null;

    const tsMs = body?.time != null ? parseTimeToMs(body.time) : Date.now();
    const updated_at_ms = Number.isFinite(tsMs) ? tsMs : Date.now();

    if (!account_login || !server || !symbol) {
      return res.status(400).json({ ok: false, error: "missing_fields" });
    }

    const db = await getDb();
    if (db) {
      await db.execute({
        sql:
          "INSERT OR REPLACE INTO ea_positions (account_login,server,magic,symbol,has_position,tickets_json,equity,updated_at_ms) VALUES (?,?,?,?,?,?,?,?)",
        args: [
          account_login,
          server,
          magic,
          symbol,
          has_position ? 1 : 0,
          JSON.stringify(tickets),
          Number.isFinite(equity) ? equity : null,
          updated_at_ms,
        ],
      });
    } else {
      // fallback: memory only
      globalThis.eaPositions = globalThis.eaPositions || new Map();
      const key = `${account_login}@${server}:${magic}:${symbol}`;
      globalThis.eaPositions.set(key, {
        account_login,
        server,
        magic,
        symbol,
        has_position,
        tickets,
        equity: Number.isFinite(equity) ? equity : null,
        updated_at_ms,
        updated_at: formatMt5(updated_at_ms),
      });
    }

    return res.json({ ok: true, stored_at: formatMt5(Date.now()) });
  } catch {
    return res.status(400).json({ ok: false, error: "bad_json" });
  }
});

// GET /ea/status?account_login=...&server=...&magic=0&symbol=XAUUSD
app.get("/ea/status", async (req, res) => {
  try {
    const account_login = req.query.account_login != null ? String(req.query.account_login) : "";
    const server = req.query.server != null ? String(req.query.server) : "";
    const magicRaw = req.query.magic != null ? Number(req.query.magic) : 0;
    const magic = Number.isFinite(magicRaw) ? Math.floor(magicRaw) : 0;
    const symbol = req.query.symbol != null ? String(req.query.symbol).toUpperCase() : "XAUUSD";

    if (!account_login || !server) {
      return res.status(400).json({ ok: false, error: "missing_fields" });
    }

    const db = await getDb();
    if (db) {
      const rows = await db.execute({
        sql:
          "SELECT has_position,tickets_json,equity,updated_at_ms FROM ea_positions WHERE account_login=? AND server=? AND magic=? AND symbol=? LIMIT 1",
        args: [account_login, server, magic, symbol],
      });
      const r = rows.rows?.[0];
      if (!r) return res.json({ ok: true, status: null });

      let tickets = [];
      try {
        tickets = JSON.parse(String(r.tickets_json || "[]"));
      } catch {
        tickets = [];
      }

      const updatedAtMs = r.updated_at_ms != null ? Number(r.updated_at_ms) : null;

      return res.json({
        ok: true,
        status: {
          account_login,
          server,
          magic,
          symbol,
          has_position: Number(r.has_position) === 1,
          tickets,
          equity: r.equity != null ? Number(r.equity) : null,
          updated_at_ms: updatedAtMs,
          updated_at: updatedAtMs != null ? formatMt5(updatedAtMs) : null,
        },
      });
    }

    const key = `${account_login}@${server}:${magic}:${symbol}`;
    const s = globalThis.eaPositions?.get(key) || null;
    return res.json({ ok: true, status: s });
  } catch {
    return res.status(500).json({ ok: false, error: "error" });
  }
});

// --- EA explicit cooldown state ---
// POST /ea/cooldown
// Header: X-API-Key: <EA_API_KEY>
// Body JSON: { symbol:"XAUUSD", active:true|false, until?:ms|sec|string, reason?:string }
app.post("/ea/cooldown", async (req, res) => {
  try {
    const apiKey = req.header("x-api-key");
    const expected = process.env.EA_API_KEY ? String(process.env.EA_API_KEY) : "";
    if (!expected || !apiKey || String(apiKey) !== expected) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    let body = req.body;
    if (typeof body === "string") body = JSON.parse(firstJsonObject(body) || body);

    const symbol = body?.symbol != null ? String(body.symbol).toUpperCase() : "";
    const active = body?.active === true || body?.active === 1 || body?.active === "1";

    // until can be: unix seconds, unix ms, ISO string
    let untilMs = 0;
    if (body?.until != null) {
      const parsed = parseTimeToMs(body.until);
      if (Number.isFinite(parsed)) untilMs = parsed;
    }

    const reason = body?.reason != null ? String(body.reason) : null;
    const updated_at_ms = Date.now();

    if (!symbol) return res.status(400).json({ ok: false, error: "missing_symbol" });

    const db = await getDb();
    if (db) {
      await db.execute({
        sql: "INSERT OR REPLACE INTO ea_cooldown (symbol,active,until_ms,updated_at_ms,reason) VALUES (?,?,?,?,?)",
        args: [symbol, active ? 1 : 0, Number(untilMs) || 0, updated_at_ms, reason],
      });
    } else {
      globalThis.eaCooldown = globalThis.eaCooldown || new Map();
      globalThis.eaCooldown.set(symbol, { symbol, active, until_ms: Number(untilMs) || 0, updated_at_ms, reason });
    }

    return res.json({ ok: true, symbol, active, until_ms: Number(untilMs) || 0, updated_at_ms });
  } catch {
    return res.status(400).json({ ok: false, error: "bad_json" });
  }
});

// GET /ea/cooldown?symbol=XAUUSD
app.get("/ea/cooldown", async (req, res) => {
  try {
    const symbol = req.query.symbol != null ? String(req.query.symbol).toUpperCase() : "XAUUSD";

    const db = await getDb();
    let cd = null;

    if (db) {
      const rows = await db.execute({
        sql: "SELECT active,until_ms,updated_at_ms,reason FROM ea_cooldown WHERE symbol=? LIMIT 1",
        args: [symbol],
      });
      cd = rows.rows?.[0] || null;
    } else {
      cd = globalThis.eaCooldown?.get(symbol) || null;
    }

    const nowMs = Date.now();
    const active = cd ? Number(cd.active) === 1 || cd.active === true : false;
    const untilMs = cd && cd.until_ms != null ? Number(cd.until_ms) : 0;
    const remainingSec = active && untilMs > nowMs ? Math.ceil((untilMs - nowMs) / 1000) : 0;

    return res.json({
      ok: true,
      symbol,
      active: !!(active && untilMs > nowMs),
      until_ms: untilMs,
      until: untilMs ? formatMt5(untilMs) : null,
      remaining_sec: remainingSec,
      updated_at_ms: cd && cd.updated_at_ms != null ? Number(cd.updated_at_ms) : null,
      reason: cd && cd.reason != null ? String(cd.reason) : null,
    });
  } catch {
    return res.status(500).json({ ok: false, error: "error" });
  }
});

app.post("/price", (req, res) => {
  try {
    const jsonStr = firstJsonObject(req.body);
    if (!jsonStr) return res.status(400).send("bad");

    const parsed = JSON.parse(jsonStr);
    const { symbol, bid, ask, time, ts } = parsed;

    if (!symbol || bid == null || ask == null) return res.status(400).send("bad");

    const bidNum = Number(bid);
    const askNum = Number(ask);
    if (!Number.isFinite(bidNum) || !Number.isFinite(askNum)) return res.status(400).send("bad");

    const now = Date.now();
    const MAX_DRIFT_MS = 5 * 60 * 1000;

    let tsCandidate = NaN;
    if (ts != null) {
      const n = Number(ts);
      if (Number.isFinite(n)) tsCandidate = n;
    }
    if (!Number.isFinite(tsCandidate) && time != null) {
      tsCandidate = parseTimeToMs(time);
    }

    const tsMs =
      Number.isFinite(tsCandidate) && Math.abs(tsCandidate - now) <= MAX_DRIFT_MS
        ? tsCandidate
        : now;

    const used_feed_time = Number.isFinite(tsCandidate) && Math.abs(tsCandidate - now) <= MAX_DRIFT_MS;

    last = {
      symbol: String(symbol),
      bid: bidNum,
      ask: askNum,
      // Return MT5 server time everywhere by default
      time: formatMt5(tsMs),
      time_utc: new Date(tsMs).toISOString(),
      ts: tsMs,
      raw_time: time ?? null,
      raw_ts: ts ?? null,
      // true when we used the timestamp coming from MT5/EA (or its time string) instead of local server time
      used_server_time: used_feed_time,
      tz: MT5_TZ,
    };

    const mid = (bidNum + askNum) / 2;
    updateCandle({ symbol: last.symbol, interval: "1m", price: mid, tsMs });
    updateCandle({ symbol: last.symbol, interval: "5m", price: mid, tsMs });
    updateCandle({ symbol: last.symbol, interval: "15m", price: mid, tsMs });

    return res.send("ok");
  } catch {
    return res.status(400).send("bad_json");
  }
});

app.get("/price", (req, res) => {
  if (!last) return res.status(404).json({ ok: false });
  return res.json({ ok: true, ...last });
});

// /candles supports: limit, hours, since, until, include_gap
app.get("/candles", async (req, res) => {
  const symbol = req.query.symbol ? String(req.query.symbol) : "";
  const interval = req.query.interval ? String(req.query.interval) : "15m";

  const includeGap =
    req.query.include_gap == null
      ? true
      : !["0", "false", "no"].includes(String(req.query.include_gap).toLowerCase());

  const hours = req.query.hours != null ? Number(req.query.hours) : null;
  const sinceRaw = req.query.since != null ? String(req.query.since) : null;
  const untilRaw = req.query.until != null ? String(req.query.until) : null;
  const limitRaw = req.query.limit != null ? Number(req.query.limit) : null;

  if (!symbol) return res.status(400).json({ ok: false, error: "symbol_required" });
  if (!INTERVALS[interval]) return res.status(400).json({ ok: false, error: "unsupported_interval" });

  // If DB is configured, prefer DB for history (survives restarts)
  const db = await getDb();
  if (db) {
    let sinceMsDb = NaN;
    let untilMsDb = NaN;

    if (Number.isFinite(hours) && hours > 0) {
      sinceMsDb = Date.now() - hours * 60 * 60 * 1000;
    }
    if (sinceRaw) {
      const ms = /^\d+$/.test(sinceRaw) ? Number(sinceRaw) : Date.parse(sinceRaw);
      if (Number.isFinite(ms)) sinceMsDb = ms;
    }
    if (untilRaw) {
      const ms = /^\d+$/.test(untilRaw) ? Number(untilRaw) : Date.parse(untilRaw);
      if (Number.isFinite(ms)) untilMsDb = ms;
    }

    const intervalMs = INTERVALS[interval];
    let hardCap;

    if (Number.isFinite(limitRaw) && limitRaw > 0) {
      hardCap = Math.min(Math.max(limitRaw, 10), 5000);
    } else if (Number.isFinite(sinceMsDb) || Number.isFinite(untilMsDb)) {
      const a = Number.isFinite(sinceMsDb) ? sinceMsDb : Date.now() - 24 * 60 * 60 * 1000;
      const b = Number.isFinite(untilMsDb) ? untilMsDb : Date.now();
      const span = Math.max(0, b - a);
      const needed = Math.ceil(span / intervalMs) + 5;
      hardCap = Math.min(Math.max(needed, 200), 5000);
    } else {
      hardCap = 200;
    }

    const baseSql =
      "SELECT start_ms,end_ms,start_iso,end_iso,open,high,low,close,last_ts,gap,seeded " +
      "FROM candles WHERE symbol=? AND interval=?";

    const args = [symbol, interval];

    let where = "";
    if (Number.isFinite(sinceMsDb)) {
      where += (where ? " AND " : " AND ") + "start_ms >= ?";
      args.push(sinceMsDb);
    }
    if (Number.isFinite(untilMsDb)) {
      where += (where ? " AND " : " AND ") + "start_ms <= ?";
      args.push(untilMsDb);
    }

    const sql = `${baseSql}${where} ORDER BY start_ms DESC LIMIT ?`;
    args.push(hardCap);

    const rows = await db.execute({ sql, args });
    let candles = (rows.rows || [])
      .map((r) => ({
        symbol,
        interval,
        start: String(r.start_iso),
        end: String(r.end_iso),
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        lastTs: r.last_ts != null ? Number(r.last_ts) : null,
        gap: Number(r.gap) === 1,
        seeded: Number(r.seeded) === 1,
      }))
      .filter((c) => [c.open, c.high, c.low, c.close].every(Number.isFinite))
      .reverse();

    if (!includeGap) candles = candles.filter((c) => !c.gap);

    const candlesOut = candles.map((c) => {
      const startMs = Date.parse(c.start);
      const endMs = c.end ? Date.parse(c.end) : NaN;
      return {
        ...c,
        start_mt5: Number.isFinite(startMs) ? formatMt5(startMs) : null,
        end_mt5: Number.isFinite(endMs) ? formatMt5(endMs) : null,
      };
    });

    return res.json({
      ok: true,
      symbol,
      interval,
      tz: MT5_TZ,
      server_time: formatMt5(Date.now()),
      persistence: "turso",
      count: candlesOut.length,
      candles: candlesOut,
    });
  }

  const store = getStoreIfExists(symbol, interval);
  if (!store) return res.json({ ok: true, symbol, interval, persistence: "memory", candles: [] });

  const all = store.current ? [...store.history, store.current] : [...store.history];

  let sinceMs = NaN;
  let untilMs = NaN;

  if (Number.isFinite(hours) && hours > 0) {
    sinceMs = Date.now() - hours * 60 * 60 * 1000;
  }
  if (sinceRaw) {
    const ms = /^\d+$/.test(sinceRaw) ? Number(sinceRaw) : Date.parse(sinceRaw);
    if (Number.isFinite(ms)) sinceMs = ms;
  }
  if (untilRaw) {
    const ms = /^\d+$/.test(untilRaw) ? Number(untilRaw) : Date.parse(untilRaw);
    if (Number.isFinite(ms)) untilMs = ms;
  }

  const intervalMs = INTERVALS[interval];
  let hardCap;

  if (Number.isFinite(limitRaw) && limitRaw > 0) {
    hardCap = Math.min(Math.max(limitRaw, 10), 5000);
  } else if (Number.isFinite(sinceMs) || Number.isFinite(untilMs)) {
    const a = Number.isFinite(sinceMs) ? sinceMs : Date.now() - 24 * 60 * 60 * 1000;
    const b = Number.isFinite(untilMs) ? untilMs : Date.now();
    const span = Math.max(0, b - a);
    const needed = Math.ceil(span / intervalMs) + 5;
    hardCap = Math.min(Math.max(needed, 200), 5000);
  } else {
    hardCap = 200;
  }

  let candles = all.slice(Math.max(0, all.length - hardCap));

  if (!includeGap) candles = candles.filter((c) => !c.gap);
  if (Number.isFinite(sinceMs)) candles = candles.filter((c) => Date.parse(c.start) >= sinceMs);
  if (Number.isFinite(untilMs)) candles = candles.filter((c) => Date.parse(c.start) <= untilMs);

  const candlesOut = candles.map((c) => {
    const startMs = Date.parse(c.start);
    const endMs = c.end ? Date.parse(c.end) : NaN;
    return {
      ...c,
      start_mt5: Number.isFinite(startMs) ? formatMt5(startMs) : null,
      end_mt5: Number.isFinite(endMs) ? formatMt5(endMs) : null,
    };
  });

  return res.json({
    ok: true,
    symbol,
    interval,
    tz: MT5_TZ,
    server_time: formatMt5(Date.now()),
    persistence: "memory",
    count: candlesOut.length,
    candles: candlesOut,
  });
});

// ✅ FIXED /seed: parse JSON even if req.body is a string
app.post("/seed", (req, res) => {
  try {
    let payload = req.body;

    if (typeof payload === "string") {
      const jsonStr = firstJsonObject(payload) || payload;
      payload = JSON.parse(String(jsonStr).trim());
    }

    const { symbol, interval, candles } = payload || {};
    if (!symbol || !INTERVALS[interval] || !Array.isArray(candles)) {
      return res.status(400).json({ ok: false, error: "bad_seed" });
    }

    const store = getOrCreateStore(symbol, interval);

    const map = new Map();
    for (const c of store.history) map.set(c.start, c);

    for (const c of candles) {
      if (!c || !c.start) continue;

      const start = String(c.start);
      const end = c.end ? String(c.end) : "";

      const open = Number(c.open);
      const high = Number(c.high);
      const low = Number(c.low);
      const close = Number(c.close);

      if (![open, high, low, close].every(Number.isFinite)) continue;

      map.set(start, {
        symbol: String(symbol),
        interval: String(interval),
        start,
        end,
        open,
        high,
        low,
        close,
        seeded: true,
      });
    }

    const merged = Array.from(map.values()).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    store.history = merged.slice(Math.max(0, merged.length - MAX_HISTORY_PER_SYMBOL));

    // persist seeded candles best-effort
    for (const c of store.history) persistCandle(c);

    return res.json({
      ok: true,
      symbol: String(symbol),
      interval: String(interval),
      got: candles.length,
      stored: store.history.length,
    });
  } catch {
    return res.status(400).json({ ok: false, error: "bad_seed_json" });
  }
});

// TradingView-ish chart rendering (png/jpg) + green/red candles
async function renderChart(req, res, format /* "png" | "jpg" */) {
  const symbol = req.query.symbol ? String(req.query.symbol) : "XAUUSD";

  // interval can be 1m/5m/15m for direct stores. For longer ranges use ?hours=...
  const requestedInterval = req.query.interval ? String(req.query.interval) : "15m";

  const reqLimit = req.query.limit ? Number(req.query.limit) : 200;
  const limit = Number.isFinite(reqLimit) ? reqLimit : 200;

  const hours = req.query.hours != null ? Number(req.query.hours) : null;

  const MIN_GOOD = 30;
  const MIN_MIN = 3;

  // Helper: aggregate base candles (sorted ascending) into larger interval.
  function aggregateCandles(baseCandles, intervalMs) {
    const out = [];
    let cur = null;
    let curStart = null;

    for (const c of baseCandles) {
      const startMs = Date.parse(c.start);
      if (!Number.isFinite(startMs)) continue;
      const bucket = floorToBucketStart(startMs, intervalMs);
      const bucketEnd = bucket + intervalMs;

      if (!cur || bucket !== curStart) {
        if (cur) out.push(cur);
        curStart = bucket;
        cur = {
          symbol: String(symbol),
          interval: "agg",
          start: new Date(bucket).toISOString(),
          end: new Date(bucketEnd).toISOString(),
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          lastTs: c.lastTs ?? startMs,
        };
        continue;
      }

      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.lastTs = c.lastTs ?? startMs;
    }

    if (cur) out.push(cur);
    return out;
  }

  // Load candles either from DB (preferred) or in-memory store.
  async function loadCandlesForChart(baseInterval, sinceMs) {
    const db = await getDb();
    if (db) {
      const rows = await db.execute({
        sql:
          "SELECT start_iso,end_iso,open,high,low,close,last_ts,gap,seeded FROM candles WHERE symbol=? AND interval=? AND start_ms >= ? ORDER BY start_ms ASC LIMIT ?",
        args: [symbol, baseInterval, sinceMs, 200000],
      });
      return (rows.rows || [])
        .map((r) => ({
          symbol,
          interval: baseInterval,
          start: String(r.start_iso),
          end: String(r.end_iso),
          open: Number(r.open),
          high: Number(r.high),
          low: Number(r.low),
          close: Number(r.close),
          lastTs: r.last_ts != null ? Number(r.last_ts) : null,
          gap: Number(r.gap) === 1,
          seeded: Number(r.seeded) === 1,
        }))
        .filter((c) => [c.open, c.high, c.low, c.close].every(Number.isFinite) && !c.gap);
    }

    const s = getStoreIfExists(symbol, baseInterval);
    if (!s) return [];
    const all = s.current ? [...s.history, s.current] : [...s.history];
    return all.filter((c) => !c.gap).filter((c) => {
      const ms = Date.parse(c.start);
      return Number.isFinite(ms) && ms >= sinceMs;
    });
  }

  // Decide interval and range.
  const now = Date.now();
  const spanMs = Number.isFinite(hours) && hours > 0 ? hours * 60 * 60 * 1000 : null;
  const sinceMs = spanMs ? now - spanMs : null;

  // If hours is provided, auto-pick an interval to keep <= ~480 candles.
  const candidates = [
    { k: "1m", ms: 60 * 1000 },
    { k: "5m", ms: 5 * 60 * 1000 },
    { k: "15m", ms: 15 * 60 * 1000 },
    { k: "30m", ms: 30 * 60 * 1000 },
    { k: "1h", ms: 60 * 60 * 1000 },
    { k: "4h", ms: 4 * 60 * 60 * 1000 },
    { k: "1d", ms: 24 * 60 * 60 * 1000 },
  ];

  let chosenInterval = null;
  let chosenIntervalMs = null;

  if (spanMs) {
    // For multi-day ranges, keep point count smaller to avoid QuickChart payload/render limits.
    const targetMax = spanMs >= 24 * 60 * 60 * 1000 ? 240 : 480;
    for (const c of candidates) {
      const need = Math.ceil(spanMs / c.ms);
      if (need <= targetMax) {
        chosenInterval = c.k;
        chosenIntervalMs = c.ms;
        break;
      }
    }
    if (!chosenInterval) {
      chosenInterval = "1d";
      chosenIntervalMs = 24 * 60 * 60 * 1000;
    }
  } else {
    chosenInterval = INTERVALS[requestedInterval] ? requestedInterval : "15m";
    chosenIntervalMs = INTERVALS[chosenInterval];
  }

  // Get base data (always from 1m store) and aggregate when needed.
  let candles = [];
  let quality = "good";

  if (spanMs) {
    const base = await loadCandlesForChart("1m", sinceMs);
    if (base.length < MIN_MIN) return res.status(404).send("no_data");

    if (chosenInterval === "1m") {
      candles = base;
    } else {
      candles = aggregateCandles(base, chosenIntervalMs);
      candles.forEach((c) => (c.interval = chosenInterval));
    }
  } else {
    // No hours: use existing store matching requested interval as before.
    const tryIntervals = [];
    if (INTERVALS[requestedInterval]) tryIntervals.push(requestedInterval);
    if (!tryIntervals.includes("15m")) tryIntervals.push("15m");
    if (!tryIntervals.includes("5m")) tryIntervals.push("5m");
    if (!tryIntervals.includes("1m")) tryIntervals.push("1m");

    let store = null;

    for (const iv of tryIntervals) {
      const s = getStoreIfExists(symbol, iv);
      const count = s ? (s.current ? s.history.length + 1 : s.history.length) : 0;
      if (s && count >= MIN_GOOD) {
        chosenInterval = iv;
        chosenIntervalMs = INTERVALS[iv];
        store = s;
        quality = "good";
        break;
      }
    }

    if (!store) {
      for (const iv of tryIntervals) {
        const s = getStoreIfExists(symbol, iv);
        const count = s ? (s.current ? s.history.length + 1 : s.history.length) : 0;
        if (s && count >= MIN_MIN) {
          chosenInterval = iv;
          chosenIntervalMs = INTERVALS[iv];
          store = s;
          quality = "low";
          break;
        }
      }
    }

    if (!store) return res.status(404).send("no_data");

    const all = store.current ? [...store.history, store.current] : [...store.history];
    const hardCap = Math.min(Math.max(limit, 120), 500);
    candles = all.slice(Math.max(0, all.length - hardCap)).filter((c) => !c.gap);
  }

  if (!candles.length) return res.status(404).send("no_data");

  // cap to 500 for QuickChart
  if (candles.length > 500) candles = candles.slice(candles.length - 500);

  // gap candles eruit = mooier
  candles = candles.filter((c) => !c.gap);
  if (candles.length < MIN_MIN) candles = all.slice(Math.max(0, all.length - hardCap));
  if (candles.length < MIN_MIN) return res.status(404).send("too_few_candles");

  // y-scale
  let minL = Infinity;
  let maxH = -Infinity;
  for (const c of candles) {
    if (Number.isFinite(c.low)) minL = Math.min(minL, c.low);
    if (Number.isFinite(c.high)) maxH = Math.max(maxH, c.high);
  }
  if (!Number.isFinite(minL) || !Number.isFinite(maxH) || minL === maxH) {
    minL = Number.isFinite(minL) ? minL - 1 : 0;
    maxH = Number.isFinite(maxH) ? maxH + 1 : 1;
  }
  const range = maxH - minL;
  const pad = Math.max(range * 0.03, maxH * 0.0005);
  const yMin = minL - pad;
  const yMax = maxH + pad;

  // QuickChart/Chart.js time-scale renders in UTC/local. To force MT5 server-time labels,
  // we render the X axis as category labels ourselves.
  const longLabels =
    (spanMs != null && Number.isFinite(spanMs) && spanMs >= 24 * 60 * 60 * 1000) ||
    (chosenIntervalMs != null && Number.isFinite(chosenIntervalMs) && candles.length * chosenIntervalMs >= 24 * 60 * 60 * 1000);

  const labels = candles.map((c) => {
    const ms = Date.parse(c.start);
    const mt5 = Number.isFinite(ms) ? formatMt5(ms) : String(c.start);

    // HH:MM for short ranges; include MM-DD for multi-day charts to prevent duplicate category labels.
    if (!mt5 || String(mt5).length < 16) return String(c.start);
    return longLabels ? String(mt5).slice(5, 16) : String(mt5).slice(11, 16);
  });

  const data = candles.map((c, i) => ({
    x: labels[i],
    o: c.open,
    h: c.high,
    l: c.low,
    c: c.close,
  }));

  // Optional horizontal levels for trade visualization
  const entry = req.query.entry != null ? Number(req.query.entry) : NaN;
  const sl = req.query.sl != null ? Number(req.query.sl) : NaN;
  const tps = String(req.query.tp || "")
    .split(",")
    .map((x) => Number(String(x).trim()))
    .filter((n) => Number.isFinite(n));

  const levelDatasets = [];
  const fmt = (n) => {
    if (!Number.isFinite(n)) return "";
    // keep 2 decimals max, trim trailing zeros
    const s = Number(n).toFixed(2);
    return s.replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
  };

  const mkLine = (y, label, color, dash) => ({
    type: "line",
    label,
    data: labels.map((x) => ({ x, y })),
    borderColor: color,
    borderWidth: 3,
    borderDash: Array.isArray(dash) ? dash : undefined,
    pointRadius: 0,
    tension: 0,
    fill: false,
  });

  // Standard colors:
  // - SL = red
  // - TPs = blue
  // - Entry = grey
  // TV-like colors for levels (include price in label for clarity)
  if (Number.isFinite(entry)) levelDatasets.push(mkLine(entry, `ENTRY ${fmt(entry)}`, "rgba(255,255,255,0.55)", [6, 6]));
  if (Number.isFinite(sl)) levelDatasets.push(mkLine(sl, `SL ${fmt(sl)}`, "#f23645"));
  tps.forEach((tp, i) => levelDatasets.push(mkLine(tp, `TP${i + 1} ${fmt(tp)}`, "#2962ff")));

  // Hard default size tuned for Telegram chat rendering (largest perceived size).
  // Landscape fills the message bubble better than tall portrait.
  const width = 1280;
  const height = 720;

  const qc = {
    version: "3",
    backgroundColor: "#000000",
    width,
    height,
    format,
    chart: {
      type: "candlestick",
      data: {
        labels,
        datasets: [
          {
            // keep label simple for internal tooltip calculations; legend hides this dataset
            label: "price",
            data,

            // Force green/red in QuickChart builds that ignore `color:{up/down}`
            backgroundColor: {
              // TradingView-like teal/red
              up: "rgba(0,188,212,0.95)",
              down: "rgba(244,67,54,0.95)",
              unchanged: "rgba(163,167,177,0.7)",
            },
            borderColor: {
              up: "rgba(0,188,212,1)",
              down: "rgba(244,67,54,1)",
              unchanged: "rgba(163,167,177,0.7)",
            },
            borderWidth: 1,
          },
          ...levelDatasets,
        ],
      },
      options: {
        responsive: false,
        animation: false,
        plugins: {
          title: {
            display: true,
            text: `${symbol} • ${chosenInterval}${spanMs ? ` • ${Math.round(spanMs / 3600000)}h` : ""} • MT5`,
            color: "rgba(255,255,255,0.98)",
            align: "center",
            font: { size: 30, weight: "900" },
            padding: { top: 16, bottom: 12 },
          },
          legend: {
            display: true,
            position: "top",
            align: "center",
            labels: {
              color: "rgba(255,255,255,0.95)",
              boxWidth: 18,
              boxHeight: 14,
              padding: 18,
              font: { size: 18, weight: "800" },
              // Keep legend clean: show only ENTRY/SL/TP*
              filter: (item) => item.datasetIndex !== 0,
            },
          },
          tooltip: {
            enabled: true,
            backgroundColor: "rgba(11,18,32,0.95)",
            titleColor: "#e5e7eb",
            bodyColor: "#e5e7eb",
            borderColor: "rgba(42,46,57,1)",
            borderWidth: 1,
            displayColors: false,
          },
        },
        layout: { padding: { left: 10, right: 18, top: 10, bottom: 8 } },
        scales: {
          x: {
            type: "category",
            grid: { color: "rgba(255,255,255,0.04)", drawBorder: false },
            ticks: { color: "rgba(255,255,255,0.65)", maxRotation: 0, autoSkip: true, autoSkipPadding: 22 },
          },
          y: {
            // Force tight autoscale (TradingView-like zoom)
            min: yMin,
            max: yMax,
            position: "right",
            grid: { color: "rgba(255,255,255,0.04)", drawBorder: false },
            ticks: { color: "rgba(255,255,255,0.65)", padding: 8 },
          },
        },
      },
    },
  };

  const mime = format === "jpg" ? "image/jpeg" : "image/png";
  const ext = format === "jpg" ? "jpg" : "png";
  const cacheKey = `${symbol}|${chosenInterval}|${format}`;

  const r = await fetchFn("https://quickchart.io/chart", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(qc),
  });

  if (!r.ok) {
    const cached = lastChartBuf.get(cacheKey);
    if (cached?.buf) {
      setNoCacheImageHeaders(res, cached.mime, symbol, chosenInterval, ext);
      res.setHeader("X-Chart-Fallback", "1");
      res.setHeader("X-Chart-Interval-Used", chosenInterval);
      res.setHeader("X-Chart-Quality", quality);
      res.setHeader("X-Chart-Count", String(candles.length));
      return res.end(cached.buf);
    }
    return res.status(502).send("chart_failed");
  }

  const buf = Buffer.from(await r.arrayBuffer());
  lastChartBuf.set(cacheKey, { buf, tsMs: Date.now(), mime });

  setNoCacheImageHeaders(res, mime, symbol, chosenInterval, ext);
  res.setHeader("X-Chart-Fallback", "0");
  res.setHeader("X-Chart-Interval-Used", chosenInterval);
  res.setHeader("X-Chart-Quality", quality);
  res.setHeader("X-Chart-Count", String(candles.length));
  return res.end(buf);
}

app.get("/chart.png", async (req, res) => {
  try {
    return await renderChart(req, res, "png");
  } catch {
    return res.status(500).send("error");
  }
});

app.get("/chart.jpg", async (req, res) => {
  try {
    return await renderChart(req, res, "jpg");
  } catch {
    return res.status(500).send("error");
  }
});

// Helper: returns a ready-to-send Telegram photo URL + caption (no need to paste the URL in chat)
// Default interval is 1m for signal visibility on Telegram screenshots.
app.get("/chartshare", (req, res) => {
  const symbol = req.query.symbol ? String(req.query.symbol) : "XAUUSD";
  const interval = req.query.interval ? String(req.query.interval) : "1m";
  const limit = req.query.limit ? Number(req.query.limit) : 80;
  const hours = req.query.hours != null ? Number(req.query.hours) : null;

  const entry = req.query.entry != null ? String(req.query.entry) : null;
  const sl = req.query.sl != null ? String(req.query.sl) : null;
  const tp = req.query.tp != null ? String(req.query.tp) : null;

  const t = Date.now();

  const u = new URL("https://flexbot-qpf2.onrender.com/chart.png");
  u.searchParams.set("symbol", symbol);
  if (hours && Number.isFinite(hours) && hours > 0) u.searchParams.set("hours", String(hours));
  else {
    u.searchParams.set("interval", interval);
    u.searchParams.set("limit", String(Number.isFinite(limit) ? limit : 80));
  }

  // enforced size + cache bust
  u.searchParams.set("w", "1080");
  u.searchParams.set("h", "1200");
  u.searchParams.set("t", String(t));

  if (entry) u.searchParams.set("entry", entry);
  if (sl) u.searchParams.set("sl", sl);
  if (tp) u.searchParams.set("tp", tp);

  const caption = hours && Number.isFinite(hours) && hours > 0 ? `${symbol} chart (${hours}h)` : `${symbol} ${interval} chart`;

  return res.json({ ok: true, media: u.toString(), caption });
});

app.get("/ff/red", async (req, res) => {
  try {
    const { currency, events } = await getRedNews(req);
    return res.json({
      ok: true,
      source: "forexfactory_json",
      currency,
      tz: MT5_TZ,
      server_time: formatMt5(Date.now()),
      count: events.length,
      events,
    });
  } catch {
    return res.status(502).json({ ok: false, error: "ff_unavailable" });
  }
});

app.get("/news", async (req, res) => {
  try {
    const { currency, events } = await getRedNews(req);
    return res.json({
      ok: true,
      source: "forexfactory_json",
      currency,
      tz: MT5_TZ,
      server_time: formatMt5(Date.now()),
      count: events.length,
      events,
    });
  } catch {
    return res.status(502).json({ ok: false, error: "ff_unavailable" });
  }
});

// News blackout helper for automations
// GET /news/blackout?currency=USD&impact=high&window_min=15
app.get("/news/blackout", async (req, res) => {
  try {
    const currency = req.query.currency ? String(req.query.currency).toUpperCase() : "USD";
    const impact = req.query.impact ? String(req.query.impact).toLowerCase() : "high";
    const windowMinRaw = req.query.window_min != null ? Number(req.query.window_min) : NEWS_BLACKOUT_MIN_DEFAULT;
    const windowMin = Number.isFinite(windowMinRaw) && windowMinRaw > 0 ? windowMinRaw : NEWS_BLACKOUT_MIN_DEFAULT;

    const all = await getFfEvents();
    let events = all;
    if (impact) events = events.filter((e) => String(e.impact) === impact);
    if (currency) events = events.filter((e) => String(e.currency) === currency);

    const now = Date.now();
    const { blackout, next_event } = computeBlackout(events, now, windowMin);

    return res.json({
      ok: true,
      blackout,
      window_min: windowMin,
      currency,
      impact,
      server_time: formatMt5(now),
      now_ms: now,
      next_event,
    });
  } catch (e) {
    return res.status(502).json({ ok: false, error: "ff_unavailable" });
  }
});

app.get("/news.txt", async (req, res) => {
  try {
    const { currency, events } = await getRedNews(req);
    const text = formatNewsText(events, currency);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.send(text);
  } catch {
    return res.status(502).send("ff_unavailable");
  }
});

// ---- Telegram helpers (to remove OpenClaw/LLM from posting) ----
async function tgSendMessage({ chatId, text }) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("missing_TELEGRAM_BOT_TOKEN");
  if (!chatId) throw new Error("missing_chatId");

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const r = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });

  const bodyText = await r.text();
  let json = null;
  try {
    json = JSON.parse(bodyText);
  } catch {
    json = { ok: false, raw: bodyText };
  }
  if (!r.ok || !json?.ok) throw new Error(json?.description || `telegram_http_${r.status}`);
  return json;
}

async function tgEditMessageText({ chatId, messageId, text }) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("missing_TELEGRAM_BOT_TOKEN");
  if (!chatId) throw new Error("missing_chatId");
  if (!messageId) throw new Error("missing_messageId");

  const url = `https://api.telegram.org/bot${token}/editMessageText`;
  const r = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text }),
  });

  const bodyText = await r.text();
  let json = null;
  try {
    json = JSON.parse(bodyText);
  } catch {
    json = { ok: false, raw: bodyText };
  }

  if (!r.ok || !json?.ok) {
    // If the message is too old or can't be edited, don't hard-fail the whole close flow.
    const err = json?.description || `telegram_http_${r.status}`;
    const e = new Error(err);
    e.details = json;
    throw e;
  }

  return json;
}

// --- Telegram inbound (webhook) ---
// Minimal auto-replies in the community group (no FAQ engine).
// Configure:
// - TELEGRAM_BOT_TOKEN
// - TELEGRAM_CHAT_ID (group id, e.g. -100...)
// - PUBLIC_BASE_URL (for webhook set)
// - TELEGRAM_WEBHOOK_SECRET (recommended)
const tgReplyCooldown = new Map(); // key -> lastMs
function tgCooldownOk(key, ms) {
  const now = Date.now();
  const last = tgReplyCooldown.get(key) || 0;
  if (now - last < ms) return false;
  tgReplyCooldown.set(key, now);
  return true;
}

function isWeekendAmsterdam(tsMs = Date.now()) {
  const { weekday } = inAmsterdamParts(tsMs);
  return weekday.startsWith("za") || weekday.startsWith("zo");
}

function buildAutoReply(text) {
  const t = String(text || "").toLowerCase();
  const weekend = isWeekendAmsterdam();

  // Weekend / market closed
  if (weekend && (t.includes("knallen") || t.includes("trade") || t.includes("signaal") || t.includes("open") || t.includes("gaan we") || t.includes("vandaag"))) {
    return "De markt is dicht (weekend) — Flexbot opent nu geen nieuwe trades. Maandag zijn we terug.";
  }

  // Unlock / members
  if (t.includes("unlock") || t.includes("member") || t.includes("members") || t.includes("betaal") || t.includes("paid")) {
    return "Voor members: DM de bot met /unlock.";
  }

  // EA not trading / disconnected
  if (t.includes("disconnected") || t.includes("geen trades") || t.includes("werkt niet") || t.includes("pakte niet") || t.includes("opent niet")) {
    return "Check de EA banner + Toolbox→Experts. Als hij DISCONNECTED is: Tools→Options→EA→Allow WebRequest + BaseUrl klopt. Stuur anders een screenshot van Experts + banner.";
  }

  // Daily stop
  if (t.includes("daily stop") || t.includes("daily") || t.includes("drawdown") || t.includes("dd")) {
    return "Zie je DAILY STOP op de banner? Dan stopt Flexbot met nieuwe trades tot de volgende trading day (bescherming).";
  }

  // News (data-driven; avoids hallucinations)
  // Include both EN + NL keywords so common questions like "is er morgen nieuws?" trigger.
  if (
    t.includes("news") ||
    t.includes("nieuws") ||
    t.includes("rood") ||
    t.includes("red") ||
    t.includes("impact") ||
    t.includes("calendar") ||
    t.includes("kalender")
  ) {
    return "NEWS_CHECK";
  }

  // Myfxbook trophy case
  if (t.includes("myfxbook") || t.includes("fxbook")) {
    return "TROPHY_LIST";
  }

  // Default: no reply
  return null;
}

async function tgSetWebhook() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("missing_TELEGRAM_BOT_TOKEN");
  const secret = (process.env.TELEGRAM_WEBHOOK_SECRET || "").trim();
  const base = (process.env.PUBLIC_BASE_URL || BASE_URL).trim().replace(/\/$/, "");
  const hookPath = secret ? `/telegram/webhook/${encodeURIComponent(secret)}` : "/telegram/webhook";
  const url = `${base}${hookPath}`;

  const api = `https://api.telegram.org/bot${token}/setWebhook`;
  const r = await fetchFn(api, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const txt = await r.text();
  let json = null;
  try { json = JSON.parse(txt); } catch { json = { ok: false, raw: txt }; }
  return { httpOk: r.ok, json, url };
}

// Call once after deploy: GET /telegram/webhook/set?key=<ADMIN_KEY>
app.get("/telegram/webhook/set", async (req, res) => {
  try {
    const adminKey = (process.env.ADMIN_KEY || "").trim();
    if (adminKey && String(req.query.key || "") !== adminKey) return res.status(401).json({ ok: false, error: "unauthorized" });
    const out = await tgSetWebhook();
    return res.json({ ok: true, ...out });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

async function handleTelegramUpdate(req, res) {
  try {
    const update = req.body || {};
    const msg = update.message || update.edited_message || null;
    if (!msg) return res.json({ ok: true });

    const chatId = String(msg.chat?.id || "");
    const targetChatId = String(process.env.TELEGRAM_CHAT_ID || "");
    if (targetChatId && chatId !== targetChatId) return res.json({ ok: true });

    // ignore other bots
    if (msg.from?.is_bot) return res.json({ ok: true });

    const text = msg.text || msg.caption || "";

    const userId = String(msg.from?.id || "");
    const ownerIds = (process.env.TELEGRAM_OWNER_IDS || "8210317741,1404483922")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const isOwner = ownerIds.includes(userId);

    const t = String(text || "").toLowerCase();
    const wantsTrophy = t.includes("myfxbook") || t.includes("fxbook");

    // Determine auto-reply intent early so we can allow certain keywords without requiring a '?' (boss request)
    const auto = buildAutoReply(text);
    const wantsNews = auto === "NEWS_CHECK";

    // For the owner: reply to ANY message (still with cooldown) so it feels responsive.
    // For others: only reply to questions/mentions to avoid spam.
    // Exceptions:
    // - allow "myfxbook" keyword to return trophy list even without a question mark.
    // - allow news keywords to always trigger the formatted news reply.
    const isQuestion = String(text).includes("?");
    const mentionsFlex = /\bflexbot\b|\bflex\b/i.test(String(text));
    if (!isOwner && !wantsTrophy && !wantsNews && !isQuestion && !mentionsFlex) return res.json({ ok: true });

    // Cooldown: per-user and per-group
    if (!tgCooldownOk(`u:${userId}`, isOwner ? 30 * 1000 : 10 * 60 * 1000)) return res.json({ ok: true });
    if (!tgCooldownOk(`g:${chatId}`, 2 * 60 * 1000)) return res.json({ ok: true });

    let reply = auto || (isOwner ? "Yo" : null);
    if (!reply) return res.json({ ok: true });

    // Trophy case (Myfxbook)
    if (reply === "TROPHY_LIST") {
      try {
        const dir = path.join(__dirname, "state");
        const fp = path.join(dir, "trophies.json");
        let trophies = [];
        try {
          const raw = fs.readFileSync(fp, "utf8");
          const json = JSON.parse(raw);
          trophies = Array.isArray(json?.trophies) ? json.trophies : [];
        } catch {
          trophies = [];
        }

        // Seed with env default if empty
        if (!trophies.length) {
          trophies = [
            {
              title: "FTMO 100K — Phase ✅",
              url: "https://www.myfxbook.com/members/FlexbotAI/flexbot-ftmo-100k-challenge-phase/11935332",
            },
          ];
        }

        const max = 10;
        const lines = ["🏛 FLEXBOT TROPHY CASE (Myfxbook)"];
        trophies.slice(0, max).forEach((x, i) => {
          const title = String(x?.title || `Challenge #${i + 1}`).trim();
          const url = String(x?.url || "").trim().replace(/>+$/, "");
          if (!url) return;
          lines.push(`${i + 1}) ${title}`);
          lines.push(`<${url}>`);
        });
        const caption = lines.join("\n");

        // Send as photo with caption
        const bannerPath = path.join(__dirname, "assets", "trophy_banner.png");
        const buf = fs.existsSync(bannerPath) ? fs.readFileSync(bannerPath) : null;
        if (buf) {
          await tgSendPhoto({ chatId, photo: buf, caption });
          return res.json({ ok: true });
        }

        // Fallback: text only
        await tgSendMessage({ chatId, text: caption });
        return res.json({ ok: true });
      } catch {
        await tgSendMessage({ chatId, text: "Myfxbook lijst is nu even niet beschikbaar." });
        return res.json({ ok: true });
      }
    }

    // Owner commands: /trophy add <url> | <title>
    if (isOwner && /^\/trophy\b/i.test(String(text || "").trim())) {
      const raw = String(text || "").trim();
      const mAdd = raw.match(/^\/trophy\s+add\s+([^\s|]+)\s*(?:\|\s*(.+))?$/i);
      const mList = raw.match(/^\/trophy\s+list\b/i);
      if (mAdd) {
        const url = String(mAdd[1] || "").trim().replace(/>+$/, "");
        const title = String(mAdd[2] || "Challenge ✅").trim();
        if (!url.startsWith("http")) {
          await tgSendMessage({ chatId, text: "Gebruik: /trophy add <link> | <titel>" });
          return res.json({ ok: true });
        }
        const dir = path.join(__dirname, "state");
        const fp = path.join(dir, "trophies.json");
        try { fs.mkdirSync(dir, { recursive: true }); } catch {}
        let trophies = [];
        try {
          const raw2 = fs.readFileSync(fp, "utf8");
          const json = JSON.parse(raw2);
          trophies = Array.isArray(json?.trophies) ? json.trophies : [];
        } catch {
          trophies = [];
        }
        trophies.unshift({ title, url });
        trophies = trophies.slice(0, 25);
        try {
          fs.writeFileSync(fp, JSON.stringify({ trophies, updatedAt: new Date().toISOString() }, null, 2), "utf8");
        } catch {}

        await tgSendMessage({ chatId, text: `✅ Added trophy: ${title}\n<${url}>` });
        return res.json({ ok: true });
      }
      if (mList) {
        const dir = path.join(__dirname, "state");
        const fp = path.join(dir, "trophies.json");
        let trophies = [];
        try {
          const raw2 = fs.readFileSync(fp, "utf8");
          const json = JSON.parse(raw2);
          trophies = Array.isArray(json?.trophies) ? json.trophies : [];
        } catch {
          trophies = [];
        }
        if (!trophies.length) {
          await tgSendMessage({ chatId, text: "Nog geen trophies opgeslagen." });
          return res.json({ ok: true });
        }
        const lines = ["🏛 Trophy list:"];
        trophies.slice(0, 20).forEach((x, i) => {
          const title = String(x?.title || `#${i + 1}`).trim();
          const url = String(x?.url || "").trim();
          lines.push(`${i + 1}) ${title} — <${url}>`);
        });
        await tgSendMessage({ chatId, text: lines.join("\n") });
        return res.json({ ok: true });
      }
    }

    // Data-driven news reply (boss format)
    if (reply === "NEWS_CHECK") {
      try {
        const all = await getFfEvents();
        const now = Date.now();
        const curList = String(process.env.NEWS_REPLY_CURRENCIES || "USD")
          .toUpperCase()
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);

        const t = String(text || "").toLowerCase();
        const wantsTomorrow = t.includes("morgen") || t.includes("tomorrow") || t.includes("tmr");

        const fmtDayLabel = (tsMs) => {
          // Example: Vrijdag (vr 20 feb)
          const d = new Date(tsMs);
          const full = new Intl.DateTimeFormat("nl-NL", { timeZone: "Europe/Amsterdam", weekday: "long" }).format(d);
          const wd = new Intl.DateTimeFormat("nl-NL", { timeZone: "Europe/Amsterdam", weekday: "short" }).format(d);
          const day = new Intl.DateTimeFormat("nl-NL", { timeZone: "Europe/Amsterdam", day: "2-digit" }).format(d);
          const mon = new Intl.DateTimeFormat("nl-NL", { timeZone: "Europe/Amsterdam", month: "short" }).format(d).replace(".", "");
          const cap = full.charAt(0).toUpperCase() + full.slice(1);
          return `${cap} (${wd} ${day} ${mon})`;
        };

        // YYYY-MM-DD bucket for Europe/Amsterdam
        const amsYmd = (tsMs) => {
          const parts = new Intl.DateTimeFormat("en-CA", {
            timeZone: "Europe/Amsterdam",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).formatToParts(new Date(tsMs));
          const get = (k) => parts.find((p) => p.type === k)?.value;
          return `${get("year")}-${get("month")}-${get("day")}`;
        };

        const ymdToday = amsYmd(now);
        const ymdTomorrow = amsYmd(now + 24 * 60 * 60 * 1000);

        const hi = all
          .filter((e) => String(e.impact) === "high")
          .filter((e) => (curList.length ? curList.includes(String(e.currency || "").toUpperCase()) : true))
          .filter((e) => Number.isFinite(e.ts))
          .sort((a, b) => a.ts - b.ts);

        let ymdPick = wantsTomorrow ? ymdTomorrow : ymdToday;

        // If user didn't explicitly ask tomorrow, but today has no upcoming HIGH events, fall forward to tomorrow.
        if (!wantsTomorrow) {
          const todayUpcoming = hi.filter((e) => amsYmd(e.ts) === ymdToday && e.ts >= now);
          if (!todayUpcoming.length) ymdPick = ymdTomorrow;
        }

        const list = hi
          .filter((e) => amsYmd(e.ts) === ymdPick)
          .filter((e) => wantsTomorrow ? true : (e.ts >= now - 5 * 60 * 1000))
          .slice(0, 12);

        if (!list.length) {
          reply = `${fmtDayLabel(now)} Geen 🟥 HIGH news voor ${curList.join(", ")} volgens de feed.`;
        } else {
          const dayLabel = fmtDayLabel(list[0].ts);

          // Combine same-time events into "A + B + C"
          const byTime = new Map();
          for (const e of list) {
            const time = String(e.mt5_time || "?").trim();
            const cur = String(e.currency || "").toUpperCase().trim();
            const title = String(e.title || e.event || "").trim();
            const key = `${time}__${cur}`;
            const prev = byTime.get(key);
            if (!prev) byTime.set(key, { time, cur, titles: [title].filter(Boolean) });
            else prev.titles.push(title);
          }

          const parts = [dayLabel];
          for (const v of byTime.values()) {
            const joined = v.titles.join(" + ");
            parts.push(`🟥 ${v.time} ${joined} (${v.cur || curList[0] || "USD"})`);
          }
          reply = parts.join(" ");
        }
      } catch {
        reply = "Kon news feed niet lezen (tijdelijk).";
      }
    }

    await tgSendMessage({ chatId, text: reply });
    return res.json({ ok: true });
  } catch (e) {
    // Always ack webhook to avoid Telegram retry storms
    return res.json({ ok: true, error: String(e?.message || e) });
  }
}

app.post("/telegram/webhook", express.json({ limit: "1mb" }), handleTelegramUpdate);
app.post("/telegram/webhook/:secret", express.json({ limit: "1mb" }), (req, res) => {
  const secret = String(req.params.secret || "");
  const expected = (process.env.TELEGRAM_WEBHOOK_SECRET || "").trim();
  if (expected && secret !== expected) return res.status(401).json({ ok: false });
  return handleTelegramUpdate(req, res);
});

// Cache voor supportvragen
const supportCache = new Map();

async function supportAnswerSupportQuestion(question) {
  if(supportCache.has(question)) {
    return supportCache.get(question);
  }
  // Vraag GPT indien niet in cache.
  const answer = await fetchFn(`https://api.openai.com/v1/chat/completions`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "openai/gpt-5.2",
      messages: [{ role: "user", content: question }],
      max_tokens: 60,
    }),
  });
  const text = answer?.choices?.[0]?.message?.content || "(Geen antwoord)";
  supportCache.set(question, text);
  return text;
}

// Gebruik supportAnswerSupportQuestion(question) in je support handler

async function tgSendPhoto({ chatId, photo, caption }) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("missing_TELEGRAM_BOT_TOKEN");
  if (!chatId) throw new Error("missing_chatId");

  const url = `https://api.telegram.org/bot${token}/sendPhoto`;

  // Telegram sendPhoto supports:
  // - photo as file_id / URL (JSON)
  // - photo as multipart/form-data upload (Buffer/Uint8Array)
  const isBinary =
    (typeof Buffer !== "undefined" && Buffer.isBuffer(photo)) ||
    photo instanceof Uint8Array;

  let r;
  if (isBinary) {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    if (caption) form.append("caption", String(caption));

    const buf = Buffer.isBuffer(photo) ? photo : Buffer.from(photo);
    const blob = new Blob([buf], { type: "image/png" });
    form.append("photo", blob, "closed.png");

    r = await fetchFn(url, { method: "POST", body: form });
  } else {
    r = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, photo, caption }),
    });
  }

  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { ok: false, raw: text };
  }

  if (!r.ok || !json?.ok) {
    const err = json?.description || json?.error || `telegram_http_${r.status}`;
    const e = new Error(err);
    e.details = json;
    throw e;
  }

  return json;
}

async function tgSendVideo({ chatId, video, caption }) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("missing_TELEGRAM_BOT_TOKEN");
  if (!chatId) throw new Error("missing_chatId");

  const url = `https://api.telegram.org/bot${token}/sendVideo`;

  // Telegram sendVideo supports:
  // - video as file_id / URL (JSON)
  // - video as multipart/form-data upload (Buffer/Uint8Array)
  const isBinary =
    (typeof Buffer !== "undefined" && Buffer.isBuffer(video)) ||
    video instanceof Uint8Array;

  let r;
  if (isBinary) {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    if (caption) form.append("caption", String(caption));

    const buf = Buffer.isBuffer(video) ? video : Buffer.from(video);
    const blob = new Blob([buf], { type: "video/mp4" });
    form.append("video", blob, "streak_tp2.mp4");

    r = await fetchFn(url, { method: "POST", body: form });
  } else {
    r = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, video, caption }),
    });
  }

  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { ok: false, raw: text };
  }

  if (!r.ok || !json?.ok) {
    const err = json?.description || json?.error || `telegram_http_${r.status}`;
    const e = new Error(err);
    e.details = json;
    throw e;
  }

  return json;
}

async function fetchJson(url) {
  const r = await fetchFn(url);
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`http_${r.status}: ${text}`);
  }
  return r.json();
}

function formatSignalCaption({ id, symbol, direction, riskPct, comment }) {
  const riskStr = String(riskPct);

  const sym = String(symbol || "").toUpperCase();
  const dir = String(direction || "").toUpperCase();

  // Public group teaser caption (NO entry/SL/TP)
  const kind = String(comment || "").toLowerCase().includes("scalp") ? "SCALP" : "SETUP";

  const ref = String(id || "");
  const shortRef = ref ? ref.slice(-8) : "";

  return (
    `🚨 LIVE SIGNAL OPEN${shortRef ? ` (Ref ${shortRef})` : ""}\n` +
    `${kind}: ${sym} ${dir}\n` +
    `\n` +
    `Full entry/SL/TP + updates = MEMBERS ONLY\n` +
    `➡️ DM de bot: /unlock\n` +
    `\n` +
    `💰 Risk: ${riskStr}%\n` +
    `❗ Not Financial Advice.`
  );
}

// Mascot variants
// - WIN: random pick from assets/mascot_win*.(png|jpg|jpeg|webp)
// - LOSS: random pick from assets/mascot_loss*.(png|jpg|jpeg|webp)
// - Fallback: assets/mascot.jpg (legacy)
let _mascotCache = null;
function _guessMimeByExt(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  return "application/octet-stream";
}
function _loadMascotCache() {
  if (_mascotCache) return _mascotCache;
  const dir = path.join(__dirname, "assets");
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    files = [];
  }

  const isImage = (f) => /\.(png|jpg|jpeg|webp)$/i.test(f);
  const isTransparentPreferred = (f) => /\.(png|webp)$/i.test(f);

  // Prefer transparent formats (png/webp). Only fall back to jpg/jpeg if no transparent variants exist.
  // Keep ordering stable so round-robin rotation is deterministic.
  // Boss: use the new "custom" win set if present.
  let win = files.filter((f) => isImage(f) && /^mascot_win/i.test(f));
  const winCustom = win.filter((f) => /^mascot_win_custom/i.test(f));
  if (winCustom.length) win = winCustom;
  const winT = win.filter(isTransparentPreferred);
  if (winT.length) win = winT;
  win = win.map((f) => path.join(dir, f)).sort((a, b) => a.localeCompare(b));

  let loss = files.filter((f) => isImage(f) && /^mascot_loss/i.test(f));
  const lossT = loss.filter(isTransparentPreferred);
  if (lossT.length) loss = lossT;
  loss = loss.map((f) => path.join(dir, f)).sort((a, b) => a.localeCompare(b));
  const legacyPng = path.join(dir, "mascot.png");
  const legacyJpg = path.join(dir, "mascot.jpg");

  // Optional: if present, ALWAYS use this transparent loss mascot on losses
  // (Boss request: always show the astronaut overlay on loss cards)
  const forceLossPng = path.join(dir, "mascot_loss_force.png");

  _mascotCache = { win, loss, legacyPng, legacyJpg, forceLossPng };
  return _mascotCache;
}
let _lastMascotPick = { win: null, loss: null };

// Round-robin mascot rotation (WIN only), persisted in /state so it survives restarts.
function _mascotRrStatePath(key) {
  return path.join(__dirname, "state", `mascot-rr-${String(key || "default")}.json`);
}
function _pickRoundRobin(pool, key) {
  if (!Array.isArray(pool) || pool.length === 0) return null;

  const fp = _mascotRrStatePath(key);
  const poolSig = pool.map((p) => path.basename(p)).join("|");
  const st = readJsonFileSafe(fp, { idx: 0, last: null, poolSig: "", updatedAtMs: 0 });

  let idx = Number(st?.idx);
  if (!Number.isFinite(idx)) idx = 0;

  // If the pool changed (added/removed/reordered), keep the index in-range.
  if (st?.poolSig !== poolSig) idx = idx % pool.length;

  idx = ((idx % pool.length) + pool.length) % pool.length;
  let chosen = pool[idx];

  // Extra safety: avoid consecutive repeats even if pool changes.
  if (pool.length > 1 && st?.last && chosen === st.last) {
    idx = (idx + 1) % pool.length;
    chosen = pool[idx];
  }

  const next = {
    idx: pool.length > 0 ? ((idx + 1) % pool.length) : 0,
    last: chosen,
    poolSig,
    updatedAtMs: Date.now(),
  };
  writeJsonFileSafe(fp, next);

  return chosen;
}

function getMascotPick({ outcome, result }) {
  const cache = _loadMascotCache();

  // Determine win/loss using the same logic as the card colors
  const outcomeStr = String(outcome || "").toLowerCase();
  const resultStr = String(result || "").trim();
  const isWin = outcomeStr.includes("tp") || (resultStr && !resultStr.startsWith("-"));

  // Boss request: always use the dedicated loss overlay if it exists.
  if (!isWin && cache.forceLossPng && fs.existsSync(cache.forceLossPng)) {
    try {
      const buf = fs.readFileSync(cache.forceLossPng);
      const mime = _guessMimeByExt(cache.forceLossPng);
      return { dataUri: `data:${mime};base64,${buf.toString("base64")}`, filePath: cache.forceLossPng, fileName: path.basename(cache.forceLossPng), isWin };
    } catch {
      // fall through to normal pool
    }
  }

  let pool = isWin ? cache.win : cache.loss;
  const key = isWin ? "win" : "loss";

  if (!pool || pool.length === 0) {
    // Fallback to legacy mascot.png (preferred, supports transparency), else mascot.jpg
    const fb = fs.existsSync(cache.legacyPng) ? cache.legacyPng : cache.legacyJpg;
    pool = [fb];
  }

  let chosen = pool[0];
  try {
    if (pool.length <= 1) {
      chosen = pool[0];
    } else if (isWin) {
      // Boss request: WIN mascot must rotate round-robin (no random, no repeats).
      const rr = _pickRoundRobin(pool, "win");
      chosen = rr || pool[0];
    } else {
      // Loss: keep random, but avoid repeating the same image twice in a row.
      const last = _lastMascotPick[key];
      let attempt = 0;
      do {
        chosen = pool[crypto.randomInt(0, pool.length)];
        attempt++;
      } while (chosen === last && attempt < 6);
      _lastMascotPick[key] = chosen;
    }
  } catch {
    chosen = pool[0];
  }

  try {
    const buf = fs.readFileSync(chosen);
    const mime = _guessMimeByExt(chosen);
    return { dataUri: `data:${mime};base64,${buf.toString("base64")}`, filePath: chosen, fileName: path.basename(chosen), isWin };
  } catch {
    return { dataUri: null, filePath: null, fileName: null, isWin };
  }
}

// Back-compat helper
function getMascotDataUri({ outcome, result }) {
  return getMascotPick({ outcome, result })?.dataUri || null;
}

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function fitFontByChars(text, base, min, targetChars) {
  const len = String(text || "").length;
  if (len <= targetChars) return base;
  const ratio = targetChars / Math.max(1, len);
  return clamp(Math.floor(base * ratio), min, base);
}
function chunkString(s, n) {
  const str = String(s || "");
  const out = [];
  for (let i = 0; i < str.length; i += n) out.push(str.slice(i, i + n));
  return out;
}

function fmtTsISO(ts = new Date()) { return ts.toISOString().slice(0, 19).replace("T", " "); }

function createClosedCardSvgV1({ id, symbol, direction, outcome, result, entry, sl, tp }) {
  const W = 1080;
  const H = 1080;

  const sym = String(symbol || "").toUpperCase();
  const dir = String(direction || "").toUpperCase();

  const tpList = Array.isArray(tp) ? tp : [];
  const tp1 = tpList.length ? tpList[0] : null;

  const outcomeStr = outcome || "-";
  const resultStr = result || "-";

  const isTp = String(outcomeStr).toLowerCase().includes("tp");
  const isSl = String(outcomeStr).toLowerCase().includes("sl");

  const accent = "#7c3aed";
  const outcomeColor = isTp ? "#22c55e" : (isSl ? "#ff4d4d" : "#f59e0b");

  // Match the reference: positive numbers show without '+'
  const rawNum = Number(String(resultStr).replace(/[^0-9.+-]/g, ""));
  const prettyNum = Number.isFinite(rawNum) ? Math.abs(rawNum).toFixed(2) : null;
  // Keep original reference format: big result lives inside the levels panel
  const resultBig = prettyNum ? `${prettyNum} USD` : String(resultStr);
  const resultBigFont = fitFontByChars(resultBig, 66, 46, 12);
  const resultColor = (String(resultStr).trim().startsWith("-") || isSl) ? "#ff4d4d" : "#22c55e";

  // Full-body mascot (best effort: we reuse the existing mascot data uri)
  const mascotDataUri = getMascotDataUri({ outcome: outcomeStr, result: resultStr });

  const ref8 = String(id || "").slice(-8);
  const ts = new Date().toISOString().slice(0, 19).replace("T", " ");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#06010f"/>
    <stop offset="0.55" stop-color="#13052a"/>
    <stop offset="1" stop-color="#040006"/>
  </linearGradient>

  <radialGradient id="nebula" cx="55%" cy="35%" r="75%">
    <stop offset="0" stop-color="#a855f7" stop-opacity="0.35"/>
    <stop offset="0.45" stop-color="#7c3aed" stop-opacity="0.22"/>
    <stop offset="1" stop-color="#000" stop-opacity="0"/>
  </radialGradient>

  <radialGradient id="ring" cx="50%" cy="50%" r="60%">
    <stop offset="0" stop-color="#c084fc" stop-opacity="0.15"/>
    <stop offset="0.7" stop-color="#7c3aed" stop-opacity="0.65"/>
    <stop offset="1" stop-color="#7c3aed" stop-opacity="0"/>
  </radialGradient>

  <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%">
    <feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#000" flood-opacity="0.65"/>
  </filter>

  <filter id="softGlow" x="-50%" y="-50%" width="200%" height="200%">
    <feGaussianBlur stdDeviation="10" result="b"/>
    <feColorMatrix in="b" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 0.38 0" result="g"/>
    <feMerge><feMergeNode in="g"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>

  <linearGradient id="panel" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="rgba(255,255,255,0.06)"/>
    <stop offset="1" stop-color="rgba(255,255,255,0.03)"/>
  </linearGradient>
</defs>

<!-- Background -->
<rect width="${W}" height="${H}" fill="url(#bg)"/>
<rect width="${W}" height="${H}" fill="url(#nebula)"/>

<!-- Outer frame -->
<rect x="42" y="42" width="996" height="996" rx="54" fill="rgba(255,255,255,0.02)" stroke="rgba(255,255,255,0.14)" stroke-width="2"/>

<!-- Header strip (TRADE CLOSED) -->
<path d="M140 88 H940 L900 128 H180 Z" fill="rgba(124,58,237,0.14)" stroke="rgba(124,58,237,0.35)" stroke-width="2"/>
<text x="540" y="118" text-anchor="middle" font-family="Inter,Segoe UI,Arial" font-size="38" fill="rgba(255,255,255,0.82)" letter-spacing="6">TRADE CLOSED</text>

<!-- Left ring -->
<circle cx="310" cy="500" r="265" fill="url(#ring)"/>
<circle cx="310" cy="500" r="240" fill="rgba(124,58,237,0.12)" stroke="rgba(192,132,252,0.55)" stroke-width="6"/>

<!-- Mascot (full body best-effort) -->
${mascotDataUri ? `<g filter="url(#shadow)">
  <image x="130" y="260" width="360" height="520" href="${mascotDataUri}" preserveAspectRatio="xMidYMid meet"/>
</g>` : ``}

<!-- Right titles -->
<text x="560" y="245" font-family="Inter,Segoe UI,Arial" font-size="30" fill="rgba(255,255,255,0.70)" letter-spacing="4">FLEXBOT</text>
<text x="560" y="300" font-family="Inter,Segoe UI,Arial" font-size="42" fill="#fff" font-weight="800">${sym} ${dir}</text>
<text x="560" y="350" font-family="Inter,Segoe UI,Arial" font-size="30" fill="rgba(255,255,255,0.70)">Outcome: <tspan fill="${outcomeColor}" font-weight="800">${outcomeStr}</tspan></text>

<!-- Big result (inside the levels panel, like reference) -->

<!-- Levels panel -->
<g filter="url(#shadow)">
  <rect x="560" y="430" width="440" height="400" rx="26" fill="url(#panel)" stroke="rgba(255,255,255,0.14)"/>

  <line x1="560" y1="520" x2="1000" y2="520" stroke="rgba(255,255,255,0.10)"/>
  <line x1="560" y1="610" x2="1000" y2="610" stroke="rgba(255,255,255,0.10)"/>
  <line x1="560" y1="700" x2="1000" y2="700" stroke="rgba(255,255,255,0.10)"/>

  <text x="610" y="495" font-family="Inter,Segoe UI,Arial" font-size="34" fill="rgba(255,255,255,0.70)">Entry</text>
  <text x="970" y="495" text-anchor="end" font-family="Inter,Segoe UI,Arial" font-size="34" fill="#fff" font-weight="800">${entry ?? "market"}</text>

  <text x="610" y="585" font-family="Inter,Segoe UI,Arial" font-size="34" fill="rgba(255,255,255,0.70)">SL</text>
  <text x="970" y="585" text-anchor="end" font-family="Inter,Segoe UI,Arial" font-size="34" fill="#fff" font-weight="800">${sl ?? "-"}</text>

  <text x="610" y="675" font-family="Inter,Segoe UI,Arial" font-size="34" fill="rgba(255,255,255,0.70)">TP</text>
  <text x="970" y="675" text-anchor="end" font-family="Inter,Segoe UI,Arial" font-size="34" fill="#fff" font-weight="800">${tp1 ?? "-"}</text>

  <text x="600" y="790" font-family="Inter,Segoe UI,Arial" font-size="${resultBigFont}" fill="${resultColor}" font-weight="900" filter="url(#softGlow)" textLength="340" lengthAdjust="spacingAndGlyphs">${resultBig}</text>
</g>

<!-- Footer -->
<text x="110" y="1008" font-family="Inter,Segoe UI,Arial" font-size="20" fill="rgba(255,255,255,0.55)">Ref  ${ref8}</text>
</svg>`;
}

// V3 card (premium refresh)
function createClosedCardSvgV3({ id, symbol, direction, outcome, result, entry, sl, tp }) {
  const fmtLevel = (v) => {
    if (v == null) return "-";
    if (typeof v === "string") return v;
    const n = Number(v);
    if (!Number.isFinite(n)) return "-";
    // XAUUSD formatting: 2 decimals.
    return n.toFixed(2);
  };
  // Premium Glass V4 (clean, minimal)
  const W = 1080;
  const H = 1080;

  // Optional: use Boss-provided LOSS template background (exact look)
  const lossTplPath = path.join(__dirname, "assets", "loss_card_template.png");
  const lossTplDataUri = (() => {
    try {
      if (!fs.existsSync(lossTplPath)) return null;
      const buf = fs.readFileSync(lossTplPath);
      return `data:image/png;base64,${buf.toString("base64")}`;
    } catch {
      return null;
    }
  })();

  const sym = String(symbol || "").toUpperCase();
  const dir = String(direction || "").toUpperCase();

  const tpList = Array.isArray(tp) ? tp : [];
  const tp1 = tpList.length ? tpList[0] : (tp ?? null);

  const outcomeStr = outcome || "-";
  const resultStr = result || "-";

  const isTp = String(outcomeStr).toLowerCase().includes("tp");
  const isSl = String(outcomeStr).toLowerCase().includes("sl");
  const outcomeColor = isTp ? "#22c55e" : (isSl ? "#ff4d4d" : "#f59e0b");

  // If it's a LOSS and we have the exact template, render on top of it.
  if (isSl && lossTplDataUri) {
    const panelValX = 930;
    const ref8t = (String(id || "").slice(-8) || "--------");
    const entryStr = entry === "market" ? "market" : fmtLevel(entry);
    const slStr = fmtLevel(sl);
    const tpStr = fmtLevel(tp1);

    // IMPORTANT: template already contains FLEXBOT / XAUUSD BUY / Outcome text.
    // So we do NOT redraw them (avoids double text like "XAUUSDBUYY").
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <image x="0" y="0" width="${W}" height="${H}" href="${lossTplDataUri}"/>

  <!-- Dynamic panel values (right) -->
  <text x="${panelValX}" y="314" text-anchor="end" font-family="Inter,Segoe UI,Arial" font-size="34" fill="#fff" font-weight="900">${entryStr}</text>
  <text x="${panelValX}" y="424" text-anchor="end" font-family="Inter,Segoe UI,Arial" font-size="34" fill="#fff" font-weight="900">${slStr}</text>
  <text x="${panelValX}" y="534" text-anchor="end" font-family="Inter,Segoe UI,Arial" font-size="34" fill="#fff" font-weight="900">${tpStr}</text>

  <!-- Ref -->
  <rect x="720" y="985" width="360" height="110" rx="16" fill="rgba(0,0,0,0.92)"/>
  <text x="${W - 56}" y="1052" text-anchor="end" font-family="Inter,Segoe UI,Arial" font-size="18" fill="rgba(255,255,255,0.55)">Ref ${ref8t}</text>
</svg>`;
  }

  const rawNum = Number(String(resultStr).replace(/[^0-9.+-]/g, ""));
  const prettyNum = Number.isFinite(rawNum) ? Math.abs(rawNum).toFixed(2) : null;
  const isNeg = String(resultStr).trim().startsWith("-") || isSl;
  const pnlColor = isNeg ? "#ff4d4d" : "#22c55e";

  const resultBig = prettyNum ? `${prettyNum} USD` : String(resultStr);
  const resultBigFont = fitFontByChars(resultBig, 74, 48, 12);

  const mascotPick = getMascotPick({ outcome: outcomeStr, result: resultStr });
  const mascotDataUri = mascotPick?.dataUri || null;
  const mascotName = String(mascotPick?.fileName || "");

  const ref8 = (String(id || "").slice(-8) || "--------");
  const ts = fmtTsISO(new Date());

  // Layout constants
  const pad = 56;
  const ringCx = 300;
  const ringCy = 760;

  // Default mascot placement (fallback)
  let mascotX = -160;
  let mascotY = 400;
  let mascotW = 840;
  let mascotH = 940;

  // Per-file overrides: tweak each mascot independently (offset + scale).
  // Add entries like: "mascot_win_custom8.png": { x:-180, y:420, w:820, h:920 }
  const mascotOverrides = {
    // win
    "mascot_win_custom1.png": { x: -125, w: 900, h: 1000 },
    // Custom2: slightly smaller + boost whites.
    "mascot_win_custom2.png": { w: 800, h: 900, filter: "boost" },

    // Custom4: a bit smaller
    "mascot_win_custom4.png": { y: -80, w: 760, h: 860 },

    // Custom5: move up
    "mascot_win_custom5.png": { y: -200 },

    // Custom6: smaller
    "mascot_win_custom6.png": { x: -200, y: 360, w: 680, h: 760 },

    // Custom7: a bit more to the right + smaller
    "mascot_win_custom7.png": { x: -120, w: 700, h: 800 },
    // loss
    // Match the reference screenshot: smaller mascot bottom-left
    "mascot_loss_force.png": { x: 40, y: 520, w: 560, h: 560 },
  };
  const ov = mascotOverrides[mascotName];
  let mascotFilter = null;
  if (ov) {
    if (ov.x != null) mascotX = Number(ov.x);
    if (ov.y != null) mascotY = Number(ov.y);
    if (ov.w != null) mascotW = Number(ov.w);
    if (ov.h != null) mascotH = Number(ov.h);
    if (ov.filter != null) mascotFilter = String(ov.filter);
  }

  const mascotFilterAttr = mascotFilter === "boost" ? "url(#mascotBoost)" : null;

  // Right-side levels panel stays on the right.
  const panelX = 560;
  const panelY = 220;
  const panelW = 460;
  const panelH = 420;

  // Boss: move title block (FLEXBOT / SYMBOL DIR / Outcome) to the LEFT.
  const titleX = 110;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#000000"/>
    <stop offset="0.55" stop-color="#0b0b0d"/>
    <stop offset="1" stop-color="#000000"/>
  </linearGradient>
  <radialGradient id="glow" cx="45%" cy="35%" r="75%">
    <stop offset="0" stop-color="#d4d4d8" stop-opacity="0.10"/>
    <stop offset="0.5" stop-color="#a1a1aa" stop-opacity="0.06"/>
    <stop offset="1" stop-color="#000" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="spot" cx="30%" cy="50%" r="55%">
    <stop offset="0" stop-color="#d4d4d8" stop-opacity="0.12"/>
    <stop offset="0.55" stop-color="#a1a1aa" stop-opacity="0.06"/>
    <stop offset="1" stop-color="#000" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="glass" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="rgba(255,255,255,0.08)"/>
    <stop offset="1" stop-color="rgba(255,255,255,0.03)"/>
  </linearGradient>
  <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%">
    <feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#000" flood-opacity="0.65"/>
  </filter>
  <filter id="softGlow" x="-50%" y="-50%" width="200%" height="200%">
    <feGaussianBlur stdDeviation="10" result="b"/>
    <feColorMatrix in="b" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 0.38 0" result="g"/>
    <feMerge><feMergeNode in="g"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>

  <!-- Per-mascot tweak: slight brightness/contrast boost (used by custom2 to avoid "see-through" whites) -->
  <filter id="mascotBoost" color-interpolation-filters="sRGB">
    <feComponentTransfer>
      <feFuncR type="gamma" amplitude="1" exponent="0.92" offset="0"/>
      <feFuncG type="gamma" amplitude="1" exponent="0.92" offset="0"/>
      <feFuncB type="gamma" amplitude="1" exponent="0.92" offset="0"/>
    </feComponentTransfer>
  </filter>
</defs>

<rect width="${W}" height="${H}" fill="url(#bg)"/>
<rect width="${W}" height="${H}" fill="url(#glow)"/>
<rect x="42" y="42" width="996" height="996" rx="58" fill="rgba(255,255,255,0.02)" stroke="rgba(255,255,255,0.14)" stroke-width="2"/>

<!-- Header -->
<path d="M170 86 H910 L880 126 H200 Z" fill="rgba(255,255,255,0.06)" stroke="rgba(212,212,216,0.22)" stroke-width="2"/>
<text x="540" y="118" text-anchor="middle" font-family="Inter,Segoe UI,Arial" font-size="40" fill="rgba(255,255,255,0.86)" letter-spacing="6">TRADE CLOSED</text>

<!-- Left mascot (no ring) -->
<ellipse cx="${ringCx}" cy="${ringCy}" rx="420" ry="420" fill="url(#spot)"/>
${mascotDataUri ? `<g filter="url(#shadow)">
  <image x="${mascotX}" y="${mascotY}" width="${mascotW}" height="${mascotH}" href="${mascotDataUri}" preserveAspectRatio="xMidYMid meet" ${mascotFilterAttr ? `filter="${mascotFilterAttr}"` : ``}/>
</g>` : ``}

<!-- Title block (left) -->
<text x="${titleX}" y="250" font-family="Inter,Segoe UI,Arial" font-size="28" fill="rgba(255,255,255,0.70)" letter-spacing="5">FLEXBOT</text>
<text x="${titleX}" y="310" font-family="Inter,Segoe UI,Arial" font-size="54" fill="#fff" font-weight="900">${sym} ${dir}</text>
<text x="${titleX}" y="365" font-family="Inter,Segoe UI,Arial" font-size="32" fill="rgba(255,255,255,0.72)">Outcome: <tspan fill="${outcomeColor}" font-weight="900">${outcomeStr}</tspan></text>

<!-- Levels panel -->
<g filter="url(#shadow)">
  <rect x="${panelX}" y="${panelY}" width="${panelW}" height="${panelH}" rx="28" fill="url(#glass)" stroke="rgba(255,255,255,0.14)"/>

  <line x1="${panelX}" y1="${panelY + 95}" x2="${panelX + panelW}" y2="${panelY + 95}" stroke="rgba(255,255,255,0.10)"/>
  <line x1="${panelX}" y1="${panelY + 185}" x2="${panelX + panelW}" y2="${panelY + 185}" stroke="rgba(255,255,255,0.10)"/>
  <line x1="${panelX}" y1="${panelY + 275}" x2="${panelX + panelW}" y2="${panelY + 275}" stroke="rgba(255,255,255,0.10)"/>

  <text x="${panelX + 48}" y="${panelY + 62}" font-family="Inter,Segoe UI,Arial" font-size="34" fill="rgba(255,255,255,0.70)">Entry</text>
  <text x="${panelX + panelW - 48}" y="${panelY + 62}" text-anchor="end" font-family="Inter,Segoe UI,Arial" font-size="34" fill="#fff" font-weight="900">${entry === "market" ? "market" : fmtLevel(entry)}</text>

  <text x="${panelX + 48}" y="${panelY + 152}" font-family="Inter,Segoe UI,Arial" font-size="34" fill="rgba(255,255,255,0.70)">SL</text>
  <text x="${panelX + panelW - 48}" y="${panelY + 152}" text-anchor="end" font-family="Inter,Segoe UI,Arial" font-size="34" fill="#fff" font-weight="900">${fmtLevel(sl)}</text>

  <text x="${panelX + 48}" y="${panelY + 242}" font-family="Inter,Segoe UI,Arial" font-size="34" fill="rgba(255,255,255,0.70)">TP</text>
  <text x="${panelX + panelW - 48}" y="${panelY + 242}" text-anchor="end" font-family="Inter,Segoe UI,Arial" font-size="34" fill="#fff" font-weight="900">${fmtLevel(tp1)}</text>

  <text x="${panelX + 40}" y="${panelY + 370}" font-family="Inter,Segoe UI,Arial" font-size="${resultBigFont}" fill="${pnlColor}" font-weight="950" filter="url(#softGlow)" textLength="${panelW - 80}" lengthAdjust="spacingAndGlyphs">${resultBig}</text>
</g>

<!-- Footer (bottom-right) -->
<text x="${W - pad - 24}" y="1068" text-anchor="end" font-family="Inter,Segoe UI,Arial" font-size="16" fill="rgba(255,255,255,0.55)">Ref ${ref8}</text>
</svg>`;
}

function formatSignalClosedText({ id, symbol, direction, entry, sl, tp, outcome, result }) {
  const sym = String(symbol || "").toUpperCase();
  const dir = String(direction || "").toUpperCase();

  // Keep it compact: only show the first TP in public recap (boss request)
  const tpList = Array.isArray(tp) ? tp : [];
  const tp1 = tpList.length ? tpList[0] : null;
  const tpLine = tp1 != null ? `TP: ${tp1}` : "TP: -";

  return (
    `✅ CLOSED (#${id})\n` +
    `${sym} ${dir}\n` +
    `\n` +
    `Outcome: ${outcome || "-"}\n` +
    `Result: ${result || "-"}\n` +
    `\n` +
    `Trade was:\n` +
    `Entry: ${entry ?? "-"}\n` +
    `SL: ${sl ?? "-"}\n` +
    `${tpLine}`
  );
}

// POST /auto/scalp/run?symbol=XAUUSD
// Fully server-side: blackout + cooldown + claim + create signal + post ONE telegram photo.
async function autoScalpRunHandler(req, res) {
  try {
    const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : "XAUUSD";
    const cooldownMin = req.query.cooldown_min != null ? Number(req.query.cooldown_min) : 15;

    // Risk/strategy env
    const riskTz = String(process.env.RISK_TZ || "Europe/Prague");
    const maxDailyLossPctRaw = Number(process.env.MAX_DAILY_LOSS_PCT || 3.8);
    const maxDailyLossPct = Number.isFinite(maxDailyLossPctRaw) && maxDailyLossPctRaw > 0 ? maxDailyLossPctRaw : 3.8;
    const maxConsecLossRaw = Number(process.env.MAX_CONSEC_LOSSES || 3);
    const maxConsecLosses = Number.isFinite(maxConsecLossRaw) && maxConsecLossRaw > 0 ? Math.floor(maxConsecLossRaw) : 3;

    // 0) market close guard
    const m = marketBlockedNow();
    if (m.blocked) return res.json({ ok: true, acted: false, reason: m.reason });

    // 0b) main account open-position lock (no new signals while main has a trade open)
    const lock = await isMainAccountLocked(symbol);
    if (lock.ok && lock.locked) return res.json({ ok: true, acted: false, reason: lock.reason });

    // 1) blackout
    const blackoutR = await fetchJson(`${BASE_URL}/news/blackout?currency=USD&impact=high&window_min=30`);
    if (!blackoutR?.ok) return res.status(502).json({ ok: false, error: "blackout_check_failed" });
    if (blackoutR.blackout) return res.json({ ok: true, acted: false, reason: "blackout" });

    // 2) cooldown
    const cd = await fetchJson(`${BASE_URL}/ea/cooldown/status?symbol=${encodeURIComponent(symbol)}&cooldown_min=${encodeURIComponent(String(cooldownMin))}`);
    if (!cd?.ok) return res.status(502).json({ ok: false, error: "cooldown_status_failed" });
    if (!cd.has_last_trade) return res.json({ ok: true, acted: false, reason: "no_last_trade" });
    if (cd.remaining_ms > 0) return res.json({ ok: true, acted: false, reason: "cooldown" });

    // Use a rolling time bucket as claim key so we can retry periodically even if a prior attempt failed.
    // Cooldown gate above still prevents rapid re-entries.
    const scalpBucketMs = 5 * 60 * 1000;
    const refMs = Math.floor(Date.now() / scalpBucketMs) * scalpBucketMs;

    // 3) claim lock (once per bucket)
    const claim = await fetchJson(`${BASE_URL}/ea/auto/claim?symbol=${encodeURIComponent(symbol)}&kind=auto_scalp_v1&ref_ms=${encodeURIComponent(String(refMs))}`);
    if (!claim?.ok) return res.status(502).json({ ok: false, error: "claim_failed" });
    if (!claim.notify) return res.json({ ok: true, acted: false, reason: "claimed" });

    // 4) candles (5m)
    const candles = await fetchJson(`${BASE_URL}/candles?symbol=${encodeURIComponent(symbol)}&interval=5m&limit=120`);
    if (!candles?.ok || !Array.isArray(candles?.candles)) return res.status(502).json({ ok: false, error: "candles_failed" });
    const arr = candles.candles;
    if (arr.length < 12) return res.status(502).json({ ok: false, error: "candles_insufficient" });

    const last12 = arr.slice(-12);
    const rangeHigh = Math.max(...last12.map((c) => Number(c.high)));
    const rangeLow = Math.min(...last12.map((c) => Number(c.low)));
    const entry = Number(last12[last12.length - 1].close);

    const biasR = trendBiasFromCandles(arr, 20, 50);
    if (!biasR.ok) return res.json({ ok: true, acted: false, reason: "no_trend_bias" });
    const direction = biasR.bias;


    // Risk model: generate SL/TP for an assumed lotsize (default 1.00) so that
    // the trade risks ~1% of equity (FTMO-style), using a simple XAUUSD value model.
    // Defaults:
    // - assumed lots: 1.00
    // - USD per $1.00 move per 1.00 lot: 100 (override env XAUUSD_USD_PER_1PRICE_PER_LOT)
    // - equity source: latest EA /ea/status equity if configured and fresh; else env AUTO_SCALP_EQUITY_USD (default 100000)
    const assumedLots = 1.0;
    const usdPer1PricePerLotRaw = Number(process.env.XAUUSD_USD_PER_1PRICE_PER_LOT || 100);
    const usdPer1PricePerLot = Number.isFinite(usdPer1PricePerLotRaw) && usdPer1PricePerLotRaw > 0 ? usdPer1PricePerLotRaw : 100;

    let equityUsd = NaN;
    try {
      const db = await getDb();
      if (db) {
        const account_login = String(process.env.EA_GATE_ACCOUNT_LOGIN || "").trim();
        const server = String(process.env.EA_GATE_SERVER || "").trim();
        const magic = Number.isFinite(Number(process.env.EA_GATE_MAGIC)) ? Math.floor(Number(process.env.EA_GATE_MAGIC)) : 0;
        const maxAgeRaw = Number(process.env.EA_STATUS_MAX_AGE_MS || 0);
        const maxAgeMs = Number.isFinite(maxAgeRaw) && maxAgeRaw > 0 ? maxAgeRaw : 5 * 60 * 1000;

        if (account_login && server) {
          const rows = await db.execute({
            sql: "SELECT equity,updated_at_ms FROM ea_positions WHERE account_login=? AND server=? AND magic=? AND symbol=? LIMIT 1",
            args: [account_login, server, magic, symbol],
          });
          const r = rows.rows?.[0] || null;
          if (r && r.updated_at_ms != null) {
            const updatedAt = Number(r.updated_at_ms);
            const fresh = Number.isFinite(updatedAt) ? Date.now() - updatedAt <= maxAgeMs : false;
            const eq = r.equity != null ? Number(r.equity) : NaN;
            if (fresh && Number.isFinite(eq) && eq > 0) equityUsd = eq;
          }
        }
      }
    } catch {
      // best effort
    }

    if (!Number.isFinite(equityUsd)) {
      const eqEnv = Number(process.env.AUTO_SCALP_EQUITY_USD || 100000);
      equityUsd = Number.isFinite(eqEnv) && eqEnv > 0 ? eqEnv : 100000;
    }

    // Daily equity-loss guard (equity snapshot at 00:00 in RISK_TZ)
    const dayState = getAndUpdateDailyEquityStart({ symbol, tz: riskTz, equityUsd });
    const startEq = Number(dayState?.startEquity);
    if (Number.isFinite(startEq) && startEq > 0) {
      const ddPct = ((startEq - equityUsd) / startEq) * 100.0;
      if (Number.isFinite(ddPct) && ddPct >= maxDailyLossPct) {
        return res.json({ ok: true, acted: false, reason: "daily_loss_limit", dd_pct: Number(ddPct.toFixed(2)), max_daily_loss_pct: maxDailyLossPct });
      }
    }

    // Consecutive-loss guard (tracked from /signal/closed outcomes)
    const consec = getConsecutiveLosses({ symbol, tz: riskTz });
    const losses = Number(consec?.losses || 0);
    if (Number.isFinite(losses) && losses >= maxConsecLosses) {
      return res.json({ ok: true, acted: false, reason: "max_consecutive_losses", losses, max_consecutive_losses: maxConsecLosses });
    }

    // Risk for auto scalp signals (default 1%); also respect SIGNAL_MAX_RISK_PCT.
    const autoRiskEnv = Number(process.env.AUTO_SCALP_RISK_PCT || 1.0);
    const maxRiskEnv2 = Number(process.env.SIGNAL_MAX_RISK_PCT || 1.0);
    const maxRiskPct2 = Number.isFinite(maxRiskEnv2) && maxRiskEnv2 > 0 ? maxRiskEnv2 : 1.0;
    let riskPct2 = Number.isFinite(autoRiskEnv) && autoRiskEnv > 0 ? autoRiskEnv : 1.0;
    riskPct2 = Math.min(riskPct2, maxRiskPct2);

    // 5) validate + CLAMP: ensure SL distance is in a scalp-friendly range.
    // Goal: keep lots near ~1.00 on 100k accounts (while still using risk_pct).
    // Defaults for XAUUSD: point=0.01 (2 digits). Override via env XAUUSD_POINT.
    const pointRaw = Number(process.env.XAUUSD_POINT || 0.01);
    const point = Number.isFinite(pointRaw) && pointRaw > 0 ? pointRaw : 0.01;

    const minSlPtsRaw = req.query.min_sl_points != null ? Number(req.query.min_sl_points) : Number(process.env.AUTO_SCALP_MIN_SL_POINTS || 800);
    const maxSlPtsRaw = req.query.max_sl_points != null ? Number(req.query.max_sl_points) : Number(process.env.AUTO_SCALP_MAX_SL_POINTS || 1200);
    const minTpPtsRaw = req.query.min_tp_points != null ? Number(req.query.min_tp_points) : Number(process.env.AUTO_SCALP_MIN_TP_POINTS || 800);
    const maxRrRaw = req.query.max_rr != null ? Number(req.query.max_rr) : Number(process.env.AUTO_SCALP_MAX_RR || 2.0);

    const minSlPts = Number.isFinite(minSlPtsRaw) && minSlPtsRaw > 0 ? minSlPtsRaw : 800;
    const maxSlPts = Number.isFinite(maxSlPtsRaw) && maxSlPtsRaw > 0 ? maxSlPtsRaw : 1200;
    const minTpPts = Number.isFinite(minTpPtsRaw) && minTpPtsRaw > 0 ? minTpPtsRaw : 800;
    const maxRr = Number.isFinite(maxRrRaw) && maxRrRaw > 0 ? maxRrRaw : 2.0;

    const targetRiskUsd = equityUsd * (riskPct2 / 100.0);
    let slDist = targetRiskUsd / (usdPer1PricePerLot * assumedLots);

    // Convert to points and clamp into [minSlPts, maxSlPts]
    let slPts = slDist / point;
    if (!Number.isFinite(slPts) || slPts <= 0) return res.json({ ok: true, acted: false, reason: "bad_sl_pts", slPts });
    slPts = Math.max(minSlPts, Math.min(maxSlPts, slPts));
    slDist = slPts * point;

    const sl = direction === "SELL" ? entry + slDist : entry - slDist;
    const tp = direction === "SELL" ? entry - slDist * 1.5 : entry + slDist * 1.5;

    // Hard consistency guard (should never fail, but protects against NaNs / sign mistakes)
    if (direction === "BUY" && !(sl < entry && tp > entry)) {
      return res.json({ ok: true, acted: false, reason: "invalid_levels_buy", entry, sl, tp });
    }
    if (direction === "SELL" && !(sl > entry && tp < entry)) {
      return res.json({ ok: true, acted: false, reason: "invalid_levels_sell", entry, sl, tp });
    }

    const slDist2 = Math.abs(entry - sl);
    const tpDist = Math.abs(entry - tp);
    const slDistPts = slDist2 / point;
    const tpDistPts = tpDist / point;
    const rr = slDist2 > 0 ? tpDist / slDist2 : Infinity;

    if (tpDistPts < minTpPts) {
      return res.json({ ok: true, acted: false, reason: "tp_too_close", tpDistPts, minTpPts });
    }
    if (rr > maxRr) {
      return res.json({ ok: true, acted: false, reason: "rr_too_high", rr, maxRr });
    }

    // 6) create signal
    const token = process.env.AUTO_SIGNAL_TOKEN;
    if (!token) return res.status(500).json({ ok: false, error: "missing_AUTO_SIGNAL_TOKEN" });

    const createUrl = new URL(`${BASE_URL}/signal/auto/create`);
    createUrl.searchParams.set("token", token);
    createUrl.searchParams.set("symbol", symbol);
    createUrl.searchParams.set("direction", direction);
    createUrl.searchParams.set("sl", String(Number(sl.toFixed(3))));
    createUrl.searchParams.set("tp", String(Number(tp.toFixed(3))));
    createUrl.searchParams.set("risk_pct", String(riskPct2));
    createUrl.searchParams.set("comment", "auto_scalp");

    const created = await fetchJson(createUrl.toString());
    if (!created?.ok) return res.status(502).json({ ok: false, error: "signal_create_failed", details: created });

    // 7) Telegram OPEN post is execution-confirmed.
    // We intentionally do NOT post here to avoid ghost signals.
    // Posting happens in POST /signal/executed when ok_mod=true.

    return res.json({ ok: true, acted: true, symbol, direction, sl, tp, ref_ms: refMs, posted: false, signal_id: created.id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "auto_scalp_failed", message: String(e?.message || e) });
  }
}

// Support BOTH POST (Render/secure webhooks) and GET (cron-job.org free tier)
app.post("/auto/scalp/run", autoScalpRunHandler);
app.get("/auto/scalp/run", autoScalpRunHandler);

// GET/POST /auto/cooldown/5m/run?symbol=XAUUSD&cooldown_min=30
async function autoCooldown5mHandler(req, res) {
  try {
    const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : "XAUUSD";
    const cooldownMin = req.query.cooldown_min != null ? Number(req.query.cooldown_min) : 15;
    const r = await fetchJson(
      `${BASE_URL}/ea/cooldown/claim5m?symbol=${encodeURIComponent(symbol)}&cooldown_min=${encodeURIComponent(String(cooldownMin))}`
    );
    if (!r?.ok) return res.status(502).json({ ok: false, error: "claim5m_failed" });
    if (!r.notify || !r.message) return res.json({ ok: true, acted: false, reason: r.reason || "no_notify" });

    const chatId = process.env.TELEGRAM_CHAT_ID || "-1003611276978";
    await tgSendMessage({ chatId, text: String(r.message) });
    return res.json({ ok: true, acted: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "auto_cooldown_5m_failed", message: String(e?.message || e) });
  }
}
app.post("/auto/cooldown/5m/run", autoCooldown5mHandler);
app.get("/auto/cooldown/5m/run", autoCooldown5mHandler);

// GET/POST /auto/news/pause/run
async function autoNewsPauseHandler(req, res) {
  try {
    const db = await getDb();
    if (!db) return res.status(503).json({ ok: false, error: "db_required" });

    const all = await getFfEvents();
    const curList = String(process.env.NEWS_ALERT_CURRENCIES || "USD").toUpperCase().split(",").map((s) => s.trim()).filter(Boolean);
    const events = all
      .filter((e) => String(e.impact) === "high")
      .filter((e) => curList.length ? curList.includes(String(e.currency || "").toUpperCase()) : true);

    const now = Date.now();
    const upcoming = events
      .map((e) => ({ e, ts: e.ts }))
      .filter((x) => Number.isFinite(x.ts) && x.ts > now && x.ts <= now + 30 * 60 * 1000)
      .sort((a, b) => a.ts - b.ts)[0];

    if (!upcoming) return res.json({ ok: true, acted: false, reason: "no_upcoming" });

    const minutes = Math.max(0, Math.round((upcoming.ts - now) / 60000));
    const title = String(upcoming.e.title || upcoming.e.event || "High News");

    // de-dupe: once per event within 60m
    const refMs = upcoming.ts;
    const kind = "news_pause";
    const insertedAt = now;

    const dedupSym = String(upcoming.e.currency || "NEWS").toUpperCase();
    await db.execute({
      sql: "INSERT OR IGNORE INTO ea_notifs (symbol,kind,ref_ms,created_at_ms) VALUES (?,?,?,?)",
      args: [dedupSym, kind, refMs, insertedAt],
    });
    const chk = await db.execute({
      sql: "SELECT created_at_ms FROM ea_notifs WHERE symbol=? AND kind=? AND ref_ms=?",
      args: [dedupSym, kind, refMs],
    });
    const createdAt = chk.rows?.[0]?.created_at_ms != null ? Number(chk.rows[0].created_at_ms) : NaN;
    const notify = Number.isFinite(createdAt) && createdAt === insertedAt;
    if (!notify) return res.json({ ok: true, acted: false, reason: "dedup" });

    const warn = minutes < 10 ? " ⚠️" : "";
    const msg = `🚨 #UPDATE NEWS PAUSE — 🇺🇸 USD High in ${minutes}m: ${title} ⏳${warn}`;

    const chatId = process.env.TELEGRAM_CHAT_ID || "-1003611276978";
    await tgSendMessage({ chatId, text: msg });
    return res.json({ ok: true, acted: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "auto_news_pause_failed", message: String(e?.message || e) });
  }
}
app.post("/auto/news/pause/run", autoNewsPauseHandler);
app.get("/auto/news/pause/run", autoNewsPauseHandler);

// GET/POST /auto/news/actuals/run
async function autoNewsActualsHandler(req, res) {
  try {
    const db = await getDb();
    if (!db) return res.status(503).json({ ok: false, error: "db_required" });

    const all = await getFfEvents();
    const now = Date.now();

    const candidates = all
      .filter((e) => String(e.currency || "").toUpperCase() === "USD")
      .filter((e) => String(e.impact) === "high")
      .map((e) => ({ e, ts: e.ts }))
      .filter((x) => Number.isFinite(x.ts) && x.ts <= now && now - x.ts <= 20 * 60 * 1000)
      .filter((x) => x.e.actual != null && x.e.forecast != null)
      .sort((a, b) => b.ts - a.ts);

    const pick = candidates[0];
    if (!pick) return res.json({ ok: true, acted: false, reason: "no_actuals" });

    const title = String(pick.e.title || pick.e.event || "USD High");
    const actual = String(pick.e.actual);
    const forecast = String(pick.e.forecast);
    const prev = pick.e.previous != null ? String(pick.e.previous) : null;

    const refMs = pick.ts;
    const kind = "news_actuals";
    const insertedAt = now;
    await db.execute({
      sql: "INSERT OR IGNORE INTO ea_notifs (symbol,kind,ref_ms,created_at_ms) VALUES (?,?,?,?)",
      args: ["USD", kind, refMs, insertedAt],
    });
    const chk = await db.execute({
      sql: "SELECT created_at_ms FROM ea_notifs WHERE symbol=? AND kind=? AND ref_ms=?",
      args: ["USD", kind, refMs],
    });
    const createdAt = chk.rows?.[0]?.created_at_ms != null ? Number(chk.rows[0].created_at_ms) : NaN;
    const notify = Number.isFinite(createdAt) && createdAt === insertedAt;
    if (!notify) return res.json({ ok: true, acted: false, reason: "dedup" });

    const msg = prev
      ? `🟦 #NEWS USD High: ${title} | Actual ${actual} vs Forecast ${forecast} (Prev ${prev})`
      : `🟦 #NEWS USD High: ${title} | Actual ${actual} vs Forecast ${forecast}`;

    const chatId = process.env.TELEGRAM_CHAT_ID || "-1003611276978";
    await tgSendMessage({ chatId, text: msg });
    return res.json({ ok: true, acted: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "auto_news_actuals_failed", message: String(e?.message || e) });
  }
}
app.post("/auto/news/actuals/run", autoNewsActualsHandler);
app.get("/auto/news/actuals/run", autoNewsActualsHandler);

// GET/POST /auto/daily/plan/run (simple no-LLM plan)
async function autoDailyPlanHandler(req, res) {
  try {
    const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : "XAUUSD";

    // if USD high-impact within 30m => NEWS PAUSE
    const all = await getFfEvents();
    const now = Date.now();
    const soon = all
      .filter((e) => String(e.currency || "").toUpperCase() === "USD")
      .filter((e) => String(e.impact) === "high")
      .map((e) => e.ts)
      .filter((ts) => Number.isFinite(ts) && ts > now && ts <= now + 30 * 60 * 1000)[0];
    if (soon) {
      const chatId = process.env.TELEGRAM_CHAT_ID || "-1003611276978";
      await tgSendMessage({ chatId, text: "#UPDATE: NEWS PAUSE" });
      return res.json({ ok: true, acted: true, reason: "news_pause" });
    }

    // De-dupe: only post once per 2h window per symbol (prevents spam if cron hits too often).
    const planWindowMs = 2 * 60 * 60 * 1000;
    const planBucketMs = Math.floor(Date.now() / planWindowMs) * planWindowMs;

    // Prefer persistent de-dupe when DB is available; otherwise best-effort in-memory.
    const db = await getDb();
    if (db) {
      const kind = "daily_plan";
      const insertedAt = Date.now();
      await db.execute({
        sql: "INSERT OR IGNORE INTO ea_notifs (symbol,kind,ref_ms,created_at_ms) VALUES (?,?,?,?)",
        args: [symbol, kind, planBucketMs, insertedAt],
      });
      const chk = await db.execute({
        sql: "SELECT created_at_ms FROM ea_notifs WHERE symbol=? AND kind=? AND ref_ms=?",
        args: [symbol, kind, planBucketMs],
      });
      const createdAt = chk.rows?.[0]?.created_at_ms != null ? Number(chk.rows[0].created_at_ms) : NaN;
      const notify = Number.isFinite(createdAt) && createdAt === insertedAt;
      if (!notify) {
        return res.json({ ok: true, acted: false, reason: "dedup_2h" });
      }
    } else {
      // In-memory fallback
      if (!globalThis.__flexbotPlanLast) globalThis.__flexbotPlanLast = new Map();
      const last = globalThis.__flexbotPlanLast.get(symbol) || 0;
      if (Date.now() - last < planWindowMs) {
        return res.json({ ok: true, acted: false, reason: "dedup_2h_mem" });
      }
      globalThis.__flexbotPlanLast.set(symbol, Date.now());
    }

    const p = await fetchJson(`${BASE_URL}/price?symbol=${encodeURIComponent(symbol)}`);
    const c15 = await fetchJson(`${BASE_URL}/candles?symbol=${encodeURIComponent(symbol)}&interval=15m&limit=192`);
    if (!p?.ok || !c15?.ok || !Array.isArray(c15?.candles) || c15.candles.length < 32)
      return res.status(502).json({ ok: false, error: "data_failed" });

    const price = Number(p.bid != null ? p.bid : p.price);
    const candles = c15.candles;

    // Compute levels from recent range; if feed is flat/buggy, expand window.
    function rangeFromLast(n) {
      const slice = candles.slice(-n);
      const highs = slice.map((x) => Number(x.high)).filter((v) => Number.isFinite(v));
      const lows = slice.map((x) => Number(x.low)).filter((v) => Number.isFinite(v));
      if (highs.length === 0 || lows.length === 0) return null;
      const hi = Math.max(...highs);
      const lo = Math.min(...lows);
      if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
      return { hi, lo, mid: (hi + lo) / 2 };
    }

    let r = rangeFromLast(32) || rangeFromLast(64) || rangeFromLast(192);
    if (!r) return res.status(502).json({ ok: false, error: "range_failed" });

    // If the range is too tight (or identical), expand window; if still flat, fallback around current price.
    if (Math.abs(r.hi - r.lo) < 0.5) {
      r = rangeFromLast(192) || r;
    }
    if (Math.abs(r.hi - r.lo) < 0.5) {
      // fallback: simple bands around current price
      const p0 = Number.isFinite(price) ? price : r.mid;
      r = { hi: p0 + 5, mid: p0, lo: p0 - 5 };
    }

    const lvl1 = Number(r.hi.toFixed(2));
    const lvl2 = Number(r.mid.toFixed(2));
    const lvl3 = Number(r.lo.toFixed(2));

    const riskPct = 0.5;

    const msg =
      `#PLAN ${symbol}\n` +
      `Levels: ${lvl1} / ${lvl2} / ${lvl3}\n` +
      `BUY | Entry ${lvl2} | SL ${lvl3} | TP1–TP3 RR | Invalidation < ${lvl3} | Risk ${riskPct}% | Bounce / reclaim\n` +
      `SELL | Entry ${lvl2} | SL ${lvl1} | TP1–TP3 RR | Invalidation > ${lvl1} | Risk ${riskPct}% | Reject / breakdown`;

    const chatId = process.env.TELEGRAM_CHAT_ID || "-1003611276978";
    await tgSendMessage({ chatId, text: msg });
    return res.json({ ok: true, acted: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "auto_daily_plan_failed", message: String(e?.message || e) });
  }
}
app.post("/auto/daily/plan/run", autoDailyPlanHandler);
app.get("/auto/daily/plan/run", autoDailyPlanHandler);

// GET/POST /auto/daily/recap/run (simple no-LLM recap)
async function autoDailyRecapHandler(req, res) {
  try {
    const db = await getDb();
    const chatId = process.env.TELEGRAM_CHAT_ID || "-1003611276978";

    if (!db) {
      await tgSendMessage({ chatId, text: "#RECAP XAUUSD\nNo data." });
      return res.json({ ok: true, acted: true, reason: "no_db" });
    }

    const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : "XAUUSD";

    // Use Amsterdam start-of-day (matches trading/Telegram expectations better than server-local time).
    const startMs = startOfDayMsInTz("Europe/Amsterdam");
    const startMsSafe = Number.isFinite(startMs) ? startMs : (() => { const s = new Date(); s.setHours(0,0,0,0); return s.getTime(); })();

    // Count ALL signals today (previous code limited to 5, which made counts wrong).
    const qCount = await db.execute({
      sql: "SELECT COUNT(1) AS n FROM signals WHERE symbol=? AND created_at_ms >= ?",
      args: [symbol, startMsSafe],
    });
    const n = qCount.rows?.[0]?.n != null ? Number(qCount.rows[0].n) : 0;

    // Fetch last direction separately.
    const qLast = await db.execute({
      sql: "SELECT direction FROM signals WHERE symbol=? AND created_at_ms >= ? ORDER BY created_at_ms DESC LIMIT 1",
      args: [symbol, startMsSafe],
    });
    const lastDir = qLast.rows?.[0]?.direction != null ? String(qLast.rows[0].direction) : null;

    const msg = n === 0
      ? `#RECAP ${symbol}\nNo signals today.`
      : `#RECAP ${symbol}\nSignals today: ${n}. Last: ${lastDir}.`;
    await tgSendMessage({ chatId, text: msg });
    return res.json({ ok: true, acted: true, n, lastDir, start_ms: startMsSafe });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "auto_daily_recap_failed", message: String(e?.message || e) });
  }
}
app.post("/auto/daily/recap/run", autoDailyRecapHandler);
app.get("/auto/daily/recap/run", autoDailyRecapHandler);

app.get("/", (_, res) => res.send("ok"));

app.get("/debug/persistence", async (req, res) => {
  const url = process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL || null;
  const authToken = process.env.TURSO_AUTH_TOKEN || process.env.DATABASE_AUTH_TOKEN || null;
  const enabled = Boolean(url && authToken);

  let urlHost = null;
  if (url) {
    try {
      // libsql://host
      const m = String(url).match(/^\w+:\/\/([^/]+)/);
      urlHost = m ? m[1] : null;
    } catch {
      urlHost = null;
    }
  }

  return res.json({
    ok: true,
    persistence_enabled: enabled,
    url_host: urlHost,
    tz: MT5_TZ,
    server_time: formatMt5(Date.now()),
  });
});

async function warmLoadFromDb() {
  const db = await getDb();
  if (!db) return;

  // Load last candles for any known symbols/intervals.
  const symRows = await db.execute("SELECT DISTINCT symbol FROM candles");
  const symbols = (symRows.rows || []).map((r) => String(r.symbol)).filter(Boolean);
  if (!symbols.length) return;

  const intervals = Object.keys(INTERVALS);

  for (const symbol of symbols) {
    for (const interval of intervals) {
      const rows = await db.execute({
        sql:
          "SELECT start_iso,end_iso,open,high,low,close,last_ts,gap,seeded FROM candles WHERE symbol=? AND interval=? ORDER BY start_ms DESC LIMIT ?",
        args: [symbol, interval, MAX_HISTORY_PER_SYMBOL],
      });

      const list = (rows.rows || [])
        .map((r) => ({
          symbol,
          interval,
          start: String(r.start_iso),
          end: String(r.end_iso),
          open: Number(r.open),
          high: Number(r.high),
          low: Number(r.low),
          close: Number(r.close),
          lastTs: r.last_ts != null ? Number(r.last_ts) : null,
          gap: Number(r.gap) === 1,
          seeded: Number(r.seeded) === 1,
        }))
        .filter((c) => [c.open, c.high, c.low, c.close].every(Number.isFinite))
        .reverse();

      if (!list.length) continue;

      const store = getOrCreateStore(symbol, interval);
      store.current = null;
      store.history = list.slice(Math.max(0, list.length - MAX_HISTORY_PER_SYMBOL));
    }
  }
}

async function main() {
  await warmLoadFromDb();
  const port = process.env.PORT || 3000;
  app.listen(port, "0.0.0.0", () => console.log("listening", port));
}

main();
