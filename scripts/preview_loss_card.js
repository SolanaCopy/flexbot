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
  const resultStr = result || "-";

  const isTp = String(outcomeStr).toLowerCase().includes("tp");
  const isSl = String(outcomeStr).toLowerCase().includes("sl");
  const outcomeColor = isTp ? "#22c55e" : (isSl ? "#ff4d4d" : "#f59e0b");

  const rawNum = Number(String(resultStr).replace(/[^0-9.+-]/g, ""));
  const prettyNum = Number.isFinite(rawNum) ? Math.abs(rawNum).toFixed(2) : null;
  const isNeg = String(resultStr).trim().startsWith("-") || isSl;
  const pnlColor = isNeg ? "#ff4d4d" : "#22c55e";

  const resultBig = prettyNum ? `${prettyNum} USD` : String(resultStr);
  const resultBigFont = fitFontByChars(resultBig, 74, 48, 12);

  // For preview we force the LOSS mascot.
  const mascotDataUri = getLossMascotDataUri();

  const ref8 = (String(id || "").slice(-8) || "--------");
  const ts = fmtTsISO(new Date());

  // Layout constants
  const pad = 56;
  const ringCx = 300;
  const ringCy = 760;

  const panelX = 560;
  const panelY = 220;
  const titleX = 110;
  const panelW = 460;
  const panelH = 420;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#000000"/>
    <stop offset="0.55" stop-color="#0b0b0d"/>
    <stop offset="1" stop-color="#000000"/>
  </linearGradient>
  <radialGradient id="glow" cx="45%" cy="35%" r="75%">
    <stop offset="0" stop-color="#d4d4d8" stop-opacity="0.10"/>
    <stop offset="0.5" stop-color="#a1a1aa" stop-opacity="0.06"/>
    <stop offset="1" stop-color="#000" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="spot" cx="30%" cy="50%" r="55%">
    <stop offset="0" stop-color="#d4d4d8" stop-opacity="0.12"/>
    <stop offset="0.55" stop-color="#a1a1aa" stop-opacity="0.06"/>
    <stop offset="1" stop-color="#000" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="glass" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="rgba(255,255,255,0.08)"/>
    <stop offset="1" stop-color="rgba(255,255,255,0.03)"/>
  </linearGradient>
  <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%">
    <feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#000" flood-opacity="0.65"/>
  </filter>
  <filter id="softGlow" x="-50%" y="-50%" width="200%" height="200%">
    <feGaussianBlur stdDeviation="10" result="b"/>
    <feColorMatrix in="b" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 0.38 0" result="g"/>
    <feMerge><feMergeNode in="g"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
</defs>

<rect width="${W}" height="${H}" fill="url(#bg)"/>
<rect width="${W}" height="${H}" fill="url(#glow)"/>
<rect x="42" y="42" width="996" height="996" rx="58" fill="rgba(255,255,255,0.02)" stroke="rgba(255,255,255,0.14)" stroke-width="2"/>

<!-- Header -->
<path d="M170 86 H910 L880 126 H200 Z" fill="rgba(255,255,255,0.06)" stroke="rgba(212,212,216,0.22)" stroke-width="2"/>
<text x="540" y="118" text-anchor="middle" font-family="Inter,Segoe UI,Arial" font-size="40" fill="rgba(255,255,255,0.86)" letter-spacing="6">TRADE CLOSED</text>

<!-- Left mascot (no ring) -->
<ellipse cx="${ringCx}" cy="${ringCy}" rx="420" ry="420" fill="url(#spot)"/>
<g filter="url(#shadow)">
  <image x="40" y="520" width="560" height="560" href="${mascotDataUri}" preserveAspectRatio="xMidYMid meet"/>
</g>

<!-- Title block (left) -->
<text x="${titleX}" y="250" font-family="Inter,Segoe UI,Arial" font-size="28" fill="rgba(255,255,255,0.70)" letter-spacing="5">FLEXBOT</text>
<text x="${titleX}" y="310" font-family="Inter,Segoe UI,Arial" font-size="54" fill="#fff" font-weight="900">${sym} ${dir}</text>
<text x="${titleX}" y="365" font-family="Inter,Segoe UI,Arial" font-size="32" fill="rgba(255,255,255,0.72)">Outcome: <tspan fill="${outcomeColor}" font-weight="900">${outcomeStr}</tspan></text>

<!-- Levels panel -->
<g filter="url(#shadow)">
  <rect x="${panelX}" y="${panelY}" width="${panelW}" height="${panelH}" rx="28" fill="url(#glass)" stroke="rgba(255,255,255,0.14)"/>

  <line x1="${panelX}" y1="${panelY + 95}" x2="${panelX + panelW}" y2="${panelY + 95}" stroke="rgba(255,255,255,0.10)"/>
  <line x1="${panelX}" y1="${panelY + 185}" x2="${panelX + panelW}" y2="${panelY + 185}" stroke="rgba(255,255,255,0.10)"/>
  <line x1="${panelX}" y1="${panelY + 275}" x2="${panelX + panelW}" y2="${panelY + 275}" stroke="rgba(255,255,255,0.10)"/>

  <text x="${panelX + 48}" y="${panelY + 62}" font-family="Inter,Segoe UI,Arial" font-size="34" fill="rgba(255,255,255,0.70)">Entry</text>
  <text x="${panelX + panelW - 48}" y="${panelY + 62}" text-anchor="end" font-family="Inter,Segoe UI,Arial" font-size="34" fill="#fff" font-weight="900">${entry ?? "market"}</text>

  <text x="${panelX + 48}" y="${panelY + 152}" font-family="Inter,Segoe UI,Arial" font-size="34" fill="rgba(255,255,255,0.70)">SL</text>
  <text x="${panelX + panelW - 48}" y="${panelY + 152}" text-anchor="end" font-family="Inter,Segoe UI,Arial" font-size="34" fill="#fff" font-weight="900">${sl ?? "-"}</text>

  <text x="${panelX + 48}" y="${panelY + 242}" font-family="Inter,Segoe UI,Arial" font-size="34" fill="rgba(255,255,255,0.70)">TP</text>
  <text x="${panelX + panelW - 48}" y="${panelY + 242}" text-anchor="end" font-family="Inter,Segoe UI,Arial" font-size="34" fill="#fff" font-weight="900">${tp1 ?? "-"}</text>

  <text x="${panelX + 40}" y="${panelY + 370}" font-family="Inter,Segoe UI,Arial" font-size="${resultBigFont}" fill="${pnlColor}" font-weight="950" filter="url(#softGlow)" textLength="${panelW - 80}" lengthAdjust="spacingAndGlyphs">${resultBig}</text>
</g>

<!-- Footer -->
<text x="${pad}" y="944" font-family="Inter,Segoe UI,Arial" font-size="24" fill="rgba(255,255,255,0.46)">Ref ${ref8}</text>
<text x="${pad}" y="996" font-family="Inter,Segoe UI,Arial" font-size="22" fill="rgba(255,255,255,0.42)">Recap generated • after trade close • ${ts}</text>
</svg>`;
}

const outPath = path.join(__dirname, "..", "..", "..", "LOSS_TEMPLATE_PREVIEW.png");

const svg = createClosedCardSvgV3({
  id: "preview-0000abcd1234",
  symbol: "XAUUSD",
  direction: "SELL",
  outcome: "SL hit",
  result: "-214.80",
  entry: "1974.20",
  sl: "1983.50",
  tp: ["1956.00"],
});

const buf = renderSvgToPngBuffer(svg);
fs.writeFileSync(outPath, buf);
console.log("wrote", outPath);
