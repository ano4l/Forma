import sharp from "sharp";

const MAX_LOGO_PIXELS = 16_000_000;
const MAX_LOGO_DIMENSION = 1_600;
const MAX_NORMALIZED_BYTES = 2 * 1024 * 1024;

export async function normalizeBusinessLogo(content) {
  if (!Buffer.isBuffer(content) || !content.length) throw Object.assign(new Error("Logo image is empty"), { status: 422, code: "VALIDATION_ERROR" });
  try {
    const { data, info } = await sharp(content, { density: 144, limitInputPixels: MAX_LOGO_PIXELS, failOn: "error" })
      .rotate()
      .resize({ width: MAX_LOGO_DIMENSION, height: MAX_LOGO_DIMENSION, fit: "inside", withoutEnlargement: true })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer({ resolveWithObject: true });
    if (!info.width || !info.height || data.length > MAX_NORMALIZED_BYTES) throw new Error("Normalized logo exceeds its safe bounds");
    return { content: data, contentType: "image/png", extension: "png", width: info.width, height: info.height };
  } catch {
    throw Object.assign(new Error("The logo could not be safely normalized"), { status: 422, code: "INVALID_LOGO_IMAGE" });
  }
}
