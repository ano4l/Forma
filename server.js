import express from "express";
import path from "node:path";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";
import { createStore } from "./db.js";
import { createSupabaseStore } from "./supabase-store.js";
import { createDocumentPdf, renderDocumentPdf } from "./pdf.js";
import { parseQuickCreate } from "./parser.js";
import { listTemplates } from "./templates.js";
import { emailProviderStatus, sendTransactionalEmail } from "./email-provider.js";
import { createAuthMiddleware, resolveAuthConfig } from "./auth.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BRAND_LOGO = "VKT-logo.png";
const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const safeFilename = (value = "logo") => path.basename(String(value)).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 100) || "logo";
const csvCell = (value = "") => {
  const text = String(value ?? "").replace(/\r?\n/g, " ");
  const protectedText = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${protectedText.replaceAll('"', '""')}"`;
};
const csvMinor = (value = 0) => (Math.round(Number(value) || 0) / 100).toFixed(2);
function receivablesCsv(documents) {
  const headers = ["Document number", "Type", "Status", "Customer", "Customer email", "Issue date", "Due or expiry date", "Currency", "Subtotal", "Discount", "Tax", "Shipping", "Total", "Amount paid", "Balance due", "Recurring schedule ID", "Created at", "Updated at"];
  const rows = documents.map((document) => {
    const data = document.snapshot || document.data || {}; const totals = document.totals || {};
    return [document.number, document.document_type, document.status, data.customer?.name || "", data.customer?.email || "", data.issue_date || "", document.document_type === "quote" ? data.expiry_date || data.due_date || "" : data.due_date || "", data.currency || "", csvMinor(totals.subtotal_minor), csvMinor(totals.discount_minor), csvMinor(totals.tax_minor), csvMinor(totals.shipping_minor), csvMinor(totals.total_minor), csvMinor(document.amount_paid_minor), csvMinor(document.balance_due_minor), document.recurring_schedule_id || "", document.created_at, document.updated_at];
  });
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
function imageInfo(buffer, contentType) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw Object.assign(new Error("Upload a non-empty logo file"), { status: 422, code: "VALIDATION_ERROR" });
  if (buffer.length > MAX_LOGO_BYTES) throw Object.assign(new Error("Logo must be smaller than 2 MB"), { status: 413, code: "PAYLOAD_TOO_LARGE" });
  if (contentType === "image/png" && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { extension: "png", contentType };
  if (contentType === "image/jpeg" && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { extension: "jpg", contentType };
  if (contentType === "image/webp" && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return { extension: "webp", contentType };
  if (contentType === "image/svg+xml") { const source = buffer.toString("utf8").replace(/^\uFEFF/, "").trim(); if (/^<svg[\s>]/i.test(source) && !/<script\b|<foreignObject\b|\son\w+\s*=/i.test(source)) return { extension: "svg", contentType }; }
  throw Object.assign(new Error("Upload a valid PNG, JPG, WebP, or safe SVG image"), { status: 422, code: "VALIDATION_ERROR" });
}
function attachmentInfo(buffer, contentType) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw Object.assign(new Error("Upload a non-empty attachment"), { status: 422, code: "VALIDATION_ERROR" });
  if (buffer.length > MAX_ATTACHMENT_BYTES) throw Object.assign(new Error("Attachment must be smaller than 10 MB"), { status: 413, code: "PAYLOAD_TOO_LARGE" });
  if (contentType === "application/pdf" && buffer.subarray(0, 5).toString("ascii") === "%PDF-") return { extension: "pdf", contentType };
  return imageInfo(buffer, contentType);
}

export function createApp({ database = process.env.FORMA_DB || process.env.MONEYFY_DB || path.join(root, "moneyfy.sqlite"), uploadDir = process.env.FORMA_UPLOAD_DIR || process.env.MONEYFY_UPLOAD_DIR || path.join(root, "uploads"), staticRoot = root, dataBackend = process.env.FORMA_DATA_BACKEND || "sqlite", authOptions = {} } = {}) {
  const app = express();
  const tenantContext = new AsyncLocalStorage();
  const normalizedBackend = String(dataBackend).trim().toLowerCase();
  const store = normalizedBackend === "supabase" ? createSupabaseStore({ getAuth: () => tenantContext.getStore() }) : createStore(database);
  app.locals.store = store;
  app.use(express.json({ limit: "1mb" }));
  const route = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
  const authMiddleware = createAuthMiddleware({ config: authOptions.config || resolveAuthConfig(), fetchImpl: authOptions.fetchImpl || globalThis.fetch });
  app.locals.authConfig = authMiddleware.publicConfig;
  app.locals.dataBackend = normalizedBackend;
  app.locals.tenantStoreReady = normalizedBackend === "supabase" && authMiddleware.publicConfig.configured && Boolean(authMiddleware.config.serviceRoleKey);
  const found = (document, label = "Document") => { if (!document) throw Object.assign(new Error(`${label} not found`), { status: 404, code: "NOT_FOUND" }); return document; };
  const safeAssetPath = (asset) => {
    const target = path.resolve(uploadDir, asset.storage_key);
    if (!target.startsWith(path.resolve(uploadDir) + path.sep)) throw Object.assign(new Error("Asset path is invalid"), { status: 500, code: "INTERNAL_ERROR" });
    return target;
  };
  const hostedStorage = normalizedBackend === "supabase";
  const writeAsset = async (asset, content) => hostedStorage ? store.uploadObject(asset.storage_key, content, asset.content_type) : (await mkdir(path.dirname(safeAssetPath(asset)), { recursive: true }), writeFile(safeAssetPath(asset), content, { flag: "wx" }));
  const readAsset = async (asset) => hostedStorage ? store.downloadObject(asset.storage_key) : readFile(safeAssetPath(asset)).catch(() => null);
  const removeAsset = async (asset) => hostedStorage ? store.deleteObject(asset.storage_key) : unlink(safeAssetPath(asset)).catch(() => {});
  async function pdfLogoFor(document) {
    const data = document.snapshot || document.data || {};
    const logoUrl = String(data.supplier?.logo_url || "").trim();
    const managedAsset = logoUrl.match(/^\/api\/assets\/([0-9a-f-]+)$/i);
    if (managedAsset) {
      const asset = await store.getMediaAsset(managedAsset[1]);
      if (asset && ["image/png", "image/jpeg"].includes(asset.content_type)) return readAsset(asset);
    }
    if (/^data:image\/(?:png|jpeg);base64,/i.test(logoUrl)) {
      const encoded = logoUrl.slice(logoUrl.indexOf(",") + 1);
      const buffer = Buffer.from(encoded, "base64");
      if (buffer.length && buffer.length <= MAX_LOGO_BYTES) return buffer;
    }
    return readFile(path.join(staticRoot, DEFAULT_BRAND_LOGO)).catch(() => null);
  }
  async function sendDocumentEmail(documentId, input = {}) {
    const provider = emailProviderStatus();
    const started = await store.beginDocumentEmail(documentId, input, provider.provider);
    if (started.idempotent) return started.attempt;
    let delivery;
    try {
      const pdf = await renderDocumentPdf(started.document, { logo: await pdfLogoFor(started.document) });
      delivery = await sendTransactionalEmail({ ...started.attempt.rendered, requestKey: started.attempt.request_key, attachment: { filename: `${started.document.number}.pdf`, content: pdf } });
    } catch {
      delivery = { accepted: false, status: "provider_error", error: "Could not prepare the document email" };
    }
    return await store.completeDocumentEmail(documentId, started.attempt.id, delivery);
  }

  app.get("/api/health", async (req, res) => res.json({ ok: true, email: emailProviderStatus(), auth: { mode: authMiddleware.publicConfig.mode, configured: authMiddleware.publicConfig.configured }, data_backend: normalizedBackend }));
  app.get("/api/auth/config", async (req, res) => res.json({ data: authMiddleware.publicConfig }));
  app.use("/api", authMiddleware);
  app.use("/api", (req, res, next) => normalizedBackend === "supabase" ? tenantContext.run(req.auth, next) : next());
  app.get("/api/session", async (req, res) => res.json({ data: { authenticated: Boolean(req.auth), user: req.auth?.user || null, memberships: req.auth?.memberships || [], workspace_id: req.auth?.workspaceId || null, role: req.auth?.role || null } }));
  app.post("/api/workspaces", route(async (req, res) => {
    if (!req.auth) throw Object.assign(new Error("Sign in to create a workspace"), { status: 401, code: "AUTHENTICATION_REQUIRED" });
    const name = String(req.body?.name || "").trim(); const slug = String(req.body?.slug || "").trim().toLowerCase();
    if (name.length < 2 || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) throw Object.assign(new Error("Enter a workspace name and a valid slug"), { status: 422, code: "VALIDATION_ERROR" });
    const result = await req.auth.supabaseFetch("/rest/v1/rpc/create_workspace", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ workspace_name: name, workspace_slug: slug }) });
    const payload = await result.json().catch(() => null);
    if (!result.ok) throw Object.assign(new Error(payload?.message || "Workspace could not be created"), { status: result.status, code: "WORKSPACE_CREATE_FAILED" });
    res.status(201).json({ data: Array.isArray(payload) ? payload[0] : payload });
  }));
  app.use("/api", (req, res, next) => {
    if (authMiddleware.publicConfig.mode !== "required") return next();
    if (!req.auth?.workspaceId) return res.status(409).json({ error: { code: "WORKSPACE_REQUIRED", message: "Select or create a workspace to continue" } });
    if (normalizedBackend !== "supabase" || !app.locals.tenantStoreReady) return res.status(503).json({ error: { code: "TENANT_STORE_NOT_CONFIGURED", message: "Tenant-safe Supabase persistence must be enabled before authenticated data access" } });
    return next();
  });

  app.post("/api/business-logo", express.raw({ type: ["image/png", "image/jpeg", "image/webp", "image/svg+xml"], limit: MAX_LOGO_BYTES }), route(async (req, res) => {
    const info = imageInfo(req.body, req.get("content-type")?.split(";")[0].trim().toLowerCase());
    const id = randomUUID(); const storageKey = hostedStorage ? path.posix.join(req.auth.workspaceId, "logos", `${id}.${info.extension}`) : path.posix.join("logos", `${id}.${info.extension}`); const pendingAsset = { storage_key: storageKey, content_type: info.contentType };
    await writeAsset(pendingAsset, req.body);
    let savedAsset = null;
    try {
      savedAsset = await store.saveMediaAsset({ id, storage_key: storageKey, filename: safeFilename(req.get("x-file-name")), content_type: info.contentType, byte_size: req.body.length });
      const profile = await store.saveBusinessProfile({ ...await store.getBusinessProfile(), logo_url: `/api/assets/${savedAsset.id}` });
      res.status(201).json({ data: { asset: { ...savedAsset, url: `/api/assets/${savedAsset.id}` }, profile } });
    } catch (cause) { if (savedAsset) await store.deleteMediaAsset(savedAsset.id).catch(() => null); await removeAsset(pendingAsset); throw cause; }
  }));
  app.get("/api/assets/:id", route(async (req, res) => {
    const asset = await store.getMediaAsset(req.params.id); if (!asset) throw Object.assign(new Error("Asset not found"), { status: 404, code: "NOT_FOUND" });
    const content = await readAsset(asset); if (!content) throw Object.assign(new Error("Asset data not found"), { status: 404, code: "NOT_FOUND" });
    res.type(asset.content_type).set("Cache-Control", "private, max-age=86400").send(content);
  }));

  // Shared-document APIs. GET by id is the explicit local-only sensitive retrieval route.
  app.get("/api/templates", async (req, res) => res.json({ data: listTemplates() }));
  app.get("/api/recurring-schedules", async (req, res) => res.json({ data: await store.listRecurringSchedules() }));
  app.post("/api/recurring-schedules", route(async (req, res) => res.status(201).json({ data: await store.saveRecurringSchedule(req.body || {}) })));
  app.put("/api/recurring-schedules/:id", route(async (req, res) => res.json({ data: await store.saveRecurringSchedule({ ...(req.body || {}), id: req.params.id }) })));
  app.post("/api/recurring-schedules/:id/pause", route(async (req, res) => res.json({ data: await store.setRecurringScheduleActive(req.params.id, false) })));
  app.post("/api/recurring-schedules/:id/resume", route(async (req, res) => res.json({ data: await store.setRecurringScheduleActive(req.params.id, true) })));
  app.post("/api/recurring-schedules/run-due", route(async (req, res) => res.json({ data: await store.runDueRecurringSchedules({ as_of: req.body?.as_of }) })));
  app.post("/api/recurring-schedules/:id/run-due", route(async (req, res) => res.json({ data: await store.runDueRecurringSchedules({ schedule_id: req.params.id, as_of: req.body?.as_of }) })));
  app.get("/api/reminders/rules", async (req, res) => res.json({ data: await store.listReminderRules() }));
  app.put("/api/reminders/rules/:id", route(async (req, res) => res.json({ data: await store.saveReminderRule({ ...(req.body || {}), id: req.params.id }) })));
  app.post("/api/reminders/rules/:id/pause", route(async (req, res) => res.json({ data: await store.setReminderRuleActive(req.params.id, false) })));
  app.post("/api/reminders/rules/:id/resume", route(async (req, res) => res.json({ data: await store.setReminderRuleActive(req.params.id, true) })));
  app.get("/api/reminders/due", route(async (req, res) => res.json({ data: await store.listDueInvoiceReminders({ as_of: req.query.as_of }) })));
  app.post("/api/reminders/run-due", route(async (req, res) => {
    const asOf = req.body?.as_of; const candidates = await store.listDueInvoiceReminders({ as_of: asOf }); const reminders = [];
    for (const candidate of candidates) {
      const claim = await store.claimInvoiceReminder(candidate);
      if (!claim.claimed) { reminders.push({ candidate, delivery: claim.delivery, skipped: true }); continue; }
      let attempt;
      try {
        attempt = await sendDocumentEmail(candidate.document.id, { purpose: candidate.rule.purpose, request_key: `reminder:${candidate.rule.id}:${candidate.document.id}:${candidate.due_date}` });
      } catch (cause) {
        attempt = { provider_status: "failed", provider_error: cause.message || "Reminder could not be sent" };
      }
      const delivery = await store.completeInvoiceReminderDelivery(claim.delivery.id, attempt);
      if (String(attempt.provider_status || "").startsWith("accepted") && candidate.days_overdue > 0) {
        const current = await store.getDocument(candidate.document.id);
        if (current && ["finalized", "sent", "partially_paid"].includes(current.status)) await store.transitionDocument(current.id, "overdue", "overdue");
      }
      reminders.push({ candidate, attempt, delivery });
    }
    res.status(202).json({ data: { reminders, rules: await store.listReminderRules(), due: await store.listDueInvoiceReminders({ as_of: asOf }) } });
  }));
  app.get("/api/exports/receivables.csv", route(async (req, res) => {
    const documents = await store.listDocuments({ document_type: req.query.document_type || undefined, status: req.query.status || undefined });
    res.type("text/csv").attachment(`forma-receivables-${new Date().toISOString().slice(0, 10)}.csv`).send(receivablesCsv(documents));
  }));
  app.get("/api/documents", route(async (req, res) => res.json({ data: await store.listDocuments({ document_type: req.query.document_type || req.query.type, status: req.query.status }) })));
  app.post("/api/documents", route(async (req, res) => res.status(201).json({ data: await store.createDocument(req.body || {}) })));
  app.get("/api/documents/:id", route(async (req, res) => res.json({ data: found(await store.getDocument(req.params.id, { sensitive: true })) })));
  app.put("/api/documents/:id", route(async (req, res) => res.json({ data: await store.updateDocument(req.params.id, req.body || {}) })));
  app.post("/api/documents/:id/finalize", route(async (req, res) => res.json({ data: await store.finalizeDocument(req.params.id) })));
  app.post("/api/documents/:id/accept", route(async (req, res) => res.json({ data: await store.transitionDocument(req.params.id, "accepted", "accepted") })));
  app.post("/api/documents/:id/decline", route(async (req, res) => res.json({ data: await store.transitionDocument(req.params.id, "declined", "declined") })));
  app.post("/api/documents/:id/expire", route(async (req, res) => res.json({ data: await store.transitionDocument(req.params.id, "expired", "expired") })));
  app.post("/api/documents/:id/convert-to-invoice", route(async (req, res) => res.status(201).json({ data: await store.convertQuote(req.params.id) })));
  app.post("/api/documents/:id/record-payment", route(async (req, res) => res.status(201).json({ data: await store.recordPayment(req.params.id, req.body || {}) })));
  app.post("/api/documents/:id/attachments", express.raw({ type: ["application/pdf", "image/png", "image/jpeg", "image/webp", "image/svg+xml"], limit: MAX_ATTACHMENT_BYTES }), route(async (req, res) => {
    const document = found(await store.getDocument(req.params.id, { sensitive: true })); if (document.status !== "draft") throw Object.assign(new Error("Attachments can only be changed on drafts"), { status: 409, code: "CONFLICT" });
    const info = attachmentInfo(req.body, req.get("content-type")?.split(";")[0].trim().toLowerCase());
    const id = randomUUID(); const storageKey = hostedStorage ? path.posix.join(req.auth.workspaceId, "documents", document.id, `${id}.${info.extension}`) : path.posix.join("documents", document.id, `${id}.${info.extension}`); const pendingAsset = { storage_key: storageKey, content_type: info.contentType };
    await writeAsset(pendingAsset, req.body);
    let savedAsset = null;
    try {
      savedAsset = await store.saveMediaAsset({ id, storage_key: storageKey, filename: safeFilename(req.get("x-file-name") || `attachment.${info.extension}`), content_type: info.contentType, byte_size: req.body.length });
      const attachment = { asset_id: savedAsset.id, name: savedAsset.filename, content_type: savedAsset.content_type, byte_size: savedAsset.byte_size, url: `/api/assets/${savedAsset.id}`, added_at: savedAsset.created_at };
      const updated = await store.updateDocument(document.id, { ...document.data, attachments: [...(document.data.attachments || []), attachment] });
      res.status(201).json({ data: { document: updated, attachment } });
    } catch (cause) { if (savedAsset) await store.deleteMediaAsset(savedAsset.id).catch(() => null); await removeAsset(pendingAsset); throw cause; }
  }));
  app.delete("/api/documents/:id/attachments/:assetId", route(async (req, res) => {
    const document = found(await store.getDocument(req.params.id, { sensitive: true })); if (document.status !== "draft") throw Object.assign(new Error("Attachments can only be changed on drafts"), { status: 409, code: "CONFLICT" });
    const attachment = (document.data.attachments || []).find((item) => item.asset_id === req.params.assetId); if (!attachment) throw Object.assign(new Error("Attachment not found on this document"), { status: 404, code: "NOT_FOUND" });
    const updated = await store.updateDocument(document.id, { ...document.data, attachments: document.data.attachments.filter((item) => item.asset_id !== req.params.assetId) });
    const asset = await store.deleteMediaAsset(req.params.assetId); if (asset) await removeAsset(asset);
    res.json({ data: updated });
  }));
  app.get("/api/documents/:id/payments", route(async (req, res) => { found(await store.getDocument(req.params.id)); res.json({ data: await store.listPayments(req.params.id) }); }));
  app.post("/api/documents/:id/void", route(async (req, res) => res.json({ data: await store.transitionDocument(req.params.id, "void", "voided") })));
  app.get("/api/documents/:id/audit", route(async (req, res) => { found(await store.getDocument(req.params.id)); res.json({ data: await store.listAudit(req.params.id) }); }));
  app.get("/api/documents/:id/pdf", route(async (req, res) => { const document = found(await store.getDocument(req.params.id, { sensitive: true })); createDocumentPdf(document, res, { logo: await pdfLogoFor(document) }); }));
  app.post("/api/documents/:id/email-drafts", route(async (req, res) => res.json({ data: await store.createEmailDraft(req.params.id, req.body || {}) })));
  app.post("/api/documents/:id/send", route(async (req, res) => {
    const attempt = await sendDocumentEmail(req.params.id, req.body || {});
    res.status(String(attempt.provider_status || "").startsWith("accepted") ? 202 : 200).json({ data: attempt });
  }));
  app.get("/api/documents/:id/email-history", route(async (req, res) => { found(await store.getDocument(req.params.id)); res.json({ data: await store.listEmailHistory(req.params.id) }); }));

  app.post("/api/quick-create/parse", route(async (req, res) => res.json({ data: parseQuickCreate(req.body?.text, { defaultCurrency: (await store.getBusinessProfile()).default_currency }) })));
  app.get("/api/business-profile", async (req, res) => res.json({ data: await store.getBusinessProfile(), caveat: "Local no-auth mode: selected document retrieval may include full payment details." }));
  app.put("/api/business-profile", route(async (req, res) => res.json({ data: await store.saveBusinessProfile(req.body || {}) })));
  app.get("/api/number-prefixes", async (req, res) => res.json({ data: await store.prefixes() }));
  app.put("/api/number-prefixes", route(async (req, res) => res.json({ data: await store.savePrefixes(req.body || {}) })));
  app.get("/api/branding-presets", async (req, res) => res.json({ data: await store.listBrandingPresets() }));
  app.post("/api/branding-presets", route(async (req, res) => res.status(201).json({ data: await store.saveBrandingPreset(req.body || {}) })));
  app.put("/api/branding-presets/:id", route(async (req, res) => res.json({ data: await store.saveBrandingPreset({ ...(req.body || {}), id: req.params.id }) })));
  app.get("/api/payment-methods", async (req, res) => res.json({ data: await store.listPaymentMethods(), caveat: "Account fields are masked in lists. Full fields are available only in an explicit selected-document read in this local no-auth service." }));
  app.post("/api/payment-methods", route(async (req, res) => res.status(201).json({ data: await store.savePaymentMethod(req.body || {}) })));
  app.put("/api/payment-methods/:id", route(async (req, res) => res.json({ data: await store.savePaymentMethod({ ...(req.body || {}), id: req.params.id }) })));
  app.post("/api/payment-methods/:id/default", route(async (req, res) => res.json({ data: await store.setDefaultPaymentMethod(req.params.id) })));
  app.get("/api/email-templates", async (req, res) => res.json({ data: await store.listEmailTemplates() }));
  app.put("/api/email-templates/:purpose", route(async (req, res) => res.json({ data: await store.saveEmailTemplate({ ...(req.body || {}), purpose: req.params.purpose }) })));
  app.post("/api/email-templates/:purpose/restore-default", route(async (req, res) => res.json({ data: await store.restoreEmailTemplate(req.params.purpose) })));

  // Invoice compatibility surface retained for the existing SPA.
  app.get("/api/customers", async (req, res) => res.json({ data: await store.listCustomers(req.query.q || "") }));
  app.post("/api/customers", route(async (req, res) => res.status(201).json({ data: await store.saveCustomer(req.body || {}) })));
  app.put("/api/customers/:id", route(async (req, res) => res.json({ data: await store.saveCustomer(req.body || {}, req.params.id) })));
  app.get("/api/products", async (req, res) => res.json({ data: await store.listProducts(req.query.q || "") }));
  app.post("/api/products", route(async (req, res) => res.status(201).json({ data: await store.saveProduct(req.body || {}) })));
  app.put("/api/products/:id", route(async (req, res) => res.json({ data: await store.saveProduct(req.body || {}, req.params.id) })));
  app.get("/api/invoices", async (req, res) => res.json({ data: await store.listInvoices() }));
  app.post("/api/invoices", route(async (req, res) => res.status(201).json({ data: await store.createDraft(req.body || {}) })));
  app.get("/api/invoices/:id", route(async (req, res) => res.json({ data: found(await store.getInvoice(req.params.id), "Invoice") })));
  app.put("/api/invoices/:id", route(async (req, res) => res.json({ data: await store.updateDraft(req.params.id, req.body || {}) })));
  app.post("/api/invoices/:id/finalize", route(async (req, res) => res.json({ data: await store.finalize(req.params.id, false) })));
  app.post("/api/invoices/:id/send", route(async (req, res) => res.json({ data: await store.finalize(req.params.id, true), integration: { email: "not_configured", pdf: `/api/invoices/${req.params.id}/pdf` } })));
  app.post("/api/invoices/:id/paid", route(async (req, res) => res.json({ data: await store.transition(req.params.id, "paid", ["finalized", "sent"], "paid") })));
  app.post("/api/invoices/:id/void", route(async (req, res) => res.json({ data: await store.transition(req.params.id, "void", ["finalized", "sent"], "voided") })));
  app.post("/api/invoices/:id/duplicate", route(async (req, res) => res.status(201).json({ data: await store.duplicate(req.params.id) })));
  app.get("/api/invoices/:id/audit", route(async (req, res) => { found(await store.getInvoice(req.params.id), "Invoice"); res.json({ data: await store.listAudit(req.params.id) }); }));
  app.get("/api/invoices/:id/pdf", route(async (req, res) => { const document = found(await store.getInvoice(req.params.id), "Invoice"); createDocumentPdf(document, res, { logo: await pdfLogoFor(document) }); }));

  app.use(express.static(staticRoot, { extensions: ["html"] }));
  app.get("/{*splat}", async (req, res) => res.sendFile(path.join(staticRoot, "index.html")));
  app.use((cause, req, res, next) => { if (res.headersSent) return next(cause); const status = cause.status || 500; res.status(status).json({ error: { code: cause.code || (status === 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR"), message: status === 500 ? "Something went wrong" : cause.message, details: cause.details } }); });
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 4173;
  createApp().listen(port, "127.0.0.1", () => console.log(`VirtuKey Forma running at http://127.0.0.1:${port}`));
}
