# Forma implementation progress

Last updated: 2026-07-19

## Current milestone

Forma is now a working local-first receivables workspace, not a static invoice mockup. It supports invoices, quotes, and receipts through one durable SQLite document ledger with PDF output, lifecycle controls, configurable identity, reusable templates, and a responsive application shell.

- Shared-document workflow milestone: approximately 90% complete.
- Full hosted production SaaS brief: approximately 59% complete.

The second figure is deliberately lower: authentication, tenant isolation, real email and payment providers, secure object storage, scheduled work, and production operations require external infrastructure and credentials that are not present in this local environment.

## Completed

### Documents and lifecycle

- Full-viewport desktop and mobile application shell with dashboard, sidebar navigation, ledgers, customer/product directories, settings, and quick create.
- Shared document model for invoices, quotes, and receipts with independent annual `INV`, `QUO`, and `REC` sequences.
- Draft creation, editable draft numbers, server-authoritative integer-minor-unit totals, validation, immutable issued snapshots, and audit history.
- Quote lifecycle: draft, mock email send, accept, decline, expire, and one-time conversion into a separately numbered invoice.
- Invoice lifecycle: draft, finalized/sent, partial payment, paid, overdue, void, refund state support, and linked receipt generation.
- Receipt workflow with payment date, method, reference, related-payer support, and server validation that blocks empty or zero-value receipts from being issued.
- Payment recording with amount, method, reference, received date, recalculated balance, and automatic receipt creation.
- Recurring invoice schedules with weekly, monthly, quarterly, and yearly frequencies; pause/resume controls; optional end dates; controlled due-run generation; month-end-safe date progression; unique run records; generated-invoice lineage; and editable invoice drafts for review before finalization or delivery.
- Receivables reporting workspace with billed, collected, outstanding, and tax rollups, plus a server-rendered downloadable CSV ledger export. The export contains document, payment, balance, recurring-schedule, and date data and neutralizes spreadsheet formula prefixes in user-controlled text.
- Payment-reminder workspace with seeded before-due, due-date, and overdue rules; due-invoice preview; pause/resume policy controls; PDF-backed reminder sends through the existing email provider; duplicate-safe delivery records; catch-up behavior that sends only the latest due reminder and marks older missed rules as skipped; and automatic overdue status transition after accepted overdue reminders.
- One ledger that search-filters and opens invoices, quotes, and receipts with their type and status visible.

### Invoice and document authoring UX

- Fast primary invoice composer with searchable recent customers, reusable products, custom lines, terms, notes, payment details, attachments, readiness checks, autosave, keyboard shortcuts, and a sticky A4 preview.
- Reusable customer records with company, billing contact, email, phone, VAT, registration number, notes, currency, payment terms, and inline create/select flows.
- Shared quote/invoice/receipt editor with saved-client search, inline client creation, saved-product search, inline product creation, line editing/reorder/undo, payment instructions, shipping, PO references, notes, A4/Letter paper, live totals, and type-aware lifecycle actions.
- Line-item cards with description, quantity, unit price, tax, line and document-level discount, calculated total, reorder controls, removal undo, and locked issued states. The document discount applies after line discounts and before tax.
- Mixed-rate tax calculations preserve each rate's taxable base and tax amount, then render an explicit rate-by-rate breakdown in the editor, live invoice paper view, and generated PDF.
- Five selectable templates: Classic, Minimal, Bold, Executive, and Compact; browser preview and server PDF share the selected template and page size.
- Quick Create deterministic parser for document type, customer, currencies, dates/terms, quantities, item prices, VAT/discount, and unknown segments. Parsed data is reviewed before document creation.
- Live A4-style paper preview with supplier identity, logo URL support, branding accent, footer, signature, payment details, and type-aware copy.
- Responsive behavior: document preview becomes on-demand at mobile widths and the editor remains free of horizontal overflow at 390px.

### Settings and delivery

- Business identity persistence: name, email, VAT number, address, default currency, logo URL, and validated logo-file upload/preview/removal. PNG, JPG, WebP, and safe SVG logos are signature-checked, limited to 2 MB, written to the configured local upload store, and tracked by asset metadata rather than profile JSON.
- Reusable branding preset persistence with template, accent, footer, and logo reference.
- Independent document prefix configuration for invoices, quotes, and receipts.
- Payment-method configuration with masked sensitive account values in lists, one durable default for new documents, per-document overrides, and explicit document retrieval only for full local values.
- Persisted editable email templates for document, quote, receipt, payment, reminder, and overdue messages.
- Purpose-specific email templates for invoice delivery, friendly and overdue reminders, corrected invoices, quote delivery/follow-up/acceptance, receipts, payment confirmation, and general delivery. Templates support the documented monetary, date, sender, payment-link, and document-link variables, reject unknown tokens, and can be restored to their system defaults.
- Email compose supports To/CC/BCC, server-rendered template defaults, generated PDF attachments, idempotency keys, a visible per-document delivery timeline with retry for failed attempts, and an explicit mock provider. A Resend REST adapter is available through environment configuration; documents transition to sent only after the provider accepts delivery, while provider failures remain recorded without finalizing the draft.

### Backend, PDFs, and testing

- Express JSON API and durable local SQLite database with a legacy-invoice migration path.
- PDFKit PDF generation for every document type, five templates, A4/Letter, and multi-page output with selectable text.
- Tests for money calculations, per-rate tax breakdowns, persistence, immutable snapshots, readiness, audit events, legacy migration, independent numbering, quote conversion, partial payments/receipts, payment masking, parser behavior, template/PDF combinations, and idempotent mock sends.
- Branding release pass: the Forma logo is a tracked browser asset, generated PDFs resolve the document's managed PNG/JPEG logo or a safe inline PNG/JPEG and fall back to the packaged Forma logo, and email attachments use the same resolver. Automated coverage proves browser asset rendering, custom-logo embedding in PDF output, and lossless migration of the legacy default business identity.
- `FORMA_DB`, `FORMA_UPLOAD_DIR`, and `FORMA_*` email configuration names are now preferred while the matching legacy `MONEYFY_*` names remain supported for existing deployments.

## Partially complete

- Business logos are stored in the local upload directory with content-signature validation and referenced by an asset endpoint. Image transformation, malware scanning, tenant-scoped private storage, and signed URLs remain for hosted production.
- Supporting-document attachments upload from both invoice entry flows. PDFs and supported images are signature-checked, stored in the local upload directory, listed on drafts, served through asset URLs, and removable before issue. Signed downloads, malware scanning, and tenant-scoped object storage remain for hosted production.
- Browser preview is a faithful local paper view; PDF is generated server-side from the same document/template selection but is not pixel-identical by design.
- The original invoice composer and shared editor still have some duplicated presentation code. They share the durable document model, but should be consolidated into one renderer in a later maintenance pass.
- Email templates and delivery history are functional locally, but the active provider defaults to `mock`; real provider adapters, verified domains, webhooks, and bounce handling remain absent.
- Dashboard/reporting uses local ledger data; forecasting, formal tax reports, customer portals, automated hosted schedule execution, and background worker execution are not implemented.
- No authentication or tenancy layer exists. Sensitive-payment retrieval caveats are explicitly documented in API responses for this local no-auth service.

## Not started

- Email/password, Google, and Microsoft authentication.
- Workspaces, invitations, roles, permission policies, and tenant-scoped data isolation.
- Hosted PostgreSQL/Supabase migration, RLS, backups, and production data migration.
- Stripe/PayPal payments, webhooks, reconciliation, refunds, and hosted payment pages. The Resend email adapter is implemented but requires a verified sender, API key, provider credentials, and production webhook handling to be activated.
- Secure object storage for attachments and uploaded logos.
- Retry queues, late fees, background jobs, and customer portal.
- Advanced tax rules: inclusive/compound taxes, exemptions, multi-rate jurisdiction engines, and filing integrations.
- Formal reports, analytics, API keys, webhooks, rate limits, observability, CI, deployment, and disaster recovery.

## Verification

From this directory:

```powershell
npm install
npm test
$env:PORT='4175'; npm start
```

Latest verified result (2026-07-19): `20` automated tests passed, `0` failed. `npm run build` passed syntax checks for every runtime module. The suite now also verifies the Forma browser logo route, custom uploaded-logo embedding in generated PDFs, and preservation of custom profile fields during the legacy branding migration.

Live local verification was completed at `http://127.0.0.1:4179`:

- Quote Quick Create parsed a two-line, 15% VAT prompt and created `QUO-2026-00002` with both line-level tax rates and correct totals.
- A quote was sent through the mock provider, accepted, converted once to `INV-2026-00465`, finalized, paid, and created linked `REC-2026-00001` receipt.
- The ledger displayed converted quote, paid invoice, and issued receipt independently.
- Business logo URL and payment instruction persistence were verified in Settings.
- Shared-editor client/product lookup and product insertion were verified; a saved product immediately populated a new tax-bearing row and live totals, and a reload restored the persisted two-line draft.
- Mock delivery was reverified through the compose UI: a generated PDF-backed quote send created an accepted provider record with an idempotency key and transitioned the ready quote to `sent` only after acceptance.
- The email compose preview was verified with the resolved subject and message values; raw template tokens are not shown to users.
- Payment-method migration and Settings verification confirmed the default method is visibly marked and used for new documents while per-document selection remains available.
- Shared-editor verification confirmed the complete billing-contact entry flow: company, contact, email, phone, VAT, registration number, and address are durable document fields.
- Delivery-history integration coverage verifies the persisted provider status, provider message ID, recipients, and idempotent resend result that power the document delivery timeline.
- Email-template coverage verifies the corrected-invoice default, rendered variables, unknown-variable rejection, and restore-default API behavior.
- Recurring-schedule coverage verifies monthly month-end progression, generated invoice lineage, unique run protection, automatic schedule completion, and pause/resume controls. API coverage verifies schedule create, due-run generation, and lifecycle endpoints.
- Reminder coverage verifies seeded policy rules, latest-rule catch-up selection, skipped older reminder steps, idempotent delivery claiming, API due-preview, PDF-backed mock sends, no duplicate run on repeat execution, and accepted overdue reminders transitioning invoices to `overdue`.
- CSV export coverage verifies the download response, invoice filtering, document columns, and spreadsheet-formula neutralization for client-entered text.
- The logo upload API was exercised by automated coverage for PNG signature validation, persisted asset retrieval, business-profile reuse, and malformed-image rejection. The same suite verifies draft-PDF attachment upload, document persistence, download, deletion, and asset cleanup. The Settings screen exposes logo file selection, upload, preview, and removal.
- Mobile `390x844` verification showed no horizontal overflow and the sticky paper preview correctly moved off the editor canvas.

## Next priorities

1. Consolidate the generic quote/invoice/receipt editor so it has the same customer picker, product picker, terms, payment selection, notes, and attachment ergonomics as the invoice composer.
2. Add Supabase Auth, workspaces, roles, tenant-safe Postgres persistence, private Storage buckets, and RLS before exposing the service outside a trusted local environment.
3. Complete Resend production delivery with verified-domain configuration, webhook processing, retries, bounce handling, and scheduled reminder execution.
4. Add Stripe and PayPal payment links, provider webhooks, reconciliation, and a customer payment portal.
5. Add CI, deployment environments, monitoring, rate limits, audit retention/recovery, tax exports, analytics, and formal CSV/PDF reports.
