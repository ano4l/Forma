import { createHmac } from "node:crypto";

const MAX_MEMORY_BUCKETS = 10_000;
const REDIS_TIMEOUT_MS = 2_000;
const LUA_FIXED_WINDOW = "local current=redis.call('INCR',KEYS[1]); if current==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]); end; local ttl=redis.call('PTTL',KEYS[1]); return {current,ttl}";
const value = (environment, name) => String(environment[name] || "").trim();

function validRedisUrl(raw, production) {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" || (!production && parsed.protocol === "http:");
  } catch { return false; }
}

export function rateLimiterStatus(environment = process.env) {
  const production = environment.NODE_ENV === "production";
  const url = value(environment, "FORMA_RATE_LIMIT_REDIS_URL");
  const token = value(environment, "FORMA_RATE_LIMIT_REDIS_TOKEN");
  const keySecret = value(environment, "FORMA_RATE_LIMIT_KEY_SECRET");
  const configured = Boolean(validRedisUrl(url, production) && token.length >= 16 && keySecret.length >= 24);
  return { provider: configured ? "redis" : "memory", configured, distributed: configured, required: production };
}

function setHeaders(response, limit, count, resetAt) {
  response.set("RateLimit-Limit", String(limit))
    .set("RateLimit-Remaining", String(Math.max(0, limit - count)))
    .set("RateLimit-Reset", String(Math.ceil(resetAt / 1000)));
}

function reject(response, resetAt, now) {
  return response.status(429).set("Retry-After", String(Math.max(1, Math.ceil((resetAt - now) / 1000))))
    .json({ error: { code: "RATE_LIMITED", message: "Too many requests; try again shortly" } });
}

export function createRateLimiter({ environment = process.env, fetchImpl = globalThis.fetch, now = () => Date.now(), maxMemoryBuckets = MAX_MEMORY_BUCKETS } = {}) {
  const status = rateLimiterStatus(environment);
  const memory = new Map();
  const identity = (ip) => status.configured ? createHmac("sha256", value(environment, "FORMA_RATE_LIMIT_KEY_SECRET")).update(String(ip || "unknown")).digest("hex") : String(ip || "unknown");

  function memoryBucket(key, windowMs, timestamp) {
    let entry = memory.get(key);
    if (!entry || entry.resetAt <= timestamp) entry = { count: 0, resetAt: timestamp + windowMs };
    entry.count += 1;
    memory.set(key, entry);
    if (memory.size > maxMemoryBuckets) {
      for (const [candidate, value] of memory) if (value.resetAt <= timestamp) memory.delete(candidate);
      while (memory.size > maxMemoryBuckets) memory.delete(memory.keys().next().value);
    }
    return entry;
  }

  async function redisBucket(key, windowMs) {
    const response = await fetchImpl(value(environment, "FORMA_RATE_LIMIT_REDIS_URL").replace(/\/$/, ""), {
      method: "POST",
      headers: { authorization: `Bearer ${value(environment, "FORMA_RATE_LIMIT_REDIS_TOKEN")}`, "content-type": "application/json" },
      body: JSON.stringify(["EVAL", LUA_FIXED_WINDOW, "1", key, String(windowMs)]),
      signal: AbortSignal.timeout(REDIS_TIMEOUT_MS),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !Array.isArray(payload?.result) || payload.result.length !== 2) throw new Error("Distributed rate limiter is unavailable");
    const count = Number(payload.result[0]); const ttl = Number(payload.result[1]);
    if (!Number.isFinite(count) || !Number.isFinite(ttl) || ttl < 0) throw new Error("Distributed rate limiter returned an invalid result");
    return { count, ttl };
  }

  const middleware = ({ name, limit, windowMs = 60_000 }) => async (request, response, next) => {
    const timestamp = now(); const normalizedLimit = Math.max(1, Math.round(Number(limit) || 1)); const normalizedWindow = Math.max(1_000, Math.round(Number(windowMs) || 60_000));
    const key = `forma:rate:${name}:${identity(request.ip)}`;
    if (status.configured) {
      let remoteEntry = null;
      try {
        remoteEntry = await redisBucket(key, normalizedWindow);
      } catch { response.set("X-Forma-RateLimit-Fallback", "memory"); }
      if (remoteEntry) {
        const resetAt = timestamp + remoteEntry.ttl;
        setHeaders(response, normalizedLimit, remoteEntry.count, resetAt);
        if (remoteEntry.count > normalizedLimit) return reject(response, resetAt, timestamp);
        return next();
      }
    }
    const entry = memoryBucket(key, normalizedWindow, timestamp);
    setHeaders(response, normalizedLimit, entry.count, entry.resetAt);
    if (entry.count > normalizedLimit) return reject(response, entry.resetAt, timestamp);
    return next();
  };
  return { middleware, status, memorySize: () => memory.size };
}
