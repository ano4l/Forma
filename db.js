import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { DEFAULT_EMAIL_TEMPLATES, PURPOSES, renderTemplate, validateTemplate } from "./email.js";
import { templateFor } from "./templates.js";

const now = () => new Date().toISOString();
const today = () => now().slice(0, 10);
const json = (value, fallback = {}) => { try { return JSON.parse(value); } catch { return fallback; } };
const TYPES = ["invoice", "quote", "receipt"];
const RECURRING_FREQUENCIES = ["weekly", "monthly", "quarterly", "yearly"];
const STATUS = {
  quote: ["draft", "sent", "accepted", "declined", "expired", "converted"],
  invoice: ["draft", "finalized", "sent", "partially_paid", "paid", "overdue", "void", "refunded"],
  receipt: ["draft", "issued", "void"]
};
const DEFAULT_PROFILE = {
  name: "Forma Studio", email: "billing@forma.co.za", address: "88 Bree Street, Cape Town, 8001",
  vat_registered: true, vat_number: "4123456789", default_currency: "ZAR", default_terms_days: 30
};
const DEFAULT_PREFIXES = { invoice: "INV", quote: "QUO", receipt: "REC" };
const DEFAULT_REMINDER_RULES = [
  { id: "before_due_7", label: "7 days before due", offset_days: -7, purpose: "invoice_reminder", active: true },
  { id: "due_today", label: "On due date", offset_days: 0, purpose: "invoice_reminder", active: true },
  { id: "overdue_7", label: "7 days overdue", offset_days: 7, purpose: "invoice_overdue", active: true }
];

function error(message, status = 422, code = "VALIDATION_ERROR", details) {
  return Object.assign(new Error(message), { status, code, details });
}

function assertType(type) { if (!TYPES.includes(type)) throw error("document_type must be invoice, quote, or receipt"); }
function assertStatus(type, status) { if (!STATUS[type].includes(status)) throw error(`Invalid ${type} status '${status}'`); }
function dateOnly(value, field) {
  const input = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input) || Number.isNaN(new Date(`${input}T12:00:00Z`).getTime())) throw error(`${field} must be a valid YYYY-MM-DD date`);
  return input;
}
function addDays(value, days) { const date = new Date(`${dateOnly(value, "date")}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); }
function daysBetween(later, earlier) { return Math.round((new Date(`${dateOnly(later, "date")}T12:00:00Z`) - new Date(`${dateOnly(earlier, "date")}T12:00:00Z`)) / 86400000); }
function addMonths(value, months) {
  const [year, month, day] = dateOnly(value, "date").split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month - 1 + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month - 1 + months, Math.min(day, lastDay), 12)).toISOString().slice(0, 10);
}
function nextRecurringDate(value, frequency) {
  if (frequency === "weekly") return addDays(value, 7);
  if (frequency === "monthly") return addMonths(value, 1);
  if (frequency === "quarterly") return addMonths(value, 3);
  if (frequency === "yearly") return addMonths(value, 12);
  throw error("frequency must be weekly, monthly, quarterly, or yearly");
}
function asMinor(value, field, { allowZero = true } = {}) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || !Number.isInteger(Math.round(amount)) || amount < 0 || (!allowZero && amount === 0)) throw error(`${field} must be a ${allowZero ? "non-negative" : "positive"} integer minor-unit amount`);
  return Math.round(amount);
}

export function isPristineTrailingItem(item = {}) {
  return !item.product_id && !String(item.description || "").trim() && Number(item.quantity) === 1
    && (Number(item.unit_price_minor) || 0) === 0 && Number(item.tax_bps) === 1500 && (Number(item.discount_bps) || 0) === 0;
}
export function withoutPristineTrailingItems(data = {}) {
  const items = Array.isArray(data.items) ? [...data.items] : [];
  while (items.length && isPristineTrailingItem(items.at(-1))) items.pop();
  return { ...data, items };
}
export function calculateTotals(data = {}) {
  const lines = withoutPristineTrailingItems(data).items.map((item) => {
    const quantity = Math.max(0, Number(item.quantity) || 0);
    const unitPriceMinor = Math.max(0, Math.round(Number(item.unit_price_minor) || 0));
    const discountBps = Math.min(10000, Math.max(0, Math.round(Number(item.discount_bps) || 0)));
    const taxBps = Math.min(10000, Math.max(0, Math.round(Number(item.tax_bps) || 0)));
    const grossMinor = Math.round(quantity * unitPriceMinor);
    const discountMinor = Math.round(grossMinor * discountBps / 10000);
    const taxableMinor = grossMinor - discountMinor;
    return { ...item, quantity, unit_price_minor: unitPriceMinor, discount_bps: discountBps, tax_bps: taxBps, gross_minor: grossMinor, discount_minor: discountMinor, taxable_minor: taxableMinor };
  });
  const subtotal_minor = lines.reduce((sum, line) => sum + line.gross_minor, 0);
  const line_discount_minor = lines.reduce((sum, line) => sum + line.discount_minor, 0);
  const taxable_before_document_discount_minor = lines.reduce((sum, line) => sum + line.taxable_minor, 0);
  const document_discount_bps = Math.min(10000, Math.max(0, Math.round(Number(data.document_discount_bps) || 0)));
  const document_discount_minor = Math.round(taxable_before_document_discount_minor * document_discount_bps / 10000);
  let allocated_document_discount_minor = 0;
  const finalizedLines = lines.map((line, index) => {
    const remaining = document_discount_minor - allocated_document_discount_minor;
    const allocation = index === lines.length - 1 ? remaining : Math.min(remaining, Math.round(document_discount_minor * line.taxable_minor / Math.max(1, taxable_before_document_discount_minor)));
    allocated_document_discount_minor += allocation;
    const taxable_after_document_discount_minor = line.taxable_minor - allocation;
    const tax_minor = Math.round(taxable_after_document_discount_minor * line.tax_bps / 10000);
    return { ...line, document_discount_minor: allocation, taxable_after_document_discount_minor, tax_minor, total_minor: taxable_after_document_discount_minor + tax_minor };
  });
  const discount_minor = line_discount_minor + document_discount_minor;
  const tax_minor = finalizedLines.reduce((sum, line) => sum + line.tax_minor, 0);
  const tax_breakdown = Object.values(finalizedLines.reduce((groups, line) => { const key = String(line.tax_bps); const group = groups[key] ||= { tax_bps: line.tax_bps, taxable_minor: 0, tax_minor: 0 }; group.taxable_minor += line.taxable_after_document_discount_minor; group.tax_minor += line.tax_minor; return groups; }, {})).sort((a, b) => a.tax_bps - b.tax_bps);
  const shipping_minor = Math.max(0, Math.round(Number(data.shipping_minor) || 0));
  return { lines: finalizedLines, subtotal_minor, line_discount_minor, document_discount_bps, document_discount_minor, discount_minor, tax_minor, tax_breakdown, shipping_minor, total_minor: subtotal_minor - discount_minor + tax_minor + shipping_minor };
}
export function readiness(data = {}, totals = calculateTotals(data), documentType = "invoice") {
  const normalized = withoutPristineTrailingItems(data); const calculated = calculateTotals(normalized);
  if (documentType === "receipt") { const checks = [["payer", "Customer or related invoice", Boolean(data.customer?.name || data.receipt_for)], ["amount", "Positive amount received", calculated.total_minor > 0 && calculated.lines.some((line) => line.quantity > 0 && line.unit_price_minor > 0)]].map(([key, label, complete]) => ({ key, label, complete })); return { ready: checks.every((check) => check.complete), checks }; }
  const supplier = data.supplier || {}; const customer = data.customer || {}; const items = calculated.lines;
  const checks = [
    ["document_title", "Document title", Boolean(data.document_title)], ["supplier", "Supplier identity and address", Boolean(supplier.name && supplier.address)],
    ["supplier_vat", "Supplier VAT number", !supplier.vat_registered || Boolean(supplier.vat_number)], ["customer", "Customer identity and address", Boolean(customer.name && customer.address)],
    ["recipient_vat", "Recipient VAT number, when applicable", !customer.vat_registered || Boolean(customer.vat_number)], ["number_date", "Serial number and issue date", Boolean(data.number && data.issue_date)],
    ["items", "At least one valid line item", items.length > 0 && items.every((item) => item.description?.trim() && item.quantity > 0 && item.unit_price_minor >= 0)], ["value", "Value, tax and total calculated", calculated.total_minor >= 0]
  ].map(([key, label, complete]) => ({ key, label, complete }));
  return { ready: checks.every((check) => check.complete), checks };
}

export function createStore(filename = "moneyfy.sqlite") {
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS customers (id TEXT PRIMARY KEY, name TEXT NOT NULL, contact_name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT 'South Africa', vat_number TEXT NOT NULL DEFAULT '', registration_number TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', vat_registered INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'ZAR', terms_days INTEGER NOT NULL DEFAULT 30, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', unit_price_minor INTEGER NOT NULL DEFAULT 0, tax_bps INTEGER NOT NULL DEFAULT 1500, currency TEXT NOT NULL DEFAULT 'ZAR', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS invoice_sequences (year INTEGER PRIMARY KEY, value INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, number TEXT NOT NULL UNIQUE, status TEXT NOT NULL, customer_id TEXT, data_json TEXT NOT NULL, totals_json TEXT NOT NULL, snapshot_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finalized_at TEXT);
    CREATE TABLE IF NOT EXISTS audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id TEXT NOT NULL, type TEXT NOT NULL, detail_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, document_type TEXT NOT NULL CHECK(document_type IN ('invoice','quote','receipt')), number TEXT NOT NULL UNIQUE, number_year INTEGER NOT NULL, status TEXT NOT NULL, customer_id TEXT, source_document_id TEXT, recurring_schedule_id TEXT, data_json TEXT NOT NULL, totals_json TEXT NOT NULL, snapshot_json TEXT, amount_paid_minor INTEGER NOT NULL DEFAULT 0, balance_due_minor INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, issued_at TEXT, finalized_at TEXT, UNIQUE(document_type, number_year, number));
    CREATE TABLE IF NOT EXISTS document_sequences (document_type TEXT NOT NULL, year INTEGER NOT NULL, value INTEGER NOT NULL, PRIMARY KEY(document_type, year));
    CREATE TABLE IF NOT EXISTS document_audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL, type TEXT NOT NULL, detail_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS payments (id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL, receipt_id TEXT, amount_minor INTEGER NOT NULL CHECK(amount_minor > 0), method TEXT NOT NULL, reference TEXT NOT NULL DEFAULT '', received_date TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, FOREIGN KEY(invoice_id) REFERENCES documents(id), FOREIGN KEY(receipt_id) REFERENCES documents(id));
    CREATE TABLE IF NOT EXISTS payment_methods (id TEXT PRIMARY KEY, name TEXT NOT NULL, method_type TEXT NOT NULL DEFAULT 'bank_transfer', details_json TEXT NOT NULL DEFAULT '{}', active INTEGER NOT NULL DEFAULT 1, is_default INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS branding_presets (id TEXT PRIMARY KEY, name TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS email_templates (purpose TEXT PRIMARY KEY, subject TEXT NOT NULL, text TEXT NOT NULL, html TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS media_assets (id TEXT PRIMARY KEY, storage_key TEXT NOT NULL UNIQUE, filename TEXT NOT NULL, content_type TEXT NOT NULL, byte_size INTEGER NOT NULL CHECK(byte_size >= 0), created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS email_delivery_attempts (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, request_key TEXT NOT NULL, recipients_json TEXT NOT NULL, template_purpose TEXT NOT NULL, provider TEXT NOT NULL, provider_status TEXT NOT NULL, provider_message_id TEXT, provider_error TEXT, rendered_json TEXT NOT NULL, next_retry_at TEXT, updated_at TEXT, created_at TEXT NOT NULL, UNIQUE(document_id, request_key));
    CREATE TABLE IF NOT EXISTS provider_webhook_events (provider TEXT NOT NULL, event_id TEXT NOT NULL, event_type TEXT NOT NULL, object_id TEXT, payload_json TEXT NOT NULL, processed_at TEXT NOT NULL, PRIMARY KEY(provider,event_id));
    CREATE TABLE IF NOT EXISTS email_suppressions (email TEXT PRIMARY KEY, reason TEXT NOT NULL, provider TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS payment_checkouts (id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL, provider TEXT NOT NULL CHECK(provider IN ('stripe','paypal')), provider_checkout_id TEXT, provider_payment_id TEXT, request_key TEXT NOT NULL UNIQUE, amount_minor INTEGER NOT NULL CHECK(amount_minor > 0), currency TEXT NOT NULL, status TEXT NOT NULL, checkout_url TEXT, provider_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, paid_at TEXT, UNIQUE(provider,provider_checkout_id), FOREIGN KEY(invoice_id) REFERENCES documents(id));
    CREATE TABLE IF NOT EXISTS document_portal_links (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, revoked_at TEXT, last_viewed_at TEXT, created_at TEXT NOT NULL, FOREIGN KEY(document_id) REFERENCES documents(id));
    CREATE TABLE IF NOT EXISTS reminder_rules (id TEXT PRIMARY KEY, label TEXT NOT NULL, offset_days INTEGER NOT NULL, purpose TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS document_reminder_deliveries (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, rule_id TEXT NOT NULL, due_date TEXT NOT NULL, scheduled_for TEXT NOT NULL, attempt_id TEXT, status TEXT NOT NULL, provider_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(document_id, rule_id, due_date), FOREIGN KEY(document_id) REFERENCES documents(id), FOREIGN KEY(rule_id) REFERENCES reminder_rules(id), FOREIGN KEY(attempt_id) REFERENCES email_delivery_attempts(id));
    CREATE TABLE IF NOT EXISTS recurring_schedules (id TEXT PRIMARY KEY, source_document_id TEXT, name TEXT NOT NULL, frequency TEXT NOT NULL CHECK(frequency IN ('weekly','monthly','quarterly','yearly')), next_run_on TEXT NOT NULL, ends_on TEXT, active INTEGER NOT NULL DEFAULT 1, data_json TEXT NOT NULL, last_run_on TEXT, generated_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS recurring_schedule_runs (id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, run_date TEXT NOT NULL, document_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, UNIQUE(schedule_id, run_date), FOREIGN KEY(schedule_id) REFERENCES recurring_schedules(id), FOREIGN KEY(document_id) REFERENCES documents(id));`);

  const setting = (key, value) => db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value));
  const getSetting = (key, fallback) => { const row = db.prepare("SELECT value FROM settings WHERE key=?").get(key); return row ? json(row.value, fallback) : fallback; };
  const columns = db.prepare("PRAGMA table_info(invoices)").all().map((column) => column.name);
  const documentColumns = db.prepare("PRAGMA table_info(documents)").all().map((column) => column.name);
  if (!documentColumns.includes("recurring_schedule_id")) db.exec("ALTER TABLE documents ADD COLUMN recurring_schedule_id TEXT");
  const customerColumns = db.prepare("PRAGMA table_info(customers)").all().map((column) => column.name);
  for (const [name, definition] of [["contact_name", "TEXT NOT NULL DEFAULT ''"], ["phone", "TEXT NOT NULL DEFAULT ''"], ["registration_number", "TEXT NOT NULL DEFAULT ''"], ["notes", "TEXT NOT NULL DEFAULT ''"]]) if (!customerColumns.includes(name)) db.exec(`ALTER TABLE customers ADD COLUMN ${name} ${definition}`);
  const emailAttemptColumns = db.prepare("PRAGMA table_info(email_delivery_attempts)").all().map((column) => column.name);
  if (!emailAttemptColumns.includes("provider_error")) db.exec("ALTER TABLE email_delivery_attempts ADD COLUMN provider_error TEXT");
  if (!emailAttemptColumns.includes("next_retry_at")) db.exec("ALTER TABLE email_delivery_attempts ADD COLUMN next_retry_at TEXT");
  if (!emailAttemptColumns.includes("updated_at")) db.exec("ALTER TABLE email_delivery_attempts ADD COLUMN updated_at TEXT");
  const paymentMethodColumns = db.prepare("PRAGMA table_info(payment_methods)").all().map((column) => column.name);
  if (!paymentMethodColumns.includes("is_default")) db.exec("ALTER TABLE payment_methods ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0");
  if (!db.prepare("SELECT 1 FROM payment_methods WHERE active=1 AND is_default=1 LIMIT 1").get()) db.prepare("UPDATE payment_methods SET is_default=1 WHERE id=(SELECT id FROM payment_methods WHERE active=1 ORDER BY name LIMIT 1)").run();

  function migrateLegacyInvoices() {
    if (!columns.length) return;
    const legacy = db.prepare("SELECT * FROM invoices").all();
    for (const row of legacy) {
      const exists = db.prepare("SELECT id FROM documents WHERE id=?").get(row.id); if (exists) continue;
      const data = json(row.data_json); const totals = json(row.totals_json, calculateTotals(data)); const yearMatch = String(row.number).match(/-(\d{4})-/);
      const year = Number(yearMatch?.[1]) || new Date(row.created_at || now()).getFullYear();
      db.prepare("INSERT INTO documents(id,document_type,number,number_year,status,customer_id,data_json,totals_json,snapshot_json,amount_paid_minor,balance_due_minor,created_at,updated_at,issued_at,finalized_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(row.id, "invoice", row.number, year, row.status, row.customer_id, JSON.stringify(normalizeData(data, "invoice", row.number)), JSON.stringify(totals), row.snapshot_json, 0, totals.total_minor || 0, row.created_at, row.updated_at, row.finalized_at, row.finalized_at);
      const sequence = Number(String(row.number).match(/(\d+)(?!.*\d)/)?.[1]) || 0;
      const current = db.prepare("SELECT value FROM document_sequences WHERE document_type='invoice' AND year=?").get(year);
      if (!current || current.value < sequence) db.prepare("INSERT INTO document_sequences(document_type,year,value) VALUES('invoice',?,?) ON CONFLICT(document_type,year) DO UPDATE SET value=MAX(value,excluded.value)").run(year, sequence);
    }
  }

  function getBusinessProfile() { return getSetting("business_profile", getSetting("supplier", DEFAULT_PROFILE)); }
  function saveBusinessProfile(input = {}) { const profile = { ...DEFAULT_PROFILE, ...getBusinessProfile(), ...input, default_currency: String(input.default_currency || getBusinessProfile().default_currency || "ZAR").toUpperCase() }; setting("business_profile", profile); setting("supplier", profile); return profile; }
  function prefixes() { return { ...DEFAULT_PREFIXES, ...getSetting("number_prefixes", {}) }; }
  function savePrefixes(value) { for (const type of TYPES) if (value[type] !== undefined && !/^[A-Z0-9]{2,10}$/i.test(value[type])) throw error(`Prefix for ${type} must be 2-10 letters or digits`); const merged = { ...prefixes(), ...value }; setting("number_prefixes", merged); return merged; }

  function normalizeData(input = {}, type = "invoice", number = input.number || "") {
    assertType(type); const profile = getBusinessProfile(); const template = templateFor(input.template_id || "classic");
    if (input.page_size && !["A4", "LETTER"].includes(input.page_size)) throw error("page_size must be A4 or LETTER");
    if (input.shipping_minor !== undefined) asMinor(input.shipping_minor, "shipping_minor");
    if (input.document_discount_bps !== undefined && (Number(input.document_discount_bps) < 0 || Number(input.document_discount_bps) > 10000)) throw error("document_discount_bps must be between 0 and 10000");
    const items = Array.isArray(input.items) ? input.items : [];
    for (const [index, item] of items.entries()) {
      if (item.quantity !== undefined && (!Number.isFinite(Number(item.quantity)) || Number(item.quantity) < 0)) throw error(`items[${index}].quantity cannot be negative`);
      if (item.unit_price_minor !== undefined) asMinor(item.unit_price_minor, `items[${index}].unit_price_minor`);
      if (item.tax_bps !== undefined && (Number(item.tax_bps) < 0 || Number(item.tax_bps) > 10000)) throw error(`items[${index}].tax_bps must be between 0 and 10000`);
      if (item.discount_bps !== undefined && (Number(item.discount_bps) < 0 || Number(item.discount_bps) > 10000)) throw error(`items[${index}].discount_bps must be between 0 and 10000`);
    }
    const defaultPayment = defaultPaymentMethod(); const defaultPaymentDetails = defaultPayment?.details?.instructions || "";
    const title = input.document_title || (type === "quote" ? "Quote" : type === "receipt" ? "Receipt" : "Tax Invoice");
    return { ...input, document_type: type, document_title: title, number, issue_date: input.issue_date || today(), due_date: input.due_date || new Date(Date.now() + (Number(input.terms_days) || profile.default_terms_days || 30) * 86400000).toISOString().slice(0, 10), terms_days: Number(input.terms_days) || profile.default_terms_days || 30, currency: String(input.currency || profile.default_currency || "ZAR").toUpperCase(), customer_id: input.customer_id || null, customer: input.customer || {}, supplier: input.supplier || profile, items, payment_method_id: input.payment_method_id || defaultPayment?.id || null, payment_method: input.payment_method || defaultPayment?.name || "Bank transfer", payment_details: input.payment_details || defaultPaymentDetails, po_number: input.po_number || "", notes: input.notes || "", shipping_minor: Math.round(Number(input.shipping_minor) || 0), document_discount_bps: Math.round(Number(input.document_discount_bps) || 0), attachments: Array.isArray(input.attachments) ? input.attachments : [], template_id: template.id, page_size: input.page_size || "A4", accent: input.accent || template.accent, brand: input.brand || {}, signature: input.signature || "", footer: input.footer || "" };
  }

  function allocateNumberInTransaction(type, year = new Date().getFullYear()) {
    assertType(type); const current = db.prepare("SELECT value FROM document_sequences WHERE document_type=? AND year=?").get(type, year);
    const next = current ? current.value + 1 : type === "invoice" ? 453 : 1;
    db.prepare("INSERT INTO document_sequences(document_type,year,value) VALUES(?,?,?) ON CONFLICT(document_type,year) DO UPDATE SET value=excluded.value").run(type, year, next);
    return `${prefixes()[type]}-${year}-${String(next).padStart(5, "0")}`;
  }
  function observeAssignedNumber(type, number, year) {
    const sequence = Number(String(number).match(/(\d+)(?!.*\d)/)?.[1]);
    if (!Number.isFinite(sequence)) return;
    const current = db.prepare("SELECT value FROM document_sequences WHERE document_type=? AND year=?").get(type, year);
    if (!current || current.value < sequence) db.prepare("INSERT INTO document_sequences(document_type,year,value) VALUES(?,?,?) ON CONFLICT(document_type,year) DO UPDATE SET value=MAX(value,excluded.value)").run(type, year, sequence);
  }
  function allocateNumber(type = "invoice") { db.exec("BEGIN IMMEDIATE"); try { const number = allocateNumberInTransaction(type); db.exec("COMMIT"); return number; } catch (cause) { db.exec("ROLLBACK"); throw cause; } }
  function audit(documentId, type, detail = {}) { db.prepare("INSERT INTO document_audit_events(document_id,type,detail_json,created_at) VALUES(?,?,?,?)").run(documentId, type, JSON.stringify(detail), now()); }

  function rowDocument(row, sensitive = false) {
    if (!row) return null; const data = json(row.data_json); const totals = json(row.totals_json); const snapshot = row.snapshot_json ? json(row.snapshot_json) : null;
    const document = { id: row.id, document_type: row.document_type, number: row.number, status: row.status, customer_id: row.customer_id, source_document_id: row.source_document_id, recurring_schedule_id: row.recurring_schedule_id || null, data, totals, snapshot, amount_paid_minor: row.amount_paid_minor, balance_due_minor: row.balance_due_minor, created_at: row.created_at, updated_at: row.updated_at, issued_at: row.issued_at, finalized_at: row.finalized_at, readiness: readiness(data, totals, row.document_type) };
    if (sensitive && data.payment_method_id) document.payment_method = getPaymentMethod(data.payment_method_id, true);
    return document;
  }
  function getDocument(id, options = {}) { return rowDocument(db.prepare("SELECT * FROM documents WHERE id=?").get(id), options.sensitive); }
  function listDocuments({ document_type, status } = {}) { let sql = "SELECT * FROM documents WHERE 1=1"; const values = []; if (document_type) { assertType(document_type); sql += " AND document_type=?"; values.push(document_type); } if (status) { sql += " AND status=?"; values.push(status); } return db.prepare(`${sql} ORDER BY updated_at DESC`).all(...values).map((row) => rowDocument(row)); }

  function insertDocument(input = {}, type = "invoice", options = {}) {
    assertType(type); const id = options.id || randomUUID(); const timestamp = now(); const year = new Date().getFullYear(); const number = input.number || allocateNumberInTransaction(type, year); if (input.number) observeAssignedNumber(type, number, year); const data = normalizeData({ ...input, number }, type, number); const totals = calculateTotals(data);
    db.prepare("INSERT INTO documents(id,document_type,number,number_year,status,customer_id,source_document_id,recurring_schedule_id,data_json,totals_json,snapshot_json,amount_paid_minor,balance_due_minor,created_at,updated_at,issued_at,finalized_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, type, number, year, "draft", data.customer_id || null, options.source_document_id || null, options.recurring_schedule_id || null, JSON.stringify(data), JSON.stringify(totals), null, 0, totals.total_minor, timestamp, timestamp, null, null);
    audit(id, "created", { number, document_type: type }); return getDocument(id);
  }
  function createDocument(input = {}) { const type = input.document_type || "invoice"; db.exec("BEGIN IMMEDIATE"); try { const document = insertDocument(input, type); db.exec("COMMIT"); return document; } catch (cause) { db.exec("ROLLBACK"); if (/UNIQUE/.test(cause.message)) throw error("Document number already exists", 409, "CONFLICT"); throw cause; } }
  function createDraft(input = {}) { return createDocument({ ...input, document_type: "invoice" }); }

  function updateDocument(id, input = {}) {
    const existing = getDocument(id); if (!existing) throw error("Document not found", 404, "NOT_FOUND"); if (existing.status !== "draft") throw error("Issued documents cannot be edited", 409, "CONFLICT");
    const type = existing.document_type; const data = normalizeData({ ...existing.data, ...input, number: input.number || existing.number }, type, input.number || existing.number); const totals = calculateTotals(data);
    try { db.prepare("UPDATE documents SET number=?,customer_id=?,data_json=?,totals_json=?,balance_due_minor=?,updated_at=? WHERE id=?").run(data.number, data.customer_id || null, JSON.stringify(data), JSON.stringify(totals), totals.total_minor, now(), id); observeAssignedNumber(type, data.number, new Date().getFullYear()); } catch (cause) { if (/UNIQUE/.test(cause.message)) throw error("Document number already exists", 409, "CONFLICT"); throw cause; }
    audit(id, "updated"); return getDocument(id);
  }
  function updateDraft(id, input) { const document = getDocument(id); if (document?.document_type !== "invoice") throw error("Invoice not found", 404, "NOT_FOUND"); return updateDocument(id, input); }
  function snapshotDocument(document, status) { const data = withoutPristineTrailingItems(document.data); const totals = calculateTotals(data); const check = readiness(data, totals, document.document_type); if (!check.ready) throw error("Document is not ready to finalize", 422, "VALIDATION_ERROR", check.checks.filter((item) => !item.complete)); const timestamp = now(); const snapshot = { ...data, totals, issued_at: timestamp }; db.prepare("UPDATE documents SET status=?,data_json=?,totals_json=?,snapshot_json=?,balance_due_minor=?,issued_at=?,finalized_at=?,updated_at=? WHERE id=?").run(status, JSON.stringify(data), JSON.stringify(totals), JSON.stringify(snapshot), Math.max(0, totals.total_minor - document.amount_paid_minor), timestamp, document.document_type === "invoice" ? timestamp : null, timestamp, document.id); return getDocument(document.id); }
  function finalizeDocument(id, markSent = false) { const document = getDocument(id); if (!document) throw error("Document not found", 404, "NOT_FOUND"); if (document.status !== "draft") throw error("Only drafts can be finalized", 409, "CONFLICT"); const status = document.document_type === "receipt" ? "issued" : document.document_type === "quote" ? "sent" : markSent ? "sent" : "finalized"; const result = snapshotDocument(document, status); audit(id, document.document_type === "receipt" ? "issued" : "finalized"); if (markSent || document.document_type === "quote") audit(id, "sent", { delivery: "local-export" }); return result; }
  function finalize(id, markSent = false) { const document = getDocument(id); if (document?.document_type !== "invoice") throw error("Invoice not found", 404, "NOT_FOUND"); return finalizeDocument(id, markSent); }
  function transitionDocument(id, status, event = status) { const document = getDocument(id); if (!document) throw error("Document not found", 404, "NOT_FOUND"); assertStatus(document.document_type, status); const transitions = { quote: { sent: ["draft"], accepted: ["sent"], declined: ["sent"], expired: ["draft", "sent"] }, invoice: { sent: ["draft", "finalized"], overdue: ["finalized", "sent", "partially_paid"], void: ["draft", "finalized", "sent", "partially_paid", "overdue"], refunded: ["paid", "partially_paid"] }, receipt: { void: ["draft", "issued"] } }; if (!transitions[document.document_type][status]?.includes(document.status)) throw error(`Cannot transition ${document.document_type} from ${document.status} to ${status}`, 409, "CONFLICT"); db.prepare("UPDATE documents SET status=?,updated_at=? WHERE id=?").run(status, now(), id); audit(id, event); return getDocument(id); }
  function transition(id, status, allowed, event) { const document = getDocument(id); if (!document || document.document_type !== "invoice") throw error("Invoice not found", 404, "NOT_FOUND"); if (!allowed.includes(document.status)) throw error(`Cannot mark ${document.status} invoice as ${status}`, 409, "CONFLICT"); db.prepare("UPDATE documents SET status=?,updated_at=? WHERE id=?").run(status, now(), id); audit(id, event); return getDocument(id); }
  function duplicate(id) { const source = getDocument(id); if (!source) throw error("Document not found", 404, "NOT_FOUND"); const base = source.snapshot || source.data; return createDocument({ ...base, document_type: source.document_type, number: undefined, issue_date: today(), due_date: new Date(Date.now() + (base.terms_days || 30) * 86400000).toISOString().slice(0, 10) }); }

  function convertQuote(id) { const quote = getDocument(id); if (!quote || quote.document_type !== "quote") throw error("Quote not found", 404, "NOT_FOUND"); if (quote.status === "converted" || db.prepare("SELECT id FROM documents WHERE source_document_id=?").get(id)) throw error("Quote has already been converted", 409, "CONFLICT"); if (quote.status !== "accepted") throw error("Only accepted quotes can be converted", 409, "CONFLICT"); db.exec("BEGIN IMMEDIATE"); try { const base = quote.snapshot || quote.data; const invoice = insertDocument({ ...base, document_type: "invoice", document_title: "Tax Invoice", number: undefined }, "invoice", { source_document_id: quote.id }); db.prepare("UPDATE documents SET status='converted',updated_at=? WHERE id=?").run(now(), quote.id); audit(quote.id, "converted", { invoice_id: invoice.id }); audit(invoice.id, "created_from_quote", { quote_id: quote.id }); db.exec("COMMIT"); return getDocument(invoice.id); } catch (cause) { db.exec("ROLLBACK"); throw cause; } }

  function createReceiptInTransaction(invoice, payment) { const receipt = insertDocument({ document_title: "Receipt", currency: invoice.data.currency, customer: invoice.data.customer, customer_id: invoice.customer_id, supplier: invoice.data.supplier, template_id: invoice.data.template_id, page_size: invoice.data.page_size, accent: invoice.data.accent, payment_method: payment.method, payment_details: invoice.data.payment_details, receipt_for: invoice.number, items: [{ description: `Payment for ${invoice.number}`, quantity: 1, unit_price_minor: payment.amount_minor, tax_bps: 0, discount_bps: 0 }], notes: payment.notes || "" }, "receipt"); const issued = getDocument(receipt.id); const timestamp = now(); const snapshot = { ...issued.data, totals: issued.totals, issued_at: timestamp }; db.prepare("UPDATE documents SET status='issued',snapshot_json=?,issued_at=?,updated_at=? WHERE id=?").run(JSON.stringify(snapshot), timestamp, timestamp, receipt.id); audit(receipt.id, "issued", { payment_for: invoice.id }); return getDocument(receipt.id); }
  function recordPaymentInTransaction(id, input = {}) {
    const invoice = getDocument(id); if (!invoice || invoice.document_type !== "invoice") throw error("Invoice not found", 404, "NOT_FOUND");
    if (!["finalized", "sent", "partially_paid", "overdue"].includes(invoice.status)) throw error("Payments can only be recorded against an issued invoice", 409, "CONFLICT");
    const amount_minor = asMinor(input.amount_minor, "amount_minor", { allowZero: false }); if (amount_minor > invoice.balance_due_minor) throw error("Payment exceeds outstanding balance");
    const method = String(input.method || "Bank transfer").trim(); if (!method) throw error("method is required");
    const payment = { amount_minor, method, notes: input.notes || "" }; const receipt = input.create_receipt === false ? null : createReceiptInTransaction(invoice, payment); const paymentId = randomUUID();
    db.prepare("INSERT INTO payments(id,invoice_id,receipt_id,amount_minor,method,reference,received_date,notes,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(paymentId, id, receipt?.id || null, amount_minor, method, input.reference || "", input.received_date || today(), input.notes || "", now());
    const paid = invoice.amount_paid_minor + amount_minor; const balance = invoice.totals.total_minor - paid; const status = balance === 0 ? "paid" : "partially_paid";
    db.prepare("UPDATE documents SET amount_paid_minor=?,balance_due_minor=?,status=?,updated_at=? WHERE id=?").run(paid, balance, status, now(), id); audit(id, "payment_recorded", { payment_id: paymentId, receipt_id: receipt?.id || null, amount_minor, method });
    return { payment: getPayment(paymentId), receipt, invoice: getDocument(id) };
  }
  function recordPayment(id, input = {}) { db.exec("BEGIN IMMEDIATE"); try { const result = recordPaymentInTransaction(id, input); db.exec("COMMIT"); return result; } catch (cause) { db.exec("ROLLBACK"); throw cause; } }
  function getPayment(id) { return db.prepare("SELECT * FROM payments WHERE id=?").get(id) || null; }
  function listPayments(invoiceId) { return db.prepare("SELECT * FROM payments WHERE invoice_id=? ORDER BY received_date,id").all(invoiceId); }
  function paymentCheckout(row) { return row || null; }
  function beginPaymentCheckout(invoiceId, input = {}) {
    const invoice = getDocument(invoiceId); if (!invoice || invoice.document_type !== "invoice") throw error("Invoice not found", 404, "NOT_FOUND");
    if (!["finalized", "sent", "partially_paid", "overdue"].includes(invoice.status) || invoice.balance_due_minor <= 0) throw error("Only an issued invoice with an outstanding balance can be paid", 409, "CONFLICT");
    const provider = String(input.provider || "").toLowerCase(); if (!["stripe", "paypal"].includes(provider)) throw error("provider must be stripe or paypal");
    const requestKey = String(input.request_key || "").trim(); if (!requestKey || requestKey.length > 200) throw error("request_key is required and must be 200 characters or fewer");
    const amount = asMinor(input.amount_minor ?? invoice.balance_due_minor, "amount_minor", { allowZero: false }); if (amount > invoice.balance_due_minor) throw error("Payment link amount exceeds the outstanding balance");
    const existing = db.prepare("SELECT * FROM payment_checkouts WHERE request_key=?").get(requestKey); if (existing) { if (existing.invoice_id !== invoiceId || existing.provider !== provider || existing.amount_minor !== amount) throw error("request_key was already used for different payment link parameters", 409, "IDEMPOTENCY_CONFLICT"); return { checkout: paymentCheckout(existing), invoice, idempotent: true }; }
    const currency = String((invoice.snapshot || invoice.data).currency || "ZAR").toUpperCase(); const id = input.id || randomUUID(); const timestamp = now();
    db.prepare("INSERT INTO payment_checkouts(id,invoice_id,provider,request_key,amount_minor,currency,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(id, invoiceId, provider, requestKey, amount, currency, "creating", timestamp, timestamp);
    return { checkout: paymentCheckout(db.prepare("SELECT * FROM payment_checkouts WHERE id=?").get(id)), invoice, idempotent: false };
  }
  function completePaymentCheckout(id, result = {}) { const row = db.prepare("SELECT * FROM payment_checkouts WHERE id=?").get(id); if (!row) throw error("Payment checkout not found", 404, "NOT_FOUND"); db.prepare("UPDATE payment_checkouts SET provider_checkout_id=?,checkout_url=?,status=?,provider_error=?,updated_at=? WHERE id=?").run(result.provider_checkout_id || row.provider_checkout_id, result.checkout_url || row.checkout_url, result.error ? "failed" : result.status || "open", result.error || null, now(), id); return paymentCheckout(db.prepare("SELECT * FROM payment_checkouts WHERE id=?").get(id)); }
  function getPaymentCheckout(id) { return paymentCheckout(db.prepare("SELECT * FROM payment_checkouts WHERE id=?").get(id)); }
  function listPaymentCheckouts(invoiceId) { return db.prepare("SELECT * FROM payment_checkouts WHERE invoice_id=? ORDER BY created_at DESC").all(invoiceId).map(paymentCheckout); }
  function savePortalLink(documentId, input = {}) { const document = getDocument(documentId); if (!document) throw error("Document not found", 404, "NOT_FOUND"); if (document.status === "draft") throw error("Finalize or send the document before sharing it", 409, "CONFLICT"); const timestamp = now(); const id = input.id || randomUUID(); db.prepare("INSERT INTO document_portal_links(id,document_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)").run(id, documentId, input.token_hash, input.expires_at, timestamp); audit(documentId, "portal_link_created", { portal_link_id: id, expires_at: input.expires_at }); return db.prepare("SELECT id,document_id,expires_at,revoked_at,last_viewed_at,created_at FROM document_portal_links WHERE id=?").get(id); }
  function listPortalLinks(documentId) { return db.prepare("SELECT id,document_id,expires_at,revoked_at,last_viewed_at,created_at FROM document_portal_links WHERE document_id=? ORDER BY created_at DESC").all(documentId); }
  function revokePortalLink(id) { const result = db.prepare("UPDATE document_portal_links SET revoked_at=? WHERE id=? AND revoked_at IS NULL").run(now(), id); if (!result.changes) throw error("Portal link not found", 404, "NOT_FOUND"); return { id, revoked: true }; }
  function resolvePortalLink(tokenHash) { const link = db.prepare("SELECT * FROM document_portal_links WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?").get(tokenHash, now()); if (!link) return null; const document = getDocument(link.document_id); db.prepare("UPDATE document_portal_links SET last_viewed_at=? WHERE id=?").run(now(), link.id); return { link: { id: link.id, expires_at: link.expires_at }, document, payment_links: document.document_type === "invoice" ? listPaymentCheckouts(document.id).filter((checkout) => checkout.checkout_url && !["failed", "paid"].includes(checkout.status)).map(({ checkout_url, provider, amount_minor, currency, status }) => ({ checkout_url, provider, amount_minor, currency, status })) : [] }; }
  function portalQuoteAction(tokenHash, action) { if (!["accepted", "declined"].includes(action)) throw error("Quote action is invalid"); const link = db.prepare("SELECT * FROM document_portal_links WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?").get(tokenHash, now()); if (!link) throw error("Portal link is invalid or expired", 404, "NOT_FOUND"); const document = getDocument(link.document_id); if (!document || document.document_type !== "quote" || document.status !== "sent") throw error("This quote can no longer be updated", 409, "CONFLICT"); db.exec("BEGIN IMMEDIATE"); try { db.prepare("UPDATE documents SET status=?,updated_at=? WHERE id=?").run(action, now(), document.id); audit(document.id, action, { source: "customer_portal", portal_link_id: link.id }); db.exec("COMMIT"); return getDocument(document.id); } catch (cause) { db.exec("ROLLBACK"); throw cause; } }
  function processPaymentWebhook(provider, event = {}) {
    if (db.prepare("SELECT 1 FROM provider_webhook_events WHERE provider=? AND event_id=?").get(provider, event.eventId)) return { duplicate: true };
    db.exec("BEGIN IMMEDIATE");
    try {
      const checkout = event.checkoutId ? db.prepare("SELECT * FROM payment_checkouts WHERE id=? AND provider=?").get(event.checkoutId, provider) : db.prepare("SELECT * FROM payment_checkouts WHERE provider=? AND provider_checkout_id=?").get(provider, event.providerCheckoutId);
      if (checkout && event.successful && (event.amountMinor !== checkout.amount_minor || event.currency !== checkout.currency)) throw error("Provider payment amount or currency does not match the checkout", 409, "PAYMENT_RECONCILIATION_MISMATCH");
      db.prepare("INSERT INTO provider_webhook_events(provider,event_id,event_type,object_id,payload_json,processed_at) VALUES(?,?,?,?,?,?)").run(provider, event.eventId, event.type, event.providerCheckoutId || event.providerPaymentId || null, JSON.stringify(event.raw || {}), now());
      let payment = null;
      if (checkout && event.successful && checkout.status !== "paid") {
        payment = recordPaymentInTransaction(checkout.invoice_id, { amount_minor: checkout.amount_minor, method: provider === "stripe" ? "Stripe" : "PayPal", reference: event.providerPaymentId || checkout.provider_checkout_id, notes: `Automatically reconciled from ${provider}`, create_receipt: true });
        db.prepare("UPDATE payment_checkouts SET status='paid',provider_payment_id=?,provider_error=NULL,paid_at=?,updated_at=? WHERE id=?").run(event.providerPaymentId || null, now(), now(), checkout.id);
      } else if (checkout && event.failed && checkout.status !== "paid") db.prepare("UPDATE payment_checkouts SET status='failed',provider_error=?,updated_at=? WHERE id=?").run(`${provider} reported ${event.type}`, now(), checkout.id);
      db.exec("COMMIT"); return { duplicate: false, matched: Boolean(checkout), checkout: checkout ? getPaymentCheckout(checkout.id) : null, payment };
    } catch (cause) { db.exec("ROLLBACK"); throw cause; }
  }

  function maskDetails(details = {}) { const result = { ...details }; for (const field of ["account_number", "account", "iban", "routing_number"]) if (result[field]) { const value = String(result[field]); result[field] = `${"*".repeat(Math.max(0, value.length - 4))}${value.slice(-4)}`; } return result; }
  function getPaymentMethod(id, sensitive = false) { const row = db.prepare("SELECT * FROM payment_methods WHERE id=?").get(id); return row && { ...row, active: Boolean(row.active), is_default: Boolean(row.is_default), details: sensitive ? json(row.details_json) : maskDetails(json(row.details_json)), details_json: undefined }; }
  function defaultPaymentMethod() { const row = db.prepare("SELECT * FROM payment_methods WHERE active=1 AND is_default=1 LIMIT 1").get(); return row && { ...row, active: Boolean(row.active), is_default: Boolean(row.is_default), details: json(row.details_json), details_json: undefined }; }
  function listPaymentMethods() { return db.prepare("SELECT * FROM payment_methods ORDER BY is_default DESC,name").all().map((row) => ({ ...row, active: Boolean(row.active), is_default: Boolean(row.is_default), details: maskDetails(json(row.details_json)), details_json: undefined })); }
  function savePaymentMethod(input, id = input.id || randomUUID()) { if (!input.name) throw error("Payment method name is required"); const timestamp = now(); const existing = db.prepare("SELECT * FROM payment_methods WHERE id=?").get(id); const hasDefault = Boolean(db.prepare("SELECT 1 FROM payment_methods WHERE is_default=1 LIMIT 1").get()); const isDefault = input.is_default === undefined ? Boolean(existing?.is_default) || !hasDefault : Boolean(input.is_default); db.exec("BEGIN IMMEDIATE"); try { if (isDefault) db.prepare("UPDATE payment_methods SET is_default=0").run(); db.prepare("INSERT INTO payment_methods(id,name,method_type,details_json,active,is_default,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,method_type=excluded.method_type,details_json=excluded.details_json,active=excluded.active,is_default=excluded.is_default,updated_at=excluded.updated_at").run(id, input.name, input.method_type || "bank_transfer", JSON.stringify(input.details || {}), input.active === false ? 0 : 1, isDefault ? 1 : 0, timestamp, timestamp); db.exec("COMMIT"); } catch (cause) { db.exec("ROLLBACK"); throw cause; } return getPaymentMethod(id, true); }
  function setDefaultPaymentMethod(id) { if (!getPaymentMethod(id, true)) throw error("Payment method not found", 404, "NOT_FOUND"); db.exec("BEGIN IMMEDIATE"); try { db.prepare("UPDATE payment_methods SET is_default=0").run(); db.prepare("UPDATE payment_methods SET is_default=1,updated_at=? WHERE id=?").run(now(), id); db.exec("COMMIT"); } catch (cause) { db.exec("ROLLBACK"); throw cause; } return getPaymentMethod(id, true); }
  function saveMediaAsset(input, id = input.id || randomUUID()) { if (!input.storage_key || !input.filename || !input.content_type) throw error("Asset metadata is incomplete"); const size = Math.round(Number(input.byte_size)); if (!Number.isFinite(size) || size < 0) throw error("Asset byte size is invalid"); const created_at = now(); db.prepare("INSERT INTO media_assets(id,storage_key,filename,content_type,byte_size,created_at) VALUES(?,?,?,?,?,?)").run(id, input.storage_key, input.filename, input.content_type, size, created_at); return getMediaAsset(id); }
  function getMediaAsset(id) { return db.prepare("SELECT * FROM media_assets WHERE id=?").get(id) || null; }
  function deleteMediaAsset(id) { const asset = getMediaAsset(id); if (!asset) return null; db.prepare("DELETE FROM media_assets WHERE id=?").run(id); return asset; }
  function listBrandingPresets() { return db.prepare("SELECT * FROM branding_presets ORDER BY name").all().map((row) => ({ id: row.id, name: row.name, ...json(row.data_json), created_at: row.created_at, updated_at: row.updated_at })); }
  function saveBrandingPreset(input, id = input.id || randomUUID()) { if (!input.name) throw error("Branding preset name is required"); if (input.template_id) templateFor(input.template_id); const timestamp = now(); db.prepare("INSERT INTO branding_presets(id,name,data_json,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,data_json=excluded.data_json,updated_at=excluded.updated_at").run(id, input.name, JSON.stringify({ template_id: input.template_id || "classic", accent: input.accent || "#7f56d9", logo_url: input.logo_url || "", footer: input.footer || "" }), timestamp, timestamp); return listBrandingPresets().find((preset) => preset.id === id); }

  function listEmailTemplates() { return db.prepare("SELECT purpose,subject,text,html,updated_at FROM email_templates ORDER BY purpose").all(); }
  function getEmailTemplate(purpose) { const template = db.prepare("SELECT purpose,subject,text,html,updated_at FROM email_templates WHERE purpose=?").get(purpose); if (!template) throw error("Email template not found", 404, "NOT_FOUND"); return template; }
  function saveEmailTemplate(input) { if (!PURPOSES.includes(input.purpose)) throw error(`purpose must be one of: ${PURPOSES.join(", ")}`); validateTemplate(input); db.prepare("INSERT INTO email_templates(purpose,subject,text,html,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(purpose) DO UPDATE SET subject=excluded.subject,text=excluded.text,html=excluded.html,updated_at=excluded.updated_at").run(input.purpose, input.subject || "", input.text || "", input.html || "", now()); return getEmailTemplate(input.purpose); }
  function restoreEmailTemplate(purpose) { const template = DEFAULT_EMAIL_TEMPLATES[purpose]; if (!template) throw error(`Unknown email template purpose '${purpose}'`); return saveEmailTemplate(template); }
  function emailVariables(document, message = "") {
    const data = document.snapshot || document.data; const money = (minor) => new Intl.NumberFormat("en-ZA", { style: "currency", currency: data.currency || "ZAR" }).format((minor || 0) / 100);
    const businessName = data.supplier?.name || getBusinessProfile().name;
    return { document_number: document.number, document_type: document.document_type, customer_name: data.customer?.name || "Customer", business_name: businessName, sender_name: businessName, currency: data.currency || "ZAR", subtotal: money(document.totals.subtotal_minor), total: money(document.totals.total_minor), amount_paid: money(document.amount_paid_minor), balance_due: money(document.balance_due_minor), due_date: data.due_date || "", expiry_date: data.expiry_date || data.due_date || "", issue_date: data.issue_date || "", payment_method: data.payment_method || "", payment_link: data.payment_link || "", document_link: data.document_link || "", message };
  }
  const validAddress = (address) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);
  const safeHtml = (value) => String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  function createEmailDraft(documentId, { purpose, message = "", subject, body } = {}) { const document = getDocument(documentId); if (!document) throw error("Document not found", 404, "NOT_FOUND"); const selected = purpose || `${document.document_type}_send`; const template = getEmailTemplate(PURPOSES.includes(selected) ? selected : "document_generic"); const rendered = renderTemplate(template, emailVariables(document, message)); const customBody = typeof body === "string" && body.trim() ? body.trim() : null; const customSubject = typeof subject === "string" && subject.trim() ? subject.trim() : null; if (customSubject && customSubject.length > 240) throw error("Email subject must be 240 characters or fewer"); return { document_id: documentId, purpose: template.purpose, recipients: document.data.customer?.email ? [document.data.customer.email] : [], subject: customSubject || rendered.subject, text: customBody || rendered.text, html: customBody ? safeHtml(customBody).replace(/\r?\n/g, "<br>") : rendered.html }; }
  function emailAttempt(row, idempotent = false) { return { ...row, recipients: json(row.recipients_json), rendered: json(row.rendered_json), recipients_json: undefined, rendered_json: undefined, idempotent }; }
  function beginDocumentEmail(id, input = {}, provider = "mock") {
    const requestKey = String(input.request_key || input.idempotency_key || "").trim();
    if (!requestKey || requestKey.length > 256) throw error("request_key is required and must be 256 characters or fewer");
    const existing = db.prepare("SELECT * FROM email_delivery_attempts WHERE document_id=? AND request_key=?").get(id, requestKey);
    if (existing) return { attempt: emailAttempt(existing, true), document: getDocument(id, { sensitive: true }), idempotent: true };
    const document = getDocument(id, { sensitive: true }); if (!document) throw error("Document not found", 404, "NOT_FOUND");
    if (document.status === "draft" && !readiness(document.data, document.totals, document.document_type).ready) throw error("Document must be complete before it can be sent", 422, "VALIDATION_ERROR");
    const draft = createEmailDraft(id, input);
    const to = Array.isArray(input.to) ? input.to : input.to ? [input.to] : Array.isArray(input.recipients) ? input.recipients : draft.recipients;
    const cc = Array.isArray(input.cc) ? input.cc : input.cc ? [input.cc] : [];
    const bcc = Array.isArray(input.bcc) ? input.bcc : input.bcc ? [input.bcc] : [];
    const allRecipients = [...new Set([...to, ...cc, ...bcc].map((address) => String(address).trim()).filter(Boolean))];
    if (!to.length || allRecipients.some((address) => !validAddress(address))) throw error("Enter at least one valid recipient email address");
    const suppressed = allRecipients.find((address) => db.prepare("SELECT 1 FROM email_suppressions WHERE email=?").get(address.toLowerCase()));
    if (suppressed) throw error(`${suppressed} is suppressed after a permanent delivery failure`, 409, "EMAIL_SUPPRESSED");
    const attempt = { id: randomUUID(), document_id: id, request_key: requestKey, recipients: allRecipients, template_purpose: draft.purpose, provider, provider_status: "sending", provider_message_id: null, provider_error: null, rendered: { subject: draft.subject, text: draft.text, html: draft.html, to, cc, bcc }, created_at: now() };
    try { db.prepare("INSERT INTO email_delivery_attempts(id,document_id,request_key,recipients_json,template_purpose,provider,provider_status,provider_message_id,provider_error,rendered_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(attempt.id, id, requestKey, JSON.stringify(attempt.recipients), draft.purpose, provider, "sending", null, null, JSON.stringify(attempt.rendered), attempt.created_at); }
    catch (cause) { if (/UNIQUE/.test(cause.message)) { const duplicate = db.prepare("SELECT * FROM email_delivery_attempts WHERE document_id=? AND request_key=?").get(id, requestKey); return { attempt: emailAttempt(duplicate, true), document, idempotent: true }; } throw cause; }
    audit(id, "email_send_started", { attempt_id: attempt.id, provider, recipients: allRecipients });
    return { attempt, document, idempotent: false };
  }
  function completeDocumentEmail(id, attemptId, delivery = {}) {
    const row = db.prepare("SELECT * FROM email_delivery_attempts WHERE id=? AND document_id=?").get(attemptId, id); if (!row) throw error("Email attempt not found", 404, "NOT_FOUND");
    if (row.provider_status !== "sending") return emailAttempt(row, true);
    const accepted = Boolean(delivery.accepted);
    db.exec("BEGIN IMMEDIATE");
    try {
      if (accepted) { const current = getDocument(id); if (current.status === "draft") finalizeDocument(id, true); db.prepare("UPDATE email_delivery_attempts SET provider_status=?,provider_message_id=?,provider_error=NULL,next_retry_at=NULL,updated_at=? WHERE id=?").run(delivery.status || "accepted", delivery.message_id || null, now(), attemptId); audit(id, "email_send_accepted", { attempt_id: attemptId, provider: row.provider, provider_message_id: delivery.message_id || null }); }
      else { const retryAt = ["provider_error", "delayed", "failed"].includes(delivery.status) ? new Date(Date.now() + 5 * 60000).toISOString() : null; db.prepare("UPDATE email_delivery_attempts SET provider_status=?,provider_error=?,next_retry_at=?,updated_at=? WHERE id=?").run(delivery.status || "failed", String(delivery.error || "Delivery was not accepted"), retryAt, now(), attemptId); audit(id, "email_send_failed", { attempt_id: attemptId, provider: row.provider }); }
      db.exec("COMMIT");
    } catch (cause) { db.exec("ROLLBACK"); throw cause; }
    return emailAttempt(db.prepare("SELECT * FROM email_delivery_attempts WHERE id=?").get(attemptId));
  }
  function sendDocument(id, input = {}) { const started = beginDocumentEmail(id, input, process.env.FORMA_EMAIL_PROVIDER || process.env.MONEYFY_EMAIL_PROVIDER || "mock"); if (started.idempotent) return started.attempt; return completeDocumentEmail(id, started.attempt.id, { accepted: true, status: "accepted_mock" }); }
  function listEmailHistory(id) { return db.prepare("SELECT * FROM email_delivery_attempts WHERE document_id=? ORDER BY created_at DESC").all(id).map((row) => emailAttempt(row)); }
  function listRetryableEmailAttempts({ as_of = now(), limit = 25 } = {}) { return db.prepare("SELECT * FROM email_delivery_attempts WHERE next_retry_at IS NOT NULL AND next_retry_at<=? AND provider_status IN ('provider_error','failed','delayed') ORDER BY next_retry_at LIMIT ?").all(as_of, Math.min(100, Math.max(1, Number(limit) || 25))).map((row) => emailAttempt(row)); }
  function claimEmailRetry(id) { const result = db.prepare("UPDATE email_delivery_attempts SET provider_status='retrying',next_retry_at=NULL,updated_at=? WHERE id=? AND next_retry_at IS NOT NULL AND provider_status IN ('provider_error','failed','delayed')").run(now(), id); return result.changes === 1; }
  function processResendWebhook(event = {}) {
    const existing = db.prepare("SELECT 1 FROM provider_webhook_events WHERE provider='resend' AND event_id=?").get(event.eventId); if (existing) return { duplicate: true };
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("INSERT INTO provider_webhook_events(provider,event_id,event_type,object_id,payload_json,processed_at) VALUES('resend',?,?,?,?,?)").run(event.eventId, event.type, event.providerMessageId || null, JSON.stringify(event.raw || {}), now());
      const attempt = db.prepare("SELECT * FROM email_delivery_attempts WHERE provider='resend' AND provider_message_id=?").get(event.providerMessageId);
      if (attempt) {
        const retryAt = event.status === "delayed" ? new Date(Date.now() + 15 * 60000).toISOString() : null;
        db.prepare("UPDATE email_delivery_attempts SET provider_status=?,provider_error=?,next_retry_at=?,updated_at=? WHERE id=?").run(event.status, event.terminalFailure ? `Resend reported ${event.status}` : null, retryAt, now(), attempt.id);
        if (event.terminalFailure) for (const address of event.recipients?.length ? event.recipients : json(attempt.recipients_json, [])) db.prepare("INSERT INTO email_suppressions(email,reason,provider,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET reason=excluded.reason,provider=excluded.provider,updated_at=excluded.updated_at").run(String(address).toLowerCase(), event.status, "resend", now(), now());
        audit(attempt.document_id, `email_${event.status}`, { attempt_id: attempt.id, event_id: event.eventId });
      }
      db.exec("COMMIT"); return { duplicate: false, matched: Boolean(attempt), attempt: attempt ? emailAttempt(db.prepare("SELECT * FROM email_delivery_attempts WHERE id=?").get(attempt.id)) : null };
    } catch (cause) { db.exec("ROLLBACK"); throw cause; }
  }
  function listAudit(id) { const fresh = db.prepare("SELECT id,type,detail_json,created_at FROM document_audit_events WHERE document_id=? ORDER BY id").all(id).map((row) => ({ ...row, detail: json(row.detail_json) })); const legacy = db.prepare("SELECT id,type,detail_json,created_at FROM audit_events WHERE invoice_id=? ORDER BY id").all(id).map((row) => ({ ...row, detail: json(row.detail_json) })); return [...legacy, ...fresh].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id); }

  function rowReminderRule(row) { return row && { id: row.id, label: row.label, offset_days: row.offset_days, purpose: row.purpose, active: Boolean(row.active), created_at: row.created_at, updated_at: row.updated_at }; }
  function reminderDelivery(row) { return row && { id: row.id, document_id: row.document_id, rule_id: row.rule_id, due_date: row.due_date, scheduled_for: row.scheduled_for, attempt_id: row.attempt_id || null, status: row.status, provider_error: row.provider_error || null, created_at: row.created_at, updated_at: row.updated_at }; }
  function listReminderRules() { return db.prepare("SELECT * FROM reminder_rules ORDER BY offset_days,id").all().map(rowReminderRule); }
  function getReminderRule(id) { return rowReminderRule(db.prepare("SELECT * FROM reminder_rules WHERE id=?").get(id)); }
  function reminderRulePayload(input = {}, existing) {
    const label = String(input.label ?? existing?.label ?? "").trim();
    if (!label || label.length > 80) throw error("Reminder label must be between 1 and 80 characters");
    const offset_days = Math.round(Number(input.offset_days ?? existing?.offset_days ?? 0));
    if (!Number.isFinite(offset_days) || offset_days < -90 || offset_days > 365) throw error("Reminder offset must be between 90 days before and 365 days after due date");
    const purpose = String(input.purpose ?? existing?.purpose ?? (offset_days > 0 ? "invoice_overdue" : "invoice_reminder"));
    if (!["invoice_reminder", "invoice_overdue", "payment_reminder"].includes(purpose) || !PURPOSES.includes(purpose)) throw error("Reminder purpose must be a valid invoice reminder email template");
    return { label, offset_days, purpose, active: input.active === undefined ? (existing ? Boolean(existing.active) : true) : Boolean(input.active) };
  }
  function saveReminderRule(input = {}, id = input.id || randomUUID()) {
    const existingRow = db.prepare("SELECT * FROM reminder_rules WHERE id=?").get(id);
    if (input.id && !existingRow) throw error("Reminder rule not found", 404, "NOT_FOUND");
    const existing = rowReminderRule(existingRow); const payload = reminderRulePayload(input, existing); const timestamp = now();
    db.prepare("INSERT INTO reminder_rules(id,label,offset_days,purpose,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,offset_days=excluded.offset_days,purpose=excluded.purpose,active=excluded.active,updated_at=excluded.updated_at")
      .run(id, payload.label, payload.offset_days, payload.purpose, payload.active ? 1 : 0, existing?.created_at || timestamp, timestamp);
    return getReminderRule(id);
  }
  function setReminderRuleActive(id, active) { if (!getReminderRule(id)) throw error("Reminder rule not found", 404, "NOT_FOUND"); db.prepare("UPDATE reminder_rules SET active=?,updated_at=? WHERE id=?").run(active ? 1 : 0, now(), id); return getReminderRule(id); }
  function hasReminderDelivery(documentId, ruleId, dueDate) { return Boolean(db.prepare("SELECT 1 FROM document_reminder_deliveries WHERE document_id=? AND rule_id=? AND due_date=?").get(documentId, ruleId, dueDate)); }
  function listDueInvoiceReminders({ as_of = today(), limit = 50 } = {}) {
    const asOf = dateOnly(as_of, "as_of"); const rules = listReminderRules().filter((rule) => rule.active); const candidates = [];
    const documents = db.prepare("SELECT * FROM documents WHERE document_type='invoice' AND status IN ('sent','partially_paid','overdue') AND balance_due_minor>0 ORDER BY issued_at,number").all().map((row) => rowDocument(row));
    for (const document of documents) {
      const data = document.snapshot || document.data; if (!data?.due_date) continue;
      let dueDate; try { dueDate = dateOnly(data.due_date, "due_date"); } catch { continue; }
      const dueRules = rules.map((rule) => ({ rule, scheduled_for: addDays(dueDate, rule.offset_days) }))
        .filter((entry) => entry.scheduled_for <= asOf && !hasReminderDelivery(document.id, entry.rule.id, dueDate))
        .sort((a, b) => b.scheduled_for.localeCompare(a.scheduled_for) || b.rule.offset_days - a.rule.offset_days);
      if (!dueRules.length) continue;
      const [selected, ...skipped] = dueRules;
      candidates.push({ document, rule: selected.rule, due_date: dueDate, scheduled_for: selected.scheduled_for, days_overdue: Math.max(0, daysBetween(asOf, dueDate)), balance_due_minor: document.balance_due_minor, currency: data.currency || "ZAR", customer: data.customer || {}, skipped_rules: skipped.map((entry) => ({ rule: entry.rule, scheduled_for: entry.scheduled_for })) });
      if (candidates.length >= Number(limit || 50)) break;
    }
    return candidates;
  }
  function listReminderDeliveries(documentId) {
    let sql = "SELECT * FROM document_reminder_deliveries"; const values = [];
    if (documentId) { sql += " WHERE document_id=?"; values.push(documentId); }
    return db.prepare(`${sql} ORDER BY created_at DESC`).all(...values).map(reminderDelivery);
  }
  function claimInvoiceReminder(input = {}) {
    const documentId = input.document_id || input.document?.id; const ruleId = input.rule_id || input.rule?.id; const document = getDocument(documentId); const rule = getReminderRule(ruleId);
    if (!document || document.document_type !== "invoice") throw error("Invoice not found", 404, "NOT_FOUND");
    if (!rule) throw error("Reminder rule not found", 404, "NOT_FOUND");
    const dueDate = dateOnly(input.due_date, "due_date"); const scheduledFor = dateOnly(input.scheduled_for || addDays(dueDate, rule.offset_days), "scheduled_for"); const timestamp = now();
    const skippedRuleIds = Array.isArray(input.skipped_rule_ids) ? input.skipped_rule_ids : (input.skipped_rules || []).map((item) => item.rule?.id || item.rule_id).filter(Boolean);
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const skippedRuleId of skippedRuleIds) {
        const skipped = getReminderRule(skippedRuleId); if (!skipped) continue;
        const skippedFor = addDays(dueDate, skipped.offset_days);
        if (!hasReminderDelivery(document.id, skipped.id, dueDate)) db.prepare("INSERT INTO document_reminder_deliveries(id,document_id,rule_id,due_date,scheduled_for,attempt_id,status,provider_error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(randomUUID(), document.id, skipped.id, dueDate, skippedFor, null, "skipped_catchup", "A newer reminder was already due during catch-up.", timestamp, timestamp);
      }
      const existing = db.prepare("SELECT * FROM document_reminder_deliveries WHERE document_id=? AND rule_id=? AND due_date=?").get(document.id, rule.id, dueDate);
      if (existing) { db.exec("COMMIT"); return { claimed: false, delivery: reminderDelivery(existing) }; }
      const id = randomUUID();
      db.prepare("INSERT INTO document_reminder_deliveries(id,document_id,rule_id,due_date,scheduled_for,attempt_id,status,provider_error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, document.id, rule.id, dueDate, scheduledFor, null, "sending", null, timestamp, timestamp);
      audit(document.id, "reminder_send_started", { rule_id: rule.id, due_date: dueDate, scheduled_for: scheduledFor });
      db.exec("COMMIT");
      return { claimed: true, delivery: reminderDelivery(db.prepare("SELECT * FROM document_reminder_deliveries WHERE id=?").get(id)) };
    } catch (cause) { db.exec("ROLLBACK"); throw cause; }
  }
  function completeInvoiceReminderDelivery(deliveryId, attempt = {}) {
    const row = db.prepare("SELECT * FROM document_reminder_deliveries WHERE id=?").get(deliveryId); if (!row) throw error("Reminder delivery not found", 404, "NOT_FOUND");
    const status = attempt.provider_status || attempt.status || "failed"; const timestamp = now();
    db.prepare("UPDATE document_reminder_deliveries SET attempt_id=?,status=?,provider_error=?,updated_at=? WHERE id=?").run(attempt.id || null, status, attempt.provider_error || attempt.error || null, timestamp, deliveryId);
    audit(row.document_id, String(status).startsWith("accepted") ? "reminder_send_accepted" : "reminder_send_failed", { rule_id: row.rule_id, due_date: row.due_date, attempt_id: attempt.id || null });
    return reminderDelivery(db.prepare("SELECT * FROM document_reminder_deliveries WHERE id=?").get(deliveryId));
  }

  function recurringRuns(scheduleId) {
    return db.prepare("SELECT runs.id,runs.run_date,runs.created_at,documents.id AS document_id,documents.number,documents.status,documents.totals_json FROM recurring_schedule_runs runs JOIN documents ON documents.id=runs.document_id WHERE runs.schedule_id=? ORDER BY runs.run_date DESC").all(scheduleId).map((run) => ({ ...run, totals: json(run.totals_json), totals_json: undefined }));
  }
  function rowRecurringSchedule(row) {
    if (!row) return null;
    return { id: row.id, source_document_id: row.source_document_id || null, name: row.name, frequency: row.frequency, next_run_on: row.next_run_on, ends_on: row.ends_on || null, active: Boolean(row.active), data: json(row.data_json), last_run_on: row.last_run_on || null, generated_count: row.generated_count, created_at: row.created_at, updated_at: row.updated_at, runs: recurringRuns(row.id) };
  }
  function getRecurringSchedule(id) { return rowRecurringSchedule(db.prepare("SELECT * FROM recurring_schedules WHERE id=?").get(id)); }
  function listRecurringSchedules() { return db.prepare("SELECT * FROM recurring_schedules ORDER BY active DESC,next_run_on,name").all().map(rowRecurringSchedule); }
  function schedulePayload(input = {}, existing) {
    const sourceDocumentId = input.source_document_id === undefined ? existing?.source_document_id || null : input.source_document_id || null;
    const source = sourceDocumentId ? getDocument(sourceDocumentId, { sensitive: true }) : null;
    if (sourceDocumentId && !source) throw error("Source invoice not found", 404, "NOT_FOUND");
    if (source && source.document_type !== "invoice") throw error("Recurring schedules can only use an invoice as their source");
    if (!source && !input.data && !existing?.data) throw error("A source invoice or recurring invoice data is required");
    const nextRunOn = dateOnly(input.next_run_on ?? existing?.next_run_on ?? today(), "next_run_on");
    const endsOn = input.ends_on === undefined ? existing?.ends_on || null : input.ends_on || null;
    if (endsOn && dateOnly(endsOn, "ends_on") < nextRunOn) throw error("ends_on cannot be before next_run_on");
    const frequency = input.frequency ?? existing?.frequency ?? "monthly";
    if (!RECURRING_FREQUENCIES.includes(frequency)) throw error("frequency must be weekly, monthly, quarterly, or yearly");
    const sourceData = source ? (source.snapshot || source.data) : {};
    const dataInput = input.data ?? existing?.data ?? sourceData;
    const termsDays = Math.max(0, Number(dataInput.terms_days) || getBusinessProfile().default_terms_days || 30);
    const data = normalizeData({ ...dataInput, document_type: "invoice", document_title: dataInput.document_title || "Tax Invoice", number: "", issue_date: nextRunOn, due_date: addDays(nextRunOn, termsDays), terms_days: termsDays }, "invoice", "");
    const name = String(input.name ?? existing?.name ?? `${data.customer?.name || "Client"} recurring invoice`).trim();
    if (!name || name.length > 120) throw error("Schedule name must be between 1 and 120 characters");
    return { source_document_id: sourceDocumentId, name, frequency, next_run_on: nextRunOn, ends_on: endsOn ? dateOnly(endsOn, "ends_on") : null, active: input.active === undefined ? (existing ? Boolean(existing.active) : true) : Boolean(input.active), data };
  }
  function saveRecurringSchedule(input = {}, id = input.id || randomUUID()) {
    const existing = db.prepare("SELECT * FROM recurring_schedules WHERE id=?").get(id);
    if (input.id && !existing) throw error("Recurring schedule not found", 404, "NOT_FOUND");
    const payload = schedulePayload(input, existing && rowRecurringSchedule(existing)); const timestamp = now();
    db.prepare("INSERT INTO recurring_schedules(id,source_document_id,name,frequency,next_run_on,ends_on,active,data_json,last_run_on,generated_count,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET source_document_id=excluded.source_document_id,name=excluded.name,frequency=excluded.frequency,next_run_on=excluded.next_run_on,ends_on=excluded.ends_on,active=excluded.active,data_json=excluded.data_json,updated_at=excluded.updated_at")
      .run(id, payload.source_document_id, payload.name, payload.frequency, payload.next_run_on, payload.ends_on, payload.active ? 1 : 0, JSON.stringify(payload.data), existing?.last_run_on || null, existing?.generated_count || 0, existing?.created_at || timestamp, timestamp);
    return getRecurringSchedule(id);
  }
  function setRecurringScheduleActive(id, active) {
    if (!getRecurringSchedule(id)) throw error("Recurring schedule not found", 404, "NOT_FOUND");
    db.prepare("UPDATE recurring_schedules SET active=?,updated_at=? WHERE id=?").run(active ? 1 : 0, now(), id);
    return getRecurringSchedule(id);
  }
  function createRecurringRun(row, runDate) {
    const schedule = rowRecurringSchedule(row); const termsDays = Math.max(0, Number(schedule.data.terms_days) || getBusinessProfile().default_terms_days || 30);
    const document = insertDocument({ ...schedule.data, document_type: "invoice", number: undefined, issue_date: runDate, due_date: addDays(runDate, termsDays), terms_days: termsDays }, "invoice", { recurring_schedule_id: schedule.id });
    db.prepare("INSERT INTO recurring_schedule_runs(id,schedule_id,run_date,document_id,created_at) VALUES(?,?,?,?,?)").run(randomUUID(), schedule.id, runDate, document.id, now());
    const nextRunOn = nextRecurringDate(runDate, schedule.frequency);
    db.prepare("UPDATE recurring_schedules SET last_run_on=?,next_run_on=?,generated_count=generated_count+1,updated_at=? WHERE id=?").run(runDate, nextRunOn, now(), schedule.id);
    audit(document.id, "recurring_generated", { schedule_id: schedule.id, run_date: runDate });
    return document;
  }
  function runDueRecurringSchedules({ as_of = today(), schedule_id } = {}) {
    const until = dateOnly(as_of, "as_of"); const generated = [];
    db.exec("BEGIN IMMEDIATE");
    try {
      const rows = schedule_id ? [db.prepare("SELECT * FROM recurring_schedules WHERE id=?").get(schedule_id)] : db.prepare("SELECT * FROM recurring_schedules WHERE active=1 AND next_run_on<=? ORDER BY next_run_on,id").all(until);
      if (schedule_id && !rows[0]) throw error("Recurring schedule not found", 404, "NOT_FOUND");
      for (const initial of rows.filter(Boolean)) {
        let row = initial;
        while (row.active && row.next_run_on <= until && (!row.ends_on || row.next_run_on <= row.ends_on)) {
          const duplicate = db.prepare("SELECT document_id FROM recurring_schedule_runs WHERE schedule_id=? AND run_date=?").get(row.id, row.next_run_on);
          if (duplicate) db.prepare("UPDATE recurring_schedules SET next_run_on=?,updated_at=? WHERE id=?").run(nextRecurringDate(row.next_run_on, row.frequency), now(), row.id);
          else generated.push(createRecurringRun(row, row.next_run_on));
          row = db.prepare("SELECT * FROM recurring_schedules WHERE id=?").get(row.id);
        }
        if (row.active && row.ends_on && row.next_run_on > row.ends_on) db.prepare("UPDATE recurring_schedules SET active=0,updated_at=? WHERE id=?").run(now(), row.id);
      }
      db.exec("COMMIT");
    } catch (cause) { db.exec("ROLLBACK"); throw cause; }
    return { documents: generated, schedules: schedule_id ? [getRecurringSchedule(schedule_id)] : listRecurringSchedules() };
  }

  function getInvoice(id) { const document = getDocument(id, { sensitive: true }); return document?.document_type === "invoice" ? document : null; }
  function listInvoices() { return listDocuments({ document_type: "invoice" }); }
  function listCustomers(query = "") { const q = `%${query}%`; return db.prepare("SELECT * FROM customers WHERE name LIKE ? OR email LIKE ? ORDER BY updated_at DESC").all(q, q).map((row) => ({ ...row, vat_registered: Boolean(row.vat_registered) })); }
  function getCustomer(id) { const row = db.prepare("SELECT * FROM customers WHERE id=?").get(id); return row && { ...row, vat_registered: Boolean(row.vat_registered) }; }
  function saveCustomer(input, id = randomUUID()) { if (!input.name) throw error("Customer name is required"); const timestamp = now(); db.prepare("INSERT INTO customers(id,name,contact_name,email,phone,address,country,vat_number,registration_number,notes,vat_registered,currency,terms_days,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,contact_name=excluded.contact_name,email=excluded.email,phone=excluded.phone,address=excluded.address,country=excluded.country,vat_number=excluded.vat_number,registration_number=excluded.registration_number,notes=excluded.notes,vat_registered=excluded.vat_registered,currency=excluded.currency,terms_days=excluded.terms_days,updated_at=excluded.updated_at").run(id, input.name, input.contact_name || "", input.email || "", input.phone || "", input.address || "", input.country || "South Africa", input.vat_number || "", input.registration_number || "", input.notes || "", input.vat_registered ? 1 : 0, input.currency || "ZAR", Number(input.terms_days) || 30, timestamp, timestamp); return getCustomer(id); }
  function listProducts(query = "") { const q = `%${query}%`; return db.prepare("SELECT * FROM products WHERE name LIKE ? OR description LIKE ? ORDER BY updated_at DESC").all(q, q); }
  function saveProduct(input, id = randomUUID()) { if (!input.name) throw error("Product name is required"); asMinor(input.unit_price_minor || 0, "unit_price_minor"); const timestamp = now(); db.prepare("INSERT INTO products(id,name,description,unit_price_minor,tax_bps,currency,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,unit_price_minor=excluded.unit_price_minor,tax_bps=excluded.tax_bps,currency=excluded.currency,updated_at=excluded.updated_at").run(id, input.name, input.description || "", Math.round(Number(input.unit_price_minor) || 0), Math.round(Number(input.tax_bps) || 0), input.currency || "ZAR", timestamp, timestamp); return db.prepare("SELECT * FROM products WHERE id=?").get(id); }

  function seed() {
    let profileSetting = getSetting("business_profile", null);
    if (!profileSetting) {
      saveBusinessProfile(DEFAULT_PROFILE);
    } else if (profileSetting.name === "Moneyfy Studio") {
      const migratedProfile = { ...profileSetting, name: "Forma Studio" };
      if (migratedProfile.email === "billing@moneyfy.co.za") migratedProfile.email = "billing@forma.co.za";
      saveBusinessProfile(migratedProfile);
    }
    if (!db.prepare("SELECT COUNT(*) AS count FROM branding_presets").get().count) saveBrandingPreset({ id: "default", name: "Forma default", template_id: "classic", accent: "#7f56d9" });
    for (const template of Object.values(DEFAULT_EMAIL_TEMPLATES)) if (!db.prepare("SELECT purpose FROM email_templates WHERE purpose=?").get(template.purpose)) saveEmailTemplate(template);
    for (const rule of DEFAULT_REMINDER_RULES) if (!db.prepare("SELECT id FROM reminder_rules WHERE id=?").get(rule.id)) saveReminderRule({ label: rule.label, offset_days: rule.offset_days, purpose: rule.purpose, active: rule.active }, rule.id);
    if (db.prepare("SELECT COUNT(*) AS count FROM customers").get().count) return;
    const timestamp = now(); const customers = [["vertex", "Vertex Labs", "finance@vertexlabs.co.za", "12 Loop Street, Cape Town, 8001", "South Africa", "4780123456", 1, "ZAR", 30], ["acme", "Acme Enterprise", "accounts@acme.co.za", "44 Oxford Road, Rosebank, Johannesburg, 2196", "South Africa", "", 0, "ZAR", 14], ["northstar", "Northstar Capital", "ap@northstar.com", "401 Bay Street, Toronto, ON", "Canada", "", 0, "USD", 30]]; const insertCustomer = db.prepare("INSERT INTO customers(id,name,email,address,country,vat_number,vat_registered,currency,terms_days,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)"); customers.forEach((row) => insertCustomer.run(...row, timestamp, timestamp)); const products = [["strategy", "Finance systems advisory", "Discovery and finance workflow design", 185000, 1500, "ZAR"], ["automation", "Invoice automation setup", "Implementation and workflow automation", 420000, 1500, "ZAR"], ["retainer", "Operations retainer", "Monthly finance operations support", 240000, 1500, "ZAR"]]; const insertProduct = db.prepare("INSERT INTO products(id,name,description,unit_price_minor,tax_bps,currency,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)"); products.forEach((row) => insertProduct.run(...row, timestamp, timestamp)); const customer = getCustomer("vertex"); createDraft({ customer_id: customer.id, customer, terms_days: customer.terms_days, items: [{ product_id: "strategy", description: "Finance systems advisory", quantity: 1, unit_price_minor: 185000, tax_bps: 1500, discount_bps: 0 }, { product_id: "automation", description: "Invoice automation setup", quantity: 1, unit_price_minor: 420000, tax_bps: 1500, discount_bps: 0 }] });
  }
  migrateLegacyInvoices(); seed();
  return { db, close: () => db.close(), setting, getSetting, getBusinessProfile, saveBusinessProfile, prefixes, savePrefixes, allocateNumber, createDocument, getDocument, listDocuments, updateDocument, finalizeDocument, transitionDocument, convertQuote, recordPayment, listPayments, beginPaymentCheckout, completePaymentCheckout, getPaymentCheckout, listPaymentCheckouts, processPaymentWebhook, savePortalLink, listPortalLinks, revokePortalLink, resolvePortalLink, portalQuoteAction, createDraft, updateDraft, finalize, transition, duplicate, getInvoice, listInvoices, listAudit, listCustomers, getCustomer, saveCustomer, listProducts, saveProduct, getPaymentMethod, listPaymentMethods, savePaymentMethod, setDefaultPaymentMethod, saveMediaAsset, getMediaAsset, deleteMediaAsset, listBrandingPresets, saveBrandingPreset, listEmailTemplates, getEmailTemplate, saveEmailTemplate, restoreEmailTemplate, createEmailDraft, beginDocumentEmail, completeDocumentEmail, sendDocument, listEmailHistory, listRetryableEmailAttempts, claimEmailRetry, processResendWebhook, listReminderRules, getReminderRule, saveReminderRule, setReminderRuleActive, listDueInvoiceReminders, claimInvoiceReminder, completeInvoiceReminderDelivery, listReminderDeliveries, getRecurringSchedule, listRecurringSchedules, saveRecurringSchedule, setRecurringScheduleActive, runDueRecurringSchedules };
}
