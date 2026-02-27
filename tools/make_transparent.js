// Convert a dark-background JPG/PNG into a PNG with transparent background.
// Usage: node tools/make_transparent.js <infile> <outfile>

const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');
const { PNG } = require('pngjs');

const infile = process.argv[2];
const outfile = process.argv[3];
if (!infile || !outfile) {
  console.error('Usage: node tools/make_transparent.js <infile> <outfile>');
  process.exit(1);
}

const ext = path.extname(infile).toLowerCase();
const buf = fs.readFileSync(infile);
let img;
if (ext === '.jpg' || ext === '.jpeg') {
  img = jpeg.decode(buf, { useTArray: true });
} else if (ext === '.png') {
  img = PNG.sync.read(buf);
} else {
  throw new Error('Unsupported: ' + ext);
}

const out = new PNG({ width: img.width, height: img.height });

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

for (let i = 0; i < img.data.length; i += 4) {
  const r = img.data[i];
  const g = img.data[i + 1];
  const b = img.data[i + 2];

  // Distance to black (0..441)
  const d = Math.sqrt(r*r + g*g + b*b);

  // Tuned for pure-black backgrounds with slight compression noise.
  // d < t0 => fully transparent, d > t1 => fully opaque.
  const t0 = 18;
  const t1 = 55;
  let a = 255;
  if (d <= t0) a = 0;
  else if (d < t1) a = Math.round(((d - t0) / (t1 - t0)) * 255);

  // Keep edges cleaner: if it's almost black, fade a bit more.
  if (d < 35) a = Math.round(a * 0.75);

  out.data[i] = r;
  out.data[i + 1] = g;
  out.data[i + 2] = b;
  out.data[i + 3] = clamp(a, 0, 255);
}

fs.mkdirSync(path.dirname(outfile), { recursive: true });
fs.writeFileSync(outfile, PNG.sync.write(out));
console.log(outfile);
