import express from "express";
import path from "node:path";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";
import { createStore } from "./db.js";
import { createSupabaseStore } from "./supabase-store.js";
import { createDocumentPdf, renderDocumentPdf } from "./pdf.js";
import { parseQuickCreate } from "./parser.js";
import { listTemplates } from "./templates.js";
import { emailProviderStatus, sendTransactionalEmail } from "./email-provider.js";
import { createAuthMiddleware, resolveAuthConfig } from "./auth.js";
import { capturePayPalOrder, createHostedPayment, createProviderRefund, paymentEventDetails, paymentProviderStatus, providerEventDetails, verifyPayPalWebhook, verifyStripeWebhook } from "./payment-provider.js";
import { resendEventDetails, verifyResendWebhook } from "./webhook-provider.js";
import { createObservability } from "./observability.js";
import { agingCsv, agingReport, collectionForecast, collectionForecastCsv, renderReceivablesReportPdf, taxCsv, taxReport } from "./reporting.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BRAND_LOGO = "VKT-logo.png";
const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const safeFilename = (value = "logo") => path.basename(String(value)).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 100) || "logo";
const htmlEscape = (value = "") => String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
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
  const observability = createObservability({ fetchImpl: authOptions.fetchImpl || globalThis.fetch });
  if (process.env.NODE_ENV === "production") app.set("trust proxy", 1);
  const tenantContext = new AsyncLocalStorage();
  const normalizedBackend = String(dataBackend).trim().toLowerCase();
  const store = normalizedBackend === "supabase" ? createSupabaseStore({ getAuth: () => tenantContext.getStore() }) : createStore(database);
  app.locals.store = store;
  const route = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
  const publicUrlFor = (req) => { const configured = String(process.env.FORMA_PUBLIC_URL || "").trim(); if (!configured) { if (process.env.NODE_ENV === "production") throw Object.assign(new Error("FORMA_PUBLIC_URL must be configured in production"), { status: 503, code: "PUBLIC_URL_NOT_CONFIGURED" }); return `${req.protocol}://${req.get("host")}`; } let url; try { url = new URL(configured); } catch { throw Object.assign(new Error("FORMA_PUBLIC_URL is invalid"), { status: 503, code: "PUBLIC_URL_NOT_CONFIGURED" }); } if (!['http:', 'https:'].includes(url.protocol) || (process.env.NODE_ENV === "production" && url.protocol !== 'https:')) throw Object.assign(new Error("FORMA_PUBLIC_URL must use HTTPS in production"), { status: 503, code: "PUBLIC_URL_NOT_CONFIGURED" }); return url.origin; };
  const rateWindows = new Map();
  const rateLimit = ({ name, limit, windowMs = 60000 }) => (req, res, next) => { const key = `${name}:${req.ip}`; const timestamp = Date.now(); let entry = rateWindows.get(key); if (!entry || entry.resetAt <= timestamp) entry = { count: 0, resetAt: timestamp + windowMs }; entry.count += 1; rateWindows.set(key, entry); if (rateWindows.size > 10000) for (const [candidate, value] of rateWindows) if (value.resetAt <= timestamp) rateWindows.delete(candidate); res.set("RateLimit-Limit", String(limit)).set("RateLimit-Remaining", String(Math.max(0, limit - entry.count))).set("RateLimit-Reset", String(Math.ceil(entry.resetAt / 1000))); if (entry.count > limit) return res.status(429).set("Retry-After", String(Math.ceil((entry.resetAt - timestamp) / 1000))).json({ error: { code: "RATE_LIMITED", message: "Too many requests; try again shortly" } }); return next(); };
  app.use((req, res, next) => { const requestId = String(req.get("x-request-id") || randomUUID()).slice(0, 128); req.requestId = requestId; res.set("X-Request-Id", requestId).set("X-Content-Type-Options", "nosniff").set("X-Frame-Options", "DENY").set("Referrer-Policy", "strict-origin-when-cross-origin").set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()").set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' https://*.supabase.co; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"); if (process.env.NODE_ENV === "production") res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains"); if (req.path.startsWith("/api/")) res.set("Cache-Control", "no-store"); const startedAt = performance.now(); res.on("finish", () => { const duration = performance.now() - startedAt; observability.recordRequest(res.statusCode, duration); if (process.env.NODE_ENV === "production" || process.env.FORMA_REQUEST_LOGS === "true") console.log(JSON.stringify({ level: "info", event: "http_request", request_id: requestId, method: req.method, path: req.route?.path || req.path, status: res.statusCode, duration_ms: Math.round(duration * 10) / 10, workspace_id: req.auth?.workspaceId || null, user_id: req.auth?.user?.id || null })); }); next(); });
  app.use(rateLimit({ name: "api", limit: Number(process.env.FORMA_RATE_LIMIT_PER_MINUTE) || 300 }));
  const authMiddleware = createAuthMiddleware({ config: authOptions.config || resolveAuthConfig(), fetchImpl: authOptions.fetchImpl || globalThis.fetch });
  const fetchImpl = authOptions.fetchImpl || globalThis.fetch;
  const serviceFetch = authMiddleware.config.serviceRoleKey ? (apiPath, options = {}) => fetchImpl(`${authMiddleware.config.url}${apiPath}`, { ...options, headers: { apikey: authMiddleware.config.serviceRoleKey, Authorization: `Bearer ${authMiddleware.config.serviceRoleKey}`, ...(options.headers || {}) } }) : null;
  const serviceRpc = async (name, body) => { if (!serviceFetch) throw Object.assign(new Error("The server-only Supabase mutation key is not configured"), { status: 503, code: "TENANT_STORE_NOT_CONFIGURED" }); const response = await serviceFetch(`/rest/v1/rpc/${name}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); const payload = await response.json().catch(() => null); if (!response.ok) throw Object.assign(new Error(payload?.message || "Provider event could not be reconciled"), { status: response.status, code: "PROVIDER_RECONCILIATION_FAILED" }); return payload; };
  const processPaymentEvent = async (provider, details) => normalizedBackend === "supabase" ? serviceRpc("process_payment_provider_event", { target_provider: provider, target_event_id: details.eventId, target_event_type: details.type, target_checkout_id: details.checkoutId || null, target_provider_checkout_id: details.providerCheckoutId || null, target_provider_payment_id: details.providerPaymentId || null, target_amount: details.amountMinor, target_currency: details.currency, target_success: details.successful, target_failed: details.failed, target_payload: details.raw }) : store.processPaymentWebhook(provider, details);
  const processRefundEvent = async (provider, details) => normalizedBackend === "supabase" ? serviceRpc("process_payment_refund_event", { target_provider: provider, target_event_id: details.eventId, target_event_type: details.type, target_refund_id: details.refundId || null, target_checkout_id: details.checkoutId || null, target_provider_refund_id: details.providerRefundId || null, target_provider_payment_id: details.providerPaymentId || null, target_amount: details.amountMinor, target_currency: details.currency, target_status: details.status, target_success: details.successful, target_failed: details.failed, target_payload: details.raw }) : store.processRefundWebhook(provider, details);
  const processDisputeEvent = async (provider, details) => normalizedBackend === "supabase" ? serviceRpc("process_payment_dispute_event", { target_provider: provider, target_event_id: details.eventId, target_event_type: details.type, target_provider_dispute_id: details.providerDisputeId, target_provider_payment_id: details.providerPaymentId || null, target_amount: details.amountMinor, target_currency: details.currency, target_status: details.status, target_reason: details.reason, target_payload: details.raw }) : store.processDisputeWebhook(provider, details);
  const processProviderEvent = (provider, details) => details.kind === "refund" ? processRefundEvent(provider, details) : details.kind === "dispute" ? processDisputeEvent(provider, details) : processPaymentEvent(provider, details);
  const capturePaymentCheckout = async (checkout) => { if (!checkout || checkout.provider !== "paypal") throw Object.assign(new Error("PayPal payment checkout not found"), { status: 404, code: "NOT_FOUND" }); if (checkout.status === "paid") return { checkout, idempotent: true }; const captured = await capturePayPalOrder(checkout.provider_checkout_id, { fetchImpl, requestKey: `capture:${checkout.id}` }); const capture = captured.purchase_units?.flatMap((unit) => unit.payments?.captures || [])[0]; const event = { id: `paypal-capture:${capture?.id || captured.id}`, event_type: capture?.status === "COMPLETED" ? "PAYMENT.CAPTURE.COMPLETED" : "PAYMENT.CAPTURE.PENDING", resource: { ...(capture || {}), supplementary_data: { related_ids: { order_id: captured.id } } } }; return { checkout, provider: captured, reconciliation: await processPaymentEvent("paypal", paymentEventDetails("paypal", event)) }; };
  const portalTokenHash = (req) => { const token = String(req.get("x-forma-portal-token") || ""); if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw Object.assign(new Error("Portal link is invalid or expired"), { status: 404, code: "PORTAL_LINK_INVALID" }); return createHash("sha256").update(token).digest("hex"); };
  const mapPublicPortal = (payload) => { if (!payload) throw Object.assign(new Error("Portal link is invalid or expired"), { status: 404, code: "PORTAL_LINK_INVALID" }); const row = payload.document; const document = row.data_json ? { id: row.id, number: row.number, document_type: row.document_type, status: row.status, data: row.snapshot_json || row.data_json || {}, totals: row.totals_json || {}, amount_paid_minor: row.amount_paid_minor, balance_due_minor: row.balance_due_minor, issued_at: row.issued_at, updated_at: row.updated_at } : row; return { link: payload.link, document, payment_links: payload.payment_links || [] }; };
  const resolvePublicPortal = async (req) => mapPublicPortal(normalizedBackend === "supabase" ? await serviceRpc("resolve_document_portal_link", { target_token_hash: portalTokenHash(req) }) : store.resolvePortalLink(portalTokenHash(req)));
  const providerRateLimit = rateLimit({ name: "providers", limit: 120 });
  app.post("/api/webhooks/resend", providerRateLimit, express.raw({ type: "application/json", limit: "512kb" }), route(async (req, res) => { const details = resendEventDetails(verifyResendWebhook(req.body, req.headers), req.get("svix-id")); const result = normalizedBackend === "supabase" ? await serviceRpc("process_resend_provider_event", { target_event_id: details.eventId, target_event_type: details.type, target_message_id: details.providerMessageId, target_status: details.status, target_terminal: details.terminalFailure, target_recipients: details.recipients, target_payload: details.raw }) : store.processResendWebhook(details); res.json({ received: true, duplicate: Boolean(result?.duplicate) }); }));
  app.post("/api/webhooks/stripe", providerRateLimit, express.raw({ type: "application/json", limit: "512kb" }), route(async (req, res) => { const event = verifyStripeWebhook(req.body, req.get("stripe-signature")); const result = await processProviderEvent("stripe", providerEventDetails("stripe", event)); res.json({ received: true, duplicate: Boolean(result?.duplicate) }); }));
  app.post("/api/webhooks/paypal", providerRateLimit, express.raw({ type: "application/json", limit: "512kb" }), route(async (req, res) => { const event = await verifyPayPalWebhook(req.body, req.headers, { fetchImpl }); const result = await processProviderEvent("paypal", providerEventDetails("paypal", event)); res.json({ received: true, duplicate: Boolean(result?.duplicate) }); }));
  app.get("/api/public/payment-links/:id/paypal-return", rateLimit({ name: "paypal-return", limit: 20 }), route(async (req, res) => { try { const checkout = normalizedBackend === "supabase" ? await serviceRpc("get_payment_checkout_for_capture", { target_id: req.params.id }) : store.getPaymentCheckout(req.params.id); await capturePaymentCheckout(checkout); res.redirect(303, "/?payment=success"); } catch { res.redirect(303, "/?payment=failed"); } }));
  app.get("/api/public/portal", rateLimit({ name: "portal", limit: 120 }), route(async (req, res) => res.json({ data: await resolvePublicPortal(req) })));
  app.get("/api/public/portal/pdf", rateLimit({ name: "portal-pdf", limit: 30 }), route(async (req, res) => { const portal = await resolvePublicPortal(req); createDocumentPdf(portal.document, res, { logo: await readFile(path.join(staticRoot, DEFAULT_BRAND_LOGO)).catch(() => null) }); }));
  app.post("/api/public/portal/quote/:action", rateLimit({ name: "portal-action", limit: 20 }), route(async (req, res) => { const hash = portalTokenHash(req); const row = normalizedBackend === "supabase" ? await serviceRpc("portal_quote_action", { target_token_hash: hash, target_action: req.params.action }) : store.portalQuoteAction(hash, req.params.action); res.json({ data: mapPublicPortal({ document: row, link: {}, payment_links: [] }).document }); }));
  app.use(express.json({ limit: "1mb" }));
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
  async function runReminderOperations(asOf) {
    const candidates = await store.listDueInvoiceReminders({ as_of: asOf }); const reminders = [];
    for (const candidate of candidates) {
      const claim = await store.claimInvoiceReminder(candidate); if (!claim.claimed) { reminders.push({ candidate, delivery: claim.delivery, skipped: true }); continue; }
      let attempt; try { attempt = await sendDocumentEmail(candidate.document.id, { purpose: candidate.rule.purpose, request_key: `reminder:${candidate.rule.id}:${candidate.document.id}:${candidate.due_date}` }); } catch (cause) { attempt = { provider_status: "failed", provider_error: cause.message || "Reminder could not be sent" }; }
      const delivery = await store.completeInvoiceReminderDelivery(claim.delivery.id, attempt);
      if (["accepted", "accepted_mock", "sent", "delivered"].includes(String(attempt.provider_status || "")) && candidate.days_overdue > 0) { const current = await store.getDocument(candidate.document.id); if (current && ["finalized", "sent", "partially_paid"].includes(current.status)) await store.transitionDocument(current.id, "overdue", "overdue"); }
      reminders.push({ candidate, attempt, delivery });
    }
    return reminders;
  }
  async function runWorkspaceOperations(asOf) {
    const recurring = await store.runDueRecurringSchedules({ as_of: asOf }); const reminders = await runReminderOperations(asOf); const retries = [];
    for (const attempt of await store.listRetryableEmailAttempts({ as_of: asOf ? `${asOf}T23:59:59.999Z` : undefined })) {
      if (!await store.claimEmailRetry(attempt.id)) continue;
      try { retries.push(await sendDocumentEmail(attempt.document_id, { ...attempt.rendered, purpose: attempt.template_purpose, request_key: `retry:${attempt.id}` })); } catch (cause) { retries.push({ source_attempt_id: attempt.id, provider_status: "failed", provider_error: cause.message }); }
    }
    const retention = await store.redactProviderPayloads({ as_of: asOf }); return { recurring, reminders, retries, retention };
  }
  const cronAuthorized = (req) => { const configured = String(process.env.FORMA_CRON_SECRET || ""); const supplied = String(req.get("x-forma-cron-secret") || req.get("authorization")?.replace(/^Bearer\s+/i, "") || ""); const a = Buffer.from(configured); const b = Buffer.from(supplied); return configured && a.length === b.length && timingSafeEqual(a, b); };

  const secretAuthorized = (req, name) => { const configured = String(process.env[name] || ""); const supplied = String(req.get("authorization")?.replace(/^Bearer\s+/i, "") || ""); const a = Buffer.from(configured); const b = Buffer.from(supplied); return configured && a.length === b.length && timingSafeEqual(a, b); };
  app.get("/api/health", async (req, res) => res.json({ ok: true, email: emailProviderStatus(), payments: paymentProviderStatus(), auth: { mode: authMiddleware.publicConfig.mode, configured: authMiddleware.publicConfig.configured }, observability: { error_sink_configured: observability.configured, metrics_configured: Boolean(process.env.FORMA_METRICS_SECRET) }, data_backend: normalizedBackend }));
  app.get("/api/ready", route(async (req, res) => { if (normalizedBackend === "supabase") { if (!serviceFetch) throw Object.assign(new Error("Hosted data service is not configured"), { status: 503, code: "NOT_READY" }); const check = await serviceFetch("/rest/v1/workspaces?select=id&limit=1"); if (!check.ok) throw Object.assign(new Error("Hosted data service is unavailable"), { status: 503, code: "NOT_READY" }); } else store.db.prepare("SELECT 1 AS ready").get(); res.json({ ready: true, data_backend: normalizedBackend }); }));
  app.get("/api/internal/metrics", rateLimit({ name: "metrics", limit: 30 }), (req, res) => { if (!process.env.FORMA_METRICS_SECRET) return res.status(503).json({ error: { code: "METRICS_NOT_CONFIGURED", message: "Metrics export is not configured" } }); if (!secretAuthorized(req, "FORMA_METRICS_SECRET")) return res.status(401).json({ error: { code: "INVALID_METRICS_CREDENTIAL", message: "Invalid metrics credential" } }); res.type("text/plain; version=0.0.4").send(observability.prometheus()); });
  app.get("/api/auth/config", async (req, res) => res.json({ data: authMiddleware.publicConfig }));
  app.post("/api/internal/run-operations", rateLimit({ name: "operations", limit: 10 }), route(async (req, res) => {
    if (!process.env.FORMA_CRON_SECRET) throw Object.assign(new Error("Scheduled operations are not configured"), { status: 503, code: "CRON_NOT_CONFIGURED" });
    if (!cronAuthorized(req)) throw Object.assign(new Error("Invalid scheduled operations credential"), { status: 401, code: "INVALID_CRON_CREDENTIAL" });
    if (normalizedBackend !== "supabase") return res.json({ data: { local: await runWorkspaceOperations(req.body?.as_of) } });
    const response = await serviceFetch("/rest/v1/workspaces?select=id&order=created_at.asc"); const workspaces = await response.json().catch(() => []); if (!response.ok) throw Object.assign(new Error("Workspaces could not be loaded for scheduled operations"), { status: 503, code: "CRON_WORKSPACE_LOAD_FAILED" }); const data = {};
    for (const workspace of workspaces) data[workspace.id] = await tenantContext.run({ workspaceId: workspace.id, role: "owner", supabaseFetch: serviceFetch, serviceFetch }, () => runWorkspaceOperations(req.body?.as_of));
    res.json({ data });
  }));
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
  app.post("/api/workspaces/accept-invitation", route(async (req, res) => { if (!req.auth) throw Object.assign(new Error("Sign in to accept an invitation"), { status: 401, code: "AUTHENTICATION_REQUIRED" }); const token = String(req.body?.token || ""); if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw Object.assign(new Error("Invitation is invalid or expired"), { status: 422, code: "INVITATION_INVALID" }); const result = await req.auth.supabaseFetch("/rest/v1/rpc/accept_workspace_invitation", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ invitation_token: token }) }); const payload = await result.json().catch(() => null); if (!result.ok) throw Object.assign(new Error(payload?.message || "Invitation is invalid or expired"), { status: result.status, code: "INVITATION_INVALID" }); res.json({ data: { workspace_id: Array.isArray(payload) ? payload[0] : payload } }); }));
  app.use("/api", (req, res, next) => {
    if (authMiddleware.publicConfig.mode !== "required") return next();
    if (!req.auth?.workspaceId) return res.status(409).json({ error: { code: "WORKSPACE_REQUIRED", message: "Select or create a workspace to continue" } });
    if (normalizedBackend !== "supabase" || !app.locals.tenantStoreReady) return res.status(503).json({ error: { code: "TENANT_STORE_NOT_CONFIGURED", message: "Tenant-safe Supabase persistence must be enabled before authenticated data access" } });
    return next();
  });
  const requireWorkspaceAdmin = (req) => { if (normalizedBackend !== "supabase") throw Object.assign(new Error("Team management is available in hosted workspaces"), { status: 409, code: "HOSTED_WORKSPACE_REQUIRED" }); if (!["owner", "admin"].includes(req.auth?.role)) throw Object.assign(new Error("Workspace admin access is required"), { status: 403, code: "WORKSPACE_ACCESS_DENIED" }); };
  const requireDataAdmin = (req) => { if (normalizedBackend === "supabase" && !["owner", "admin"].includes(req.auth?.role)) throw Object.assign(new Error("Workspace admin access is required"), { status: 403, code: "WORKSPACE_ACCESS_DENIED" }); };
  app.get("/api/workspace/team", route(async (req, res) => { requireWorkspaceAdmin(req); const workspace = encodeURIComponent(req.auth.workspaceId); const [memberResponse, invitationResponse] = await Promise.all([serviceFetch(`/rest/v1/workspace_memberships?select=workspace_id,user_id,role,status,created_at,updated_at&workspace_id=eq.${workspace}&order=created_at.asc`), serviceFetch(`/rest/v1/workspace_invitations?select=id,email,role,expires_at,accepted_at,delivery_status,delivery_error,created_at&workspace_id=eq.${workspace}&order=created_at.desc`)]); const members = await memberResponse.json().catch(() => []); const invitations = await invitationResponse.json().catch(() => []); if (!memberResponse.ok || !invitationResponse.ok) throw Object.assign(new Error("Workspace team could not be loaded"), { status: 503, code: "TEAM_LOAD_FAILED" }); res.json({ data: { members, invitations } }); }));
  app.post("/api/workspace/invitations", route(async (req, res) => { requireWorkspaceAdmin(req); const email = String(req.body?.email || "").trim().toLowerCase(); const role = String(req.body?.role || "member"); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !["admin", "member", "viewer"].includes(role)) throw Object.assign(new Error("Enter a valid email and invitation role"), { status: 422, code: "VALIDATION_ERROR" }); const id = randomUUID(); const token = randomBytes(32).toString("base64url"); const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString(); const invitation = await serviceRpc("create_workspace_invitation_record", { target_workspace: req.auth.workspaceId, target_id: id, target_email: email, target_role: role, target_token_hash: createHash("sha256").update(token).digest("hex"), target_expires_at: expiresAt, target_created_by: req.auth.user.id }); const inviteUrl = `${publicUrlFor(req)}/#invite=${token}`; const workspaceName = req.auth.memberships.find((membership) => membership.workspace_id === req.auth.workspaceId)?.workspaces?.name || "a Forma workspace"; const delivery = await sendTransactionalEmail({ to: [email], subject: `You're invited to ${workspaceName} on Forma`, text: `You have been invited as ${role}. Open this secure link within 7 days:\n\n${inviteUrl}`, html: `<p>You have been invited to <strong>${htmlEscape(workspaceName)}</strong> as ${htmlEscape(role)}.</p><p><a href="${htmlEscape(inviteUrl)}">Accept invitation</a></p><p>This link expires in 7 days.</p>`, requestKey: `workspace-invitation:${id}` }); await serviceFetch(`/rest/v1/workspace_invitations?id=eq.${encodeURIComponent(id)}&workspace_id=eq.${encodeURIComponent(req.auth.workspaceId)}`, { method: "PATCH", headers: { "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify({ delivery_status: delivery.status, delivery_error: delivery.accepted ? null : delivery.error }) }); res.status(201).json({ data: { ...invitation, invite_url: inviteUrl, delivery } }); }));
  app.delete("/api/workspace/invitations/:id", route(async (req, res) => { requireWorkspaceAdmin(req); const response = await serviceFetch(`/rest/v1/workspace_invitations?id=eq.${encodeURIComponent(req.params.id)}&workspace_id=eq.${encodeURIComponent(req.auth.workspaceId)}`, { method: "DELETE", headers: { Prefer: "return=representation" } }); const rows = await response.json().catch(() => []); if (!response.ok || !rows.length) throw Object.assign(new Error("Invitation not found"), { status: 404, code: "NOT_FOUND" }); res.json({ data: { id: req.params.id, revoked: true } }); }));
  app.patch("/api/workspace/members/:userId", route(async (req, res) => { requireWorkspaceAdmin(req); const role = req.body?.role; const status = req.body?.status; if (role !== undefined && !["owner", "admin", "member", "viewer"].includes(role)) throw Object.assign(new Error("Member role is invalid"), { status: 422, code: "VALIDATION_ERROR" }); if (status !== undefined && !["active", "suspended"].includes(status)) throw Object.assign(new Error("Member status is invalid"), { status: 422, code: "VALIDATION_ERROR" }); const targetResponse = await serviceFetch(`/rest/v1/workspace_memberships?select=user_id,role,status&workspace_id=eq.${encodeURIComponent(req.auth.workspaceId)}&user_id=eq.${encodeURIComponent(req.params.userId)}&limit=1`); const target = (await targetResponse.json().catch(() => []))[0]; if (!target) throw Object.assign(new Error("Workspace member not found"), { status: 404, code: "NOT_FOUND" }); if ((role === "owner" || target.role === "owner") && req.auth.role !== "owner") throw Object.assign(new Error("Only an owner can change workspace ownership"), { status: 403, code: "WORKSPACE_ACCESS_DENIED" }); const response = await serviceFetch(`/rest/v1/workspace_memberships?workspace_id=eq.${encodeURIComponent(req.auth.workspaceId)}&user_id=eq.${encodeURIComponent(req.params.userId)}`, { method: "PATCH", headers: { "Content-Type": "application/json", Prefer: "return=representation" }, body: JSON.stringify({ ...(role !== undefined ? { role } : {}), ...(status !== undefined ? { status } : {}), updated_at: new Date().toISOString() }) }); const rows = await response.json().catch(() => []); if (!response.ok || !rows.length) throw Object.assign(new Error("Workspace member could not be updated"), { status: response.status || 404, code: "MEMBER_UPDATE_FAILED" }); res.json({ data: rows[0] }); }));
  app.get("/api/privacy/provider-payload-retention", route(async (req, res) => res.json({ data: await store.getProviderPayloadRetentionPolicy() })));
  app.put("/api/privacy/provider-payload-retention", route(async (req, res) => { requireDataAdmin(req); res.json({ data: await store.saveProviderPayloadRetentionPolicy(req.body || {}) }); }));

  app.post("/api/business-logo", express.raw({ type: ["image/png", "image/jpeg", "image/webp", "image/svg+xml"], limit: MAX_LOGO_BYTES }), route(async (req, res) => {
    const info = imageInfo(req.body, req.get("content-type")?.split(";")[0].trim().toLowerCase());
    const id = randomUUID(); const storageKey = hostedStorage ? path.posix.join(req.auth.workspaceId, "logos", `${id}.${info.extension}`) : path.posix.join("logos", `${id}.${info.extension}`); const pendingAsset = { storage_key: storageKey, content_type: info.contentType };
    await writeAsset(pendingAsset, req.body);
    let savedAsset = null;
    try {
      savedAsset = await store.saveMediaAsset({ id, storage_key: storageKey, filename: safeFilename(req.get("x-file-name")), content_type: info.contentType, byte_size: req.body.length });
      const profile = await store.saveBusinessProfile({ ...await store.getBusinessProfile(), logo_url: `/api/assets/${savedAsset.id}` });
      res.status(201).json({ data: { asset: { ...savedAsset, url: `/api/assets/${savedAsset.id}` }, profile } });
    } catch (cause) { if (savedAsset) await Promise.resolve(store.deleteMediaAsset(savedAsset.id)).catch(() => null); await removeAsset(pendingAsset); throw cause; }
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
    const asOf = req.body?.as_of; const reminders = await runReminderOperations(asOf);
    res.status(202).json({ data: { reminders, rules: await store.listReminderRules(), due: await store.listDueInvoiceReminders({ as_of: asOf }) } });
  }));
  app.get("/api/exports/receivables.csv", route(async (req, res) => {
    const documents = await store.listDocuments({ document_type: req.query.document_type || undefined, status: req.query.status || undefined });
    res.type("text/csv").attachment(`forma-receivables-${new Date().toISOString().slice(0, 10)}.csv`).send(receivablesCsv(documents));
  }));
  app.get("/api/reports/aging.csv", route(async (req, res) => { const report = agingReport(await store.listDocuments({ document_type: "invoice" }), { asOf: req.query.as_of }); res.type("text/csv").attachment(`forma-aging-${report.as_of}.csv`).send(agingCsv(report)); }));
  app.get("/api/reports/tax.csv", route(async (req, res) => { const report = taxReport(await store.listDocuments({ document_type: "invoice" }), { from: req.query.from, to: req.query.to }); res.type("text/csv").attachment(`forma-tax-${report.from || "all"}-${report.to || "all"}.csv`).send(taxCsv(report)); }));
  app.get("/api/reports/collection-forecast.csv", route(async (req, res) => { const report = collectionForecast(await store.listDocuments({ document_type: "invoice" }), { asOf: req.query.as_of }); res.type("text/csv").attachment(`forma-collection-forecast-${report.as_of}.csv`).send(collectionForecastCsv(report)); }));
  app.get("/api/reports/receivables.pdf", route(async (req, res) => { const report = agingReport(await store.listDocuments({ document_type: "invoice" }), { asOf: req.query.as_of }); renderReceivablesReportPdf(report, await store.getBusinessProfile(), res); }));
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
  app.post("/api/documents/:id/payment-links", route(async (req, res) => {
    const requestKey = String(req.body?.request_key || req.get("idempotency-key") || randomUUID());
    const started = await store.beginPaymentCheckout(req.params.id, { ...(req.body || {}), request_key: requestKey });
    if (started.idempotent && started.checkout.checkout_url) return res.json({ data: started.checkout, idempotent: true });
    const publicUrl = publicUrlFor(req);
    try {
      const providerResult = await createHostedPayment({ provider: started.checkout.provider, checkoutId: started.checkout.id, requestKey, workspaceId: req.auth?.workspaceId || "local", invoice: started.invoice, amountMinor: started.checkout.amount_minor, publicUrl }, { fetchImpl });
      const checkout = await store.completePaymentCheckout(started.checkout.id, providerResult); res.status(201).json({ data: checkout, idempotent: false });
    } catch (cause) { await Promise.resolve(store.completePaymentCheckout(started.checkout.id, { error: cause.message })).catch(() => null); throw cause; }
  }));
  app.get("/api/documents/:id/payment-links", route(async (req, res) => { found(await store.getDocument(req.params.id)); res.json({ data: await store.listPaymentCheckouts(req.params.id) }); }));
  app.post("/api/documents/:id/refunds", route(async (req, res) => {
    const requestKey = String(req.body?.request_key || req.get("idempotency-key") || randomUUID()); const started = await store.beginPaymentRefund(req.params.id, { ...(req.body || {}), request_key: requestKey });
    const reconcile = async (providerResult, idempotent) => {
      const status = String(providerResult.status || "pending").toLowerCase(); const reconciliation = await processRefundEvent(started.refund.provider, { kind: "refund", eventId: `${started.refund.provider}-refund:${providerResult.id}:${status}`, type: "refund.api.created", refundId: started.refund.id, checkoutId: started.refund.checkout_id, providerRefundId: providerResult.id, providerPaymentId: started.refund.provider_payment_id, status, successful: ["succeeded", "completed"].includes(status), failed: ["failed", "canceled"].includes(status), amountMinor: providerResult.amount_minor, currency: providerResult.currency, raw: providerResult.raw || {} });
      const refund = reconciliation.refund || await store.listPaymentRefunds(req.params.id).then((rows) => rows.find((row) => row.id === started.refund.id));
      return res.status(idempotent ? 200 : 201).json({ data: { refund, invoice: await store.getDocument(req.params.id), idempotent } });
    };
    if (started.idempotent && started.refund.status !== "creating") {
      if (!started.refund.ledger_applied_at && ["succeeded", "completed"].includes(started.refund.status) && started.refund.provider_refund_id) return reconcile({ id: started.refund.provider_refund_id, status: started.refund.status, amount_minor: started.refund.amount_minor, currency: started.refund.currency, raw: {} }, true);
      return res.json({ data: { refund: started.refund, invoice: started.invoice, idempotent: true } });
    }
    let providerResult;
    try { providerResult = await createProviderRefund({ provider: started.refund.provider, providerPaymentId: started.refund.provider_payment_id, refundId: started.refund.id, checkoutId: started.refund.checkout_id, amountMinor: started.refund.amount_minor, currency: started.refund.currency, reason: started.refund.reason, requestKey }, { fetchImpl }); }
    catch (cause) { await Promise.resolve(store.completePaymentRefund(started.refund.id, { error: cause.message })).catch(() => null); throw cause; }
    await store.completePaymentRefund(started.refund.id, { provider_refund_id: providerResult.id, status: providerResult.status });
    return reconcile(providerResult, false);
  }));
  app.get("/api/documents/:id/refunds", route(async (req, res) => { found(await store.getDocument(req.params.id)); res.json({ data: await store.listPaymentRefunds(req.params.id) }); }));
  app.get("/api/documents/:id/disputes", route(async (req, res) => { found(await store.getDocument(req.params.id)); res.json({ data: await store.listPaymentDisputes(req.params.id) }); }));
  app.post("/api/documents/:id/portal-links", route(async (req, res) => { const days = Math.min(90, Math.max(1, Math.round(Number(req.body?.expires_in_days) || 30))); const token = randomBytes(32).toString("base64url"); const link = await store.savePortalLink(req.params.id, { id: randomUUID(), token_hash: createHash("sha256").update(token).digest("hex"), expires_at: new Date(Date.now() + days * 86400000).toISOString() }); res.status(201).json({ data: { ...link, url: `${publicUrlFor(req)}/portal.html#${token}` } }); }));
  app.get("/api/documents/:id/portal-links", route(async (req, res) => { found(await store.getDocument(req.params.id)); res.json({ data: await store.listPortalLinks(req.params.id) }); }));
  app.delete("/api/portal-links/:id", route(async (req, res) => res.json({ data: await store.revokePortalLink(req.params.id) })));
  app.post("/api/payment-links/:id/capture", route(async (req, res) => {
    const checkout = await store.getPaymentCheckout(req.params.id); if (!checkout) throw Object.assign(new Error("Payment checkout not found"), { status: 404, code: "NOT_FOUND" }); if (checkout.provider !== "paypal") throw Object.assign(new Error("Only PayPal orders require an explicit capture"), { status: 409, code: "CONFLICT" }); const result = await capturePaymentCheckout(checkout); res.json({ data: { ...result, checkout: await store.getPaymentCheckout(checkout.id) } });
  }));
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
    } catch (cause) { if (savedAsset) await Promise.resolve(store.deleteMediaAsset(savedAsset.id)).catch(() => null); await removeAsset(pendingAsset); throw cause; }
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
  app.use((cause, req, res, next) => { if (res.headersSent) return next(cause); const status = cause.status || 500; const code = cause.code || (status === 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR"); observability.recordError(code, status); if (status >= 500) void observability.notifyError({ request_id: req.requestId, method: req.method, route: req.route?.path, status, code }); if (status >= 500 || process.env.FORMA_LOG_ERRORS === "true") console.error(JSON.stringify({ level: "error", event: "request_error", request_id: req.requestId, method: req.method, path: req.path, status, code, message: cause.message, stack: process.env.NODE_ENV === "production" ? undefined : cause.stack })); res.status(status).json({ error: { code, message: status === 500 ? "Something went wrong" : cause.message, details: cause.details, request_id: req.requestId } }); });
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 4173; const host = process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1"); const app = createApp();
  const server = app.listen(port, host, () => console.log(`VirtuKey Forma running at http://${host}:${port}`));
  const shutdown = (signal) => { console.log(JSON.stringify({ level: "info", event: "shutdown", signal })); server.close(() => { app.locals.store.close(); process.exit(0); }); setTimeout(() => process.exit(1), 10000).unref(); };
  process.once("SIGTERM", () => shutdown("SIGTERM")); process.once("SIGINT", () => shutdown("SIGINT"));
}
