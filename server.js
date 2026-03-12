const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Public base URL for external links / webhooks.
// On Render you can set PUBLIC_BASE_URL=https://flexbot-qpf2.onrender.com
const BASE_URL = (process.env.PUBLIC_BASE_URL || "https://flexbot-qpf2.onrender.com").trim();
// Internal base URL for self-referential API calls (avoids deadlock on single-threaded hosts)
const INTERNAL_BASE = `http://localhost:${process.env.PORT || 3000}`;

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
  if (!Array.isArray(candles) || candles.length < slow + 2) return { ok: false, bias: "none", strength: 0 };
  const closes = candles.map((c) => Number(c.close)).filter((x) => Number.isFinite(x));
  if (closes.length < slow + 2) return { ok: false, bias: "none", strength: 0 };
  const eFast = ema(closes.slice(-Math.max(fast * 3, slow + 2)), fast);
  const eSlow = ema(closes.slice(-Math.max(slow * 3, slow + 2)), slow);
  if (!Number.isFinite(eFast) || !Number.isFinite(eSlow)) return { ok: false, bias: "none", strength: 0 };
  // strength: how far apart the EMAs are relative to price (0-1 scale, capped)
  const mid = (eFast + eSlow) / 2;
  const gap = Math.abs(eFast - eSlow);
  const strength = mid > 0 ? Math.min(gap / mid * 100, 1.0) : 0;
  return { ok: true, bias: eFast >= eSlow ? "BUY" : "SELL", strength };
}

// ATR (Average True Range) from OHLC candles
function atr(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return NaN;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = Number(candles[i].high);
    const l = Number(candles[i].low);
    const pc = Number(candles[i - 1].close);
    if (!Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(pc)) continue;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  if (trs.length < period) return NaN;
  // Use EMA-style ATR (Wilder smoothing)
  let a = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < trs.length; i++) a = (a * (period - 1) + trs[i]) / period;
  return a;
}

// RSI (Relative Strength Index)
function rsi(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return NaN;
  const closes = candles.map((c) => Number(c.close)).filter((x) => Number.isFinite(x));
  if (closes.length < period + 1) return NaN;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss += Math.abs(d);
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? Math.abs(d) : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// Find recent swing high/low for smarter SL placement
function findSwingLevels(candles, lookback = 20) {
  if (!Array.isArray(candles) || candles.length < lookback) return null;
  const recent = candles.slice(-lookback);
  const highs = recent.map((c) => Number(c.high)).filter((v) => Number.isFinite(v));
  const lows = recent.map((c) => Number(c.low)).filter((v) => Number.isFinite(v));
  if (highs.length === 0 || lows.length === 0) return null;
  return { swingHigh: Math.max(...highs), swingLow: Math.min(...lows) };
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

function getAndUpdateDailyBalanceStart({ symbol, tz, balanceUsd }) {
  const dayKey = dayKeyInTz(tz);
  const fp = riskStatePath("balance-day", symbol);
  const st = readJsonFileSafe(fp, { dayKey: "", tz, startBalance: null, updatedAtMs: 0 });
  if (st.dayKey !== dayKey || !Number.isFinite(Number(st.startBalance)) || Number(st.startBalance) <= 0) {
    const next = { dayKey, tz, startBalance: balanceUsd, updatedAtMs: Date.now() };
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
      "balance REAL," +
      "updated_at_ms INTEGER NOT NULL," +
      "PRIMARY KEY (account_login, server, magic, symbol)" +
    ")"
  );

  // Add balance column if it doesn't exist (migration for existing DBs)
  try { await libsqlClient.execute("ALTER TABLE ea_positions ADD COLUMN balance REAL"); } catch { /* already exists */ }

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

  // Mission Control: bot heartbeats (each bot reports its status)
  await libsqlClient.execute(
    "CREATE TABLE IF NOT EXISTS bot_heartbeats (" +
      "bot_id TEXT PRIMARY KEY," +
      "name TEXT," +
      "status TEXT," +
      "last_action TEXT," +
      "updated_at_ms INTEGER" +
    ")"
  );

  // Mission Control: commands from admin to bots
  await libsqlClient.execute(
    "CREATE TABLE IF NOT EXISTS bot_commands (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT," +
      "bot_id TEXT," +
      "command TEXT," +
      "created_at_ms INTEGER," +
      "executed_at_ms INTEGER" +
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
  if (!events.length) return "No red news found.";

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
      "Stoploss hit. Part of the plan. Risk managed, on to the next one.",
      "SL hit. All according to plan, risk under control. Staying consistent.",
      "Stoploss taken. No emotion, just business. Next opportunity is coming.",
      "Stoploss hit. Risk controlled, process intact.",
      "SL taken. Capital protected, focus stays sharp.",
      "Stoploss. Part of the game. No stress.",
      "One against us. Structure remains solid.",
      "SL hit team. All according to plan — waiting for the next setup.",
      "Stoploss hit. Risk managed. We'll catch the next one together.",
      "Losses are part of the game. We keep building.",
      "Loss taken within the rules. Everything under control.",
      "SL hit. Daily risk safe.",
      "SL hit, rules followed. That's what counts.",
      "Capital first, profits follow.",
      "Stoploss is not a mistake, it's protection. On to the next one.",
      "SL hit. This is why we have risk management.",
      "We follow rules, not emotions.",
      "This is why we work with fixed risk.",
      "SL prevents major damage. No SL, no long-term success.",
      "Control over risk = control over emotion. Drawdown managed.",
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

          // TP / trade-closed one-liners (no link; rotate variants)
          const tpLines = [
            "🔥 Take Profit hit — next move?",
            "✅ TP secured — clean.",
            "🎯 TP reached — nicely done.",
            "💥 TP hit — well played.",
            "🚀 TP taken — on to the next one.",
          ];
          const pickTpLine = () => {
            const last = globalThis.__flexbotLastTpLine || "";
            const pool = tpLines.filter((x) => x !== last);
            const arr = pool.length ? pool : tpLines;
            const chosen = arr[Math.floor(Math.random() * arr.length)];
            globalThis.__flexbotLastTpLine = chosen;
            return chosen;
          };

          if (isTp && next >= 1) {
            const line = pickTpLine();

            if (next === 2) {
              // Send streak-2 VIDEO (Boss request)
              const videoPath = path.join(__dirname, "assets", "streak_tp2.mp4");
              if (fs.existsSync(videoPath)) {
                const buf = fs.readFileSync(videoPath);
                await tgSendVideo({ chatId, video: buf, caption: line });
              } else {
                await tgSendMessage({ chatId, text: line });
              }
            } else if (next === 3) {
              // Send streak-3 VIDEO (Boss request)
              const videoPath = path.join(__dirname, "assets", "streak_tp3.mp4");
              if (fs.existsSync(videoPath)) {
                const buf = fs.readFileSync(videoPath);
                await tgSendVideo({ chatId, video: buf, caption: line });
              } else {
                await tgSendMessage({ chatId, text: line });
              }
            } else {
              await tgSendMessage({ chatId, text: line });
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
      "⏳ 5 min left… then the EA can take a new trade ✅",
      "👀 5 minutes to go — EA is almost ready ✅",
      "Chill… 5 min cooldown left and then we're back 🔥",
      "⏱️ Cooldown almost done: 5 min left, then the EA can trade again ✅",
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
// Body JSON: { account_login, server, magic, symbol, has_position, tickets?:[], equity?:number, balance?:number, time?:ms|string }
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
    const balance = body?.balance != null ? Number(body.balance) : null;

    // Track daily start BALANCE for PnL % calculations (Amsterdam day)
    try {
      if (Number.isFinite(balance) && balance > 0) {
        getAndUpdateDailyBalanceStart({ symbol, tz: "Europe/Amsterdam", balanceUsd: balance });
      }
    } catch {
      // ignore
    }

    // (Legacy) Track daily start equity (still used by some risk checks)
    try {
      if (Number.isFinite(equity) && equity > 0) {
        getAndUpdateDailyEquityStart({ symbol, tz: "Europe/Amsterdam", equityUsd: equity });
      }
    } catch {
      // ignore
    }

    const tsMs = body?.time != null ? parseTimeToMs(body.time) : Date.now();
    const updated_at_ms = Number.isFinite(tsMs) ? tsMs : Date.now();

    if (!account_login || !server || !symbol) {
      return res.status(400).json({ ok: false, error: "missing_fields" });
    }

    const db = await getDb();
    if (db) {
      await db.execute({
        sql:
          "INSERT OR REPLACE INTO ea_positions (account_login,server,magic,symbol,has_position,tickets_json,equity,balance,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?)",
        args: [
          account_login,
          server,
          magic,
          symbol,
          has_position ? 1 : 0,
          JSON.stringify(tickets),
          Number.isFinite(equity) ? equity : null,
          Number.isFinite(balance) ? balance : null,
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
        balance: Number.isFinite(balance) ? balance : null,
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

function buildAutoReply(text, lang = "en") {
  const t = String(text || "").toLowerCase();
  const weekend = isWeekendAmsterdam();
  const isNL = String(lang).toLowerCase().startsWith("nl");

  // Weekend / market closed
  if (weekend && (t.includes("knallen") || t.includes("trade") || t.includes("signaal") || t.includes("open") || t.includes("gaan we") || t.includes("vandaag"))) {
    return isNL
      ? "Markt is gesloten (weekend) — Flexbot opent geen nieuwe trades. Maandag zijn we terug."
      : "Market is closed (weekend) — Flexbot won't open new trades. We're back on Monday.";
  }

  // Unlock / members
  if (t.includes("unlock") || t.includes("member") || t.includes("members") || t.includes("betaal") || t.includes("paid")) {
    return isNL
      ? "Voor members: stuur de bot een DM met /unlock."
      : "For members: DM the bot with /unlock.";
  }

  // EA not trading / disconnected
  if (t.includes("disconnected") || t.includes("geen trades") || t.includes("werkt niet") || t.includes("pakte niet") || t.includes("opent niet")) {
    return isNL
      ? "Check de EA banner + Toolbox→Experts. Als daar DISCONNECTED staat: Tools→Options→EA→Allow WebRequest + BaseUrl checken. Anders stuur een screenshot van Experts + de banner."
      : "Check the EA banner + Toolbox→Experts. If it says DISCONNECTED: Tools→Options→EA→Allow WebRequest + make sure BaseUrl is correct. Otherwise send a screenshot of Experts + banner.";
  }

  // Greetings
  if (/^(yo|hey|hi|hello)\b/.test(t.trim())) {
    return isNL ? "Yo, zeg ’t maar." : "Yo — tell me.";
  }

  // Daily stop
  if (t.includes("daily stop") || t.includes("daily") || t.includes("drawdown") || t.includes("dd")) {
    return isNL
      ? "Zie je DAILY STOP op de banner? Flexbot opent geen nieuwe trades tot de volgende trading day (bescherming)."
      : "See DAILY STOP on the banner? Flexbot stops opening new trades until the next trading day (protection).";
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

    // Language: English in the configured group, Dutch in DMs/other chats.
    const isGroupTarget = !!targetChatId && chatId === targetChatId;
    const lang = isGroupTarget ? "en" : "nl";

    // Determine auto-reply intent early so we can allow certain keywords without requiring a '?' (boss request)
    const auto = buildAutoReply(text, lang);
    const wantsNews = auto === "NEWS_CHECK";

    // For the owner: reply to ANY message (still with cooldown) so it feels responsive.
    // For others: reply in the target group without requiring an @mention.
    // We still avoid spam by only replying when:
    // - it's a question (contains '?'), OR
    // - it matches an auto-reply intent (keywords like setup/news/myfxbook/etc).
    const isQuestion = String(text).includes("?");
    if (!isOwner && !wantsTrophy && !wantsNews && !auto && !isQuestion) return res.json({ ok: true });

    // Cooldown: per-user and per-group
    if (!tgCooldownOk(`u:${userId}`, isOwner ? 30 * 1000 : 10 * 60 * 1000)) return res.json({ ok: true });
    if (!tgCooldownOk(`g:${chatId}`, 2 * 60 * 1000)) return res.json({ ok: true });

    let reply = auto || (isOwner ? (lang === "nl" ? "Yo, zeg ’t maar." : "Yo — tell me.") : null);
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
        await tgSendMessage({ chatId, text: "Myfxbook list is currently unavailable." });
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
          await tgSendMessage({ chatId, text: "Usage: /trophy add <link> | <title>" });
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
          await tgSendMessage({ chatId, text: "No trophies saved yet." });
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
          // Example: Friday (Fri 20 Feb)
          const d = new Date(tsMs);
          const full = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Amsterdam", weekday: "long" }).format(d);
          const wd = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Amsterdam", weekday: "short" }).format(d);
          const day = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Amsterdam", day: "2-digit" }).format(d);
          const mon = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Amsterdam", month: "short" }).format(d).replace(".", "");
          return `${full} (${wd} ${day} ${mon})`;
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
          reply = `${fmtDayLabel(now)} No 🟥 HIGH news for ${curList.join(", ")} according to the feed.`;
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
        reply = "Could not read news feed (temporarily unavailable).";
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
      messages: [
        { role: "system", content: "You are Flexbot's support assistant in a Telegram trading group. Always reply in English. Keep answers short (1-2 sentences max). You help with questions about the Flexbot gold (XAUUSD) trading EA, MetaTrader 5 setup, and trading in general." },
        { role: "user", content: question }
      ],
      max_tokens: 60,
    }),
  });
  const text = answer?.choices?.[0]?.message?.content || "(No answer)";
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

async function fetchJson(url, timeoutMs) {
  const opts = {};
  if (timeoutMs) {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), timeoutMs);
    opts.signal = ctrl.signal;
  }
  const r = await fetchFn(url, opts);
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
      // Optional: force a specific WIN mascot (used for deterministic local previews).
      // Accepts either a basename (e.g. mascot_win_custom4.png) or full path.
      const forced = String(process?.env?.FLEXBOT_FORCE_WIN_MASCOT || "").trim();
      const forcedBase = forced ? path.basename(forced) : "";
      const forcedPick = forced ? (pool.find((p) => p === forced || path.basename(p) === forcedBase) || null) : null;

      if (forcedPick) {
        chosen = forcedPick;
      } else {
        // Boss request: WIN mascot must rotate round-robin (no random, no repeats).
        const rr = _pickRoundRobin(pool, "win");
        chosen = rr || pool[0];
      }
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

  const rawNum = Number(String(resultStr).replace(/[^0-9.+-]/g, ""));
  const prettyNum = Number.isFinite(rawNum) ? Math.abs(rawNum).toFixed(2) : null;
  const isNeg = String(resultStr).trim().startsWith("-") || isSl;
  const pnlColor = isNeg ? "#ff4d4d" : "#22c55e";

  const resultBig = prettyNum ? `${prettyNum} USD` : String(resultStr);
  const resultBigFont = fitFontByChars(resultBig, 74, 48, 12);

  // Mascot: on losses we still want to show the dedicated loss overlay if configured.
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
    "mascot_win_custom2.png": { x: -60, w: 660, h: 760, filter: "boost" },

    // Custom4: a bit smaller
    "mascot_win_custom4.png": { x: -100, y: 480, w: 680, h: 780 },

    // Custom5: move up
    "mascot_win_custom5.png": { y: -200 },

    // Custom6: move further left + slightly smaller so it never covers the title block
    "mascot_win_custom6.png": { x: 40, y: 520, w: 600, h: 680 },

    // Custom7: a bit more to the right + smaller
    "mascot_win_custom7.png": { x: 0, y: 430, w: 580, h: 680 },

    // Custom9: move right
    "mascot_win_custom9.png": { x: -120 },

    // Custom10: smaller
    "mascot_win_custom10.png": { x: -100, w: 720, h: 820 },

    // Custom11: soldier astronaut
    "mascot_win_custom11.png": { x: -100, y: 360 },

    // Custom12: champagne astronaut
    "mascot_win_custom12.png": { x: -15, y: 390, w: 640, h: 740 },

    // Custom13: trophy astronaut
    "mascot_win_custom13.png": { x: -25, y: 360, w: 660, h: 760 },

    // Custom14: cash astronaut (same placement as custom13)
    "mascot_win_custom14.png": { x: -25, y: 360, w: 660, h: 760 },

    // Custom15: burning cash astronaut (same placement as custom13)
    "mascot_win_custom15.png": { x: -25, y: 360, w: 660, h: 760 },

    // Custom16: gun astronaut (same placement as custom13)
    "mascot_win_custom16.png": { x: -25, y: 360, w: 660, h: 760 },

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

  // Layout
  const panelX = 560;
  const panelY = 310; // moved down (Boss request)
  const panelW = 480;
  const panelH = 450;

  const pnlSign = isNeg ? "-" : "+";
  const pnlDisplay = prettyNum ? `${pnlSign}${resultBig}` : resultBig;
  const pnlFs = Math.min(resultBigFont, Math.max(28, Math.floor((panelW - 88) / (pnlDisplay.length * 0.60))));
  const badgeW = Math.max(110, outcomeStr.length * 24 + 44);
  const badgeCenterX = 80 + Math.round(badgeW / 2);
  const symDirText = `${sym} ${dir}`;
  const symDirFs = Math.min(68, Math.max(36, Math.floor((panelX - 80 - 20) / (symDirText.length * 0.70))));

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
  <linearGradient id="bgGrad" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#0e1520"/>
    <stop offset="1" stop-color="#080b14"/>
  </linearGradient>
  <linearGradient id="accentBar" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#f7c948"/>
    <stop offset="0.5" stop-color="#e6b820"/>
    <stop offset="1" stop-color="#c9960c"/>
  </linearGradient>
  <linearGradient id="headerFade" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#1a1508"/>
    <stop offset="0.5" stop-color="#111620" stop-opacity="0.7"/>
    <stop offset="1" stop-color="#080b14" stop-opacity="0"/>
  </linearGradient>
  <linearGradient id="glassPanel" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="rgba(255,255,255,0.07)"/>
    <stop offset="1" stop-color="rgba(255,255,255,0.02)"/>
  </linearGradient>
  <linearGradient id="goldBorder" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#f7c948" stop-opacity="0.5"/>
    <stop offset="1" stop-color="#c9960c" stop-opacity="0.15"/>
  </linearGradient>
  <pattern id="dots" x="0" y="0" width="32" height="32" patternUnits="userSpaceOnUse">
    <circle cx="16" cy="16" r="1.5" fill="rgba(255,255,255,0.06)"/>
  </pattern>
  <filter id="glowGold" x="-30%" y="-50%" width="160%" height="200%">
    <feGaussianBlur stdDeviation="8" result="b"/>
    <feColorMatrix in="b" type="matrix" values="2.5 1.5 0 0 0  1.5 1 0 0 0  0 0 0 0 0  0 0 0 0.65 0" result="g"/>
    <feMerge><feMergeNode in="g"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
  <filter id="glowGreen" x="-30%" y="-50%" width="160%" height="200%">
    <feGaussianBlur stdDeviation="10" result="b"/>
    <feColorMatrix in="b" type="matrix" values="0 0 0 0 0.1  0 3 0 0 0.4  0 0 0 0 0.15  0 0 0 0.6 0" result="g"/>
    <feMerge><feMergeNode in="g"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
  <filter id="glowRed" x="-30%" y="-50%" width="160%" height="200%">
    <feGaussianBlur stdDeviation="10" result="b"/>
    <feColorMatrix in="b" type="matrix" values="3 0 0 0 0.4  0 0 0 0 0.05  0 0 0 0 0.05  0 0 0 0.6 0" result="g"/>
    <feMerge><feMergeNode in="g"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
  <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%">
    <feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#000" flood-opacity="0.65"/>
  </filter>
  <filter id="mascotBoost" color-interpolation-filters="sRGB">
    <feComponentTransfer>
      <feFuncR type="gamma" amplitude="1" exponent="0.92" offset="0"/>
      <feFuncG type="gamma" amplitude="1" exponent="0.92" offset="0"/>
      <feFuncB type="gamma" amplitude="1" exponent="0.92" offset="0"/>
    </feComponentTransfer>
  </filter>
</defs>

<!-- Background -->
<rect width="${W}" height="${H}" fill="url(#bgGrad)"/>
<rect width="${W}" height="${H}" fill="url(#dots)"/>

<!-- Left gold accent bar -->
<rect x="0" y="0" width="8" height="${H}" fill="url(#accentBar)"/>

<!-- Header glow strip -->
<rect x="0" y="0" width="${W}" height="200" fill="url(#headerFade)"/>

<!-- FLEXBOT gold -->
<text x="80" y="88" font-family="Inter,Segoe UI,Arial" font-size="30" font-weight="900" fill="#f7c948" letter-spacing="8" filter="url(#glowGold)">FLEXBOT</text>
<!-- TRADE CLOSED -->
<text x="80" y="156" font-family="Inter,Segoe UI,Arial" font-size="62" font-weight="900" fill="#ffffff" letter-spacing="2">TRADE CLOSED</text>
<!-- Gold divider -->
<line x1="80" y1="184" x2="${W - 60}" y2="184" stroke="#f7c948" stroke-width="1.5" stroke-opacity="0.3"/>

<!-- Symbol + Direction -->
<text x="80" y="270" font-family="Inter,Segoe UI,Arial" font-size="${symDirFs}" font-weight="900" fill="#ffffff">${sym} <tspan fill="rgba(255,255,255,0.70)">${dir}</tspan></text>

<!-- Outcome badge -->
<rect x="80" y="290" width="${badgeW}" height="50" rx="25" fill="${isTp ? "rgba(34,197,94,0.15)" : (isSl ? "rgba(255,77,77,0.15)" : "rgba(245,158,11,0.15)")}"/>
<rect x="80" y="290" width="${badgeW}" height="50" rx="25" fill="none" stroke="${outcomeColor}" stroke-width="1.5"/>
<text x="${badgeCenterX}" y="322" text-anchor="middle" font-family="Inter,Segoe UI,Arial" font-size="26" font-weight="700" fill="${outcomeColor}">${outcomeStr}</text>

<!-- Left mascot -->
${mascotDataUri ? `<g filter="url(#shadow)">
  <image x="${mascotX}" y="${mascotY}" width="${mascotW}" height="${mascotH}" href="${mascotDataUri}" preserveAspectRatio="xMidYMid meet" ${mascotFilterAttr ? `filter="${mascotFilterAttr}"` : ``}/>
</g>` : ``}

<!-- Levels panel (right) -->
<g filter="url(#shadow)">
  <rect x="${panelX}" y="${panelY}" width="${panelW}" height="${panelH}" rx="22" fill="url(#glassPanel)" stroke="url(#goldBorder)" stroke-width="1.5"/>

  <line x1="${panelX + 28}" y1="${panelY + 100}" x2="${panelX + panelW - 28}" y2="${panelY + 100}" stroke="rgba(255,255,255,0.08)"/>
  <text x="${panelX + 44}" y="${panelY + 66}" font-family="Inter,Segoe UI,Arial" font-size="27" fill="rgba(255,255,255,0.50)" letter-spacing="1">Entry</text>
  <text x="${panelX + panelW - 44}" y="${panelY + 66}" text-anchor="end" font-family="Inter,Segoe UI,Arial" font-size="36" fill="#ffffff" font-weight="700">${entry === "market" ? "market" : fmtLevel(entry)}</text>

  <line x1="${panelX + 28}" y1="${panelY + 195}" x2="${panelX + panelW - 28}" y2="${panelY + 195}" stroke="rgba(255,255,255,0.08)"/>
  <text x="${panelX + 44}" y="${panelY + 156}" font-family="Inter,Segoe UI,Arial" font-size="27" fill="rgba(255,255,255,0.50)" letter-spacing="1">SL</text>
  <text x="${panelX + panelW - 44}" y="${panelY + 156}" text-anchor="end" font-family="Inter,Segoe UI,Arial" font-size="36" fill="#ff6b6b" font-weight="700">${fmtLevel(sl)}</text>

  <line x1="${panelX + 28}" y1="${panelY + 290}" x2="${panelX + panelW - 28}" y2="${panelY + 290}" stroke="rgba(255,255,255,0.08)"/>
  <text x="${panelX + 44}" y="${panelY + 252}" font-family="Inter,Segoe UI,Arial" font-size="27" fill="rgba(255,255,255,0.50)" letter-spacing="1">TP</text>
  <text x="${panelX + panelW - 44}" y="${panelY + 252}" text-anchor="end" font-family="Inter,Segoe UI,Arial" font-size="36" fill="#4ade80" font-weight="700">${fmtLevel(tp1)}</text>

  <!-- PnL result with glow -->
  <text x="${panelX + 44}" y="${panelY + 396}" font-family="Inter,Segoe UI,Arial" font-size="${pnlFs}" fill="${pnlColor}" font-weight="900" filter="url(${isNeg ? "#glowRed" : "#glowGreen"})" textLength="${panelW - 88}" lengthAdjust="spacingAndGlyphs">${pnlDisplay}</text>
</g>

<!-- Bottom bar -->
<rect x="0" y="${H - 76}" width="${W}" height="76" fill="rgba(0,0,0,0.45)"/>
<line x1="0" y1="${H - 76}" x2="${W}" y2="${H - 76}" stroke="#f7c948" stroke-width="1" stroke-opacity="0.22"/>
<text x="80" y="${H - 28}" font-family="Inter,Segoe UI,Arial" font-size="26" font-weight="900" fill="#f7c948" letter-spacing="5" filter="url(#glowGold)">FLEXBOT</text>
<text x="${W - 60}" y="${H - 28}" text-anchor="end" font-family="Inter,Segoe UI,Arial" font-size="21" fill="rgba(255,255,255,0.32)">#${ref8} · ${ts}</text>

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

function createDailyRecapSvg({ symbol, dayLabel, closedCount, totalUsdStr, totalPctStr, lines, page, pages }) {
  const W = 1080, H = 1080, pad = 52;
  const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Optional corner mascot (Boss request)
  const cornerPath = path.join(__dirname, "assets", "recap_corner.png");
  const cornerDataUri = (() => {
    try {
      if (!fs.existsSync(cornerPath)) return null;
      const buf = fs.readFileSync(cornerPath);
      return `data:image/png;base64,${buf.toString("base64")}`;
    } catch {
      return null;
    }
  })();

  const sym = String(symbol || "XAUUSD").toUpperCase();
  const sub = String(dayLabel || "").trim();
  const pageLabel = pages && pages > 1 ? `${page}/${pages}` : "";

  const isNeg = String(totalUsdStr || "").trim().startsWith("-");
  const pnlColor = isNeg ? "#ff4757" : "#00d084";
  const borderColor = isNeg ? "rgba(255,71,87,0.25)" : "rgba(0,208,132,0.25)";
  const usdNum = String(totalUsdStr || "-").replace(/\s*USD\s*/i, "").trim();
  const pnlBig = esc(usdNum || "-");
  const pnlPct = totalPctStr ? esc(String(totalPctStr)) : "";
  const pnlFs = pnlBig.length >= 13 ? 40 : pnlBig.length >= 11 ? 46 : pnlBig.length >= 9 ? 54 : 62;

  const safeLines = Array.isArray(lines) ? lines : [];
  const twoCols = safeLines.length > 10;
  const linesPerCol = 9;
  const showLines = safeLines.slice(0, twoCols ? linesPerCol * 2 : 12);

  const logoDataUri = (() => {
    try {
      const p = path.join(__dirname, "assets", "recap_flexbot_logo.png");
      if (!fs.existsSync(p)) return null;
      return `data:image/png;base64,${fs.readFileSync(p).toString("base64")}`;
    } catch { return null; }
  })();

  const showCorner = false;

  const normalizeOut = v => {
    const s = String(v || "").trim().toLowerCase();
    if (s === "sl hit" || s === "sl") return "SL";
    if (s === "tp hit" || s === "tp") return "TP";
    return String(v || "").trim();
  };
  const colOut = out => {
    const s = String(out || "").toLowerCase();
    if (s.includes("tp")) return "#00d084";
    if (s.includes("sl")) return "#ff4757";
    return "rgba(255,255,255,0.88)";
  };
  const colPnl = (res, out) => {
    const s = String(res || "");
    if (s.includes("-")) return "#ff4757";
    if (s.includes("+")) return "#00d084";
    if (String(out || "").toLowerCase().includes("tp")) return "#00d084";
    return "rgba(255,255,255,0.88)";
  };
  const textForLine = t => {
    if (t && typeof t === "object") return t.text != null ? String(t.text) : "";
    return String(t || "");
  };

  const listStartY = 450;
  const lineH = twoCols ? 36 : 42;
  const colW = twoCols ? 488 : W - pad * 2;
  const col1X = pad + 8;
  const col2X = twoCols ? col1X + 504 : col1X;
  const textFs = twoCols ? 22 : 26;

  // Layout offsets for aligned columns
  const numW = twoCols ? 30 : 36;
  const dirBadgeX = twoCols ? 44 : 54;
  const dirBadgeW = twoCols ? 68 : 78;
  const outBadgeX = twoCols ? 120 : 140;
  const outBadgeW = twoCols ? 48 : 52;
  const resOffX = twoCols ? 160 : 182;
  const badgeH = twoCols ? 26 : 30;
  const badgeR = twoCols ? 6 : 7;

  const linesSvg = showLines.map((t, i) => {
    const col = twoCols ? (i >= linesPerCol ? 1 : 0) : 0;
    const row = twoCols ? (i % linesPerCol) : i;
    const baseX = col === 1 ? col2X : col1X;
    const rowY = listStartY + row * lineH;
    const textY = rowY + lineH * 0.72;
    const badgeY = rowY + (lineH - badgeH) / 2 - 1;
    const raw = textForLine(t);
    const parts = raw.split("|").map(x => x.trim());
    const leftRaw = parts[0] || raw;
    const outRaw = parts[1] || "";
    const res = parts[2] || "";
    const out = normalizeOut(outRaw);
    const outFill = colOut(out);
    const resFill = colPnl(res, out);
    const rowBg = row % 2 === 0 ? "rgba(255,255,255,0.028)" : "transparent";
    const isResNeg = String(res).includes("-");

    // Parse number and direction from left part (e.g. "1) BUY")
    const leftMatch = leftRaw.match(/^(\d+)\)\s*(BUY|SELL)/i);
    const num = leftMatch ? leftMatch[1] : "";
    const dir = leftMatch ? leftMatch[2].toUpperCase() : leftRaw;
    const dirColor = dir === "BUY" ? "#00d084" : dir === "SELL" ? "#ff4757" : "#ffffff";
    const outBg = out === "TP" ? "rgba(0,208,132,0.12)" : out === "SL" ? "rgba(255,71,87,0.12)" : "rgba(255,255,255,0.05)";
    const outStroke = out === "TP" ? "rgba(0,208,132,0.30)" : out === "SL" ? "rgba(255,71,87,0.30)" : "rgba(255,255,255,0.10)";
    const dirBg = dir === "BUY" ? "rgba(0,208,132,0.12)" : dir === "SELL" ? "rgba(255,71,87,0.12)" : "rgba(255,255,255,0.05)";
    const dirStroke = dir === "BUY" ? "rgba(0,208,132,0.30)" : dir === "SELL" ? "rgba(255,71,87,0.30)" : "rgba(255,255,255,0.10)";

    return [
      // Row bg + colored left accent
      `<rect x="${baseX - 8}" y="${rowY}" width="${colW}" height="${lineH - 2}" rx="6" fill="${rowBg}"/>`,
      `<rect x="${baseX - 8}" y="${rowY + 4}" width="2.5" height="${lineH - 10}" rx="1.25" fill="${dirColor}" opacity="0.3"/>`,
      // Trade number (subtle)
      `<text x="${baseX + numW}" y="${textY}" text-anchor="end" font-family="JetBrains Mono,Consolas,monospace" font-size="${textFs - 6}" fill="rgba(255,255,255,0.22)" font-weight="600">${esc(num)}</text>`,
      // Direction badge
      `<rect x="${baseX + dirBadgeX}" y="${badgeY}" width="${dirBadgeW}" height="${badgeH}" rx="${badgeR}" fill="${dirBg}" stroke="${dirStroke}" stroke-width="1"/>`,
      `<text x="${baseX + dirBadgeX + dirBadgeW / 2}" y="${textY}" text-anchor="middle" font-family="Inter,Segoe UI,Arial" font-size="${textFs - 2}" fill="${dirColor}" font-weight="900" letter-spacing="1">${esc(dir)}</text>`,
      // Outcome badge
      outRaw ? `<rect x="${baseX + outBadgeX}" y="${badgeY}" width="${outBadgeW}" height="${badgeH}" rx="${badgeR}" fill="${outBg}" stroke="${outStroke}" stroke-width="1"/>` : "",
      outRaw ? `<text x="${baseX + outBadgeX + outBadgeW / 2}" y="${textY}" text-anchor="middle" font-family="Inter,Segoe UI,Arial" font-size="${textFs - 2}" fill="${outFill}" font-weight="900">${esc(out)}</text>` : "",
      // PnL amount with subtle glow
      res ? (() => {
        const resMatch = res.match(/^([+-]?)([\d.]+)\s*(.*)/);
        const sign = resMatch ? resMatch[1] : "";
        const amt = resMatch ? resMatch[2] : res;
        const unit = resMatch ? resMatch[3] : "";
        const unitX = baseX + resOffX + (twoCols ? 116 : 128);
        return [
          `<text x="${unitX}" y="${textY}" text-anchor="end" font-family="JetBrains Mono,Consolas,monospace" font-size="${textFs}" fill="${resFill}" font-weight="700" style="font-variant-numeric: tabular-nums;">${esc(sign + amt)}</text>`,
          unit ? `<text x="${unitX + 6}" y="${textY}" font-family="Inter,Segoe UI,Arial" font-size="${textFs - 6}" fill="rgba(255,255,255,0.25)" font-weight="500" letter-spacing="0.5">${esc(unit)}</text>` : "",
        ].join("\n");
      })() : "",
      // Subtle row separator
      `<line x1="${baseX}" y1="${rowY + lineH - 2}" x2="${baseX + colW - 24}" y2="${rowY + lineH - 2}" stroke="rgba(255,255,255,0.025)" stroke-width="0.5"/>`,
    ].filter(Boolean).join("\n");
  }).join("\n");

  // Stat card layout
  const statsY = 160;
  const statsH = 152;
  const stat1W = 270;
  const stat2W = pnlPct ? W - pad * 2 - stat1W * 2 - 24 : W - pad * 2 - stat1W - 12;
  const stat1X = pad;
  const stat2X = pad + stat1W + 12;
  const stat3X = pad + stat1W + stat2W + 24;

  // Dynamic font size: fit number inside card width (0.58 = avg char width ratio for bold Inter)
  const fitFs = (text, availW, max, min) => Math.min(max, Math.max(min, Math.floor(availW / (String(text).length * 0.58))));

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0.3" y2="1">
    <stop offset="0" stop-color="#0c1018"/>
    <stop offset="0.4" stop-color="#080c14"/>
    <stop offset="1" stop-color="#04060c"/>
  </linearGradient>
  <radialGradient id="auraGold" cx="5%" cy="0%" r="55%">
    <stop offset="0" stop-color="#f0a030" stop-opacity="0.10"/>
    <stop offset="0.6" stop-color="#f0a030" stop-opacity="0.03"/>
    <stop offset="1" stop-color="#f0a030" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="auraPnl" cx="50%" cy="25%" r="55%">
    <stop offset="0" stop-color="${pnlColor}" stop-opacity="0.06"/>
    <stop offset="1" stop-color="${pnlColor}" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="glass" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="rgba(255,255,255,0.08)"/>
    <stop offset="1" stop-color="rgba(255,255,255,0.02)"/>
  </linearGradient>
  <linearGradient id="glassPnl" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="rgba(255,255,255,0.06)"/>
    <stop offset="0.5" stop-color="${pnlColor}08"/>
    <stop offset="1" stop-color="rgba(255,255,255,0.01)"/>
  </linearGradient>
  <linearGradient id="goldBar" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#ffd06000"/>
    <stop offset="0.15" stop-color="#ffd060"/>
    <stop offset="0.5" stop-color="#e8a020"/>
    <stop offset="0.85" stop-color="#c97d10"/>
    <stop offset="1" stop-color="#c97d1000"/>
  </linearGradient>
  <linearGradient id="headerLine" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#f0a030" stop-opacity="0.40"/>
    <stop offset="0.5" stop-color="#f0a030" stop-opacity="0.12"/>
    <stop offset="1" stop-color="#f0a030" stop-opacity="0"/>
  </linearGradient>
  <linearGradient id="footerFade" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#00000000"/>
    <stop offset="1" stop-color="rgba(0,0,0,0.55)"/>
  </linearGradient>
  <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse">
    <circle cx="24" cy="24" r="0.6" fill="rgba(255,255,255,0.04)"/>
  </pattern>
  <filter id="sh" x="-20%" y="-20%" width="140%" height="140%">
    <feDropShadow dx="0" dy="8" stdDeviation="16" flood-color="#000" flood-opacity="0.70"/>
  </filter>
  <filter id="shSm" x="-10%" y="-10%" width="120%" height="120%">
    <feDropShadow dx="0" dy="3" stdDeviation="6" flood-color="#000" flood-opacity="0.50"/>
  </filter>
  <filter id="glowPnl" x="-40%" y="-40%" width="180%" height="180%">
    <feGaussianBlur stdDeviation="8" result="b"/>
    <feColorMatrix in="b" type="matrix" values="${isNeg ? "1.2 0 0 0 0.4  0 0 0 0 0  0 0 0 0 0.05  0 0 0 0.45 0" : "0 0 0 0 0  1.2 0 0 0 0.4  0 0 0 0 0.2  0 0 0 0.45 0"}" result="g"/>
    <feMerge><feMergeNode in="g"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
  <filter id="glowGold" x="-40%" y="-40%" width="180%" height="180%">
    <feGaussianBlur stdDeviation="6" result="b"/>
    <feColorMatrix in="b" type="matrix" values="1.2 0 0 0 0.35  0.6 0 0 0 0.2  0 0 0 0 0  0 0 0 0.4 0" result="g"/>
    <feMerge><feMergeNode in="g"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
</defs>

<!-- Background layers -->
<rect width="${W}" height="${H}" fill="url(#bg)"/>
<rect width="${W}" height="${H}" fill="url(#grid)"/>
<rect width="${W}" height="${H}" fill="url(#auraGold)"/>
<rect width="${W}" height="${H}" fill="url(#auraPnl)"/>

<!-- Left gold accent bar -->
<rect x="0" y="0" width="4" height="${H}" fill="url(#goldBar)"/>

<!-- Outer frame -->
<rect x="18" y="18" width="${W - 36}" height="${H - 36}" rx="28" fill="none" stroke="rgba(255,255,255,0.045)" stroke-width="1"/>
<rect x="19" y="19" width="${W - 38}" height="${H - 38}" rx="27" fill="none" stroke="rgba(240,160,48,0.06)" stroke-width="0.5"/>

<!-- Header -->
<text x="${pad}" y="76" font-family="Inter,Segoe UI,Arial" font-size="38" fill="#f0a030" font-weight="900" letter-spacing="2" filter="url(#glowGold)">FLEXBOT</text>
<text x="${W - pad}" y="76" text-anchor="end" font-family="Inter,Segoe UI,Arial" font-size="14" fill="rgba(255,255,255,0.30)" font-weight="600" letter-spacing="5">DAILY RECAP</text>
<line x1="${pad}" y1="98" x2="${W - pad}" y2="98" stroke="url(#headerLine)" stroke-width="1"/>
${sub ? `<text x="${W / 2}" y="132" text-anchor="middle" font-family="Inter,Segoe UI,Arial" font-size="26" fill="rgba(255,255,255,0.65)" font-weight="600" letter-spacing="2">${esc(sub)}</text>` : ""}

<!-- Stat cards -->
<g filter="url(#sh)">
  <rect x="${stat1X}" y="${statsY}" width="${stat1W}" height="${statsH}" rx="16" fill="url(#glass)" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
  <text x="${stat1X + stat1W / 2}" y="${statsY + 40}" text-anchor="middle" font-family="Inter,Segoe UI,Arial" font-size="14" fill="rgba(255,255,255,0.35)" letter-spacing="3" font-weight="600">TRADES</text>
  <text x="${stat1X + stat1W / 2}" y="${statsY + 115}" text-anchor="middle" font-family="Inter,Segoe UI,Arial" font-size="72" fill="#ffffff" font-weight="900" style="font-variant-numeric: tabular-nums;">${esc(String(closedCount ?? "-"))}</text>

  <rect x="${stat2X}" y="${statsY}" width="${stat2W}" height="${statsH}" rx="16" fill="url(#glassPnl)" stroke="${borderColor}" stroke-width="1.5"/>
  <text x="${stat2X + stat2W / 2}" y="${statsY + 40}" text-anchor="middle" font-family="Inter,Segoe UI,Arial" font-size="14" fill="rgba(255,255,255,0.35)" letter-spacing="3" font-weight="600">TOTAL P&amp;L</text>
  <text x="${stat2X + stat2W / 2}" y="${statsY + 117}" text-anchor="middle" font-family="Inter,Segoe UI,Arial" font-size="${fitFs(pnlBig, stat2W - 40, 58, 26)}" fill="${pnlColor}" font-weight="900" filter="url(#glowPnl)" style="font-variant-numeric: tabular-nums;">${pnlBig}<tspan font-size="14" fill="rgba(255,255,255,0.30)" font-weight="400"> USD</tspan></text>

  ${pnlPct ? `<rect x="${stat3X}" y="${statsY}" width="${stat1W}" height="${statsH}" rx="16" fill="url(#glassPnl)" stroke="${borderColor}" stroke-width="1"/>
  <text x="${stat3X + stat1W / 2}" y="${statsY + 40}" text-anchor="middle" font-family="Inter,Segoe UI,Arial" font-size="14" fill="rgba(255,255,255,0.35)" letter-spacing="3" font-weight="600">CHANGE</text>
  <text x="${stat3X + stat1W / 2}" y="${statsY + 117}" text-anchor="middle" font-family="Inter,Segoe UI,Arial" font-size="${fitFs(pnlPct, stat1W - 32, 58, 26)}" fill="${pnlColor}" font-weight="900" filter="url(#glowPnl)" style="font-variant-numeric: tabular-nums;">${esc(pnlPct)}</text>` : ""}
</g>

<!-- Trades section divider -->
<line x1="${pad}" y1="${statsY + statsH + 32}" x2="${pad + 50}" y2="${statsY + statsH + 32}" stroke="rgba(240,160,48,0.25)" stroke-width="1"/>
<text x="${pad + 62}" y="${statsY + statsH + 37}" font-family="Inter,Segoe UI,Arial" font-size="11" fill="rgba(240,160,48,0.45)" letter-spacing="4" font-weight="700">TRADES</text>
<line x1="${pad + 138}" y1="${statsY + statsH + 32}" x2="${W - pad}" y2="${statsY + statsH + 32}" stroke="rgba(255,255,255,0.04)" stroke-width="0.5"/>

<!-- Column headers (two-col mode) -->
${twoCols ? `<text x="${col1X}" y="${listStartY - 14}" font-family="Inter,Segoe UI,Arial" font-size="13" fill="rgba(240,160,48,0.40)" font-weight="700" letter-spacing="2">#1 – ${linesPerCol}</text>
<text x="${col2X}" y="${listStartY - 14}" font-family="Inter,Segoe UI,Arial" font-size="13" fill="rgba(240,160,48,0.40)" font-weight="700" letter-spacing="2">#${linesPerCol + 1} – ${showLines.length}</text>` : ""}

<!-- Trade rows -->
${linesSvg}

<!-- Footer -->
<rect x="0" y="${H - 70}" width="${W}" height="70" fill="url(#footerFade)"/>
<line x1="4" y1="${H - 70}" x2="${W}" y2="${H - 70}" stroke="rgba(240,160,48,0.12)" stroke-width="0.5"/>
${logoDataUri
  ? `<g opacity="0.85"><image x="${(W - 180) / 2}" y="${H - 54}" width="180" height="38" href="${logoDataUri}" preserveAspectRatio="xMidYMid meet"/></g>`
  : `<text x="${W / 2}" y="${H - 22}" text-anchor="middle" font-family="Inter,Segoe UI,Arial" font-size="18" fill="rgba(240,160,48,0.65)" letter-spacing="10" font-weight="900">FLEXBOT</text>`}
${pageLabel ? `<text x="${W - pad}" y="${H - 22}" text-anchor="end" font-family="Inter,Segoe UI,Arial" font-size="15" fill="rgba(255,255,255,0.25)">${esc(pageLabel)}</text>` : ""}
</svg>`;
}

function createTopTradesSvg({ symbol, dayLabel, items }) {
  const W = 1080, H = 1080, pad = 52;
  const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const sub = String(dayLabel || "").trim();

  const logoDataUri = (() => {
    try {
      const p = path.join(__dirname, "assets", "toptrades_flexbot_logo.png");
      if (!fs.existsSync(p)) return null;
      return `data:image/png;base64,${fs.readFileSync(p).toString("base64")}`;
    } catch { return null; }
  })();

  const list = Array.isArray(items) ? items.slice(0, 3) : [];
  const rankColors = ["#ffd700", "#c0c0c0", "#cd7f32"];

  const rowY0 = 338;
  const rowH = 188;

  const cardsSvg = list.map((it, i) => {
    const y = rowY0 + i * rowH;
    const rank = esc(String(it?.rank ?? (i + 1)));
    const dir = esc(String(it?.dir ?? "-").toUpperCase());
    const out = esc(String(it?.out ?? ""));
    const usdStr = esc(String(it?.usdStr ?? "-"));
    const rankColor = rankColors[i] || "#ffffff";
    const dirColor = dir === "BUY" ? "#00d084" : dir === "SELL" ? "#ff4757" : "#ffffff";
    const outColor = String(it?.out || "").toLowerCase().includes("sl") ? "#ff4757" : "#00d084";
    const isPositive = !String(it?.usdStr || "").includes("-");
    const glowFilter = isPositive ? "url(#glowGreen)" : "url(#glowRed)";
    const amtColor = isPositive ? "#00d084" : "#ff4757";
    const cardH = rowH - 16;
    // Amount column starts after badges (~380px), ends at W-pad-32. Fit font to available space.
    const amtAvailW = W - pad - 32 - (pad + 380);
    const amtFs = Math.min(54, Math.max(26, Math.floor(amtAvailW / (usdStr.length * 0.62))));
    return `<g filter="url(#sh)">
  <rect x="${pad}" y="${y}" width="${W - pad * 2}" height="${cardH}" rx="20" fill="url(#glass)" stroke="${rankColor}18" stroke-width="1.5"/>
  <rect x="${pad}" y="${y}" width="5" height="${cardH}" rx="2.5" fill="${rankColor}" opacity="0.80"/>
  <text x="${pad + 64}" y="${y + cardH / 2 + 22}" text-anchor="middle" font-family="Inter,Segoe UI,Arial" font-size="72" fill="${rankColor}" font-weight="900" opacity="0.88">${rank}</text>
  <line x1="${pad + 114}" y1="${y + 22}" x2="${pad + 114}" y2="${y + cardH - 22}" stroke="rgba(255,255,255,0.07)" stroke-width="1"/>
  <rect x="${pad + 134}" y="${y + 38}" width="114" height="48" rx="11" fill="${dirColor}1a" stroke="${dirColor}40" stroke-width="1.5"/>
  <text x="${pad + 191}" y="${y + 71}" text-anchor="middle" font-family="Inter,Segoe UI,Arial" font-size="28" fill="${dirColor}" font-weight="900" letter-spacing="1">${dir}</text>
  ${out ? `<rect x="${pad + 262}" y="${y + 38}" width="90" height="48" rx="11" fill="${outColor}1a" stroke="${outColor}40" stroke-width="1.5"/>
  <text x="${pad + 307}" y="${y + 71}" text-anchor="middle" font-family="Inter,Segoe UI,Arial" font-size="28" fill="${outColor}" font-weight="900">${out}</text>` : ""}
  <text x="${W - pad - 32}" y="${y + cardH / 2 + amtFs * 0.38}" text-anchor="end" font-family="JetBrains Mono,Consolas,monospace" font-size="${amtFs}" fill="${amtColor}" font-weight="900" filter="${glowFilter}" style="font-variant-numeric: tabular-nums;">${usdStr}</text>
</g>`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0.5" y2="1">
    <stop offset="0" stop-color="#080b14"/>
    <stop offset="1" stop-color="#04060c"/>
  </linearGradient>
  <radialGradient id="aura" cx="15%" cy="10%" r="65%">
    <stop offset="0" stop-color="#f0a030" stop-opacity="0.09"/>
    <stop offset="1" stop-color="#f0a030" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="topAura" cx="50%" cy="30%" r="55%">
    <stop offset="0" stop-color="#ffd700" stop-opacity="0.06"/>
    <stop offset="1" stop-color="#ffd700" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="glass" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="rgba(255,255,255,0.07)"/>
    <stop offset="1" stop-color="rgba(255,255,255,0.02)"/>
  </linearGradient>
  <linearGradient id="goldLine" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#ffd060"/>
    <stop offset="0.5" stop-color="#f0a030"/>
    <stop offset="1" stop-color="#c97d10"/>
  </linearGradient>
  <pattern id="dots" width="40" height="40" patternUnits="userSpaceOnUse">
    <circle cx="20" cy="20" r="0.9" fill="rgba(255,255,255,0.06)"/>
  </pattern>
  <filter id="sh" x="-20%" y="-20%" width="140%" height="140%">
    <feDropShadow dx="0" dy="6" stdDeviation="14" flood-color="#000" flood-opacity="0.75"/>
  </filter>
  <filter id="glowGold" x="-40%" y="-40%" width="180%" height="180%">
    <feGaussianBlur stdDeviation="6" result="b"/>
    <feColorMatrix in="b" type="matrix" values="1 0 0 0 0.4  0.5 0 0 0 0.25  0 0 0 0 0  0 0 0 0.35 0" result="g"/>
    <feMerge><feMergeNode in="g"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
  <filter id="glowGreen" x="-40%" y="-40%" width="180%" height="180%">
    <feGaussianBlur stdDeviation="6" result="b"/>
    <feColorMatrix in="b" type="matrix" values="0 0 0 0 0  1 0 0 0 0.4  0 0 0 0 0.2  0 0 0 0.4 0" result="g"/>
    <feMerge><feMergeNode in="g"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
  <filter id="glowRed" x="-40%" y="-40%" width="180%" height="180%">
    <feGaussianBlur stdDeviation="6" result="b"/>
    <feColorMatrix in="b" type="matrix" values="1 0 0 0 0.5  0 0 0 0 0  0 0 0 0 0.1  0 0 0 0.4 0" result="g"/>
    <feMerge><feMergeNode in="g"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
</defs>

<rect width="${W}" height="${H}" fill="url(#bg)"/>
<rect width="${W}" height="${H}" fill="url(#dots)"/>
<rect width="${W}" height="${H}" fill="url(#aura)"/>
<rect width="${W}" height="${H}" fill="url(#topAura)"/>
<rect x="0" y="0" width="5" height="${H}" fill="url(#goldLine)"/>
<rect x="22" y="22" width="${W - 44}" height="${H - 44}" rx="26" fill="none" stroke="rgba(255,255,255,0.055)" stroke-width="1.5"/>

<text x="50" y="78" font-family="Inter,Segoe UI,Arial" font-size="42" fill="#f0a030" font-weight="900" letter-spacing="1.5" filter="url(#glowGold)">FLEXBOT</text>
<text x="${W - 50}" y="78" text-anchor="end" font-family="Inter,Segoe UI,Arial" font-size="22" fill="rgba(255,255,255,0.40)" font-weight="600" letter-spacing="4">TOP TRADES</text>
<line x1="50" y1="96" x2="${W - 50}" y2="96" stroke="rgba(240,160,48,0.15)" stroke-width="1"/>

<text x="${W / 2}" y="170" text-anchor="middle" font-family="Inter,Segoe UI,Arial" font-size="46" fill="#ffffff" font-weight="900">TOP 3 TRADES OF THE DAY</text>
${sub ? `<text x="${W / 2}" y="216" text-anchor="middle" font-family="Inter,Segoe UI,Arial" font-size="26" fill="rgba(255,255,255,0.50)" font-weight="500">${esc(sub)}</text>` : ""}

<circle cx="${W / 2}" cy="278" r="26" fill="rgba(255,215,0,0.07)" stroke="rgba(255,215,0,0.18)" stroke-width="1.5"/>
<text x="${W / 2}" y="288" text-anchor="middle" font-family="Inter,Segoe UI,Arial" font-size="26" fill="rgba(255,215,0,0.65)" font-weight="900">★</text>

${cardsSvg}

<rect x="0" y="${H - 60}" width="${W}" height="60" fill="rgba(0,0,0,0.40)"/>
<line x1="5" y1="${H - 60}" x2="${W}" y2="${H - 60}" stroke="rgba(240,160,48,0.18)" stroke-width="1"/>
${logoDataUri
  ? `<g opacity="0.90"><image x="${(W - 200) / 2}" y="${H - 52}" width="200" height="44" href="${logoDataUri}" preserveAspectRatio="xMidYMid meet"/></g>`
  : `<text x="${W / 2}" y="${H - 18}" text-anchor="middle" font-family="Inter,Segoe UI,Arial" font-size="22" fill="rgba(240,160,48,0.80)" letter-spacing="8" font-weight="900">FLEXBOT</text>`}
</svg>`;
}

function createWeeklyRecapSvg({ symbol, weekLabel, totalTrades, totalUsdStr, totalPctStr, days }) {
  const W = 1080, H = 1080, pad = 52;
  const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const sub = String(weekLabel || "").trim();
  const isNeg = String(totalUsdStr || "").trim().startsWith("-");
  const pnlColor = isNeg ? "#ff4757" : "#00d084";

  const dayRows = Array.isArray(days) ? days : [];
  const pnlTot = esc(String(totalUsdStr || "-"));
  const pctTot = totalPctStr ? esc(String(totalPctStr)) : "";
  // Summary card: PnL spans center area (~320px wide), fit font dynamically
  const totFs = Math.min(48, Math.max(26, Math.floor(300 / (pnlTot.length * 0.58))));
  const borderColor = isNeg ? "rgba(255,71,87,0.25)" : "rgba(0,208,132,0.25)";

  const logoDataUri = (() => {
    try {
      const p = path.join(__dirname, "assets", "recap_flexbot_logo.png");
      if (!fs.existsSync(p)) return null;
      return `data:image/png;base64,${fs.readFileSync(p).toString("base64")}`;
    } catch { return null; }
  })();

  const colorPnl = usdStr => {
    const s = String(usdStr || "");
    if (s.includes("-")) return "#ff4757";
    if (s.includes("+")) return "#00d084";
    return "rgba(255,255,255,0.85)";
  };

  const rowY0 = 276;
  const rowH = 104;
  const rowRectH = 90;
  const summaryY = rowY0 + 5 * rowH + 32;

  const colsSvg = `<text x="${pad + 204}" y="${rowY0 - 16}" text-anchor="middle" font-family="Inter,Segoe UI,Arial" font-size="17" fill="rgba(255,255,255,0.35)" letter-spacing="2">TRADES</text>
<text x="${W / 2}" y="${rowY0 - 16}" text-anchor="middle" font-family="Inter,Segoe UI,Arial" font-size="17" fill="rgba(255,255,255,0.35)" letter-spacing="2">PnL</text>
<text x="${W - pad - 64}" y="${rowY0 - 16}" text-anchor="end" font-family="Inter,Segoe UI,Arial" font-size="17" fill="rgba(255,255,255,0.35)" letter-spacing="2">%</text>`;

  const rowsSvg = dayRows.slice(0, 5).map((d, i) => {
    const y = rowY0 + i * rowH;
    const label = esc(d?.label ?? "-");
    const trades = esc(String(d?.trades ?? "-"));
    const usdStr = esc(String(d?.usdStr ?? "-"));
    const pctStr = esc(String(d?.pctStr ?? ""));
    const fill = colorPnl(d?.usdStr);
    const alt = i % 2 === 0 ? "rgba(255,255,255,0.025)" : "transparent";
    const hasData = d?.trades && String(d.trades) !== "0" && String(d.trades) !== "-";
    // PnL column spans center (~250px available), % column spans right side (~200px)
    const rowPnlFs = Math.min(36, Math.max(20, Math.floor(240 / (usdStr.length * 0.58))));
    const rowPctFs = Math.min(32, Math.max(18, Math.floor(180 / (pctStr.length * 0.60))));
    return `<g>
  <rect x="${pad}" y="${y}" width="${W - pad * 2}" height="${rowRectH}" rx="16" fill="${alt}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
  <rect x="${pad}" y="${y}" width="4" height="${rowRectH}" rx="2" fill="${hasData ? fill : "rgba(255,255,255,0.15)"}" opacity="${hasData ? 0.7 : 0.3}"/>
  <text x="${pad + 30}" y="${y + 57}" font-family="Inter,Segoe UI,Arial" font-size="36" fill="${hasData ? "#ffffff" : "rgba(255,255,255,0.38)"}" font-weight="900">${label}</text>
  <text x="${pad + 204}" y="${y + 62}" text-anchor="middle" font-family="Inter,Segoe UI,Arial" font-size="36" fill="${hasData ? "#ffffff" : "rgba(255,255,255,0.30)"}" font-weight="900" style="font-variant-numeric: tabular-nums;">${trades}</text>
  <text x="${W / 2}" y="${y + 62}" text-anchor="middle" font-family="Inter,Segoe UI,Arial" font-size="${rowPnlFs}" fill="${hasData ? fill : "rgba(255,255,255,0.25)"}" font-weight="900" style="font-variant-numeric: tabular-nums;">${usdStr}</text>
  ${pctStr ? `<text x="${W - pad - 52}" y="${y + 58}" text-anchor="end" font-family="Inter,Segoe UI,Arial" font-size="${rowPctFs}" fill="${hasData ? fill : "rgba(255,255,255,0.25)"}" font-weight="900" style="font-variant-numeric: tabular-nums;">${pctStr}</text>` : ""}
</g>`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0.5" y2="1">
    <stop offset="0" stop-color="#080b14"/>
    <stop offset="1" stop-color="#04060c"/>
  </linearGradient>
  <radialGradient id="aura" cx="15%" cy="10%" r="65%">
    <stop offset="0" stop-color="#f0a030" stop-opacity="0.09"/>
    <stop offset="1" stop-color="#f0a030" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="pnlAura" cx="62%" cy="78%" r="45%">
    <stop offset="0" stop-color="${pnlColor}" stop-opacity="0.07"/>
    <stop offset="1" stop-color="${pnlColor}" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="glass" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="rgba(255,255,255,0.07)"/>
    <stop offset="1" stop-color="rgba(255,255,255,0.02)"/>
  </linearGradient>
  <linearGradient id="goldLine" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#ffd060"/>
    <stop offset="0.5" stop-color="#f0a030"/>
    <stop offset="1" stop-color="#c97d10"/>
  </linearGradient>
  <pattern id="dots" width="40" height="40" patternUnits="userSpaceOnUse">
    <circle cx="20" cy="20" r="0.9" fill="rgba(255,255,255,0.06)"/>
  </pattern>
  <filter id="sh" x="-20%" y="-20%" width="140%" height="140%">
    <feDropShadow dx="0" dy="6" stdDeviation="14" flood-color="#000" flood-opacity="0.75"/>
  </filter>
  <filter id="glowPnl" x="-40%" y="-40%" width="180%" height="180%">
    <feGaussianBlur stdDeviation="7" result="b"/>
    <feColorMatrix in="b" type="matrix" values="${isNeg ? "1 0 0 0 0.45  0 0 0 0 0  0 0 0 0 0.05  0 0 0 0.4 0" : "0 0 0 0 0  1 0 0 0 0.45  0 0 0 0 0.25  0 0 0 0.4 0"}" result="g"/>
    <feMerge><feMergeNode in="g"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
  <filter id="glowGold" x="-40%" y="-40%" width="180%" height="180%">
    <feGaussianBlur stdDeviation="5" result="b"/>
    <feColorMatrix in="b" type="matrix" values="1 0 0 0 0.4  0.5 0 0 0 0.25  0 0 0 0 0  0 0 0 0.35 0" result="g"/>
    <feMerge><feMergeNode in="g"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
</defs>

<rect width="${W}" height="${H}" fill="url(#bg)"/>
<rect width="${W}" height="${H}" fill="url(#dots)"/>
<rect width="${W}" height="${H}" fill="url(#aura)"/>
<rect width="${W}" height="${H}" fill="url(#pnlAura)"/>
<rect x="0" y="0" width="5" height="${H}" fill="url(#goldLine)"/>
<rect x="22" y="22" width="${W - 44}" height="${H - 44}" rx="26" fill="none" stroke="rgba(255,255,255,0.055)" stroke-width="1.5"/>

<text x="50" y="78" font-family="Inter,Segoe UI,Arial" font-size="42" fill="#f0a030" font-weight="900" letter-spacing="1.5" filter="url(#glowGold)">FLEXBOT</text>
<text x="${W - 50}" y="78" text-anchor="end" font-family="Inter,Segoe UI,Arial" font-size="22" fill="rgba(255,255,255,0.40)" font-weight="600" letter-spacing="4">WEEKLY RECAP</text>
<line x1="50" y1="96" x2="${W - 50}" y2="96" stroke="rgba(240,160,48,0.15)" stroke-width="1"/>

${sub ? `<text x="${W / 2}" y="144" text-anchor="middle" font-family="Inter,Segoe UI,Arial" font-size="27" fill="rgba(255,255,255,0.58)" font-weight="600">${esc(sub)}</text>` : ""}

<line x1="${pad}" y1="${rowY0 - 32}" x2="${W - pad}" y2="${rowY0 - 32}" stroke="rgba(240,160,48,0.08)" stroke-width="1"/>
${colsSvg}

${rowsSvg}

<g filter="url(#sh)">
  <rect x="${pad}" y="${summaryY}" width="${W - pad * 2}" height="120" rx="20" fill="url(#glass)" stroke="${borderColor}" stroke-width="1.5"/>
  <rect x="${pad}" y="${summaryY}" width="4" height="120" rx="2" fill="${pnlColor}" opacity="0.70"/>
  <text x="${pad + 200}" y="${summaryY + 42}" text-anchor="middle" font-family="Inter,Segoe UI,Arial" font-size="17" fill="rgba(255,255,255,0.40)" letter-spacing="2">TOTAL TRADES</text>
  <text x="${pad + 200}" y="${summaryY + 96}" text-anchor="middle" font-family="Inter,Segoe UI,Arial" font-size="56" fill="#ffffff" font-weight="900" style="font-variant-numeric: tabular-nums;">${esc(String(totalTrades ?? "-"))}</text>
  <text x="${W / 2}" y="${summaryY + 42}" text-anchor="middle" font-family="Inter,Segoe UI,Arial" font-size="17" fill="rgba(255,255,255,0.40)" letter-spacing="2">TOTAL PnL</text>
  <text x="${W / 2}" y="${summaryY + 96}" text-anchor="middle" font-family="Inter,Segoe UI,Arial" font-size="${totFs}" fill="${pnlColor}" font-weight="900" filter="url(#glowPnl)" style="font-variant-numeric: tabular-nums;">${pnlTot}</text>
  ${pctTot ? `<text x="${W - pad - 60}" y="${summaryY + 42}" text-anchor="end" font-family="Inter,Segoe UI,Arial" font-size="17" fill="rgba(255,255,255,0.40)" letter-spacing="2">CHANGE</text>
  <text x="${W - pad - 60}" y="${summaryY + 96}" text-anchor="end" font-family="Inter,Segoe UI,Arial" font-size="${totFs}" fill="${pnlColor}" font-weight="900" filter="url(#glowPnl)" style="font-variant-numeric: tabular-nums;">${pctTot}</text>` : ""}
</g>

<rect x="0" y="${H - 60}" width="${W}" height="60" fill="rgba(0,0,0,0.40)"/>
<line x1="5" y1="${H - 60}" x2="${W}" y2="${H - 60}" stroke="rgba(240,160,48,0.18)" stroke-width="1"/>
${logoDataUri
  ? `<g opacity="0.88"><image x="${(W - 200) / 2}" y="${H - 52}" width="200" height="44" href="${logoDataUri}" preserveAspectRatio="xMidYMid meet"/></g>`
  : `<text x="${W / 2}" y="${H - 18}" text-anchor="middle" font-family="Inter,Segoe UI,Arial" font-size="22" fill="rgba(240,160,48,0.80)" letter-spacing="8" font-weight="900">FLEXBOT</text>`}
</svg>`;
}

// POST /auto/scalp/run?symbol=XAUUSD
// Fully server-side: blackout + cooldown + claim + create signal + post ONE telegram photo.
async function autoScalpRunHandler(req, res) {
  try {
    const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : "XAUUSD";
    const cooldownMin = req.query.cooldown_min != null ? Number(req.query.cooldown_min) : 15;

    // Risk/strategy env
    const riskTz = String(process.env.RISK_TZ || "Europe/Prague");
    const maxDailyLossPctRaw = Number(process.env.MAX_DAILY_LOSS_PCT || 15);
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
    const blackoutR = await fetchJson(`${INTERNAL_BASE}/news/blackout?currency=USD&impact=high&window_min=30`);
    if (!blackoutR?.ok) return res.status(502).json({ ok: false, error: "blackout_check_failed" });
    if (blackoutR.blackout) return res.json({ ok: true, acted: false, reason: "blackout" });

    // 2) cooldown
    const cd = await fetchJson(`${INTERNAL_BASE}/ea/cooldown/status?symbol=${encodeURIComponent(symbol)}&cooldown_min=${encodeURIComponent(String(cooldownMin))}`);
    if (!cd?.ok) return res.status(502).json({ ok: false, error: "cooldown_status_failed" });
    if (!cd.has_last_trade) return res.json({ ok: true, acted: false, reason: "no_last_trade" });
    if (cd.remaining_ms > 0) return res.json({ ok: true, acted: false, reason: "cooldown" });

    // Use a rolling time bucket as claim key so we can retry periodically even if a prior attempt failed.
    // Cooldown gate above still prevents rapid re-entries.
    const scalpBucketMs = 5 * 60 * 1000;
    const refMs = Math.floor(Date.now() / scalpBucketMs) * scalpBucketMs;

    // 3) claim lock (once per bucket)
    const claim = await fetchJson(`${INTERNAL_BASE}/ea/auto/claim?symbol=${encodeURIComponent(symbol)}&kind=auto_scalp_v1&ref_ms=${encodeURIComponent(String(refMs))}`);
    if (!claim?.ok) return res.status(502).json({ ok: false, error: "claim_failed" });
    if (!claim.notify) return res.json({ ok: true, acted: false, reason: "claimed" });

    // 4) candles (5m)
    const candles = await fetchJson(`${INTERNAL_BASE}/candles?symbol=${encodeURIComponent(symbol)}&interval=5m&limit=120`);
    if (!candles?.ok || !Array.isArray(candles?.candles)) return res.status(502).json({ ok: false, error: "candles_failed" });
    const arr = candles.candles;
    if (arr.length < 12) return res.status(502).json({ ok: false, error: "candles_insufficient" });

    const last12 = arr.slice(-12);
    const rangeHigh = Math.max(...last12.map((c) => Number(c.high)));
    const rangeLow = Math.min(...last12.map((c) => Number(c.low)));
    const entry = Number(last12[last12.length - 1].close);

    const biasR = trendBiasFromCandles(arr, 10, 30);
    if (!biasR.ok) return res.json({ ok: true, acted: false, reason: "no_trend_bias" });
    const direction = biasR.bias;

    // RSI filter: DISABLED (backtest showed better results without it)
    // const rsiVal = rsi(arr, 14);

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

    // 5) Fixed SL/TP: always 1000 pts SL, 1.5x RR for TP.
    // This gives consistent lot sizes (~0.50 at 100k with 0.5% risk).
    const pointRaw = Number(process.env.XAUUSD_POINT || 0.01);
    const point = Number.isFinite(pointRaw) && pointRaw > 0 ? pointRaw : 0.01;

    const fixedSlPts = Number(process.env.AUTO_SCALP_FIXED_SL_POINTS || 1000);
    const fixedRr = 1.5;

    const slPts = fixedSlPts;
    const slDist = slPts * point; // 1000 pts = 10.00

    const sl = direction === "SELL" ? entry + slDist : entry - slDist;
    const tp = direction === "SELL" ? entry - slDist * fixedRr : entry + slDist * fixedRr;

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

    // Safety guards (with fixed SL/TP these should always pass, but protect against NaN)
    const minTpPts = Number(process.env.AUTO_SCALP_MIN_TP_PTS || 200);
    const maxRr = Number(process.env.AUTO_SCALP_MAX_RR || 5);
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

    const p = await fetchJson(`${INTERNAL_BASE}/price?symbol=${encodeURIComponent(symbol)}`);
    const c15 = await fetchJson(`${INTERNAL_BASE}/candles?symbol=${encodeURIComponent(symbol)}&interval=15m&limit=192`);
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

    // Use Amsterdam start-of-day (rollover expectation).
    const startMs = startOfDayMsInTz("Europe/Amsterdam");
    const startMsSafe = Number.isFinite(startMs)
      ? startMs
      : (() => {
          const s = new Date();
          s.setHours(0, 0, 0, 0);
          return s.getTime();
        })();

    // Closed trades only.
    const q = await db.execute({
      sql:
        "SELECT id,direction,close_outcome,close_result,closed_at_ms FROM signals " +
        "WHERE symbol=? AND status='closed' AND closed_at_ms IS NOT NULL AND closed_at_ms >= ? " +
        "ORDER BY closed_at_ms ASC",
      args: [symbol, startMsSafe],
    });

    const rows = q.rows || [];

    const parseUsd = (s) => {
      const raw = String(s ?? "");
      const n = Number(raw.replace(/[^0-9.+-]/g, ""));
      return Number.isFinite(n) ? n : 0;
    };

    const items = rows.map((r) => {
      const dir = r.direction != null ? String(r.direction).toUpperCase() : "-";
      const out = r.close_outcome != null ? String(r.close_outcome) : "-";
      const resu = r.close_result != null ? String(r.close_result) : "-";
      const usd = parseUsd(resu);
      return { dir, out, resu, usd };
    });

    const totalUsd = items.reduce((a, x) => a + (Number.isFinite(x.usd) ? x.usd : 0), 0);

    // Percent: use stored daily start BALANCE (written by /ea/status) if available.
    let startBalance = null;
    try {
      const fp = riskStatePath("balance-day", symbol);
      const st = readJsonFileSafe(fp, null);
      if (st && Number.isFinite(Number(st.startBalance)) && Number(st.startBalance) > 0) {
        startBalance = Number(st.startBalance);
      }
    } catch {
      startBalance = null;
    }
    if (startBalance == null) {
      const envBal = Number(process.env.DAILY_START_BALANCE_USD || process.env.START_BALANCE_USD || 0);
      if (Number.isFinite(envBal) && envBal > 0) startBalance = envBal;
    }

    const pct = startBalance ? (totalUsd / startBalance) * 100 : null;

    const sign = (n) => (n > 0 ? "+" : n < 0 ? "-" : "");
    const fmtNum = (n) => {
      const v = Math.abs(Number(n) || 0);
      try {
        return new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
      } catch {
        return v.toFixed(2);
      }
    };
    const fmtUsd = (n) => `${sign(n)}${fmtNum(n)} USD`;
    const fmtPct = (n) => `${sign(n)}${fmtNum(n)}%`;

    if (!items.length) {
      await tgSendMessage({ chatId, text: `#RECAP ${symbol}\nNo closed trades today.` });
      return res.json({ ok: true, acted: true, closed: 0, totalUsd: 0, start_ms: startMsSafe });
    }

    const lines = items.map((x, i) => {
      let outShort = String(x.out || "-").replace(/\s+/g, " ").trim();
      // Shorten: "SL hit" -> "SL" (Boss request)
      if (outShort.toLowerCase() === "sl hit") outShort = "SL";

      const resShort = String(x.resu || "-").replace(/\s+/g, " ").trim();
      return `${i + 1}) ${x.dir} | ${outShort} | ${resShort}`;
    });

    const dayLabel = (() => {
      try {
        const dk = dayKeyInTz("Europe/Amsterdam");
        return `Day: ${dk}`;
      } catch {
        return "";
      }
    })();

    const totalUsdStr = fmtUsd(totalUsd);
    const totalPctStr = pct != null ? fmtPct(pct) : null;

    // Render recap as PNG pages.
    // Keep in sync with createDailyRecapSvg layout constants.
    const perPage = lines.length > 10 ? 18 : 12;
    const pages = Math.max(1, Math.ceil(lines.length / perPage));
    for (let p = 0; p < pages; p++) {
      const chunk = lines.slice(p * perPage, (p + 1) * perPage);
      const svg = createDailyRecapSvg({
        symbol,
        dayLabel,
        closedCount: items.length,
        totalUsdStr,
        totalPctStr,
        lines: chunk,
        page: p + 1,
        pages,
      });
      const pngBuf = renderSvgToPngBuffer(svg);
      await tgSendPhoto({ chatId, photo: pngBuf, caption: p === 0 ? `#RECAP ${symbol}` : undefined });
    }

    // Post TOP 3 trades of the day (by +USD) after the recap.
    const top = items
      .filter((x) => Number.isFinite(x.usd) && x.usd > 0)
      .slice()
      .sort((a, b) => (b.usd || 0) - (a.usd || 0))
      .slice(0, 3)
      .map((x, i) => ({
        rank: i + 1,
        dir: x.dir,
        out: String(x.out || "").toUpperCase().includes("TP") ? "TP" : "",
        usdStr: fmtUsd(x.usd),
      }));
    if (top.length) {
      const svgTop = createTopTradesSvg({ symbol, dayLabel, items: top });
      const pngTop = renderSvgToPngBuffer(svgTop);
      await tgSendPhoto({ chatId, photo: pngTop, caption: "TOP TRADES" });
    }

    return res.json({ ok: true, acted: true, closed: items.length, totalUsd, pct, startEquity, start_ms: startMsSafe, pages, top_trades_posted: top.length });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "auto_daily_recap_failed", message: String(e?.message || e) });
  }
}
app.post("/auto/daily/recap/run", autoDailyRecapHandler);
app.get("/auto/daily/recap/run", autoDailyRecapHandler);

// GET/POST /auto/daily/toptrades/run (posts TOP 3 by +USD)
async function autoDailyTopTradesHandler(req, res) {
  try {
    const db = await getDb();
    const chatId = process.env.TELEGRAM_CHAT_ID || "-1003611276978";

    if (!db) {
      await tgSendMessage({ chatId, text: "TOP TRADES\nNo data." });
      return res.json({ ok: true, acted: true, reason: "no_db" });
    }

    const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : "XAUUSD";
    const startMs = startOfDayMsInTz("Europe/Amsterdam");

    const q = await db.execute({
      sql:
        "SELECT direction,close_outcome,close_result,closed_at_ms FROM signals " +
        "WHERE symbol=? AND status='closed' AND closed_at_ms IS NOT NULL AND closed_at_ms >= ? " +
        "ORDER BY closed_at_ms ASC",
      args: [symbol, startMs],
    });

    const rows = q.rows || [];

    const parseUsd = (s) => {
      const raw = String(s ?? "");
      const n = Number(raw.replace(/[^0-9.+-]/g, ""));
      return Number.isFinite(n) ? n : 0;
    };

    const items = rows.map((r) => {
      const dir = r.direction != null ? String(r.direction).toUpperCase() : "-";
      const out = r.close_outcome != null ? String(r.close_outcome) : "-";
      const resu = r.close_result != null ? String(r.close_result) : "-";
      const usd = parseUsd(resu);
      return { dir, out, resu, usd };
    });

    const sign = (n) => (n > 0 ? "+" : n < 0 ? "-" : "");
    const fmtNum = (n) => {
      const v = Math.abs(Number(n) || 0);
      try {
        return new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
      } catch {
        return v.toFixed(2);
      }
    };
    const fmtUsd = (n) => `${sign(n)}${fmtNum(n)} USD`;

    const dayLabel = (() => {
      try {
        const dk = dayKeyInTz("Europe/Amsterdam");
        return `Day: ${dk}`;
      } catch {
        return "";
      }
    })();

    const top = items
      .filter((x) => Number.isFinite(x.usd) && x.usd > 0)
      .slice()
      .sort((a, b) => (b.usd || 0) - (a.usd || 0))
      .slice(0, 3)
      .map((x, i) => ({
        rank: i + 1,
        dir: x.dir,
        out: String(x.out || "").toUpperCase().includes("TP") ? "TP" : "",
        usdStr: fmtUsd(x.usd),
      }));

    if (!top.length) {
      await tgSendMessage({ chatId, text: "TOP TRADES\nNo winning trades today." });
      return res.json({ ok: true, acted: true, posted: 0 });
    }

    const svg = createTopTradesSvg({ symbol, dayLabel, items: top });
    const pngBuf = renderSvgToPngBuffer(svg);
    await tgSendPhoto({ chatId, photo: pngBuf, caption: "TOP TRADES" });

    return res.json({ ok: true, acted: true, posted: top.length, symbol, startMs });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "auto_daily_toptrades_failed", message: String(e?.message || e) });
  }
}
app.post("/auto/daily/toptrades/run", autoDailyTopTradesHandler);
app.get("/auto/daily/toptrades/run", autoDailyTopTradesHandler);

// GET/POST /auto/weekly/recap/run (Mon–Fri mini overview, posts 1 PNG)
async function autoWeeklyRecapHandler(req, res) {
  try {
    const db = await getDb();
    const chatId = process.env.TELEGRAM_CHAT_ID || "-1003611276978";

    if (!db) {
      await tgSendMessage({ chatId, text: "WEEKLY RECAP\nNo data." });
      return res.json({ ok: true, acted: true, reason: "no_db" });
    }

    const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : "XAUUSD";

    // Range: Monday 00:00 → Friday 00:00 (Amsterdam). At Fri 00:00 this covers Mon–Thu closes.
    const nowMs = Date.now();
    const parts = inAmsterdamParts(nowMs);
    const d = new Date(Date.UTC(parts.y, parts.m - 1, parts.d, 0, 0, 0, 0));
    // JS: 0=Sun..6=Sat; we want Monday as 1
    const dow = d.getUTCDay();
    const mondayOffset = (dow + 6) % 7; // Mon->0, Tue->1, ... Sun->6
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - mondayOffset);
    const startMs = monday.getTime();
    const endMs = startMs + 4 * 24 * 60 * 60 * 1000; // Fri 00:00

    const q = await db.execute({
      sql:
        "SELECT direction,close_outcome,close_result,closed_at_ms FROM signals " +
        "WHERE symbol=? AND status='closed' AND closed_at_ms IS NOT NULL AND closed_at_ms >= ? AND closed_at_ms < ? " +
        "ORDER BY closed_at_ms ASC",
      args: [symbol, startMs, endMs],
    });

    const rows = q.rows || [];

    const parseUsd = (s) => {
      const raw = String(s ?? "");
      const n = Number(raw.replace(/[^0-9.+-]/g, ""));
      return Number.isFinite(n) ? n : 0;
    };

    // Use stored daily start equity (same as daily recap) for pct approximation.
    let startEquity = null;
    try {
      const fp = riskStatePath("risk-day", symbol);
      const st = readJsonFileSafe(fp, null);
      if (st && Number.isFinite(Number(st.startEquity)) && Number(st.startEquity) > 0) {
        startEquity = Number(st.startEquity);
      }
    } catch {
      startEquity = null;
    }
    if (startEquity == null) {
      const envEq = Number(process.env.DAILY_START_EQUITY_USD || process.env.START_EQUITY_USD || 0);
      if (Number.isFinite(envEq) && envEq > 0) startEquity = envEq;
    }

    const sign = (n) => (n > 0 ? "+" : n < 0 ? "-" : "");
    const fmtNum = (n) => {
      const v = Math.abs(Number(n) || 0);
      try {
        return new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
      } catch {
        return v.toFixed(2);
      }
    };
    const fmtUsd = (n) => `${sign(n)}${fmtNum(n)} USD`;
    const fmtPct = (n) => `${sign(n)}${fmtNum(n)}%`;

    const dayKey = (tsMs) => {
      const p = inAmsterdamParts(tsMs);
      return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
    };

    // Prepare buckets for Mon–Fri
    const days = [];
    const labels = ["Mon", "Tue", "Wed", "Thu", "Fri"];
    for (let i = 0; i < 5; i++) {
      const t0 = startMs + i * 24 * 60 * 60 * 1000;
      days.push({
        label: labels[i],
        key: dayKey(t0),
        trades: 0,
        usd: 0,
      });
    }

    for (const r of rows) {
      const ts = Number(r.closed_at_ms);
      if (!Number.isFinite(ts)) continue;
      const k = dayKey(ts);
      const idx = days.findIndex((d) => d.key === k);
      if (idx < 0) continue;
      days[idx].trades += 1;
      days[idx].usd += parseUsd(r.close_result);
    }

    const totalTrades = days.reduce((a, d) => a + d.trades, 0);
    const totalUsd = days.reduce((a, d) => a + d.usd, 0);
    const totalPct = startEquity ? (totalUsd / startEquity) * 100 : null;

    const weekLabel = (() => {
      const p0 = inAmsterdamParts(startMs);
      const p1 = inAmsterdamParts(endMs - 1);
      const a = `${p0.y}-${String(p0.m).padStart(2, "0")}-${String(p0.d).padStart(2, "0")}`;
      const b = `${p1.y}-${String(p1.m).padStart(2, "0")}-${String(p1.d).padStart(2, "0")}`;
      return `Week: ${a} → ${b}`;
    })();

    const dayOut = days.map((d) => ({
      label: d.label,
      trades: d.trades,
      usdStr: d.trades ? fmtUsd(d.usd) : "0.00 USD",
      pctStr: startEquity && d.trades ? fmtPct((d.usd / startEquity) * 100) : "",
    }));

    const svg = createWeeklyRecapSvg({
      symbol,
      weekLabel,
      totalTrades,
      totalUsdStr: fmtUsd(totalUsd),
      totalPctStr: totalPct != null ? fmtPct(totalPct) : "",
      days: dayOut,
    });

    const pngBuf = renderSvgToPngBuffer(svg);
    await tgSendPhoto({ chatId, photo: pngBuf, caption: "WEEKLY RECAP" });

    return res.json({ ok: true, acted: true, symbol, startMs, endMs, totalTrades, totalUsd, totalPct, startEquity });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "auto_weekly_recap_failed", message: String(e?.message || e) });
  }
}
app.post("/auto/weekly/recap/run", autoWeeklyRecapHandler);
app.get("/auto/weekly/recap/run", autoWeeklyRecapHandler);

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

// ============================================================
// MISSION CONTROL
// ============================================================

function mcAuthDashboard(req, res) {
  const key = req.query.key ? String(req.query.key) : "";
  const expected = process.env.DASHBOARD_KEY ? String(process.env.DASHBOARD_KEY) : "";
  if (!expected || !key || key !== expected) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return false;
  }
  return true;
}

function mcAuthBot(req, res) {
  const apiKey = req.header("x-api-key") || req.query.key || "";
  // BOT_API_KEY voor OpenClaw bots; valt terug op EA_API_KEY voor backwards compat
  const expected = String(process.env.BOT_API_KEY || process.env.EA_API_KEY || "");
  const dashKey = String(process.env.DASHBOARD_KEY || "");
  if ((!expected || apiKey !== expected) && (!dashKey || apiKey !== dashKey)) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return false;
  }
  return true;
}

// POST /api/mc/bot/heartbeat  (X-API-Key: EA_API_KEY)
// GET  /api/mc/bot/heartbeat?bot_id=...&status=...&last_action=...  (X-API-Key: EA_API_KEY)
async function mcHeartbeatHandler(req, res) {
  if (!mcAuthBot(req, res)) return;
  try {
    const db = await getDb();
    if (!db) return res.status(503).json({ ok: false, error: "db_unavailable" });

    let body = {};
    try { body = JSON.parse(typeof req.body === "string" ? req.body : JSON.stringify(req.body)); } catch { /* ignore */ }

    const bot_id = String(body.bot_id || req.query.bot_id || "").trim();
    const name = String(body.name || req.query.name || body.bot_id || req.query.bot_id || "").trim();
    const status = String(body.status || req.query.status || "online").trim();
    const last_action = String(body.last_action || req.query.last_action || "").trim();

    if (!bot_id) return res.status(400).json({ ok: false, error: "bot_id_required" });

    await db.execute({
      sql: "INSERT OR REPLACE INTO bot_heartbeats (bot_id, name, status, last_action, updated_at_ms) VALUES (?,?,?,?,?)",
      args: [bot_id, name, status, last_action, Date.now()],
    });

    return res.json({ ok: true, bot_id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
app.post("/api/mc/bot/heartbeat", mcHeartbeatHandler);
app.get("/api/mc/bot/heartbeat", mcHeartbeatHandler);

// GET /api/mc/bot/commands  (X-API-Key: EA_API_KEY)
app.get("/api/mc/bot/commands", async (req, res) => {
  if (!mcAuthBot(req, res)) return;
  try {
    const db = await getDb();
    if (!db) return res.status(503).json({ ok: false, error: "db_unavailable" });

    const bot_id = req.query.bot_id ? String(req.query.bot_id).trim() : "";
    if (!bot_id) return res.status(400).json({ ok: false, error: "bot_id_required" });

    const rows = await db.execute({
      sql: "SELECT id, command, created_at_ms FROM bot_commands WHERE bot_id=? AND executed_at_ms IS NULL ORDER BY id ASC LIMIT 10",
      args: [bot_id],
    });

    const commands = (rows.rows || []).map((r) => ({
      id: Number(r.id),
      command: String(r.command),
      created_at_ms: Number(r.created_at_ms),
    }));

    // Mark fetched commands as executed
    if (commands.length > 0) {
      const ids = commands.map((c) => c.id);
      for (const id of ids) {
        await db.execute({
          sql: "UPDATE bot_commands SET executed_at_ms=? WHERE id=?",
          args: [Date.now(), id],
        });
      }
    }

    return res.json({ ok: true, bot_id, commands });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// POST /api/mc/bot/command  (?key=DASHBOARD_KEY)
app.post("/api/mc/bot/command", async (req, res) => {
  if (!mcAuthDashboard(req, res)) return;
  try {
    const db = await getDb();
    if (!db) return res.status(503).json({ ok: false, error: "db_unavailable" });

    let body = {};
    try { body = JSON.parse(typeof req.body === "string" ? req.body : JSON.stringify(req.body)); } catch { /* ignore */ }

    const bot_id = String(body.bot_id || req.query.bot_id || "").trim();
    const command = String(body.command || req.query.command || "").trim();

    if (!bot_id) return res.status(400).json({ ok: false, error: "bot_id_required" });
    if (!["start", "stop", "restart"].includes(command)) {
      return res.status(400).json({ ok: false, error: "invalid_command", allowed: ["start", "stop", "restart"] });
    }

    await db.execute({
      sql: "INSERT INTO bot_commands (bot_id, command, created_at_ms) VALUES (?,?,?)",
      args: [bot_id, command, Date.now()],
    });

    return res.json({ ok: true, bot_id, command });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// DELETE /api/mc/ea  (?key=DASHBOARD_KEY&account_login=...&server=...&symbol=...)
app.delete("/api/mc/ea", async (req, res) => {
  if (!mcAuthDashboard(req, res)) return;
  try {
    const db = await getDb();
    if (!db) return res.status(503).json({ ok: false, error: "db_unavailable" });
    const account_login = String(req.query.account_login || "").trim();
    const server = String(req.query.server || "").trim();
    const symbol = String(req.query.symbol || "XAUUSD").toUpperCase();
    if (!account_login) return res.status(400).json({ ok: false, error: "account_login_required" });
    await db.execute({
      sql: "DELETE FROM ea_positions WHERE account_login=? AND server=? AND symbol=?",
      args: [account_login, server, symbol],
    });
    return res.json({ ok: true, deleted: { account_login, server, symbol } });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// GET /api/mc/state  (?key=DASHBOARD_KEY)
app.get("/api/mc/state", async (req, res) => {
  if (!mcAuthDashboard(req, res)) return;
  try {
    const db = await getDb();

    // Market status
    const market = marketBlockedNow();

    // EA positions — alleen Flexbot test account
    const mcLogin = String(process.env.MC_GATE_ACCOUNT_LOGIN || process.env.MAIN_ACCOUNT_LOGIN || "12033719").trim();
    const mcServer = String(process.env.MC_GATE_SERVER || process.env.MAIN_ACCOUNT_SERVER || "VantageInternational-Demo").trim();
    let eaPositions = [];
    if (db) {
      try {
        const rows = await db.execute({
          sql: "SELECT account_login, server, magic, symbol, has_position, equity, balance, updated_at_ms FROM ea_positions WHERE account_login=? AND server=? ORDER BY updated_at_ms DESC",
          args: [mcLogin, mcServer],
        });
        eaPositions = (rows.rows || []).map((r) => ({
          account_login: String(r.account_login),
          server: String(r.server),
          magic: Number(r.magic),
          symbol: String(r.symbol),
          has_position: Number(r.has_position) === 1,
          equity: r.equity != null ? Number(r.equity) : null,
          balance: r.balance != null ? Number(r.balance) : null,
          updated_at_ms: Number(r.updated_at_ms),
        }));
      } catch { /* ignore */ }
    }

    // Bot heartbeats
    let bots = [];
    let gateway = null;
    if (db) {
      try {
        const rows = await db.execute(
          "SELECT bot_id, name, status, last_action, updated_at_ms FROM bot_heartbeats ORDER BY bot_id ASC"
        );
        const nowMs = Date.now();
        for (const r of (rows.rows || [])) {
          const updMs = r.updated_at_ms != null ? Number(r.updated_at_ms) : 0;
          const ageMins = (nowMs - updMs) / 60000;
          const reported = String(r.status || "offline");
          // Heartbeat vers (<15 min) → gerapporteerde status; anders offline
          const status = ageMins < 15 ? reported : "offline";
          const entry = {
            bot_id: String(r.bot_id),
            name: String(r.name || r.bot_id),
            status,
            last_action: String(r.last_action || ""),
            updated_at_ms: updMs,
            age_mins: Math.round(ageMins),
          };
          if (r.bot_id === "_gateway") {
            gateway = entry;
          } else {
            bots.push(entry);
          }
        }
      } catch { /* ignore */ }
    }

    // Recent signals (last 10)
    let signals = [];
    if (db) {
      try {
        const rows = await db.execute(
          "SELECT id, symbol, direction, sl, tp_json, status, created_at_ms, closed_at_ms, close_outcome FROM signals ORDER BY created_at_ms DESC LIMIT 10"
        );
        signals = (rows.rows || []).map((r) => ({
          id: String(r.id),
          symbol: String(r.symbol),
          direction: String(r.direction),
          sl: r.sl != null ? Number(r.sl) : null,
          tp: (() => { try { return JSON.parse(String(r.tp_json))[0]; } catch { return null; } })(),
          status: String(r.status),
          created_at_ms: Number(r.created_at_ms),
          closed_at_ms: r.closed_at_ms != null ? Number(r.closed_at_ms) : null,
          close_outcome: r.close_outcome != null ? String(r.close_outcome) : null,
        }));
      } catch { /* ignore */ }
    }

    // ── Trade Gates evaluatie ──
    const symbol = "XAUUSD";
    const riskTz = String(process.env.RISK_TZ || "Europe/Prague");
    const maxDailyLossPct = 5;
    const maxConsecLossRaw = Number(process.env.MAX_CONSEC_LOSSES || 3);
    const maxConsecLosses = Number.isFinite(maxConsecLossRaw) && maxConsecLossRaw > 0 ? Math.floor(maxConsecLossRaw) : 3;

    const trade_gates = {
      market:          { pass: !market.blocked, reason: market.reason || null },
      news_blackout:   { pass: true, next_event: null },
      open_trade_lock: { pass: true, reason: null },
      cooldown:        { pass: true, remaining_min: 0 },
      daily_loss:      { pass: true, dd_pct: 0, max: maxDailyLossPct },
      consec_losses:   { pass: true, losses: 0, max: maxConsecLosses },
      trend_bias:      { pass: true, bias: "none" },
      verdict:         "ready",
      block_reason:    null,
      account:         mcLogin,
    };

    // Helper: zet eerste blokkerende gate
    function setBlocked(gateName) {
      if (!trade_gates.block_reason) {
        trade_gates.verdict = "blocked";
        trade_gates.block_reason = gateName;
      }
    }
    if (market.blocked) setBlocked("market");

    // News blackout
    try {
      const blackoutR = await fetchJson(`${INTERNAL_BASE}/news/blackout?currency=USD&impact=high&window_min=30`, 5000);
      if (blackoutR?.ok && blackoutR.blackout) {
        trade_gates.news_blackout.pass = false;
        trade_gates.news_blackout.next_event = blackoutR.next_event || null;
        setBlocked("news_blackout");
      }
    } catch { /* best effort */ }

    // Open trade lock (check Flexbot test account positie)
    try {
      const mcEa = eaPositions.find(ea => ea.account_login === mcLogin && ea.server === mcServer && ea.symbol === symbol);
      if (mcEa && mcEa.has_position) {
        const updAge = mcEa.updated_at_ms ? Date.now() - mcEa.updated_at_ms : Infinity;
        if (updAge <= 5 * 60 * 1000) { // alleen als status vers is (<5 min)
          trade_gates.open_trade_lock.pass = false;
          trade_gates.open_trade_lock.reason = "open_position_lock";
          setBlocked("open_trade_lock");
        }
      }
    } catch { /* best effort */ }

    // Cooldown
    try {
      const cooldownMin = Number(process.env.AUTO_SCALP_COOLDOWN_MIN || 15);
      const cd = await fetchJson(`${INTERNAL_BASE}/ea/cooldown/status?symbol=${encodeURIComponent(symbol)}&cooldown_min=${encodeURIComponent(String(cooldownMin))}`, 5000);
      if (cd?.ok && cd.remaining_ms > 0) {
        trade_gates.cooldown.pass = false;
        trade_gates.cooldown.remaining_min = Math.ceil(cd.remaining_ms / 60000);
        setBlocked("cooldown");
      }
    } catch { /* best effort */ }

    // Daily loss — lees state bestand (wordt bijgewerkt door EA /ea/status POST)
    try {
      const latestEa = eaPositions.find(ea => ea.account_login === mcLogin && ea.server === mcServer && ea.symbol === symbol && ea.equity != null);
      const currentEq = latestEa ? latestEa.equity : NaN;
      if (Number.isFinite(currentEq) && currentEq > 0) {
        const fp = riskStatePath("risk-day", symbol);
        const dayKey = dayKeyInTz(riskTz);
        const st = readJsonFileSafe(fp, { dayKey: "", startEquity: null });
        const startEq = Number(st?.startEquity);
        const valid = Number.isFinite(startEq) && startEq > 0 && st.dayKey === dayKey;
        if (valid) {
          const ddPct = Math.max(0, ((startEq - currentEq) / startEq) * 100.0);
          trade_gates.daily_loss.dd_pct = Number(ddPct.toFixed(2));
          trade_gates.daily_loss.start_equity = Number(startEq.toFixed(2));
          trade_gates.daily_loss.current_equity = Number(currentEq.toFixed(2));
          trade_gates.daily_loss.max = maxDailyLossPct;
          if (ddPct >= maxDailyLossPct) {
            trade_gates.daily_loss.pass = false;
            setBlocked("daily_loss");
          }
        } else {
          // Geen data van vandaag — toon huidige equity, geen drawdown
          trade_gates.daily_loss.dd_pct = 0;
          trade_gates.daily_loss.start_equity = null;
          trade_gates.daily_loss.current_equity = Number(currentEq.toFixed(2));
          trade_gates.daily_loss.max = maxDailyLossPct;
        }
      }
    } catch { /* best effort */ }

    // Consecutive losses (read-only)
    try {
      const consec = getConsecutiveLosses({ symbol, tz: riskTz });
      const losses = Number(consec?.losses || 0);
      trade_gates.consec_losses.losses = losses;
      if (losses >= maxConsecLosses) {
        trade_gates.consec_losses.pass = false;
        setBlocked("consec_losses");
      }
    } catch { /* best effort */ }

    // Trend bias
    try {
      const candlesR = await fetchJson(`${INTERNAL_BASE}/candles?symbol=${encodeURIComponent(symbol)}&interval=5m&limit=120`, 5000);
      if (candlesR?.ok && Array.isArray(candlesR?.candles)) {
        const biasR = trendBiasFromCandles(candlesR.candles, 20, 50);
        trade_gates.trend_bias.bias = biasR.bias || "none";
        if (!biasR.ok) {
          trade_gates.trend_bias.pass = false;
          setBlocked("trend_bias");
        }
      }
    } catch { /* best effort */ }

    return res.json({
      ok: true,
      server_time_ms: Date.now(),
      market,
      gateway,
      ea_positions: eaPositions,
      bots,
      signals,
      trade_gates,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// POST /api/mc/reset-daily  (?key=DASHBOARD_KEY) — reset daily loss state
app.post("/api/mc/reset-daily", (req, res) => {
  if (!mcAuthDashboard(req, res)) return;
  try {
    const symbol = String(req.query.symbol || "XAUUSD");
    const fp = riskStatePath("risk-day", symbol);
    writeJsonFileSafe(fp, { dayKey: "", startEquity: null, updatedAtMs: 0 });
    return res.json({ ok: true, reset: fp });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// GET /mc  (?key=DASHBOARD_KEY) — HTML dashboard
app.get("/mc", async (req, res) => {
  if (!mcAuthDashboard(req, res)) return;
  const key = String(req.query.key || "");
  const html = `<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>⚡ Mission Control — OpenClaw</title>
<style>
  :root{
    --bg:#07090f;--surface:#0d1117;--surface2:#111827;--border:#1e2535;
    --cyan:#22d3ee;--green:#4ade80;--orange:#fb923c;--red:#f87171;--blue:#60a5fa;--purple:#a78bfa;--yellow:#fbbf24;
    --text:#e2e8f0;--muted:#64748b;--muted2:#94a3b8;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh;position:relative}
  body::after{content:'';position:fixed;inset:0;background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,.03) 2px,rgba(0,0,0,.03) 4px);pointer-events:none;z-index:9999}

  /* ── Navbar ── */
  .navbar{background:#080b12;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:0;padding:0 24px;position:sticky;top:0;z-index:200}
  .nav-tab{padding:10px 18px;font-size:.75rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);text-decoration:none;border-bottom:2px solid transparent;transition:all .2s}
  .nav-tab:hover{color:var(--text);background:rgba(255,255,255,.03)}
  .nav-tab.active{color:var(--cyan);border-bottom-color:var(--cyan)}
  .nav-tab .nav-icon{margin-right:6px;font-size:.8rem}

  /* ── Header ── */
  header{background:var(--surface);border-bottom:1px solid var(--border);padding:12px 24px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:36px;z-index:100;backdrop-filter:blur(8px)}
  .hdr-left{display:flex;align-items:center;gap:12px}
  .hdr-logo{font-size:1.3rem;font-weight:800;letter-spacing:.04em;color:#fff;text-transform:uppercase}
  .hdr-logo span{color:var(--cyan)}
  .hdr-live{background:#450a0a;color:var(--red);border:1px solid #7f1d1d;font-size:.65rem;font-weight:800;padding:2px 7px;border-radius:4px;letter-spacing:.1em;animation:livePulse 1.5s ease-in-out infinite}
  @keyframes livePulse{0%,100%{opacity:1}50%{opacity:.6}}
  .hdr-chip{display:flex;align-items:center;gap:5px;background:var(--surface2);border:1px solid var(--border);border-radius:99px;padding:3px 9px;font-size:.65rem;font-weight:700;letter-spacing:.04em;transition:all .3s}
  #mkt-chip.open{border-color:#166534;color:var(--green)}
  #mkt-chip.closed{border-color:#7f1d1d;color:var(--red)}
  #gw-chip.online{border-color:#166534;color:var(--green)}
  #gw-chip.idle{border-color:#92400e;color:var(--orange)}
  #gw-chip.offline{border-color:#7f1d1d;color:var(--red);animation:livePulse 1.5s ease-in-out infinite}
  #gw-chip.unknown{border-color:#334155;color:var(--muted)}
  .chip-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
  #mkt-chip.open .chip-dot{background:var(--green);animation:dotPulse 1.5s ease-in-out infinite}
  #mkt-chip.closed .chip-dot{background:var(--red)}
  #gw-chip.online .chip-dot{background:var(--green);animation:dotPulse 1.5s ease-in-out infinite}
  #gw-chip.idle .chip-dot{background:var(--orange)}
  #gw-chip.offline .chip-dot{background:var(--red)}
  #gw-chip.unknown .chip-dot{background:var(--muted)}
  .hdr-right{text-align:right}
  #live-clock{font-size:1.1rem;font-weight:700;color:var(--cyan);font-variant-numeric:tabular-nums;letter-spacing:.05em}
  #refresh-time{font-size:.65rem;color:var(--muted);margin-top:1px}

  /* ── Layout ── */
  .page{padding:18px 22px;display:flex;flex-direction:column;gap:14px}
  .row-2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  @media(max-width:800px){.row-2{grid-template-columns:1fr}}

  /* ── Cards ── */
  .card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:18px;position:relative;overflow:hidden}
  .card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,var(--cyan),transparent);opacity:.4}
  .card-title{font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:14px;display:flex;align-items:center;gap:6px}
  .card-title-icon{font-size:.85rem}

  /* ── Badges ── */
  .badge{display:inline-flex;align-items:center;gap:4px;padding:2px 9px;border-radius:99px;font-size:.68rem;font-weight:700;letter-spacing:.03em}
  .badge-green{background:#052e16;color:var(--green);border:1px solid #166534}
  .badge-orange{background:#1c0a00;color:var(--orange);border:1px solid #7c2d12}
  .badge-red{background:#1c0505;color:var(--red);border:1px solid #7f1d1d}
  .badge-blue{background:#0c1a2e;color:var(--blue);border:1px solid #1d4ed8}
  .badge-gray{background:#0f172a;color:var(--muted2);border:1px solid #334155}
  .badge-cyan{background:#042028;color:var(--cyan);border:1px solid #0e7490}

  /* ── Error ── */
  #error-banner{display:none;background:#1c0505;color:#fca5a5;padding:10px 18px;border-radius:8px;border:1px solid #7f1d1d;font-size:.8rem}

  /* ── Market card ── */
  .mkt-body{display:flex;align-items:center;gap:20px}
  .mkt-ring{position:relative;width:70px;height:70px;flex-shrink:0}
  .mkt-ring svg{width:70px;height:70px;transform:rotate(-90deg)}
  .mkt-ring-center{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
  .mkt-dot{width:12px;height:12px;border-radius:50%}
  .mkt-dot.open{background:var(--green);box-shadow:0 0 10px var(--green);animation:dotPulse 1.5s ease-in-out infinite}
  .mkt-dot.closed{background:var(--red)}
  @keyframes dotPulse{0%,100%{box-shadow:0 0 6px var(--green)}50%{box-shadow:0 0 18px var(--green)}}
  .mkt-info{}
  .mkt-status{font-size:1.5rem;font-weight:800;letter-spacing:.04em}
  .mkt-status.open{color:var(--green)}
  .mkt-status.closed{color:var(--red)}
  .mkt-reason{font-size:.78rem;color:var(--muted2);margin-top:3px}

  /* ── EA cards ── */
  .ea-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}
  .ea-card{background:var(--surface2);border:1px solid var(--border);border-left:3px solid var(--border);border-radius:8px;padding:13px}
  .ea-card.has-pos{border-left-color:var(--orange)}
  .ea-card.fresh{border-left-color:var(--green)}
  .ea-name{font-weight:700;font-size:.9rem;color:#fff;margin-bottom:8px}
  .ea-equity{font-size:1.4rem;font-weight:800;color:var(--cyan);margin-bottom:8px;letter-spacing:.02em}
  .ea-row{display:flex;justify-content:space-between;align-items:center;font-size:.75rem;color:var(--muted2);margin-top:5px}
  .ea-row span:last-child{color:var(--text)}

  /* ── Bot office (pixel art) ── */
  .office-room{background:linear-gradient(180deg,#1a1a2e 0%,#16213e 40%,#0f3460 100%);border-radius:14px;overflow:hidden;border:1px solid #1a2440;position:relative}
  /* Stars / particles on ceiling */
  .office-room::before{content:'';position:absolute;inset:0;background:
    radial-gradient(1px 1px at 10% 8%,rgba(255,255,255,.4),transparent),
    radial-gradient(1px 1px at 25% 15%,rgba(255,255,255,.3),transparent),
    radial-gradient(1px 1px at 42% 5%,rgba(255,255,255,.5),transparent),
    radial-gradient(1px 1px at 58% 12%,rgba(255,255,255,.3),transparent),
    radial-gradient(1px 1px at 73% 7%,rgba(255,255,255,.4),transparent),
    radial-gradient(1px 1px at 88% 18%,rgba(255,255,255,.2),transparent),
    radial-gradient(1px 1px at 15% 22%,rgba(255,255,255,.15),transparent),
    radial-gradient(1px 1px at 65% 20%,rgba(255,255,255,.2),transparent);
    pointer-events:none;z-index:0;animation:twinkle 4s ease-in-out infinite alternate}
  @keyframes twinkle{0%{opacity:.6}100%{opacity:1}}
  /* Neon ceiling strip */
  .office-ceiling{height:4px;background:linear-gradient(90deg,transparent 5%,rgba(34,211,238,.5) 20%,rgba(34,211,238,.8) 50%,rgba(34,211,238,.5) 80%,transparent 95%);box-shadow:0 2px 20px rgba(34,211,238,.3),0 4px 40px rgba(34,211,238,.1);position:relative;z-index:2}
  /* Floor with reflection */
  .office-floor{height:12px;background:linear-gradient(180deg,#0a0a18 0%,#050510 100%);border-top:1px solid rgba(34,211,238,.08);position:relative;z-index:2}
  .office-floor::before{content:'';position:absolute;top:0;left:5%;right:5%;height:1px;background:linear-gradient(90deg,transparent,rgba(34,211,238,.15),rgba(74,222,128,.1),rgba(251,191,36,.08),transparent)}
  .office-floor::after{content:'';position:absolute;top:2px;left:0;right:0;bottom:0;background:repeating-linear-gradient(90deg,rgba(255,255,255,.01) 0px,rgba(255,255,255,.01) 1px,transparent 1px,transparent 20px);pointer-events:none}
  /* Wall — darker, with window and poster deco */
  .px-wall{display:flex;align-items:flex-end;justify-content:center;gap:8px;padding:14px 20px 0;background:linear-gradient(180deg,#0d1117 0%,#161b22 60%,#1c2333 100%);border-bottom:2px solid #1a2440;position:relative;z-index:1;min-height:86px}
  /* Subtle brick texture */
  .px-wall::before{content:'';position:absolute;inset:0;background:
    repeating-linear-gradient(90deg,rgba(255,255,255,.012) 0px,rgba(255,255,255,.012) 1px,transparent 1px,transparent 52px),
    repeating-linear-gradient(0deg,rgba(255,255,255,.008) 0px,rgba(255,255,255,.008) 1px,transparent 1px,transparent 26px);pointer-events:none}
  /* Neon accent on wall bottom */
  .px-wall::after{content:'';position:absolute;bottom:0;left:10%;right:10%;height:2px;background:linear-gradient(90deg,transparent,rgba(34,211,238,.2),transparent);pointer-events:none}
  .px-wall-item{image-rendering:pixelated;image-rendering:-moz-crisp-edges;image-rendering:crisp-edges;flex-shrink:0;transition:all .4s;filter:brightness(.85) drop-shadow(0 2px 4px rgba(0,0,0,.5))}
  .px-wall-item:hover{filter:brightness(1.15) drop-shadow(0 2px 8px rgba(34,211,238,.3));transform:scale(1.08)}
  /* Office floor area with workstations */
  .px-office-wrap{display:flex;align-items:flex-end;background:linear-gradient(180deg,rgba(13,17,23,.6),rgba(10,10,24,.8));position:relative;z-index:2;padding:0 10px}
  .px-side-deco{flex-shrink:0;image-rendering:pixelated;image-rendering:-moz-crisp-edges;image-rendering:crisp-edges;align-self:flex-end;margin-bottom:6px;opacity:.8;transition:all .5s;filter:drop-shadow(0 2px 6px rgba(0,0,0,.6))}
  .office-room:hover .px-side-deco{opacity:1;filter:drop-shadow(0 2px 8px rgba(34,211,238,.15))}
  .px-office{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;padding:18px 10px 10px;flex:1;min-width:0}
  @media(max-width:700px){.px-office{grid-template-columns:repeat(2,1fr);gap:12px}}
  /* Workstation */
  .px-station{display:flex;flex-direction:column;align-items:center;position:relative;padding:10px 6px 12px;border-radius:12px;transition:all .4s ease;border:1px solid transparent}
  .px-station:hover{transform:translateY(-3px)}
  /* Glow per status */
  .px-station.st-online{background:radial-gradient(ellipse at 50% 60%,rgba(74,222,128,.07),transparent 70%);border-color:rgba(74,222,128,.1);box-shadow:0 6px 30px rgba(74,222,128,.08)}
  .px-station.st-idle{background:radial-gradient(ellipse at 50% 60%,rgba(251,191,36,.05),transparent 70%);border-color:rgba(251,191,36,.08);box-shadow:0 4px 20px rgba(251,191,36,.05)}
  .px-station.st-offline{opacity:.4;filter:grayscale(.5) brightness(.7)}
  .px-station.st-offline:hover{opacity:.65;filter:grayscale(.2) brightness(.85)}
  /* Pixel scene */
  .px-scene{position:relative;width:140px;height:130px;margin:0 auto}
  .px-sprite{image-rendering:pixelated;image-rendering:-moz-crisp-edges;image-rendering:crisp-edges;position:absolute}
  .px-desk{width:128px;height:128px;bottom:0;left:6px;filter:drop-shadow(0 4px 8px rgba(0,0,0,.6))}
  .px-pc{width:96px;height:96px;bottom:38px;left:22px;z-index:3;filter:drop-shadow(0 2px 4px rgba(0,0,0,.4))}
  /* Monitor screen glow */
  .st-online .px-pc{filter:drop-shadow(0 0 8px rgba(74,222,128,.4)) drop-shadow(0 0 20px rgba(74,222,128,.15));animation:screenGlow 3s ease-in-out infinite alternate}
  .st-idle .px-pc{filter:drop-shadow(0 0 6px rgba(251,191,36,.3)) drop-shadow(0 0 15px rgba(251,191,36,.1));animation:screenGlowIdle 4s ease-in-out infinite alternate}
  @keyframes screenGlow{0%{filter:drop-shadow(0 0 6px rgba(74,222,128,.3)) drop-shadow(0 0 15px rgba(74,222,128,.1))}100%{filter:drop-shadow(0 0 12px rgba(74,222,128,.5)) drop-shadow(0 0 25px rgba(74,222,128,.2))}}
  @keyframes screenGlowIdle{0%{filter:drop-shadow(0 0 4px rgba(251,191,36,.2)) drop-shadow(0 0 10px rgba(251,191,36,.05))}100%{filter:drop-shadow(0 0 8px rgba(251,191,36,.35)) drop-shadow(0 0 18px rgba(251,191,36,.12))}}
  .px-chair{width:64px;height:64px;bottom:2px;left:38px;z-index:1}
  .px-char{width:64px;height:64px;bottom:12px;left:38px;z-index:2;background-size:448px 384px;transition:opacity .3s}
  .px-plant-sm{width:48px;height:96px;position:absolute;right:-6px;bottom:0;z-index:4;image-rendering:pixelated;image-rendering:crisp-edges;animation:plantSway 5s ease-in-out infinite alternate;filter:drop-shadow(0 2px 4px rgba(0,0,0,.5))}
  @keyframes plantSway{0%{transform:rotate(-1deg)}50%{transform:rotate(1.5deg)}100%{transform:rotate(-0.5deg)}}
  /* Character animations */
  .px-char.walk{background-position:0 0;animation:pxWalk .6s steps(4) infinite}
  .px-char.idle-char{background-position:0 0;animation:charBreathe 3s ease-in-out infinite}
  .px-char.seated-back{background-position:0 -192px;animation:charBreathe 3s ease-in-out infinite}
  @keyframes pxWalk{from{background-position:0 0}to{background-position:-256px 0}}
  @keyframes charBreathe{0%,100%{transform:translateY(0)}50%{transform:translateY(-1.5px)}}
  /* Nameplate */
  .ws-nameplate{margin-top:10px;text-align:center;padding:5px 14px;border-radius:8px;backdrop-filter:blur(6px);transition:all .3s}
  .st-online .ws-nameplate{background:rgba(74,222,128,.08);border:1px solid rgba(74,222,128,.18);box-shadow:0 0 12px rgba(74,222,128,.05)}
  .st-idle .ws-nameplate{background:rgba(251,191,36,.06);border:1px solid rgba(251,191,36,.14);box-shadow:0 0 10px rgba(251,191,36,.04)}
  .st-offline .ws-nameplate{background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.04)}
  .ws-name{font-size:.68rem;color:#e8eaed;font-family:'Segoe UI',system-ui,sans-serif;font-weight:700;letter-spacing:.08em;text-transform:uppercase;text-shadow:0 1px 3px rgba(0,0,0,.5)}
  .ws-stat{font-size:.5rem;font-weight:800;letter-spacing:.12em;margin-top:2px}
  .ws-stat.online{color:var(--green);text-shadow:0 0 8px rgba(74,222,128,.4)}
  .ws-stat.idle{color:var(--orange);text-shadow:0 0 6px rgba(251,191,36,.3)}
  .ws-stat.offline{color:#2d3748}
  /* Status LED */
  .ws-led{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:4px;vertical-align:middle}
  .ws-led.online{background:var(--green);box-shadow:0 0 4px var(--green),0 0 10px var(--green);animation:ledPulse 2s ease-in-out infinite}
  .ws-led.idle{background:var(--orange);box-shadow:0 0 4px var(--orange),0 0 8px var(--orange);animation:ledPulse 3s ease-in-out infinite}
  .ws-led.offline{background:#2d3748}
  @keyframes ledPulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.8)}}
  /* Control buttons */
  .ws-btns{display:flex;gap:4px;margin-top:8px;justify-content:center;opacity:0;transition:opacity .3s}
  .px-station:hover .ws-btns{opacity:1}
  .btn{border:none;border-radius:6px;padding:5px 11px;font-size:.68rem;cursor:pointer;font-weight:700;transition:all .2s;letter-spacing:.03em}
  .btn-start{background:#052e16;color:var(--green);border:1px solid #166534}
  .btn-stop{background:#1c0505;color:var(--red);border:1px solid #7f1d1d}
  .btn-restart{background:#0c1a2e;color:var(--blue);border:1px solid #1d4ed8}
  .btn:hover{filter:brightness(1.4);transform:translateY(-1px);box-shadow:0 2px 8px rgba(0,0,0,.3)}

  /* ── Trade Gates ── */
  .gates-row{display:flex;flex-wrap:wrap;gap:8px}
  .gate-chip{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:99px;font-size:.72rem;font-weight:700;letter-spacing:.03em;transition:all .3s}
  .gate-chip .gate-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
  .gate-pass{background:#052e16;color:var(--green);border:1px solid #166534}
  .gate-pass .gate-dot{background:var(--green);box-shadow:0 0 6px var(--green)}
  .gate-fail{background:#1c0505;color:var(--red);border:1px solid #7f1d1d}
  .gate-fail .gate-dot{background:var(--red);box-shadow:0 0 6px var(--red)}
  .gate-detail{font-size:.62rem;color:var(--muted2);font-weight:400;margin-left:2px}
  .verdict-bar{margin-top:10px;padding:8px 14px;border-radius:8px;font-size:.8rem;font-weight:800;letter-spacing:.04em;display:flex;align-items:center;gap:8px}
  .verdict-ready{background:#052e16;color:var(--green);border:1px solid #166534}
  .verdict-blocked{background:#1c0505;color:var(--red);border:1px solid #7f1d1d}

  /* ── Signals table ── */
  .signals-wrap{overflow-x:auto}
  table{width:100%;border-collapse:collapse;font-size:.78rem}
  thead tr{border-bottom:1px solid var(--border)}
  th{text-align:left;padding:8px 12px;color:var(--muted);font-weight:600;font-size:.65rem;text-transform:uppercase;letter-spacing:.08em}
  td{padding:9px 12px;border-bottom:1px solid #0f1520;color:var(--muted2)}
  td:first-child{color:var(--text);font-variant-numeric:tabular-nums}
  tbody tr:hover{background:rgba(255,255,255,.02)}
  tbody tr:last-child td{border-bottom:none}
</style>
</head>
<body>
<nav class="navbar">
  <a href="/mc?key=${key}" class="nav-tab active"><span class="nav-icon">⚡</span>Mission Control</a>
  <a href="/fxcopy?key=${key}" class="nav-tab"><span class="nav-icon">📡</span>FxCopy</a>
</nav>
<header>
  <div class="hdr-left">
    <div class="hdr-logo">Mission <span>Control</span></div>
    <div class="hdr-live">LIVE</div>
    <div id="mkt-chip" class="hdr-chip"><div class="chip-dot"></div><span id="mkt-label">laden...</span></div>
    <div id="gw-chip" class="hdr-chip unknown"><div class="chip-dot"></div><span id="gw-label">Gateway...</span></div>
  </div>
  <div class="hdr-right">
    <div id="live-clock">--:--:--</div>
    <div id="refresh-time">nog niet geladen</div>
  </div>
</header>
<div class="page">
  <div id="error-banner"></div>
  <div class="row-2">
    <div class="card" id="card-ea">
      <div class="card-title"><span class="card-title-icon">&#128268;</span> EA Verbindingen</div>
      <div class="ea-grid" id="ea-body"><span style="color:var(--muted);font-size:.8rem">laden...</span></div>
    </div>
    <div class="card">
      <div class="card-title"><span class="card-title-icon">&#127970;</span> Agent Office</div>
      <div class="office-room">
        <div class="office-ceiling"></div>
        <div id="bots-body"><div style="color:var(--muted);font-size:.8rem;padding:20px 12px">laden...</div></div>
        <div class="office-floor"></div>
      </div>
    </div>
  </div>
  <div class="card">
    <div class="card-title"><span class="card-title-icon">&#128679;</span> Trade Gates — Why no trade?</div>
    <div class="gates-row" id="gates-body"><span style="color:var(--muted);font-size:.8rem">laden...</span></div>
    <div id="gates-verdict"></div>
  </div>
  <div class="card">
    <div class="card-title"><span class="card-title-icon">&#128200;</span> Recente Trades (laatste 10)</div>
    <div class="signals-wrap"><table><thead><tr><th>Tijd</th><th>Richting</th><th>SL</th><th>TP</th><th>Status</th></tr></thead><tbody id="signals-tbody"><tr><td colspan="5">laden...</td></tr></tbody></table></div>
  </div>
</div>
<script>
const KEY = ${JSON.stringify(key)};
const BASE = window.location.origin;

function tick(){
  document.getElementById('live-clock').textContent=new Date().toLocaleTimeString('nl-NL',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
}
tick();setInterval(tick,1000);

function fmtTime(ms){
  if(!ms)return'—';
  return new Date(ms).toLocaleTimeString('nl-NL',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
}
function fmtDate(ms){
  if(!ms)return'—';
  const d=new Date(ms);
  return d.toLocaleDateString('nl-NL',{day:'2-digit',month:'2-digit'})+' '+fmtTime(ms);
}
function ageFmt(ms){
  const mins=Math.round((Date.now()-ms)/60000);
  if(mins<1)return'nu net';
  if(mins<60)return mins+'m';
  return Math.round(mins/60)+'u';
}

async function sendCommand(botId, cmd){
  try{
    const r=await fetch(BASE+'/api/mc/bot/command?key='+encodeURIComponent(KEY),{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({bot_id:botId,command:cmd})
    });
    const d=await r.json();
    if(d.ok) alert('Commando '+cmd+' verstuurd naar '+botId);
    else alert('Error: '+(d.error||JSON.stringify(d)));
  }catch(e){alert('Error: '+e.message);}
}

// Pixel art sprites (base64)
const PX_SPRITES={
  chars:[
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAHAAAABgCAYAAADFNvbQAAAACXBIWXMAAAsTAAALEwEAmpwYAAAGbmlUWHRYTUw6Y29tLmFkb2JlLnhtcAAAAAAAPD94cGFja2V0IGJlZ2luPSLvu78iIGlkPSJXNU0wTXBDZWhpSHpyZVN6TlRjemtjOWQiPz4gPHg6eG1wbWV0YSB4bWxuczp4PSJhZG9iZTpuczptZXRhLyIgeDp4bXB0az0iQWRvYmUgWE1QIENvcmUgNS42LWMxNDUgNzkuMTYzNDk5LCAyMDE4LzA4LzEzLTE2OjQwOjIyICAgICAgICAiPiA8cmRmOlJERiB4bWxuczpyZGY9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkvMDIvMjItcmRmLXN5bnRheC1ucyMiPiA8cmRmOkRlc2NyaXB0aW9uIHJkZjphYm91dD0iIiB4bWxuczp4bXA9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC8iIHhtbG5zOmRjPSJodHRwOi8vcHVybC5vcmcvZGMvZWxlbWVudHMvMS4xLyIgeG1sbnM6cGhvdG9zaG9wPSJodHRwOi8vbnMuYWRvYmUuY29tL3Bob3Rvc2hvcC8xLjAvIiB4bWxuczp4bXBNTT0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL21tLyIgeG1sbnM6c3RFdnQ9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9zVHlwZS9SZXNvdXJjZUV2ZW50IyIgeG1wOkNyZWF0b3JUb29sPSJBZG9iZSBQaG90b3Nob3AgQ0MgMjAxOSAoV2luZG93cykiIHhtcDpDcmVhdGVEYXRlPSIyMDI2LTAyLTE2VDExOjM0OjQxWiIgeG1wOk1vZGlmeURhdGU9IjIwMjYtMDItMTZUMTM6MTg6MzVaIiB4bXA6TWV0YWRhdGFEYXRlPSIyMDI2LTAyLTE2VDEzOjE4OjM1WiIgZGM6Zm9ybWF0PSJpbWFnZS9wbmciIHBob3Rvc2hvcDpDb2xvck1vZGU9IjMiIHBob3Rvc2hvcDpJQ0NQcm9maWxlPSJzUkdCIElFQzYxOTY2LTIuMSIgeG1wTU06SW5zdGFuY2VJRD0ieG1wLmlpZDowZjE1NzQ1Ny1jZWZlLWJkNDMtOGRjNC0wODM5NmM0MjI5MTQiIHhtcE1NOkRvY3VtZW50SUQ9InhtcC5kaWQ6MGYxNTc0NTctY2VmZS1iZDQzLThkYzQtMDgzOTZjNDIyOTE0IiB4bXBNTTpPcmlnaW5hbERvY3VtZW50SUQ9InhtcC5kaWQ6MGYxNTc0NTctY2VmZS1iZDQzLThkYzQtMDgzOTZjNDIyOTE0Ij4gPHBob3Rvc2hvcDpEb2N1bWVudEFuY2VzdG9ycz4gPHJkZjpCYWc+IDxyZGY6bGk+YWRvYmU6ZG9jaWQ6cGhvdG9zaG9wOjI5YWFmNzNjLTViOGMtOWE0MC1hYjk2LWNhZWQ3YjU4MmZmYTwvcmRmOmxpPiA8cmRmOmxpPmFkb2JlOmRvY2lkOnBob3Rvc2hvcDo1ZTRlNTM3Ni0yMjg0LWM3NDEtOTNmMC05ODQ0ZDZiY2U2OGI8L3JkZjpsaT4gPHJkZjpsaT54bXAuZGlkOjIwYjUxYTRhLWIwYjktNDc0Mi1iZTQ2LTQyN2Y4NGFkYmQ0MjwvcmRmOmxpPiA8cmRmOmxpPnhtcC5kaWQ6ZDUyN2YxZjUtOWE1MC0wMTQ3LTkxNzAtN2VjOGY3N2I5YzJmPC9yZGY6bGk+IDwvcmRmOkJhZz4gPC9waG90b3Nob3A6RG9jdW1lbnRBbmNlc3RvcnM+IDx4bXBNTTpIaXN0b3J5PiA8cmRmOlNlcT4gPHJkZjpsaSBzdEV2dDphY3Rpb249ImNyZWF0ZWQiIHN0RXZ0Omluc3RhbmNlSUQ9InhtcC5paWQ6MGYxNTc0NTctY2VmZS1iZDQzLThkYzQtMDgzOTZjNDIyOTE0IiBzdEV2dDp3aGVuPSIyMDI2LTAyLTE2VDExOjM0OjQxWiIgc3RFdnQ6c29mdHdhcmVBZ2VudD0iQWRvYmUgUGhvdG9zaG9wIENDIDIwMTkgKFdpbmRvd3MpIi8+IDwvcmRmOlNlcT4gPC94bXBNTTpIaXN0b3J5PiA8L3JkZjpEZXNjcmlwdGlvbj4gPC9yZGY6UkRGPiA8L3g6eG1wbWV0YT4gPD94cGFja2V0IGVuZD0iciI/Pu5QeR4AAAisSURBVHja7V3LbuVEELVgBhSkkLloeCRDeGl4CAGLERkxSIxGbFDYRELKIvtZIQHb+YAREiuWsIsEK9gg+AFW/ANbYDXfwOKSMi6r3K6ufpXdbqctlXJj3+Nq16ku+97USTfb7bapVq7VIKyBQLrd2j/c2qwxNrVBZPa/GgIhSL9+fdzbt/fvtIGDn1988sYomFoEpPqvBHbBgyChYdDef/mVPpj0OLxfi4BU/5eeQAgSBAUDBfbVp2+3Bq9pENFgnxYBqf6LJyGhglkDiCRQIig5NICpBKT61yrhufExFcwaQNPwRFMQkOpf6x6eEx9bwSYjcE68xj08Jz6lgq2CwClKeG68bwUbnIBmiVkKcBBgeEJtAjT9p5bw3Hjf+I0CiJmDtRrBcxCQ6n9NFSSIQDxIA/fox4etma/B4H2aBGj5v7QE0sdfCBQ8IIFh4Ojvf3zz5egpKpWAVP9rITCmgg0eg4/vfrD99/fvtv8fGQYQNjgG7+E+x6QQkOpfs4TnxodWsFEAIWCwnZycbLd//tZa+/pig2M2AlMTIMW/5j08Bz6lgo2+SYAA/f39gzbYCITXsI8GT5OAVP+pJTw3nlYwrFZcBQMzK9gggE+++N52c/+nNlBgDz/7sDX8HY7Be7QJ0PCfWsK18KEEkOtvj2MFg6THfTgB4Bg51/APuhi8zfGD1mC78sTV1mDD/RhE7ktZXwIkbIx/zRKegI8iILWCDQOIQbIEELfz8/OtJgFg3TkHvlj8hUkEpt7Dc+JpIthmMPvXCBrAvXufswHEweEgWAIdCWAjAIw5/wgPY+MSiJZgVwmH93Q2wON+H3x3vax/FwHcLQDP51vBBr7NAMIbMFAcgVDDTQLp7LElACWAIwHOCec2EYhYGJuYgJ1FcAWgC74I/90/EgiG0BSQWAQQ/1LFii2go0CaCOQDkyaPDU8JcBGAr1QG96VQFIABP/N8UsBtCUg4u48d1M0WwWKxY8CSAmgGwaQewChs8eHQI4EeiGSfJ4FcBJr+zfGHJgBNIAjyX/88Go0f9sExVwUIxZs1vCH3CNauPPMS+zGAlimXAXgjN+8hcG6Xfxij6T8kgWz+ufH7JiBNIAwynTU//PxLv89VAULxLIF4H6MG++CaH9vZkz7HRRGAW3duq38J70sA3rtMPFcBfBOAJhCdJeaGBEgVIBTPzgAMID5VHR0dbc/OztjH2JAEcBGIu8EX+MSnNoq3VQBKgCuBXATG4JFYOoNg5uAswn2uChCKZ2cABO/g4KAN4FO71/rPJoeHh2JTDpcAvgTg1vkY+IaxIKE+FSA2gTTwrnuYNt45Axphs5VAmgAhBNjcxFYALoFCCIzBu54itfHiDNhsNk0IgZYE8CaA27oxeFcAVwJJFaBEvHpjKk2A3d3dBsxFgJZ/rABSAkkVoET86jqbYxKoZHwViFR9YLVF6QND+vunKIE5/K9GXoaG/R3YKkAbdGgQtQhYgv+c+GQCub5+CBbXbYV9/ZoE5Pa/BHxsAvRdVbRjCoNn9vjjMbMtLpWA3P5z41MSYBBAdEAdm33+tr7GFAKW4j8XPiUB2AGYPYzm4KYmIJf/3PiYBFANYMXPn4A1gIXjR+IMOn3pzZNTnmpeQG7/xRNonsDs66e1eA4C5vafG59MIAbIx9CJJgG5/efGxybA4HOIT/C4/7KQSkBu/0vAxybAqDUcGmZsjrGZxvZNRCwBS/CfE5+SAGwAuSDifpc2IJaAJfnPgY9NAFYedvTOm33A0GCfjz4whYDc/peCD0kAVp9ndmSZfflTEZDbf268tgxKeFleJgUvQB84CVbRfxcI2pjbywpix596/bF4qzxMMh91TehFzOb/wqC72dQmwD4v/57qornwVn0gZzZ9ngYBKf4R6+sf5XK0tT0UbyZA6PVr4a36QFtnMicN4/SBEgE2faCPf07ZRMUhLv/cOUxpnYSXxCn4HgmPFUALb5WXxQbQJwG4JHAF0SUvM9VJEl7SJvqM3yVPmxNv1edNFUBJH+gTQFtTlC8BXfs8d91e2ghfedpc+Mn0gaEXkKIP5ORhrgRYC381+kD0L0nEcKatCb8KfWDtCy1cH1gJLFwfWAksXB9YxS2F6wMrgdUqgdUqgdUqgZXAapeVwKqwzUxgKgEUFypw1PJfMl6FwBQCqMYtVOColQCl46MVuhoE0O7iUIGjhv/S8bEJoEYA1biZ+jaXOkfTf6n42ASYhIBQeZWm/9LxUQpdTQIqft4ErgEsHK86ANS4hQocK4FKBGoRwA1CEjhq+S8drzYDYwkwb7gUB4Z/F4SuNCpw1PJfOj4mAdQIkDRuuHwNbPv7+/0iUtoJsES8se5Rb1oJrEYA3Tg8LgoFrRVcZ7aG/1LwmAQaCaBKAHcOWDQK8WB0HUHtBCgFzxEYmwBqBNiW5AE5FGAQZ1tyRzMBSsADplsPIjoBAC92htkI8Pk2nerdcEHFkH/6Guq/NDxZocWWAD2eSwDEBxEgzSBJL+hDoEvwuAR88PVb/NOVWGwESv4pPogAaek4E0s1g/Aa1iDyDeK927dGgseUBNLA4wqcPtcv+efIS8GLBFBFKBIgLR1H8eaKnL4EcuSFBnBKvO/1S/5DyZPwjbQWH65oCSdAAnyzz1yRU4vA1ADG4kNm8Jzjdy7miCdwEcAplMwVOX21DVMEUIMAc/XpJYzf+vjfr/nq+SBCCdx5/aORxg2wp6enjS+BpkQt5EFoSrwvgXON31zJudl562NWYAjgd2/fbXyaerhVwK4++5pVHOMjEqXfQqDopuINAq/feLWR/lODzwBsOkGqC5QIvHbjJjsGkKhRmVooHs+xNrx5gl7bRwlrSfMcgE0nSHWBjhk8wNEMNGVqHB5/vyz4EYFU24ezhq5r5xpAiFDURiDFPf70863/vesvjGRqUgDQEH+RgKvED04giTs5oaVEoI9QlMPHCExrZ3a1Yu0/NyeuDtm11pIAAAAASUVORK5CYII=',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAHAAAABgCAYAAADFNvbQAAAACXBIWXMAAAsTAAALEwEAmpwYAAALDWlUWHRYTUw6Y29tLmFkb2JlLnhtcAAAAAAAPD94cGFja2V0IGJlZ2luPSLvu78iIGlkPSJXNU0wTXBDZWhpSHpyZVN6TlRjemtjOWQiPz4gPHg6eG1wbWV0YSB4bWxuczp4PSJhZG9iZTpuczptZXRhLyIgeDp4bXB0az0iQWRvYmUgWE1QIENvcmUgNS42LWMxNDUgNzkuMTYzNDk5LCAyMDE4LzA4LzEzLTE2OjQwOjIyICAgICAgICAiPiA8cmRmOlJERiB4bWxuczpyZGY9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkvMDIvMjItcmRmLXN5bnRheC1ucyMiPiA8cmRmOkRlc2NyaXB0aW9uIHJkZjphYm91dD0iIiB4bWxuczp4bXA9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC8iIHhtbG5zOmRjPSJodHRwOi8vcHVybC5vcmcvZGMvZWxlbWVudHMvMS4xLyIgeG1sbnM6cGhvdG9zaG9wPSJodHRwOi8vbnMuYWRvYmUuY29tL3Bob3Rvc2hvcC8xLjAvIiB4bWxuczp4bXBNTT0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL21tLyIgeG1sbnM6c3RFdnQ9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9zVHlwZS9SZXNvdXJjZUV2ZW50IyIgeG1sbnM6c3RSZWY9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9zVHlwZS9SZXNvdXJjZVJlZiMiIHhtcDpDcmVhdG9yVG9vbD0iQWRvYmUgUGhvdG9zaG9wIENDIDIwMTkgKFdpbmRvd3MpIiB4bXA6Q3JlYXRlRGF0ZT0iMjAyNi0wMi0xNlQxMTozNDo0MVoiIHhtcDpNb2RpZnlEYXRlPSIyMDI2LTAyLTE2VDIwOjA0OjA0WiIgeG1wOk1ldGFkYXRhRGF0ZT0iMjAyNi0wMi0xNlQyMDowNDowNFoiIGRjOmZvcm1hdD0iaW1hZ2UvcG5nIiBwaG90b3Nob3A6Q29sb3JNb2RlPSIzIiBwaG90b3Nob3A6SUNDUHJvZmlsZT0ic1JHQiBJRUM2MTk2Ni0yLjEiIHhtcE1NOkluc3RhbmNlSUQ9InhtcC5paWQ6MzYxODRhNjktNmYzOC1hYTQyLThkMTUtMDRmMDhlNDllYjZiIiB4bXBNTTpEb2N1bWVudElEPSJhZG9iZTpkb2NpZDpwaG90b3Nob3A6OGZkYTg1NzktZDZjOC0xZTQ3LWE2YjAtYzFmYzExNWIzZDUzIiB4bXBNTTpPcmlnaW5hbERvY3VtZW50SUQ9InhtcC5kaWQ6N2EzMGIwYWEtZmE1NS1hYzRlLWFkODItNjEwNTRiMzllMWUzIj4gPHBob3Rvc2hvcDpEb2N1bWVudEFuY2VzdG9ycz4gPHJkZjpCYWc+IDxyZGY6bGk+YWRvYmU6ZG9jaWQ6cGhvdG9zaG9wOjI5YWFmNzNjLTViOGMtOWE0MC1hYjk2LWNhZWQ3YjU4MmZmYTwvcmRmOmxpPiA8cmRmOmxpPmFkb2JlOmRvY2lkOnBob3Rvc2hvcDo1ZTRlNTM3Ni0yMjg0LWM3NDEtOTNmMC05ODQ0ZDZiY2U2OGI8L3JkZjpsaT4gPHJkZjpsaT54bXAuZGlkOjIwYjUxYTRhLWIwYjktNDc0Mi1iZTQ2LTQyN2Y4NGFkYmQ0MjwvcmRmOmxpPiA8cmRmOmxpPnhtcC5kaWQ6N2EzMGIwYWEtZmE1NS1hYzRlLWFkODItNjEwNTRiMzllMWUzPC9yZGY6bGk+IDxyZGY6bGk+eG1wLmRpZDpkNTI3ZjFmNS05YTUwLTAxNDctOTE3MC03ZWM4Zjc3YjljMmY8L3JkZjpsaT4gPC9yZGY6QmFnPiA8L3Bob3Rvc2hvcDpEb2N1bWVudEFuY2VzdG9ycz4gPHhtcE1NOkhpc3Rvcnk+IDxyZGY6U2VxPiA8cmRmOmxpIHN0RXZ0OmFjdGlvbj0iY3JlYXRlZCIgc3RFdnQ6aW5zdGFuY2VJRD0ieG1wLmlpZDo3YTMwYjBhYS1mYTU1LWFjNGUtYWQ4Mi02MTA1NGIzOWUxZTMiIHN0RXZ0OndoZW49IjIwMjYtMDItMTZUMTE6MzQ6NDFaIiBzdEV2dDpzb2Z0d2FyZUFnZW50PSJBZG9iZSBQaG90b3Nob3AgQ0MgMjAxOSAoV2luZG93cykiLz4gPHJkZjpsaSBzdEV2dDphY3Rpb249InNhdmVkIiBzdEV2dDppbnN0YW5jZUlEPSJ4bXAuaWlkOmVkOWJmNTQ3LTYwZGItNTg0Ny05MTVhLTVmYzU3NmJhMDgyMSIgc3RFdnQ6d2hlbj0iMjAyNi0wMi0xNlQxMzo1NzoyN1oiIHN0RXZ0OnNvZnR3YXJlQWdlbnQ9IkFkb2JlIFBob3Rvc2hvcCBDQyAyMDE5IChXaW5kb3dzKSIgc3RFdnQ6Y2hhbmdlZD0iLyIvPiA8cmRmOmxpIHN0RXZ0OmFjdGlvbj0ic2F2ZWQiIHN0RXZ0Omluc3RhbmNlSUQ9InhtcC5paWQ6YWNiOWJjNWEtMmQ2Ni01ZDRhLTlhZjMtYmM4YjRjMDE2NWE4IiBzdEV2dDp3aGVuPSIyMDI2LTAyLTE2VDIwOjA0OjA0WiIgc3RFdnQ6c29mdHdhcmVBZ2VudD0iQWRvYmUgUGhvdG9zaG9wIENDIDIwMTkgKFdpbmRvd3MpIiBzdEV2dDpjaGFuZ2VkPSIvIi8+IDxyZGY6bGkgc3RFdnQ6YWN0aW9uPSJjb252ZXJ0ZWQiIHN0RXZ0OnBhcmFtZXRlcnM9ImZyb20gYXBwbGljYXRpb24vdm5kLmFkb2JlLnBob3Rvc2hvcCB0byBpbWFnZS9wbmciLz4gPHJkZjpsaSBzdEV2dDphY3Rpb249ImRlcml2ZWQiIHN0RXZ0OnBhcmFtZXRlcnM9ImNvbnZlcnRlZCBmcm9tIGFwcGxpY2F0aW9uL3ZuZC5hZG9iZS5waG90b3Nob3AgdG8gaW1hZ2UvcG5nIi8+IDxyZGY6bGkgc3RFdnQ6YWN0aW9uPSJzYXZlZCIgc3RFdnQ6aW5zdGFuY2VJRD0ieG1wLmlpZDozNjE4NGE2OS02ZjM4LWFhNDItOGQxNS0wNGYwOGU0OWViNmIiIHN0RXZ0OndoZW49IjIwMjYtMDItMTZUMjA6MDQ6MDRaIiBzdEV2dDpzb2Z0d2FyZUFnZW50PSJBZG9iZSBQaG90b3Nob3AgQ0MgMjAxOSAoV2luZG93cykiIHN0RXZ0OmNoYW5nZWQ9Ii8iLz4gPC9yZGY6U2VxPiA8L3htcE1NOkhpc3Rvcnk+IDx4bXBNTTpEZXJpdmVkRnJvbSBzdFJlZjppbnN0YW5jZUlEPSJ4bXAuaWlkOmFjYjliYzVhLTJkNjYtNWQ0YS05YWYzLWJjOGI0YzAxNjVhOCIgc3RSZWY6ZG9jdW1lbnRJRD0ieG1wLmRpZDo3YTMwYjBhYS1mYTU1LWFjNGUtYWQ4Mi02MTA1NGIzOWUxZTMiIHN0UmVmOm9yaWdpbmFsRG9jdW1lbnRJRD0ieG1wLmRpZDo3YTMwYjBhYS1mYTU1LWFjNGUtYWQ4Mi02MTA1NGIzOWUxZTMiLz4gPC9yZGY6RGVzY3JpcHRpb24+IDwvcmRmOlJERj4gPC94OnhtcG1ldGE+IDw/eHBhY2tldCBlbmQ9InIiPz4sS3FpAAAIN0lEQVR42u1dPY8kRQytn7IR0m7MBqfNSICEACIE0opwCYiJSCFCBJfwCyBDOjISJHI+Ev4DKVx0ITFBs26tR263XR+2e6p7rkYq3cx0v3aN36uu2hu/qTRNUxrtuG0k4egEfv3RM6lNSlud6+1A7/iXRuCcqJc/fDq3f/94Pjd8L5dIKwHe+INAkrzfvvyAJ2rR4BickyHDIwBT/EGgMGoqCJiiCPDGHwSS5NcSoJDgEYA5/iBQmLMqCZgiCPDGVxZG1jnYO4effRHWnYDIERiwCOuNbxbAxYzAiDm4M94kgIsZgRGLsN54iwCyQ5Z2oDCkQwXQEp+OPk/8znizAFYdgOevfnw+NzyZvo4mwBtfWrRY7gC98VYBrIJDolJKc+OvaVJJIK8AXPEvZASaBZD4vTXN/789nRKGCcT3SvdqgwBc8ccIJCfgAXjc399P01+/zG1+/viomVw9ArDEHyNQuPA/3381/ff7dycC4Dm8V+qoVwCW+Lk/3Fvm4N74sDnw6upq+vC9d+b26zefzw1fw7FoArzx+Qi0LsJ6460CWFzgz2+/mO7u7qbb29vp5uZm0eA9OAZkMAV5BXC6Bly7FB/6mItvmYMj8XiuhMf3IheBp79DIMG0gVLDBMK50t8wNQIQCDjFp3gtPvSRxXfPwRF4ShJOIfgapxB6TpQA0mNy51ZKIBzHDwTPEQf9ev/tt6oFgAQgncan1y8JCHERc3A0/kTkE54nX5qCrAJYJRBuc9IIwuM8gXBdJB+OlwiUrkEFRASyGsHQNy6giDm4N94jAJVASgQ+x7mMJh4JxM5qAqAEcBJoH3D0SfE1Ar2LsN54zwBWCYQgmHDa4L2nY0kiEEdPTgBIgDQCsZXiSwJyLsK8i6gF/t433sy20iKwhFdHICavdAvkJNI5sEYA0ij2xkcRORZhnkXUCQ/ihCT//fLVxB/wHhzDO4i0CEQB5PBcQNnkUfVpSUQCrQRExKd3gdZFmHcRxedwSDI86Kh58dPPp/dyeBRAC36RQN5Z2ugxiUArARHx+TwsLYK0RVrtIqpWAEiA9KAjMAq/SmJNk26hVgIi4ksE1i7CahdRNQTyEQgjB0dRDYEWfKpQYso1fgttJaDUSiOH1sRo82/NLbxmCtAWcnQxV5rDAA/nRuHn5POGSpSO8YYEUiwVACeg5pot/aHkeW/hEfjSKjIaH1KbWEp4DQHW5p1Dj44/fGGrdw49On5YtIY/cLThDxz+wHh/IP1GGGs0zukP7BT/sN6I8NJwAwG94+8Bb/ZGrCqDCx3Y3B/YI/6evBG1AtisNLyRgN7xd4EP80ZUdmDTushzx9+bN6JWABdDgDd+b7ynLjTReoyaDmyl4N7x91SZXSuAxQWkDtALsHvwRP6OcxPQO/4e8O4RiAewGpjW5eOF6Xk0gREE9IzfG28VwOoC9GSeOPo8moA9xO+JtwpgVdlML8KHLBu+UQT0jr8bvEUAiQ5ZKVH4nL/WStMNBOwifke8SwCJnlhKmtTJKAJ6x++NtwpgoSCJfa4A/n4UAb3j98ZbBbD6kQAKkJrkzfMQ0Dv+XvBWAawKY0u1/1ic9HgB8TdaWgnYQ/yeeK8AmkvTsbScfy/lIWAv8XvhPQJY1V/mEoid1ApTvf5AvHbJnsbtbVEC2AO+JADEowBWCSz5A6WCX8TWmEPwPOkaudJ4LKcrlcbXmlsuBS/ay7TS8prkW/2BvCBYs6dp1eIlg2oJzz9/rcG0Fe+Nz/FN/jzNWxDlDyTXbyprl+4gWnyprJ3ejkv4nLexBi/Vs3rwbn8eT/65/YFeg6rXYNqKzwnIgg/zBvTyB3KDC6pYaWpVN71ODV4bQefGh9b29/QHvrZ1oVG1/b39gYNAoz8w0tzh9Qe+lgR6/YEStoc/cJhbgryB5/YHDgJHEgaBow0CRxsEDgK7mDQHCQEEegnwWKQ2iH84fDSBHgKaLVIbCODo+CYBRBPQbJGKjn9wfLMAIgkwGTSiBXB0fKsAIglYGTSw8zmLVHT8A+NNAkiRBPBy8B4CODq+VQApmgBa13huARwdbxFAiiRAMmicUwBHx1sEkCIJ4Coq3cPZfwSECODo+FYBpGgCqMcNGq8qxu8JERcZ/+h4iwBCCaArJ6kcHDew0PDe+EfHWwQQSgC3SdFO4ZYy19fXi5/u3yL+nvB0uxy2vU6KuINFEbC4d+PuI/Q6EBgeDw8Pi70TthDA3vFUBF4BRBGw8nDDcb6dGjS4Lt34Ijr+EfAlAlsEUEUA/FtDAO8AdRohju9aEhn/SHjAPW0nYBYA4KMIWP3vOXcbPW38lJSvY0IEcBT8IwGJbPBhEgDiswRgeSCaVrQPoNVz4g5cxLMglpNrO4FSX2JBAJvi6aYhtQKW4mO+6UYeNQJAPManePX7KEoAEkhHVM5jgMGYHU3d/YzH/uyTj0VzaSGBi/ci8ZAHKmbhFlodn5PXKiCOFwngo48SIG0AqREo4SUC6Wsgj3rktARqeGrRisLTfJQ+f018Sp4Xv7oATTy1POf278uNQLobmJVAbwK9eD6Cc/3fIn4OLxLIE58zpUibb/APnfPoaQLI3QJrExiJx88PFq8e8TW8SABPfC0B1JxI1cufc3tYibwWAeQIuER8KAHUHqw1yd8XFV/bxYw+5y7XVjw83wMeceEEtFrMouIzhy62Uzw0lhLXlAvvjR+FDyWg8LMhqq04Ir6SgEUimO3NhffGj8IvEpgzd+b2kdcsZjW+wNIiSvkVi+wtSEsEWQgkTmAr3hs/Ci8mMPc7KFICLcZMjcBSH4ZDd5hbLqr9DxcCtoNy5xOOAAAAAElFTkSuQmCC',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAHAAAABgCAYAAADFNvbQAAAACXBIWXMAAAsTAAALEwEAmpwYAAALDWlUWHRYTUw6Y29tLmFkb2JlLnhtcAAAAAAAPD94cGFja2V0IGJlZ2luPSLvu78iIGlkPSJXNU0wTXBDZWhpSHpyZVN6TlRjemtjOWQiPz4gPHg6eG1wbWV0YSB4bWxuczp4PSJhZG9iZTpuczptZXRhLyIgeDp4bXB0az0iQWRvYmUgWE1QIENvcmUgNS42LWMxNDUgNzkuMTYzNDk5LCAyMDE4LzA4LzEzLTE2OjQwOjIyICAgICAgICAiPiA8cmRmOlJERiB4bWxuczpyZGY9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkvMDIvMjItcmRmLXN5bnRheC1ucyMiPiA8cmRmOkRlc2NyaXB0aW9uIHJkZjphYm91dD0iIiB4bWxuczp4bXA9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC8iIHhtbG5zOmRjPSJodHRwOi8vcHVybC5vcmcvZGMvZWxlbWVudHMvMS4xLyIgeG1sbnM6cGhvdG9zaG9wPSJodHRwOi8vbnMuYWRvYmUuY29tL3Bob3Rvc2hvcC8xLjAvIiB4bWxuczp4bXBNTT0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL21tLyIgeG1sbnM6c3RFdnQ9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9zVHlwZS9SZXNvdXJjZUV2ZW50IyIgeG1sbnM6c3RSZWY9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9zVHlwZS9SZXNvdXJjZVJlZiMiIHhtcDpDcmVhdG9yVG9vbD0iQWRvYmUgUGhvdG9zaG9wIENDIDIwMTkgKFdpbmRvd3MpIiB4bXA6Q3JlYXRlRGF0ZT0iMjAyNi0wMi0xNlQxMTozNDo0MVoiIHhtcDpNb2RpZnlEYXRlPSIyMDI2LTAyLTE2VDE0OjU5OjAzWiIgeG1wOk1ldGFkYXRhRGF0ZT0iMjAyNi0wMi0xNlQxNDo1OTowM1oiIGRjOmZvcm1hdD0iaW1hZ2UvcG5nIiBwaG90b3Nob3A6Q29sb3JNb2RlPSIzIiBwaG90b3Nob3A6SUNDUHJvZmlsZT0ic1JHQiBJRUM2MTk2Ni0yLjEiIHhtcE1NOkluc3RhbmNlSUQ9InhtcC5paWQ6MmY1ZjlhYjAtN2QzNC02NTQ5LWI2OTgtYWE4N2JkOTk5NTY5IiB4bXBNTTpEb2N1bWVudElEPSJhZG9iZTpkb2NpZDpwaG90b3Nob3A6ZjlmMmJhYzUtODBiYy1lODQ2LTljYTItY2YxMDRmYzIzYTQ0IiB4bXBNTTpPcmlnaW5hbERvY3VtZW50SUQ9InhtcC5kaWQ6N2EzMGIwYWEtZmE1NS1hYzRlLWFkODItNjEwNTRiMzllMWUzIj4gPHBob3Rvc2hvcDpEb2N1bWVudEFuY2VzdG9ycz4gPHJkZjpCYWc+IDxyZGY6bGk+YWRvYmU6ZG9jaWQ6cGhvdG9zaG9wOjI5YWFmNzNjLTViOGMtOWE0MC1hYjk2LWNhZWQ3YjU4MmZmYTwvcmRmOmxpPiA8cmRmOmxpPmFkb2JlOmRvY2lkOnBob3Rvc2hvcDo1ZTRlNTM3Ni0yMjg0LWM3NDEtOTNmMC05ODQ0ZDZiY2U2OGI8L3JkZjpsaT4gPHJkZjpsaT54bXAuZGlkOjIwYjUxYTRhLWIwYjktNDc0Mi1iZTQ2LTQyN2Y4NGFkYmQ0MjwvcmRmOmxpPiA8cmRmOmxpPnhtcC5kaWQ6N2EzMGIwYWEtZmE1NS1hYzRlLWFkODItNjEwNTRiMzllMWUzPC9yZGY6bGk+IDxyZGY6bGk+eG1wLmRpZDpkNTI3ZjFmNS05YTUwLTAxNDctOTE3MC03ZWM4Zjc3YjljMmY8L3JkZjpsaT4gPC9yZGY6QmFnPiA8L3Bob3Rvc2hvcDpEb2N1bWVudEFuY2VzdG9ycz4gPHhtcE1NOkhpc3Rvcnk+IDxyZGY6U2VxPiA8cmRmOmxpIHN0RXZ0OmFjdGlvbj0iY3JlYXRlZCIgc3RFdnQ6aW5zdGFuY2VJRD0ieG1wLmlpZDo3YTMwYjBhYS1mYTU1LWFjNGUtYWQ4Mi02MTA1NGIzOWUxZTMiIHN0RXZ0OndoZW49IjIwMjYtMDItMTZUMTE6MzQ6NDFaIiBzdEV2dDpzb2Z0d2FyZUFnZW50PSJBZG9iZSBQaG90b3Nob3AgQ0MgMjAxOSAoV2luZG93cykiLz4gPHJkZjpsaSBzdEV2dDphY3Rpb249InNhdmVkIiBzdEV2dDppbnN0YW5jZUlEPSJ4bXAuaWlkOmVkOWJmNTQ3LTYwZGItNTg0Ny05MTVhLTVmYzU3NmJhMDgyMSIgc3RFdnQ6d2hlbj0iMjAyNi0wMi0xNlQxMzo1NzoyN1oiIHN0RXZ0OnNvZnR3YXJlQWdlbnQ9IkFkb2JlIFBob3Rvc2hvcCBDQyAyMDE5IChXaW5kb3dzKSIgc3RFdnQ6Y2hhbmdlZD0iLyIvPiA8cmRmOmxpIHN0RXZ0OmFjdGlvbj0ic2F2ZWQiIHN0RXZ0Omluc3RhbmNlSUQ9InhtcC5paWQ6ZjM3MjFmNDYtODJlMy1jNzQ4LTlmYjYtOWUyMTg5ODM2Y2VlIiBzdEV2dDp3aGVuPSIyMDI2LTAyLTE2VDE0OjU5OjAzWiIgc3RFdnQ6c29mdHdhcmVBZ2VudD0iQWRvYmUgUGhvdG9zaG9wIENDIDIwMTkgKFdpbmRvd3MpIiBzdEV2dDpjaGFuZ2VkPSIvIi8+IDxyZGY6bGkgc3RFdnQ6YWN0aW9uPSJjb252ZXJ0ZWQiIHN0RXZ0OnBhcmFtZXRlcnM9ImZyb20gYXBwbGljYXRpb24vdm5kLmFkb2JlLnBob3Rvc2hvcCB0byBpbWFnZS9wbmciLz4gPHJkZjpsaSBzdEV2dDphY3Rpb249ImRlcml2ZWQiIHN0RXZ0OnBhcmFtZXRlcnM9ImNvbnZlcnRlZCBmcm9tIGFwcGxpY2F0aW9uL3ZuZC5hZG9iZS5waG90b3Nob3AgdG8gaW1hZ2UvcG5nIi8+IDxyZGY6bGkgc3RFdnQ6YWN0aW9uPSJzYXZlZCIgc3RFdnQ6aW5zdGFuY2VJRD0ieG1wLmlpZDoyZjVmOWFiMC03ZDM0LTY1NDktYjY5OC1hYTg3YmQ5OTk1NjkiIHN0RXZ0OndoZW49IjIwMjYtMDItMTZUMTQ6NTk6MDNaIiBzdEV2dDpzb2Z0d2FyZUFnZW50PSJBZG9iZSBQaG90b3Nob3AgQ0MgMjAxOSAoV2luZG93cykiIHN0RXZ0OmNoYW5nZWQ9Ii8iLz4gPC9yZGY6U2VxPiA8L3htcE1NOkhpc3Rvcnk+IDx4bXBNTTpEZXJpdmVkRnJvbSBzdFJlZjppbnN0YW5jZUlEPSJ4bXAuaWlkOmYzNzIxZjQ2LTgyZTMtYzc0OC05ZmI2LTllMjE4OTgzNmNlZSIgc3RSZWY6ZG9jdW1lbnRJRD0ieG1wLmRpZDo3YTMwYjBhYS1mYTU1LWFjNGUtYWQ4Mi02MTA1NGIzOWUxZTMiIHN0UmVmOm9yaWdpbmFsRG9jdW1lbnRJRD0ieG1wLmRpZDo3YTMwYjBhYS1mYTU1LWFjNGUtYWQ4Mi02MTA1NGIzOWUxZTMiLz4gPC9yZGY6RGVzY3JpcHRpb24+IDwvcmRmOlJERj4gPC94OnhtcG1ldGE+IDw/eHBhY2tldCBlbmQ9InIiPz4tZNjoAAAI/klEQVR42u1dzW4cRRAeCQyWAigmxD+bxDh2kI2IImMBEiBLcIwUZIQEkjnAAfEAROEIEhLikrfgBhdexa8QcQGJEweuw9bYtaqpruru6eqZ2d7tkSqZnZmvq7u+6u1xUp+7quu6KpavlSAsA4H02N7crDWr2JGsEyP7XxoCabD2d3fro3sH9VtHhzPjgUxFgNV/IfAqeBAkCBwYfIYA4mcMKBgGMRUBVv+FwAQEjolfeQJp8N64u9cYBhA/00DibEpFgNV/IZAESyOA3uMBtBJg9U/NsgZb1/AxXsJaAaRBlq71RYDVv0RezEvY2PiYBJgLIAfdmuzMrC8CrP75t0Bua7glAVoBhL+//vikZVIwUxNg9b8MBMbivQGUgonPpiIghX/rGjwmfqEJHBJvXYPHxMcmQCsDHp4cNoECcsEwcPQzPCP9GGAhIJX/FGvwmPiYBGgtoge7d+rvPz2tL++0AwgH3INntH9JiSXA6j/lS9jY+K4JMBdACBgcZ2dn9S9fPWoMzuGAexqB1gSw+O9zDR4SH5MAcz+HQIDOP7zfBBs7AedwjQYvJQFW/8uyhsckQCuAX2y8Uv/15FYTKLCfP/ugMfwM9+CZ1ARY/S8zgT5808A0KE3wfruzXf/3w14TqCdbN1oG1+AePAPPAgY7MA1u9d3NjWACrp6d4a3+MQiWNTgVHp+V8GCpXwLnAvh0snkZxMeX52BwDtfgXCPQQoDVP+mHeQ024JvnEA/LBl7DJQTuETKTJEBwAHF9w3VMIzCGADjn7ccSaH0JGxEflQBzAYTguAiEDMBO0MDh14+PQNoGHQBtQyMQ+iYlECcxdg22ruGUCG0GpX4JnAugRiBcw7WMd4DOHhceCcCOSAMAc+GlBCIz2fQSZsF38U8x3L8vAbj/uQD6CDi+/nIlEYizJ4RAaQbCAW378FICYfBSrMFW/Pub95wm4ZG8LniRwP3XtquNm0f1O6df1gdvflI//PzH5m8wuAb39q6tSwTOZk8IAXwG4QFtU/+0D+gf+ugiMHYNToWHID/78++aH3BNI9CCb/44Pz+fGQYQAgf26nPr9fR6fXFxgeezZymB01nVGE8AToCEp9fAB/gCn3CObbjwIQS6XsKsL1EUD0GGg86aX3//Y3bN578rXiUQgg7nGND63386EYiBDyGAEwi+MGEA40sAug7HvIRZX6IoHgmQDrjHlw8r3jsD8BonL2QGwnkIAbxd6i/kG4CuwyqB0z5oa6j1JQrP4TqdQTBzcBbhNU6eFe+dATy4PgJ5AoQQ4PIR8g1ASeQJxNdw6SWMvkTxNZgnoJYAeO5bwySMBd/8MQ1QyzDw/Do3jUCaAJwACe/zo/VH+jkQnoNg0wSCz2BwLr2E0ZcoXwJKL1GcAJeFENgFn6S07eottDE4cOA4UP45dWm86xskZAbnjF+K4lY6KD5j6Zo6nYVV1zVYam+R8KU8vegDiy2UPrBLdXAf+sAY/7njk+sDaTWwVKvRVwCs/nPHx8Sv9R+KWDjKi0mx1JsW1KQegNV/7vjY+JUAZo4XdQW0QhgboBXCWml47ACs/nPHJyeQVgHzBmin+gqA1X/u+C7xUxvQOkCv9TkAi//c8V3i5+0AgmkjQwbA6j93vC9+3gZcjQ4xAKv/3PG++LUKS2kdvsv6GIDVf+542Ph17oCrNHyIAFj9547n8Wu9xoY2oJWGxw7A6j93vCV+cyUFvgZc+kBLAKz+c8fHxq8EMHO8WFr+7v3DpngHQXAO10L0gZYBWP3njseiKhfeSSBUXUEV1rPHl5VZ1OAa3AvRB8YOwOp/FfFiZbKrAa2wFfWBIR1w6QNj/a8qvgRwWQjEwlhfA1jYmnoAof5dpelD4LXxj9X/Vmk3lqbDw/XTt2dgOOfaAUmdFBoATR/Ykp4x/4B3VUZTvNT/ULw2frimjT8Ub/Uv4UV5mUSAT+BJ9YGuDmj6QK5NkBLAVRpP8VoChZTWa+NHAjUCQvBW/xK+1cDplT5Pa8Al8KT6QFcHXPpAbN+FP3WUxlvxseMPxVv9S3ivPpBrA9bWX6i0GRCaQVoGQ9tc2xCiD0yFt4w/FG/1z/FJ9IGaPG0ofSC/hqoowVrPd8VPk3Dh8En0ga4EGEofuNKFvVZ9oCsBhtIHFgIN+kBXAgypD1xZAq36QI4dUx9YxC0JtA1D6wMLgcUKgcUKgcUKgYXA0USaxYwELopIs6h0jQSOKdIsKt2ITbCKSDJvlW6yDrg0bojtUyS6qvhkBGgaN2kHkq4ixxj/ueGTE5iCALoPXleJldV/7vjQBKhSEiDt/2PRyFkSIHd8aAJUKQmgCptYvNV/zviYBKhSE0B1EFC8BL+un+4+QjvnkliNlUBj47smQNUXAYjHajW+hYy2/1Fq/7nikxEYSoCmcaN43PvAtYVc6gTIHe9LgGQE0IPi6e4ncOzs7LT2IErpfxHxbNeWmUlbqMckQFIC6L8mcDxuKQP1MVp5eir/i47HJOD/GRCTAL0QQGv9+VcA34OoD/+LjtcIjEmAXgg4P6yqn/ZfqnC/IMAgLnADKZP/HPD4C84tCQB4tQPYiRgCgMCpNVIyMDhHSZlW2JTSfw54ssFHVAIg3ksAbgbFdQ3aAK6wIoHf3LhecRJd/qm2oksCpMZ3Gb/LP91aADfy0AikeJ4AFC8S8O3Bmkgg18c5CKw5gSiv9hEI+I/eO6ljAzgrFk6Mh3GEjN/nXyLPglcJQDUtNoAEUH2ci0Au2AwlEMnD7d5iAtgn3jf+EP+cPAte3UUSDOXQlMDAr9CaCzZTEWgNYCy+ywwesv8igXObORICQ74CcfrTnSu74mMD2Bd+Ufuv/q4XKnMOGQAXpaC4UpOWcYFK3wFcVnyrgRdvP6iuPXjUCj4l4Hjr9er22vOdCHSRJxF4fHdL9Y8ai8lkou9AtmL4OQJQDuZqIEQi1pVAaeYyvChTo3j6UoDaxGXHtxrgWj7cti20A1zXp+kCXQQKuNqlE+R4EoCZLTN+jkBNTOnrgKTp03SBksYvRNAZ8g2gBWBZ8WIAtRnj6oB0aLpA3xrq6oM2g4s2oliW9j8kRDdt5u6b4wAAAABJRU5ErkJggg==',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAHAAAABgCAYAAADFNvbQAAAACXBIWXMAAAsTAAALEwEAmpwYAAALDWlUWHRYTUw6Y29tLmFkb2JlLnhtcAAAAAAAPD94cGFja2V0IGJlZ2luPSLvu78iIGlkPSJXNU0wTXBDZWhpSHpyZVN6TlRjemtjOWQiPz4gPHg6eG1wbWV0YSB4bWxuczp4PSJhZG9iZTpuczptZXRhLyIgeDp4bXB0az0iQWRvYmUgWE1QIENvcmUgNS42LWMxNDUgNzkuMTYzNDk5LCAyMDE4LzA4LzEzLTE2OjQwOjIyICAgICAgICAiPiA8cmRmOlJERiB4bWxuczpyZGY9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkvMDIvMjItcmRmLXN5bnRheC1ucyMiPiA8cmRmOkRlc2NyaXB0aW9uIHJkZjphYm91dD0iIiB4bWxuczp4bXA9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC8iIHhtbG5zOmRjPSJodHRwOi8vcHVybC5vcmcvZGMvZWxlbWVudHMvMS4xLyIgeG1sbnM6cGhvdG9zaG9wPSJodHRwOi8vbnMuYWRvYmUuY29tL3Bob3Rvc2hvcC8xLjAvIiB4bWxuczp4bXBNTT0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL21tLyIgeG1sbnM6c3RFdnQ9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9zVHlwZS9SZXNvdXJjZUV2ZW50IyIgeG1sbnM6c3RSZWY9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9zVHlwZS9SZXNvdXJjZVJlZiMiIHhtcDpDcmVhdG9yVG9vbD0iQWRvYmUgUGhvdG9zaG9wIENDIDIwMTkgKFdpbmRvd3MpIiB4bXA6Q3JlYXRlRGF0ZT0iMjAyNi0wMi0xNlQxMTozNDo0MVoiIHhtcDpNb2RpZnlEYXRlPSIyMDI2LTAyLTE2VDE0OjU4OjQ4WiIgeG1wOk1ldGFkYXRhRGF0ZT0iMjAyNi0wMi0xNlQxNDo1ODo0OFoiIGRjOmZvcm1hdD0iaW1hZ2UvcG5nIiBwaG90b3Nob3A6Q29sb3JNb2RlPSIzIiBwaG90b3Nob3A6SUNDUHJvZmlsZT0ic1JHQiBJRUM2MTk2Ni0yLjEiIHhtcE1NOkluc3RhbmNlSUQ9InhtcC5paWQ6YWVmMjk3YTItMTk5OS0xZTQ5LWJjMjMtZGZiMGI5NGNkOGQ4IiB4bXBNTTpEb2N1bWVudElEPSJhZG9iZTpkb2NpZDpwaG90b3Nob3A6ZmRhMjdhYWQtNzc0NC1iZDRjLWI1OTktN2QyNGFhZDI5MmQwIiB4bXBNTTpPcmlnaW5hbERvY3VtZW50SUQ9InhtcC5kaWQ6N2EzMGIwYWEtZmE1NS1hYzRlLWFkODItNjEwNTRiMzllMWUzIj4gPHBob3Rvc2hvcDpEb2N1bWVudEFuY2VzdG9ycz4gPHJkZjpCYWc+IDxyZGY6bGk+YWRvYmU6ZG9jaWQ6cGhvdG9zaG9wOjI5YWFmNzNjLTViOGMtOWE0MC1hYjk2LWNhZWQ3YjU4MmZmYTwvcmRmOmxpPiA8cmRmOmxpPmFkb2JlOmRvY2lkOnBob3Rvc2hvcDo1ZTRlNTM3Ni0yMjg0LWM3NDEtOTNmMC05ODQ0ZDZiY2U2OGI8L3JkZjpsaT4gPHJkZjpsaT54bXAuZGlkOjIwYjUxYTRhLWIwYjktNDc0Mi1iZTQ2LTQyN2Y4NGFkYmQ0MjwvcmRmOmxpPiA8cmRmOmxpPnhtcC5kaWQ6N2EzMGIwYWEtZmE1NS1hYzRlLWFkODItNjEwNTRiMzllMWUzPC9yZGY6bGk+IDxyZGY6bGk+eG1wLmRpZDpkNTI3ZjFmNS05YTUwLTAxNDctOTE3MC03ZWM4Zjc3YjljMmY8L3JkZjpsaT4gPC9yZGY6QmFnPiA8L3Bob3Rvc2hvcDpEb2N1bWVudEFuY2VzdG9ycz4gPHhtcE1NOkhpc3Rvcnk+IDxyZGY6U2VxPiA8cmRmOmxpIHN0RXZ0OmFjdGlvbj0iY3JlYXRlZCIgc3RFdnQ6aW5zdGFuY2VJRD0ieG1wLmlpZDo3YTMwYjBhYS1mYTU1LWFjNGUtYWQ4Mi02MTA1NGIzOWUxZTMiIHN0RXZ0OndoZW49IjIwMjYtMDItMTZUMTE6MzQ6NDFaIiBzdEV2dDpzb2Z0d2FyZUFnZW50PSJBZG9iZSBQaG90b3Nob3AgQ0MgMjAxOSAoV2luZG93cykiLz4gPHJkZjpsaSBzdEV2dDphY3Rpb249InNhdmVkIiBzdEV2dDppbnN0YW5jZUlEPSJ4bXAuaWlkOmVkOWJmNTQ3LTYwZGItNTg0Ny05MTVhLTVmYzU3NmJhMDgyMSIgc3RFdnQ6d2hlbj0iMjAyNi0wMi0xNlQxMzo1NzoyN1oiIHN0RXZ0OnNvZnR3YXJlQWdlbnQ9IkFkb2JlIFBob3Rvc2hvcCBDQyAyMDE5IChXaW5kb3dzKSIgc3RFdnQ6Y2hhbmdlZD0iLyIvPiA8cmRmOmxpIHN0RXZ0OmFjdGlvbj0ic2F2ZWQiIHN0RXZ0Omluc3RhbmNlSUQ9InhtcC5paWQ6Y2YyNGIwNTctZjBiMi02NTRmLWEyNmQtYTc1YjFiZTZkOWUwIiBzdEV2dDp3aGVuPSIyMDI2LTAyLTE2VDE0OjU4OjQ4WiIgc3RFdnQ6c29mdHdhcmVBZ2VudD0iQWRvYmUgUGhvdG9zaG9wIENDIDIwMTkgKFdpbmRvd3MpIiBzdEV2dDpjaGFuZ2VkPSIvIi8+IDxyZGY6bGkgc3RFdnQ6YWN0aW9uPSJjb252ZXJ0ZWQiIHN0RXZ0OnBhcmFtZXRlcnM9ImZyb20gYXBwbGljYXRpb24vdm5kLmFkb2JlLnBob3Rvc2hvcCB0byBpbWFnZS9wbmciLz4gPHJkZjpsaSBzdEV2dDphY3Rpb249ImRlcml2ZWQiIHN0RXZ0OnBhcmFtZXRlcnM9ImNvbnZlcnRlZCBmcm9tIGFwcGxpY2F0aW9uL3ZuZC5hZG9iZS5waG90b3Nob3AgdG8gaW1hZ2UvcG5nIi8+IDxyZGY6bGkgc3RFdnQ6YWN0aW9uPSJzYXZlZCIgc3RFdnQ6aW5zdGFuY2VJRD0ieG1wLmlpZDphZWYyOTdhMi0xOTk5LTFlNDktYmMyMy1kZmIwYjk0Y2Q4ZDgiIHN0RXZ0OndoZW49IjIwMjYtMDItMTZUMTQ6NTg6NDhaIiBzdEV2dDpzb2Z0d2FyZUFnZW50PSJBZG9iZSBQaG90b3Nob3AgQ0MgMjAxOSAoV2luZG93cykiIHN0RXZ0OmNoYW5nZWQ9Ii8iLz4gPC9yZGY6U2VxPiA8L3htcE1NOkhpc3Rvcnk+IDx4bXBNTTpEZXJpdmVkRnJvbSBzdFJlZjppbnN0YW5jZUlEPSJ4bXAuaWlkOmNmMjRiMDU3LWYwYjItNjU0Zi1hMjZkLWE3NWIxYmU2ZDllMCIgc3RSZWY6ZG9jdW1lbnRJRD0ieG1wLmRpZDo3YTMwYjBhYS1mYTU1LWFjNGUtYWQ4Mi02MTA1NGIzOWUxZTMiIHN0UmVmOm9yaWdpbmFsRG9jdW1lbnRJRD0ieG1wLmRpZDo3YTMwYjBhYS1mYTU1LWFjNGUtYWQ4Mi02MTA1NGIzOWUxZTMiLz4gPC9yZGY6RGVzY3JpcHRpb24+IDwvcmRmOlJERj4gPC94OnhtcG1ldGE+IDw/eHBhY2tldCBlbmQ9InIiPz4BE02oAAAH20lEQVR42u1dv6skRRDev0J4uWBi4sEpiqCYmDx4cJEvMzAwNxKMxFDFv0HBAzk4QbnsYSwYyQPBQDyMDuT54x8Yt8atpbamqn9V9cz0bA/UvdnZ+aZ6vq96une36no3DMOuW7vWSdiCgHT79uuvBs12bHNrxML+NyMgJevXn34c/n762zD889fROJFeAlj9dwEP5AFJQBwYvAYC8TUSCoYkeglg9d8FdBBwSfzZC0jJe/bL7WhIIL6mRGJv8hLA6r8LSMjSBKDvcQKtAlj9e43BS+HdBKQkS8dqCWD17zUJWxpfEgATAjnohyffHa2WAFb/rY/hlgA4IRD+PvngwYlJZHoLYPW/BQFL8VECJTLxXC8BPPxbx+Al8asWcE68dQxeEl8aACcR8Ok7b4xEgbhgSBx9DedIHwMsAnj59xiDl8SXBMDJIPrWK/eG/3kZJgTiscM54jcppQJY/XtOwpbG5wbAhEAgDLarq6thePjRaOP+foP3NAGtAWDxX3MMnhNfEgCTzyFA0KP33x5+/+y9YyNgH45R8jwFsPrfyhheEgAnBF5eXg53d3cjUWCfPHhtNHwN78E53gJY/W9ZwBj+SCCSd3t7O9zc3IgG71ESvQTw8G8dg73weK6EB/OeBIoEhkwj0CqA1b/XGGzAH0XCIQRf4xBCz/EKAFUAThyOb3Qc8xSAX5/jUp4AHpMwj0ncUcgDnh7zDoAJgSgEFRH28X2IAC4gF08KAHoMReAC4iMM9rl/xGgB5DEGL40vCQBVQKnn4FjGG0B7jxYAVAAUQboBHCu1nhsS0DoJs+BpIMfwFMPxsQDg+AmBcELIpAiivScUACgA9mIpgmP+tUeQ5xhswb/63PNB88ZPCHz9pavh5+8/Hz58d6/6Fx8P8Br24Rjsa48AjLIUAUKPQOof9qENKf49J2EWPJD89I9nA9/gWKqAOXiVQCAObPj3z+H6+nq00DN836tG4wGQKgB9CqA/8I3XyBGwZBJmnUQhHkiGjfaaL955fDwW85+Lj/YAIJJPXlIEROJTBaAC4uMYfOc8AUonYR6TKMSjANIG78X85+JFAnmk8slLag+E/VQBeBuob96eFAFzJmEekyicC9AeBD0HexEew7HfCz/+g+SD8Uik73GTBOSE89cSPuSD9xzNv2US5jGJwv3YGCZhLHiRQCQ+RGxIQBoAKQLE/GjtiU2CciZh1kkUFSBkKQLm4N1rG6RHbuwR7OFf+kgjBVCMwNbw20huJRvvsfu/SWO4RIKA5dez4K3+1bTCbr0+sNta6gNzsoNrPAJL/LeOd68PpNnAUq5GLQKs/lvHl/B38oMiJo7yZFJM9aYJNd43YPXfOr6Uv05g4/hJZjBNJAXDC9AMYS01vPQGrP5bx7sLSLOA+QVoo2oRYPXfOj6HP/UCWgPosZo3YPHfOj6Hv2gDEEwvMicBVv+t42P8RS8QuugcN2D13zo+xt9JYinNww9ZjRuw+m8dX8pfdgNCqeFzEGD13zqe83cyjU29gJYaXnoDVv+t4y38TX7Rjl0gVB9oIcDqv3V8KX+dwMbxYlLT/RdfGH8BRhDsw7GU1HDLDVj9nyNeTC3XMpNT6wNLb8Dq/xzxruVdlhtYS2Z1a/hO4BYFDJWHzXEDVv/nhJ+kdsdS06XMZK/6QHp9LbU9lJoeqmtIwWv3z+srLHir/2BqPWY2Sz0pVFvgUR/I8yG1nqvNYunNhXp+bBofepKEBEjFW/1HP0aklobVqA9MKVGLfYyx4EvvPwdPz/fAb6Y+sAZeun9Itl0T3q0+UGvAXPWB9Bji0bBKam+7FDyez69zyPJeFd6tPlALgDnqA3tir0N9oBYAc9QHnr2A1vpAqZ5vzvrALqCxPjAUAHPUB/bilsbrA7uA3bqA3bqA3bqAXcDFijS7GQVcS5Fmr9I1CrhkkWav0i1YBKsXSbZdpevWgFCNG2JrFomeK95NAK3GTVqBJLfIscR/a/gSAUcRawpA18HLLbGy+m8dnxoAO08BpPV/LDVylgBoHZ8aADtPAWiFTSne6r9lfEkA7LwFoHUQ8BMS/G/rdPUR2rhQidVSAbQ0PjcAdrUEQDz+NsiXkNHWP/L23yo+RcCdpwBajRvFh1YvqRUAreNjAeAmAN0onq8/dHFxMS5kIaUWWv2vEc+Wy6HL65x8JVYaAK4C0G8TOB7XJMIstxDe6n/teAwC/mNASQBUEYBmk/FHAF9DqIb/teM1AUsCoIoA9BqQVg8YxKXklnr4Xzse/4NzSwAAvpoAkEaPdRFSXULtAFg7nizwURQAiM8SgFf31BSQ4nll71L40gDm5XR0IY8QXgsAis8SAPZTFjKm5yNeI1HCv/nyvaGUQFqz6IVHkzLEc/1L4lnwwfoESQBeI6EJyDOyUwXk4pUQWBMfu/8U/1w8C15dhpQ2ViuQjAlIM7S9BLQSWIrP6cFztl8UUKqUzXkEYgPwhkvxJQTWwkOF1WFoWFX71UcoL1XOEYBWKWGpGa9Myr2B0gDA8jYvfK6A3v6TCMTK1lBtX6qAIfFy/adG8Dnh1THQ0gCLgFrj6WehlFkgFqduHa8uQwqGj8CUBmh1fbE6w9AkCguL6fGUScCBgNH2+N2W8cFlSKVvBrQG5BRmxgQMtSH1cxwnYKv4iQCh4k7pvdhXSVJdYMh/ToFpL/LsxS3N239+7VbDOZpVPgAAAABJRU5ErkJggg=='
  ],
  desk:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAv0lEQVR4Ae3BIa7CQBSG0a83N4iaZyAhxWARbIV9vDzNKtCEfbCiMTMhaU3NiBqYklnD/Oadg1pHcfvdvhG4PqbOqXY/W1oa54mVU+2HDS2NM1+GmCHmFCFmINFSiJmVUxwPPefTQFsJyBhihpghZogZYk71SgsKTrUfNrQ0znwZYoaYIWaIGWJOEWIGEi2FmFk5xfHQcz4NtJWAjCFmiDnVKy0oONU4Tyg4RYiZ1f2ZOxr4u/RvKkPMEDP+iX0ABRgsZWvI5xIAAAAASUVORK5CYII=',
  fullPcCoffeeOn:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAACPUlEQVR4Ae3BMUsbUQDA8f8L9wUKbYZM5XiLcJSCHcwUh4AgFApp2i5FyBQdHJzcNLSDU0AHzRRwK54BQQgIN+Q69DJIB7mtj9dSykFPof0GrzmIcIQkNklxaX4//nuiVK4aZtByG4IZWPScnhyR+P4jZhJbWzvMyop8j3anyzQi32NWFn2nH3+xW1mkdm6wXzxCn10zTmnhK/9ChpTauSGhz665LxlSdp4LEnsrB9yXDCm1c0Ni+2KT+2KRsrdywPbFJtMqlauGlJbbENzBImX7YpNplcpVU9lYY3V5iUS706XHtNyGYAyLFHP9mb+28IBBq8tLvHy1TuL05Ijm4TGlctW03IZgBIu+3coikwiVZpjI90jbX/8NVE3LbQiGsHKFIu9fv2UauUIRXEUi8j3anS6ffn4h0e50iXyPq6ePifxLRhEMyGelyRWKJCobaySah8ckIt8jiJVgiHxWGvfDM9LKby5JBLESjGAxIFcoUtlYw5E2t+r1GqHSNOlxFaNcBTc8yT8kcRXckAhiJRjDYojm4TGTCmIl3u1j2P/GrSBWgrk7CFLyWWlyhSLjRL5HECtBX6lcNfS03IZgChYpuUKRer1GqDSOtAmVxpE2odI40iZUmiY9riJRKldNvV4jVJoe03IbggllGBAqjSNtQqVxpE2oNI60CZXGkTaDQqWZRYYBjrQJlSYRKo0jbUKlcaRNqDRpke9xK/I9piFIyWelyRWKjBP5HkGsBH35rDT0BLESzM3NzU3hD5xb3OrEH1kvAAAAAElFTkSuQmCC',
  fullPcCoffeeOff:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAACEUlEQVR4Ae3BMWsaUQDA8f+T+wjFwakcbzxKhw5xMoNTVmPSJQQymYyZAyU0s5DFOgmSJenV1ekG39CeQ7qEt/XxKKU86JGh3+DVAwOHGIMastTfj/+eaDRbnjUM4q5gDQETXz5/Ivfrd8YyTk8/sK7AqYThaMwqnEpYV8DUxf4Byzi7ueI5BBSc3VyR63X6OJXwEkrM6HX6OJXwUkoU9Dp9nEp4SQEFTiWso9FseQoGcVfwhIBn0mi2/NHJITvbW+SGozETfhB3BQuUeEY721vs7h2zu3fMzvYWuUaz5VkgYOr6+1eWoY1lHqcSii6P/wItP4i7gjmCSq3Oxf4Bq6jU6hAbck4lDEdjvv35QW44GuNUwt3b1zh1y2MEM6pl6Su1Ormjk0NyvU6fnFMJaWYEc1TL0sfX7yhqvr8ll2ZG8IiAGZVanaOTQyIZ8qDdPkcbS4+J2PCYu/SeN9VX5O7Se3JpZgQLBMzR6/RZVpoZ8fESz+VPHqSZEWw8QVBQLUtfqdVZxKmENDOCqUaz5ZkYxF3BCgIKKrU67fY52lgiGaKNJZIh2lgiGaKNpcdEbMg1mi3fbp+jjWXCD+KuYEklZmhjiWSINpZIhmhjiWSINpZIhszSxrKOEjMiGaKNJaeNJZIh2lgiGaKNpcyphAdOJaxCUFAtS1+p1VnEqYQ0M4Kpall6JtLMCDY2NjZW8A+NStHHd0gqbQAAAABJRU5ErkJggg==',
  chairBack:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABEklEQVR4AcXBv2rCQADA4V9CnsElU0CIQydd6kM4iJAMvcVXEFw76KIE8gou5xChZOhD6KKTQw6ETFl8CRvhjlxL/QMd+n38OwfLeDK98IRVmjhoHtp4Mr1EsSAMfO5RZUXtskoTh5qLJQx8HgkDH5vHD6qsuCcMfGweWiFzVCwwNpnEFsWCK1VWFDLHcLmhkDlRLIhiQSFzbvHQOmLIbDDCtskkxmwwwuiIIds04crDsj7uMN5eXrGtjzuM+WKJ4fJHLlohc1RZ8YgqKwqZY3hYNpnklvliyW8cGt1+q73nCdvzqQccqDk0umj9Vnv//vlBGPhcqbJiNhixPZ96NA7UHL7roo0n0z2WVZr0aBzQvgALH1OPfJHIAwAAAABJRU5ErkJggg==',
  fullBookshelfTall:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAgCAYAAAAbifjMAAABs0lEQVR4Ae3BsWrbQACA4V/yPYAzKLSUbjHcJEM0+HLbjRm1mSCwnU7FpQaD9nTKEDDEUDzWDvIsQ1dDtiQdumSJIH2CklcILhekVJjSKmjt9/Fffc5gHG/IfZmcOVQwGMcbcs5gHG9G/R7n8wUvMer3OJ8vEOSM0viyRRW32T0Fl5pcahKU7Ox4VHNPQWRJyq3SXN5cUdXlzRVWlqQIclmSkiUpVRmlsVxKZBRiyeEUOZxiNeIOjbiDJaMQGYWUudTk8geOt4/j7WMtuxOW3QkFozRlgn84vbvgbwQ5GYUYpRn1e8ADT9Yrnq0PKcgopCDIZUlKlqRUZZTGcimRUYiMQiwdNNFBE0sHTXTQxHr36g1lLjW5bDFKY/ltD7/tYfltD7/tYXXevqbMpSZBTkYhRml82WK2XlGYHfFsdgSPgJwvKAhyWZKSJSlVGaWxBCUyCtmWJSmNuMPj2TfkcIqVff5IwaUmly1GaYzSGKUxSmMtuxOsk+OAk+OAMkEFp3cXWJ++btgmKDFK48sWZbP1iifrQ+AB6z2/CUpmH2JeyjnY3duQu/75I6CCg9297+R+AQ2xb+um94kUAAAAAElFTkSuQmCC',
  windowDoubleWhite:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABZElEQVR4Ae3BMWobQRSA4d+rvcNr1L0TvFNsuUXYAwg1KSIdQMiVhQ6QBJIm7AFECpcGNz7BgCqBGHAVGNzoBglbDAzKjnYbV97vYzKZTCYf3h2JT83nv7yz34efdyRKrtzff+G9PDx851rJlePpzOPhiTHqpuLx8MQYdVPRpyRjsdliKjgfiEyFaL1cES02WyJToeN8IGr3O3IKMkwF5wORqRA5H+hjKnScD4xVkOF8IDIVIucDfUyFjvOBlKlwS8EAUyFyPtDHVOg4H0iZCkNKMtr9jk7LsPVyRZ+WYSUZX399I3I+kDIV1ssV0WKzJWUqRM4H2v2OnIIBzgdSpsItpkLkfGBIwQ3OB1KmQsf5QB9TIXI+MEZBhvOBlKnQcT7Qx1SInA+MVZIxn11Ivb1e6Mxn/Gc+u/D2eiGazxitpEfdVBxPZ26pm4pO3VQcT2duqZuKnJLEn5dnfrw8M5l8KP8AhMBwbPAxjnoAAAAASUVORK5CYII=',
  chartSm1:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABYElEQVR4Ae3BsUsbURzA8W/k9xdU3buE3uQcMimvw0Pe0ExSiMSOugiCi1goOApCpro1oQeO1+ENb/Dh1nZ2Ogj5E/RfUE4UnkfuEskli/f5UKvVau9eg8C3o+MHluDXxXmDZ0LO4V6PReoPhoSEQBon3LbaLFIaJ4SECW7+/2URtlpt8oQCh3s9qtQfDJlEKLD+8RPLsEIJ7yx5l+MDLscHTOKdxTuLd5aMdxbvLGWECiltCCltmEaYw/f4jsxZd5WMdxalDd5ZQkobiggzuP+6S+bD1W/KKG3IKG2YlVAh7ywhpQ3eWZQ2FBEqpLQhT2lDGWEK7yz0dnjiLE22yfiRZXONJ96B0gbvLBmlDbMSSihteAulDW8lFDj9ccIyCBNstdq82IiahG7TEVUSAlG3w0bUJLT/+Quhn9d/mEfU7fDv4pwXQiCNE/q8FnU7hPqDIfNI44SQkJPGCbV35RHF7V83pDi+ZgAAAABJRU5ErkJggg==',
  chartSm2:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABbUlEQVR4Ae3BoUsDUQDA4Z/jVdMwWYQhXjJva3KGAy+4OLihtmkRBIs4EM4mqCvT5gaXLGd44QUfNmc2HYjR6P4F5cDB87h5UzeL933kcrncvzeDYWtv/40/cHV6MsMHQcLu5gbT1O72MAkMURDyWK4yTVEQYhKkuHu4ZxpWylWSBCPsbm4wSe1ujzSCEeYWljAN6g1iZ2vnxHyvyCQUGMOg3iCpFbxi0kqilSSmlUQriVaSLIIMg3qDUVrBK75XJGY7LkO24zIuwYRoJUljOy5fEWS4Pp7lkz6pbMflJwp803ylRRqtJFpJtJJoJYlpJckiyNAsdbh83sE0X2nx0vfxvSJDtuOSZDsuWQqMoVnqkOR7RUxaSbSSfJdgTM1Sh6/YjstPCEY4PDrgLwhSrJSrDC1bi5geoycmSWCwvBrL1iKm7dV1TBe3N/yG5dXon54wJDBEQUibzyyvhqnd7fEbURBiEiREQUjuX3kHkIBkZqncyO4AAAAASUVORK5CYII=',
  clockWall:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAgCAYAAAAbifjMAAABN0lEQVR4Ae3BsUoCcQDA4d9fe4ZTalUJrrtbKlCIa2gRTDpoMQKFRGjyBRx08h3i3KIgiECC5iYHhTvE0SXIwyTCBCEIuRAMjuOkpfG+j1Ao9D8Ea5iq7uJT7j8LfAQBTFV3jXwWv4f2E+X+s8Ajio+p6q6Rz+JYNtNqmZmcYianmF/fsX94QGr6XW+/vTRYieBhqrpr5LM4ls2iWUNTZC6PTtAUmUWzhmPZGPkspqq7rETwaI1HOJbNollDU2S8NEVm0azhWDat8YhfEQJoikwQTZHxi/CH7XODTCxJJpYkyAYBBrkCO4+3LFVLRSgVWRrkCvhF8XidfzTsz6/68dYmk5t7pLNT4jGJeEzi/aLKUqXbozMZClYEAdJSwr3a28Wv0u3RmQwFHoI10lLCxaczGQpCoQA/t7piRtUbUu0AAAAASUVORK5CYII=',
  coffeeMachine:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAgCAYAAAAbifjMAAABCklEQVR4Ae3BsUrDQACA4f+OewafQMHJxSlxyOjoEALOTilkDbhk6uhaSB6hEDM4CnHIoFl06VRo5wwtmEeIOehwhGulZBHp93HyHwgMfhB2HFDkmWBAsOMHYXcX3HLIS/5KkWcCg2QkyUiSkSQjSXaaqsRzXPbxHJemKhlSGNp2i+e42LTtFs0Pwo5ekWeCnmKgqj+wubq8QEuSiJ2uyDMhGUkykEYxmue4eI6LlkYx+ygs0igmxW46naE1VYmmOFKSRGiTqkRTHOnt8xuTZCSFxWT2hCmNYhbLFTYKw2K54jfPjw9o9WYt6AkMztl5R2/+9Y7p/voGrd6sBQOCAT8IOyyKPBOc/FE/flVJ/zUuOdkAAAAASUVORK5CYII=',
  plant2:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAgCAYAAAAbifjMAAACEklEQVR4AaXBQUvbYBzA4d/7LpfchLqdBfUakQrbWgIVhLGLhHwCFQTvsnM/QD+C32HsKgx2GE3oIV3NMUQYPaaW9NZLyn/NaOE1xjHI8ygRoQlNQ5qGNA1pGtI0pGlI05DFmlKKLdfzhbWf374q/kFEKGlq9PotXM8X/oOmxmQ6p9dv4Xq+sOF6vrieL1RYbHx8dyC8wvV82bmEp+uYKo3hzZf3FEFMnthMpnOKIMb1fJGuTZ7Y1NFUWB2H1WBE6ez+lCKIKanhkpLr+eJ6vrChWXM9X6yOgxouMU2mc0pquKRkdRx6/RYmzVoRxPT6LYogZitPbExFENPrt5hM5xRBzJZmLcxS9f3TD87uTymCmK08sbE6DkUQs3vnMJnOebqOCbNUsaExTKZzdu8cTNK12coTmyrNRpil6uk6pmR1HLbUcMnunUNpNRgRZqnCoKnIE5udS1DDJaY8samjMYRZqlaDEXliY8oTm9VgRJiligqN4fbzibAhXRs1XCJdm63bzydChabi5uqQ1WCEaTUYcXN1SB2LNRFBKUVp73ifTntGMBjxVwCd9g57x/vEDzNEBJOFIYgWOEePnF984PyCZ37/eiSIFlRZVMQPM+rEDzPqWBjCLG0THUTUCKIFYZa2qbB4hXP0lq34YcZrLJ4bh1naJjqIgmiBKczSNjCmwuKlcZilbV4aU0OJCE1oGvoD/ynYbmI3ZXEAAAAASUVORK5CYII=',
  plant3:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAgCAYAAAAbifjMAAACB0lEQVR4AaXBMWrbUACA4f+9atEmcDOkQwkks9ygQItA4C1kCUIniIecIHT2AXSE3iHkAIEMAQkNch2N4gWKhwxKjDx1snhFqVwURaaDvk9orRlCMpBkIMlAkoEkA0kGkgxk0BBCsIvnB5rG/c210FqzJfkPzw/0ZDZiMhvRx6DF8wNN4/7mWnh+oCezEYvlitomyugyaHh+oCezEbXFcoVHoDdRxmJpU3u5zIgLJeiQNO5vrsXt6R2L5YqaNeWfMjfZRdISF0q8XGaUuUntw/evlLlJFSbEhRL0kHTEhRJVmFDmJrUqTDBc+5PnB/ueH+zTIekRF0pUYULLE/AEPNFh0OL5gaaxiTJqhmtjTeHL5xF/BRoQNAwanh/oyWxEbbFcscZGA9aUV3e3v6nChC6DxibKuD2Fjz9satYUypxXZW5ShQlxoQQdkkZcKBEXSrxcZpS5yVaZm1RhQlwoQQ9Jh+tYVGFCmZu0XZ2daHpIWq7OTrQ93sN1LKowoVaFCa5jYY/3uDo70XRIOg6OD4nSNW1Ruubg+JA+kh6uY1GrwoSa61hsaa1pM2iJ0jX2+JHzi2+cX/DGr5+PROmaLoOO7OGZPtnDM30MWuJCOaRHKT2idE1cKIcOgx3s8R5b2cMzuxi8NY8L5ZAepVG6pi0ulAPM6TB4bx4XyuG9OT2E1pohJAP9ARUu0EX9Xv9TAAAAAElFTkSuQmCC',
  waterCooler:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAgCAYAAAAbifjMAAACB0lEQVR4AdXBsUsbUQDA4V/ONzgU3mQ6FJLFwPVOMtSIRlwKLhUsBkEQxBYHIVjsEApZhCgOhaBDCAgdDyEgSpwui9CleAVDQSExEBdvdLt/wGsDF/o4zpLg1O/j/xfjCYVKzUdxsL0aI0KMCIVKzS+uZFF9PXE42F6NETJCSKFS84srWSzb5brrcd31uO56bC1N8JiYLjmNs10UIygKlZpfXMli2S6GKRmLjzIWH+Xd1Ess22VraYLHxHTJaZztEtCIYJgSVfPewzAlUTSeSUNxub+DZbtkkpKwTFJi2S6X+zuoBBEs22V9IYHKsl2iCCIYpsSyXVSGKWm3PMI0Atn4uI9ifSHB+kICw5QYpkSVjY/7BDQitFseYe2WRxQNRb5a5rS4gWFKmvcezXuPdsuj3fIwTMlpcQPn4S6GQiMkXy2zt7hMJinJJCWGKTFMyd7iMvlqGeuk7qMQBPS1HGk9xU2nS75a5n16HlW+WqYnrafQ13I4h2V6BCFpPcW/3HS6qAQR8vNLfJvKsHnVpOd16Qe3pTmOLs4J03jC5lWTvtvSHE8RRNDXcgxKEOHzxw8MShBy0+kyDIHi+89LhiVQvJ2ZZRCd4zp9Gs8kUBx9+sKwNALOw90kA3Ie7iYJxPjrDcP5xR+/AeXon2ASSnJ3AAAAAElFTkSuQmCC'
};

function makeWorkstation(charIdx, status, showPlant){
  var charSprite = status!=='offline' ? PX_SPRITES.chars[charIdx] : '';
  var pcSprite = status!=='offline' ? PX_SPRITES.fullPcCoffeeOn : PX_SPRITES.fullPcCoffeeOff;
  var charClass = status==='online' ? 'seated-back' : 'idle-char';
  var html = '<div class="px-scene">';
  html += '<img class="px-sprite px-pc" src="'+pcSprite+'">';
  html += '<img class="px-sprite px-desk" src="'+PX_SPRITES.desk+'">';
  html += '<img class="px-sprite px-chair" src="'+PX_SPRITES.chairBack+'">';
  if(charSprite){
    html += '<div class="px-sprite px-char '+charClass+'" style="background-image:url('+charSprite+')"></div>';
  }
  if(showPlant){
    var plantSrc = charIdx%2===0 ? PX_SPRITES.plant2 : PX_SPRITES.plant3;
    html += '<img class="px-plant-sm" src="'+plantSrc+'">';
  }
  html += '</div>';
  return html;
}

async function load(){
  try{
    const ctrl=new AbortController();
    const timer=setTimeout(()=>ctrl.abort(),15000);
    const r=await fetch(BASE+'/api/mc/state?key='+encodeURIComponent(KEY),{signal:ctrl.signal});
    clearTimeout(timer);
    if(!r.ok){
      const eb=document.getElementById('error-banner');
      const reasons={'401':'🔑 Verkeerde key — controleer de URL','403':'🔑 Geen toegang','500':'💥 Server crash — check Render logs','502':'🔄 Server herstart (Render deploy bezig)','503':'😴 Server slaapt — wacht 30s tot hij opstart','504':'⏱️ Gateway timeout — server te langzaam'};
      eb.textContent=(reasons[String(r.status)]||'Fout')+' (HTTP '+r.status+')';
      eb.style.display='block';
      return;
    }
    document.getElementById('error-banner').style.display='none';
    const d=await r.json();
    document.getElementById('refresh-time').textContent='Vernieuwd '+new Date().toLocaleTimeString('nl-NL',{hour:'2-digit',minute:'2-digit',second:'2-digit'});

    // Market chip
    if(d.market){
      const open=!d.market.blocked;
      const chip=document.getElementById('mkt-chip');
      chip.className='hdr-chip '+(open?'open':'closed');
      document.getElementById('mkt-label').textContent='Forex Market: '+(open?'OPEN':'CLOSED')+(d.market.reason?' ('+d.market.reason+')':'');
    }

    // Gateway chip — probeer eerst direct localhost te pingen (browser → lokale gateway)
    // Gebruikt favicon als image-ping (omzeilt mixed-content blokkade HTTPS→HTTP)
    const gwChip=document.getElementById('gw-chip');
    const gwLbl=document.getElementById('gw-label');
    let gwResolved=false;
    try{
      gwResolved=await new Promise(resolve=>{
        const img=new Image();
        const timer=setTimeout(()=>{img.src='';resolve(false);},2500);
        img.onload=()=>{clearTimeout(timer);resolve(true);};
        img.onerror=()=>{clearTimeout(timer);resolve(false);};
        img.src='http://localhost:18789/favicon-32.png?_t='+Date.now();
      });
      if(gwResolved){
        gwChip.className='hdr-chip online';
        gwLbl.textContent='Gateway: ONLINE (lokaal)';
      }
    }catch(e){/* gateway niet bereikbaar lokaal */}
    if(!gwResolved){
      if(d.gateway){
        const gs=d.gateway.status;
        gwChip.className='hdr-chip '+(gs==='online'?'online':gs==='idle'?'idle':'offline');
        gwLbl.textContent='Gateway: '+(gs==='online'?'ONLINE':gs==='idle'?'IDLE':'DOWN')+(d.gateway.age_mins?', '+d.gateway.age_mins+'m ago':'');
      } else {
        gwChip.className='hdr-chip unknown';
        gwLbl.textContent='Gateway: onbekend';
      }
    }

    // EA positions
    const EA_NAMES={'12033719':'Flexbot test'};
    const eaEl=document.getElementById('ea-body');
    const activeEa=(d.ea_positions||[]).filter(ea=>ea.updated_at_ms&&(Date.now()-ea.updated_at_ms)<24*60*60*1000);
    if(activeEa.length===0){
      eaEl.innerHTML='<span style="color:var(--muted);font-size:.8rem">No active EA connections</span>';
    } else {
      eaEl.innerHTML=activeEa.map(ea=>{
        const fresh=ea.updated_at_ms&&(Date.now()-ea.updated_at_ms)<5*60000;
        const hasPos=ea.has_position;
        const cls=fresh?'fresh':(hasPos?'has-pos':'');
        return '<div class="ea-card '+cls+'">'+
          '<div class="ea-name">'+(EA_NAMES[ea.account_login]||ea.account_login)+'</div>'+
          '<div class="ea-equity">'+(ea.equity!=null?'$'+ea.equity.toFixed(2):'—')+'</div>'+
          '<div class="ea-row"><span>Symbol</span><span>'+ea.symbol+'</span></div>'+
          '<div class="ea-row"><span>Server</span><span style="font-size:.7rem">'+ea.server+'</span></div>'+
          '<div class="ea-row"><span>Position</span><span><span class="badge '+(hasPos?'badge-orange':'badge-gray')+'">'+(hasPos?'&#9650; IN POSITION':'none')+'</span></span></div>'+
          '<div class="ea-row"><span>Update</span><span><span class="badge '+(fresh?'badge-green':'badge-red')+'">'+(ea.updated_at_ms?ageFmt(ea.updated_at_ms)+' ago':'—')+'</span></span></div>'+
          '</div>';
      }).join('');
    }

    // Bots — pixel art office
    const BOT_IDS=['bot-default','bot-affiliate','bot-fxcopie','bot-builder'];
    const BOT_CHAR_IDX={'bot-default':0,'bot-affiliate':1,'bot-fxcopie':2,'bot-builder':3};
    const botMap={};
    (d.bots||[]).forEach(b=>{botMap[b.bot_id]=b;});
    const botsEl=document.getElementById('bots-body');

    // Wall decoration strip
    const wallHtml='<div class="px-wall">'+
      '<img class="px-wall-item" src="'+PX_SPRITES.coffeeMachine+'" style="width:32px;height:64px">'+
      '<img class="px-wall-item" src="'+PX_SPRITES.fullBookshelfTall+'" style="width:32px;height:64px">'+
      '<img class="px-wall-item" src="'+PX_SPRITES.windowDoubleWhite+'" style="width:64px;height:64px">'+
      '<img class="px-wall-item" src="'+PX_SPRITES.chartSm1+'" style="width:64px;height:64px">'+
      '<img class="px-wall-item" src="'+PX_SPRITES.clockWall+'" style="width:32px;height:64px">'+
      '<img class="px-wall-item" src="'+PX_SPRITES.chartSm2+'" style="width:64px;height:64px">'+
      '<img class="px-wall-item" src="'+PX_SPRITES.windowDoubleWhite+'" style="width:64px;height:64px">'+
      '<img class="px-wall-item" src="'+PX_SPRITES.fullBookshelfTall+'" style="width:32px;height:64px">'+
    '</div>';

    // Build workstation grid
    const stationsHtml=BOT_IDS.map((id,idx)=>{
      const b=botMap[id];
      const hbFresh=b&&b.age_mins<15;
      let status='offline';
      if(hbFresh){
        const actMatch=b&&b.last_action?b.last_action.match(/(\\d+)(m|u)\\s*(?:geleden|ago)/):null;
        const actMins=actMatch?(actMatch[2]==='u'?Number(actMatch[1])*60:Number(actMatch[1])):Infinity;
        status=actMins<10?'online':'idle';
      }
      const shortName=id.replace('bot-','');
      const charIdx=BOT_CHAR_IDX[id]||0;
      const showPlant=true;
      return '<div class="px-station st-'+status+'">'+
        makeWorkstation(charIdx,status,showPlant)+
        '<div class="ws-nameplate">'+
          '<div class="ws-name">'+shortName+'</div>'+
          '<div class="ws-stat '+status+'"><span class="ws-led '+status+'"></span>'+status.toUpperCase()+'</div>'+
        '</div>'+
        '<div class="ws-btns">'+
          '<button class="btn btn-start" data-bot="'+id+'" data-cmd="start" onclick="sendCommand(this.dataset.bot,this.dataset.cmd)" title="Start">&#9654;</button>'+
          '<button class="btn btn-stop" data-bot="'+id+'" data-cmd="stop" onclick="sendCommand(this.dataset.bot,this.dataset.cmd)" title="Stop">&#9646;&#9646;</button>'+
          '<button class="btn btn-restart" data-bot="'+id+'" data-cmd="restart" onclick="sendCommand(this.dataset.bot,this.dataset.cmd)" title="Restart">&#8635;</button>'+
        '</div>'+
      '</div>';
    }).join('');

    // Assemble office
    const officeHtml=wallHtml+
      '<div class="px-office-wrap">'+
        '<div style="display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:2px">'+
          '<img class="px-side-deco" src="'+PX_SPRITES.plant3+'" style="width:40px;height:80px">'+
          '<img class="px-side-deco" src="'+PX_SPRITES.waterCooler+'" style="width:40px;height:80px">'+
        '</div>'+
        '<div class="px-office">'+stationsHtml+'</div>'+
        '<div style="display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:2px">'+
          '<img class="px-side-deco" src="'+PX_SPRITES.coffeeMachine+'" style="width:32px;height:64px">'+
          '<img class="px-side-deco" src="'+PX_SPRITES.plant2+'" style="width:40px;height:80px">'+
        '</div>'+
      '</div>';

    botsEl.innerHTML=officeHtml;

    // Trade Gates
    if(d.trade_gates){
      const g=d.trade_gates;
      const gates=[
        {key:'market',       label:'Market',        detail:g.market.reason||''},
        {key:'news_blackout',label:'News',          detail:!g.news_blackout.pass&&g.news_blackout.next_event?g.news_blackout.next_event.title||'blackout':''},
        {key:'open_trade_lock',label:'Open Position', detail:g.open_trade_lock.reason||''},
        {key:'cooldown',     label:'Cooldown',       detail:!g.cooldown.pass?g.cooldown.remaining_min+'m remaining':''},
        {key:'daily_loss',   label:'Daily Loss',     detail:g.daily_loss.start_equity?g.daily_loss.dd_pct+'% of max '+g.daily_loss.max+'% (equity $'+g.daily_loss.current_equity+' / start $'+g.daily_loss.start_equity+')':'no data today'},
        {key:'consec_losses',label:'Consecutive',   detail:g.consec_losses.losses+' / max '+g.consec_losses.max},
        {key:'trend_bias',   label:'Trend Bias',     detail:g.trend_bias.bias},
      ];
      document.getElementById('gates-body').innerHTML=gates.map(gt=>{
        const pass=g[gt.key].pass;
        return '<div class="gate-chip '+(pass?'gate-pass':'gate-fail')+'">'+
          '<div class="gate-dot"></div>'+
          gt.label+
          (gt.detail?' <span class="gate-detail">('+gt.detail+')</span>':'')+
        '</div>';
      }).join('');
      const vEl=document.getElementById('gates-verdict');
      if(g.verdict==='ready'){
        vEl.innerHTML='<div class="verdict-bar verdict-ready">&#9989; READY — All gates open</div>';
      } else {
        vEl.innerHTML='<div class="verdict-bar verdict-blocked">&#128721; BLOCKED — '+g.block_reason+'</div>';
      }
    }

    // Signals
    const tbody=document.getElementById('signals-tbody');
    if(!d.signals||d.signals.length===0){
      tbody.innerHTML='<tr><td colspan="5" style="color:var(--muted)">No trades found</td></tr>';
    } else {
      tbody.innerHTML=d.signals.map(s=>{
        const outcome=s.close_outcome||s.status;
        let badge='badge-gray';
        if(outcome==='active')badge='badge-cyan';
        else if(/tp/i.test(outcome))badge='badge-green';
        else if(/sl/i.test(outcome))badge='badge-red';
        return '<tr>'+
          '<td>'+fmtDate(s.created_at_ms)+'</td>'+
          '<td><span class="badge '+(s.direction==='BUY'?'badge-green':'badge-orange')+'">'+s.direction+'</span></td>'+
          '<td style="font-variant-numeric:tabular-nums">'+(s.sl!=null?s.sl.toFixed(2):'—')+'</td>'+
          '<td style="font-variant-numeric:tabular-nums">'+(s.tp!=null?s.tp.toFixed(2):'—')+'</td>'+
          '<td><span class="badge '+badge+'">'+outcome+'</span></td>'+
          '</tr>';
      }).join('');
    }

  }catch(e){
    const eb=document.getElementById('error-banner');
    let msg='';
    if(e.name==='AbortError'){
      msg='⏱️ Timeout: server reageert niet binnen 15s. Render is waarschijnlijk aan het opstarten (cold start). Wacht 30s en probeer opnieuw.';
    } else if(e.message&&e.message.includes('Failed to fetch')){
      msg='🔴 Server niet bereikbaar. Mogelijke oorzaken:\\n• Render server is down of slaapt\\n• Geen internetverbinding\\n• Server wordt opnieuw gedeployed';
    } else if(e.message&&e.message.includes('NetworkError')){
      msg='🌐 Netwerkfout: controleer je internetverbinding.';
    } else {
      msg='❌ Fout: '+e.message;
    }
    eb.innerHTML=msg.replace(/\\n/g,'<br>');
    eb.style.display='block';
    // Toon retry countdown
    let sec=30;
    const countEl=document.createElement('div');
    countEl.style.cssText='margin-top:6px;font-size:.7rem;color:#94a3b8';
    countEl.textContent='Volgende poging over '+sec+'s...';
    eb.appendChild(countEl);
    const ci=setInterval(()=>{sec--;if(sec<=0){clearInterval(ci);countEl.textContent='Opnieuw laden...';}else{countEl.textContent='Volgende poging over '+sec+'s...';}},1000);
  }
}

load();
setInterval(load,30000);
</script>
</body>
</html>`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

// ============================================================
// FXCOPY DASHBOARD
// ============================================================

app.get("/fxcopy", async (req, res) => {
  if (!mcAuthDashboard(req, res)) return;
  const key = String(req.query.key || "");
  const html = `<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>📡 FxCopy — Signal Dashboard</title>
<style>
  :root{
    --bg:#07090f;--surface:#0d1117;--surface2:#111827;--border:#1e2535;
    --cyan:#22d3ee;--green:#4ade80;--orange:#fb923c;--red:#f87171;--blue:#60a5fa;--purple:#a78bfa;--yellow:#fbbf24;
    --text:#e2e8f0;--muted:#64748b;--muted2:#94a3b8;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh}

  .navbar{background:#080b12;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:0;padding:0 24px;position:sticky;top:0;z-index:200}
  .nav-tab{padding:10px 18px;font-size:.75rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);text-decoration:none;border-bottom:2px solid transparent;transition:all .2s}
  .nav-tab:hover{color:var(--text);background:rgba(255,255,255,.03)}
  .nav-tab.active{color:var(--purple);border-bottom-color:var(--purple)}
  .nav-tab .nav-icon{margin-right:6px;font-size:.8rem}

  header{background:var(--surface);border-bottom:1px solid var(--border);padding:12px 24px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:36px;z-index:100;backdrop-filter:blur(8px)}
  .hdr-left{display:flex;align-items:center;gap:12px}
  .hdr-logo{font-size:1.3rem;font-weight:800;letter-spacing:.04em;color:#fff;text-transform:uppercase}
  .hdr-logo span{color:var(--purple)}
  .hdr-chip{display:flex;align-items:center;gap:5px;background:var(--surface2);border:1px solid var(--border);border-radius:99px;padding:3px 9px;font-size:.65rem;font-weight:700;letter-spacing:.04em;transition:all .3s}
  .chip-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
  .chip-online{border-color:#166534;color:var(--green)}
  .chip-online .chip-dot{background:var(--green);animation:dotPulse 1.5s ease-in-out infinite}
  .chip-offline{border-color:#7f1d1d;color:var(--red)}
  .chip-offline .chip-dot{background:var(--red)}
  @keyframes dotPulse{0%,100%{box-shadow:0 0 6px var(--green)}50%{box-shadow:0 0 18px var(--green)}}
  .hdr-right{text-align:right}
  #live-clock{font-size:1.1rem;font-weight:700;color:var(--purple);font-variant-numeric:tabular-nums;letter-spacing:.05em}
  #refresh-time{font-size:.65rem;color:var(--muted);margin-top:1px}
  .page{padding:18px 22px;display:flex;flex-direction:column;gap:14px}
  .row-2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  @media(max-width:800px){.row-2{grid-template-columns:1fr}}

  .card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:18px;position:relative;overflow:hidden}
  .card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,var(--purple),transparent);opacity:.4}
  .card-title{font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:14px;display:flex;align-items:center;gap:6px}
  .card-title-icon{font-size:.85rem}

  .badge{display:inline-flex;align-items:center;gap:4px;padding:2px 9px;border-radius:99px;font-size:.68rem;font-weight:700;letter-spacing:.03em}
  .badge-green{background:#052e16;color:var(--green);border:1px solid #166534}
  .badge-red{background:#1c0505;color:var(--red);border:1px solid #7f1d1d}
  .badge-blue{background:#0c1a2e;color:var(--blue);border:1px solid #1d4ed8}
  .badge-orange{background:#1c0a00;color:var(--orange);border:1px solid #7c2d12}
  .badge-gray{background:#0f172a;color:var(--muted2);border:1px solid #334155}
  .badge-purple{background:#1a0a2e;color:var(--purple);border:1px solid #6d28d9}

  #error-banner{display:none;background:#1c0505;color:#fca5a5;padding:10px 18px;border-radius:8px;border:1px solid #7f1d1d;font-size:.8rem}

  /* Latest signal card */
  .sig-big{text-align:center;padding:20px}
  .sig-dir{font-size:2.2rem;font-weight:900;letter-spacing:.05em}
  .sig-dir.BUY{color:var(--green)}
  .sig-dir.SELL{color:var(--red)}
  .sig-symbol{font-size:1rem;color:var(--muted2);font-weight:600;margin-bottom:4px}
  .sig-entry{font-size:1.6rem;font-weight:800;color:var(--cyan);margin:6px 0}
  .sig-levels{display:flex;justify-content:center;gap:20px;margin-top:10px;font-size:.85rem}
  .sig-sl{color:var(--red);font-weight:700}
  .sig-tp{color:var(--green);font-weight:700}
  .sig-time{font-size:.7rem;color:var(--muted);margin-top:12px}
  .sig-none{color:var(--muted);font-size:1rem;padding:30px 0}

  /* EA status card */
  .ea-big{text-align:center}
  .ea-equity{font-size:2rem;font-weight:900;color:var(--cyan);letter-spacing:.02em}
  .ea-balance{font-size:.85rem;color:var(--muted2);margin-top:4px}
  .ea-pos{margin-top:12px;font-size:.9rem;font-weight:700}

  /* Signal history table */
  .signals-wrap{overflow-x:auto}
  table{width:100%;border-collapse:collapse;font-size:.78rem}
  thead tr{border-bottom:1px solid var(--border)}
  th{text-align:left;padding:8px 12px;color:var(--muted);font-weight:600;font-size:.65rem;text-transform:uppercase;letter-spacing:.08em}
  td{padding:9px 12px;border-bottom:1px solid #0f1520;color:var(--muted2)}
  tr:hover td{background:rgba(255,255,255,.02)}
  .dir-buy{color:var(--green);font-weight:700}
  .dir-sell{color:var(--red);font-weight:700}

  /* Trade history */
  .trade-row{display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:8px;background:var(--surface2);border:1px solid var(--border);margin-bottom:8px}
  .trade-icon{font-size:1.2rem;flex-shrink:0}
  .trade-info{flex:1}
  .trade-pair{font-weight:700;font-size:.85rem;color:#fff}
  .trade-detail{font-size:.72rem;color:var(--muted2);margin-top:2px}
  .trade-result{text-align:right;font-weight:800;font-size:.85rem}
  .trade-result.tp{color:var(--green)}
  .trade-result.sl{color:var(--red)}
</style>
</head>
<body>
<nav class="navbar">
  <a href="/mc?key=${key}" class="nav-tab"><span class="nav-icon">⚡</span>Mission Control</a>
  <a href="/fxcopy?key=${key}" class="nav-tab active"><span class="nav-icon">📡</span>FxCopy</a>
</nav>
<header>
  <div class="hdr-left">
    <div class="hdr-logo">📡 Fx<span>Copy</span></div>
    <div id="bridge-chip" class="hdr-chip chip-offline"><div class="chip-dot"></div><span id="bridge-label">Bridge: checking...</span></div>
  </div>
  <div class="hdr-right">
    <div id="live-clock">--:--:--</div>
    <div id="refresh-time">nog niet geladen</div>
  </div>
</header>

<div class="page">
  <div id="error-banner"></div>

  <div class="row-2">
    <!-- Latest Signal -->
    <div class="card">
      <div class="card-title"><span class="card-title-icon">📊</span> Laatste Signaal</div>
      <div id="sig-body" class="sig-big">
        <div class="sig-none">Wachten op signaal...</div>
      </div>
    </div>

    <!-- EA Status -->
    <div class="card">
      <div class="card-title"><span class="card-title-icon">🤖</span> EA Status</div>
      <div id="ea-body" class="ea-big">
        <div class="sig-none">Laden...</div>
      </div>
    </div>
  </div>

  <!-- Signal History -->
  <div class="card">
    <div class="card-title"><span class="card-title-icon">📋</span> Signaal Geschiedenis</div>
    <div class="signals-wrap">
      <table>
        <thead><tr><th>#</th><th>Tijd</th><th>Symbol</th><th>Richting</th><th>Entry</th><th>SL</th><th>TP1</th></tr></thead>
        <tbody id="sig-table">
          <tr><td colspan="7" style="color:var(--muted);text-align:center">Laden...</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <!-- Trade History -->
  <div class="card">
    <div class="card-title"><span class="card-title-icon">💰</span> Laatste Trades</div>
    <div id="trades-body">
      <div class="sig-none" style="text-align:center">Laden...</div>
    </div>
  </div>
</div>

<script>
const KEY='${key}';
const BRIDGE='http://localhost:8000';
const BASE=location.origin;

// Clock
function tick(){document.getElementById('live-clock').textContent=new Date().toLocaleTimeString('nl-NL',{hour:'2-digit',minute:'2-digit',second:'2-digit',timeZone:'Europe/Amsterdam'});}
tick();setInterval(tick,1000);

function fmtTime(ms){
  if(!ms)return '—';
  const d=new Date(ms*1000||ms);
  return d.toLocaleString('nl-NL',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',timeZone:'Europe/Amsterdam'});
}

function ago(ms){
  if(!ms)return '';
  const s=Math.floor((Date.now()-(ms*1000>1e15?ms:ms*1000))/1000);
  if(s<60)return s+'s geleden';
  if(s<3600)return Math.floor(s/60)+'m geleden';
  return Math.floor(s/3600)+'u geleden';
}

async function loadBridge(){
  const chip=document.getElementById('bridge-chip');
  const lbl=document.getElementById('bridge-label');
  try{
    const r=await fetch(BRIDGE+'/health',{signal:AbortSignal.timeout(3000)});
    if(!r.ok)throw new Error('HTTP '+r.status);
    const d=await r.json();
    chip.className='hdr-chip chip-online';
    lbl.textContent='Bridge: ONLINE'+(d.history_count?' ('+d.history_count+' signalen)':'');

    // Latest signal
    const lr=await fetch(BRIDGE+'/latest',{signal:AbortSignal.timeout(3000)});
    const latest=await lr.json();
    const sb=document.getElementById('sig-body');
    if(latest&&latest.signal){
      const s=latest.signal;
      const tps=s.tp||[];
      sb.innerHTML=
        '<div class="sig-symbol">'+s.symbol+'</div>'+
        '<div class="sig-dir '+s.side+'">'+s.side+'</div>'+
        '<div class="sig-entry">@ '+s.entry+'</div>'+
        '<div class="sig-levels">'+
          '<span class="sig-sl">SL: '+s.sl+'</span>'+
          (tps.length?'<span class="sig-tp">TP1: '+tps[0]+(tps.length>1?' (+'+( tps.length-1)+')':'')+'</span>':'')+
        '</div>'+
        '<div class="sig-time">'+ago(latest.ts)+' — bron: @'+s.source+'</div>';
    } else {
      sb.innerHTML='<div class="sig-none">Nog geen signaal ontvangen</div>';
    }

    // Signal history
    const hr=await fetch(BRIDGE+'/history?limit=20',{signal:AbortSignal.timeout(3000)});
    const hist=await hr.json();
    const tb=document.getElementById('sig-table');
    if(hist&&hist.length>0){
      tb.innerHTML=hist.slice().reverse().map((h,i)=>{
        const s=h.signal||{};
        const tps=s.tp||[];
        return '<tr>'+
          '<td>'+(hist.length-i)+'</td>'+
          '<td>'+fmtTime(h.ts)+'</td>'+
          '<td style="color:#fff;font-weight:700">'+s.symbol+'</td>'+
          '<td class="dir-'+(s.side||'').toLowerCase()+'">'+(s.side||'—')+'</td>'+
          '<td>'+(s.entry||'—')+'</td>'+
          '<td style="color:var(--red)">'+(s.sl||'—')+'</td>'+
          '<td style="color:var(--green)">'+(tps[0]||'—')+'</td>'+
          '</tr>';
      }).join('');
    } else {
      tb.innerHTML='<tr><td colspan="7" style="color:var(--muted);text-align:center">Geen signalen</td></tr>';
    }
  }catch(e){
    chip.className='hdr-chip chip-offline';
    lbl.textContent='Bridge: OFFLINE';
    document.getElementById('sig-body').innerHTML='<div class="sig-none">⚠️ Bridge niet bereikbaar (localhost:8000)</div>';
    document.getElementById('sig-table').innerHTML='<tr><td colspan="7" style="color:var(--muted);text-align:center">Bridge offline</td></tr>';
  }
}

async function loadMC(){
  try{
    const r=await fetch(BASE+'/api/mc/state?key='+encodeURIComponent(KEY),{signal:AbortSignal.timeout(15000)});
    if(!r.ok)return;
    const d=await r.json();
    document.getElementById('refresh-time').textContent='Vernieuwd '+new Date().toLocaleTimeString('nl-NL',{hour:'2-digit',minute:'2-digit',second:'2-digit'});

    // EA status — FxCopy account
    const eb=document.getElementById('ea-body');
    const ea=(d.ea_positions||[]).find(e=>e.account_login==='12145457')||(d.ea_positions||[]).find(e=>String(e.magic)==='88001');
    if(ea&&ea.equity!=null){
      const pos=ea.has_position;
      eb.innerHTML=
        '<div class="ea-equity">$'+Number(ea.equity).toLocaleString('en-US',{minimumFractionDigits:2})+'</div>'+
        '<div class="ea-balance">Balance: $'+Number(ea.balance||ea.equity).toLocaleString('en-US',{minimumFractionDigits:2})+'</div>'+
        '<div class="ea-pos">'+(pos?'<span class="badge badge-orange">⚡ POSITIE OPEN</span>':'<span class="badge badge-gray">Geen positie</span>')+'</div>'+
        '<div style="margin-top:8px;font-size:.7rem;color:var(--muted)">'+ago(ea.updated_at_ms)+'</div>';
    } else {
      eb.innerHTML='<div class="sig-none">Geen EA data</div>';
    }

    // Trade history
    const tb=document.getElementById('trades-body');
    const sigs=(d.signals||[]).filter(s=>s.close_outcome);
    if(sigs.length>0){
      tb.innerHTML=sigs.slice(0,10).map(s=>{
        const isTP=s.close_outcome&&s.close_outcome.includes('TP');
        const isSL=s.close_outcome&&s.close_outcome.includes('SL');
        const icon=isTP?'✅':isSL?'❌':'🔵';
        const cls=isTP?'tp':isSL?'sl':'';
        return '<div class="trade-row">'+
          '<div class="trade-icon">'+icon+'</div>'+
          '<div class="trade-info">'+
            '<div class="trade-pair">'+s.symbol+' <span class="dir-'+(s.direction||'').toLowerCase()+'">'+(s.direction||'')+'</span></div>'+
            '<div class="trade-detail">SL: '+(s.sl||'—')+' | TP: '+(s.tp||'—')+' | '+fmtTime(s.closed_at_ms)+'</div>'+
          '</div>'+
          '<div class="trade-result '+cls+'">'+s.close_outcome+'</div>'+
          '</div>';
      }).join('');
    } else {
      tb.innerHTML='<div class="sig-none" style="text-align:center">Geen trades</div>';
    }

  }catch(e){
    document.getElementById('error-banner').textContent='Error: '+e.message;
    document.getElementById('error-banner').style.display='block';
  }
}

async function load(){
  await Promise.all([loadBridge(),loadMC()]);
}

load();
setInterval(load,15000);
</script>
</body>
</html>`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

// ============================================================
// END MISSION CONTROL
// ============================================================

async function runPreviewRenders() {
  // Dev-only: generate closed card previews without starting the server.
  // Usage (PowerShell):
  //   $env:FLEXBOT_RENDER_PREVIEW="1"; node server.js
  const outDir = path.join(__dirname, "tmp");
  try { fs.mkdirSync(outDir, { recursive: true }); } catch {}

  const samples = [
    {
      name: "closed_win",
      payload: {
        id: "PREVIEW12345678",
        symbol: "XAUUSD",
        direction: "BUY",
        entry: 2034.12,
        sl: 2027.55,
        tp: [2046.9],
        outcome: "TP1",
        result: "+27.50",
      },
    },
    {
      name: "closed_loss",
      payload: {
        id: "PREVIEW87654321",
        symbol: "XAUUSD",
        direction: "SELL",
        entry: 2034.12,
        sl: 2041.55,
        tp: [2022.9],
        outcome: "SL",
        result: "-25.00",
      },
    },
  ];

  for (const s of samples) {
    const svg = createClosedCardSvgV3(s.payload);
    const pngBuf = renderSvgToPngBuffer(svg);
    const outPath = path.join(outDir, `${s.name}.png`);
    fs.writeFileSync(outPath, pngBuf);
    console.log("preview_written", outPath);
  }
}

async function main() {
  // Preview render mode (no server listen)
  if (String(process.env.FLEXBOT_RENDER_PREVIEW || "").trim() === "1") {
    await runPreviewRenders();
    return;
  }

  await warmLoadFromDb();
  const port = process.env.PORT || 3000;
  app.listen(port, "0.0.0.0", () => console.log("listening", port));
}

main();
