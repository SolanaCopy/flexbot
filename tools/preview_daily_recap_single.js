// Preview DAILY RECAP with fewer trades (single column layout)
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const serverPath = path.join(root, "server.js");

let code = fs.readFileSync(serverPath, "utf8");
code = code.replace(/\n\s*main\(\)\s*;?\s*\n?\s*$/m, "\n// main() disabled for preview\n");

const sandbox = {
  require, console,
  process: { ...process, env: { ...process.env } },
  __dirname: root, __filename: serverPath,
  Buffer, setTimeout, clearTimeout, setInterval, clearInterval,
};

vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: serverPath, timeout: 15000 });

const { createDailyRecapSvg, renderSvgToPngBuffer } = sandbox;

const lines = [
  "1) BUY | TP | +523.40 USD",
  "2) SELL | SL | -187.20 USD",
  "3) BUY | TP | +312.80 USD",
  "4) SELL | TP | +445.60 USD",
  "5) BUY | SL | -92.10 USD",
  "6) SELL | TP | +678.30 USD",
  "7) BUY | SL | -155.50 USD",
];

const svg = createDailyRecapSvg({
  symbol: "XAUUSD",
  dayLabel: "Day: 2026-03-07",
  closedCount: 7,
  totalUsdStr: "+1525.30 USD",
  totalPctStr: "+2.14%",
  lines,
  page: 1,
  pages: 1,
});

const png = renderSvgToPngBuffer(svg);
const outPath = path.join(root, "out", `daily-recap-single-${Date.now()}.png`);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, png);
console.log(outPath);
