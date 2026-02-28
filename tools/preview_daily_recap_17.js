// Preview DAILY RECAP with 17 trades (should be 1 page in 2-column mode).
// Usage: node tools/preview_daily_recap_17.js

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

const createDailyRecapSvg = sandbox.createDailyRecapSvg;
const renderSvgToPngBuffer = sandbox.renderSvgToPngBuffer;

if (typeof createDailyRecapSvg !== "function" || typeof renderSvgToPngBuffer !== "function") {
  throw new Error("Missing createDailyRecapSvg/renderSvgToPngBuffer in sandbox");
}

const lines = Array.from({ length: 17 }, (_, i) => {
  const n = i + 1;
  const dir = n % 2 === 0 ? "SELL" : "BUY";
  const out = n % 5 === 0 ? "TP" : "SL";
  const usd = out === "TP" ? `+${(100 + n * 11.1).toFixed(2)} USD` : `-${(300 + n * 9.3).toFixed(2)} USD`;
  return `${n}) ${dir} | ${out} | ${usd}`;
});

const svg = createDailyRecapSvg({
  symbol: "XAUUSD",
  dayLabel: "Day: 2026-02-27",
  closedCount: 17,
  totalUsdStr: "-1422.49 USD",
  totalPctStr: "-1.55%",
  lines,
  page: 1,
  pages: 1,
});

const png = renderSvgToPngBuffer(svg);
const outPath = path.join(root, "out", `daily-recap-17-1page-${Date.now()}.png`);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, png);
console.log(outPath);
