// Convert an input image to a transparent PNG by removing near-black background.
// Usage: node tools/make_transparent_mascot.js <inPath> <outPath>

const sharp = require("sharp");

(async () => {
  const inPath = process.argv[2];
  const outPath = process.argv[3];
  if (!inPath || !outPath) {
    console.error("Usage: node tools/make_transparent_mascot.js <inPath> <outPath>");
    process.exit(1);
  }

  const { data, info } = await sharp(inPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;

  // Simple chroma-key: make near-black pixels transparent
  for (let i = 0; i < w * h; i++) {
    const idx = i * 4;
    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const lum = (r + g + b) / 3;

    // tweak thresholds if needed
    if (lum < 18 && (max - min) < 22) data[idx + 3] = 0;
  }

  await sharp(data, { raw: { width: w, height: h, channels: 4 } })
    .png()
    .toFile(outPath);

  console.log(outPath);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
