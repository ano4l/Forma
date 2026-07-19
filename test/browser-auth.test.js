import test from "node:test";
import assert from "node:assert/strict";
import { SESSION_KEY, SupabaseBrowserAuth } from "../supabase-browser.js";

const config = { supabase_url: "https://project.supabase.co", publishable_key: "publishable-test" };
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}

test("browser auth signs in and persists a normalized session", async () => {
  const storage = memoryStorage(); let request;
  const auth = new SupabaseBrowserAuth(config, { storage, fetchImpl: async (url, options) => { request = { url, options }; return jsonResponse({ access_token: "access", refresh_token: "refresh", expires_in: 3600, user: { id: "user-1" } }); } });
  const session = await auth.signIn("owner@forma.test", "secret-password");
  assert.equal(request.url, "https://project.supabase.co/auth/v1/token?grant_type=password");
  assert.deepEqual(JSON.parse(request.options.body), { email: "owner@forma.test", password: "secret-password" });
  assert.equal(session.access_token, "access");
  assert.ok(session.expires_at > Math.floor(Date.now() / 1000));
  assert.equal(JSON.parse(storage.getItem(SESSION_KEY)).refresh_token, "refresh");
});

test("browser auth refreshes expired access tokens and clears failed sessions", async () => {
  const expired = { access_token: "old", refresh_token: "refresh", expires_at: 1 };
  const storage = memoryStorage({ [SESSION_KEY]: JSON.stringify(expired) }); let calls = 0;
  const auth = new SupabaseBrowserAuth(config, { storage, fetchImpl: async () => { calls += 1; return jsonResponse({ access_token: "new", refresh_token: "refresh-2", expires_in: 3600 }); } });
  assert.equal(await auth.accessToken(), "new"); assert.equal(calls, 1);

  auth.session.expires_at = 1;
  auth.fetchImpl = async () => jsonResponse({ message: "invalid refresh token" }, 401);
  assert.equal(await auth.accessToken(), "");
  assert.equal(storage.getItem(SESSION_KEY), null);
});

test("browser auth handles confirmation-required sign-up and OAuth callbacks", async () => {
  const storage = memoryStorage(); const replaced = [];
  const location = { origin: "https://forma.example", pathname: "/app", hash: "#access_token=oauth-access&refresh_token=oauth-refresh&expires_in=1800&token_type=bearer" };
  const auth = new SupabaseBrowserAuth(config, { storage, location, history: { replaceState: (...args) => replaced.push(args) }, fetchImpl: async () => jsonResponse({ user: { id: "pending" } }) });
  assert.deepEqual(await auth.signUp("new@forma.test", "secret-password"), { confirmation_required: true, user: { id: "pending" } });
  assert.equal(auth.consumeOAuthCallback().access_token, "oauth-access");
  assert.deepEqual(replaced[0], [null, "", "/app#documents"]);
  const oauth = new URL(auth.oauthUrl("google"));
  assert.equal(oauth.searchParams.get("provider"), "google");
  assert.equal(new URL(oauth.searchParams.get("redirect_to")).searchParams.get("auth_callback"), "1");
});

test("browser logout clears local state and revokes the active token", async () => {
  const storage = memoryStorage({ [SESSION_KEY]: JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_at: 9999999999 }) }); let request;
  const auth = new SupabaseBrowserAuth(config, { storage, fetchImpl: async (url, options) => { request = { url, options }; return jsonResponse({}); } });
  await auth.signOut();
  assert.equal(storage.getItem(SESSION_KEY), null);
  assert.equal(request.url, "https://project.supabase.co/auth/v1/logout");
  assert.equal(request.options.headers.Authorization, "Bearer access");
});
