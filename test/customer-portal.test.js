import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../server.js";

test("opaque portal links expose a sanitized document and accept a sent quote once", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "forma-portal-")); const app = createApp({ database: path.join(dir, "test.sqlite"), uploadDir: path.join(dir, "uploads") }); const store = app.locals.store;
  const quote = store.createDocument({ document_type: "quote", supplier: { name: "Forma", address: "Cape Town" }, customer: { name: "Acme", address: "Johannesburg" }, issue_date: "2026-07-19", due_date: "2026-08-18", items: [{ description: "Advisory", quantity: 1, unit_price_minor: 10000, tax_bps: 1500 }] }); store.finalizeDocument(quote.id);
  const token = "portal_token_with_at_least_32_characters_123"; store.savePortalLink(quote.id, { id: "portal-1", token_hash: createHash("sha256").update(token).digest("hex"), expires_at: "2027-07-19T00:00:00.000Z" });
  const server = app.listen(0, "127.0.0.1"); await new Promise((resolve) => server.once("listening", resolve)); const base = `http://127.0.0.1:${server.address().port}`; const headers = { "X-Forma-Portal-Token": token };
  try {
    const page = await fetch(`${base}/portal.html`); assert.equal(page.status, 200); assert.match(await page.text(), /Secure document portal/);
    const response = await fetch(`${base}/api/public/portal`, { headers }); const portal = (await response.json()).data; assert.equal(response.status, 200); assert.equal(portal.document.number, quote.number); assert.equal(portal.document.status, "sent"); assert.equal(JSON.stringify(portal).includes("token_hash"), false);
    const pdf = await fetch(`${base}/api/public/portal/pdf`, { headers }); assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");
    const accepted = await fetch(`${base}/api/public/portal/quote/accepted`, { method: "POST", headers }); assert.equal(accepted.status, 200); assert.equal((await accepted.json()).data.status, "accepted");
    const repeat = await fetch(`${base}/api/public/portal/quote/declined`, { method: "POST", headers }); assert.equal(repeat.status, 409);
    const invalid = await fetch(`${base}/api/public/portal`, { headers: { "X-Forma-Portal-Token": "invalid_token_that_is_long_enough_12345" } }); assert.equal(invalid.status, 404);
  } finally { await new Promise((resolve) => server.close(resolve)); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
