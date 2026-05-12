#!/usr/bin/env node
// End-to-end test for manual broadcast flow.
// Three scenarios verified, no MT5/FTMO involvement:
//   A) basic: master open → customer poll → customer gets signal
//   B) spurious-close guard: master open → spurious close (500ms) → customer poll → customer STILL gets signal
//   C) cleanup: force-close test signals

const BASE = "https://flexbot-qpf2.onrender.com";
const ADMIN_KEY = "Tanger2026@";
const EA_API_KEY = "fb_10792cbd4ac74742126d50a3f0198ad9bbfa17c14761e18f";

const MASTER_LOGIN = "511253083";
const MASTER_SERVER = "FTMO-Server";
const CUSTOMER_LOGIN = "521049561";
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
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, json };
}

async function openSignal(suffix) {
  const ticket = `test-${suffix}-${Date.now()}`;
  const signalId = `m-${MASTER_LOGIN}-${ticket}`;
  const r = await http("POST", "/signal/manual/open", {
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
  return { ok: r.status === 200, signalId, response: r };
}

async function customerPoll() {
  const r = await http("GET", `/signal/next?symbol=XAUUSD&account_login=${CUSTOMER_LOGIN}&server=${CUSTOMER_SERVER}&since_ms=0`);
  return r.json.signal;
}

async function adminClose(signalId) {
  return http("POST", `/admin/signal/${encodeURIComponent(signalId)}/close?key=${encodeURIComponent(ADMIN_KEY)}`);
}

async function simulateClose(signalId) {
  return http("POST", `/admin/signal/${encodeURIComponent(signalId)}/simulate-close?key=${encodeURIComponent(ADMIN_KEY)}`);
}

(async () => {
  const line = "═".repeat(60);
  const results = [];

  // ─── A: basic flow ───
  console.log(line);
  console.log("Test A — basic broadcast flow");
  console.log(line);
  const a = await openSignal("A");
  console.log("1. master open:", a.ok ? "ok" : a.response.json);
  await sleep(300);
  const sigA = await customerPoll();
  const passA = sigA && sigA.id === a.signalId;
  console.log("2. customer poll:", passA ? "✅ got signal" : `❌ ${sigA ? "wrong signal "+sigA.id : "null"}`);
  await adminClose(a.signalId);
  results.push(["A. basic open → poll", passA]);
  console.log();

  // ─── B: spurious close guard ───
  console.log(line);
  console.log("Test B — spurious close guard (close fires 500ms after open)");
  console.log(line);
  const b = await openSignal("B");
  console.log("1. master open:", b.ok ? "ok" : b.response.json);
  await sleep(500);
  const spur = await simulateClose(b.signalId);
  const guarded = spur.json.ignored === "too_soon_after_open";
  console.log("2. spurious close (500ms after open):", guarded ? `✅ blocked (age=${spur.json.age_ms_server}ms)` : `❌ accepted: ${JSON.stringify(spur.json)}`);
  await sleep(200);
  const sigB = await customerPoll();
  const passB = sigB && sigB.id === b.signalId;
  console.log("3. customer poll AFTER spurious close:", passB ? "✅ still gets signal" : `❌ ${sigB ? "wrong signal" : "null (signal was killed)"}`);
  await adminClose(b.signalId);
  results.push(["B. spurious-close guard blocks <30s close", guarded && passB]);
  console.log();

  // ─── C: legit close after 31s gets through ───
  console.log(line);
  console.log("Test C — legit close after 31s passes guard");
  console.log(line);
  const c = await openSignal("C");
  console.log("1. master open:", c.ok ? "ok" : c.response.json);
  console.log("2. waiting 31 seconds...");
  await sleep(31000);
  const real = await simulateClose(c.signalId);
  const accepted = real.json.closed === c.signalId;
  console.log("3. close 31s after open:", accepted ? "✅ accepted (signal now closed)" : `❌ ${JSON.stringify(real.json)}`);
  results.push(["C. legit close after 30s passes through", accepted]);
  console.log();

  // ─── summary ───
  console.log(line);
  console.log("SUMMARY");
  console.log(line);
  for (const [name, ok] of results) {
    console.log(` ${ok ? "✅" : "❌"} ${name}`);
  }
  const allPass = results.every(r => r[1]);
  console.log();
  console.log(allPass ? "🎯 ALL TESTS PASSED — broadcast flow verified end-to-end" : "⚠ Some tests failed — see above");
})();
