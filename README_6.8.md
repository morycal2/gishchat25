# Zento 6.8

This build extends the 6.7 media-editor release with Telegram-inspired chat interactions:

- Online / last-seen / typing presence
- Unread counters and read receipts
- In-chat search and global search
- Delete for me / delete for everyone
- Pin/unpin, save, reply, forward, edit and reactions
- Hold-to-record voice and video messages with duration + pre-send preview
- Attachment menu for image, video, audio, file, location, contact and polls
- Upload progress UI
- Saved Messages as a real chat with search
- Privacy controls and password change UI
- Stories (24-hour image stories)
- Improved mobile layout
- More resilient WebRTC ICE handling
- PostgreSQL migrations for presence, unread state, per-user deletion and stories

Deploy this folder as the backend/frontend bundle. The server is designed for Node 20+ and Railway/reverse proxies.
