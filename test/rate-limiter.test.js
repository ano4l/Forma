import assert from "node:assert/strict";
import test from "node:test";
import { createRateLimiter, rateLimiterStatus } from "../rate-limiter.js";

function responseBox() {
  return {
    headers: {}, statusCode: 200, body: null,
    set(name, value) { this.headers[name] = value; return this; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

test("bounded memory limiter rejects excess requests and evicts old identities", async () => {
  let timestamp = 1_000;
  const limiter = createRateLimiter({ environment: { NODE_ENV: "development" }, now: () => timestamp, maxMemoryBuckets: 2 });
  const middleware = limiter.middleware({ name: "api", limit: 2, windowMs: 60_000 });
  let nextCalls = 0;
  for (let index = 0; index < 3; index += 1) {
    const response = responseBox();
    await middleware({ ip: "192.0.2.1" }, response, () => { nextCalls += 1; });
    if (index === 2) { assert.equal(response.statusCode, 429); assert.equal(response.body.error.code, "RATE_LIMITED"); }
  }
  assert.equal(nextCalls, 2);
  await middleware({ ip: "192.0.2.2" }, responseBox(), () => {});
  await middleware({ ip: "192.0.2.3" }, responseBox(), () => {});
  assert.equal(limiter.memorySize(), 2);
  timestamp += 61_000;
  const reset = responseBox();
  await middleware({ ip: "192.0.2.1" }, reset, () => { nextCalls += 1; });
  assert.equal(reset.statusCode, 200);
});

test("distributed limiter uses an atomic Redis command and pseudonymizes IPs", async () => {
  let request;
  const environment = { NODE_ENV: "production", FORMA_RATE_LIMIT_REDIS_URL: "https://redis.test", FORMA_RATE_LIMIT_REDIS_TOKEN: "redis-token-value", FORMA_RATE_LIMIT_KEY_SECRET: "k".repeat(32) };
  const limiter = createRateLimiter({ environment, fetchImpl: async (url, options) => { request = { url, options }; return new Response(JSON.stringify({ result: [1, 60_000] }), { status: 200, headers: { "content-type": "application/json" } }); }, now: () => 10_000 });
  assert.deepEqual(rateLimiterStatus(environment), { provider: "redis", configured: true, distributed: true, required: true });
  let passed = false; const response = responseBox();
  await limiter.middleware({ name: "portal", limit: 20 })({ ip: "203.0.113.10" }, response, () => { passed = true; });
  assert.equal(passed, true);
  assert.equal(request.url, environment.FORMA_RATE_LIMIT_REDIS_URL);
  assert.equal(request.options.headers.authorization, "Bearer redis-token-value");
  const command = JSON.parse(request.options.body);
  assert.equal(command[0], "EVAL");
  assert.equal(command[2], "1");
  assert.doesNotMatch(command[3], /203\.0\.113\.10/);
  assert.match(command[3], /^forma:rate:portal:[a-f0-9]{64}$/);
});

test("distributed limiter degrades to its bounded local safety net", async () => {
  const environment = { NODE_ENV: "production", FORMA_RATE_LIMIT_REDIS_URL: "https://redis.test", FORMA_RATE_LIMIT_REDIS_TOKEN: "redis-token-value", FORMA_RATE_LIMIT_KEY_SECRET: "k".repeat(32) };
  const limiter = createRateLimiter({ environment, fetchImpl: async () => { throw new Error("offline"); } });
  const response = responseBox(); let passed = false;
  await limiter.middleware({ name: "api", limit: 1 })({ ip: "203.0.113.20" }, response, () => { passed = true; });
  assert.equal(passed, true);
  assert.equal(response.headers["X-Forma-RateLimit-Fallback"], "memory");
  assert.equal(limiter.memorySize(), 1);
});
