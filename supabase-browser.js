const SESSION_KEY = "forma.supabase.session.v1";

const jsonError = async (response, fallback) => {
  const payload = await response.json().catch(() => ({}));
  return new Error(payload.error_description || payload.msg || payload.message || payload.error || fallback);
};

export class SupabaseBrowserAuth {
  constructor(config, { fetchImpl = globalThis.fetch, storage = globalThis.localStorage, location = globalThis.location, history = globalThis.history } = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.storage = storage;
    this.location = location;
    this.history = history;
    this.session = this.readSession();
  }

  readSession() {
    try { return JSON.parse(this.storage?.getItem(SESSION_KEY) || "null"); }
    catch { this.storage?.removeItem(SESSION_KEY); return null; }
  }

  saveSession(session) {
    if (!session?.access_token) return this.clearSession();
    const expiresAt = Number(session.expires_at) || Math.floor(Date.now() / 1000) + Number(session.expires_in || 3600);
    this.session = { ...session, expires_at: expiresAt };
    this.storage?.setItem(SESSION_KEY, JSON.stringify(this.session));
    return this.session;
  }

  clearSession() { this.session = null; this.storage?.removeItem(SESSION_KEY); return null; }

  async request(path, { method = "POST", body } = {}) {
    const response = await this.fetchImpl(`${this.config.supabase_url}${path}`, {
      method,
      headers: { apikey: this.config.publishable_key, Authorization: `Bearer ${this.config.publishable_key}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (!response.ok) throw await jsonError(response, "Supabase Auth request failed");
    return response.json();
  }

  async signIn(email, password) {
    const session = await this.request("/auth/v1/token?grant_type=password", { body: { email, password } });
    return this.saveSession(session);
  }

  async signUp(email, password, metadata = {}) {
    const emailRedirectTo = `${this.location?.origin || "http://localhost"}${this.location?.pathname || "/"}`;
    const result = await this.request("/auth/v1/signup", { body: { email, password, data: metadata, email_redirect_to: emailRedirectTo } });
    return result.access_token ? this.saveSession(result) : { confirmation_required: true, user: result.user || null };
  }

  oauthUrl(provider) {
    const redirectTo = new URL(this.location?.origin || "http://localhost");
    redirectTo.searchParams.set("auth_callback", "1");
    const url = new URL(`${this.config.supabase_url}/auth/v1/authorize`);
    url.searchParams.set("provider", provider);
    url.searchParams.set("redirect_to", redirectTo.toString());
    return url.toString();
  }

  consumeOAuthCallback() {
    const hash = String(this.location?.hash || "").replace(/^#/, "");
    const parameters = new URLSearchParams(hash);
    if (!parameters.get("access_token")) return this.session;
    const session = this.saveSession({
      access_token: parameters.get("access_token"),
      refresh_token: parameters.get("refresh_token"),
      token_type: parameters.get("token_type") || "bearer",
      expires_in: Number(parameters.get("expires_in") || 3600)
    });
    this.history?.replaceState?.(null, "", `${this.location.pathname || "/"}#documents`);
    return session;
  }

  async accessToken() {
    if (!this.session?.access_token) return "";
    const refreshAt = Number(this.session.expires_at || 0) - 60;
    if (refreshAt > Math.floor(Date.now() / 1000)) return this.session.access_token;
    if (!this.session.refresh_token) return this.clearSession() || "";
    try {
      const refreshed = await this.request("/auth/v1/token?grant_type=refresh_token", { body: { refresh_token: this.session.refresh_token } });
      return this.saveSession(refreshed).access_token;
    } catch { this.clearSession(); return ""; }
  }

  async signOut() {
    const token = this.session?.access_token;
    this.clearSession();
    if (!token) return;
    await this.fetchImpl(`${this.config.supabase_url}/auth/v1/logout`, { method: "POST", headers: { apikey: this.config.publishable_key, Authorization: `Bearer ${token}` } }).catch(() => {});
  }
}

export { SESSION_KEY };
