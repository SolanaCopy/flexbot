const express = require("express");

// Public base URL for self-calls inside automation endpoints.
// On Render you can set PUBLIC_BASE_URL=https://flexbot-qpf2.onrender.com
const BASE_URL = (process.env.PUBLIC_BASE_URL || "https://flexbot-qpf2.onrender.com").trim();

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

  // Always block on Saturday.
  if (weekday.startsWith("za")) return { blocked: true, reason: "market_closed_weekend" };

  // Friday: stop early to avoid weekend carry.
  if (weekday.startsWith("vr") && minutesOfDay >= (22 * 60 + 30)) {
    return { blocked: true, reason: "market_close_soon_friday" };
  }

  // Sunday: block until reopen window.
  if (weekday.startsWith("zo") && minutesOfDay < (23 * 60 + 5)) {
    return { blocked: true, reason: "market_closed_weekend" };
  }

  // Daily safety window around 23:00 NL.
  if (minutesOfDay >= (22 * 60 + 55) && minutesOfDay < (23 * 60 + 5)) {
    return { blocked: true, reason: "market_close_window" };
  }

  return { blocked: false, reason: null };
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
      "created_at_mt5 TEXT NOT NULL" +
    ")"
  );

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

  return libsqlClient;
}

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

// GET /signal/create?secret=...&symbol=XAUUSD&direction=BUY&sl=...&tp=...&risk_pct=0.5&comment=...
// NOTE: This is designed for bot/web_fetch usage (no POST needed). Keep secret in Render env: SIGNAL_SECRET.
app.get("/signal/create", async (req, res) => {
  try {
    const secret = req.query.secret != null ? String(req.query.secret) : "";
    const expected = process.env.SIGNAL_SECRET ? String(process.env.SIGNAL_SECRET) : "";
    if (!expected || secret !== expected) return res.status(401).json({ ok: false, error: "unauthorized" });

    const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : "";
    const direction = req.query.direction ? String(req.query.direction).toUpperCase() : "";
    const sl = Number(req.query.sl);
    const risk_pct = req.query.risk_pct != null ? Number(req.query.risk_pct) : 0.5;
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
app.get("/signal/auto/create", async (req, res) => {
  try {
    const token = req.query.token != null ? String(req.query.token) : "";
    const expected = process.env.AUTO_SIGNAL_TOKEN ? String(process.env.AUTO_SIGNAL_TOKEN) : "";
    if (!expected || token !== expected) return res.status(401).json({ ok: false, error: "unauthorized" });

    const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : "";
    const direction = req.query.direction ? String(req.query.direction).toUpperCase() : "";
    const sl = Number(req.query.sl);
    const risk_pct = req.query.risk_pct != null ? Number(req.query.risk_pct) : 0.5;
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

// POST /signal
// Body (JSON): { symbol:"XAUUSD", direction:"BUY"|"SELL", sl:number, tp:[..] or "tp":"a,b,c", risk_pct?:number, comment?:string }
app.post("/signal", async (req, res) => {
  try {
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
app.get("/signal/next", async (req, res) => {
  try {
    const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : "XAUUSD";

    const sinceRaw = req.query.since_ms != null ? String(req.query.since_ms) : null;
    const sinceMs = sinceRaw && /^\d+$/.test(sinceRaw) ? Number(sinceRaw) : 0;
    const sinceMsSafe = Number.isFinite(sinceMs) && sinceMs > 0 ? sinceMs : 0;

    const db = await getDb();
    if (!db) return res.status(503).json({ ok: false, error: "db_required" });

    const rows = await db.execute({
      sql:
        "SELECT id,symbol,direction,sl,tp_json,risk_pct,comment,status,created_at_ms,created_at_mt5 " +
        "FROM signals " +
        "WHERE symbol=? AND status='new' AND created_at_ms >= ? " +
        "ORDER BY created_at_ms ASC LIMIT 1",
      args: [symbol, sinceMsSafe],
    });

    const r = rows.rows?.[0];
    if (!r) return res.json({ ok: true, signal: null });

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
  } catch {
    return res.status(500).json({ ok: false, error: "error" });
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

    const okModRaw = body?.ok_mod ?? body?.okMod ?? body?.okmod;
    const ok_mod = okModRaw === true || okModRaw === 1 || okModRaw === "1" || okModRaw === "true";

    const tsMs = body?.time != null ? parseTimeToMs(body.time) : Date.now();
    const executed_at_ms = Number.isFinite(tsMs) ? tsMs : Date.now();
    const executed_at_mt5 = formatMt5(executed_at_ms);

    if (!signal_id) return res.status(400).json({ ok: false, error: "bad_signal_id" });

    const db = await getDb();
    if (!db) return res.status(503).json({ ok: false, error: "db_required" });

    // Always record execution callback so the same signal isn't re-processed.
    await db.execute({
      sql: "INSERT OR REPLACE INTO signal_exec (signal_id,ticket,fill_price,filled_at_ms,filled_at_mt5,raw_json) VALUES (?,?,?,?,?,?)",
      args: [signal_id, ticket, fill_price, executed_at_ms, executed_at_mt5, JSON.stringify(body)],
    });

    await db.execute({
      sql: "UPDATE signals SET status='executed' WHERE id=?",
      args: [signal_id],
    });

    // Update EA cooldown state ONLY when EA confirms success.
    // Prefer symbol from signals table (authoritative)
    const sigRow = await db.execute({
      sql: "SELECT symbol,direction,sl,tp_csv,risk_pct,comment FROM signals WHERE id=? LIMIT 1",
      args: [signal_id],
    });
    const sig = sigRow.rows?.[0] || null;
    const sym = sig?.symbol != null ? String(sig.symbol).toUpperCase() : null;

    if (sym && ok_mod) {
      await db.execute({
        sql: "INSERT OR REPLACE INTO ea_state (symbol,last_executed_ms,last_signal_id,last_ticket) VALUES (?,?,?,?)",
        args: [sym, executed_at_ms, signal_id, ticket],
      });

      // Telegram post happens only on success (prevents group spam when EA ignores/fails)
      try {
        const direction = sig?.direction != null ? String(sig.direction) : "";
        const sl = sig?.sl != null ? Number(sig.sl) : NaN;
        const tp1 = sig?.tp_csv ? Number(String(sig.tp_csv).split(",")[0]) : NaN;

        const chatId = process.env.TELEGRAM_CHAT_ID || "-1003611276978";
        const photoUrl = new URL(`${BASE_URL}/chart.png`);
        photoUrl.searchParams.set("symbol", sym);
        photoUrl.searchParams.set("interval", "1m");
        photoUrl.searchParams.set("hours", "3");
        if (Number.isFinite(fill_price)) photoUrl.searchParams.set("entry", String(Number(fill_price.toFixed(3))));
        if (Number.isFinite(sl)) photoUrl.searchParams.set("sl", String(Number(sl.toFixed(3))));
        if (Number.isFinite(tp1)) photoUrl.searchParams.set("tp", String(Number(tp1.toFixed(3))));

        const caption = formatSignalCaption({ symbol: sym, direction, sl: Number.isFinite(sl) ? Number(sl.toFixed(3)) : sl, tp: Number.isFinite(tp1) ? Number(tp1.toFixed(3)) : tp1, riskPct: sig?.risk_pct != null ? Number(sig.risk_pct) : 0.5, comment: sig?.comment || "" });
        await tgSendPhoto({ chatId, photo: photoUrl.toString(), caption });
      } catch {
        // best-effort
      }
    }

    return res.json({ ok: true, signal_id, ticket, fill_price, executed_at: executed_at_mt5, ok_mod });
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
          "FROM signal_exec se JOIN signals s ON s.id = se.signal_id " +
          "WHERE s.symbol=? AND se.filled_at_ms IS NOT NULL " +
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
        "FROM signal_exec se JOIN signals s ON s.id = se.signal_id " +
        "WHERE s.symbol=? AND se.filled_at_ms IS NOT NULL " +
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
    const targetMax = 480;
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
  const labels = candles.map((c) => {
    const ms = Date.parse(c.start);
    const mt5 = Number.isFinite(ms) ? formatMt5(ms) : String(c.start);
    // keep labels compact: HH:MM
    return mt5.slice(11, 16);
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
  try { json = JSON.parse(bodyText); } catch { json = { ok:false, raw: bodyText }; }
  if (!r.ok || !json?.ok) throw new Error(json?.description || `telegram_http_${r.status}`);
  return json;
}

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
  const r = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, photo, caption }),
  });

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

function formatSignalCaption({ symbol, direction, sl, tp, riskPct, comment }) {
  const slStr = String(sl);
  const tpStr = String(tp);
  const riskStr = String(riskPct);

  const sym = String(symbol || '').toUpperCase();
  const dir = String(direction || '').toUpperCase();

  // Clean single-message caption (Telegram-friendly)
  // Example:
  // 🚨 SCALP SETUP LIVE — XAUUSD BUY 🟢 Entry locked 🛑 SL: 4969.625 🎯 TP: 4987.550 💰 Risk: 0.5% ❗ Not Financial Advice.
  const kind = String(comment || '').toLowerCase().includes('scalp') ? 'SCALP' : 'SETUP';

  return (
    `🚨 ${kind} SETUP LIVE — ${sym} ${dir} 🟢\n` +
    `Entry locked\n` +
    `\n` +
    `🛑 SL: ${slStr}\n` +
    `🎯 TP: ${tpStr}\n` +
    `💰 Risk: ${riskStr}%\n` +
    `❗ Not Financial Advice.`
  );
}

// POST /auto/scalp/run?symbol=XAUUSD
// Fully server-side: blackout + cooldown + claim + create signal + post ONE telegram photo.
async function autoScalpRunHandler(req, res) {
  try {
    const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : "XAUUSD";
    const cooldownMin = req.query.cooldown_min != null ? Number(req.query.cooldown_min) : 15;

    // 0) market close guard
    const m = marketBlockedNow();
    if (m.blocked) return res.json({ ok: true, acted: false, reason: m.reason });

    // 1) blackout
    const blackoutR = await fetchJson(`${BASE_URL}/news/blackout?currency=USD&impact=high&window_min=15`);
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

    const mid = (rangeHigh + rangeLow) / 2;
    const direction = entry >= mid ? "SELL" : "BUY";
    const sl = direction === "SELL" ? rangeHigh + 0.4 : rangeLow - 0.4;

    const risk = Math.abs(entry - sl);
    const tp = direction === "SELL" ? entry - risk * 1.5 : entry + risk * 1.5;

    // 5) create signal
    const token = process.env.AUTO_SIGNAL_TOKEN;
    if (!token) return res.status(500).json({ ok: false, error: "missing_AUTO_SIGNAL_TOKEN" });

    const createUrl = new URL(`${BASE_URL}/signal/auto/create`);
    createUrl.searchParams.set("token", token);
    createUrl.searchParams.set("symbol", symbol);
    createUrl.searchParams.set("direction", direction);
    createUrl.searchParams.set("sl", String(Number(sl.toFixed(3))));
    createUrl.searchParams.set("tp", String(Number(tp.toFixed(3))));
    createUrl.searchParams.set("risk_pct", "0.5");
    createUrl.searchParams.set("comment", "auto_scalp");

    const created = await fetchJson(createUrl.toString());
    if (!created?.ok) return res.status(502).json({ ok: false, error: "signal_create_failed", details: created });

    // 6) no Telegram post here.
    // We only post to Telegram when the EA confirms success via POST /signal/executed with ok_mod=true.

    return res.json({ ok: true, acted: true, symbol, direction, sl, tp, ref_ms: refMs, posted: false });
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
    const events = all
      .filter((e) => (String(e.currency || e.country || "").toUpperCase() === "USD"))
      .filter((e) => String(e.impact) === "High");

    const now = Date.now();
    const upcoming = events
      .map((e) => ({ e, ts: Number(e.timestamp) * 1000 }))
      .filter((x) => Number.isFinite(x.ts) && x.ts > now && x.ts <= now + 30 * 60 * 1000)
      .sort((a, b) => a.ts - b.ts)[0];

    if (!upcoming) return res.json({ ok: true, acted: false, reason: "no_upcoming" });

    const minutes = Math.max(0, Math.round((upcoming.ts - now) / 60000));
    const title = String(upcoming.e.title || upcoming.e.event || "USD High");

    // de-dupe: once per event within 60m
    const refMs = upcoming.ts;
    const kind = "news_pause";
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
      .filter((e) => (String(e.currency || e.country || "").toUpperCase() === "USD"))
      .filter((e) => String(e.impact) === "High")
      .map((e) => ({ e, ts: Number(e.timestamp) * 1000 }))
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
      .filter((e) => (String(e.currency || e.country || "").toUpperCase() === "USD"))
      .filter((e) => String(e.impact) === "High")
      .map((e) => Number(e.timestamp) * 1000)
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
    const start = new Date();
    start.setHours(0, 0, 0, 0);

    const q = await db.execute({
      sql: "SELECT id,direction,created_at_ms FROM signals WHERE symbol=? AND created_at_ms >= ? ORDER BY created_at_ms DESC LIMIT 5",
      args: [symbol, start.getTime()],
    });

    const n = q.rows?.length || 0;
    const lastDir = n > 0 ? String(q.rows[0].direction) : null;

    const msg = n === 0 ? "#RECAP XAUUSD\nNo signals today." : `#RECAP XAUUSD\nSignals today: ${n}. Last: ${lastDir}.`;
    await tgSendMessage({ chatId, text: msg });
    return res.json({ ok: true, acted: true });
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
