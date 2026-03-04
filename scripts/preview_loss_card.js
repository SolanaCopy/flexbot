const fs   = require("fs");
const path = require("path");
const vm   = require("vm");

const root       = path.join(__dirname, "..");
const serverPath = path.join(root, "server.js");

// Load server.js in a sandbox (same as other preview tools)
let code = fs.readFileSync(serverPath, "utf8");
code = code.replace(/\n\s*main\(\)\s*;?\s*\n?\s*$/m, "\n// main() disabled for preview\n");

const sandbox = {
  require,
  console,
  process:    { ...process, env: { ...process.env } },
  __dirname:  root,
  __filename: serverPath,
  Buffer,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: serverPath, timeout: 15000 });

const { createClosedCardSvgV3, renderSvgToPngBuffer } = sandbox;

function rnd(a, b) { return a + Math.random() * (b - a); }

const entryP = rnd(3200, 3300);
const slP    = entryP + rnd(6, 18);
const tpP    = entryP - rnd(10, 25);
const usd    = rnd(120, 980);

const svg = createClosedCardSvgV3({
  id:        `preview-${Math.random().toString(16).slice(2)}`,
  symbol:    "XAUUSD",
  direction: "BUY",
  outcome:   "SL",
  result:    `-${usd.toFixed(2)} USD`,
  entry:     entryP.toFixed(2),
  sl:        slP.toFixed(2),
  tp:        [tpP.toFixed(2)],
});

const outPath = path.join(__dirname, "..", "..", "..", "LOSS_TEMPLATE_PREVIEW.png");
fs.writeFileSync(outPath, renderSvgToPngBuffer(svg));
console.log("wrote", outPath);
