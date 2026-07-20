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
