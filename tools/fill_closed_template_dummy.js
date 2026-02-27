/*
Generate a filled dummy CLOSED card from a provided background template image.
Usage:
  node tools/fill_closed_template_dummy.js <inputImagePath> <outputPngPath>
*/

const fs = require("fs");
const path = require("path");
const { Resvg } = require("@resvg/resvg-js");

const inPath = process.argv[2];
const outPath = process.argv[3] || path.join(__dirname, "..", "out", `closed-template-dummy-${Date.now()}.png`);

if (!inPath) {
  console.error("Missing input image path");
  process.exit(1);
}

const W = 1080;
const H = 1080;

const bgBuf = fs.readFileSync(inPath);
const ext = path.extname(inPath).toLowerCase();
const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
const bgData = `data:${mime};base64,${bgBuf.toString("base64")}`;

// Dummy values
const symdir = "XAUUSD BUY";
const outcome = "SL";
const outcomeColor = "#ff4d4d";
const entry = "5184.78";
const sl = "5193.85";
const tp = "5168.85";

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <image x="0" y="0" width="${W}" height="${H}" href="${bgData}"/>

  <!-- Symbol + direction -->
  <text x="110" y="320" font-family="Inter,Segoe UI,Arial" font-size="54" fill="#fff" font-weight="900">${symdir}</text>

  <!-- Outcome (20px up) -->
  <text x="110" y="375" font-family="Inter,Segoe UI,Arial" font-size="32" fill="rgba(255,255,255,0.72)">Outcome: <tspan fill="${outcomeColor}" font-weight="900">${outcome}</tspan></text>

  <!-- Panel values (right) -->
  <text x="930" y="294" text-anchor="end" font-family="Inter,Segoe UI,Arial" font-size="34" fill="#fff" font-weight="900">${entry}</text>
  <text x="930" y="379" text-anchor="end" font-family="Inter,Segoe UI,Arial" font-size="34" fill="#fff" font-weight="900">${sl}</text>
  <text x="930" y="474" text-anchor="end" font-family="Inter,Segoe UI,Arial" font-size="34" fill="#fff" font-weight="900">${tp}</text>
</svg>`;

const resvg = new Resvg(svg, { fitTo: { mode: "width", value: W } });
const png = resvg.render().asPng();
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, png);
console.log(outPath);
