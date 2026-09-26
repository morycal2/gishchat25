# Zento v4.31.24

- Premium admin navigation with labeled controls and creator-only protected private activity center.
- Private activity password defaults to `1234` on first database initialization and can be changed by the creator.
- Creator-only private activity endpoint remains protected by superadmin role plus password unlock.
- Call signaling hardened with socket readiness checks, dynamic ICE configuration, and TURN fallback; production TURN can be supplied with `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL`.
- Desktop chat call buttons are explicitly restored for direct chats and keep labels.
- Group/channel creation gets an inline visible create button and supports profile image upload.
- Profile report button is present on public user profiles.
- Stories list uses a premium card/ring layout.
- Media attachment composer provides edit/metadata action for all attachment types and keeps confirm/send flow.
- User uploads show aggregate progress and speed while multiple attachments upload concurrently.
- Service worker/app cache bumped to app.js?v=124.
