const env = (name) => process.env[`FORMA_${name}`] || process.env[`MONEYFY_${name}`];
const configuredProvider = () => String(env("EMAIL_PROVIDER") || "mock").trim().toLowerCase();

export function emailProviderStatus() {
  const provider = configuredProvider();
  if (provider === "mock") return { provider, configured: true, mode: "development" };
  if (provider === "resend") return { provider, configured: Boolean(env("RESEND_API_KEY") && env("EMAIL_FROM")), mode: "transactional" };
  return { provider, configured: false, mode: "disabled" };
}

export async function sendTransactionalEmail({ to, cc = [], bcc = [], subject, text, html, requestKey, attachment }) {
  const status = emailProviderStatus();
  if (status.provider === "mock") return { accepted: true, status: "accepted_mock", message_id: `mock-${requestKey}` };
  if (status.provider !== "resend") return { accepted: false, status: "disabled", error: `Unsupported FORMA_EMAIL_PROVIDER '${status.provider}'` };
  if (!status.configured) return { accepted: false, status: "configuration_error", error: "Set FORMA_RESEND_API_KEY and FORMA_EMAIL_FROM before enabling Resend delivery" };
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env("RESEND_API_KEY")}`,
        "Content-Type": "application/json",
        "Idempotency-Key": requestKey,
        "User-Agent": "forma-invoice-generator/2.0"
      },
      body: JSON.stringify({ from: env("EMAIL_FROM"), to, cc, bcc, subject, text, html, attachments: attachment ? [{ filename: attachment.filename, content: attachment.content.toString("base64") }] : undefined })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return { accepted: false, status: "provider_error", error: body.message || body.error?.message || `Resend rejected the message (${response.status})` };
    return { accepted: true, status: "accepted", message_id: body.id || null };
  } catch (cause) { return { accepted: false, status: "provider_error", error: "Could not reach the configured email provider" }; }
}
