const express = require("express");
const app = express();

app.use(express.json({ type: "*/*" }));

let last = null;

app.post("/price", (req, res) => {
  const { symbol, bid, ask, time } = req.body || {};
  if (!symbol || bid == null || ask == null) return res.status(400).send("bad");

  last = {
    symbol: String(symbol),
    bid: Number(bid),
    ask: Number(ask),
    time: time || new Date().toISOString(),
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
