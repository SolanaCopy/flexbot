#!/usr/bin/env node
// End-to-end test for manual broadcast flow.
// Simulates master open → customer poll, without touching real MT5 or FTMO.
// No real money, no asking the customer for screenshots.

const BASE = "https://flexbot-qpf2.onrender.com";
const ADMIN_KEY = "Tanger2026@";
const EA_API_KEY = "fb_10792cbd4ac74742126d50a3f0198ad9bbfa17c14761e18f"; // any active license works

const MASTER_LOGIN = "511253083";
const MASTER_SERVER = "FTMO-Server";
const CUSTOMER_LOGIN = "521049561"; // Valentyn
const CUSTOMER_SERVER = "FTMO-Server2";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function http(method, path, body, extraHeaders = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

(async () => {
  const ticket = "test-" + Date.now();
  const signalId = `m-${MASTER_LOGIN}-${ticket}`;
  const line = "═".repeat(60);
  console.log(line);
  console.log("Broadcast flow test — no MT5/FTMO interaction");
  console.log(line);
  console.log("Signal id:", signalId);
  console.log();

  // STEP 1: Master opens trade (simulated)
  console.log("1. master → /signal/manual/open");
  const open = await http("POST", "/signal/manual/open", {
    id: signalId,
    symbol: "XAUUSD",
    direction: "BUY",
    sl: 4690,
    tp: [4730],
    risk_pct: 0.5,
    ticket: ticket,
    fill_price: 4710.50,
    account_login: MASTER_LOGIN,
    server: MASTER_SERVER,
    time: Date.now(),
    comment: "test-manual",
  }, { "X-API-Key": EA_API_KEY });
  console.log("   status:", open.status, "→", open.json.id ? "ok" : JSON.stringify(open.json));
  if (open.status !== 200) { console.log("\n❌ ABORT: open failed"); process.exit(1); }

  // STEP 2: Customer polls /signal/next
  await sleep(300);
  console.log("\n2. customer → /signal/next (300ms after open)");
  const poll = await http("GET", `/signal/next?symbol=XAUUSD&account_login=${CUSTOMER_LOGIN}&server=${CUSTOMER_SERVER}&since_ms=0`);
  console.log("   status:", poll.status);
  const sig = poll.json.signal;
  let result;
  if (sig && sig.id === signalId) {
    result = "✅ PASS — customer received the broadcast signal";
  } else if (sig) {
    result = `⚠  customer got a different signal: ${sig.id}`;
  } else {
    result = "❌ FAIL — customer got null (signal was lost)";
  }
  console.log("   result:", result);

  // STEP 3: cleanup via admin endpoint
  console.log("\n3. cleanup (close test signal via admin endpoint)");
  const cleanup = await http("POST", `/admin/signal/${encodeURIComponent(signalId)}/close?key=${encodeURIComponent(ADMIN_KEY)}`);
  console.log("   status:", cleanup.status, "→", JSON.stringify(cleanup.json));

  console.log("\n" + line);
  console.log(result);
  console.log(line);
})();
