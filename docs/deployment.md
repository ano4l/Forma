# VirtuDoc deployment stack

This app is a Node/Express document workspace with a local SQLite store by default. The repository is configured for Vercel previews, Supabase as the hosted Postgres target, Resend transactional email, and a later Railway cutover for a persistent Node runtime.

## Vercel

Vercel uses `api/index.js` as the Node 22 serverless entrypoint and rewrites all routes to the Express app.

Required project settings:

- Build command: `npm run build`
- Install command: `npm ci`
- Output directory: leave empty
- Node runtime: `22.x`

Environment variables:

```text
NODE_ENV=production
FORMA_DB=/tmp/forma.sqlite
FORMA_UPLOAD_DIR=/tmp/forma-uploads
FORMA_EMAIL_PROVIDER=resend
FORMA_RESEND_API_KEY=...
FORMA_EMAIL_FROM="Forma <billing@yourdomain.com>"
SUPABASE_URL=...
SUPABASE_PUBLISHABLE_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_DB_URL=...
FORMA_AUTH_MODE=required
FORMA_AUTH_PROVIDERS=email,google,azure
FORMA_DATA_BACKEND=sqlite
```

Important: Vercel function storage is ephemeral. Use this Vercel target for preview/demo deployments until the SQLite store is replaced by the Supabase/Postgres adapter, or deploy production on Railway with a persistent volume/database.

## Supabase

The target schema lives in:

```text
supabase/migrations/20260712000000_init_virtudoc.sql
```

Recommended setup:

```powershell
supabase link --project-ref <project-ref>
supabase db push
```

The schema mirrors the current document ledger: customers, products, documents, payments, templates, delivery attempts, reminder policies, recurring invoices, media metadata, settings, and audit history.

The `20260719000000_auth_workspaces_rls.sql` migration enables Supabase Auth-backed workspaces, owner/admin/member/viewer roles, tenant columns, composite tenant foreign keys, RLS, workspace RPCs, and private Storage policies. It fails closed if existing hosted rows have no assigned workspace.

Server authentication is also fail-closed: required mode verifies access tokens against Supabase Auth, loads active memberships through RLS, and rejects spoofed workspace headers. Business-data routes remain unavailable until the Supabase Postgres store adapter replaces SQLite and `FORMA_DATA_BACKEND=supabase` is deliberately enabled.

## Resend

The app already uses a provider abstraction in `email-provider.js`.

To enable Resend:

```text
FORMA_EMAIL_PROVIDER=resend
FORMA_RESEND_API_KEY=re_xxxxxxxxx
FORMA_EMAIL_FROM="Forma <billing@yourdomain.com>"
```

Every document send includes a generated PDF attachment and an `Idempotency-Key`. Provider acceptance is recorded before drafts become sent; provider failures are stored without finalizing the draft.

Legacy `MONEYFY_*` runtime variables remain accepted during migration, but new environments should use the `FORMA_*` names above.

## Railway handoff

Railway config is provided in `railway.json`. When moving from Vercel preview to a persistent production runtime:

1. Provision Railway Postgres or connect Supabase Postgres.
2. Set `DATABASE_URL` and the same Resend variables.
3. Keep `npm start` as the start command.
4. Point health checks at `/api/health`.
5. Replace the SQLite store with the Postgres adapter before relying on production data durability.
