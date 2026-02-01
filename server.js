const express = require("express");
const app = express();

app.use(express.text({ type: "*/*" }));

let last = null;

function firstJsonObject(raw) {
  const s = String(raw || "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a === -1 || b === -1 || b <= a) return null;
  return s.slice(a, b + 1);
}

app.post("/price", (req, res) => {
  try {
    const jsonStr = firstJsonObject(req.body);
    if (!jsonStr) return res.status(400).send("bad");

    const parsed = JSON.parse(jsonStr);
    const { symbol, bid, ask, time } = parsed;

    if (!symboln s.slice(a, b + 1)ask == null) return res.status(400).send("bad");

    last = {
      symbol: String(symbol),
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
