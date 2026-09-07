# Zento v7.4 — Railway Deploy

## Required Railway variables

- `DATABASE_URL` — Supabase/PostgreSQL connection string
- `SUPABASE_URL` — Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` — Supabase service-role key
- `JWT_SECRET` — long random secret
- `STORAGE_BUCKET` — optional, defaults to `gish-files`
- `FRONTEND_ORIGIN` — optional for same-origin Railway deployment; for a separate frontend, use a comma-separated list of allowed origins
- `AI_API_URL` — optional OpenAI-compatible chat-completions endpoint for the built-in AI
- `AI_API_KEY` — optional API key for the AI provider
- `AI_MODEL` — optional model name (defaults to `gpt-4o-mini`)

## Deploy

Railway can deploy this repository directly. The project uses `npm start`, which runs `node server.js`.

The backend serves `public/` itself, so the Railway URL is a complete web app and does not require GitHub Pages. `/health` is available for Railway health checks.

On startup the server creates/updates the required application tables and the Supabase Storage bucket.

## Important

Do not expose `SUPABASE_SERVICE_ROLE_KEY` to the browser. Keep it only in Railway environment variables.

## Stage 4

- Multi-device realtime sync: all active sessions join the user's conversation rooms.
- Bot API: create bots from the in-app Bot panel and use `/api/bot/<TOKEN>/send`.
- Mini Apps: launch HTTPS iframe apps from the Advanced Features panel.
- Real-time Tic-Tac-Toe: start a game inside a selected conversation.
- Screen sharing: available from video calls after camera/microphone permission is granted.
- AI: configure the three AI variables above to enable the assistant.
- PWA: the service worker is registered automatically and the app can be installed by supported browsers.
