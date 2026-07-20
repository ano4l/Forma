import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { normalizeBusinessLogo } from "../image-processing.js";

test("SVG logos are rasterized into bounded metadata-free PNGs", async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="#7f56d9"/></svg>');
  const normalized = await normalizeBusinessLogo(svg);
  assert.equal(normalized.contentType, "image/png");
  assert.equal(normalized.extension, "png");
  assert.ok(normalized.content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  const metadata = await sharp(normalized.content).metadata();
  assert.equal(metadata.format, "png");
  assert.ok(metadata.width <= 1600 && metadata.height <= 1600);
  assert.equal(metadata.exif, undefined);
});

test("WebP logos become PNGs that PDFKit can embed", async () => {
  const webp = await sharp({ create: { width: 32, height: 16, channels: 4, background: "#111827" } }).webp().toBuffer();
  const normalized = await normalizeBusinessLogo(webp);
  const metadata = await sharp(normalized.content).metadata();
  assert.equal(metadata.format, "png");
  assert.equal(metadata.width, 32);
  assert.equal(metadata.height, 16);
});

test("corrupt images are rejected during normalization", async () => {
  await assert.rejects(() => normalizeBusinessLogo(Buffer.from("not-an-image")), (error) => error.status === 422 && error.code === "INVALID_LOGO_IMAGE");
});
