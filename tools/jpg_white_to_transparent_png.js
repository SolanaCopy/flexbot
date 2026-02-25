const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');
const { PNG } = require('pngjs');

// Usage: node tools/jpg_white_to_transparent_png.js <in.jpg> <out.png> [threshold]
// Makes near-white pixels transparent (simple background removal).

function main() {
  const inFp = process.argv[2];
  const outFp = process.argv[3];
  const thr = Number(process.argv[4] || 248);
  if (!inFp || !outFp) {
    console.error('Usage: node tools/jpg_white_to_transparent_png.js <in.jpg> <out.png> [threshold]');
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

    // simple whiteness metric
    const min = Math.min(r, g, b);
    const max = Math.max(r, g, b);

    // if it's close to white and low chroma, treat as bg
    const chroma = max - min;
    const isBg = (r >= thr && g >= thr && b >= thr && chroma <= 18);

    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;

    if (isBg) {
      png.data[i + 3] = 0;
      madeTransparent++;
    } else {
      // feather edges a tiny bit for almost-white pixels
      if (r >= thr - 10 && g >= thr - 10 && b >= thr - 10 && chroma <= 30) {
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
