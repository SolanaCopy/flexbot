const express = require("express");
const app = express();

app.use(express.text({ type: "*/*" }));

let last = null;

function parseBody(raw) {
  if (!raw) return null;

  try { return JSON.parse(raw); } catch {}

  try {
    const obj = {};
    for (const part of String(raw).split("&")) {
      const [k, v] = part.split("=");
      if (!k) continue;
      obj[decodeURIComponent(k)] = decodeURIComponent(v || "");
    }
    return obj;
  } catch {
    return null;
  }
}

app.post("/price", (req, res) => {
  const raw = req.body;
  console.log("RAW:", raw);

  const payload = parseBody(raw) || {};
  const { symbol, bid, ask, time } = payload;

  if (!symbol || bid == null || ask == null) return res.status(400).send("bad");

  last = {
    symbol: String(symbol),
    bid: Number(bid),
    ask: Number(ask),
    time: time || new Date().toISOString()
  };

  res.send("ok");
});

app.get("/price", (req, res) => {
  if (!last) return res.status(404).json({ ok: false });
  res.json({ ok: true, ...last });
});

app.get("/", (_, res) => res.send("ok"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("listening", port));
