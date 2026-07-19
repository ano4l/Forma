# Supabase backend

This folder contains Forma's hosted Postgres, Supabase Auth, workspace tenancy, RLS, and private Storage schema.

Apply it to a linked Supabase project:

```powershell
supabase link --project-ref <project-ref>
supabase db push
```

For a direct SQL apply, run the migrations in timestamp order. The second migration adds user profiles, workspace membership and roles, tenant keys, cross-tenant foreign-key protection, RLS policies, workspace RPCs, and the private `forma-private` Storage bucket.

The tenancy migration deliberately aborts if hosted business rows exist without a `workspace_id`. Assign those rows to a real workspace in an explicit data migration before retrying; it will not guess ownership.

Current runtime note: local development still uses SQLite by default. Required-auth mode verifies Supabase sessions and workspace membership but intentionally returns `TENANT_STORE_NOT_CONFIGURED` for business-data routes until the Postgres adapter is enabled. This prevents authenticated users from falling through to a shared local database.
