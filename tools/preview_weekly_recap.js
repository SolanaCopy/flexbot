// Preview WEEKLY RECAP (Mon-Fri mini overview) locally.
// Usage: node tools/preview_weekly_recap.js

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

const createWeeklyRecapSvg = sandbox.createWeeklyRecapSvg;
const renderSvgToPngBuffer = sandbox.renderSvgToPngBuffer;

if (typeof createWeeklyRecapSvg !== "function" || typeof renderSvgToPngBuffer !== "function") {
  throw new Error("Missing createWeeklyRecapSvg/renderSvgToPngBuffer in sandbox");
}

const days = [
  { label: "Mon", trades: 3, usdStr: "+412.30 USD", pctStr: "+0.41%" },
  { label: "Tue", trades: 2, usdStr: "-975.23 USD", pctStr: "-0.98%" },
  { label: "Wed", trades: 4, usdStr: "+388.10 USD", pctStr: "+0.39%" },
  { label: "Thu", trades: 1, usdStr: "+255.00 USD", pctStr: "+0.26%" },
  { label: "Fri", trades: 5, usdStr: "-610.00 USD", pctStr: "-0.61%" },
];

const svg = createWeeklyRecapSvg({
  symbol: "XAUUSD",
  weekLabel: "Week: 2026-02-23 → 2026-02-27",
  totalTrades: 15,
  totalUsdStr: "-529.83 USD",
  totalPctStr: "-0.53%",
  days,
});

const png = renderSvgToPngBuffer(svg);
const outPath = path.join(root, "out", `weekly-recap-preview-${Date.now()}.png`);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, png);
console.log(outPath);
