import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import { createObservability } from "../observability.js";
import { agingCsv, agingReport, collectionForecast, collectionForecastCsv, taxCsv, taxReport } from "../reporting.js";
import { createApp } from "../server.js";

const documents = [{ id: "invoice-1", document_type: "invoice", number: "=DANGEROUS", status: "overdue", balance_due_minor: 11500, amount_paid_minor: 0, data: { issue_date: "2026-05-01", due_date: "2026-05-31", currency: "ZAR", customer: { name: "Acme" } }, totals: { total_minor: 11500, tax_minor: 1500, tax_breakdown: [{ tax_bps: 1500, taxable_minor: 10000, tax_minor: 1500 }] } }];

test("observability exports bounded metrics and signed sanitized errors", async () => {
  let sent; const fetchImpl = async (url, options) => { sent = { url, options }; return new Response("", { status: 202 }); }; const monitor = createObservability({ environment: { NODE_ENV: "production", FORMA_ERROR_WEBHOOK_URL: "https://monitor.test/errors", FORMA_ERROR_WEBHOOK_SECRET: "secret" }, fetchImpl });
  monitor.recordRequest(200, 12.5); monitor.recordError("DATABASE_FAILED", 500); assert.match(monitor.prometheus(), /forma_http_requests_total\{status_family="2xx"\} 1/);
  assert.equal(await monitor.notifyError({ request_id: "request-1", method: "POST", route: "/api/documents/:id", status: 500, code: "DATABASE_FAILED", message: "must not leave process" }), true);
  assert.doesNotMatch(sent.options.body, /must not leave process|customer|document_id/); assert.equal(sent.options.headers["X-Forma-Signature"], `sha256=${createHmac("sha256", "secret").update(sent.options.body).digest("hex")}`);
});

test("aging and tax reports preserve currency, buckets, tax rates, and CSV safety", () => {
  const aging = agingReport(documents, { asOf: "2026-07-19" }); assert.equal(aging.rows[0].bucket, "31-60 days"); assert.equal(aging.totals[0].total_minor, 11500); assert.match(agingCsv(aging), /"'=DANGEROUS"/);
  const tax = taxReport(documents, { from: "2026-01-01", to: "2026-12-31" }); assert.deepEqual(tax.totals[0], { currency: "ZAR", tax_bps: 1500, taxable_minor: 10000, tax_minor: 1500 }); assert.match(taxCsv(tax), /15\.00/);
  const forecast = collectionForecast(documents, { asOf: "2026-07-19" }); assert.equal(forecast.rows[0].bucket, "Overdue"); assert.equal(forecast.totals[0].buckets.Overdue, 11500); assert.match(collectionForecastCsv(forecast), /Expected collection/);
});

test("runtime exposes hardened readiness and downloadable finance reports", async () => {
  const previousMetrics = process.env.FORMA_METRICS_SECRET; process.env.FORMA_METRICS_SECRET = "metrics-test-secret";
  const dir = mkdtempSync(path.join(tmpdir(), "forma-runtime-")); const app = createApp({ database: path.join(dir, "test.sqlite"), uploadDir: path.join(dir, "uploads") }); const store = app.locals.store;
  const draft = store.createDocument({ document_type: "invoice", supplier: { name: "Forma", address: "Cape Town" }, customer: { name: "Acme", address: "Johannesburg" }, issue_date: "2026-05-01", due_date: "2026-05-31", items: [{ description: "Advisory", quantity: 1, unit_price_minor: 10000, tax_bps: 1500 }] }); store.finalizeDocument(draft.id);
  const server = app.listen(0, "127.0.0.1"); await new Promise((resolve) => server.once("listening", resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ready = await fetch(`${base}/api/ready`); assert.equal(ready.status, 200); assert.equal((await ready.json()).ready, true); assert.equal(ready.headers.get("x-content-type-options"), "nosniff"); assert.match(ready.headers.get("content-security-policy"), /frame-ancestors 'none'/); assert.ok(ready.headers.get("x-request-id"));
    const aging = await fetch(`${base}/api/reports/aging.csv?as_of=2026-07-19`); assert.equal(aging.status, 200); assert.match(await aging.text(), /31-60 days/);
    const tax = await fetch(`${base}/api/reports/tax.csv`); assert.equal(tax.status, 200); assert.match(await tax.text(), /15\.00/);
    const forecast = await fetch(`${base}/api/reports/collection-forecast.csv?as_of=2026-07-19`); assert.equal(forecast.status, 200); assert.match(await forecast.text(), /Overdue/);
    const pdf = await fetch(`${base}/api/reports/receivables.pdf?as_of=2026-07-19`); assert.equal(pdf.status, 200); assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");
    assert.equal((await fetch(`${base}/api/internal/metrics`)).status, 401); const metrics = await fetch(`${base}/api/internal/metrics`, { headers: { Authorization: "Bearer metrics-test-secret" } }); assert.equal(metrics.status, 200); assert.match(await metrics.text(), /forma_http_requests_total/);
    store.saveProviderPayloadRetentionPolicy({ payload_days: 7, legal_hold: false }); store.db.prepare("INSERT INTO provider_webhook_events(provider,event_id,event_type,payload_json,processed_at) VALUES('stripe','old-event','test','{\"secret\":true}','2026-01-01T00:00:00.000Z')").run(); assert.equal(store.redactProviderPayloads({ as_of: "2026-07-19" }).redacted, 1); assert.deepEqual(JSON.parse(store.db.prepare("SELECT payload_json FROM provider_webhook_events WHERE event_id='old-event'").get().payload_json), { redacted: true });
  } finally { await new Promise((resolve) => server.close(resolve)); store.close(); if (previousMetrics === undefined) delete process.env.FORMA_METRICS_SECRET; else process.env.FORMA_METRICS_SECRET = previousMetrics; rmSync(dir, { recursive: true, force: true }); }
});
