// Generates the PWA icon set as real PNGs with 4x supersampled antialiasing.
// Usage: node scripts/generate-icons.mjs
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "icons");

const BRAND_TOP = [139, 98, 224];    // #8b62e0
const BRAND_BOTTOM = [105, 65, 198]; // #6941c6
const INK = [16, 24, 40];            // --ink
const PAGE = [255, 255, 255];
const FOLD = [237, 228, 255];
const LINE = [127, 86, 217];         // --brand

function crc32(buffer) {
  let crc = ~0;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

const lerp = (a, b, t) => a.map((value, index) => Math.round(value + (b[index] - value) * t));

function inPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, yi] = points[i]; const [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inRoundedRect(x, y, x0, y0, w, h, r) {
  if (x < x0 || x > x0 + w || y < y0 || y > y0 + h) return false;
  if (r <= 0) return true;
  const cx = Math.max(x0 + r, Math.min(x, x0 + w - r));
  const cy = Math.max(y0 + r, Math.min(y, y0 + h - r));
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function renderIcon(size, { maskable = false } = {}) {
  const SS = 4;
  const hi = size * SS;
  const buffer = Buffer.alloc(hi * hi * 4);
  const cornerR = maskable ? 0 : 0.225 * hi;
  const scale = maskable ? 0.84 : 1;
  const pageW = 0.5 * hi * scale; const pageH = 0.62 * hi * scale;
  const px = (hi - pageW) / 2; const py = (hi - pageH) / 2 - (maskable ? 0 : 0.005 * hi);
  const fold = 0.15 * hi * scale;
  const page = [[px, py], [px + pageW - fold, py], [px + pageW, py + fold], [px + pageW, py + pageH], [px, py + pageH]];
  const flap = [[px + pageW - fold, py], [px + pageW, py + fold], [px + pageW - fold, py + fold]];
  const shadowOffset = 0.018 * hi;
  const shadow = page.map(([x, y]) => [x, y + shadowOffset]);
  const bars = [
    [px + 0.11 * pageW, py + 0.56 * pageH, 0.62 * pageW],
    [px + 0.11 * pageW, py + 0.68 * pageH, 0.48 * pageW],
    [px + 0.11 * pageW, py + 0.8 * pageH, 0.34 * pageW]
  ];
  const barH = 0.045 * pageH;

  for (let y = 0; y < hi; y += 1) {
    for (let x = 0; x < hi; x += 1) {
      const offset = (y * hi + x) * 4;
      if (cornerR > 0 && !inRoundedRect(x, y, 0, 0, hi, hi, cornerR)) continue; // transparent
      const t = (x + y) / (2 * hi);
      let [r, g, b] = lerp(BRAND_TOP, BRAND_BOTTOM, t);
      if (inPolygon(x, y, shadow)) { r *= 0.82; g *= 0.82; b *= 0.82; }
      if (inPolygon(x, y, page)) [r, g, b] = PAGE;
      if (inPolygon(x, y, flap)) [r, g, b] = FOLD;
      for (const [bx, by, bw] of bars) if (inRoundedRect(x, y, bx, by, bw, barH, barH / 2)) [r, g, b] = LINE;
      buffer[offset] = r; buffer[offset + 1] = g; buffer[offset + 2] = b; buffer[offset + 3] = 255;
    }
  }
  // Fold crease: thin diagonal accent from fold corner to opposite page corner.
  return buffer;
}

function supersampleDown(hiSize, buffer) {
  const size = hiSize / 4;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < 4; dy += 1) for (let dx = 0; dx < 4; dx += 1) {
        const offset = (((y * 4 + dy) * hiSize) + x * 4 + dx) * 4;
        r += buffer[offset] * buffer[offset + 3]; g += buffer[offset + 1] * buffer[offset + 3]; b += buffer[offset + 2] * buffer[offset + 3]; a += buffer[offset + 3];
      }
      const o = (y * size + x) * 4;
      out[o] = a ? Math.round(r / a) : 0; out[o + 1] = a ? Math.round(g / a) : 0; out[o + 2] = a ? Math.round(b / a) : 0; out[o + 3] = Math.round(a / 16);
    }
  }
  return out;
}

const icons = [
  { name: "apple-touch-icon-180.png", size: 180, maskable: true },
  { name: "icon-192.png", size: 192, maskable: false },
  { name: "icon-512.png", size: 512, maskable: false },
  { name: "icon-maskable-512.png", size: 512, maskable: true }
];

await mkdir(outDir, { recursive: true });
for (const icon of icons) {
  const hi = renderIcon(icon.size, icon);
  const rgba = supersampleDown(icon.size * 4, hi);
  const png = encodePng(icon.size, rgba);
  await writeFile(path.join(outDir, icon.name), png);
  console.log(`icons/${icon.name}  ${(png.length / 1024).toFixed(1)} KB`);
}
