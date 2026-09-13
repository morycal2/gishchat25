# Zento v4.27.0 — Creator Control Center & Reliability

- Fixed creator/admin dashboard API failures by making dashboard reads resilient to missing optional tables/columns.
- Added `/api/admin/health` database latency and uptime check.
- Prevented superadmin sessions from hitting normal user profile creation endpoints.
- Expanded creator dashboard with system health, quick actions, search, richer call center, and monitoring cards.
- Existing call, zoom, scroll, archive, emoji and profile features are preserved.

Creator login remains configured through environment variables; defaults are kept only for the development build.
