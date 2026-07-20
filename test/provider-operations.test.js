import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Stripe from "stripe";
import { Webhook } from "svix";
import { createStore } from "../db.js";
import { createApp } from "../server.js";
import { createHostedPayment, createProviderRefund, paymentEventDetails, providerEventDetails, verifyStripeWebhook } from "../payment-provider.js";
import { resendEventDetails, verifyResendWebhook } from "../webhook-provider.js";

function invoiceData(number) { return { number, document_title: "Tax Invoice", issue_date: "2026-07-19", due_date: "2026-08-18", currency: "ZAR", supplier: { name: "Forma", address: "Cape Town" }, customer: { name: "Acme", email: "accounts@acme.test", address: "Johannesburg" }, items: [{ description: "Delivery", quantity: 1, unit_price_minor: 10000, tax_bps: 1500 }] }; }
function sandbox() { const dir = mkdtempSync(path.join(tmpdir(), "forma-provider-")); return { dir, store: createStore(path.join(dir, "test.sqlite")) }; }

test("payment checkout reconciliation is atomic and idempotent", () => {
  const box = sandbox();
  try {
    const draft = box.store.createDocument({ document_type: "invoice" }); box.store.updateDocument(draft.id, invoiceData(draft.number)); box.store.finalizeDocument(draft.id);
    const started = box.store.beginPaymentCheckout(draft.id, { provider: "stripe", request_key: "checkout-1", amount_minor: 11500 });
    assert.throws(() => box.store.beginPaymentCheckout(draft.id, { provider: "paypal", request_key: "checkout-1", amount_minor: 100 }), /different payment link parameters/);
    box.store.completePaymentCheckout(started.checkout.id, { provider_checkout_id: "cs_123", checkout_url: "https://checkout.test", status: "open" });
    const event = { eventId: "evt_1", type: "checkout.session.completed", providerCheckoutId: "cs_123", providerPaymentId: "pi_123", amountMinor: 11500, currency: "ZAR", successful: true, failed: false, raw: { id: "evt_1" } };
    const first = box.store.processPaymentWebhook("stripe", event); const duplicate = box.store.processPaymentWebhook("stripe", event);
    assert.equal(first.checkout.status, "paid"); assert.equal(first.payment.invoice.status, "paid"); assert.equal(first.payment.receipt.status, "issued");
    assert.equal(duplicate.duplicate, true); assert.equal(box.store.listPayments(draft.id).length, 1);
  } finally { box.store.close(); rmSync(box.dir, { recursive: true, force: true }); }
});

test("Resend events update delivery state once and suppress permanent failures", () => {
  const box = sandbox();
  try {
    const draft = box.store.createDocument({ document_type: "invoice" }); box.store.updateDocument(draft.id, invoiceData(draft.number));
    const started = box.store.beginDocumentEmail(draft.id, { request_key: "send-1" }, "resend"); box.store.completeDocumentEmail(draft.id, started.attempt.id, { accepted: true, status: "accepted", message_id: "email_123" });
    const event = { eventId: "resend-event-1", type: "email.bounced", providerMessageId: "email_123", status: "bounced", terminalFailure: true, raw: {} };
    assert.equal(box.store.processResendWebhook(event).attempt.provider_status, "bounced"); assert.equal(box.store.processResendWebhook(event).duplicate, true);
    assert.throws(() => box.store.beginDocumentEmail(draft.id, { request_key: "send-2" }, "resend"), /suppressed/);
  } finally { box.store.close(); rmSync(box.dir, { recursive: true, force: true }); }
});

test("provider webhook signatures are verified against the untouched body", () => {
  const resendSecret = `whsec_${Buffer.from("resend-test-secret").toString("base64")}`; const resendBody = JSON.stringify({ id: "evt_resend", type: "email.delivered", data: { email_id: "email_1" } }); const webhook = new Webhook(resendSecret); const timestamp = new Date(); const signature = webhook.sign("msg_1", timestamp, resendBody);
  const resend = verifyResendWebhook(Buffer.from(resendBody), { "svix-id": "msg_1", "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)), "svix-signature": signature }, { FORMA_RESEND_WEBHOOK_SECRET: resendSecret });
  assert.deepEqual({ status: resendEventDetails(resend, "msg_1").status, eventId: resendEventDetails(resend, "msg_1").eventId }, { status: "delivered", eventId: "msg_1" });
  const stripeSecret = "whsec_test_secret"; const stripeBody = JSON.stringify({ id: "evt_stripe", type: "checkout.session.completed", data: { object: { id: "cs_1", payment_status: "paid" } } }); const stripeHeader = Stripe.webhooks.generateTestHeaderString({ payload: stripeBody, secret: stripeSecret });
  assert.equal(verifyStripeWebhook(Buffer.from(stripeBody), stripeHeader, { FORMA_STRIPE_WEBHOOK_SECRET: stripeSecret }).id, "evt_stripe");
  assert.throws(() => verifyStripeWebhook(Buffer.from(`${stripeBody} `), stripeHeader, { FORMA_STRIPE_WEBHOOK_SECRET: stripeSecret }), /signature/i);
});

test("PayPal order creation uses OAuth, minor-unit amounts, and idempotency", async () => {
  const calls = []; const fetchImpl = async (url, options) => { calls.push({ url, options }); if (url.endsWith("/v1/oauth2/token")) return Response.json({ access_token: "token" }); return Response.json({ id: "ORDER-1", status: "CREATED", links: [{ rel: "approve", href: "https://paypal.test/approve" }] }); };
  const result = await createHostedPayment({ provider: "paypal", checkoutId: "checkout-1", requestKey: "request-1", workspaceId: "workspace-1", invoice: { id: "invoice-1", number: "INV-1", data: { currency: "ZAR", customer: {}, supplier: { name: "Forma" } } }, amountMinor: 12345, publicUrl: "https://forma.test" }, { environment: { FORMA_PAYPAL_CLIENT_ID: "client", FORMA_PAYPAL_CLIENT_SECRET: "secret" }, fetchImpl });
  const order = JSON.parse(calls[1].options.body); assert.equal(result.provider_checkout_id, "ORDER-1"); assert.equal(calls[1].options.headers["PayPal-Request-Id"], "request-1"); assert.equal(order.purchase_units[0].amount.value, "123.45"); assert.equal(paymentEventDetails("paypal", { id: "evt", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAPTURE", supplementary_data: { related_ids: { order_id: "ORDER-1" } } } }).successful, true);
});

test("partial and full provider refunds update the ledger exactly once", () => {
  const box = sandbox();
  try {
    const draft = box.store.createDocument({ document_type: "invoice" }); box.store.updateDocument(draft.id, invoiceData(draft.number)); box.store.finalizeDocument(draft.id);
    const started = box.store.beginPaymentCheckout(draft.id, { provider: "stripe", request_key: "refund-checkout", amount_minor: 11500 }); box.store.completePaymentCheckout(started.checkout.id, { provider_checkout_id: "cs_refund", status: "open" });
    box.store.processPaymentWebhook("stripe", { eventId: "evt_paid", type: "checkout.session.completed", providerCheckoutId: "cs_refund", providerPaymentId: "pi_refund", amountMinor: 11500, currency: "ZAR", successful: true, failed: false, raw: {} });
    const first = box.store.beginPaymentRefund(draft.id, { checkout_id: started.checkout.id, request_key: "refund-1", amount_minor: 5000, reason: "requested_by_customer" }); box.store.completePaymentRefund(first.refund.id, { provider_refund_id: "re_1", status: "succeeded" });
    const event = { eventId: "evt_refund_1", type: "refund.created", refundId: first.refund.id, providerRefundId: "re_1", providerPaymentId: "pi_refund", status: "succeeded", successful: true, failed: false, amountMinor: 5000, currency: "ZAR", raw: {} };
    assert.equal(box.store.processRefundWebhook("stripe", event).invoice.amount_paid_minor, 6500); assert.equal(box.store.processRefundWebhook("stripe", event).duplicate, true);
    assert.throws(() => box.store.beginPaymentRefund(draft.id, { request_key: "too-much", amount_minor: 6501 }), /remaining refundable/);
    const second = box.store.beginPaymentRefund(draft.id, { request_key: "refund-2", amount_minor: 6500 }); box.store.completePaymentRefund(second.refund.id, { provider_refund_id: "re_2", status: "succeeded" });
    const reconciled = box.store.processRefundWebhook("stripe", { ...event, eventId: "evt_refund_2", refundId: second.refund.id, providerRefundId: "re_2", amountMinor: 6500 });
    assert.equal(reconciled.invoice.status, "refunded"); assert.equal(reconciled.invoice.amount_paid_minor, 0); assert.equal(reconciled.invoice.balance_due_minor, 11500); assert.equal(box.store.listPaymentRefunds(draft.id).length, 2);
  } finally { box.store.close(); rmSync(box.dir, { recursive: true, force: true }); }
});

test("refund and dispute provider payloads are normalized", async () => {
  const calls = []; const fetchImpl = async (url, options) => { calls.push({ url, options }); if (url.endsWith("/v1/oauth2/token")) return Response.json({ access_token: "token" }); return Response.json({ id: "REFUND-1", status: "COMPLETED", amount: { value: "12.34", currency_code: "ZAR" } }); };
  const refund = await createProviderRefund({ provider: "paypal", providerPaymentId: "CAPTURE-1", refundId: "refund-1", checkoutId: "checkout-1", amountMinor: 1234, currency: "ZAR", reason: "Customer request", requestKey: "request-refund-1" }, { environment: { FORMA_PAYPAL_CLIENT_ID: "client", FORMA_PAYPAL_CLIENT_SECRET: "secret" }, fetchImpl });
  assert.equal(refund.status, "completed"); assert.equal(calls[1].options.headers["PayPal-Request-Id"], "request-refund-1"); assert.equal(JSON.parse(calls[1].options.body).custom_id, "refund-1");
  const stripeRefund = providerEventDetails("stripe", { id: "evt_refund", type: "refund.created", data: { object: { id: "re_1", status: "succeeded", amount: 1234, currency: "zar", payment_intent: "pi_1", metadata: { forma_refund_id: "refund-1" } } } });
  assert.equal(stripeRefund.kind, "refund"); assert.equal(stripeRefund.successful, true);
  const dispute = providerEventDetails("paypal", { id: "evt_dispute", event_type: "CUSTOMER.DISPUTE.CREATED", resource: { dispute_id: "PP-D-1", status: "OPEN", dispute_amount: { value: "4.00", currency_code: "ZAR" }, disputed_transactions: [{ seller_transaction_id: "CAPTURE-1" }] } });
  assert.equal(dispute.kind, "dispute"); assert.equal(dispute.providerPaymentId, "CAPTURE-1"); assert.equal(dispute.amountMinor, 400);
});

test("refund API returns the reconciled invoice and refund record", async () => {
  const box = sandbox(); box.store.close();
  const previousClient = process.env.FORMA_PAYPAL_CLIENT_ID; const previousSecret = process.env.FORMA_PAYPAL_CLIENT_SECRET; process.env.FORMA_PAYPAL_CLIENT_ID = "client"; process.env.FORMA_PAYPAL_CLIENT_SECRET = "secret";
  const fetchImpl = async (url) => url.endsWith("/v1/oauth2/token") ? Response.json({ access_token: "token" }) : Response.json({ id: "PAYPAL-REFUND-1", status: "COMPLETED", amount: { value: "115.00", currency_code: "ZAR" } });
  const app = createApp({ database: path.join(box.dir, "api.sqlite"), uploadDir: path.join(box.dir, "uploads"), authOptions: { fetchImpl, config: { url: "", publishableKey: "", serviceRoleKey: "", configured: false, mode: "disabled", providers: [] } } });
  const store = app.locals.store; const draft = store.createDocument({ document_type: "invoice" }); store.updateDocument(draft.id, invoiceData(draft.number)); store.finalizeDocument(draft.id);
  const checkout = store.beginPaymentCheckout(draft.id, { provider: "paypal", request_key: "api-checkout", amount_minor: 11500 }).checkout; store.completePaymentCheckout(checkout.id, { provider_checkout_id: "ORDER-API", status: "open" }); store.processPaymentWebhook("paypal", { eventId: "api-paid", type: "PAYMENT.CAPTURE.COMPLETED", checkoutId: checkout.id, providerCheckoutId: "ORDER-API", providerPaymentId: "CAPTURE-API", amountMinor: 11500, currency: "ZAR", successful: true, failed: false, raw: {} });
  const server = await new Promise((resolve) => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/documents/${draft.id}/refunds`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "api-refund" }, body: JSON.stringify({ checkout_id: checkout.id, amount_minor: 11500, reason: "requested_by_customer" }) }); const payload = await response.json();
    assert.equal(response.status, 201); assert.equal(payload.data.refund.status, "succeeded"); assert.equal(payload.data.invoice.status, "refunded"); assert.equal(payload.data.invoice.amount_paid_minor, 0);
  } finally { await new Promise((resolve) => server.close(resolve)); store.close(); if (previousClient === undefined) delete process.env.FORMA_PAYPAL_CLIENT_ID; else process.env.FORMA_PAYPAL_CLIENT_ID = previousClient; if (previousSecret === undefined) delete process.env.FORMA_PAYPAL_CLIENT_SECRET; else process.env.FORMA_PAYPAL_CLIENT_SECRET = previousSecret; rmSync(box.dir, { recursive: true, force: true }); }
});
