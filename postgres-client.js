const REMOTE_OPERATION_TIMEOUT_MS = 60_000;

export function postgresClientConfig(connectionString) {
  if (!connectionString) throw new Error("A PostgreSQL connection string is required");
  let parsed;
  try { parsed = new URL(connectionString); } catch { throw new Error("The PostgreSQL connection string is invalid"); }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) throw new Error("The PostgreSQL connection string must use postgres:// or postgresql://");
  const local = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname.toLowerCase());
  return {
    connectionString,
    ssl: local ? false : { rejectUnauthorized: true },
    connectionTimeoutMillis: 15_000,
    query_timeout: REMOTE_OPERATION_TIMEOUT_MS,
    statement_timeout: REMOTE_OPERATION_TIMEOUT_MS,
    application_name: "forma-data-operations",
  };
}
