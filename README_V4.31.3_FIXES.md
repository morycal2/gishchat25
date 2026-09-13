# Zento v4.31.3

- Removed the duplicate story rail from the chat pane/bottom area. Stories remain only in the main chat-list sidebar top bar.
- `/api/admin/me` now returns a normal JSON `isAdmin:false` response for regular users instead of HTTP 403, preventing the expected non-admin check from appearing as a console error.
- Repositioned the compact ban/restriction panel into the top-right header area and kept it above the UI with a high z-index.
- Ban countdown remains live and message composer restrictions are preserved.
