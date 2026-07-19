import test from "node:test";
import assert from "node:assert/strict";
import { createSupabaseStore } from "../supabase-store.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";

function jsonResponse(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }); }

function createHarness(role = "member") {
  const calls = []; const rows = new Map();
  const auth = {
    workspaceId, role,
    async supabaseFetch(path, options = {}) {
      calls.push({ path, options });
      if (path.startsWith("/storage/v1/object/authenticated/")) return new Response(Buffer.from("stored-file"), { status: 200 });
      if (path.startsWith("/storage/v1/object/")) return jsonResponse({ Key: path }, 200);
      if (path.endsWith("/rpc/allocate_document_number")) return jsonResponse("INV-2026-00001");
      if (path.endsWith("/rpc/create_document_record")) {
        const input = JSON.parse(options.body); const number = input.requested_number || "INV-2026-00001";
        return jsonResponse({ workspace_id: workspaceId, id: input.target_id, document_type: input.target_type, number, number_year: input.target_year, status: "draft", customer_id: input.target_customer_id, source_document_id: input.target_source_document_id, recurring_schedule_id: input.target_recurring_schedule_id, data_json: { ...input.target_data, number }, totals_json: input.target_totals, snapshot_json: null, amount_paid_minor: 0, balance_due_minor: input.target_totals.total_minor, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), issued_at: null, finalized_at: null });
      }
      const table = path.match(/^\/rest\/v1\/([^?]+)/)?.[1];
      if (!table) return jsonResponse({ message: "not found" }, 404);
      if ((options.method || "GET") === "GET") {
        if (table === "documents") return jsonResponse([...(rows.get(table) || [])]);
        return jsonResponse([]);
      }
      const body = JSON.parse(options.body || "null");
      if (options.method === "POST") {
        const inserted = Array.isArray(body) ? body : [body];
        if (table === "documents") rows.set(table, [...(rows.get(table) || []), ...inserted]);
        return jsonResponse(inserted);
      }
      if (options.method === "PATCH") return jsonResponse([{ ...(rows.get(table)?.[0] || {}), ...body }]);
      if (options.method === "DELETE") return jsonResponse(rows.get(table)?.slice(0, 1) || []);
      return jsonResponse([]);
    },
    serviceFetch(path, options = {}) { return auth.supabaseFetch(path, options); }
  };
  return { auth, calls, store: createSupabaseStore({ getAuth: () => auth }) };
}

test("Supabase store scopes reads, writes, numbering, and generated documents to the active workspace", async () => {
  const { store, calls } = createHarness();
  const document = await store.createDocument({ document_type: "invoice", supplier: { name: "Forma", address: "Cape Town" }, customer: { name: "Acme", address: "Johannesburg" }, items: [{ description: "Advisory", quantity: 1, unit_price_minor: 10000, tax_bps: 1500 }] });
  assert.equal(document.number, "INV-2026-00001");
  assert.equal(document.totals.total_minor, 11500);

  const documentWrite = calls.find((call) => call.path.endsWith("/rpc/create_document_record"));
  const workflow = JSON.parse(documentWrite.options.body);
  assert.equal(workflow.target_workspace, workspaceId);
  assert.equal(workflow.target_type, "invoice");
  assert.equal(workflow.target_year, new Date().getFullYear());

  await store.listDocuments({ document_type: "invoice" });
  const documentRead = calls.findLast((call) => call.path.startsWith("/rest/v1/documents") && !call.options.method);
  assert.match(documentRead.path, new RegExp(`workspace_id=eq\\.${workspaceId}`));
  assert.match(documentRead.path, /document_type=eq.invoice/);
});

test("Supabase private object operations require a workspace-prefixed path", async () => {
  const { store, calls } = createHarness();
  const key = `${workspaceId}/documents/document-1/attachment.pdf`;
  await store.uploadObject(key, Buffer.from("%PDF-file"), "application/pdf");
  assert.equal((await store.downloadObject(key)).toString(), "stored-file");
  await store.deleteObject(key);
  assert.ok(calls.every((call) => !call.path.includes("../")));
  assert.match(calls[0].path, new RegExp(`forma-private/${workspaceId}/documents/document-1/attachment\\.pdf$`));
  assert.throws(() => store.storageKey("another-workspace/private.pdf"), /outside the active workspace/);
});

test("viewer reads do not attempt workspace seed writes", async () => {
  const { store, calls } = createHarness("viewer");
  assert.deepEqual(await store.listDocuments(), []);
  assert.equal(calls.some((call) => call.options.method === "POST"), false);
  await assert.rejects(() => store.saveCustomer({ name: "Forbidden write" }), /Member workspace access is required/);
});
