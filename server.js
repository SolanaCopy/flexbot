const express = require("express");
const app = express();

app.use(express.text({ type: "*/*" }));

// Node 18+ heeft fetch standaard. Voor oudere Node versies: npm i node-fetch
const fetchFn =
  globalThis.fetch?.bind(globalThis) ||
  ((...args) => import("node-fetch").then(({ default: f }) => f(...args)));

let last = null;

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

/** ---- Time parsing (robust) ---- */
function parseTimeToMs(input) {
  if (input == null) return Date.now();

  // number
  if (typeof input === "number" && Number.isFinite(input)) {
    // seconden vs ms
    return input < 1e12 ? input * 1000 : input;
  }

  const s = String(input).trim();
  if (!s) return Date.now();

  // numeric string
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n)) return Date.now();
    return n < 1e12 ? n * 1000 : n;
  }

  // MetaTrader format: "YYYY.MM.DD HH:MM:SS"
  // We interpreteren dit als UTC om een consistente bucket te krijgen.
  const m = s.match(/^(\d{4})\.(\d{2})\.(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (m) {
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  }

  // ISO / parseable strings
  const p = Date.parse(s);
  return Number.isFinite(p) ? p : Date.now();
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

  // Out-of-order tick vóór huidige candle -> negeren
  if (tsMs < currentStartMs) return;

  // Zelfde bucket
  if (currentStartMs === bucketStart) {
    store.current.high = Math.max(store.current.high, price);
    store.current.low = Math.min(store.current.low, price);
    store.current.close = price;
    store.current.lastTs = tsMs;
    return;
  }

  // Nieuwe bucket: sluit huidige candle
  const finished = store.current;
  store.current = null;
  pushHistoryCapped(store, finished);

  // Gaps vullen (handig voor charting)
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

  // Start nieuwe candle
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

/** ---- Routes ---- */

app.post("/price", (req, res) => {
  try {
    const jsonStr = firstJsonObject(req.body);
    if (!jsonStr) return res.status(400).send("bad");

    const parsed = JSON.parse(jsonStr);
    const { symbol, bid, ask, time } = parsed;

    if (!symbol || bid == null || ask == null) {
      return res.status(400).send("bad");
    }

    const bidNum = Number(bid);
    const askNum = Number(ask);

    if (!Number.isFinite(bidNum) || !Number.isFinite(askNum)) {
      return res.status(400).send("bad");
    }

    // time bewaren zoals binnenkomt, maar ook een ms versie maken voor candles
    const tsMs = parseTimeToMs(time);

    last = {
      symbol: String(symbol),
      bid: bidNum,
      ask: askNum,
      time: time || new Date(tsMs).toISOString(),
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

// Candles ophalen
// Voorbeeld: /candles?symbol=XAUUSD&interval=15m&limit=200
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

// Chart image (png) voor Telegram bots
// Voorbeeld: /chart.png?symbol=XAUUSD&interval=15m&limit=80
app.get("/chart.png", async (req, res) => {
  try {
    const symbol = req.query.symbol ? String(req.query.symbol) : "XAUUSD";
    const interval = req.query.interval ? String(req.query.interval) : "15m";
    const limit = req.query.limit ? Number(req.query.limit) : 80;

    if (!INTERVALS[interval]) return res.status(400).send("unsupported_interval");

    const store = candleStore.get(symbol);
    if (!store) return res.status(404).send("no_data");

    const all = store.current ? [...store.history, store.current] : [...store.history];
    const hardCap = Math.min(Math.max(limit, 10), 500);
    const candles = all.slice(Math.max(0, all.length - hardCap));

    // QuickChart + chartjs-chart-financial (candlestick) gebruikt Chart.js v3+ :contentReference[oaicite:2]{index=2}
    // In Chart.js v3 is de standaard tijd-key "x" (niet "t") :contentReference[oaicite:3]{index=3}
    const data = candles.map((c) => ({
      x: new Date(c.start).getTime(),
      o: c.open,
      h: c.high,
      l: c.low,
      c: c.close,
    }));

    const qc = {
      version: "3",
      backgroundColor: "#0b1220",
      width: 900,
      height: 500,
      format: "png",
      chart: {
        type: "candlestick",
        data: {
          datasets: [{ label: `${symbol} ${interval}`, data }],
        },
        options: {
          plugins: {
            legend: { labels: { color: "#e5e7eb" } },
          },
          scales: {
            x: {
              type: "time",
              ticks: { color: "#9ca3af" },
              grid: { color: "rgba(255,255,255,0.06)" },
            },
            y: {
              ticks: { color: "#9ca3af" },
              grid: { color: "rgba(255,255,255,0.06)" },
            },
          },
        },
      },
    };

    const r = await fetchFn("https://quickchart.io/chart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(qc),
    });

    if (!r.ok) return res.status(502).send("chart_failed");

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");

    const buf = Buffer.from(await r.arrayBuffer());
    return res.end(buf);
  } catch (e) {
    return res.status(500).send("error");
  }
});

app.get("/", (_, res) => res.send("ok"));

const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => console.log("listening", port));
