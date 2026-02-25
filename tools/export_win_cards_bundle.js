const fs = require('fs');
const path = require('path');

// Copies tmp/all-win-cards/WIN_CARD_mascot_win_custom{1..10}.png to tmp/send/wins_<timestamp>/
// and also creates a wins_<timestamp>.zip via powershell Compress-Archive (best-effort).

function main() {
  const root = path.resolve(__dirname, '..');
  const srcDir = path.join(root, 'tmp', 'all-win-cards');
  const outRoot = path.join(root, 'tmp', 'send');
  const stamp = String(Date.now());
  const outDir = path.join(outRoot, `wins_${stamp}`);

  fs.mkdirSync(outDir, { recursive: true });

  const outFiles = [];
  for (let i = 1; i <= 10; i++) {
    const src = path.join(srcDir, `WIN_CARD_mascot_win_custom${i}.png`);
    const dst = path.join(outDir, `WIN_custom${i}.png`);
    fs.copyFileSync(src, dst);
    outFiles.push(dst);
  }

  const zipPath = path.join(outRoot, `wins_${stamp}.zip`);
  try {
    const { execSync } = require('child_process');
    // Use powershell Compress-Archive (available on Windows)
    execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${outDir}\\*' -DestinationPath '${zipPath}' -Force"`, {
      stdio: 'ignore',
    });
  } catch {
    // ignore
  }

  console.log(JSON.stringify({ ok: true, stamp, outDir, outFiles, zipPath }, null, 2));
}

main();
