const fs = require("fs");
const path = require("path");

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function fitFontByChars(text, base, min, targetChars) {
  const len = String(text || "").length;
  if (len <= targetChars) return base;
  const ratio = targetChars / Math.max(1, len);
  return clamp(Math.floor(base * ratio), min, base);
}
function fmtTsISO(ts = new Date()) { return ts.toISOString().slice(0, 19).replace("T", " "); }

function renderSvgToPngBuffer(svg) {
  const { Resvg } = require("@resvg/resvg-js");
  const r = new Resvg(svg, {
    fitTo: { mode: "width", value: 1080 },
    font: { loadSystemFonts: true },
  });
  const pngData = r.render();
  return Buffer.from(pngData.asPng());
}

function getLossMascotDataUri() {
  const fp = path.join(__dirname, "..", "assets", "mascot_loss_force.png");
  const buf = fs.readFileSync(fp);
  return `data:image/png;base64,${buf.toString("base64")}`;
}

function createClosedCardSvgV3({ id, symbol, direction, outcome, result, entry, sl, tp }) {
  const W = 1080;
  const H = 1080;

  const sym = String(symbol || "").toUpperCase();
  const dir = String(direction || "").toUpperCase();

  const tpList = Array.isArray(tp) ? tp : [];
  const tp1 = tpList.length ? tpList[0] : (tp ?? null);

  const outcomeStr = outcome || "-";
  const isSl = String(outcomeStr).toLowerCase().includes("sl");
  const outcomeColor = "#ff4d4d";

  const tplPath = path.join(__dirname, "..", "assets", "loss_card_template.png");
  const tplBuf = fs.readFileSync(tplPath);
  const tplUri = `data:image/png;base64,${tplBuf.toString("base64")}`;

  const ref8t = (String(id || "").slice(-8) || "--------");
  const entryStr = entry ?? "market";
  const slStr = sl ?? "-";
  const tpStr = tp1 ?? "-";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <image x="0" y="0" width="${W}" height="${H}" href="${tplUri}"/>

  <rect x="70" y="190" width="520" height="220" rx="18" fill="rgba(0,0,0,0.35)"/>
  <rect x="820" y="1010" width="250" height="60" rx="10" fill="rgba(0,0,0,0.35)"/>

  <text x="110" y="250" font-family="Inter,Segoe UI,Arial" font-size="28" fill="rgba(255,255,255,0.70)" letter-spacing="5">FLEXBOT</text>
  <text x="110" y="310" font-family="Inter,Segoe UI,Arial" font-size="54" fill="#fff" font-weight="900">${sym} ${dir}</text>
  <text x="110" y="365" font-family="Inter,Segoe UI,Arial" font-size="32" fill="rgba(255,255,255,0.72)">Outcome: <tspan fill="${outcomeColor}" font-weight="900">${outcomeStr}</tspan></text>

  <text x="930" y="314" text-anchor="end" font-family="Inter,Segoe UI,Arial" font-size="34" fill="#fff" font-weight="900">${entryStr}</text>
  <text x="930" y="424" text-anchor="end" font-family="Inter,Segoe UI,Arial" font-size="34" fill="#fff" font-weight="900">${slStr}</text>
  <text x="930" y="534" text-anchor="end" font-family="Inter,Segoe UI,Arial" font-size="34" fill="#fff" font-weight="900">${tpStr}</text>

  <text x="${W - 56}" y="1052" text-anchor="end" font-family="Inter,Segoe UI,Arial" font-size="18" fill="rgba(255,255,255,0.55)">Ref ${ref8t}</text>
</svg>`;
}

const outPath = path.join(__dirname, "..", "..", "..", "LOSS_TEMPLATE_PREVIEW.png");

// Random-ish preview numbers
function rnd(a,b){ return (a + Math.random()*(b-a)); }
const entryP = rnd(5100, 5250);
const slP = entryP - rnd(6, 18);
const tpP = entryP + rnd(10, 25);
const usd = rnd(120, 980);

const svg = createClosedCardSvgV3({
  id: `preview-${Math.random().toString(16).slice(2)}abcd1234`,
  symbol: "XAUUSD",
  direction: "BUY",
  outcome: "SL hit",
  result: `-${usd.toFixed(2)}`,
  entry: entryP.toFixed(2),
  sl: slP.toFixed(3),
  tp: [tpP.toFixed(3)],
});

const buf = renderSvgToPngBuffer(svg);
fs.writeFileSync(outPath, buf);
console.log("wrote", outPath);
