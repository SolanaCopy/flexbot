const express = require("express");

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
const FF_CACHE_MS = 60 * 1000;

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
  // TV-like colors for levels
  if (Number.isFinite(entry)) levelDatasets.push(mkLine(entry, "ENTRY", "rgba(255,255,255,0.55)", [6, 6]));
  if (Number.isFinite(sl)) levelDatasets.push(mkLine(sl, "SL", "#f23645"));
  tps.forEach((tp, i) => levelDatasets.push(mkLine(tp, `TP${i + 1}`, "#2962ff")));

  // Hard default size for Telegram. We keep it fixed for consistent look in chat.
  // (If we ever need overrides, add an explicit allow flag.)
  const width = 1080;
  const height = 1200;

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
            color: "rgba(255,255,255,0.9)",
            align: "start",
            font: { size: 13, weight: "600" },
            padding: { top: 6, bottom: 6 },
          },
          legend: {
            display: true,
            position: "top",
            align: "start",
            labels: {
              color: "rgba(255,255,255,0.85)",
              boxWidth: 10,
              boxHeight: 8,
              padding: 10,
              font: { size: 11 },
              // Hide the main candle dataset label; keep only SL/ENTRY/TP*
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
        layout: { padding: { left: 10, right: 14, top: 6, bottom: 6 } },
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
app.get("/chartshare", (req, res) => {
  const symbol = req.query.symbol ? String(req.query.symbol) : "XAUUSD";
  const interval = req.query.interval ? String(req.query.interval) : "15m";
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
