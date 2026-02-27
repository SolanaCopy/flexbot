/*
Convert a raster image (JPG/PNG) to PNG (RGBA).
Usage:
  node tools/convert_image_to_png.js <input> <output>

No resizing; keeps original dimensions.
*/

const fs = require("fs");
const path = require("path");
const jpeg = require("jpeg-js");
const { PNG } = require("pngjs");

const inPath = process.argv[2];
const outPath = process.argv[3];

if (!inPath || !outPath) {
  console.error("Usage: node tools/convert_image_to_png.js <input> <output>");
  process.exit(1);
}

const ext = path.extname(inPath).toLowerCase();
const buf = fs.readFileSync(inPath);

let width, height, data;

if (ext === ".jpg" || ext === ".jpeg") {
  const decoded = jpeg.decode(buf, { useTArray: true });
  width = decoded.width;
  height = decoded.height;
  data = decoded.data; // RGBA
} else if (ext === ".png") {
  const decoded = PNG.sync.read(buf);
  width = decoded.width;
  height = decoded.height;
  data = decoded.data; // RGBA
} else {
  console.error("Unsupported input type:", ext);
  process.exit(1);
}

const png = new PNG({ width, height });
// Ensure buffer sizes match
if (data.length !== png.data.length) {
  console.error("Unexpected pixel buffer size", { in: data.length, out: png.data.length, width, height });
  process.exit(1);
}

png.data.set(data);
const outBuf = PNG.sync.write(png);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, outBuf);
console.log(outPath);
