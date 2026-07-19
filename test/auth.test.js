import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../server.js";
import { publicAuthConfig, resolveAuthConfig } from "../auth.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const user = { id: "22222222-2222-4222-8222-222222222222", email: "owner@forma.test" };
const membership = { workspace_id: workspaceId, role: "owner", status: "active", workspaces: { id: workspaceId, name: "Forma Test", slug: "forma-test" } };
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function authFetch(url, options = {}) {
  if (url.endsWith("/auth/v1/user")) return Promise.resolve(new Response(JSON.stringify(user), { status: options.headers.Authorization === "Bearer valid-token" ? 200 : 401, headers: { "Content-Type": "application/json" } }));
  if (url.includes("/rest/v1/workspace_memberships")) return Promise.resolve(new Response(JSON.stringify([membership]), { status: 200, headers: { "Content-Type": "application/json" } }));
  if (url.endsWith("/rest/v1/rpc/create_workspace")) return Promise.resolve(new Response(JSON.stringify(membership.workspaces), { status: 200, headers: { "Content-Type": "application/json" } }));
  return Promise.resolve(new Response("{}", { status: 404, headers: { "Content-Type": "application/json" } }));
}

async function withServer(run, { dataBackend = "sqlite" } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "forma-auth-"));
  const config = { url: "https://project.supabase.co", publishableKey: "publishable-test", serviceRoleKey: "service-test", configured: true, mutationConfigured: true, mode: "required", providers: ["email", "google", "azure"] };
  const app = createApp({ database: path.join(dir, "test.sqlite"), uploadDir: path.join(dir, "uploads"), dataBackend, authOptions: { config, fetchImpl: authFetch } });
  const server = app.listen(0, "127.0.0.1"); await new Promise((resolve) => server.once("listening", resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); app.locals.store.close(); rmSync(dir, { recursive: true, force: true }); }
}

test("auth configuration is fail-closed and never exposes service credentials", () => {
  const disabled = resolveAuthConfig({});
  assert.equal(disabled.mode, "disabled");
  assert.equal(disabled.mutationConfigured, false);
  const required = resolveAuthConfig({ SUPABASE_URL: "https://project.supabase.co/", SUPABASE_PUBLISHABLE_KEY: "publishable", SUPABASE_SERVICE_ROLE_KEY: "secret" });
  assert.equal(required.mode, "required");
  assert.equal(required.url, "https://project.supabase.co");
  assert.equal(required.mutationConfigured, true);
  assert.doesNotMatch(JSON.stringify(publicAuthConfig(required)), /secret|service_role/i);
});

test("required auth verifies Supabase users, resolves membership, and blocks the SQLite tenant store", async () => {
  await withServer(async (base) => {
    let response = await fetch(`${base}/api/documents`);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, "AUTHENTICATION_REQUIRED");

    response = await fetch(`${base}/api/session`, { headers: { Authorization: "Bearer valid-token" } });
    assert.equal(response.status, 200);
    const session = (await response.json()).data;
    assert.equal(session.authenticated, true);
    assert.equal(session.workspace_id, workspaceId);
    assert.equal(session.role, "owner");

    response = await fetch(`${base}/api/documents`, { headers: { Authorization: "Bearer valid-token", "X-Workspace-Id": workspaceId } });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "TENANT_STORE_NOT_CONFIGURED");

    response = await fetch(`${base}/api/session`, { headers: { Authorization: "Bearer valid-token", "X-Workspace-Id": "33333333-3333-4333-8333-333333333333" } });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, "WORKSPACE_ACCESS_DENIED");

    response = await fetch(`${base}/api/workspaces`, { method: "POST", headers: { Authorization: "Bearer valid-token", "Content-Type": "application/json" }, body: JSON.stringify({ name: "Forma Test", slug: "forma-test" }) });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).data.id, workspaceId);
  });
});

test("hosted migration scopes every business table and private object path by workspace", () => {
  const sql = readFileSync(new URL("../supabase/migrations/20260719000000_auth_workspaces_rls.sql", import.meta.url), "utf8");
  for (const table of ["settings", "customers", "products", "document_sequences", "documents", "document_audit_events", "payments", "payment_methods", "branding_presets", "email_templates", "media_assets", "email_delivery_attempts", "reminder_rules", "document_reminder_deliveries", "recurring_schedules", "recurring_schedule_runs"]) {
    assert.match(sql, new RegExp(`'${table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`));
  }
  assert.match(sql, /enable row level security/gi);
  assert.match(sql, /has_workspace_role\(workspace_id, ''viewer''\)/);
  assert.match(sql, /forma-private/);
  assert.match(sql, /storage\.foldername\(name\)/);
  assert.match(sql, /run an explicit tenant data migration first/);
  assert.match(sql, /allocate_document_number/);
  assert.match(sql, /revoke insert, update, delete on all tables in schema public from authenticated/);
  assert.match(sql, /revoke select on public\.payment_methods from authenticated/);
  const workflows = readFileSync(new URL("../supabase/migrations/20260719010000_hosted_document_workflows.sql", import.meta.url), "utf8");
  for (const name of ["create_document_record", "finalize_document_record", "transition_document_record", "convert_quote_record", "record_invoice_payment", "begin_email_delivery_record", "claim_reminder_delivery_record", "create_recurring_run_record"]) assert.match(workflows, new RegExp(name));
  assert.match(workflows, /for update/gi);
  assert.match(workflows, /security definer/gi);
  assert.doesNotMatch(workflows, /grant execute[^;]+to authenticated/i);
});

test("required auth enables the Supabase store only after workspace membership is resolved", async () => {
  const hostedFetch = async (url, options = {}) => {
    if (url.endsWith("/auth/v1/user")) return jsonResponse(user, 200);
    if (url.includes("/rest/v1/workspace_memberships")) return jsonResponse([membership], 200);
    if (url.includes("/rest/v1/documents?")) {
      assert.match(url, new RegExp(`workspace_id=eq\\.${workspaceId}`));
      assert.equal(options.headers.Authorization, "Bearer valid-token");
      return jsonResponse([], 200);
    }
    return jsonResponse({}, 404);
  };
  const dir = mkdtempSync(path.join(tmpdir(), "forma-hosted-auth-"));
  const config = { url: "https://project.supabase.co", publishableKey: "publishable-test", serviceRoleKey: "service-test", configured: true, mutationConfigured: true, mode: "required", providers: ["email"] };
  const app = createApp({ database: path.join(dir, "unused.sqlite"), uploadDir: path.join(dir, "uploads"), dataBackend: "supabase", authOptions: { config, fetchImpl: hostedFetch } });
  const server = app.listen(0, "127.0.0.1"); await new Promise((resolve) => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/documents`, { headers: { Authorization: "Bearer valid-token", "X-Workspace-Id": workspaceId } });
    assert.equal(response.status, 200); assert.deepEqual((await response.json()).data, []);
    assert.equal(app.locals.tenantStoreReady, true);
  } finally { await new Promise((resolve) => server.close(resolve)); app.locals.store.close(); rmSync(dir, { recursive: true, force: true }); }
});
