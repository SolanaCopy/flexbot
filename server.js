const express = require("express");
const app = express();

// We accepteren eender welke content-type als plain text (handig als je webhook soms rommel meestuurt)
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

app.post("/price", (req, res) => {
  try {
    const jsonStr = firstJsonObject(req.body);
    if (!jsonStr) return res.status(400).send("bad");

    const parsed = JSON.parse(jsonStr);
    const { symbol, bid, ask, time } = parsed;

    // ✅ Validatie (fix van je kapotte regel)
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

    return res.send("ok");
  } catch (e) {
    return res.status(400).send("bad_json");
  }
});

app.get("/price", (req, res) => {
  if (!last) return res.status(404).json({ ok: false });
  return res.json({ ok: true, ...last });
});

app.get("/", (_, res) => res.send("ok"));

// ✅ Render/hosting vriendelijk: luister op process.env.PORT en bind aan 0.0.0.0
const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => console.log("listening", port));
