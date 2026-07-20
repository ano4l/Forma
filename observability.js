import { createHmac } from "node:crypto";

const metricName = (value) => String(value || "unknown").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_|_$/g, "") || "unknown";
const env = (name, environment) => String(environment[name] || "").trim();

export function createObservability({ environment = process.env, fetchImpl = globalThis.fetch } = {}) {
  const startedAt = Date.now(); const requests = new Map(); const errors = new Map(); let totalDurationMs = 0; let totalRequests = 0;
  const errorUrl = env("FORMA_ERROR_WEBHOOK_URL", environment); const errorSecret = env("FORMA_ERROR_WEBHOOK_SECRET", environment);
  let parsedErrorUrl = null; try { parsedErrorUrl = errorUrl ? new URL(errorUrl) : null; } catch { parsedErrorUrl = null; }
  if (parsedErrorUrl && !["https:", ...(environment.NODE_ENV === "production" ? [] : ["http:"])].includes(parsedErrorUrl.protocol)) parsedErrorUrl = null;
  const increment = (map, key) => { const boundedKey = !map.has(key) && map.size >= 100 ? "other:500" : key; map.set(boundedKey, (map.get(boundedKey) || 0) + 1); };
  return {
    configured: Boolean(parsedErrorUrl),
    recordRequest(status, durationMs) { const family = status >= 500 ? "5xx" : status >= 400 ? "4xx" : status >= 300 ? "3xx" : "2xx"; increment(requests, family); totalRequests += 1; totalDurationMs += Number(durationMs) || 0; },
    recordError(code, status) { increment(errors, `${metricName(code)}:${Number(status) || 500}`); },
    async notifyError(event) {
      if (!parsedErrorUrl) return false;
      const body = JSON.stringify({ service: "forma", environment: env("NODE_ENV", environment) || "development", event: "request_error", request_id: event.request_id, method: event.method, route: event.route || "unmatched", status: event.status, code: event.code, occurred_at: new Date().toISOString() });
      const headers = { "Content-Type": "application/json", "User-Agent": "Forma-Observability/1.0" }; if (errorSecret) headers["X-Forma-Signature"] = `sha256=${createHmac("sha256", errorSecret).update(body).digest("hex")}`;
      try { const response = await fetchImpl(parsedErrorUrl, { method: "POST", headers, body, signal: AbortSignal.timeout(2500) }); return response.ok; } catch { return false; }
    },
    prometheus() {
      const memory = process.memoryUsage(); const lines = ["# HELP forma_uptime_seconds Process uptime.", "# TYPE forma_uptime_seconds gauge", `forma_uptime_seconds ${Math.floor((Date.now() - startedAt) / 1000)}`, "# HELP forma_http_requests_total HTTP responses by status family.", "# TYPE forma_http_requests_total counter"];
      for (const family of ["2xx", "3xx", "4xx", "5xx"]) lines.push(`forma_http_requests_total{status_family="${family}"} ${requests.get(family) || 0}`);
      lines.push("# HELP forma_http_request_duration_ms_total Aggregate request duration.", "# TYPE forma_http_request_duration_ms_total counter", `forma_http_request_duration_ms_total ${Math.round(totalDurationMs * 10) / 10}`, "# HELP forma_http_request_duration_ms_average Average request duration.", "# TYPE forma_http_request_duration_ms_average gauge", `forma_http_request_duration_ms_average ${totalRequests ? Math.round(totalDurationMs / totalRequests * 10) / 10 : 0}`, "# HELP forma_errors_total Application errors by code and status.", "# TYPE forma_errors_total counter");
      for (const [key, value] of errors) { const [code, status] = key.split(":"); lines.push(`forma_errors_total{code="${code}",status="${status}"} ${value}`); }
      lines.push("# HELP forma_process_heap_bytes Node.js heap use.", "# TYPE forma_process_heap_bytes gauge", `forma_process_heap_bytes ${memory.heapUsed}`, ""); return lines.join("\n");
    }
  };
}
