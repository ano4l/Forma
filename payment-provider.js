import Stripe from "stripe";

const env = (name, environment = process.env) => String(environment[name] || "").trim();
const providerError = (message, status = 502) => Object.assign(new Error(message), { status, code: "PAYMENT_PROVIDER_ERROR" });

export function paymentProviderStatus(environment = process.env) {
  const stripe = Boolean(env("FORMA_STRIPE_SECRET_KEY", environment));
  const paypal = Boolean(env("FORMA_PAYPAL_CLIENT_ID", environment) && env("FORMA_PAYPAL_CLIENT_SECRET", environment));
  return { stripe: { configured: stripe }, paypal: { configured: paypal, environment: env("FORMA_PAYPAL_ENV", environment) === "live" ? "live" : "sandbox" } };
}

function paypalBase(environment) {
  return env("FORMA_PAYPAL_ENV", environment) === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
}

async function paypalToken(environment, fetchImpl) {
  const clientId = env("FORMA_PAYPAL_CLIENT_ID", environment); const secret = env("FORMA_PAYPAL_CLIENT_SECRET", environment);
  if (!clientId || !secret) throw providerError("PayPal is not configured", 503);
  const response = await fetchImpl(`${paypalBase(environment)}/v1/oauth2/token`, { method: "POST", headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) throw providerError(body.error_description || "PayPal authorization failed");
  return body.access_token;
}

export async function createHostedPayment({ provider, checkoutId, requestKey, workspaceId, invoice, amountMinor, publicUrl }, { environment = process.env, fetchImpl = globalThis.fetch } = {}) {
  const currency = String((invoice.snapshot || invoice.data).currency || "ZAR").toUpperCase();
  const customer = (invoice.snapshot || invoice.data).customer || {};
  if (provider === "stripe") {
    const secret = env("FORMA_STRIPE_SECRET_KEY", environment); if (!secret) throw providerError("Stripe is not configured", 503);
    const stripe = new Stripe(secret);
    const session = await stripe.checkout.sessions.create({
      mode: "payment", client_reference_id: checkoutId, customer_email: customer.email || undefined,
      success_url: `${publicUrl}/?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${publicUrl}/?payment=cancelled`,
      metadata: { forma_checkout_id: checkoutId, forma_workspace_id: workspaceId || "local", forma_invoice_id: invoice.id },
      payment_intent_data: { metadata: { forma_checkout_id: checkoutId, forma_workspace_id: workspaceId || "local", forma_invoice_id: invoice.id } },
      line_items: [{ quantity: 1, price_data: { currency: currency.toLowerCase(), unit_amount: amountMinor, product_data: { name: `Invoice ${invoice.number}`, description: `Payment to ${(invoice.snapshot || invoice.data).supplier?.name || "Forma business"}` } } }]
    }, { idempotencyKey: requestKey });
    return { provider_checkout_id: session.id, checkout_url: session.url, status: session.payment_status === "paid" ? "paid" : "open", raw: session };
  }
  if (provider === "paypal") {
    const token = await paypalToken(environment, fetchImpl);
    const response = await fetchImpl(`${paypalBase(environment)}/v2/checkout/orders`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "PayPal-Request-Id": requestKey }, body: JSON.stringify({ intent: "CAPTURE", purchase_units: [{ reference_id: checkoutId, custom_id: checkoutId, invoice_id: invoice.number, amount: { currency_code: currency, value: (amountMinor / 100).toFixed(2) }, description: `Invoice ${invoice.number}` }], payment_source: { paypal: { experience_context: { return_url: `${publicUrl}/api/public/payment-links/${encodeURIComponent(checkoutId)}/paypal-return`, cancel_url: `${publicUrl}/?payment=cancelled`, user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING" } } } }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw providerError(body.details?.[0]?.description || body.message || "PayPal could not create the order");
    return { provider_checkout_id: body.id, checkout_url: body.links?.find((link) => link.rel === "approve")?.href, status: String(body.status || "CREATED").toLowerCase(), raw: body };
  }
  throw Object.assign(new Error("provider must be stripe or paypal"), { status: 422, code: "VALIDATION_ERROR" });
}

export async function capturePayPalOrder(orderId, { environment = process.env, fetchImpl = globalThis.fetch, requestKey } = {}) {
  const token = await paypalToken(environment, fetchImpl);
  const response = await fetchImpl(`${paypalBase(environment)}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "PayPal-Request-Id": requestKey } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw providerError(body.details?.[0]?.description || body.message || "PayPal could not capture the order");
  return body;
}

export async function createProviderRefund({ provider, providerPaymentId, refundId, checkoutId, amountMinor, currency, reason, requestKey }, { environment = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (provider === "stripe") {
    const secret = env("FORMA_STRIPE_SECRET_KEY", environment); if (!secret) throw providerError("Stripe is not configured", 503);
    const stripe = new Stripe(secret);
    const refund = await stripe.refunds.create({
      payment_intent: providerPaymentId,
      amount: amountMinor,
      ...( ["duplicate", "fraudulent", "requested_by_customer"].includes(reason) ? { reason } : {}),
      metadata: { forma_refund_id: refundId, forma_checkout_id: checkoutId }
    }, { idempotencyKey: requestKey });
    return { id: refund.id, status: refund.status, amount_minor: refund.amount, currency: refund.currency?.toUpperCase(), provider_payment_id: typeof refund.payment_intent === "string" ? refund.payment_intent : refund.payment_intent?.id, raw: refund };
  }
  if (provider === "paypal") {
    const token = await paypalToken(environment, fetchImpl);
    const response = await fetchImpl(`${paypalBase(environment)}/v2/payments/captures/${encodeURIComponent(providerPaymentId)}/refund`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "PayPal-Request-Id": requestKey, Prefer: "return=representation" },
      body: JSON.stringify({ amount: { value: (amountMinor / 100).toFixed(2), currency_code: currency }, custom_id: refundId, invoice_id: checkoutId, ...(reason ? { note_to_payer: String(reason).slice(0, 255) } : {}) })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw providerError(body.details?.[0]?.description || body.message || "PayPal could not create the refund");
    return { id: body.id, status: String(body.status || "PENDING").toLowerCase(), amount_minor: Math.round(Number(body.amount?.value) * 100), currency: body.amount?.currency_code?.toUpperCase(), provider_payment_id: providerPaymentId, raw: body };
  }
  throw Object.assign(new Error("provider must be stripe or paypal"), { status: 422, code: "VALIDATION_ERROR" });
}

export function verifyStripeWebhook(rawBody, signature, environment = process.env) {
  const secret = env("FORMA_STRIPE_WEBHOOK_SECRET", environment); if (!secret) throw providerError("Stripe webhook verification is not configured", 503);
  const stripe = new Stripe(env("FORMA_STRIPE_SECRET_KEY", environment) || "sk_test_placeholder");
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}

export async function verifyPayPalWebhook(rawBody, headers, { environment = process.env, fetchImpl = globalThis.fetch } = {}) {
  const webhookId = env("FORMA_PAYPAL_WEBHOOK_ID", environment); if (!webhookId) throw providerError("PayPal webhook verification is not configured", 503);
  const token = await paypalToken(environment, fetchImpl); const event = JSON.parse(rawBody.toString("utf8"));
  const response = await fetchImpl(`${paypalBase(environment)}/v1/notifications/verify-webhook-signature`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ auth_algo: headers["paypal-auth-algo"], cert_url: headers["paypal-cert-url"], transmission_id: headers["paypal-transmission-id"], transmission_sig: headers["paypal-transmission-sig"], transmission_time: headers["paypal-transmission-time"], webhook_id: webhookId, webhook_event: event }) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.verification_status !== "SUCCESS") throw Object.assign(new Error("Invalid PayPal webhook signature"), { status: 400, code: "INVALID_WEBHOOK_SIGNATURE" });
  return event;
}

export function paymentEventDetails(provider, event) {
  if (provider === "stripe") {
    const object = event.data?.object || {}; const successful = ["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type) && object.payment_status === "paid";
    return { eventId: event.id, type: event.type, providerCheckoutId: object.id, checkoutId: object.metadata?.forma_checkout_id || object.client_reference_id, successful, failed: event.type === "checkout.session.async_payment_failed", providerPaymentId: typeof object.payment_intent === "string" ? object.payment_intent : object.payment_intent?.id, amountMinor: Number.isInteger(object.amount_total) ? object.amount_total : null, currency: object.currency?.toUpperCase() || null, raw: event };
  }
  const resource = event.resource || {}; const related = resource.supplementary_data?.related_ids || {};
  const amount = resource.amount?.value; const amountMinor = amount === undefined ? null : Math.round(Number(amount) * 100);
  return { eventId: event.id, type: event.event_type, providerCheckoutId: related.order_id || resource.id, checkoutId: resource.custom_id || resource.invoice_id || null, successful: event.event_type === "PAYMENT.CAPTURE.COMPLETED", failed: ["PAYMENT.CAPTURE.DENIED", "CHECKOUT.ORDER.VOIDED"].includes(event.event_type), providerPaymentId: event.event_type?.startsWith("PAYMENT.CAPTURE") ? resource.id : related.capture_id, amountMinor: Number.isFinite(amountMinor) ? amountMinor : null, currency: resource.amount?.currency_code?.toUpperCase() || null, raw: event };
}

export function refundEventDetails(provider, event) {
  if (provider === "stripe") {
    const object = event.data?.object || {}; const status = String(object.status || "pending").toLowerCase();
    return { kind: "refund", eventId: event.id, type: event.type, refundId: object.metadata?.forma_refund_id || null, checkoutId: object.metadata?.forma_checkout_id || null, providerRefundId: object.id, providerPaymentId: typeof object.payment_intent === "string" ? object.payment_intent : object.payment_intent?.id, status, successful: status === "succeeded", failed: ["failed", "canceled"].includes(status), amountMinor: Number.isInteger(object.amount) ? object.amount : null, currency: object.currency?.toUpperCase() || null, raw: event };
  }
  const resource = event.resource || {}; const related = resource.supplementary_data?.related_ids || {}; const amount = resource.amount?.value; const type = event.event_type; const status = type === "PAYMENT.CAPTURE.REFUNDED" || type === "PAYMENT.CAPTURE.REVERSED" ? "completed" : String(resource.status || (type === "PAYMENT.REFUND.FAILED" ? "failed" : "pending")).toLowerCase();
  return { kind: "refund", eventId: event.id, type, refundId: resource.custom_id || null, checkoutId: resource.invoice_id || null, providerRefundId: type?.startsWith("PAYMENT.REFUND") ? resource.id : null, providerPaymentId: related.capture_id || (type?.startsWith("PAYMENT.CAPTURE") ? resource.id : null), status, successful: ["completed", "refunded", "reversed"].includes(status), failed: status === "failed", amountMinor: amount === undefined ? null : Math.round(Number(amount) * 100), currency: resource.amount?.currency_code?.toUpperCase() || null, raw: event };
}

export function disputeEventDetails(provider, event) {
  if (provider === "stripe") {
    const object = event.data?.object || {};
    return { kind: "dispute", eventId: event.id, type: event.type, providerDisputeId: object.id, providerPaymentId: typeof object.payment_intent === "string" ? object.payment_intent : object.payment_intent?.id, status: object.status || "open", reason: object.reason || "", amountMinor: Number.isInteger(object.amount) ? object.amount : null, currency: object.currency?.toUpperCase() || null, raw: event };
  }
  const resource = event.resource || {}; const transaction = resource.disputed_transactions?.[0] || {}; const amount = resource.dispute_amount?.value;
  return { kind: "dispute", eventId: event.id, type: event.event_type, providerDisputeId: resource.dispute_id || resource.id, providerPaymentId: transaction.seller_transaction_id || transaction.seller_transaction?.id || null, status: resource.status || event.event_type?.split(".").at(-1)?.toLowerCase() || "open", reason: resource.reason || resource.dispute_reason || "", amountMinor: amount === undefined ? null : Math.round(Number(amount) * 100), currency: resource.dispute_amount?.currency_code?.toUpperCase() || null, raw: event };
}

export function providerEventDetails(provider, event) {
  const type = provider === "stripe" ? event.type : event.event_type;
  if (provider === "stripe" ? type?.startsWith("charge.dispute.") : type?.startsWith("CUSTOMER.DISPUTE.")) return disputeEventDetails(provider, event);
  if (provider === "stripe" ? type?.startsWith("refund.") || type === "charge.refund.updated" : ["PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.REVERSED", "PAYMENT.REFUND.PENDING", "PAYMENT.REFUND.FAILED"].includes(type)) return refundEventDetails(provider, event);
  return { kind: "payment", ...paymentEventDetails(provider, event) };
}
