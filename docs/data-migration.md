# Forma data cutover and recovery

Forma includes a portable, tenant-bound data bundle for the initial SQLite cutover and off-platform workspace exports. Every table file and private object is covered by a SHA-256 manifest. Imports inject one immutable workspace UUID, run all database writes in a single PostgreSQL transaction, reject a non-empty target, and verify exact row counts before commit.

The bundle contains Forma business data and private objects. It does not contain Supabase Auth users, workspace memberships, or provider secrets. Managed database backups/PITR and a full encrypted logical backup remain the authoritative whole-project recovery mechanism.

## Initial SQLite cutover

1. Apply every file in `supabase/migrations` and sign in to Forma once to create the destination workspace. Record that workspace UUID.
2. Stop writes to the SQLite deployment. Start the current application against the ledger once before export so all local schema migrations have run.
3. Create and verify a bundle. The destination directory must not already exist.

```powershell
npm run data:export -- --workspace <workspace-uuid> --database .\moneyfy.sqlite --upload-dir .\uploads --output .\cutover-bundles\initial-cutover
npm run data:verify -- --bundle .\cutover-bundles\initial-cutover
```

4. Configure `SUPABASE_DB_URL`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY` in the process environment, then import. The workspace must exist and contain no user/business activity. Defaults automatically created while onboarding (settings, payment methods, branding, email templates, and reminder rules) are replaced atomically by the bundle; any customer, product, document, sequence, delivery, payment, suppression, recurring, portal, or provider row blocks the import.

```powershell
npm run data:import -- --bundle .\cutover-bundles\initial-cutover
npm run data:verify-hosted -- --bundle .\cutover-bundles\initial-cutover
```

The PostgreSQL phase commits before object upload. If an object upload is interrupted, do not rerun the database import. Resume only the manifest-verified objects, explicitly allowing those same objects to be replaced, and verify the destination again:

```powershell
npm run data:import -- --bundle .\cutover-bundles\initial-cutover --assets-only --upsert-assets
npm run data:verify-hosted -- --bundle .\cutover-bundles\initial-cutover
```

Do not use `--upsert-assets` with an untrusted or edited bundle. `data:verify` must pass first.

5. Deploy with `FORMA_AUTH_MODE=required` and `FORMA_DATA_BACKEND=supabase`. Keep the SQLite ledger and bundle read-only until owner/member/viewer isolation, document/PDF access, totals, payments, provider event idempotency, and object retrieval have been accepted.

The exporter fails if a legacy invoice has not been migrated into the shared `documents` ledger, a current table is missing required columns, an asset is absent or has the wrong size, a storage key escapes its root, or JSON is malformed. Audit entries from the legacy and shared ledgers are retained; hosted identity values are regenerated for audit rows because they are not public record identifiers.

## Hosted workspace export

Create a portable inventory from a live workspace with a repeatable-read PostgreSQL snapshot and authenticated downloads from the private bucket:

```powershell
npm run data:export-hosted -- --workspace <workspace-uuid> --output .\backups\workspace-2026-07-20
npm run data:verify -- --bundle .\backups\workspace-2026-07-20
```

Store the bundle encrypted outside the deployment account and restrict access as financial/customer data. A hosted export is useful for an off-platform inventory, tenant-level evidence, and isolated restore testing. It is not a replacement for Supabase managed backups/PITR or an encrypted full-database `pg_dump`, because Auth identities and workspace membership are project-level data.

## Restore drill

For a whole-project incident, restore the managed backup or full logical backup into an isolated Supabase project first. Rotate all restored secrets and prevent schedulers/webhooks from running. Verify the migration ledger and Auth memberships, then use `data:export-hosted` and `data:verify` to inventory representative workspaces. For an empty tenant-level recovery target, create the workspace with the intended UUID through an approved database recovery procedure, import its portable bundle, and run `data:verify-hosted`.

Record the recovery point, start/end time, database row counts, object counts/checksums, Auth/member checks, document/PDF sampling, receivable totals, and provider-event comparisons. Never replay payment callbacks until restored `provider_webhook_events`, checkouts, refunds, and provider dashboards have been reconciled.

## Production gate

The gate checks the production environment without printing credential values. Its remote mode validates Auth providers, service-role access, the private bucket, applied migration versions, deployed readiness, the Resend sender domain, and Stripe/PayPal credentials.

```powershell
npm run production:check
```

The command exits non-zero when a required configuration or remote check fails. Monitoring sink configuration is reported as a warning; all hosted/auth/delivery/payment checks are blockers.
