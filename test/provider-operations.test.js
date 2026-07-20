import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Stripe from "stripe";
import { Webhook } from "svix";
import { createStore } from "../db.js";
import { createHostedPayment, paymentEventDetails, verifyStripeWebhook } from "../payment-provider.js";
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
