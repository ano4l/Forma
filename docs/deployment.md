# Forma deployment stack

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
FORMA_RESEND_WEBHOOK_SECRET=...
FORMA_PUBLIC_URL=https://app.yourdomain.com
FORMA_CRON_SECRET=...
FORMA_STRIPE_SECRET_KEY=...
FORMA_STRIPE_WEBHOOK_SECRET=...
FORMA_PAYPAL_ENV=live
FORMA_PAYPAL_CLIENT_ID=...
FORMA_PAYPAL_CLIENT_SECRET=...
FORMA_PAYPAL_WEBHOOK_ID=...
SUPABASE_URL=...
SUPABASE_PUBLISHABLE_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_DB_URL=...
FORMA_AUTH_MODE=required
FORMA_AUTH_PROVIDERS=email,google,azure
FORMA_DATA_BACKEND=supabase
FORMA_RATE_LIMIT_PER_MINUTE=300
FORMA_REQUEST_LOGS=true
```

Important: Vercel function storage is ephemeral. Hosted mode does not depend on it: business records use Supabase Postgres and uploads use the private `forma-private` bucket. SQLite mode still requires a persistent volume and must not be used as a production database on Vercel.

## Supabase

The target schema lives in the ordered files under:

```text
supabase/migrations/
```

Recommended setup:

```powershell
supabase link --project-ref <project-ref>
supabase db push
```

The schema mirrors the current document ledger: customers, products, documents, payments, templates, delivery attempts, reminder policies, recurring invoices, media metadata, settings, and audit history.

The `20260719000000_auth_workspaces_rls.sql` migration enables Supabase Auth-backed workspaces, owner/admin/member/viewer roles, tenant columns, composite tenant foreign keys, RLS, workspace RPCs, and private Storage policies. It fails closed if existing hosted rows have no assigned workspace.

Server authentication is also fail-closed: required mode verifies access tokens against Supabase Auth, loads active memberships through RLS, and rejects spoofed workspace headers. The Supabase store adapter scopes every read and mutation to the resolved workspace, uses private Storage paths prefixed by workspace UUID, and moves financial multi-record workflows into atomic Postgres functions. Business-data routes remain unavailable unless `FORMA_DATA_BACKEND=supabase` and the server-only service-role key are both configured.

Authenticated browser users receive read-only table grants, so the public project key cannot bypass Express validation with direct writes. Mutations are sent by the server through narrowly scoped, transactional functions. The service-role key is never included in `/api/auth/config`; rotate it immediately if it is ever exposed outside the server environment.

### Auth dashboard setup

The browser includes email/password registration and sign-in, Google and Microsoft (`azure`) OAuth, automatic access-token refresh, logout, workspace creation, and workspace selection. To activate it:

1. In **Authentication → URL Configuration**, set the production app origin as the Site URL and add the exact production, staging, and local app URLs to Redirect URLs. Forma returns social sign-ins to the current app URL and consumes the session from the URL fragment.
2. Keep email/password enabled. Hosted Supabase projects normally require email confirmation; the confirmation link returns to the current Forma path.
3. Enable Google and Azure in **Authentication → Providers** and add each provider's client credentials. Keep `FORMA_AUTH_PROVIDERS` aligned with the providers actually enabled.
4. Use only `SUPABASE_PUBLISHABLE_KEY` in browser-visible configuration. Never expose a service-role key to the browser.
5. Configure production SMTP for Auth confirmation and invitation messages before launch; Supabase's trial sender is not a production delivery channel.

References: [Supabase redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls), [password authentication](https://supabase.com/docs/guides/auth/passwords), and [implicit browser sessions](https://supabase.com/docs/guides/auth/sessions/implicit-flow).

## Resend

The app already uses a provider abstraction in `email-provider.js`.

To enable Resend:

```text
FORMA_EMAIL_PROVIDER=resend
FORMA_RESEND_API_KEY=re_xxxxxxxxx
FORMA_EMAIL_FROM="Forma <billing@yourdomain.com>"
```

Every document send includes a generated PDF attachment and an `Idempotency-Key`. Provider acceptance is recorded before drafts become sent; provider failures are stored without finalizing the draft.

Create a Resend webhook for `https://app.yourdomain.com/api/webhooks/resend`, subscribe to sent/delivered/delayed/bounced/complained/failed/suppressed/opened/clicked events, and copy its signing secret to `FORMA_RESEND_WEBHOOK_SECRET`. The endpoint verifies the Svix signature against the untouched request body, stores each event once, updates delivery history, schedules transient retries, and suppresses recipients after permanent failures.

## Hosted payments

Stripe Checkout and PayPal Orders are available from an issued invoice's **Create payment link** action. Configure the providers independently; the UI returns a provider-hosted URL and Forma records money only after a verified event is reconciled against the original checkout amount.

- Stripe webhook: `https://app.yourdomain.com/api/webhooks/stripe`. Subscribe to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `refund.created`, `refund.updated`, `refund.failed`, and `charge.dispute.created/updated/closed`; store the endpoint secret as `FORMA_STRIPE_WEBHOOK_SECRET`.
- PayPal webhook: `https://app.yourdomain.com/api/webhooks/paypal`. At minimum subscribe to `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, `CHECKOUT.ORDER.VOIDED`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED`, `PAYMENT.REFUND.PENDING`, `PAYMENT.REFUND.FAILED`, and `CUSTOMER.DISPUTE.CREATED/UPDATED/RESOLVED`; store the webhook ID as `FORMA_PAYPAL_WEBHOOK_ID`.
- Set `FORMA_PUBLIC_URL` to the exact HTTPS application origin. PayPal returns to a one-time opaque checkout route which captures the approved order and redirects to the app.

Provider event IDs and payment references are unique. Duplicate callbacks return success without recording a second payment. Hosted Postgres performs event claim, invoice balance change, payment insert, and audit insert in one service-only transaction.

Workspace owners/admins can issue full or partial refunds against the original captured payment. Refund requests reserve the remaining refundable amount before contacting the provider, use provider idempotency keys, and alter the invoice ledger only after a successful provider response or verified callback. Subsequent callbacks cannot apply the same refund twice. Provider-created disputes are retained as visible invoice risk events but do not silently alter receivables; finance operators must resolve their accounting treatment from the provider outcome.

## Customer portal and team access

Issued documents can create an expiring customer-portal URL. Only a SHA-256 digest is stored; the fragment secret is shown once, removed from the browser address immediately, and sent to public APIs in a dedicated header so request logs do not contain it. The portal exposes a sanitized immutable document, PDF download, current balance, an existing provider-hosted payment link, and sent-quote accept/decline actions. Revoke links from the document action menu when access should end.

Workspace owners/admins manage members and invitations in Settings. Invitation tokens are likewise stored only as hashes, expire after seven days, and are bound to the invited user's verified Supabase Auth email. Configure `FORMA_PUBLIC_URL` to the exact HTTPS origin before enabling invitation or portal delivery; production fails closed if it is missing or not HTTPS.

## Scheduled operations

Call `POST /api/internal/run-operations` with `X-Forma-Cron-Secret: <FORMA_CRON_SECRET>` from the platform scheduler. One invocation runs due recurring invoices, reminder delivery, and claimed transient email retries for every workspace. An optional JSON body can supply `{"as_of":"YYYY-MM-DD"}` for controlled testing. The route is unavailable until a secret is configured.

Legacy `MONEYFY_*` runtime variables remain accepted during migration, but new environments should use the `FORMA_*` names above.

## Railway handoff

Railway config is provided in `railway.json`. When moving from Vercel preview to a persistent production runtime:

1. Provision Railway Postgres or connect Supabase Postgres.
2. Set `DATABASE_URL` and the same Resend variables.
3. Keep `npm start` as the start command.
4. Point health checks at `/api/health`.
5. Point health checks at `/api/ready`, apply all Supabase migrations, and run the hosted Auth/RLS/Storage integration checklist before importing production data.

The production release, monitoring, scheduler, backup/restore, secret-rotation, rollback, and incident checklist is in `docs/operations.md`.
