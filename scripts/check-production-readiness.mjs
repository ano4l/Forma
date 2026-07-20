import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function present(value) { return Boolean(String(value || "").trim()); }
function httpsUrl(value) { try { return new URL(value).protocol === "https:"; } catch { return false; } }
function add(checks, id, ok, message, severity = "blocker") { checks.push({ id, status: ok ? "pass" : severity, message }); }

export function evaluateConfiguration(environment = process.env) {
  const checks = [];
  const publishable = environment.SUPABASE_PUBLISHABLE_KEY || environment.SUPABASE_ANON_KEY;
  add(checks, "runtime.production", environment.NODE_ENV === "production", "NODE_ENV is production");
  add(checks, "runtime.auth", environment.FORMA_AUTH_MODE === "required", "FORMA_AUTH_MODE is required");
  add(checks, "runtime.backend", environment.FORMA_DATA_BACKEND === "supabase", "FORMA_DATA_BACKEND is supabase");
  add(checks, "runtime.public_url", httpsUrl(environment.FORMA_PUBLIC_URL), "FORMA_PUBLIC_URL is an HTTPS origin");
  add(checks, "runtime.rate_limit", Number(environment.FORMA_RATE_LIMIT_PER_MINUTE) > 0, "A positive API rate limit is configured");
  add(checks, "runtime.cron_secret", String(environment.FORMA_CRON_SECRET || "").length >= 24, "Scheduler secret is at least 24 characters");
  add(checks, "runtime.metrics_secret", String(environment.FORMA_METRICS_SECRET || "").length >= 24, "Metrics secret is at least 24 characters");
  add(checks, "runtime.request_logs", environment.FORMA_REQUEST_LOGS === "true", "Structured production request logs are enabled");

  add(checks, "supabase.url", httpsUrl(environment.SUPABASE_URL), "Supabase URL is configured with HTTPS");
  add(checks, "supabase.publishable_key", present(publishable), "Supabase publishable key is configured");
  add(checks, "supabase.service_role", present(environment.SUPABASE_SERVICE_ROLE_KEY), "Supabase service-role key is configured");
  add(checks, "supabase.database_url", present(environment.SUPABASE_DB_URL), "Supabase database connection URL is configured");
  const authProviders = String(environment.FORMA_AUTH_PROVIDERS || "").split(",").map((value) => value.trim()).filter(Boolean);
  add(checks, "supabase.auth_providers", ["email", "google", "azure"].every((provider) => authProviders.includes(provider)), "Email, Google, and Microsoft Auth are declared");

  add(checks, "email.provider", environment.FORMA_EMAIL_PROVIDER === "resend", "Resend is the active email provider");
  add(checks, "email.api_key", present(environment.FORMA_RESEND_API_KEY), "Resend API key is configured");
  add(checks, "email.sender", /<[^<>\s@]+@[^<>\s@]+>$/.test(String(environment.FORMA_EMAIL_FROM || "")) || /^[^\s@]+@[^\s@]+$/.test(String(environment.FORMA_EMAIL_FROM || "")), "Resend sender address is configured");
  add(checks, "email.webhook", present(environment.FORMA_RESEND_WEBHOOK_SECRET), "Resend webhook verification secret is configured");

  add(checks, "stripe.secret", /^sk_(test|live)_/.test(String(environment.FORMA_STRIPE_SECRET_KEY || "")), "Stripe secret key is configured");
  add(checks, "stripe.webhook", /^whsec_/.test(String(environment.FORMA_STRIPE_WEBHOOK_SECRET || "")), "Stripe webhook secret is configured");
  add(checks, "paypal.environment", environment.FORMA_PAYPAL_ENV === "live", "PayPal is configured for live mode");
  add(checks, "paypal.client", present(environment.FORMA_PAYPAL_CLIENT_ID) && present(environment.FORMA_PAYPAL_CLIENT_SECRET), "PayPal client credentials are configured");
  add(checks, "paypal.webhook", present(environment.FORMA_PAYPAL_WEBHOOK_ID), "PayPal webhook ID is configured");

  add(checks, "monitoring.error_sink", httpsUrl(environment.FORMA_ERROR_WEBHOOK_URL), "An HTTPS error sink is configured", "warning");
  add(checks, "monitoring.error_secret", String(environment.FORMA_ERROR_WEBHOOK_SECRET || "").length >= 24, "Error-sink signature secret is at least 24 characters", "warning");
  return checks;
}

async function fetchCheck(checks, id, url, options, validate, message) {
  try {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10_000) });
    const body = await response.json().catch(() => ({}));
    add(checks, id, response.ok && validate(body, response), message);
    return body;
  } catch {
    add(checks, id, false, message);
    return null;
  }
}

function serviceHeaders(environment) {
  return { apikey: environment.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${environment.SUPABASE_SERVICE_ROLE_KEY}` };
}

async function checkMigrations(checks, environment) {
  if (!present(environment.SUPABASE_DB_URL)) return add(checks, "supabase.migrations", false, "All repository migrations are applied");
  const local = (await readdir(path.join(root, "supabase", "migrations"))).filter((file) => file.endsWith(".sql")).map((file) => file.split("_")[0]).sort();
  const client = new Client({ connectionString: environment.SUPABASE_DB_URL, ssl: environment.SUPABASE_DB_URL.includes("localhost") ? undefined : { rejectUnauthorized: false }, connectionTimeoutMillis: 10_000 });
  try {
    await client.connect();
    const result = await client.query("SELECT version FROM supabase_migrations.schema_migrations ORDER BY version");
    const applied = new Set(result.rows.map((row) => String(row.version)));
    add(checks, "supabase.migrations", local.every((version) => applied.has(version)), "All repository migrations are applied");
  } catch {
    add(checks, "supabase.migrations", false, "All repository migrations are applied");
  } finally {
    await client.end().catch(() => {});
  }
}

export async function runRemoteChecks(environment = process.env) {
  const checks = [];
  const supabaseUrl = String(environment.SUPABASE_URL || "").replace(/\/$/, "");
  const publishable = environment.SUPABASE_PUBLISHABLE_KEY || environment.SUPABASE_ANON_KEY;
  if (httpsUrl(supabaseUrl) && present(publishable)) {
    const settings = await fetchCheck(checks, "supabase.auth_reachable", `${supabaseUrl}/auth/v1/settings`, { headers: { apikey: publishable } }, (body) => Boolean(body.external), "Supabase Auth settings are reachable");
    const external = settings?.external || {};
    for (const provider of String(environment.FORMA_AUTH_PROVIDERS || "email,google,azure").split(",").map((value) => value.trim()).filter(Boolean)) {
      add(checks, `supabase.auth.${provider}`, external[provider] === true, `${provider} Auth is enabled in Supabase`);
    }
  } else add(checks, "supabase.auth_reachable", false, "Supabase Auth settings are reachable");

  if (httpsUrl(supabaseUrl) && present(environment.SUPABASE_SERVICE_ROLE_KEY)) {
    await fetchCheck(checks, "supabase.service_access", `${supabaseUrl}/rest/v1/workspaces?select=id&limit=1`, { headers: serviceHeaders(environment) }, (body) => Array.isArray(body), "Service role can read hosted workspaces");
    await fetchCheck(checks, "supabase.private_bucket", `${supabaseUrl}/storage/v1/bucket/forma-private`, { headers: serviceHeaders(environment) }, (body) => body.id === "forma-private" && body.public === false, "Private forma-private Storage bucket exists");
  } else {
    add(checks, "supabase.service_access", false, "Service role can read hosted workspaces");
    add(checks, "supabase.private_bucket", false, "Private forma-private Storage bucket exists");
  }
  await checkMigrations(checks, environment);

  if (httpsUrl(environment.FORMA_PUBLIC_URL)) {
    await fetchCheck(checks, "app.readiness", `${String(environment.FORMA_PUBLIC_URL).replace(/\/$/, "")}/api/ready`, {}, (body) => body.ready === true && body.data_backend === "supabase", "Deployed application reports hosted readiness");
  } else add(checks, "app.readiness", false, "Deployed application reports hosted readiness");

  if (present(environment.FORMA_RESEND_API_KEY)) {
    const sender = String(environment.FORMA_EMAIL_FROM || "").match(/@([^>\s]+)>?$/)?.[1]?.toLowerCase();
    await fetchCheck(checks, "email.domain_verified", "https://api.resend.com/domains", { headers: { authorization: `Bearer ${environment.FORMA_RESEND_API_KEY}` } }, (body) => Array.isArray(body.data) && body.data.some((domain) => domain.name?.toLowerCase() === sender && domain.status === "verified"), "Resend sender domain is verified");
  } else add(checks, "email.domain_verified", false, "Resend sender domain is verified");

  if (present(environment.FORMA_STRIPE_SECRET_KEY)) {
    await fetchCheck(checks, "stripe.credentials", "https://api.stripe.com/v1/balance", { headers: { authorization: `Bearer ${environment.FORMA_STRIPE_SECRET_KEY}` } }, (body) => body.object === "balance", "Stripe credentials are accepted");
  } else add(checks, "stripe.credentials", false, "Stripe credentials are accepted");

  if (present(environment.FORMA_PAYPAL_CLIENT_ID) && present(environment.FORMA_PAYPAL_CLIENT_SECRET)) {
    const paypalUrl = environment.FORMA_PAYPAL_ENV === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
    await fetchCheck(checks, "paypal.credentials", `${paypalUrl}/v1/oauth2/token`, { method: "POST", headers: { authorization: `Basic ${Buffer.from(`${environment.FORMA_PAYPAL_CLIENT_ID}:${environment.FORMA_PAYPAL_CLIENT_SECRET}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" }, (body) => present(body.access_token), "PayPal credentials are accepted");
  } else add(checks, "paypal.credentials", false, "PayPal credentials are accepted");
  return checks;
}

export function summarizeReadiness(checks) {
  return {
    ready: !checks.some((check) => check.status === "blocker"),
    counts: {
      pass: checks.filter((check) => check.status === "pass").length,
      blocker: checks.filter((check) => check.status === "blocker").length,
      warning: checks.filter((check) => check.status === "warning").length,
    },
    checks,
  };
}

async function main() {
  const remote = process.argv.includes("--remote");
  const checks = evaluateConfiguration(process.env);
  if (remote) checks.push(...await runRemoteChecks(process.env));
  const summary = summarizeReadiness(checks);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!summary.ready) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { process.stderr.write(`Production readiness check failed: ${error.message}\n`); process.exitCode = 1; });
