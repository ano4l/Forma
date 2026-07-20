import { Webhook } from "svix";

export function verifyResendWebhook(rawBody, headers, environment = process.env) {
  const secret = String(environment.FORMA_RESEND_WEBHOOK_SECRET || "").trim();
  if (!secret) throw Object.assign(new Error("Resend webhook verification is not configured"), { status: 503, code: "WEBHOOK_NOT_CONFIGURED" });
  try { return new Webhook(secret).verify(rawBody.toString("utf8"), { "svix-id": headers["svix-id"], "svix-timestamp": headers["svix-timestamp"], "svix-signature": headers["svix-signature"] }); }
  catch { throw Object.assign(new Error("Invalid Resend webhook signature"), { status: 400, code: "INVALID_WEBHOOK_SIGNATURE" }); }
}

export function resendEventDetails(event, eventId = event.id) {
  const mapping = { "email.sent": "sent", "email.scheduled": "scheduled", "email.delivered": "delivered", "email.delivery_delayed": "delayed", "email.bounced": "bounced", "email.complained": "complained", "email.failed": "failed", "email.suppressed": "suppressed", "email.opened": "opened", "email.clicked": "clicked" };
  const rawRecipients = event.data?.to; const recipients = (Array.isArray(rawRecipients) ? rawRecipients : rawRecipients ? [rawRecipients] : []).map((address) => String(address).toLowerCase());
  return { eventId, type: event.type, providerMessageId: event.data?.email_id, status: mapping[event.type] || event.type, terminalFailure: ["email.bounced", "email.complained", "email.failed", "email.suppressed"].includes(event.type), recipients, raw: event };
}
