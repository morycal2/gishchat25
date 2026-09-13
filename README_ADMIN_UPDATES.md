# Zento v4.31.7 — Admin/UI updates

- Added Report action to public user profiles (existing endpoint retained).
- Fixed admin user search state so the query is not lost during render.
- Admin user lists use stored profile avatars.
- Support center shows unread/answered/closed status with red/green indicators and open/closed text.
- Reports show open/reviewed status with red/green indicators.
- Added admin account profile and password management.
- Added admin profile editing for site admins.
- Added normal-user account password change under Settings > Account.
- Added database-backed superadmin profile/password so creator credentials can be changed without editing code.
- Ban duration changes now notify users with old/new duration and whether it increased or decreased.
- Added ban_started_at and ban_duration_minutes migrations.
