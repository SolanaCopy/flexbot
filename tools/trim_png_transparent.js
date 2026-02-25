const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

// Usage: node tools/trim_png_transparent.js <in.png> <out.png> [alphaThreshold]
// Trims fully/mostly transparent borders based on alpha > threshold.

function main() {
  const inFp = process.argv[2];
  const outFp = process.argv[3];
  const thr = Number(process.argv[4] || 8);
  if (!inFp || !outFp) {
    console.error('Usage: node tools/trim_png_transparent.js <in.png> <out.png> [alphaThreshold]');
    process.exit(2);
  }

  const buf = fs.readFileSync(inFp);
  const png = PNG.sync.read(buf);
  const { width: W, height: H, data } = png;

  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const a = data[i + 3];
      if (a > thr) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    // Nothing visible; just copy.
    fs.mkdirSync(path.dirname(outFp), { recursive: true });
    fs.writeFileSync(outFp, buf);
    console.log(JSON.stringify({ ok: true, inFp: path.resolve(inFp), outFp: path.resolve(outFp), trimmed: false, reason: 'no_nontransparent_pixels' }, null, 2));
    return;
  }

  const newW = maxX - minX + 1;
  const newH = maxY - minY + 1;
  const out = new PNG({ width: newW, height: newH });

  for (let y = 0; y < newH; y++) {
    for (let x = 0; x < newW; x++) {
      const srcI = ((minY + y) * W + (minX + x)) * 4;
      const dstI = (y * newW + x) * 4;
      out.data[dstI] = data[srcI];
      out.data[dstI + 1] = data[srcI + 1];
      out.data[dstI + 2] = data[srcI + 2];
      out.data[dstI + 3] = data[srcI + 3];
    }
  }

  fs.mkdirSync(path.dirname(outFp), { recursive: true });
  fs.writeFileSync(outFp, PNG.sync.write(out));
  console.log(
    JSON.stringify(
      {
        ok: true,
        inFp: path.resolve(inFp),
        outFp: path.resolve(outFp),
        trimmed: true,
        alphaThreshold: thr,
        box: { minX, minY, maxX, maxY },
        size: { in: [W, H], out: [newW, newH] },
      },
      null,
      2,
    ),
  );
}

main();
