// Deterministic preview for CLOSED WIN card (V3) with a forced mascot.
// Usage:
//   node tools/preview_closed_card_win.js custom4
//   node tools/preview_closed_card_win.js mascot_win_custom4.png
//   node tools/preview_closed_card_win.js mascot_win_custom4.png --sell
//
// This sets process.env.FLEXBOT_FORCE_WIN_MASCOT so previews don't depend on round-robin state.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const serverPath = path.join(root, "server.js");

const arg = String(process.argv[2] || "").trim();
const isSell = process.argv.includes("--sell");

if (!arg) {
  console.error("Missing mascot argument. Example: node tools/preview_closed_card_win.js custom4");
  process.exit(1);
}

let mascotName = arg;
if (/^custom\d+$/i.test(arg)) mascotName = `mascot_win_${arg.toLowerCase()}.png`;
if (!/\.png$/i.test(mascotName) && !/\.jpe?g$/i.test(mascotName)) {
  // allow passing just '4' etc
  if (/^\d+$/.test(mascotName)) mascotName = `mascot_win_custom${mascotName}.png`;
}

process.env.FLEXBOT_FORCE_WIN_MASCOT = mascotName;

let code = fs.readFileSync(serverPath, "utf8");
code = code.replace(/\n\s*main\(\)\s*;?\s*\n?\s*$/m, "\n// main() disabled for preview\n");

const sandbox = {
  require,
  console,
  process: { ...process, env: { ...process.env } },
  __dirname: root,
  __filename: serverPath,
  Buffer,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
};

vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: serverPath, timeout: 15000 });

const createClosedCardSvgV3 = sandbox.createClosedCardSvgV3;
const renderSvgToPngBuffer = sandbox.renderSvgToPngBuffer;

if (typeof createClosedCardSvgV3 !== "function" || typeof renderSvgToPngBuffer !== "function") {
  throw new Error("Preview tool could not access createClosedCardSvgV3/renderSvgToPngBuffer");
}

const payload = {
  id: `demo-${String(mascotName).replace(/[^a-z0-9]/gi, "-")}`,
  symbol: "XAUUSD",
  direction: isSell ? "SELL" : "BUY",
  outcome: "TP hit",
  result: isSell ? "+642.55 USD" : "1180.20 USD",
  entry: isSell ? 5266.4 : 5258.18,
  sl: isSell ? 5275.1 : 5247.23,
  tp: [isSell ? 5253.9 : 5272.23],
};

const svg = createClosedCardSvgV3(payload);
const png = renderSvgToPngBuffer(svg);

const outPath = path.join(root, "out", `closed-card-win-${path.basename(mascotName, path.extname(mascotName))}-${Date.now()}.png`);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, png);

console.log(outPath);
