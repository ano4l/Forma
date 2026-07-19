const normalizeUrl = (value = "") => String(value).trim().replace(/\/+$/, "");
const bearerToken = (request) => {
  const authorization = String(request.get("authorization") || "");
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
};

export function resolveAuthConfig(environment = process.env) {
  const url = normalizeUrl(environment.SUPABASE_URL);
  const publishableKey = String(environment.SUPABASE_PUBLISHABLE_KEY || environment.SUPABASE_ANON_KEY || "").trim();
  const configured = Boolean(url && publishableKey);
  const requestedMode = String(environment.FORMA_AUTH_MODE || (configured ? "required" : "disabled")).trim().toLowerCase();
  const mode = ["disabled", "optional", "required"].includes(requestedMode) ? requestedMode : "required";
  const providers = String(environment.FORMA_AUTH_PROVIDERS || "email,google,azure").split(",").map((provider) => provider.trim()).filter(Boolean);
  return { url, publishableKey, configured, mode, providers };
}

export function publicAuthConfig(config = resolveAuthConfig()) {
  return {
    mode: config.mode,
    configured: config.configured,
    supabase_url: config.configured ? config.url : "",
    publishable_key: config.configured ? config.publishableKey : "",
    providers: config.providers
  };
}

const authError = (response, fallback) => {
  const cause = new Error(fallback);
  cause.status = response.status === 401 || response.status === 403 ? 401 : 503;
  cause.code = response.status === 401 || response.status === 403 ? "AUTHENTICATION_REQUIRED" : "AUTH_SERVICE_UNAVAILABLE";
  return cause;
};

export function createAuthMiddleware({ config = resolveAuthConfig(), fetchImpl = globalThis.fetch } = {}) {
  const publicConfig = publicAuthConfig(config);
  const middleware = async (request, response, next) => {
    if (config.mode === "disabled") { request.auth = null; return next(); }
    if (!config.configured) {
      if (config.mode === "required") return response.status(503).json({ error: { code: "AUTH_NOT_CONFIGURED", message: "Supabase Auth is required but not configured" } });
      request.auth = null; return next();
    }
    const token = bearerToken(request);
    if (!token) {
      if (config.mode === "required") return response.status(401).json({ error: { code: "AUTHENTICATION_REQUIRED", message: "Sign in to continue" } });
      request.auth = null; return next();
    }
    const supabaseFetch = (path, options = {}) => fetchImpl(`${config.url}${path}`, {
      ...options,
      headers: {
        apikey: config.publishableKey,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });
    try {
      const userResponse = await supabaseFetch("/auth/v1/user");
      if (!userResponse.ok) return next(authError(userResponse, "The Supabase session is invalid or expired"));
      const user = await userResponse.json();
      const membershipResponse = await supabaseFetch(`/rest/v1/workspace_memberships?select=workspace_id,role,status,workspaces(id,name,slug)&user_id=eq.${encodeURIComponent(user.id)}&status=eq.active`);
      if (!membershipResponse.ok) return next(authError(membershipResponse, "Workspace memberships could not be loaded"));
      const memberships = await membershipResponse.json();
      const requestedWorkspace = String(request.get("x-workspace-id") || "").trim();
      const selected = requestedWorkspace ? memberships.find((membership) => membership.workspace_id === requestedWorkspace) : memberships.length === 1 ? memberships[0] : null;
      if (requestedWorkspace && !selected) return response.status(403).json({ error: { code: "WORKSPACE_ACCESS_DENIED", message: "You do not have access to that workspace" } });
      request.auth = { user, token, memberships, workspaceId: selected?.workspace_id || null, role: selected?.role || null, supabaseFetch };
      return next();
    } catch (cause) {
      cause.status ||= 503; cause.code ||= "AUTH_SERVICE_UNAVAILABLE"; return next(cause);
    }
  };
  middleware.config = config;
  middleware.publicConfig = publicConfig;
  return middleware;
}

