import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, realpath, stat, writeFile, copyFile, lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { postgresClientConfig } from "../postgres-client.js";

const { Client } = pg;
export const BUNDLE_FORMAT = "forma-portable-backup";
export const BUNDLE_VERSION = 1;
export const STORAGE_BUCKET = "forma-private";
const REMOTE_OPERATION_TIMEOUT_MS = 60_000;
export { postgresClientConfig } from "../postgres-client.js";

const TABLES = {
  settings: ["key", "value"],
  customers: ["id", "name", "contact_name", "email", "phone", "address", "country", "vat_number", "registration_number", "notes", "vat_registered", "currency", "terms_days", "created_at", "updated_at"],
  products: ["id", "name", "description", "unit_price_minor", "tax_bps", "currency", "created_at", "updated_at"],
  document_sequences: ["document_type", "year", "value"],
  documents: ["id", "document_type", "number", "number_year", "status", "customer_id", "source_document_id", "recurring_schedule_id", "data_json", "totals_json", "snapshot_json", "amount_paid_minor", "balance_due_minor", "created_at", "updated_at", "issued_at", "finalized_at"],
  document_audit_events: ["document_id", "type", "detail_json", "created_at"],
  payments: ["id", "invoice_id", "receipt_id", "amount_minor", "method", "reference", "received_date", "notes", "created_at"],
  payment_methods: ["id", "name", "method_type", "details_json", "active", "is_default", "created_at", "updated_at"],
  branding_presets: ["id", "name", "data_json", "created_at", "updated_at"],
  email_templates: ["purpose", "subject", "text", "html", "updated_at"],
  media_assets: ["id", "storage_key", "filename", "content_type", "byte_size", "created_at"],
  email_delivery_attempts: ["id", "document_id", "request_key", "recipients_json", "template_purpose", "provider", "provider_status", "provider_message_id", "provider_error", "rendered_json", "next_retry_at", "updated_at", "created_at"],
  provider_webhook_events: ["provider", "event_id", "event_type", "object_id", "payload_json", "processed_at"],
  email_suppressions: ["email", "reason", "provider", "created_at", "updated_at"],
  payment_checkouts: ["id", "invoice_id", "provider", "provider_checkout_id", "provider_payment_id", "request_key", "amount_minor", "currency", "status", "checkout_url", "provider_error", "created_at", "updated_at", "paid_at"],
  payment_refunds: ["id", "invoice_id", "checkout_id", "provider", "provider_refund_id", "provider_payment_id", "request_key", "amount_minor", "currency", "status", "reason", "provider_error", "ledger_applied_at", "created_at", "updated_at", "completed_at"],
  payment_disputes: ["id", "invoice_id", "checkout_id", "provider", "provider_dispute_id", "provider_payment_id", "amount_minor", "currency", "status", "reason", "event_type", "created_at", "updated_at"],
  document_portal_links: ["id", "document_id", "token_hash", "expires_at", "revoked_at", "last_viewed_at", "created_at"],
  reminder_rules: ["id", "label", "offset_days", "purpose", "active", "created_at", "updated_at"],
  document_reminder_deliveries: ["id", "document_id", "rule_id", "due_date", "scheduled_for", "attempt_id", "status", "provider_error", "created_at", "updated_at"],
  recurring_schedules: ["id", "source_document_id", "name", "frequency", "next_run_on", "ends_on", "active", "data_json", "last_run_on", "generated_count", "created_at", "updated_at"],
  recurring_schedule_runs: ["id", "schedule_id", "run_date", "document_id", "created_at"],
};

const JSON_COLUMNS = new Set([
  "settings.value", "documents.data_json", "documents.totals_json", "documents.snapshot_json",
  "document_audit_events.detail_json", "payment_methods.details_json", "branding_presets.data_json",
  "email_delivery_attempts.recipients_json", "email_delivery_attempts.rendered_json",
  "provider_webhook_events.payload_json", "recurring_schedules.data_json",
]);
const BOOLEAN_COLUMNS = new Set([
  "customers.vat_registered", "payment_methods.active", "payment_methods.is_default",
  "reminder_rules.active", "recurring_schedules.active",
]);
const CONFIG_TABLES = ["settings", "customers", "products", "document_sequences", "payment_methods", "branding_presets", "email_templates", "email_suppressions", "reminder_rules"];
const REPLACEABLE_SEED_TABLES = new Set(["settings", "payment_methods", "branding_presets", "email_templates", "reminder_rules"]);
const INSERT_ORDER = [
  ...CONFIG_TABLES, "documents", "recurring_schedules", "document_audit_events", "payments",
  "media_assets", "email_delivery_attempts", "provider_webhook_events", "payment_checkouts",
  "payment_refunds", "payment_disputes", "document_portal_links", "document_reminder_deliveries",
  "recurring_schedule_runs",
];

function fail(message) {
  throw new Error(message);
}

function assertWorkspaceId(value) {
  const workspaceId = String(value || "").toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(workspaceId)) fail("--workspace must be a valid UUID");
  return workspaceId;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function safeRelative(value, label = "path") {
  const normalized = String(value || "").replaceAll("\\", "/");
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").some((part) => part === ".." || part === "")) fail(`${label} is not a safe relative path`);
  return normalized;
}

function inside(root, relative, label) {
  const base = path.resolve(root);
  const target = path.resolve(base, ...safeRelative(relative, label).split("/"));
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) fail(`${label} escapes its root`);
  return target;
}

async function safeFilePath(root, relative, label) {
  const rootReal = await realpath(path.resolve(root));
  const target = inside(root, relative, label);
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isFile()) fail(`${label} must be a regular file`);
  const targetReal = await realpath(target);
  if (!targetReal.startsWith(`${rootReal}${path.sep}`)) fail(`${label} escapes its root`);
  return targetReal;
}

async function readSafeFile(root, relative, label, encoding) {
  return readFile(await safeFilePath(root, relative, label), encoding);
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function normalizeRow(table, source) {
  const row = {};
  for (const column of TABLES[table]) {
    let value = source[column] ?? null;
    if (JSON_COLUMNS.has(`${table}.${column}`) && typeof value === "string") {
      try { value = JSON.parse(value); } catch { fail(`Invalid JSON in ${table}.${column}`); }
    }
    if (BOOLEAN_COLUMNS.has(`${table}.${column}`)) value = Boolean(value);
    row[column] = value;
  }
  return row;
}

async function writeTable(bundleDir, table, rows) {
  const relative = `tables/${table}.json`;
  const body = stableJson(rows);
  const target = inside(bundleDir, relative, "table file");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, body, { encoding: "utf8", flag: "wx" });
  return { file: relative, rows: rows.length, sha256: sha256(body) };
}

async function createBundleDirectory(output) {
  if (!output) fail("--output is required");
  const bundleDir = path.resolve(output);
  try { await stat(bundleDir); fail(`Output already exists: ${bundleDir}`); } catch (error) { if (error.code !== "ENOENT") throw error; }
  await mkdir(bundleDir, { recursive: false });
  return bundleDir;
}

async function writeManifest(bundleDir, { createdAt, source, workspaceId, tables, assets }) {
  const manifest = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    created_at: createdAt,
    source,
    workspace_id: workspaceId,
    bucket: STORAGE_BUCKET,
    tables,
    assets,
  };
  await writeFile(path.join(bundleDir, "manifest.json"), stableJson(manifest), { encoding: "utf8", flag: "wx" });
  return { directory: bundleDir, manifest };
}

export async function exportBundle({ database, output, workspaceId, uploadDir = "uploads", createdAt = new Date().toISOString() }) {
  const tenant = assertWorkspaceId(workspaceId);
  const dbPath = path.resolve(database || "moneyfy.sqlite");
  const bundleDir = await createBundleDirectory(output);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const tableManifest = {};
  const assets = [];
  try {
    db.exec("PRAGMA query_only=ON; BEGIN;");
    if (!tableExists(db, "documents")) fail("Source database is not an initialized Forma ledger");
    const documentIds = new Set(db.prepare("SELECT id FROM documents").all().map((row) => row.id));
    if (tableExists(db, "invoices")) {
      const missing = db.prepare("SELECT id FROM invoices").all().filter((row) => !documentIds.has(row.id));
      if (missing.length) fail(`Legacy invoice migration is incomplete (${missing.length} invoices are missing from documents)`);
    }

    for (const table of Object.keys(TABLES)) {
      if (tableExists(db, table)) {
        const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
        const missing = TABLES[table].filter((column) => !columns.has(column));
        if (missing.length) fail(`Source schema is outdated: ${table} is missing ${missing.join(", ")}`);
      }
      let rows = tableExists(db, table) ? db.prepare(`SELECT * FROM ${table}`).all().map((row) => normalizeRow(table, row)) : [];
      if (table === "document_audit_events" && tableExists(db, "audit_events")) {
        const legacy = db.prepare("SELECT invoice_id AS document_id,type,detail_json,created_at FROM audit_events").all()
          .filter((row) => documentIds.has(row.document_id)).map((row) => normalizeRow(table, row));
        rows = [...legacy, ...rows];
      }
      if (table === "media_assets") {
        rows = rows.map((row) => ({ ...row, storage_key: `${tenant}/${safeRelative(String(row.storage_key).replace(/^[/\\]+/, ""), "media storage_key")}` }));
      }
      tableManifest[table] = await writeTable(bundleDir, table, rows);
    }

    const mediaRows = JSON.parse(await readSafeFile(bundleDir, tableManifest.media_assets.file, "media table", "utf8"));
    for (const asset of mediaRows) {
      const originalKey = asset.storage_key.slice(tenant.length + 1);
      const source = await safeFilePath(path.resolve(uploadDir), originalKey, "local asset key");
      const relative = `assets/${safeRelative(asset.storage_key, "hosted asset key")}`;
      const target = inside(bundleDir, relative, "bundle asset");
      const info = await stat(source).catch(() => null);
      if (!info?.isFile()) fail(`Missing local asset: ${originalKey}`);
      if (info.size !== asset.byte_size) fail(`Asset size mismatch: ${originalKey}`);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, target);
      const contents = await readFile(target);
      assets.push({ id: asset.id, storage_key: asset.storage_key, file: relative, bytes: contents.length, sha256: sha256(contents), content_type: asset.content_type });
    }
    db.exec("COMMIT;");
  } catch (error) {
    try { db.exec("ROLLBACK;"); } catch {}
    throw error;
  } finally {
    db.close();
  }

  return writeManifest(bundleDir, { createdAt, source: { type: "sqlite", database: path.basename(dbPath) }, workspaceId: tenant, tables: tableManifest, assets });
}

export async function verifyBundle(bundle) {
  if (!bundle) fail("--bundle is required");
  const bundleDir = path.resolve(bundle);
  const manifest = JSON.parse(await readSafeFile(bundleDir, "manifest.json", "manifest", "utf8"));
  if (manifest.format !== BUNDLE_FORMAT || manifest.version !== BUNDLE_VERSION) fail("Unsupported Forma bundle format or version");
  assertWorkspaceId(manifest.workspace_id);
  if (manifest.bucket !== STORAGE_BUCKET) fail("Unexpected Storage bucket in bundle");
  for (const table of Object.keys(TABLES)) {
    const entry = manifest.tables?.[table];
    if (!entry || entry.file !== `tables/${table}.json`) fail(`Missing manifest entry for ${table}`);
    const body = await readSafeFile(bundleDir, entry.file, `${table} file`, "utf8");
    if (sha256(body) !== entry.sha256) fail(`Checksum mismatch for ${table}`);
    const rows = JSON.parse(body);
    if (!Array.isArray(rows) || rows.length !== entry.rows) fail(`Row-count mismatch for ${table}`);
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) fail(`Invalid row in ${table}`);
      const unexpected = Object.keys(row).filter((column) => !TABLES[table].includes(column));
      if (unexpected.length) fail(`Unexpected columns in ${table}: ${unexpected.join(", ")}`);
      const missing = TABLES[table].filter((column) => !Object.hasOwn(row, column));
      if (missing.length) fail(`Missing columns in ${table}: ${missing.join(", ")}`);
    }
  }
  for (const asset of manifest.assets || []) {
    if (asset.file !== `assets/${asset.storage_key}`) fail(`Unexpected bundle path for asset ${asset.id}`);
    if (!asset.storage_key.startsWith(`${manifest.workspace_id}/`)) fail(`Asset ${asset.id} is outside the bundle workspace`);
    const body = await readSafeFile(bundleDir, asset.file, "asset file");
    if (body.length !== asset.bytes || sha256(body) !== asset.sha256) fail(`Checksum mismatch for asset ${asset.id}`);
  }
  const mediaRows = JSON.parse(await readSafeFile(bundleDir, manifest.tables.media_assets.file, "media table", "utf8"));
  const assetsById = new Map((manifest.assets || []).map((asset) => [asset.id, asset]));
  if (assetsById.size !== mediaRows.length || manifest.assets.length !== mediaRows.length) fail("Asset manifest does not match media metadata");
  for (const media of mediaRows) {
    const asset = assetsById.get(media.id);
    if (!asset || asset.storage_key !== media.storage_key || asset.bytes !== media.byte_size || asset.content_type !== media.content_type) fail(`Asset manifest does not match media metadata for ${media.id}`);
  }
  return { directory: bundleDir, manifest };
}

async function readRows(bundleDir, manifest, table) {
  const body = await readSafeFile(bundleDir, manifest.tables[table].file, `${table} file`, "utf8");
  if (sha256(body) !== manifest.tables[table].sha256) fail(`Checksum changed while reading ${table}`);
  return JSON.parse(body);
}

function postgresValue(table, column, value) {
  if (value === undefined) return null;
  if (JSON_COLUMNS.has(`${table}.${column}`)) return value === null ? null : JSON.stringify(value);
  return value;
}

async function insertRows(client, table, rows, workspaceId, transform = (row) => row) {
  const columns = ["workspace_id", ...TABLES[table]];
  for (const original of rows) {
    const row = transform({ ...original });
    const values = [workspaceId, ...TABLES[table].map((column) => postgresValue(table, column, row[column]))];
    const placeholders = values.map((_, index) => `$${index + 1}`).join(",");
    await client.query(`INSERT INTO public.${table} (${columns.join(",")}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`, values);
  }
}

async function assertEmptyTarget(client, workspaceId) {
  for (const table of Object.keys(TABLES)) {
    const result = await client.query(`SELECT count(*)::integer AS count FROM public.${table} WHERE workspace_id=$1`, [workspaceId]);
    if (result.rows[0].count && !REPLACEABLE_SEED_TABLES.has(table)) fail(`Target workspace contains non-seed data: ${table} has ${result.rows[0].count} rows`);
  }
}

async function clearTargetSeeds(client, workspaceId) {
  for (const table of ["branding_presets", "payment_methods", "reminder_rules", "email_templates", "settings"]) {
    await client.query(`DELETE FROM public.${table} WHERE workspace_id=$1`, [workspaceId]);
  }
}

async function verifyTargetCounts(client, manifest) {
  for (const table of Object.keys(TABLES)) {
    const result = await client.query(`SELECT count(*)::integer AS count FROM public.${table} WHERE workspace_id=$1`, [manifest.workspace_id]);
    if (result.rows[0].count !== manifest.tables[table].rows) fail(`Hosted row-count mismatch for ${table}: expected ${manifest.tables[table].rows}, found ${result.rows[0].count}`);
  }
}

function storageUrl(supabaseUrl, key, authenticated = false) {
  const encoded = safeRelative(key, "Storage key").split("/").map(encodeURIComponent).join("/");
  return `${String(supabaseUrl).replace(/\/$/, "")}/storage/v1/object/${authenticated ? "authenticated/" : ""}${STORAGE_BUCKET}/${encoded}`;
}

async function storageRequest(url, serviceRoleKey, options = {}) {
  const response = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(REMOTE_OPERATION_TIMEOUT_MS), headers: { authorization: `Bearer ${serviceRoleKey}`, apikey: serviceRoleKey, ...(options.headers || {}) } });
  if (!response.ok) fail(`Storage request failed (${response.status})`);
  return response;
}

export async function exportHostedBundle({ output, workspaceId, connectionString, supabaseUrl, serviceRoleKey, createdAt = new Date().toISOString() }) {
  const tenant = assertWorkspaceId(workspaceId);
  if (!connectionString || !supabaseUrl || !serviceRoleKey) fail("SUPABASE_DB_URL, SUPABASE_URL, and SUPABASE_SERVICE_ROLE_KEY are required for hosted export");
  const bundleDir = await createBundleDirectory(output);
  const client = new Client(postgresClientConfig(connectionString));
  const tableManifest = {};
  const tableRows = {};
  await client.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const workspace = await client.query("SELECT id FROM public.workspaces WHERE id=$1", [tenant]);
    if (!workspace.rowCount) fail("Hosted workspace does not exist");
    for (const [table, columns] of Object.entries(TABLES)) {
      const result = await client.query(`SELECT ${columns.join(",")} FROM public.${table} WHERE workspace_id=$1`, [tenant]);
      tableRows[table] = result.rows;
      tableManifest[table] = await writeTable(bundleDir, table, result.rows);
    }
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally { await client.end(); }

  const assets = [];
  for (const media of tableRows.media_assets) {
    if (!media.storage_key.startsWith(`${tenant}/`)) fail(`Hosted asset ${media.id} is outside its workspace`);
    const response = await storageRequest(storageUrl(supabaseUrl, media.storage_key, true), serviceRoleKey);
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length !== media.byte_size) fail(`Hosted asset size mismatch for ${media.id}`);
    const relative = `assets/${safeRelative(media.storage_key, "hosted asset key")}`;
    const target = inside(bundleDir, relative, "bundle asset");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body, { flag: "wx" });
    assets.push({ id: media.id, storage_key: media.storage_key, file: relative, bytes: body.length, sha256: sha256(body), content_type: media.content_type });
  }
  return writeManifest(bundleDir, { createdAt, source: { type: "supabase-postgres" }, workspaceId: tenant, tables: tableManifest, assets });
}

export async function uploadBundleAssets({ bundle, supabaseUrl, serviceRoleKey, upsert = false }) {
  const { directory, manifest } = await verifyBundle(bundle);
  if (!supabaseUrl || !serviceRoleKey) fail("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for asset upload");
  for (const asset of manifest.assets) {
    const body = await readSafeFile(directory, asset.file, "asset file");
    if (body.length !== asset.bytes || sha256(body) !== asset.sha256) fail(`Checksum changed while reading asset ${asset.id}`);
    await storageRequest(storageUrl(supabaseUrl, asset.storage_key), serviceRoleKey, {
      method: "POST", body,
      headers: { "content-type": asset.content_type, "x-upsert": String(Boolean(upsert)) },
    });
  }
  return { uploaded: manifest.assets.length };
}

export async function importBundle({ bundle, connectionString, supabaseUrl, serviceRoleKey, assetsOnly = false, upsertAssets = false }) {
  const { directory, manifest } = await verifyBundle(bundle);
  if (!assetsOnly) {
    if (!connectionString) fail("SUPABASE_DB_URL is required for database import");
    const client = new Client(postgresClientConfig(connectionString));
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`forma-import:${manifest.workspace_id}`]);
      const workspace = await client.query("SELECT id FROM public.workspaces WHERE id=$1", [manifest.workspace_id]);
      if (!workspace.rowCount) fail("Target workspace does not exist; create it through Forma onboarding first");
      await assertEmptyTarget(client, manifest.workspace_id);
      await clearTargetSeeds(client, manifest.workspace_id);

      const rows = {};
      for (const table of Object.keys(TABLES)) rows[table] = await readRows(directory, manifest, table);
      for (const table of INSERT_ORDER) {
        if (table === "documents") {
          await insertRows(client, table, rows[table], manifest.workspace_id, (row) => ({ ...row, source_document_id: null, recurring_schedule_id: null }));
        } else if (table === "recurring_schedules") {
          await insertRows(client, table, rows[table], manifest.workspace_id, (row) => ({ ...row, source_document_id: null }));
        } else {
          await insertRows(client, table, rows[table], manifest.workspace_id);
        }
      }
      for (const row of rows.documents) {
        if (row.source_document_id || row.recurring_schedule_id) await client.query("UPDATE public.documents SET source_document_id=$1,recurring_schedule_id=$2 WHERE workspace_id=$3 AND id=$4", [row.source_document_id, row.recurring_schedule_id, manifest.workspace_id, row.id]);
      }
      for (const row of rows.recurring_schedules) {
        if (row.source_document_id) await client.query("UPDATE public.recurring_schedules SET source_document_id=$1 WHERE workspace_id=$2 AND id=$3", [row.source_document_id, manifest.workspace_id, row.id]);
      }
      await verifyTargetCounts(client, manifest);
      await client.query("COMMIT");
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      throw error;
    } finally {
      await client.end();
    }
  }
  const storage = await uploadBundleAssets({ bundle: directory, supabaseUrl, serviceRoleKey, upsert: upsertAssets });
  return { workspace_id: manifest.workspace_id, database_imported: !assetsOnly, assets_uploaded: storage.uploaded };
}

export async function verifyHosted({ bundle, connectionString, supabaseUrl, serviceRoleKey }) {
  const { directory, manifest } = await verifyBundle(bundle);
  if (!connectionString || !supabaseUrl || !serviceRoleKey) fail("SUPABASE_DB_URL, SUPABASE_URL, and SUPABASE_SERVICE_ROLE_KEY are required");
  const client = new Client(postgresClientConfig(connectionString));
  await client.connect();
  try { await verifyTargetCounts(client, manifest); } finally { await client.end(); }
  for (const asset of manifest.assets) {
    const response = await storageRequest(storageUrl(supabaseUrl, asset.storage_key, true), serviceRoleKey);
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length !== asset.bytes || sha256(body) !== asset.sha256) fail(`Hosted asset mismatch for ${asset.id}`);
  }
  return { workspace_id: manifest.workspace_id, tables: Object.keys(TABLES).length, assets: manifest.assets.length, verified: true };
}

function parseArgs(args) {
  const [command, ...rest] = args;
  const options = {};
  const allowed = new Set(["database", "output", "workspace", "upload_dir", "bundle", "assets_only", "upsert_assets"]);
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (!value.startsWith("--")) fail(`Unexpected argument: ${value}`);
    const key = value.slice(2).replaceAll("-", "_");
    if (!allowed.has(key)) fail(`Unknown option: ${value}`);
    if (["assets_only", "upsert_assets"].includes(key)) options[key] = true;
    else options[key] = rest[++index] || fail(`Missing value for ${value}`);
  }
  return { command, options };
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  let result;
  if (command === "export") result = await exportBundle({ database: options.database || process.env.FORMA_DB || "moneyfy.sqlite", output: options.output, workspaceId: options.workspace, uploadDir: options.upload_dir || process.env.FORMA_UPLOAD_DIR || "uploads" });
  else if (command === "export-hosted") result = await exportHostedBundle({ output: options.output, workspaceId: options.workspace, connectionString: process.env.SUPABASE_DB_URL, supabaseUrl: process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY });
  else if (command === "verify-bundle") result = await verifyBundle(options.bundle);
  else if (command === "import") result = await importBundle({ bundle: options.bundle, connectionString: process.env.SUPABASE_DB_URL, supabaseUrl: process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY, assetsOnly: options.assets_only, upsertAssets: options.upsert_assets });
  else if (command === "verify-hosted") result = await verifyHosted({ bundle: options.bundle, connectionString: process.env.SUPABASE_DB_URL, supabaseUrl: process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY });
  else fail("Usage: forma-data.mjs export|export-hosted|verify-bundle|import|verify-hosted [options]");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`Forma data operation failed: ${error.message}\n`); process.exitCode = 1; });
}
