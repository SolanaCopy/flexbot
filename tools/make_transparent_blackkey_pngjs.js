// Remove near-black background from a raster image and output a transparent PNG.
// Usage: node tools/make_transparent_blackkey_pngjs.js <input.(png|jpg|jpeg)> <output.png>

const fs = require("fs");
const path = require("path");
const jpeg = require("jpeg-js");
const { PNG } = require("pngjs");

const inPath = process.argv[2];
const outPath = process.argv[3];

if (!inPath || !outPath) {
  console.error("Usage: node tools/make_transparent_blackkey_pngjs.js <input> <output.png>");
  process.exit(1);
}

const ext = path.extname(inPath).toLowerCase();
const buf = fs.readFileSync(inPath);

let width, height, data;
if (ext === ".jpg" || ext === ".jpeg") {
  const decoded = jpeg.decode(buf, { useTArray: true });
  width = decoded.width;
  height = decoded.height;
  data = Buffer.from(decoded.data); // RGBA
} else if (ext === ".png") {
  const decoded = PNG.sync.read(buf);
  width = decoded.width;
  height = decoded.height;
  data = Buffer.from(decoded.data); // RGBA
} else {
  console.error("Unsupported input type:", ext);
  process.exit(1);
}

// Chroma-key near-black pixels to alpha=0.
// Tuned for solid/near-solid black backgrounds.
const lumThresh = 28; // higher => more aggressive
const chromaThresh = 30; // max-min channel

for (let i = 0; i < width * height; i++) {
  const idx = i * 4;
  const r = data[idx];
  const g = data[idx + 1];
  const b = data[idx + 2];
  const a = data[idx + 3];
  if (a === 0) continue;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lum = (r + g + b) / 3;

  if (lum < lumThresh && (max - min) < chromaThresh) {
    data[idx + 3] = 0;
  }
}

const png = new PNG({ width, height });
png.data = data;
const outBuf = PNG.sync.write(png);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, outBuf);
console.log(outPath);
