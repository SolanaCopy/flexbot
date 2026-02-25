const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');
const { PNG } = require('pngjs');

// Usage: node tools/jpg_black_to_transparent_png.js <in.jpg> <out.png> [threshold]
// Makes near-black pixels transparent (simple background removal).

function main() {
  const inFp = process.argv[2];
  const outFp = process.argv[3];
  const thr = Number(process.argv[4] || 18); // <= thr treated as bg
  if (!inFp || !outFp) {
    console.error('Usage: node tools/jpg_black_to_transparent_png.js <in.jpg> <out.png> [threshold]');
    process.exit(2);
  }

  const jpgBuf = fs.readFileSync(inFp);
  const decoded = jpeg.decode(jpgBuf, { useTArray: true });
  const { width, height, data } = decoded; // RGBA

  const png = new PNG({ width, height });
  let madeTransparent = 0;
  let partial = 0;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const chroma = max - min;

    const isBg = (max <= thr && chroma <= 20);

    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;

    if (isBg) {
      png.data[i + 3] = 0;
      madeTransparent++;
    } else {
      // feather edges a tiny bit for almost-black pixels
      if (max <= thr + 12 && chroma <= 35) {
        png.data[i + 3] = 180;
        partial++;
      } else {
        png.data[i + 3] = 255;
      }
    }
  }

  fs.mkdirSync(path.dirname(outFp), { recursive: true });
  fs.writeFileSync(outFp, PNG.sync.write(png));
  console.log(JSON.stringify({ ok: true, inFp: path.resolve(inFp), outFp: path.resolve(outFp), width, height, thr, madeTransparent, partial }, null, 2));
}

main();
