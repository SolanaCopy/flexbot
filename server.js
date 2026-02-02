const express = require("express");

const app = express();
app.use(express.text({ type: "*/*" }));

// Node 18+ heeft fetch standaard. Voor oudere Node versies: npm i node-fetch
const fetchFn =
  globalThis.fetch?.bind(globalThis) ||
  ((...args) => import("node-fetch").then(({ default: f }) => f(...args)));

let last = null;

// ✅ laatste succesvolle PNG per symbol+interval (fallback als QuickChart faalt)
const lastChartPng = new Map(); // key -> { buf, tsMs }

// ---- ForexFactory calendar feed (JSON, geen npm nodig) ----
const FF_JSON_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
let ffCache = { ts: 0, events: [] };
const FF_CACHE_MS = 60 * 1000; // 60s cache

/**
 * Probeert de eerste "echte" JSON object string uit een tekst te halen.
 * Neemt alles tussen de eerste '{' en de laatste '}'.
 */
function firstJsonObject(raw) {
  const s = String(raw || "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a === -1 || b === -1 || b <= a) return null;
  return s.slice(a, b + 1);
}

/** ---- Time parsing (fallback) ---- */
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

/** ---- Candle aggregation (15m) ---- */
const INTERVALS = {
  "15m": 15 * 60 * 1000,
};

const candleStore = new Map(); // symbol -> { current, history }
const MAX_HISTORY_PER_SYMBOL = 2000;

function floorToBucketStart(tsMs, intervalMs) {
  return Math.floor(tsMs / intervalMs) * intervalMs;
}

function getOrCreateSymbolStore(symbol) {
  const key = String(symbol);
  if (!candleStore.has(key)) candleStore.set(key, { current: null, history: [] });
  return candleStore.get(key);
}

function pushHistoryCapped(store, candle) {
  store.history.push(candle);
  if (store.history.length > MAX_HISTORY_PER_SYMBOL) {
    store.history.splice(0, store.history.length - MAX_HISTORY_PER_SYMBOL);
  }
}

function update15mCandle({ symbol, price, tsMs }) {
  const intervalMs = INTERVALS["15m"];
  const store = getOrCreateSymbolStore(symbol);

  const bucketStart = floorToBucketStart(tsMs, intervalMs);
  const bucketEnd = bucketStart + intervalMs;

  if (!store.current) {
    store.current = {
      symbol: String(symbol),
      interval: "15m",
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

  const finished = store.current;
  store.current = null;
  pushHistoryCapped(store, finished);

  const prevClose = finished.close;
  let nextStart = currentStartMs + intervalMs;
  while (nextStart < bucketStart) {
    pushHistoryCapped(store, {
      symbol: String(symbol),
      interval: "15m",
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

  store.current = {
    symbol: String(symbol),
    interval: "15m",
    start: new Date(bucketStart).toISOString(),
    end: new Date(bucketEnd).toISOString(),
    open: price,
    high: price,
    low: price,
    close: price,
    lastTs: tsMs,
  };
}

/** ---- Helpers ---- */
function setNoCachePngHeaders(res, symbol, interval) {
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  res.setHeader("Content-Disposition", `inline; filename="chart-${symbol}-${interval}-${Date.now()}.png"`);
}

/** ---- ForexFactory JSON helpers ---- */
function normImpact(x) {
  const s = String(x ?? "").toLowerCase();
  if (s.includes("high")) return "high";
  if (s.includes("medium")) return "medium";
  if (s.includes("low")) return "low";
  return s || "unknown";
}

function getEventTsMs(e) {
  // Vaak heeft de JSON feed "timestamp" (in seconds). Anders proberen date+time.
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
    headers: {
      "User-Agent": "flexbot/1.0",
      "Accept": "application/json,*/*",
    },
  });

  if (!r.ok) throw new Error(`ff_fetch_failed_${r.status}`);

  const arr = await r.json();
  const list = Array.isArray(arr) ? arr : [];
  const events = list.map(normalizeFfEvent);

  ffCache = { ts: now, events };
  return events;
}

/** ---- Routes ---- */

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

    // ✅ vertrouw server tijd, tenzij client-tijd "dichtbij" is
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

    last = {
      symbol: String(symbol),
      bid: bidNum,
      ask: askNum,
      time: new Date(tsMs).toISOString(),
      ts: tsMs,
      raw_time: time ?? null,
      raw_ts: ts ?? null,
      used_server_time: tsMs === now,
    };

    const mid = (bidNum + askNum) / 2;
    update15mCandle({ symbol: last.symbol, price: mid, tsMs });

    return res.send("ok");
  } catch (e) {
    return res.status(400).send("bad_json");
  }
});

app.get("/price", (req, res) => {
  if (!last) return res.status(404).json({ ok: false });
  return res.json({ ok: true, ...last });
});

app.get("/candles", (req, res) => {
  const symbol = req.query.symbol ? String(req.query.symbol) : "";
  const interval = req.query.interval ? String(req.query.interval) : "15m";
  const limit = req.query.limit ? Number(req.query.limit) : 200;

  if (!symbol) return res.status(400).json({ ok: false, error: "symbol_required" });
  if (!INTERVALS[interval]) return res.status(400).json({ ok: false, error: "unsupported_interval" });
  if (!Number.isFinite(limit) || limit <= 0) return res.status(400).json({ ok: false, error: "bad_limit" });

  const store = candleStore.get(symbol);
  if (!store) return res.json({ ok: true, symbol, interval, candles: [] });

  const all = store.current ? [...store.history, store.current] : [...store.history];
  const hardCap = Math.min(Math.max(limit, 10), 5000);
  const candles = all.slice(Math.max(0, all.length - hardCap));

  return res.json({ ok: true, symbol, interval, candles });
});

// Chart image (png)
app.get("/chart.png", async (req, res) => {
  try {
    const symbol = req.query.symbol ? String(req.query.symbol) : "XAUUSD";
    const interval = req.query.interval ? String(req.query.interval) : "15m";
    const reqLimit = req.query.limit ? Number(req.query.limit) : 200;
    const limit = Number.isFinite(reqLimit) ? reqLimit : 200;

    if (!INTERVALS[interval]) return res.status(400).send("unsupported_interval");

    const store = candleStore.get(symbol);
    if (!store) return res.status(404).send("no_data");

    const all = store.current ? [...store.history, store.current] : [...store.history];
    const hardCap = Math.min(Math.max(limit, 120), 500);
    const candles = all.slice(Math.max(0, all.length - hardCap));
    if (candles.length < 10) return res.status(404).send("too_few_candles");

    const data = candles.map((c) => ({
      x: new Date(c.start).getTime(),
      o: c.open,
      h: c.high,
      l: c.low,
      c: c.close,
    }));

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

    const qc = {
      version: "3",
      backgroundColor: "#0b1220",
      width: 900,
      height: 500,
      format: "png",
      chart: {
        type: "candlestick",
        data: {
          datasets: [
            {
              label: `${symbol} ${interval}`,
              data,
              color: {
                up: "rgba(34,197,94,0.9)",
                down: "rgba(239,68,68,0.9)",
                unchanged: "rgba(148,163,184,0.9)",
              },
            },
          ],
        },
        options: {
          animation: false,
          plugins: { legend: { labels: { color: "#e5e7eb" } } },
          scales: {
            x: { type: "time", ticks: { color: "#9ca3af" }, grid: { color: "rgba(255,255,255,0.06)" } },
            y: { suggestedMin: yMin, suggestedMax: yMax, ticks: { color: "#9ca3af" }, grid: { color: "rgba(255,255,255,0.06)" } },
          },
        },
      },
    };

    const key = `${symbol}|${interval}`;

    const r = await fetchFn("https://quickchart.io/chart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(qc),
    });

    if (!r.ok) {
      const cached = lastChartPng.get(key);
      if (cached?.buf) {
        setNoCachePngHeaders(res, symbol, interval);
        res.setHeader("X-Chart-Fallback", "1");
        return res.end(cached.buf);
      }
      return res.status(502).send("chart_failed");
    }

    const buf = Buffer.from(await r.arrayBuffer());
    lastChartPng.set(key, { buf, tsMs: Date.now() });

    setNoCachePngHeaders(res, symbol, interval);
    res.setHeader("X-Chart-Fallback", "0");
    return res.end(buf);
  } catch (e) {
    return res.status(500).send("error");
  }
});

// ✅ ForexFactory “red news” endpoint (High impact)
// Voorbeelden:
// /ff/red
// /ff/red?currency=USD&limit=25
// /ff/red?minutes=120
app.get("/ff/red", async (req, res) => {
  try {
    const currency = req.query.currency ? String(req.query.currency).toUpperCase() : null;
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const minutes = req.query.minutes ? Number(req.query.minutes) : null;

    const all = await getFfEvents();

    let events = all.filter((e) => e.impact === "high"); // "red"
    if (currency) events = events.filter((e) => e.currency === currency);

    if (Number.isFinite(minutes) && minutes > 0) {
      const now = Date.now();
      const until = now + minutes * 60 * 1000;
      events = events.filter((e) => e.ts == null || (e.ts >= now && e.ts <= until));
    }

    const hardCap = Math.min(Math.max(Number.isFinite(limit) ? limit : 50, 1), 200);
    events = events.slice(0, hardCap);

    return res.json({ ok: true, source: "forexfactory_json", currency, count: events.length, events });
  } catch (e) {
    return res.status(502).json({ ok: false, error: "ff_unavailable" });
  }
});

app.get("/", (_, res) => res.send("ok"));

const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => console.log("listening", port));
