// BSC Scanner Dashboard — apart bestand, niet gemixed met flexbot code
// Wordt geladen via: require('./scanner-dashboard')(app);

const SCANNER_API_KEY = process.env.SCANNER_API_KEY || '';
const DASH_KEY = process.env.DASH_KEY || 'Tanger2026@';

let scannerResults = [];

function authDash(req, res) {
  const key = req.query.key;
  if (key !== DASH_KEY) { res.status(403).send('Unauthorized'); return false; }
  return true;
}

module.exports = function(app) {

  // POST: scanner pusht resultaten
  app.post('/api/scanner/results', (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== SCANNER_API_KEY) return res.status(403).json({ error: 'Unauthorized' });
    let body = req.body;
    if (Array.isArray(body)) {
      scannerResults = body.slice(0, 500);
    } else if (body.result) {
      const idx = scannerResults.findIndex(r => r.address?.toLowerCase() === body.result.address?.toLowerCase());
      if (idx >= 0) scannerResults[idx] = body.result;
      else scannerResults.unshift(body.result);
      if (scannerResults.length > 500) scannerResults.pop();
    }
    return res.json({ ok: true, count: scannerResults.length });
  });

  // GET: dashboard haalt data
  app.get('/api/scanner/results', (req, res) => {
    if (!authDash(req, res)) return;
    return res.json(scannerResults);
  });

  // Dashboard pagina
  app.get('/scanner', (req, res) => {
    if (!authDash(req, res)) return;
    const key = req.query.key;

    res.send(`<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BSC Scanner Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Segoe UI', system-ui, sans-serif; background: #0a0e17; color: #e0e6ed; min-height: 100vh; }
  .header { background: linear-gradient(135deg, #1a1f2e 0%, #0d1117 100%); border-bottom: 1px solid #21262d; padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; }
  .header h1 { font-size: 20px; font-weight: 600; }
  .header h1 span { color: #f0b429; }
  .clock { color: #8b949e; font-size: 13px; }
  .nav { display: flex; gap: 8px; padding: 12px 24px; background: #161b22; border-bottom: 1px solid #21262d; }
  .nav a { color: #8b949e; text-decoration: none; padding: 6px 14px; border-radius: 6px; font-size: 13px; transition: all 0.2s; }
  .nav a:hover { background: #21262d; color: #c9d1d9; }
  .nav a.active { background: #1f6feb; color: #fff; }
  .stats-bar { display: flex; gap: 16px; padding: 16px 24px; flex-wrap: wrap; }
  .stat-card { background: #161b22; border: 1px solid #21262d; border-radius: 10px; padding: 14px 20px; flex: 1; min-width: 150px; }
  .stat-card .label { font-size: 11px; color: #8b949e; text-transform: uppercase; letter-spacing: 1px; }
  .stat-card .value { font-size: 24px; font-weight: 700; margin-top: 4px; }
  .stat-card .value.green { color: #3fb950; }
  .stat-card .value.red { color: #f85149; }
  .stat-card .value.gold { color: #f0b429; }
  .stat-card .value.blue { color: #58a6ff; }
  .filters { padding: 8px 24px; display: flex; gap: 8px; flex-wrap: wrap; }
  .filter-btn { background: #21262d; border: 1px solid #30363d; color: #c9d1d9; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 13px; transition: all 0.2s; }
  .filter-btn:hover { background: #30363d; }
  .filter-btn.active { background: #1f6feb; border-color: #1f6feb; color: #fff; }
  .table-wrap { padding: 8px 24px 24px; overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { background: #161b22; border-bottom: 2px solid #21262d; padding: 10px 12px; text-align: left; cursor: pointer; user-select: none; white-space: nowrap; color: #8b949e; font-weight: 600; text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px; }
  th:hover { color: #58a6ff; }
  td { padding: 10px 12px; border-bottom: 1px solid #21262d; }
  tr:hover td { background: #161b22; }
  .addr { font-family: 'Courier New', monospace; font-size: 12px; }
  .addr a { color: #58a6ff; text-decoration: none; }
  .addr a:hover { text-decoration: underline; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
  .badge.danger { background: #f8514922; color: #f85149; border: 1px solid #f8514944; }
  .badge.warn { background: #d2992244; color: #f0b429; border: 1px solid #d2992266; }
  .badge.clean { background: #3fb95022; color: #3fb950; border: 1px solid #3fb95044; }
  .high-cell { color: #f85149; font-weight: 700; }
  .med-cell { color: #f0b429; font-weight: 600; }
  .balance { color: #3fb950; font-weight: 600; }
  .empty { text-align: center; padding: 60px; color: #484f58; font-size: 16px; }
  .refresh-bar { padding: 4px 24px; display: flex; justify-content: space-between; align-items: center; }
  .refresh-bar span { font-size: 11px; color: #484f58; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #3fb950; margin-right: 6px; animation: pulse 2s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
</style>
</head>
<body>
<div class="header">
  <h1>🔍 <span>BSC Scanner</span> Dashboard</h1>
  <div class="clock" id="clock"></div>
</div>
<div class="nav">
  <a href="/mc?key=${key}">📊 Mission Control</a>
  <a href="/fxcopy?key=${key}">📋 FxCopy</a>
  <a href="/scanner?key=${key}" class="active">🔍 Scanner</a>
</div>
<div class="stats-bar">
  <div class="stat-card"><div class="label">Contracten Gescand</div><div class="value blue" id="s-total">-</div></div>
  <div class="stat-card"><div class="label">Met High Issues</div><div class="value red" id="s-high">-</div></div>
  <div class="stat-card"><div class="label">Totale Balance</div><div class="value gold" id="s-balance">-</div></div>
  <div class="stat-card"><div class="label">Schoon</div><div class="value green" id="s-clean">-</div></div>
</div>
<div class="filters">
  <button class="filter-btn active" onclick="setFilter('all')">Alle</button>
  <button class="filter-btn" onclick="setFilter('high')">🔴 Alleen High</button>
  <button class="filter-btn" onclick="setFilter('50k')">💰 $50k+</button>
  <button class="filter-btn" onclick="setFilter('danger')">⚠️ Gevaarlijk</button>
</div>
<div class="refresh-bar">
  <span><span class="dot"></span>Auto-refresh elke 60s</span>
  <span id="last-update">Laden...</span>
</div>
<div class="table-wrap">
  <table>
    <thead><tr>
      <th onclick="sortBy('time')">Datum <span class="sa" id="sort-time"></span></th>
      <th onclick="sortBy('contractName')">Naam <span class="sa" id="sort-contractName"></span></th>
      <th onclick="sortBy('address')">Contract <span class="sa" id="sort-address"></span></th>
      <th onclick="sortBy('balanceUsd')">Balance <span class="sa" id="sort-balanceUsd"></span></th>
      <th onclick="sortBy('totalHigh')">🔴 High <span class="sa" id="sort-totalHigh"></span></th>
      <th onclick="sortBy('totalMedium')">🟡 Medium <span class="sa" id="sort-totalMedium"></span></th>
      <th onclick="sortBy('verdict')">Verdict <span class="sa" id="sort-verdict"></span></th>
    </tr></thead>
    <tbody id="results-body"><tr><td colspan="7" class="empty">Laden...</td></tr></tbody>
  </table>
</div>
<script>
const KEY='${key}';let data=[],currentSort='totalHigh',sortDir=-1,currentFilter='all';
function shortAddr(a){return a?a.slice(0,6)+'...'+a.slice(-4):'';}
function fmtBal(v){return v>=1e6?'$'+(v/1e6).toFixed(1)+'M':v>=1e3?'$'+(v/1e3).toFixed(0)+'k':'$'+(v||0).toFixed(0);}
function fmtDate(t){if(!t)return'-';const d=new Date(t);return d.toLocaleDateString('nl-NL',{day:'2-digit',month:'2-digit'})+' '+d.toLocaleTimeString('nl-NL',{hour:'2-digit',minute:'2-digit'});}
function verdict(r){if(r.totalHigh>=3)return{t:'GEVAARLIJK',c:'danger',s:3};if(r.totalHigh>=1)return{t:'VERDACHT',c:'warn',s:2};return{t:'SCHOON',c:'clean',s:1};}
function setFilter(f){currentFilter=f;document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));event.target.classList.add('active');render();}
function sortBy(col){if(currentSort===col)sortDir*=-1;else{currentSort=col;sortDir=-1;}render();}
function render(){
  let f=[...data];
  if(currentFilter==='high')f=f.filter(r=>r.totalHigh>0);
  else if(currentFilter==='50k')f=f.filter(r=>r.balanceUsd>=50000);
  else if(currentFilter==='danger')f=f.filter(r=>r.totalHigh>=3);
  f.sort((a,b)=>{let va,vb;if(currentSort==='verdict'){va=verdict(a).s;vb=verdict(b).s;}else if(currentSort==='time'){va=new Date(a.time||0).getTime();vb=new Date(b.time||0).getTime();}else{va=a[currentSort]||0;vb=b[currentSort]||0;}if(typeof va==='string')return sortDir*va.localeCompare(vb);return sortDir*(va-vb);});
  document.querySelectorAll('.sa').forEach(s=>s.textContent='');
  const ar=document.getElementById('sort-'+currentSort);if(ar)ar.textContent=sortDir===-1?'▼':'▲';
  document.getElementById('s-total').textContent=data.length;
  document.getElementById('s-high').textContent=data.filter(r=>r.totalHigh>0).length;
  document.getElementById('s-balance').textContent=fmtBal(data.reduce((s,r)=>s+(r.balanceUsd||0),0));
  document.getElementById('s-clean').textContent=data.filter(r=>r.totalHigh===0).length;
  const tb=document.getElementById('results-body');
  if(!f.length){tb.innerHTML='<tr><td colspan="7" class="empty">Geen resultaten'+(currentFilter!=='all'?' (filter actief)':'')+'</td></tr>';return;}
  tb.innerHTML=f.map(r=>{const v=verdict(r);return '<tr><td>'+fmtDate(r.time)+'</td><td>'+(r.contractName||'-')+'</td><td class="addr"><a href="https://bscscan.com/address/'+r.address+'" target="_blank">'+shortAddr(r.address)+'</a></td><td class="balance">'+fmtBal(r.balanceUsd)+'</td><td class="high-cell">'+(r.totalHigh||0)+'</td><td class="med-cell">'+(r.totalMedium||0)+'</td><td><span class="badge '+v.c+'">'+v.t+'</span></td></tr>';}).join('');
}
async function fetchData(){try{const r=await fetch('/api/scanner/results?key='+KEY);data=await r.json();render();document.getElementById('last-update').textContent='Update: '+new Date().toLocaleTimeString('nl-NL');}catch(e){document.getElementById('last-update').textContent='Fout';}}
function clock(){document.getElementById('clock').textContent=new Date().toLocaleString('nl-NL',{timeZone:'Europe/Amsterdam',weekday:'short',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',second:'2-digit'});}
fetchData();setInterval(fetchData,60000);setInterval(clock,1000);clock();
</script>
</body></html>`);
  });

  console.log('[SCANNER] Dashboard routes geladen (/scanner, /api/scanner/*)');
};
