import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createStore } from "../db.js";
import { parseQuickCreate } from "../parser.js";
import { createApp } from "../server.js";

function sandbox() { const dir = mkdtempSync(path.join(tmpdir(), "moneyfy-shared-")); return { dir, store: createStore(path.join(dir, "test.sqlite")) }; }
function valid(number, overrides = {}) { return { number, document_title: "Tax Invoice", issue_date: "2026-07-11", due_date: "2026-08-10", currency: "ZAR", supplier: { name: "Moneyfy Studio", address: "88 Bree Street, Cape Town", vat_registered: true, vat_number: "4123456789" }, customer: { name: "Vertex Labs", email: "finance@vertex.co.za", address: "12 Loop Street, Cape Town", vat_registered: true, vat_number: "4780123456" }, items: [{ description: "Advisory", quantity: 2, unit_price_minor: 10000, discount_bps: 1000, tax_bps: 1500 }], ...overrides }; }
function dispose({ dir, store }) { store.close(); rmSync(dir, { recursive: true, force: true }); }

test("allocates independent annual invoice, quote, and receipt numbers", () => {
  const box = sandbox();
  try {
    const invoice = box.store.createDocument({ document_type: "invoice" });
    const quote = box.store.createDocument({ document_type: "quote" });
    const receipt = box.store.createDocument({ document_type: "receipt" });
    assert.match(invoice.number, /^INV-\d{4}-\d{5}$/);
    assert.match(quote.number, /^QUO-\d{4}-00001$/);
    assert.match(receipt.number, /^REC-\d{4}-00001$/);
    assert.notEqual(invoice.number, quote.number);
  } finally { dispose(box); }
});

test("first startup migrates legacy invoice rows without changing their identifiers", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "moneyfy-legacy-")); const file = path.join(dir, "legacy.sqlite");
  const db = new DatabaseSync(file); const created = "2026-07-11T00:00:00.000Z"; const legacy = valid("INV-2026-00999");
  db.exec("CREATE TABLE invoices (id TEXT PRIMARY KEY, number TEXT NOT NULL UNIQUE, status TEXT NOT NULL, customer_id TEXT, data_json TEXT NOT NULL, totals_json TEXT NOT NULL, snapshot_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finalized_at TEXT)");
  db.prepare("INSERT INTO invoices VALUES(?,?,?,?,?,?,?,?,?,?)").run("legacy-invoice", legacy.number, "finalized", null, JSON.stringify(legacy), JSON.stringify({ total_minor: 20700, lines: [] }), JSON.stringify(legacy), created, created, created); db.close();
  const store = createStore(file);
  try { const migrated = store.getInvoice("legacy-invoice"); assert.equal(migrated.number, "INV-2026-00999"); assert.equal(migrated.status, "finalized"); assert.match(store.createDraft().number, /^INV-\d{4}-01001$/); } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("accepted quotes convert once into an independent invoice", () => {
  const box = sandbox();
  try {
    const quote = box.store.createDocument({ ...valid(undefined, { document_title: "Quote", template_id: "executive", page_size: "LETTER" }), document_type: "quote" });
    box.store.finalizeDocument(quote.id);
    box.store.transitionDocument(quote.id, "accepted", "accepted");
    const invoice = box.store.convertQuote(quote.id);
    assert.equal(invoice.document_type, "invoice");
    assert.equal(invoice.source_document_id, quote.id);
    assert.equal(invoice.data.template_id, "executive");
    assert.equal(invoice.data.page_size, "LETTER");
    assert.equal(invoice.totals.total_minor, quote.totals.total_minor);
    assert.throws(() => box.store.convertQuote(quote.id), /already been converted/);
  } finally { dispose(box); }
});

test("partial payments issue a receipt and recalculate invoice balance", () => {
  const box = sandbox();
  try {
    const draft = box.store.createDraft();
    box.store.updateDraft(draft.id, valid(draft.number));
    box.store.finalize(draft.id);
    const partial = box.store.recordPayment(draft.id, { amount_minor: 5000, method: "EFT", reference: "PAY-1" });
    assert.equal(partial.receipt.document_type, "receipt");
    assert.equal(partial.receipt.status, "issued");
    assert.equal(partial.invoice.status, "partially_paid");
    assert.equal(partial.invoice.balance_due_minor, 15700);
    const paid = box.store.recordPayment(draft.id, { amount_minor: 15700, method: "EFT" });
    assert.equal(paid.invoice.status, "paid");
    assert.equal(paid.invoice.balance_due_minor, 0);
  } finally { dispose(box); }
});

test("document discount is applied after line discounts and before tax", () => {
  const box = sandbox();
  try {
    const document = box.store.createDocument({ ...valid(undefined, { document_discount_bps: 1000 }), document_type: "invoice" });
    assert.equal(document.totals.subtotal_minor, 20000);
    assert.equal(document.totals.line_discount_minor, 2000);
    assert.equal(document.totals.document_discount_minor, 1800);
    assert.equal(document.totals.tax_minor, 2430);
    assert.equal(document.totals.total_minor, 18630);
    assert.throws(() => box.store.createDocument({ ...valid(undefined, { document_discount_bps: 10001 }), document_type: "invoice" }), /document_discount_bps/);
  } finally { dispose(box); }
});

test("tax totals retain a separate breakdown for each rate", () => {
  const box = sandbox();
  try {
    const document = box.store.createDocument({ ...valid(undefined, { items: [{ description: "Taxable", quantity: 1, unit_price_minor: 10000, tax_bps: 1500, discount_bps: 0 }, { description: "Zero rated", quantity: 1, unit_price_minor: 8000, tax_bps: 0, discount_bps: 0 }] }), document_type: "invoice" });
    assert.deepEqual(document.totals.tax_breakdown, [{ tax_bps: 0, taxable_minor: 8000, tax_minor: 0 }, { tax_bps: 1500, taxable_minor: 10000, tax_minor: 1500 }]);
    assert.equal(document.totals.tax_minor, 1500); assert.equal(document.totals.total_minor, 19500);
  } finally { dispose(box); }
});

test("receipts require a payer and positive received amount before issue", () => {
  const box = sandbox();
  try {
    const empty = box.store.createDocument({ document_type: "receipt", customer: { name: "Acme" }, items: [] });
    assert.equal(empty.readiness.ready, false);
    assert.throws(() => box.store.finalizeDocument(empty.id), /not ready/);
    const receipt = box.store.createDocument({ document_type: "receipt", customer: { name: "Acme" }, payment_reference: "PAY-2026-1", items: [{ description: "Payment received", quantity: 1, unit_price_minor: 250000, tax_bps: 0, discount_bps: 0 }] });
    assert.equal(receipt.readiness.ready, true);
    assert.equal(box.store.finalizeDocument(receipt.id).status, "issued");
  } finally { dispose(box); }
});

test("recurring schedules create uniquely numbered invoice drafts and never repeat a run", () => {
  const box = sandbox();
  try {
    const source = box.store.createDocument({ ...valid(undefined, { terms_days: 14 }), document_type: "invoice" });
    const schedule = box.store.saveRecurringSchedule({ source_document_id: source.id, name: "Vertex monthly advisory", frequency: "monthly", next_run_on: "2026-01-31", ends_on: "2026-03-31" });
    assert.equal(schedule.active, true);
    assert.equal(schedule.data.customer.name, "Vertex Labs");
    const firstRun = box.store.runDueRecurringSchedules({ schedule_id: schedule.id, as_of: "2026-01-31" });
    assert.equal(firstRun.documents.length, 1);
    const firstInvoice = firstRun.documents[0];
    assert.equal(firstInvoice.document_type, "invoice");
    assert.equal(firstInvoice.status, "draft");
    assert.equal(firstInvoice.recurring_schedule_id, schedule.id);
    assert.equal(firstInvoice.data.issue_date, "2026-01-31");
    assert.equal(firstInvoice.data.due_date, "2026-02-14");
    assert.match(firstInvoice.number, /^INV-\d{4}-\d{5}$/);
    assert.equal(box.store.runDueRecurringSchedules({ schedule_id: schedule.id, as_of: "2026-01-31" }).documents.length, 0);
    const afterFirst = box.store.getRecurringSchedule(schedule.id);
    assert.equal(afterFirst.next_run_on, "2026-02-28");
    const catchup = box.store.runDueRecurringSchedules({ schedule_id: schedule.id, as_of: "2026-04-01" });
    assert.equal(catchup.documents.length, 2);
    const completed = box.store.getRecurringSchedule(schedule.id);
    assert.equal(completed.generated_count, 3);
    assert.equal(completed.active, false);
    assert.equal(completed.runs.length, 3);
    assert.equal(box.store.setRecurringScheduleActive(schedule.id, true).active, true);
    assert.equal(box.store.setRecurringScheduleActive(schedule.id, false).active, false);
  } finally { dispose(box); }
});

test("invoice reminders choose the latest due rule and record skipped catch-up steps", () => {
  const box = sandbox();
  try {
    const invoice = box.store.createDocument({ ...valid(undefined, { due_date: "2026-08-01" }), document_type: "invoice" });
    box.store.finalizeDocument(invoice.id, true);
    const due = box.store.listDueInvoiceReminders({ as_of: "2026-08-12" });
    assert.equal(due.length, 1);
    assert.equal(due[0].rule.id, "overdue_7");
    assert.equal(due[0].skipped_rules.length, 2);
    const claim = box.store.claimInvoiceReminder(due[0]);
    assert.equal(claim.claimed, true);
    const delivery = box.store.completeInvoiceReminderDelivery(claim.delivery.id, { provider_status: "accepted_mock" });
    assert.equal(delivery.status, "accepted_mock");
    assert.equal(box.store.listDueInvoiceReminders({ as_of: "2026-08-12" }).length, 0);
    assert.equal(box.store.listReminderDeliveries(invoice.id).length, 3);
    assert.equal(box.store.claimInvoiceReminder(due[0]).claimed, false);
  } finally { dispose(box); }
});

test("business settings persist and payment method list masks accounts", () => {
  const box = sandbox();
  try {
    assert.equal(box.store.saveBusinessProfile({ name: "Acme Billing", default_currency: "USD" }).default_currency, "USD");
    const method = box.store.savePaymentMethod({ name: "Main bank", details: { bank_name: "FNB", account_number: "62123456789" } });
    assert.equal(method.is_default, true);
    assert.match(box.store.listPaymentMethods().find((item) => item.id === method.id).details.account_number, /^\*+6789$/);
    assert.equal(box.store.getPaymentMethod(method.id, true).details.account_number, "62123456789");
    const alternate = box.store.savePaymentMethod({ name: "Card link", is_default: true, details: { instructions: "Pay by card" } });
    assert.equal(box.store.getPaymentMethod(method.id, true).is_default, false);
    assert.equal(box.store.getPaymentMethod(alternate.id, true).is_default, true);
    const document = box.store.createDocument({ document_type: "invoice" });
    assert.equal(document.data.payment_method_id, alternate.id);
    assert.equal(document.data.payment_method, "Card link");
    assert.equal(document.data.payment_details, "Pay by card");
    const customer = box.store.saveCustomer({ name: "Ledger Works", contact_name: "Ava Finance", email: "ap@ledgerworks.test", phone: "+27 21 555 0100", address: "1 Finance Way", registration_number: "2026/001234/07", notes: "Send statements monthly" });
    assert.equal(customer.contact_name, "Ava Finance"); assert.equal(customer.phone, "+27 21 555 0100"); assert.equal(customer.registration_number, "2026/001234/07"); assert.equal(customer.notes, "Send statements monthly");
    assert.equal(box.store.saveBrandingPreset({ name: "Executive", template_id: "executive" }).template_id, "executive");
  } finally { dispose(box); }
});

test("legacy Moneyfy business identity migrates without replacing custom profile fields", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "forma-branding-migration-"));
  const database = path.join(dir, "test.sqlite");
  let store = createStore(database);
  store.setting("business_profile", { name: "Moneyfy Studio", email: "billing@moneyfy.co.za", address: "Custom address", custom_field: "preserved" });
  store.close();
  store = createStore(database);
  try {
    assert.deepEqual(store.getBusinessProfile(), { name: "Forma Studio", email: "billing@forma.co.za", address: "Custom address", custom_field: "preserved", vat_registered: true, vat_number: "4123456789", default_currency: "ZAR", default_terms_days: 30 });
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("parser is deterministic for invoice, quote, receipt, currencies and ambiguity", () => {
  const quote = parseQuickCreate("Quote for Acme; 2 x Design @ R1,250.50; VAT 15%; due in 14 days");
  assert.equal(quote.document_type, "quote"); assert.equal(quote.customer.name, "Acme"); assert.equal(quote.items[0].unit_price_minor, 125050); assert.equal(quote.tax_bps, 1500); assert.equal(quote.due_in_days, 14);
  const invoice = parseQuickCreate("Invoice to Vertex; Consulting @ USD 1,200.00; discount 10%; due 2026-08-01", { defaultCurrency: "ZAR" });
  assert.equal(invoice.currency, "USD"); assert.equal(invoice.items[0].unit_price_minor, 120000); assert.equal(invoice.discount_bps, 1000); assert.equal(invoice.due_date, "2026-08-01");
  const receipt = parseQuickCreate("Receipt for Acme; received R500 cash");
  assert.equal(receipt.payment.amount_minor, 50000); assert.equal(receipt.payment.method, "cash");
  assert.ok(parseQuickCreate("Invoice maybe later", { defaultCurrency: "ZAR" }).warnings.length > 0);
});

test("quick-create parser recognises conjunction-separated items, VAT, receipts, and unknown segments", () => {
  const novaQuote = parseQuickCreate("Quote for Nova Studio; website design at R5,000; hosting 12x at R199 each; add 15% VAT");
  assert.equal(novaQuote.document_type, "quote");
  assert.equal(novaQuote.customer.name, "Nova Studio");
  assert.equal(novaQuote.currency, "ZAR");
  assert.equal(novaQuote.tax_bps, 1500);
  assert.deepEqual(novaQuote.items.map(({ description, quantity, unit_price_minor }) => ({ description, quantity, unit_price_minor })), [
    { description: "website design", quantity: 1, unit_price_minor: 500000 },
    { description: "hosting", quantity: 12, unit_price_minor: 19900 }
  ]);

  const invoice = parseQuickCreate("Invoice to Vertex; 2x website design at 150 each and 5x content writing at 305 each");
  assert.deepEqual(invoice.items.map(({ description, quantity, unit_price_minor }) => ({ description, quantity, unit_price_minor })), [
    { description: "website design", quantity: 2, unit_price_minor: 15000 },
    { description: "content writing", quantity: 5, unit_price_minor: 30500 }
  ]);

  const receipt = parseQuickCreate("Receipt; payment of R2,500 by bank transfer");
  assert.deepEqual(receipt.payment, { amount_minor: 250000, method: "bank transfer" });

  const consulting = parseQuickCreate("Invoice to Acme; 3 hours consulting @ 800 per hour, due in 30 days");
  assert.deepEqual(consulting.items.map(({ description, quantity, unit_price_minor }) => ({ description, quantity, unit_price_minor })), [
    { description: "consulting", quantity: 3, unit_price_minor: 80000 }
  ]);
  assert.equal(consulting.due_in_days, 30);

  const namedItem = parseQuickCreate("Invoice to Acme; Research and Development at €1,250.50; unclear instructions");
  assert.equal(namedItem.currency, "EUR");
  assert.equal(namedItem.items[0].description, "Research and Development");
  assert.deepEqual(namedItem.unparsed_segments, ["unclear instructions"]);
  assert.ok(namedItem.warnings.includes("Unparsed segment: unclear instructions"));
});

test("generic APIs render all template/page/type combinations and mock sends are idempotent", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "moneyfy-api-shared-"));
  const app = createApp({ database: path.join(dir, "test.sqlite"), uploadDir: path.join(dir, "uploads") }); const server = app.listen(0, "127.0.0.1"); await new Promise((resolve) => server.once("listening", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const type of ["invoice", "quote", "receipt"]) for (const template of ["classic", "minimal", "bold", "executive", "compact"]) for (const page_size of ["A4", "LETTER"]) {
      const create = await fetch(`${base}/api/documents`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...valid(undefined, { document_title: type, template_id: template, page_size }), document_type: type }) });
      assert.equal(create.status, 201); const document = (await create.json()).data;
      const pdf = await fetch(`${base}/api/documents/${document.id}/pdf`); const bytes = new Uint8Array(await pdf.arrayBuffer());
      assert.equal(pdf.status, 200); assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-");
    }
    const document = (await (await fetch(`${base}/api/documents`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...valid(undefined), document_type: "invoice" }) })).json()).data;
    let response = await fetch(base + "/api/recurring-schedules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source_document_id: document.id, name: "API monthly invoice", frequency: "monthly", next_run_on: "2026-07-11" }) });
    assert.equal(response.status, 201); const recurring = (await response.json()).data;
    assert.equal(recurring.data.customer.name, "Vertex Labs");
    response = await fetch(base + "/api/recurring-schedules/run-due", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ as_of: "2026-07-12" }) });
    assert.equal(response.status, 200); const recurringRun = (await response.json()).data;
    assert.equal(recurringRun.documents.length, 1);
    assert.equal(recurringRun.documents[0].recurring_schedule_id, recurring.id);
    response = await fetch(base + "/api/recurring-schedules/" + recurring.id + "/pause", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal((await response.json()).data.active, false);
    response = await fetch(base + "/api/recurring-schedules/" + recurring.id + "/resume", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal((await response.json()).data.active, true);
    const unsafePayload = valid(undefined); unsafePayload.customer.name = "=Formula";
    await fetch(base + "/api/documents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...unsafePayload, document_type: "invoice" }) });
    response = await fetch(base + "/api/exports/receivables.csv?document_type=invoice");
    assert.equal(response.status, 200); assert.match(response.headers.get("content-type"), /text\/csv/);
    assert.match(response.headers.get("content-disposition"), /attachment/);
    const csv = await response.text();
    assert.match(csv, /"Document number"/); assert.match(csv, /"'=Formula"/);
    response = await fetch(`${base}/api/documents/${document.id}/email-drafts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ purpose: "invoice_send" }) });
    assert.equal(response.status, 200); const renderedDraft = (await response.json()).data;
    assert.match(renderedDraft.subject, new RegExp(document.number));
    assert.doesNotMatch(renderedDraft.subject, /{{document_number}}/);
    response = await fetch(`${base}/api/documents/${document.id}/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ request_key: "one" }) }); const first = (await response.json()).data;
    assert.equal(first.provider_status, "accepted_mock");
    response = await fetch(`${base}/api/documents/${document.id}/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ request_key: "one" }) }); const second = (await response.json()).data;
    assert.equal(second.id, first.id); assert.equal(second.idempotent, true);
    response = await fetch(`${base}/api/documents/${document.id}/email-history`); const history = (await response.json()).data;
    assert.equal(history.length, 1); assert.equal(history[0].provider_status, "accepted_mock"); assert.equal(history[0].provider_message_id, "mock-one");
    response = await fetch(`${base}/api/email-templates/invoice_send`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subject: "{{unknown}}", text: "x", html: "x" }) });
    assert.equal(response.status, 422);
    response = await fetch(base + "/api/email-templates"); const templates = (await response.json()).data;
    assert.ok(templates.some((template) => template.purpose === "invoice_corrected"));
    response = await fetch(`${base}/api/documents/${document.id}/email-drafts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ purpose: "invoice_corrected" }) });
    assert.match((await response.json()).data.subject, /Corrected invoice/);
    response = await fetch(base + "/api/email-templates/invoice_corrected", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subject: "Changed", text: "Changed", html: "<p>Changed</p>" }) });
    assert.equal(response.status, 200);
    response = await fetch(base + "/api/email-templates/invoice_corrected/restore-default", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.match((await response.json()).data.subject, /Corrected invoice/);
    const reminderDocument = (await (await fetch(`${base}/api/documents`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...valid(undefined, { due_date: "2026-07-01" }), document_type: "invoice" }) })).json()).data;
    response = await fetch(`${base}/api/documents/${reminderDocument.id}/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ request_key: "initial-send" }) });
    assert.equal(response.status, 202);
    response = await fetch(`${base}/api/reminders/due?as_of=2026-07-10`);
    const dueReminders = (await response.json()).data;
    assert.equal(dueReminders.length, 1);
    assert.equal(dueReminders[0].rule.id, "overdue_7");
    response = await fetch(`${base}/api/reminders/run-due`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ as_of: "2026-07-10" }) });
    assert.equal(response.status, 202);
    const reminderRun = (await response.json()).data;
    assert.equal(reminderRun.reminders.length, 1);
    assert.equal(reminderRun.reminders[0].delivery.status, "accepted_mock");
    const overdue = (await (await fetch(`${base}/api/documents/${reminderDocument.id}`)).json()).data;
    assert.equal(overdue.status, "overdue");
    response = await fetch(`${base}/api/reminders/run-due`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ as_of: "2026-07-10" }) });
    assert.equal((await response.json()).data.reminders.length, 0);

    const failedDocument = (await (await fetch(`${base}/api/documents`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...valid(undefined), document_type: "invoice" }) })).json()).data;
    const originalProvider = process.env.MONEYFY_EMAIL_PROVIDER;
    process.env.MONEYFY_EMAIL_PROVIDER = "disabled";
    try {
      response = await fetch(`${base}/api/documents/${failedDocument.id}/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ request_key: "disabled-provider" }) });
      assert.equal(response.status, 200);
      const failedAttempt = (await response.json()).data;
      assert.equal(failedAttempt.provider_status, "disabled");
      const unchanged = (await (await fetch(`${base}/api/documents/${failedDocument.id}`)).json()).data;
      assert.equal(unchanged.status, "draft");
    } finally { if (originalProvider === undefined) delete process.env.MONEYFY_EMAIL_PROVIDER; else process.env.MONEYFY_EMAIL_PROVIDER = originalProvider; }

    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    response = await fetch(`${base}/api/business-logo`, { method: "POST", headers: { "Content-Type": "image/png", "X-File-Name": "forma.png" }, body: png });
    assert.equal(response.status, 201); const uploaded = (await response.json()).data;
    assert.match(uploaded.asset.url, /^\/api\/assets\//); assert.equal(uploaded.profile.logo_url, uploaded.asset.url);
    response = await fetch(`${base}${uploaded.asset.url}`); assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "image/png");
    const brandedDocument = (await (await fetch(`${base}/api/documents`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...valid(undefined, { supplier: { ...valid().supplier, logo_url: uploaded.asset.url } }), document_type: "invoice" }) })).json()).data;
    response = await fetch(`${base}/api/documents/${brandedDocument.id}/pdf`);
    assert.equal(response.status, 200);
    const brandedPdf = Buffer.from(await response.arrayBuffer()).toString("latin1");
    assert.match(brandedPdf, /\/Subtype \/Image/);
    assert.match(brandedPdf, /\/Width 1\b/);
    assert.match(brandedPdf, /\/Height 1\b/);

    response = await fetch(base);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<img src="\/VKT-logo\.png" alt="Forma" class="brand-logo">/);
    response = await fetch(`${base}/VKT-logo.png`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    response = await fetch(`${base}/api/business-logo`, { method: "POST", headers: { "Content-Type": "image/png" }, body: Buffer.from("not-a-png") });
    assert.equal(response.status, 422);

    const attachmentDocument = (await (await fetch(`${base}/api/documents`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...valid(undefined), document_type: "invoice" }) })).json()).data;
    response = await fetch(`${base}/api/documents/${attachmentDocument.id}/attachments`, { method: "POST", headers: { "Content-Type": "application/pdf", "X-File-Name": "scope.pdf" }, body: Buffer.from("%PDF-1.7\nattachment") });
    assert.equal(response.status, 201); const attachmentUpload = (await response.json()).data;
    assert.equal(attachmentUpload.document.data.attachments.length, 1);
    const uploadedAttachment = attachmentUpload.attachment;
    response = await fetch(`${base}${uploadedAttachment.url}`); assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "application/pdf");
    response = await fetch(`${base}/api/documents/${attachmentDocument.id}/attachments/${uploadedAttachment.asset_id}`, { method: "DELETE" });
    assert.equal(response.status, 200); assert.equal((await response.json()).data.data.attachments.length, 0);
    response = await fetch(`${base}${uploadedAttachment.url}`); assert.equal(response.status, 404);
  } finally { await new Promise((resolve) => server.close(resolve)); app.locals.store.close(); rmSync(dir, { recursive: true, force: true }); }
});
