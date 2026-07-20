# Forma production operations

## Release gate

Every production release should pass `npm ci`, `npm run build`, `npm test`, the high-severity production dependency audit, and parsing of every ordered Supabase migration. The GitHub Actions workflow enforces these checks on pull requests and pushes to `master`.

Deploy migrations before application code that depends on them. Take a database recovery point first, apply migrations in a staging project, run the owner/member/viewer tenant-isolation checklist, then apply production and deploy the matching application revision. Do not deploy hosted mode with `FORMA_AUTH_MODE` other than `required`.

## Health and monitoring

- `/api/health` is a process liveness check and reports only configuration state.
- `/api/ready` checks the active data backend and should be the deployment readiness/health-check target.
- Every response includes `X-Request-Id`. Production request and server-error logs are newline-delimited JSON, so an incident can be traced without logging request bodies, authorization values, provider payloads, or financial details.
- Set `FORMA_METRICS_SECRET` and scrape `GET /api/internal/metrics` with a Bearer token. The Prometheus text export contains status-family counts, aggregate/average latency, error-code counts, uptime, and heap use; it deliberately omits routes, workspace IDs, document IDs, and customer labels.
- Optionally set `FORMA_ERROR_WEBHOOK_URL` and `FORMA_ERROR_WEBHOOK_SECRET` to send a signed, sanitized envelope for server errors. The envelope includes only service/environment, request ID, method, route template, status, code, and timestamp. Production accepts only HTTPS sinks.
- Alert on readiness failures, HTTP 5xx rate, webhook 4xx/5xx responses, scheduled-operation failures, email bounce/complaint growth, unmatched provider events, and payment reconciliation mismatches.

The built-in limiter protects a single Node process. Production should also enforce per-IP and per-route limits at the CDN/WAF because in-memory counters are not shared between serverless instances.

## Scheduled work

Invoke `POST /api/internal/run-operations` with `X-Forma-Cron-Secret` at least every 15 minutes. Use a dedicated random secret and rotate it after any exposure. The endpoint claims retries and reminder/run records before work, making overlapping scheduler calls duplicate-safe. It also applies each workspace's provider-payload retention policy: raw callback JSON is replaced with a redaction marker after the configured window, while provider/event IDs and processed timestamps remain available for idempotency and incident correlation. A legal hold pauses redaction.

## Backup and recovery

1. Enable managed Supabase backups and point-in-time recovery appropriate to the production recovery objectives.
2. Take an encrypted logical database export before migrations and at a regular off-platform cadence. Use `npm run data:export-hosted -- --workspace <uuid> --output <new-directory>` plus `npm run data:verify -- --bundle <directory>` for a tenant-bound, checksum-covered business-data and private-object inventory. Restrict and audit access to exports because they contain customer and financial data.
3. Keep private Storage objects under the workspace UUID prefix and include the `forma-private` bucket in the backup inventory. Include `document_portal_links` and `workspace_invitations`; their stored values are hashes and cannot reconstruct a lost share secret.
4. Quarterly, restore the latest database and object backup into an isolated project, rotate restored secrets, and verify sign-in, tenant isolation, document/PDF retrieval, outstanding balances, and provider-event idempotency.
5. Record recovery time, recovery point, row counts, object counts, and any manual remediation. A backup is not considered valid until a restore drill succeeds.

The executable SQLite cutover, hosted export, resume, verification, and restore-drill procedure is in `docs/data-migration.md`. Portable bundles deliberately exclude Supabase Auth users and workspace membership, so whole-project recovery still requires managed backup/PITR or an encrypted full logical database backup.

For rollback, stop scheduled/provider delivery first, roll application traffic back to the last compatible revision, and restore data only when forward repair is unsafe. Never replay payment callbacks against a database restored to an earlier point without first comparing `provider_webhook_events`, `payment_checkouts`, and provider dashboards.

## Secret rotation

Rotate Supabase service-role, cron, Resend, Stripe, and PayPal credentials independently. Update the deployment secret store, redeploy, test readiness and a sandbox callback, then revoke the prior credential. Webhook endpoint secrets/IDs must match the exact endpoint and environment; test and live values are not interchangeable.

## Incident priorities

1. Prevent duplicate or incorrect money movement: disable payment-link creation/capture while preserving signed webhook ingestion for later replay.
2. Preserve evidence: retain request IDs, provider event IDs, audit events, and deployment/migration revisions.
3. Contain tenant exposure: revoke affected sessions/keys and verify RLS/service boundaries before restoring traffic.
4. Communicate from confirmed ledger/provider evidence; never infer payment success from a browser redirect alone.
