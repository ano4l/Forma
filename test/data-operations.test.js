import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createStore } from "../db.js";
import { evaluateConfiguration, summarizeReadiness } from "../scripts/check-production-readiness.mjs";
import { exportBundle, verifyBundle } from "../scripts/forma-data.mjs";

const WORKSPACE_ID = "7d243f7c-7691-4f72-b7b9-2a4750a06e34";

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "forma-data-"));
  const database = path.join(directory, "source.sqlite");
  const uploadDir = path.join(directory, "uploads");
  mkdirSync(uploadDir);
  const store = createStore(database);
  const document = store.createDocument({
    document_type: "invoice",
    customer: { name: "Migration Customer", address: "1 Main Road" },
    items: [{ description: "Service", quantity: 1, unit_price_minor: 12500, tax_bps: 1500 }],
  });
  const asset = Buffer.from("portable-object-contents");
  writeFileSync(path.join(uploadDir, "proof.pdf"), asset);
  store.db.prepare("INSERT INTO media_assets(id,storage_key,filename,content_type,byte_size,created_at) VALUES(?,?,?,?,?,?)")
    .run("asset-1", "proof.pdf", "proof.pdf", "application/pdf", asset.length, "2026-07-20T10:00:00.000Z");
  store.db.prepare("UPDATE documents SET data_json=json_set(data_json,'$.attachments',json('[\"asset-1\"]')) WHERE id=?").run(document.id);
  store.close();
  return { directory, database, uploadDir, output: path.join(directory, "bundle"), document };
}

test("portable export binds rows and private assets to one workspace", async () => {
  const box = fixture();
  try {
    const exported = await exportBundle({ database: box.database, output: box.output, workspaceId: WORKSPACE_ID, uploadDir: box.uploadDir, createdAt: "2026-07-20T12:00:00.000Z" });
    const verified = await verifyBundle(box.output);
    assert.equal(exported.manifest.workspace_id, WORKSPACE_ID);
    assert.ok(verified.manifest.tables.documents.rows >= 1);
    assert.equal(verified.manifest.tables.media_assets.rows, 1);
    assert.equal(verified.manifest.assets.length, 1);
    assert.equal(verified.manifest.assets[0].storage_key, `${WORKSPACE_ID}/proof.pdf`);
    assert.equal(readFileSync(path.join(box.output, verified.manifest.assets[0].file), "utf8"), "portable-object-contents");
    const media = JSON.parse(readFileSync(path.join(box.output, "tables", "media_assets.json"), "utf8"));
    assert.equal(media[0].storage_key, `${WORKSPACE_ID}/proof.pdf`);
    const documents = JSON.parse(readFileSync(path.join(box.output, "tables", "documents.json"), "utf8"));
    assert.ok(documents.some((document) => document.id === box.document.id));
  } finally { rmSync(box.directory, { recursive: true, force: true }); }
});

test("bundle verification rejects a changed table", async () => {
  const box = fixture();
  try {
    await exportBundle({ database: box.database, output: box.output, workspaceId: WORKSPACE_ID, uploadDir: box.uploadDir });
    writeFileSync(path.join(box.output, "tables", "documents.json"), "[]\n");
    await assert.rejects(() => verifyBundle(box.output), /Checksum mismatch for documents/);
  } finally { rmSync(box.directory, { recursive: true, force: true }); }
});

test("production configuration gate identifies a complete secret layout without exposing values", () => {
  const environment = {
    NODE_ENV: "production",
    FORMA_AUTH_MODE: "required",
    FORMA_DATA_BACKEND: "supabase",
    FORMA_PUBLIC_URL: "https://forma.example.com",
    FORMA_RATE_LIMIT_PER_MINUTE: "300",
    FORMA_CRON_SECRET: "c".repeat(32),
    FORMA_METRICS_SECRET: "m".repeat(32),
    FORMA_REQUEST_LOGS: "true",
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "publishable-value",
    SUPABASE_SERVICE_ROLE_KEY: "service-secret-value",
    SUPABASE_DB_URL: "postgresql://example.invalid/postgres",
    FORMA_AUTH_PROVIDERS: "email,google,azure",
    FORMA_EMAIL_PROVIDER: "resend",
    FORMA_RESEND_API_KEY: "resend-secret-value",
    FORMA_EMAIL_FROM: "Forma <billing@example.com>",
    FORMA_RESEND_WEBHOOK_SECRET: "resend-webhook-secret",
    FORMA_STRIPE_SECRET_KEY: "sk_live_secret-value",
    FORMA_STRIPE_WEBHOOK_SECRET: "whsec_secret-value",
    FORMA_PAYPAL_ENV: "live",
    FORMA_PAYPAL_CLIENT_ID: "paypal-client",
    FORMA_PAYPAL_CLIENT_SECRET: "paypal-secret",
    FORMA_PAYPAL_WEBHOOK_ID: "paypal-webhook",
    FORMA_ERROR_WEBHOOK_URL: "https://monitoring.example.com/errors",
    FORMA_ERROR_WEBHOOK_SECRET: "e".repeat(32),
  };
  const summary = summarizeReadiness(evaluateConfiguration(environment));
  assert.equal(summary.ready, true);
  assert.equal(summary.counts.blocker, 0);
  const serialized = JSON.stringify(summary);
  for (const secret of [environment.SUPABASE_SERVICE_ROLE_KEY, environment.FORMA_RESEND_API_KEY, environment.FORMA_PAYPAL_CLIENT_SECRET]) assert.equal(serialized.includes(secret), false);
});

test("production configuration gate fails closed on local defaults", () => {
  const summary = summarizeReadiness(evaluateConfiguration({ FORMA_AUTH_MODE: "disabled", FORMA_DATA_BACKEND: "sqlite" }));
  assert.equal(summary.ready, false);
  assert.ok(summary.counts.blocker > 10);
});
