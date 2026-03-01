// Preview TOP TRADES OF THE DAY card locally.
// Usage: node tools/preview_top_trades.js

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const serverPath = path.join(root, "server.js");

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

const createTopTradesSvg = sandbox.createTopTradesSvg;
const renderSvgToPngBuffer = sandbox.renderSvgToPngBuffer;

if (typeof createTopTradesSvg !== "function" || typeof renderSvgToPngBuffer !== "function") {
  throw new Error("Missing createTopTradesSvg/renderSvgToPngBuffer in sandbox");
}

const svg = createTopTradesSvg({
  symbol: "XAUUSD",
  dayLabel: "Day: 2026-02-27",
  items: [
    { rank: 1, dir: "BUY", out: "TP", usdStr: "+1297.12 USD" },
    { rank: 2, dir: "SELL", out: "TP", usdStr: "+642.55 USD" },
    { rank: 3, dir: "BUY", out: "TP", usdStr: "+412.30 USD" },
  ],
});

const png = renderSvgToPngBuffer(svg);
const outPath = path.join(root, "out", `top-trades-preview-${Date.now()}.png`);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, png);
console.log(outPath);
