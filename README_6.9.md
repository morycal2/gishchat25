# Zento 6.9 — Telegram-style Feature Pack

This release builds on 6.8 and adds:

- Custom theme colors, message bubble styles and compact mode
- Chat folders with persistent PostgreSQL storage
- Per-chat PIN locking
- Disappearing messages (10s / 1m / 1h / 1d)
- Multi-profile variants
- QR profile sharing
- Advanced in-chat search by text, sender, type and date
- User activity statistics and achievement badges
- Zento Bot registry + command response API
- Mini-app hub with Tic-Tac-Toe, polls and quick tools
- Screen sharing hook for video calls
- Smart burst notification aggregation
- PWA service worker / installable app shell
- Existing realtime sync, unread counts, read receipts, media editor, saved messages, stories, group/channel admin panels and WebRTC calling remain enabled

## Optional AI
Set `GISH_AI_ENDPOINT` to a JSON endpoint that accepts `{ action, text, userId }` and returns `{ result }`. Optionally set `GISH_AI_KEY` for a Bearer token.

## Deployment
Node 20+ is supported. Railway/reverse-proxy deployments use `app.set('trust proxy', 1)` and the bundled `ws` dependency for Supabase realtime compatibility.
