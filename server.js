const express = require("express");
const app = express();

app.use(express.text({ type: "*/*" }));

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

/** ---- Candle aggregation (15m) ---- */

const INTERVALS = {
  "15m": 15 * 60 * 1000,
};

// Per symbol houden we bij:
// - current: de candle die nu bezig is
// - history: afgesloten candles (array)
const candleStore = new Map(); // symbol -> { current, history }

function floorToBucketStart(tsMs, intervalMs) {
  return Math.floor(tsMs / intervalMs) * intervalMs;
}

function getOrCreateSymbolStore(symbol) {
  const key = String(symbol);
  if (!candleStore.has(key)) {
    candleStore.set(key, { current: null, history: [] });
  }
  return candleStore.get(key);
}

function finalizeCurrent(store) {
  if (store.current) {
    store.history.push(store.current);
    store.current = null;
  }
}

// Optioneel: limiet op geheugen per symbool
const MAX_HISTORY_PER_SYMBOL = 2000;

function pushHistoryCapped(store, candle) {
  store.history.push(candle);
  if (store.history.length > MAX_HISTORY_PER_SYMBOL) {
    store.history.splice(0, store.history.length - MAX_HISTORY_PER_SYMBOL);
  }
}

function update15mCandle({ symbol, price, timeISO }) {
  const intervalMs = INTERVALS["15m"];

  const tsMs = timeISO ? Date.parse(timeISO) : Date.now();
  if (!Number.isFinite(tsMs)) return; // ongeldige time string

  const store = getOrCreateSymbolStore(symbol);
  const bucketStart = floorToBucketStart(tsMs, intervalMs);
  const bucketEnd = bucketStart + intervalMs;

  // Eerste candle voor dit symbool
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
      // volume: null, // geen volume info in jouw payload
      lastTs: tsMs,
    };
    return;
  }

  const currentStartMs = Date.parse(store.current.start);

  // Out-of-order tick die vóór huidige candle valt: negeren (simpel & safe)
  if (tsMs < currentStartMs) return;

  // Tick valt nog in dezelfde 15m bucket
  if (currentStartMs === bucketStart) {
    store.current.high = Math.max(store.current.high, price);
    store.current.low = Math.min(store.current.low, price);
    store.current.close = price;
    store.current.lastTs = tsMs;
    return;
  }

  // Tick is in een nieuwe bucket: sluit huidige candle af
  const finished = store.current;
  store.current = null;
  pushHistoryCapped(store, finished);

  // (Optioneel) gaps vullen: als er buckets ontbreken, kun je “flat” candles toevoegen
  // met open=high=low=close=vorige close. Handig voor charting.
  const prevClose = finished.close;
  let nextStart = currentStartMs + intervalMs;
  while (nextStart < bucketStart) {
    const gapCandle = {
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
    };
    pushHistoryCapped(store, gapCandle);
    nextStart += intervalMs;
  }

  // Start nieuwe candle met deze tick
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

    last = {
      symbol: String(symbol),
      bid: bidNum,
      ask: askNum,
      time: time || new Date().toISOString(),
    };

    // mid price voor candle (je kan ook bid of ask nemen, maar mid is meestal netjes)
    const mid = (bidNum + askNum) / 2;
    update15mCandle({ symbol: last.symbol, price: mid, timeISO: last.time });

    return res.send("ok");
  } catch (e) {
    return res.status(400).send("bad_json");
  }
});

app.get("/price", (req, res) => {
  if (!last) return res.status(404).json({ ok: false });
  return res.json({ ok: true, ...last });
});

// ✅ Nieuwe endpoint voor candles
// Voorbeeld: /candles?symbol=EURUSD&interval=15m&limit=200
app.get("/candles", (req, res) => {
  const symbol = req.query.symbol ? String(req.query.symbol) : "";
  const interval = req.query.interval ? String(req.query.interval) : "15m";
  const limit = req.query.limit ? Number(req.query.limit) : 200;

  if (!symbol) return res.status(400).json({ ok: false, error: "symbol_required" });
  if (!INTERVALS[interval]) return res.status(400).json({ ok: false, error: "unsupported_interval" });
  if (!Number.isFinite(limit) || limit <= 0) return res.status(400).json({ ok: false, error: "bad_limit" });

  const store = candleStore.get(symbol);
  if (!store) return res.json({ ok: true, symbol, interval, candles: [] });

  // history + current (current is nog niet “afgesloten” maar wel bruikbaar)
  const all = store.current ? [...store.history, store.current] : [...store.history];
  const sliced = all.slice(Math.max(0, all.length - Math.min(limit, 5000))); // hard cap

  return res.json({ ok: true, symbol, interval, candles: sliced });
});

app.get("/", (_, res) => res.send("ok"));

const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => console.log("listening", port));
