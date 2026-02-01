const express = require("express");
const app = express();

app.use(express.text({ type: "*/*" }));

let last = null;

app.post("/price", (req, res) => {
  try {
    const payload = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const { symbol, bid, ask, time } = payload;

    if (!symbol || bid == null || ask == null) return res.status(400).send("bad");

    last = {
      symbol,
      bid: Number(bid),
      ask: Number(ask),
      time: time || new Date().toISOString(),
    };

    res.send("ok");
  } catch (e) {
    res.status(400).send("bad_json");
  }
});

app.get("/price", (req, res) => {
  if (!last) return res.status(404).json({ ok: false });
  res.json({ ok: true, ...last });
});

app.get("/", (_, res) => res.send("ok"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("listening", port));
