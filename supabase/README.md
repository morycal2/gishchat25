# Supabase setup

1. Create a free Supabase project.
2. Open SQL Editor.
3. Run `schema.sql` from this directory.
4. In Project Settings → Database, copy the connection string. Prefer the Supavisor/session pooler connection string if your environment has IPv4 connectivity issues.
5. In Project Settings → API, copy the Project URL and the `service_role` key. **Never put the service_role key in `public/`, GitHub Pages, or browser code.**
6. Put those values only in Render environment variables.

The free plan currently includes 500 MB database size and 1 GB file storage, with projects pausing after one week of inactivity. See the official pricing page for current limits.
