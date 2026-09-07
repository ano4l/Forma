import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../server.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const pngDimensions = (file) => {
  const bytes = readFileSync(file);
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${file} must be a PNG`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};

test("PWA icon files are valid PNGs at the advertised sizes", () => {
  assert.deepEqual(pngDimensions(path.join(root, "icons", "apple-touch-icon-180.png")), { width: 180, height: 180 });
  assert.deepEqual(pngDimensions(path.join(root, "icons", "icon-192.png")), { width: 192, height: 192 });
  assert.deepEqual(pngDimensions(path.join(root, "icons", "icon-512.png")), { width: 512, height: 512 });
  assert.deepEqual(pngDimensions(path.join(root, "icons", "icon-maskable-512.png")), { width: 512, height: 512 });
});

test("PWA manifest, service worker, icons, and installable shell are served correctly", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "moneyfy-pwa-"));
  const app = createApp({ database: path.join(dir, "test.sqlite"), uploadDir: path.join(dir, "uploads") });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;

    let response = await fetch(`${base}/manifest.webmanifest`);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("application/manifest+json"));
    assert.ok(response.headers.get("cache-control")?.includes("no-cache"));
    const manifest = await response.json();
    assert.equal(manifest.name, "VirtuKey Forma");
    assert.equal(manifest.display, "standalone");
    assert.ok(manifest.icons.some((icon) => icon.sizes === "512x512" && icon.purpose === "maskable"));
    assert.ok(manifest.icons.every((icon) => icon.src.startsWith("/icons/")));

    response = await fetch(`${base}/sw.js`);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("javascript"));
    assert.ok(response.headers.get("cache-control")?.includes("no-cache"));
    assert.equal(response.headers.get("service-worker-allowed"), "/");
    const worker = await response.text();
    assert.ok(worker.includes('"/manifest.webmanifest"'), "worker precaches the manifest");
    assert.ok(worker.includes("networkFirst"), "worker protects API reads with a network-first strategy");

    response = await fetch(`${base}/icons/icon-192.png`);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("cache-control")?.includes("immutable"));
    assert.equal(response.headers.get("content-type"), "image/png");

    response = await fetch(`${base}/`);
    const html = await response.text();
    assert.ok(html.includes('rel="manifest" href="/manifest.webmanifest"'));
    assert.ok(html.includes('apple-mobile-web-app-capable" content="yes"'));
    assert.ok(html.includes('rel="apple-touch-icon"'));

    response = await fetch(`${base}/api/health`);
    assert.equal(response.status, 200, "API still responds alongside the PWA routes");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    app.locals.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
