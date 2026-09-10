const express = require('express');
const http = require('http');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');
const { Server } = require('socket.io');
const WebSocket = require('ws');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STORAGE_BUCKET = process.env.STORAGE_BUCKET || 'zento-files';
const allowedOrigins = (process.env.FRONTEND_ORIGIN || 'http://localhost:5500')
  .split(',').map(x => x.trim()).filter(Boolean);

if (!JWT_SECRET) throw new Error('JWT_SECRET is required');
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
  realtime: { transport: WebSocket },
});

function corsOrigin(origin, cb) {
  if (!origin || allowedOrigins.includes(origin) || /^https:\/\/[^/]+\.railway\.app$/i.test(origin)) return cb(null, true);
  cb(new Error('CORS origin not allowed'));
}
const io = new Server(server, {
  cors: { origin: corsOrigin, methods: ['GET', 'POST'], credentials: false }
});

app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin || allowedOrigins.includes(origin)) {
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(origin && allowedOrigins.includes(origin) ? 204 : 403);
  next();
});
app.use(express.json({ limit: '3mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve the frontend assets from the same Railway service.
// This must be registered before the SPA fallback below; otherwise requests
// such as /style.css and /app.js would receive index.html and the browser
// would report MIME-type errors, leaving the UI unstyled/non-functional.
app.use(express.static(path.join(__dirname, 'public'), {
  index: false,
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
}));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 80, standardHeaders: true, legacyHeaders: false });
app.use('/api/login', authLimiter);
app.use('/api/register', authLimiter);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /^(image\/(jpeg|png|webp|gif)|audio\/(mpeg|mp4|webm|ogg|wav|aac)|video\/(mp4|webm|quicktime|ogg)|application\/(pdf|zip)|text\/plain|application\/zip|application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet)|application\/msword|application\/vnd\.ms-excel)$/.test(file.mimetype);
    cb(ok ? null : new Error('نوع فایل پشتیبانی نمی‌شود'), ok);
  }
});

async function q(text, params = []) { return pool.query(text, params); }
function safeUser(row) {
  if (!row) return null;
  return {
    id: Number(row.id), username: row.username, email: row.email || '',
    display_name: row.display_name, avatar: row.avatar || '', bio: row.bio || '', is_bot: !!row.is_bot
  };
}
async function getUser(id) {
  const r = await q('SELECT id, username, email, display_name, avatar, bio FROM users WHERE id=$1', [Number(id)]);
  return safeUser(r.rows[0]);
}
async function getUserRawByEmail(email) {
  const r = await q('SELECT * FROM users WHERE lower(email)=lower($1) LIMIT 1', [email]);
  return r.rows[0] || null;
}
async function isMember(cid, uid) {
  const r = await q('SELECT 1 FROM conversation_members WHERE conversation_id=$1 AND user_id=$2', [Number(cid), Number(uid)]);
  return r.rowCount > 0;
}
async function getConversation(cid) {
  const r = await q('SELECT * FROM conversations WHERE id=$1', [Number(cid)]);
  return r.rows[0] || null;
}
let currentViewUserId=0;
async function conversationView(c, viewerId=currentViewUserId) {
  const members = await q(`SELECT u.id,u.username,u.email,u.display_name,u.avatar,u.bio, (EXISTS(SELECT 1 FROM bots b WHERE b.bot_user_id=u.id)) AS is_bot
    FROM conversation_members cm JOIN users u ON u.id=cm.user_id
    WHERE cm.conversation_id=$1 ORDER BY cm.user_id`, [c.id]);
  const last = await q(`SELECT id,text,kind,created_at FROM messages WHERE conversation_id=$1 AND deleted=false AND NOT EXISTS (SELECT 1 FROM message_hidden mh WHERE mh.message_id=messages.id AND mh.user_id=$2) ORDER BY id DESC LIMIT 1`, [c.id, viewerId]);
  const m = last.rows[0];
  let lastText = '';
  if (m) lastText = m.kind === 'voice' ? '🎙️ پیام صوتی' : m.kind === 'image' ? '🖼️ تصویر' : m.kind === 'video' ? '🎬 ویدیو' : m.kind === 'audio' ? '🎵 آهنگ' : (m.text || '📎 فایل');
  const unread = await q(`SELECT count(*)::int AS n FROM messages m JOIN conversation_members cm ON cm.conversation_id=m.conversation_id AND cm.user_id=$2 WHERE m.conversation_id=$1 AND m.sender_id<>$2 AND m.deleted=false AND m.created_at>cm.last_read_at AND NOT EXISTS (SELECT 1 FROM message_hidden mh WHERE mh.message_id=m.id AND mh.user_id=$2)`, [c.id, viewerId]);
  return {
    id: Number(c.id), name: c.name, type: c.type || 'group', created_at: c.created_at,
    last_text: lastText, last_time: m ? m.created_at : c.created_at,
    members: members.rows.map(safeUser), owner_id: c.owner_id ? Number(c.owner_id) : null,
    description: c.description || '', username: c.username || '', unread_count: Number(unread.rows[0]?.n||0)
  };
}
async function messageView(row) {
  const u = await getUser(row.sender_id);
  let display_name=u?.display_name, username=u?.username, avatar=u?.avatar;
  if(row.profile_id){ const pr=await q('SELECT name,username,avatar FROM user_profiles WHERE id=$1',[Number(row.profile_id)]); if(pr.rows[0]){display_name=pr.rows[0].name;username=pr.rows[0].username;avatar=pr.rows[0].avatar||avatar;} }
  let bot_name=null,bot_username=null;if(row.bot_id){const br=await q('SELECT name,username FROM bots WHERE id=$1',[Number(row.bot_id)]);if(br.rows[0]){bot_name=br.rows[0].name;bot_username=br.rows[0].username;}}
  return { ...row, id: Number(row.id), conversation_id: Number(row.conversation_id), sender_id: Number(row.sender_id), bot_id: row.bot_id?Number(row.bot_id):null, bot_name, bot_username,
    reply_to: row.reply_to ? Number(row.reply_to) : null, reactions: row.reactions || {}, display_name, username, avatar };
}
function tokenFor(u) { return jwt.sign({ id: Number(u.id) }, JWT_SECRET, { expiresIn: '7d' }); }
async function auth(req, res, next) {
  try {
    const raw = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const d = jwt.verify(raw, JWT_SECRET);
    const u = await getUser(d.id);
    if (!u) throw new Error('user');
    req.user = u; next();
  } catch { res.status(401).json({ error: 'نشست نامعتبر است' }); }
}

app.get('/health', async (_req, res) => {
  try { await q('SELECT 1'); res.json({ ok: true, service: 'zento-chat', database: 'postgres', storage: STORAGE_BUCKET, time: new Date().toISOString() }); }
  catch { res.status(503).json({ ok: false, error: 'database unavailable' }); }
});

app.post('/api/register', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const displayName = String(req.body.displayName || '').trim().slice(0, 50);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 6 || !displayName)
      return res.status(400).json({ error: 'ایمیل معتبر، نام نمایشی و رمز حداقل ۶ کاراکتری لازم است' });
    if (await getUserRawByEmail(email)) return res.status(409).json({ error: 'این ایمیل قبلاً ثبت شده است' });
    const base = email.split('@')[0].replace(/[^a-z0-9_.-]/g, '').slice(0, 24) || 'user';
    let username = base, i = 1;
    while ((await q('SELECT 1 FROM users WHERE username=$1', [username])).rowCount) username = base + (i++);
    const hash = await bcrypt.hash(password, 12);
    const r = await q(`INSERT INTO users(username,email,password_hash,display_name) VALUES($1,$2,$3,$4)
      RETURNING id,username,email,display_name,avatar,bio`, [username, email, hash, displayName]);
    const u = r.rows[0];
    res.json({ token: tokenFor(u), user: safeUser(u) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'ثبت‌نام ناموفق بود' }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const u = await getUserRawByEmail(email);
    if (!u || !(await bcrypt.compare(String(req.body.password || ''), u.password_hash))) return res.status(401).json({ error: 'ایمیل یا رمز عبور اشتباه است' });
    res.json({ token: tokenFor(u), user: safeUser(u) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'ورود ناموفق بود' }); }
});
app.get('/api/me', auth, (req, res) => res.json(req.user));

app.get('/api/users', auth, async (req, res) => {
  const qv = String(req.query.q || '').toLowerCase();
  const r = await q(`SELECT id,username,email,display_name,avatar,bio
    FROM users
    WHERE id<>$1 AND ($2='' OR lower(username) LIKE '%'||$2||'%' OR lower(display_name) LIKE '%'||$2||'%')
    ORDER BY display_name LIMIT 50`, [req.user.id, qv]);
  res.json(r.rows.map(safeUser));
});

// Resolve a public Zento bot username directly. Bot accounts are real Zento users
// linked to a row in `bots`, so @username can open a real profile/chat instead of
// falling through to the normal-user search and showing "کاربر پیدا نشد".
app.get('/api/bots/resolve/:username', auth, async (req,res)=>{
  try{
    const username=String(req.params.username||'').replace(/^@/,'').trim().toLowerCase();
    let r=await q(`SELECT b.* FROM bots b WHERE lower(b.username)=lower($1) LIMIT 1`,[username]);
    if(!r.rowCount)return res.status(404).json({error:'ربات پیدا نشد'});
    const bot=r.rows[0];
    const userId=await ensureBotUser(bot);
    r=await q(`SELECT b.id AS bot_id,b.username,b.name,b.description,b.avatar,b.owner_id,
      u.id AS user_id,u.display_name,u.avatar AS user_avatar,u.bio
      FROM bots b JOIN users u ON u.id=b.bot_user_id WHERE b.id=$1 LIMIT 1`,[bot.id]);
    const x=r.rows[0];
    res.json({id:Number(x.user_id),bot_id:Number(x.bot_id),username:x.username,display_name:x.name||x.display_name,avatar:x.avatar||x.user_avatar||'',bio:x.description||x.bio||'',is_bot:true,owner_id:Number(x.owner_id)});
  }catch(e){console.error(e);res.status(500).json({error:'بازیابی ربات ناموفق بود'})}
});

app.get('/api/conversations', auth, async (req, res) => {
  currentViewUserId=req.user.id;
  const r = await q(`SELECT c.* FROM conversations c JOIN conversation_members cm ON cm.conversation_id=c.id
    WHERE cm.user_id=$1 AND c.name <> '__zento_saved__' ORDER BY c.updated_at DESC, c.id DESC`, [req.user.id]);
  const views = []; for (const c of r.rows) views.push(await conversationView(c, req.user.id));
  res.json(views);
});

app.post('/api/conversations/direct', auth, async (req, res) => {
  const other = Number(req.body.userId);
  if (!await getUser(other) || other === req.user.id) return res.status(400).json({ error: 'کاربر نامعتبر است' });
  const existing = await q(`SELECT c.* FROM conversations c
    JOIN conversation_members a ON a.conversation_id=c.id AND a.user_id=$1
    JOIN conversation_members b ON b.conversation_id=c.id AND b.user_id=$2
    WHERE c.type='direct' AND (SELECT count(*) FROM conversation_members x WHERE x.conversation_id=c.id)=2 LIMIT 1`, [req.user.id, other]);
  let c = existing.rows[0];
  if (!c) {
    const cr = await q(`INSERT INTO conversations(name,type) VALUES('گفتگو','direct') RETURNING *`);
    c = cr.rows[0];
    await q('INSERT INTO conversation_members(conversation_id,user_id) VALUES($1,$2),($1,$3)', [c.id, req.user.id, other]);
  }
  res.json(await conversationView(c, req.user.id));
});

app.post('/api/conversations/group', auth, async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 60);
  const username = String(req.body.username || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 30);
  const members = [...new Set([req.user.id, ...(Array.isArray(req.body.members) ? req.body.members.map(Number) : [])])].filter(Boolean);
  if (!name || members.length < 2) return res.status(400).json({ error: 'نام گروه و حداقل یک عضو دیگر لازم است' });
  if (username && username.length < 3) return res.status(400).json({ error: 'شناسه گروه باید حداقل ۳ حرف باشد' });
  if (username && (await q('SELECT 1 FROM conversations WHERE username=$1 LIMIT 1', [username])).rowCount) return res.status(409).json({ error: 'این شناسه قبلاً استفاده شده است' });
  const valid = await q('SELECT id FROM users WHERE id=ANY($1::bigint[])', [members]);
  const ids = valid.rows.map(x => Number(x.id));
  if (ids.length !== members.length) return res.status(400).json({ error: 'عضو نامعتبر است' });
  const cr = await q(`INSERT INTO conversations(name,type,owner_id,username,description) VALUES($1,'group',$2,$3,$4) RETURNING *`, [name, req.user.id, username || null, String(req.body.description || '').trim().slice(0, 200)]);
  const c = cr.rows[0];
  for (const uid of ids) await q('INSERT INTO conversation_members(conversation_id,user_id) VALUES($1,$2)', [c.id, uid]);
  res.json(await conversationView(c, req.user.id));
});

app.post('/api/conversations/channel', auth, async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 60);
  const username = String(req.body.username || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 30);
  const description = String(req.body.description || '').trim().slice(0, 200);
  if (!name || username.length < 3) return res.status(400).json({ error: 'نام کانال و شناسه انگلیسی حداقل ۳ حرفی لازم است' });
  if ((await q("SELECT 1 FROM conversations WHERE type='channel' AND username=$1", [username])).rowCount) return res.status(409).json({ error: 'این شناسه کانال قبلاً استفاده شده است' });
  const cr = await q(`INSERT INTO conversations(name,type,owner_id,username,description) VALUES($1,'channel',$2,$3,$4) RETURNING *`, [name, req.user.id, username, description]);
  const c = cr.rows[0];
  await q('INSERT INTO conversation_members(conversation_id,user_id) VALUES($1,$2)', [c.id, req.user.id]);
  res.json(await conversationView(c, req.user.id));
});

app.get('/api/public/conversations/:username', async (req, res) => {
  try {
    const username = String(req.params.username || '').trim().toLowerCase();
    const r = await q(`SELECT id,name,type,description,username,photo FROM conversations WHERE username=$1 AND type IN ('group','channel') LIMIT 1`, [username]);
    if (!r.rowCount) return res.status(404).json({ error: 'گروه یا کانال پیدا نشد' });
    const c = r.rows[0];
    res.json({ id: Number(c.id), name: c.name, type: c.type, description: c.description || '', username: c.username || '', photo: c.photo || '' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'لینک گفتگو در دسترس نیست' }); }
});

app.post('/api/conversations/:id/join', auth, async (req, res) => {
  const c = await getConversation(req.params.id);
  if (!c || !['channel','group'].includes(c.type)) return res.status(404).json({ error: 'گفتگو پیدا نشد' });
  await q('INSERT INTO conversation_members(conversation_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [c.id, req.user.id]);
  res.json(await conversationView(c, req.user.id));
});

app.get('/api/conversations/:id/messages', auth, async (req, res) => {
  const cid = Number(req.params.id);
  if (!await isMember(cid, req.user.id)) return res.status(403).json({ error: 'ابتدا باید عضو این گفتگو باشید' });
  const r = await q(`SELECT id,conversation_id,sender_id,text,file_url,file_type,file_name,kind,reply_to,created_at,deleted,reactions,expires_at,quote_ids
    FROM messages WHERE conversation_id=$1 ORDER BY id DESC LIMIT 300`, [cid]);
  const rows = r.rows.reverse(); const out = []; for (const m of rows) out.push(await messageView(m));
  res.json(out);
});

async function canMessage(cid, uid) {
  const c = await getConversation(cid);
  if (!c || !await isMember(cid, uid)) return { ok: false, error: 'گفتگو پیدا نشد یا عضو آن نیستید' };
  if (c.type === 'channel' && Number(c.owner_id) !== Number(uid)) {
    const ar = await q('SELECT permissions FROM conversation_admins WHERE conversation_id=$1 AND user_id=$2', [cid, uid]);
    if (!ar.rowCount || ar.rows[0].permissions?.post === false) return { ok: false, error: 'فقط مالک یا ادمین مجاز می‌تواند در کانال پیام بفرستد' };
  }
  if (c.type === 'group') {
    const st = c.settings || {};
    if (st.onlyAdminsPost && Number(c.owner_id) !== Number(uid)) {
      const ar = await q('SELECT permissions FROM conversation_admins WHERE conversation_id=$1 AND user_id=$2', [cid, uid]);
      if (!ar.rowCount || ar.rows[0].permissions?.post === false) return { ok: false, error: 'در این گروه فقط مدیران می‌توانند پیام بفرستند' };
    }
  }
  if (c.type === 'direct') {
    const mr = await q('SELECT user_id FROM conversation_members WHERE conversation_id=$1 AND user_id<>$2 LIMIT 1', [cid, uid]);
    const other = mr.rows[0]?.user_id;
    if (other && (await q(`SELECT 1 FROM blocks WHERE (user_id=$1 AND blocked_id=$2) OR (user_id=$2 AND blocked_id=$1)`, [uid, other])).rowCount)
      return { ok: false, error: 'ارسال پیام به این کاربر مجاز نیست' };
  }
  return { ok: true, conversation: c };
}

async function insertMessage({ cid, uid, text, kind='text', fileUrl='', fileType='', fileName='', replyTo=null, profileId=null, expiresIn=null, quoteIds=[], botId=null, replyMarkup=null }) {
  const expiresAt = expiresIn ? new Date(Date.now()+Number(expiresIn)*1000) : null;
  const r = await q(`INSERT INTO messages(conversation_id,sender_id,text,file_url,file_type,file_name,kind,reply_to,profile_id,expires_at,quote_ids,bot_id,reply_markup)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`, [cid, uid, text, fileUrl, fileType, fileName, kind, replyTo, profileId, expiresAt, JSON.stringify(Array.isArray(quoteIds)?quoteIds.map(Number).filter(Boolean):[]), botId, replyMarkup ? JSON.stringify(replyMarkup) : null]);
  await q('UPDATE conversations SET updated_at=now() WHERE id=$1', [cid]);
  return messageView(r.rows[0]);
}

app.post('/api/conversations/bot', auth, async (req,res)=>{
  try{
    const username=String(req.body.username||'').replace(/^@/,'').trim().toLowerCase();
    if(!username) return res.status(400).json({error:'شناسه ربات لازم است'});
    const r=await q('SELECT * FROM bots WHERE lower(username)=lower($1) LIMIT 1',[username]);
    if(!r.rowCount) return res.status(404).json({error:'ربات پیدا نشد'});
    const bot=r.rows[0]; const botUid=await ensureBotUser(bot);
    if(Number(botUid)===Number(req.user.id)) return res.status(400).json({error:'نمی‌توانی با ربات خودت گفتگو بسازی'});
    const c=await ensureDirectConversation(req.user.id,botUid);
    res.json(await conversationView(c,req.user.id));
  }catch(e){console.error(e);res.status(500).json({error:'باز کردن گفتگوی ربات ناموفق بود'})}
});

// Deliver incoming user messages to bots that are members of the conversation.
// This must never make the normal message endpoint fail: bot delivery is best-effort.
async function dispatchBotUpdateForMessage(message) {
  try {
    if (!message || message.bot_id) return;
    const cid = Number(message.conversation_id);
    const senderId = Number(message.sender_id);
    if (!cid || !senderId) return;
    const r = await q(`SELECT b.*,COALESCE(bcs.can_read,true) AS chat_can_read
      FROM bots b
      JOIN conversation_members cm ON cm.user_id=b.bot_user_id
      LEFT JOIN bot_chat_settings bcs ON bcs.bot_id=b.id AND bcs.conversation_id=$1
      WHERE cm.conversation_id=$1 AND b.bot_user_id IS NOT NULL AND b.bot_user_id<>$2`, [cid, senderId]);
    if (!r.rowCount) return;
    const chat=await getConversation(cid); const eligibleBots=r.rows.filter(bot=>bot.chat_can_read!==false && (bot.privacy_mode===false || !['group','channel'].includes(String(chat?.type)) || String(message.text||'').startsWith('/') || String(message.text||'').toLowerCase().includes('@'+String(bot.username||'').toLowerCase())));
    if (!eligibleBots.length) return;

    const update = {
      update_id: Number(message.id),
      message: {
        message_id: Number(message.id),
        chat: { id: cid },
        from: {
          id: Number(message.sender_id),
          is_bot: false,
          first_name: message.display_name || message.username || 'کاربر',
          username: message.username || ''
        },
        date: Math.floor(new Date(message.created_at || Date.now()).getTime() / 1000),
        text: message.text || '',
        reply_to_message: message.reply_to ? { message_id: Number(message.reply_to) } : undefined
      }
    };

    await Promise.allSettled(eligibleBots.map(async bot => {
      await q('INSERT INTO bot_updates(bot_id,update_json) VALUES($1,$2)', [Number(bot.id), JSON.stringify(update)]);
      const webhook = String(bot.webhook_url || '').trim();
      if (webhook && /^https:\/\//i.test(webhook)) {
        try {
          await fetch(webhook, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(update),
            signal: AbortSignal.timeout(5000)
          });
        } catch (e) {
          console.warn('bot webhook delivery failed', bot.username, e.message);
        }
      }
    }));
  } catch (e) {
    // Bot update delivery is intentionally isolated from normal chat delivery.
    console.error('dispatchBotUpdateForMessage', e);
  }
}

app.post('/api/messages', auth, async (req, res) => {
  try {
    const cid = Number(req.body.conversationId); const check = await canMessage(cid, req.user.id);
    if (!check.ok) return res.status(403).json({ error: check.error });
    const text = String(req.body.text || '').trim().slice(0, 5000);
    const replyTo = req.body.replyTo ? Number(req.body.replyTo) : null;
    const fileUrl=String(req.body.fileUrl||'').slice(0,1000), fileType=String(req.body.fileType||'').slice(0,120), fileName=safeFileName(req.body.fileName||''), kind=String(req.body.kind||'text').slice(0,40);
    const profileId=req.body.profileId?Number(req.body.profileId):null;
    const expiresIn=req.body.expiresIn?Number(req.body.expiresIn):null;
    const quoteIds=Array.isArray(req.body.quoteIds)?req.body.quoteIds:[];
    if (!text && !fileUrl) return res.status(400).json({ error: 'پیام خالی است' });
    if (text && !fileUrl && await isBotFatherConversation(cid)) {
      const userOut=await insertMessage({ cid, uid:req.user.id, text, kind:'text', replyTo, profileId, expiresIn, quoteIds });
      io.to('conv:'+cid).emit('message',userOut);
      const handled=await handleBotFatherCommand(cid, req.user.id, text);
      if(handled){
        const fresh=await q('SELECT * FROM messages WHERE conversation_id=$1 ORDER BY id DESC LIMIT 1',[cid]);
        return res.json(await messageView(fresh.rows[0]));
      }
    }
    const out = await insertMessage({ cid, uid: req.user.id, text, kind, fileUrl, fileType, fileName, replyTo, profileId, expiresIn, quoteIds });
    io.to('conv:' + cid).emit('message', out);
    if(text && !fileUrl) void handleConfiguredBotCommand(cid, req.user.id, text);
    void dispatchBotUpdateForMessage(out);
    res.json(out);
  } catch (e) { console.error(e); res.status(500).json({ error: 'ارسال پیام ناموفق بود' }); }
});

// Stage 2: advanced message search, read receipts, disappearing messages and deep links
app.get('/api/conversations/:id/search', auth, async (req,res)=>{
  try{
    const cid=Number(req.params.id); if(!await isMember(cid,req.user.id)) return res.status(403).json({error:'دسترسی ندارید'});
    const text=String(req.query.q||'').trim(); const sender=req.query.sender?Number(req.query.sender):null;
    const type=String(req.query.type||'all'); const from=req.query.from?new Date(req.query.from):null; const to=req.query.to?new Date(req.query.to):null;
    const params=[cid,text,sender,from,to];
    let where=`conversation_id=$1 AND deleted=false AND ($2='' OR text ILIKE '%'||$2||'%') AND ($3::bigint IS NULL OR sender_id=$3) AND ($4::timestamptz IS NULL OR created_at >= $4) AND ($5::timestamptz IS NULL OR created_at < $5)`;
    if(type==='image') where += ` AND file_type LIKE 'image/%'`; else if(type==='video') where += ` AND file_type LIKE 'video/%'`; else if(type==='audio') where += ` AND (file_type LIKE 'audio/%' OR kind='voice')`; else if(type==='file') where += ` AND file_url<>'' AND file_type NOT LIKE 'image/%' AND file_type NOT LIKE 'video/%' AND file_type NOT LIKE 'audio/%'`; else if(type==='link') where += ` AND text ~* 'https?://[^[:space:]]+'`;
    const r=await q(`SELECT id,conversation_id,sender_id,text,file_url,file_type,file_name,kind,reply_to,created_at,deleted,reactions,expires_at,quote_ids FROM messages WHERE ${where} AND NOT EXISTS (SELECT 1 FROM message_hidden mh WHERE mh.message_id=messages.id AND mh.user_id=$6) ORDER BY id DESC LIMIT 100`,[...params, req.user.id]);
    const out=[]; for(const m of r.rows) out.push(await messageView(m)); res.json(out);
  }catch(e){console.error(e);res.status(500).json({error:'جستجو ناموفق بود'})}
});
app.post('/api/conversations/:id/read', auth, async(req,res)=>{const cid=Number(req.params.id);if(!await isMember(cid,req.user.id))return res.status(403).json({error:'دسترسی ندارید'});await q('UPDATE conversation_members SET last_read_at=now() WHERE conversation_id=$1 AND user_id=$2',[cid,req.user.id]);await q(`INSERT INTO message_receipts(message_id,user_id,delivered_at,read_at) SELECT id,$2,now(),now() FROM messages WHERE conversation_id=$1 AND sender_id<>$2 AND deleted=false AND NOT EXISTS(SELECT 1 FROM message_receipts mr WHERE mr.message_id=messages.id AND mr.user_id=$2)`,[cid,req.user.id]);io.to('conv:'+cid).emit('read_receipt',{conversationId:cid,userId:req.user.id});res.json({ok:true})});
app.get('/api/messages/:id/link',auth,async(req,res)=>{const r=await q('SELECT id,conversation_id FROM messages WHERE id=$1 AND deleted=false',[Number(req.params.id)]);if(!r.rowCount||!await isMember(r.rows[0].conversation_id,req.user.id))return res.status(404).json({error:'پیام پیدا نشد'});res.json({url:`${String(req.protocol)}://${req.get('host')}/#/msg/${r.rows[0].conversation_id}/${r.rows[0].id}`})});
app.post('/api/messages/:id/forward',auth,async(req,res)=>{try{const src=await q('SELECT * FROM messages WHERE id=$1 AND deleted=false',[Number(req.params.id)]);if(!src.rowCount)return res.status(404).json({error:'پیام پیدا نشد'});const m=src.rows[0], target=Number(req.body.conversationId);const ck=await canMessage(target,req.user.id);if(!ck.ok)return res.status(403).json({error:ck.error});const out=await insertMessage({cid:target,uid:req.user.id,text:m.text,kind:m.kind,fileUrl:m.file_url,fileType:m.file_type,fileName:m.file_name,profileId:null,quoteIds:[m.id]});io.to('conv:'+target).emit('message',out);res.json(out)}catch(e){console.error(e);res.status(500).json({error:'فوروارد ناموفق بود'})}});
function safeFileName(name) { return path.basename(String(name || 'file')).replace(/[^\w.\- ]+/g, '_').slice(0, 120); }
async function uploadToStorage(file, folder, userId) {
  const ext = path.extname(file.originalname).toLowerCase();
  const objectPath = `${folder}/${userId}/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
  const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(objectPath, file.buffer, {
    contentType: file.mimetype, upsert: false, cacheControl: '31536000'
  });
  if (error) throw error;
  const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(objectPath);
  return { url: data.publicUrl, path: objectPath };
}

async function removeStoredMessageFile(fileUrl) {
  if (!fileUrl) return;
  try {
    const raw = String(fileUrl);
    const marker = `/storage/v1/object/public/${STORAGE_BUCKET}/`;
    const i = raw.indexOf(marker);
    if (i < 0) return;
    const objectPath = decodeURIComponent(raw.slice(i + marker.length).split('?')[0]);
    if (objectPath) await supabase.storage.from(STORAGE_BUCKET).remove([objectPath]);
  } catch (e) { console.warn('message storage cleanup', e.message); }
}

app.post('/api/upload', auth, (req, res) => {
  upload.single('file')(req, res, async err => {
    try {
      if (err) return res.status(400).json({ error: err.message || 'آپلود ناموفق بود' });
      if (!req.file) return res.status(400).json({ error: 'فایل ارسال نشده' });
      const stored = await uploadToStorage(req.file, 'files', req.user.id);
      res.json({ url: stored.url, name: safeFileName(req.file.originalname), size: req.file.size, mime: req.file.mimetype, storage_path: stored.path });
    } catch (e) { console.error(e); res.status(500).json({ error: 'ذخیره فایل ناموفق بود' }); }
  });
});

app.put('/api/profile', auth, async (req, res) => {
  const name = String(req.body.displayName || '').trim().slice(0, 50), bio = String(req.body.bio || '').trim().slice(0, 160);
  if (!name) return res.status(400).json({ error: 'نام نامعتبر است' });
  const r = await q('UPDATE users SET display_name=$1,bio=$2,updated_at=now() WHERE id=$3 RETURNING id,username,email,display_name,avatar,bio', [name,bio,req.user.id]);
  res.json(safeUser(r.rows[0]));
});
app.post('/api/profile/avatar', auth, (req, res) => {
  upload.single('avatar')(req, res, async err => {
    try {
      if (err) return res.status(400).json({ error: err.message || 'آپلود ناموفق بود' });
      if (!req.file || !/^image\/(jpeg|png|webp|gif)$/.test(req.file.mimetype)) return res.status(400).json({ error: 'لطفاً یک تصویر JPG، PNG، WEBP یا GIF انتخاب کنید' });
      const stored = await uploadToStorage(req.file, 'avatars', req.user.id);
      const r = await q('UPDATE users SET avatar=$1,updated_at=now() WHERE id=$2 RETURNING id,username,email,display_name,avatar,bio', [stored.url,req.user.id]);
      res.json(safeUser(r.rows[0]));
    } catch (e) { console.error(e); res.status(500).json({ error: 'ذخیره تصویر ناموفق بود' }); }
  });
});

// Profile media: up to 10 photos and 2 songs per account.
app.get('/api/profile/media', auth, async (req,res)=>{
  const r=await q('SELECT id,kind,url,name,mime,size,position,created_at FROM profile_media WHERE user_id=$1 ORDER BY kind,position,id',[req.user.id]);
  res.json(r.rows.map(x=>({...x,id:Number(x.id),position:Number(x.position||0),size:Number(x.size||0)})));
});
app.post('/api/profile/photos', auth, (req,res)=>{
  upload.single('photo')(req,res,async err=>{
    try{
      if(err)return res.status(400).json({error:err.message||'آپلود ناموفق بود'});
      if(!req.file||!/^image\/(jpeg|png|webp|gif)$/.test(req.file.mimetype))return res.status(400).json({error:'عکس JPG، PNG، WEBP یا GIF انتخاب کنید'});
      const count=await q("SELECT count(*)::int AS n FROM profile_media WHERE user_id=$1 AND kind='photo'",[req.user.id]);
      if(Number(count.rows[0].n)>=24)return res.status(400).json({error:'حداکثر ۲۴ عکس پروفایل مجاز است'});
      const stored=await uploadToStorage(req.file,'profile-photos',req.user.id);
      const pos=Number(count.rows[0].n);
      const r=await q("INSERT INTO profile_media(user_id,kind,url,name,mime,size,position) VALUES($1,'photo',$2,$3,$4,$5,$6) RETURNING *",[req.user.id,stored.url,safeFileName(req.file.originalname),req.file.mimetype,req.file.size,pos]);
      res.json({...r.rows[0],id:Number(r.rows[0].id),position:Number(r.rows[0].position)});
    }catch(e){console.error(e);res.status(500).json({error:'ذخیره عکس پروفایل ناموفق بود'})}
  });
});
app.delete('/api/profile/photos/:id', auth, async(req,res)=>{await q("DELETE FROM profile_media WHERE id=$1 AND user_id=$2 AND kind='photo'",[Number(req.params.id),req.user.id]);res.json({ok:true})});
app.post('/api/profile/songs', auth, (req,res)=>{
  upload.single('song')(req,res,async err=>{
    try{
      if(err)return res.status(400).json({error:err.message||'آپلود ناموفق بود'});
      if(!req.file||!/^audio\//.test(req.file.mimetype))return res.status(400).json({error:'یک فایل صوتی معتبر انتخاب کنید'});
      const count=await q("SELECT count(*)::int AS n FROM profile_media WHERE user_id=$1 AND kind='song'",[req.user.id]);
      if(Number(count.rows[0].n)>=3)return res.status(400).json({error:'حداکثر ۳ آهنگ در پروفایل مجاز است'});
      const stored=await uploadToStorage(req.file,'profile-songs',req.user.id);
      const pos=Number(count.rows[0].n);
      const r=await q("INSERT INTO profile_media(user_id,kind,url,name,mime,size,position) VALUES($1,'song',$2,$3,$4,$5,$6) RETURNING *",[req.user.id,stored.url,safeFileName(req.file.originalname),req.file.mimetype,req.file.size,pos]);
      res.json({...r.rows[0],id:Number(r.rows[0].id),position:Number(r.rows[0].position)});
    }catch(e){console.error(e);res.status(500).json({error:'ذخیره آهنگ ناموفق بود'})}
  });
});
app.delete('/api/profile/songs/:id', auth, async(req,res)=>{await q("DELETE FROM profile_media WHERE id=$1 AND user_id=$2 AND kind='song'",[Number(req.params.id),req.user.id]);res.json({ok:true})});


// ---- Zento Stage 1: appearance, folders, chat locks, profiles ----
const defaultTheme={accent:'#3390ec',mine:'#2b6cff',theirs:'#ffffff',background:'#dce9f4',bubbleRadius:18,shadow:true,fontSize:15,compact:false};
const defaultSettings={
  notifications:{messages:true,sounds:true,previews:true},
  data_usage:{autoplay:true,autoDownloadImages:true,autoDownloadVideos:false,autoDownloadAudio:false},
  privacy:{lastSeen:'everyone',profilePhoto:'everyone',readReceipts:true},
  security:{twoStep:false},
  appearance:{dark:false,compact:false}
};
function mergeSettings(value){return {
  ...defaultSettings,
  ...(value||{}),
  notifications:{...defaultSettings.notifications,...((value||{}).notifications||{})},
  data_usage:{...defaultSettings.data_usage,...((value||{}).data_usage||{})},
  privacy:{...defaultSettings.privacy,...((value||{}).privacy||{})},
  security:{...defaultSettings.security,...((value||{}).security||{})},
  appearance:{...defaultSettings.appearance,...((value||{}).appearance||{})}
};}
app.get('/api/preferences', auth, async (req,res)=>{ const r=await q('SELECT theme FROM user_preferences WHERE user_id=$1',[req.user.id]); res.json({theme:{...defaultTheme,...(r.rows[0]?.theme||{})}}); });
app.put('/api/preferences', auth, async (req,res)=>{ const theme={...defaultTheme,...(req.body.theme||{})}; await q(`INSERT INTO user_preferences(user_id,theme) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET theme=EXCLUDED.theme,updated_at=now()`,[req.user.id,JSON.stringify(theme)]); res.json({theme}); });
// Backwards-compatible settings API used by the Telegram-inspired settings UI.
app.get('/api/settings', auth, async (req,res)=>{ const r=await q('SELECT settings FROM user_preferences WHERE user_id=$1',[req.user.id]); res.json(mergeSettings(r.rows[0]?.settings)); });
app.put('/api/settings', auth, async (req,res)=>{ const settings=mergeSettings(req.body); await q(`INSERT INTO user_preferences(user_id,settings) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET settings=EXCLUDED.settings,updated_at=now()`,[req.user.id,JSON.stringify(settings)]); res.json(settings); });
app.get('/api/folders', auth, async (req,res)=>{ const r=await q(`SELECT f.id,f.name,f.icon,f.position,COALESCE(json_agg(m.conversation_id) FILTER(WHERE m.conversation_id IS NOT NULL),'[]') conversations FROM chat_folders f LEFT JOIN chat_folder_members m ON m.folder_id=f.id WHERE f.user_id=$1 GROUP BY f.id ORDER BY f.position,f.id`,[req.user.id]); res.json(r.rows.map(x=>({...x,id:Number(x.id),conversations:(x.conversations||[]).map(Number)}))); });
app.post('/api/folders', auth, async (req,res)=>{ const name=String(req.body.name||'').trim().slice(0,40); const icon=String(req.body.icon||'📁').slice(0,4); if(!name)return res.status(400).json({error:'نام پوشه لازم است'}); try{const r=await q('INSERT INTO chat_folders(user_id,name,icon,position) VALUES($1,$2,$3,(SELECT COALESCE(max(position)+1,0) FROM chat_folders WHERE user_id=$1)) RETURNING *',[req.user.id,name,icon]);res.json({...r.rows[0],id:Number(r.rows[0].id),conversations:[]})}catch(e){res.status(409).json({error:'این پوشه قبلاً وجود دارد'})}});
app.put('/api/folders/:id', auth, async (req,res)=>{const id=Number(req.params.id);const name=String(req.body.name||'').trim().slice(0,40);const icon=String(req.body.icon||'📁').slice(0,4);await q('UPDATE chat_folders SET name=$1,icon=$2 WHERE id=$3 AND user_id=$4',[name,icon,id,req.user.id]);res.json({ok:true})});
app.delete('/api/folders/:id', auth, async (req,res)=>{await q('DELETE FROM chat_folders WHERE id=$1 AND user_id=$2',[Number(req.params.id),req.user.id]);res.json({ok:true})});
app.post('/api/folders/:id/conversations/:cid', auth, async (req,res)=>{const f=Number(req.params.id),c=Number(req.params.cid);if(!(await q('SELECT 1 FROM chat_folders WHERE id=$1 AND user_id=$2',[f,req.user.id])).rowCount)return res.status(404).json({error:'پوشه پیدا نشد'});if(!(await isMember(c,req.user.id)))return res.status(403).json({error:'عضو گفتگو نیستید'});await q('INSERT INTO chat_folder_members(folder_id,conversation_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[f,c]);res.json({ok:true})});
app.delete('/api/folders/:id/conversations/:cid', auth, async (req,res)=>{await q('DELETE FROM chat_folder_members WHERE folder_id=$1 AND conversation_id=$2 AND EXISTS(SELECT 1 FROM chat_folders WHERE id=$1 AND user_id=$3)',[Number(req.params.id),Number(req.params.cid),req.user.id]);res.json({ok:true})});
app.get('/api/conversations/:id/lock', auth, async(req,res)=>{const r=await q('SELECT 1 FROM chat_locks WHERE user_id=$1 AND conversation_id=$2',[req.user.id,Number(req.params.id)]);res.json({locked:r.rowCount>0})});
app.post('/api/conversations/:id/lock', auth, async(req,res)=>{const pin=String(req.body.pin||'');if(!/^\d{4,8}$/.test(pin))return res.status(400).json({error:'PIN باید ۴ تا ۸ رقم باشد'});if(!(await isMember(Number(req.params.id),req.user.id)))return res.status(403).json({error:'دسترسی ندارید'});const hash=await bcrypt.hash(pin,12);await q('INSERT INTO chat_locks(user_id,conversation_id,pin_hash) VALUES($1,$2,$3) ON CONFLICT(user_id,conversation_id) DO UPDATE SET pin_hash=EXCLUDED.pin_hash,updated_at=now()',[req.user.id,Number(req.params.id),hash]);res.json({locked:true})});
app.post('/api/conversations/:id/unlock', auth, async(req,res)=>{const r=await q('SELECT pin_hash FROM chat_locks WHERE user_id=$1 AND conversation_id=$2',[req.user.id,Number(req.params.id)]);if(!r.rowCount)return res.json({unlocked:true});if(!(await bcrypt.compare(String(req.body.pin||''),r.rows[0].pin_hash)))return res.status(403).json({error:'PIN اشتباه است'});res.json({unlocked:true})});
app.delete('/api/conversations/:id/lock', auth, async(req,res)=>{await q('DELETE FROM chat_locks WHERE user_id=$1 AND conversation_id=$2',[req.user.id,Number(req.params.id)]);res.json({locked:false})});
app.get('/api/profiles', auth, async(req,res)=>{let r=await q('SELECT * FROM user_profiles WHERE user_id=$1 ORDER BY is_default DESC,id',[req.user.id]);if(!r.rowCount){await q('INSERT INTO user_profiles(user_id,name,username,avatar,bio,is_default) VALUES($1,$2,$3,$4,$5,true)',[req.user.id,req.user.display_name,req.user.username,req.user.avatar,req.user.bio]);r=await q('SELECT * FROM user_profiles WHERE user_id=$1 ORDER BY is_default DESC,id',[req.user.id]);}res.json(r.rows.map(x=>({...x,id:Number(x.id)})))});
app.post('/api/profiles', auth, async(req,res)=>{const name=String(req.body.name||'').trim().slice(0,50),username=String(req.body.username||'').trim().toLowerCase().replace(/[^a-z0-9_]/g,'').slice(0,30),bio=String(req.body.bio||'').trim().slice(0,200),avatar=String(req.body.avatar||'').slice(0,1000);if(!name||username.length<3)return res.status(400).json({error:'نام و نام کاربری لازم است'});try{const r=await q('INSERT INTO user_profiles(user_id,name,username,avatar,bio) VALUES($1,$2,$3,$4,$5) RETURNING *',[req.user.id,name,username,avatar,bio]);res.json({...r.rows[0],id:Number(r.rows[0].id)})}catch(e){res.status(409).json({error:'این نام کاربری در پروفایل‌های شما تکراری است'})}});
app.put('/api/profiles/:id', auth, async(req,res)=>{const id=Number(req.params.id);const r=await q('UPDATE user_profiles SET name=$1,username=$2,bio=$3,avatar=$4 WHERE id=$5 AND user_id=$6 RETURNING *',[String(req.body.name||'').trim().slice(0,50),String(req.body.username||'').trim().toLowerCase().replace(/[^a-z0-9_]/g,'').slice(0,30),String(req.body.bio||'').trim().slice(0,200),String(req.body.avatar||'').slice(0,1000),id,req.user.id]);if(!r.rowCount)return res.status(404).json({error:'پروفایل پیدا نشد'});res.json({...r.rows[0],id:Number(r.rows[0].id)})});
app.delete('/api/profiles/:id', auth, async(req,res)=>{const id=Number(req.params.id);const r=await q('SELECT is_default FROM user_profiles WHERE id=$1 AND user_id=$2',[id,req.user.id]);if(!r.rowCount)return res.status(404).json({error:'پروفایل پیدا نشد'});if(r.rows[0].is_default)return res.status(400).json({error:'پروفایل اصلی قابل حذف نیست'});await q('DELETE FROM user_profiles WHERE id=$1 AND user_id=$2',[id,req.user.id]);res.json({ok:true})});
app.patch('/api/conversations/:id', auth, async (req, res) => {
  try {
    const cid = Number(req.params.id);
    const c = await getConversation(cid);
    if (!c || !['group','channel'].includes(c.type)) return res.status(404).json({ error: 'گروه یا کانال پیدا نشد' });
    const manager = await conversationManager(cid, req.user.id);
    if (!manager.ok) return res.status(403).json({ error: manager.error });
    const name = String(req.body.name ?? c.name).trim().slice(0, 60);
    const username = String(req.body.username ?? c.username ?? '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 30);
    const description = String(req.body.description ?? c.description ?? '').trim().slice(0, 200);
    if (!name) return res.status(400).json({ error: 'نام الزامی است' });
    if (username && username.length < 3) return res.status(400).json({ error: 'شناسه باید حداقل ۳ حرف باشد' });
    const dupe = await q('SELECT 1 FROM conversations WHERE username=$1 AND id<>$2 LIMIT 1', [username, cid]);
    if (username && dupe.rowCount) return res.status(409).json({ error: 'این شناسه قبلاً استفاده شده است' });
    const r = await q('UPDATE conversations SET name=$1,username=$2,description=$3,updated_at=now() WHERE id=$4 RETURNING *', [name, username || null, description, cid]);
    res.json(await conversationView(r.rows[0], req.user.id));
  } catch (e) { console.error(e); res.status(500).json({ error: 'ویرایش گفتگو ناموفق بود' }); }
});

app.put('/api/conversations/:id/profile', auth, async(req,res)=>{const cid=Number(req.params.id),pid=Number(req.body.profileId);if(!(await isMember(cid,req.user.id)))return res.status(403).json({error:'دسترسی ندارید'});if(!(await q('SELECT 1 FROM user_profiles WHERE id=$1 AND user_id=$2',[pid,req.user.id])).rowCount)return res.status(404).json({error:'پروفایل پیدا نشد'});await q('INSERT INTO conversation_profiles(user_id,conversation_id,profile_id) VALUES($1,$2,$3) ON CONFLICT(user_id,conversation_id) DO UPDATE SET profile_id=EXCLUDED.profile_id',[req.user.id,cid,pid]);res.json({ok:true,profileId:pid})});
app.get('/api/conversations/:id/profile', auth, async(req,res)=>{const r=await q('SELECT p.* FROM conversation_profiles cp JOIN user_profiles p ON p.id=cp.profile_id WHERE cp.user_id=$1 AND cp.conversation_id=$2',[req.user.id,Number(req.params.id)]);res.json(r.rows[0]?{...r.rows[0],id:Number(r.rows[0].id)}:null)});

app.get('/api/users/:id/profile', auth, async (req, res) => {
  const id = Number(req.params.id); if (!id) return res.status(400).json({ error: 'کاربر نامعتبر است' });
  const u = await getUser(id); if (!u) return res.status(404).json({ error: 'کاربر پیدا نشد' });
  const blocked = (await q('SELECT 1 FROM blocks WHERE user_id=$1 AND blocked_id=$2',[req.user.id,id])).rowCount > 0;
  const blockedBy = (await q('SELECT 1 FROM blocks WHERE user_id=$1 AND blocked_id=$2',[id,req.user.id])).rowCount > 0;
  const media=await q('SELECT id,kind,url,name,mime,position FROM profile_media WHERE user_id=$1 ORDER BY kind,position,id',[id]);
  res.json({...u,blocked,blockedBy,photos:media.rows.filter(x=>x.kind==='photo').map(x=>({...x,id:Number(x.id),position:Number(x.position||0)})),songs:media.rows.filter(x=>x.kind==='song').map(x=>({...x,id:Number(x.id),position:Number(x.position||0)}))});
});

// ---- Zento Stories + public profile sharing ----
app.get('/api/public/users/:username/profile', auth, async (req,res)=>{
  const username=String(req.params.username||'').trim().replace(/^@/,'');
  const ur=await q('SELECT id,username,email,display_name,avatar,bio FROM users WHERE lower(username)=lower($1) LIMIT 1',[username]);
  if(!ur.rowCount)return res.status(404).json({error:'کاربر پیدا نشد'});
  const id=Number(ur.rows[0].id);
  const media=await q('SELECT id,kind,url,name,mime,position FROM profile_media WHERE user_id=$1 ORDER BY kind,position,id',[id]);
  const stories=await q(`SELECT s.id,s.kind,s.url,s.text,s.created_at,s.expires_at
    FROM stories s WHERE s.user_id=$1 AND s.expires_at>now() ORDER BY s.created_at DESC`,[id]);
  res.json({...safeUser(ur.rows[0]),photos:media.rows.filter(x=>x.kind==='photo').map(x=>({...x,id:Number(x.id),position:Number(x.position||0)})),songs:media.rows.filter(x=>x.kind==='song').map(x=>({...x,id:Number(x.id),position:Number(x.position||0)})),stories:stories.rows.map(x=>({...x,id:Number(x.id)}))});
});
app.get('/api/stories/feed', auth, async (req,res)=>{
  const r=await q(`SELECT s.id,s.user_id,s.kind,s.url,s.text,s.created_at,s.expires_at,
      u.username,u.display_name,u.avatar,
      EXISTS(SELECT 1 FROM story_views sv WHERE sv.story_id=s.id AND sv.viewer_id=$1) AS viewed, (SELECT count(*) FROM story_views vx WHERE vx.story_id=s.id) AS view_count, (SELECT count(*) FROM story_reactions rx WHERE rx.story_id=s.id) AS reaction_count, EXISTS(SELECT 1 FROM story_reactions rm WHERE rm.story_id=s.id AND rm.user_id=$1) AS reacted
    FROM stories s JOIN users u ON u.id=s.user_id
    WHERE s.expires_at>now() AND (s.user_id=$1 OR EXISTS(
      SELECT 1 FROM conversation_members cm1 JOIN conversation_members cm2 ON cm2.conversation_id=cm1.conversation_id
      WHERE cm1.user_id=$1 AND cm2.user_id=s.user_id))
    ORDER BY s.created_at ASC`,[req.user.id]);
  const grouped=new Map();
  for(const x of r.rows){if(!grouped.has(x.user_id))grouped.set(x.user_id,{user_id:Number(x.user_id),username:x.username,display_name:x.display_name,avatar:x.avatar||'',has_unseen:false,stories:[]});const g=grouped.get(x.user_id);g.stories.push({...x,id:Number(x.id),user_id:Number(x.user_id)});if(!x.viewed)g.has_unseen=true}
  res.json([...grouped.values()]);
});
app.post('/api/stories', auth, (req,res)=>{
  upload.single('story')(req,res,async err=>{try{
    if(err)return res.status(400).json({error:err.message||'آپلود ناموفق بود'});
    if(!req.file||!(/^(image\/(jpeg|png|webp|gif)|video\/(mp4|webm|quicktime|ogg))$/.test(req.file.mimetype)))return res.status(400).json({error:'عکس یا ویدیوی معتبر انتخاب کنید'});
    const active=await q("SELECT count(*)::int AS n FROM stories WHERE user_id=$1 AND expires_at>now()",[req.user.id]);
    if(Number(active.rows[0].n)>=20)return res.status(400).json({error:'حداکثر ۲۰ استوری فعال مجاز است'});
    const stored=await uploadToStorage(req.file,'stories',req.user.id);
    const text=String(req.body.text||'').trim().slice(0,500);
    const r=await q(`INSERT INTO stories(user_id,kind,url,text,expires_at) VALUES($1,$2,$3,$4,now()+interval '24 hours') RETURNING *`,[req.user.id,req.file.mimetype.startsWith('video/')?'video':'photo',stored.url,text]);
    res.json({...r.rows[0],id:Number(r.rows[0].id),user_id:Number(r.rows[0].user_id)});
  }catch(e){console.error(e);res.status(500).json({error:'ساخت استوری ناموفق بود'})}})
});
app.post('/api/stories/:id/view', auth, async(req,res)=>{const id=Number(req.params.id);const ok=await q('SELECT 1 FROM stories WHERE id=$1 AND expires_at>now()',[id]);if(!ok.rowCount)return res.status(404).json({error:'استوری پیدا نشد'});await q('INSERT INTO story_views(story_id,viewer_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[id,req.user.id]);res.json({ok:true})});
app.post('/api/stories/:id/reaction', auth, async(req,res)=>{try{const id=Number(req.params.id), reaction=String(req.body.reaction||'❤️').slice(0,8);const st=await q('SELECT user_id FROM stories WHERE id=$1 AND expires_at>now()',[id]);if(!st.rowCount)return res.status(404).json({error:'استوری پیدا نشد'});const ex=await q('SELECT reaction FROM story_reactions WHERE story_id=$1 AND user_id=$2',[id,req.user.id]);if(ex.rowCount && ex.rows[0].reaction===reaction) await q('DELETE FROM story_reactions WHERE story_id=$1 AND user_id=$2',[id,req.user.id]);else await q('INSERT INTO story_reactions(story_id,user_id,reaction) VALUES($1,$2,$3) ON CONFLICT(story_id,user_id) DO UPDATE SET reaction=EXCLUDED.reaction,created_at=now()',[id,req.user.id,reaction]);const n=await q('SELECT count(*)::int n FROM story_reactions WHERE story_id=$1',[id]);res.json({ok:true,count:Number(n.rows[0].n),mine:!!ex.rowCount&&ex.rows[0].reaction!==reaction});}catch(e){res.status(500).json({error:'ثبت واکنش ناموفق بود'})}});
app.get('/api/stories/:id/stats', auth, async(req,res)=>{try{const id=Number(req.params.id);const st=await q('SELECT user_id FROM stories WHERE id=$1',[id]);if(!st.rowCount)return res.status(404).json({error:'استوری پیدا نشد'});if(Number(st.rows[0].user_id)!==Number(req.user.id))return res.status(403).json({error:'فقط صاحب استوری می‌تواند آمار را ببیند'});const v=await q(`SELECT u.id,u.username,u.display_name,u.avatar,sv.viewed_at FROM story_views sv JOIN users u ON u.id=sv.viewer_id WHERE sv.story_id=$1 ORDER BY sv.viewed_at DESC`,[id]);const r=await q(`SELECT u.id,u.username,u.display_name,u.avatar,sr.reaction,sr.created_at FROM story_reactions sr JOIN users u ON u.id=sr.user_id WHERE sr.story_id=$1 ORDER BY sr.created_at DESC`,[id]);res.json({views:v.rows.map(x=>({...x,id:Number(x.id)})),reactions:r.rows.map(x=>({...x,id:Number(x.id)})),viewCount:v.rowCount,reactionCount:r.rowCount});}catch(e){res.status(500).json({error:'دریافت آمار ناموفق بود'})}});
app.get('/api/conversations/:id/user-settings', auth, async(req,res)=>{const r=await q('SELECT pinned,muted,archived FROM conversation_user_settings WHERE user_id=$1 AND conversation_id=$2',[req.user.id,Number(req.params.id)]);res.json(r.rows[0]||{pinned:false,muted:false,archived:false})});
app.post('/api/conversations/:id/user-settings', auth, async(req,res)=>{const cid=Number(req.params.id);if(!await isMember(cid,req.user.id))return res.status(403).json({error:'دسترسی ندارید'});const fields=['pinned','muted','archived'].filter(k=>typeof req.body[k]==='boolean');if(!fields.length)return res.status(400).json({error:'گزینه نامعتبر'});const cur=await q('SELECT pinned,muted,archived FROM conversation_user_settings WHERE user_id=$1 AND conversation_id=$2',[req.user.id,cid]);const old=cur.rows[0]||{pinned:false,muted:false,archived:false};const val={...old};fields.forEach(k=>val[k]=req.body[k]);await q(`INSERT INTO conversation_user_settings(user_id,conversation_id,pinned,muted,archived,updated_at) VALUES($1,$2,$3,$4,$5,now()) ON CONFLICT(user_id,conversation_id) DO UPDATE SET pinned=$3,muted=$4,archived=$5,updated_at=now()`,[req.user.id,cid,val.pinned,val.muted,val.archived]);res.json(val)});
app.delete('/api/conversations/:id/self', auth, async(req,res)=>{const cid=Number(req.params.id);const c=await getConversation(cid);if(!c||!await isMember(cid,req.user.id))return res.status(404).json({error:'گفتگو پیدا نشد'});if(c.type==='direct'){await q('DELETE FROM conversation_members WHERE conversation_id=$1 AND user_id=$2',[cid,req.user.id]);}else{await q('DELETE FROM conversation_members WHERE conversation_id=$1 AND user_id=$2',[cid,req.user.id]);}res.json({ok:true})});
app.delete('/api/stories/:id', auth, async(req,res)=>{await q('DELETE FROM stories WHERE id=$1 AND user_id=$2',[Number(req.params.id),req.user.id]);res.json({ok:true})});

app.post('/api/users/:id/block', auth, async (req, res) => {
  const id = Number(req.params.id); if (!await getUser(id) || id === req.user.id) return res.status(400).json({ error: 'کاربر نامعتبر است' });
  const existing = await q('SELECT 1 FROM blocks WHERE user_id=$1 AND blocked_id=$2',[req.user.id,id]);
  if (existing.rowCount) { await q('DELETE FROM blocks WHERE user_id=$1 AND blocked_id=$2',[req.user.id,id]); return res.json({blocked:false}); }
  await q('INSERT INTO blocks(user_id,blocked_id) VALUES($1,$2)',[req.user.id,id]); res.json({blocked:true});
});
app.post('/api/users/:id/report', auth, async (req, res) => {
  const id = Number(req.params.id), reason = String(req.body.reason || 'رفتار نامناسب').trim().slice(0,200);
  if (!await getUser(id) || id === req.user.id) return res.status(400).json({ error: 'کاربر نامعتبر است' });
  await q('INSERT INTO reports(reporter_id,reported_id,reason) VALUES($1,$2,$3)',[req.user.id,id,reason]); res.json({ok:true});
});

// Private Saved Messages chat. Stored as a hidden conversation so it can
// reuse the normal message/media pipeline without appearing in the chat list.
async function getOrCreateSavedConversation(userId) {
  let r = await q(`SELECT c.* FROM conversations c
    JOIN conversation_members cm ON cm.conversation_id=c.id AND cm.user_id=$1
    WHERE c.type='group' AND c.owner_id=$1 AND c.name='__zento_saved__'
    ORDER BY c.id DESC LIMIT 1`, [userId]);
  if (r.rowCount) return r.rows[0];
  const cr = await q(`INSERT INTO conversations(name,type,owner_id,description)
    VALUES('__zento_saved__','group',$1,'') RETURNING *`, [userId]);
  const c = cr.rows[0];
  await q("INSERT INTO conversation_members(conversation_id,user_id,role) VALUES($1,$2,'member') ON CONFLICT DO NOTHING", [c.id,userId]);
  return c;
}

app.get('/api/saved/chat', auth, async (req,res)=>{
  try{
    const c = await getOrCreateSavedConversation(req.user.id);
    const saved = await q(`SELECT s.id AS saved_id,s.created_at AS saved_at,m.* FROM saved_messages s
      JOIN messages m ON m.id=s.message_id WHERE s.user_id=$1 ORDER BY s.id DESC LIMIT 500`, [req.user.id]);
    const personal = await q(`SELECT * FROM messages WHERE conversation_id=$1 AND deleted=false ORDER BY id ASC LIMIT 500`, [c.id]);
    const savedMessages=[];
    for(const row of saved.rows){ const m=await messageView(row); savedMessages.push({id:Number(row.saved_id),message:m,created_at:row.saved_at}); }
    const personalMessages=[];
    for(const row of personal.rows) personalMessages.push(await messageView(row));
    res.json({conversation:{id:Number(c.id),name:'پیام‌های ذخیره‌شده',type:'saved'},messages:personalMessages,saved:savedMessages});
  }catch(e){console.error('saved chat get',e);res.status(500).json({error:'باز کردن پیام‌های ذخیره‌شده ناموفق بود'})}
});

app.post('/api/saved/chat/messages', auth, async (req,res)=>{
  try{
    const c = await getOrCreateSavedConversation(req.user.id);
    const text=String(req.body.text||'').trim().slice(0,5000);
    const fileUrl=String(req.body.fileUrl||'').slice(0,1000);
    const fileType=String(req.body.fileType||'').slice(0,120);
    const fileName=safeFileName(req.body.fileName||'');
    const kind=String(req.body.kind||'text').slice(0,40);
    if(!text&&!fileUrl) return res.status(400).json({error:'پیام خالی است'});
    const out=await insertMessage({cid:Number(c.id),uid:req.user.id,text,kind,fileUrl,fileType,fileName});
    res.json(out);
  }catch(e){console.error('saved chat post',e);res.status(500).json({error:'ذخیره پیام ناموفق بود'})}
});

app.post('/api/support', auth, async (req,res)=>{try{const subject=String(req.body.subject||'').trim().slice(0,100),message=String(req.body.message||'').trim().slice(0,2000);if(!message)return res.status(400).json({error:'پیام پشتیبانی الزامی است'});const r=await q('INSERT INTO support_requests(user_id,subject,message) VALUES($1,$2,$3) RETURNING id,created_at',[req.user.id,subject,message]);res.json({ok:true,id:Number(r.rows[0].id),created_at:r.rows[0].created_at});}catch(e){console.error('support',e);res.status(500).json({error:'ارسال درخواست پشتیبانی ناموفق بود'})}});

app.get('/api/saved', auth, async (req, res) => {
  const r = await q(`SELECT s.id AS saved_id,s.created_at AS saved_at,m.* FROM saved_messages s
    JOIN messages m ON m.id=s.message_id WHERE s.user_id=$1 ORDER BY s.id DESC LIMIT 500`, [req.user.id]);
  const out=[]; for(const row of r.rows){ const m=await messageView(row); out.push({id:Number(row.saved_id),user_id:req.user.id,message:m,created_at:row.saved_at}); }
  res.json(out);
});
app.post('/api/saved/:messageId', auth, async (req, res) => {
  const mid=Number(req.params.messageId); const mr=await q('SELECT * FROM messages WHERE id=$1',[mid]); const m=mr.rows[0];
  if(!m || !await isMember(m.conversation_id,req.user.id)) return res.status(404).json({error:'پیام پیدا نشد'});
  const ex=await q('SELECT 1 FROM saved_messages WHERE user_id=$1 AND message_id=$2',[req.user.id,mid]);
  if(ex.rowCount){await q('DELETE FROM saved_messages WHERE user_id=$1 AND message_id=$2',[req.user.id,mid]);return res.json({saved:false});}
  await q('INSERT INTO saved_messages(user_id,message_id) VALUES($1,$2)',[req.user.id,mid]);res.json({saved:true});
});

const online = new Map();
io.use((s, next) => { try { s.user=jwt.verify(s.handshake.auth?.token || '', JWT_SECRET); next(); } catch { next(new Error('unauthorized')); } });
io.on('connection', async socket => {
  const uid=Number(socket.user.id); online.set(uid,(online.get(uid)||0)+1); socket.join('user:'+uid);
  const memberships=await q('SELECT conversation_id FROM conversation_members WHERE user_id=$1',[uid]); memberships.rows.forEach(x=>socket.join('conv:'+Number(x.conversation_id)));
  io.emit('presence',{userId:uid,online:true,devices:online.get(uid)||1});
  socket.on('device:hello',d=>socket.emit('device:state',{userId:uid,devices:online.get(uid)||1,deviceId:String(d?.deviceId||'')}));
  socket.on('join', async cid => { if(await isMember(Number(cid),uid)) socket.join('conv:'+Number(cid)); });
  socket.on('game:join', async cid => { const id=Number(cid); if(!await isMember(id,uid))return; const g=activeGames.get(gameKey(id)); if(!g)return; if(!g.players.includes(uid)&&g.players.length<2){g.players.push(uid);g.turn=g.players[0];} io.to('conv:'+id).emit('game:state',g); });
  socket.on('game:move', async d => { const id=Number(d.conversationId), cell=Number(d.cell); if(!await isMember(id,uid)||cell<0||cell>8)return; const g=activeGames.get(gameKey(id)); if(!g||g.winner||g.players.length<2||g.turn!==uid||g.board[cell])return; const mark=g.players[0]===uid?'X':'O'; g.board[cell]=mark; const wins=[[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]]; if(wins.some(a=>a.every(i=>g.board[i]===mark)))g.winner=uid; else if(g.board.every(Boolean))g.winner='draw'; else g.turn=g.players.find(x=>x!==uid); io.to('conv:'+id).emit('game:state',g); });
  socket.on('game:end', async cid => { const id=Number(cid); if(!await isMember(id,uid))return; activeGames.delete(gameKey(id)); io.to('conv:'+id).emit('game:ended'); });
  socket.on('typing', async d => { const cid=Number(d.conversationId); if(await isMember(cid,uid)) socket.to('conv:'+cid).emit('typing',{userId:uid,typing:!!d.typing}); });
  socket.on('send_message', async d => {
    try { const cid=Number(d.conversationId), check=await canMessage(cid,uid); if(!check.ok)return;
      const text=String(d.text||'').trim().slice(0,5000), fileUrl=String(d.fileUrl||'').slice(0,1000), fileType=String(d.fileType||'').slice(0,120), fileName=safeFileName(d.fileName||'');
      if(!text&&!fileUrl)return;
      if(text&&!fileUrl&&await isBotFatherConversation(cid)){
        const userOut=await insertMessage({cid,uid,text,kind:'text',replyTo:d.replyTo?Number(d.replyTo):null,profileId:d.profileId?Number(d.profileId):null,expiresIn:d.expiresIn?Number(d.expiresIn):null,quoteIds:Array.isArray(d.quoteIds)?d.quoteIds:[]});
        io.to('conv:'+cid).emit('message',userOut);
        if(await handleBotFatherCommand(cid,uid,text)) return;
      }
      const out=await insertMessage({cid,uid,text,kind:String(d.kind||'text'),fileUrl,fileType,fileName,replyTo:d.replyTo?Number(d.replyTo):null,profileId:d.profileId?Number(d.profileId):null,expiresIn:d.expiresIn?Number(d.expiresIn):null,quoteIds:Array.isArray(d.quoteIds)?d.quoteIds:[]}); io.to('conv:'+cid).emit('message',out); if(text&&!fileUrl) void handleConfiguredBotCommand(cid,uid,text); void dispatchBotUpdateForMessage(out);
    } catch(e){ console.error('socket send_message',e); }
  });
  socket.on('react', async d => { try { const mid=Number(d.messageId), emoji=String(d.emoji||'').slice(0,8); const mr=await q('SELECT * FROM messages WHERE id=$1',[mid]); const m=mr.rows[0]; if(!m||!emoji||!await isMember(m.conversation_id,uid))return;
      const reactions=m.reactions||{};
      // A user may have only one reaction on each message. Selecting another emoji
      // removes the previous one; selecting the same emoji again toggles it off.
      let hadSame=false;
      for(const key of Object.keys(reactions)){
        const arr=Array.isArray(reactions[key])?reactions[key]:[];
        if(arr.includes(uid)){
          if(key===emoji) hadSame=true;
          reactions[key]=arr.filter(id=>Number(id)!==Number(uid));
          if(!reactions[key].length) delete reactions[key];
        }
      }
      if(!hadSame){
        if(!Array.isArray(reactions[emoji])) reactions[emoji]=[];
        reactions[emoji].push(uid);
      }
      const rr=await q('UPDATE messages SET reactions=$1 WHERE id=$2 RETURNING reactions',[JSON.stringify(reactions),mid]); io.to('conv:'+m.conversation_id).emit('reaction',{messageId:mid,reactions:rr.rows[0].reactions});
    }catch(e){console.error('socket react',e)} });
  socket.on('delete_message', async d => { try {
    const id=Number(typeof d==='object'?d.id:d), mode=typeof d==='object'?(d.mode||'for_me'):'for_everyone';
    const mr=await q('SELECT * FROM messages WHERE id=$1',[id]); const m=mr.rows[0];
    if(!m || m.deleted || !await isMember(m.conversation_id,uid)) return;
    if(mode==='for_everyone'){
      if(Number(m.sender_id)!==uid) return;
      await q('DELETE FROM saved_messages WHERE message_id=$1',[m.id]);
      await q('DELETE FROM messages WHERE id=$1',[m.id]);
      await removeStoredMessageFile(m.file_url);
      io.to('conv:'+m.conversation_id).emit('message_deleted',Number(m.id));
    } else {
      await q('INSERT INTO message_hidden(message_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[m.id,uid]);
      socket.emit('message_hidden',Number(m.id));
    }
  }catch(e){console.error('socket delete',e)} });
  socket.on('call:offer', d => io.to('user:'+Number(d.to)).emit('call:offer',{from:uid,offer:d.offer,video:!!d.video}));
  socket.on('call:answer', d => io.to('user:'+Number(d.to)).emit('call:answer',{from:uid,answer:d.answer}));
  socket.on('call:ice', d => io.to('user:'+Number(d.to)).emit('call:ice',{from:uid,candidate:d.candidate}));
  socket.on('call:end', d => io.to('user:'+Number(d.to)).emit('call:end',{from:uid}));
  // Lightweight mesh conference signaling for small groups/channels. Media stays peer-to-peer; server only relays SDP/ICE.
  socket.on('conference:join', async d => { const room=String(d.room||''); const m=room.match(/^conv:(\d+)$/); if(!m||!await isMember(Number(m[1]),uid))return; socket.join(room); const members=await q('SELECT user_id FROM conversation_members WHERE conversation_id=$1',[Number(m[1])]); const participants=members.rows.map(x=>Number(x.user_id)).filter(x=>x!==uid).slice(0,8); socket.emit('conference:participants',{room,participants}); socket.to(room).emit('conference:peer-joined',{room,userId:uid}); });
  socket.on('conference:offer', d => { const room=String(d.room||''); io.to('user:'+Number(d.to)).emit('conference:offer',{room,from:uid,offer:d.offer}); });
  socket.on('conference:answer', d => { const room=String(d.room||''); io.to('user:'+Number(d.to)).emit('conference:answer',{room,from:uid,answer:d.answer}); });
  socket.on('conference:ice', d => { const room=String(d.room||''); io.to('user:'+Number(d.to)).emit('conference:ice',{room,from:uid,candidate:d.candidate}); });
  socket.on('conference:leave', d => { const room=String(d.room||''); socket.leave(room); socket.to(room).emit('conference:peer-left',{room,userId:uid}); });
  socket.on('disconnect',()=>{const n=(online.get(uid)||1)-1;if(n<=0){online.delete(uid);io.emit('presence',{userId:uid,online:false,devices:0})}else {online.set(uid,n);io.emit('presence',{userId:uid,online:true,devices:n})}});
});


// ---- Zento Stage 3: badges, statistics, group/channel management, smart notifications ----
app.get('/api/stats', auth, async (req,res)=>{
  try{
    const uid=req.user.id;
    const [msgs,groups,channels,files,contacts,storage]=await Promise.all([
      q('SELECT count(*)::int n FROM messages WHERE sender_id=$1 AND deleted=false',[uid]),
      q("SELECT count(*)::int n FROM conversation_members cm JOIN conversations c ON c.id=cm.conversation_id WHERE cm.user_id=$1 AND c.type='group'",[uid]),
      q("SELECT count(*)::int n FROM conversation_members cm JOIN conversations c ON c.id=cm.conversation_id WHERE cm.user_id=$1 AND c.type='channel'",[uid]),
      q("SELECT count(*)::int n FROM messages WHERE sender_id=$1 AND deleted=false AND file_url<>''",[uid]),
      q("SELECT count(*)::int n FROM conversation_members a JOIN conversations c ON c.id=a.conversation_id JOIN conversation_members b ON b.conversation_id=c.id AND b.user_id<>$1 WHERE a.user_id=$1 AND c.type='direct'",[uid]),
      q("SELECT COALESCE(sum(length(file_url)),0)::bigint n FROM messages WHERE sender_id=$1 AND deleted=false AND file_url<>''",[uid])
    ]);
    const first=await q('SELECT created_at FROM users WHERE id=$1',[uid]);
    res.json({messages:Number(msgs.rows[0].n),groups:Number(groups.rows[0].n),channels:Number(channels.rows[0].n),files:Number(files.rows[0].n),contacts:Number(contacts.rows[0].n),account_created_at:first.rows[0]?.created_at||null,storage_hint:Number(storage.rows[0].n)});
  }catch(e){console.error(e);res.status(500).json({error:'دریافت آمار ناموفق بود'})}
});

app.get('/api/badges', auth, async (req,res)=>{
  try{
    const uid=req.user.id;
    const r=await q(`SELECT
      (SELECT count(*) FROM messages WHERE sender_id=$1 AND deleted=false)::int messages,
      (SELECT count(*) FROM conversation_members WHERE user_id=$1)::int memberships,
      (SELECT count(*) FROM conversations WHERE owner_id=$1)::int owned_groups,
      (SELECT count(*) FROM messages WHERE sender_id=$1 AND deleted=false AND file_url<>'')::int media_count,
      (SELECT created_at FROM users WHERE id=$1) created_at`,[uid]);
    const x=r.rows[0], days=Math.floor((Date.now()-new Date(x.created_at).getTime())/86400000);
    const badges=[];
    if(Number(x.messages)>=100) badges.push({id:'active',icon:'⭐',name:'کاربر فعال',description:'حداقل ۱۰۰ پیام ارسال کرده‌ای'});
    if(days>=365) badges.push({id:'old',icon:'🏅',name:'عضو قدیمی',description:'بیش از یک سال از عضویت گذشته است'});
    if(Number(x.owned_groups)>0) badges.push({id:'creator',icon:'👑',name:'سازنده گروه',description:'حداقل یک گروه ساخته‌ای'});
    if(Number(x.media_count)>=50) badges.push({id:'creator-content',icon:'🎖️',name:'تولیدکننده محتوا',description:'حداقل ۵۰ رسانه ارسال کرده‌ای'});
    if(!badges.length) badges.push({id:'new',icon:'🌱',name:'عضو زنتو',description:'به زنتو خوش آمدی'});
    res.json(badges);
  }catch(e){console.error(e);res.status(500).json({error:'دریافت نشان‌ها ناموفق بود'})}
});

async function conversationManager(cid, uid) {
  const c = await getConversation(cid);
  if (!c || !['group','channel'].includes(c.type)) return { ok:false, error:'گفتگو پیدا نشد' };
  if (Number(c.owner_id) === Number(uid)) return { ok:true, owner:true, role:'owner', permissions:{manage:true,post:true,edit:true,delete:true,invite:true,ban:true} };
  const ar = await q('SELECT role,permissions FROM conversation_admins WHERE conversation_id=$1 AND user_id=$2',[cid,uid]);
  if (!ar.rowCount) return { ok:false, error:'فقط مالک یا ادمین دسترسی مدیریت دارد' };
  const permissions=ar.rows[0].permissions||{};
  if (permissions.manage===false) return { ok:false, error:'دسترسی مدیریت برای شما فعال نیست' };
  return { ok:true, owner:false, role:'admin', permissions };
}

app.get('/api/conversations/:id/management', auth, async (req,res)=>{
  try{
    const cid=Number(req.params.id), c=await getConversation(cid); if(!c||!await isMember(cid,req.user.id))return res.status(404).json({error:'گفتگو پیدا نشد'});
    const manager=await conversationManager(cid,req.user.id);
    const role=await q('SELECT role FROM conversation_members WHERE conversation_id=$1 AND user_id=$2',[cid,req.user.id]);
    const admins=await q(`SELECT ca.user_id,ca.role,ca.permissions,u.username,u.display_name,u.avatar FROM conversation_admins ca JOIN users u ON u.id=ca.user_id WHERE ca.conversation_id=$1 ORDER BY ca.role,u.display_name`,[cid]);
    if(!manager.ok) return res.status(403).json({error:manager.error});
    res.json({conversation:{id:Number(c.id),name:c.name,type:c.type,description:c.description,username:c.username,photo:c.photo||'',settings:c.settings||{}},role:role.rows[0]?.role||'member',owner_id:c.owner_id?Number(c.owner_id):null,admins:admins.rows.map(a=>({...a,user_id:Number(a.user_id)})),canManage:true,isOwner:!!manager.owner,permissions:manager.permissions||{}});
  }catch(e){console.error(e);res.status(500).json({error:'مدیریت گفتگو در دسترس نیست'})}
});

app.put('/api/conversations/:id/management', auth, async (req,res)=>{
  try{
    const cid=Number(req.params.id), c=await getConversation(cid); if(!c||!['group','channel'].includes(c.type))return res.status(404).json({error:'گفتگو پیدا نشد'});
    const manager=await conversationManager(cid,req.user.id);
    if(!manager.ok)return res.status(403).json({error:manager.error});
    const incoming=req.body.settings && typeof req.body.settings==='object'?req.body.settings:{};
    const allowed={slowMode:!!incoming.slowMode,onlyAdminsPost:!!incoming.onlyAdminsPost,approval:!!incoming.approval,hideMembers:!!incoming.hideMembers,comments:!!incoming.comments};
    await q('UPDATE conversations SET settings=$1,updated_at=now() WHERE id=$2',[JSON.stringify(allowed),cid]);
    res.json({settings:allowed});
  }catch(e){console.error(e);res.status(500).json({error:'ذخیره تنظیمات ناموفق بود'})}
});

app.delete('/api/conversations/:id/members/:userId', auth, async (req,res)=>{
  try {
    const cid=Number(req.params.id), target=Number(req.params.userId), c=await getConversation(cid);
    const manager=await conversationManager(cid,req.user.id);
    if(!manager.ok)return res.status(403).json({error:manager.error});
    if(target===Number(c.owner_id))return res.status(400).json({error:'مالک را نمی‌توان حذف کرد'});
    if(target===Number(req.user.id))return res.status(400).json({error:'برای خروج از گفتگو از گزینه خروج استفاده کنید'});
    await q('DELETE FROM conversation_members WHERE conversation_id=$1 AND user_id=$2',[cid,target]);
    await q('DELETE FROM conversation_admins WHERE conversation_id=$1 AND user_id=$2',[cid,target]);
    io.to('conv:'+cid).emit('member_removed',{conversationId:cid,userId:target});
    res.json({ok:true});
  } catch(e){console.error(e);res.status(500).json({error:'حذف عضو ناموفق بود'})}
});

app.post('/api/conversations/:id/admins', auth, async (req,res)=>{
  try{
    const cid=Number(req.params.id), target=Number(req.body.userId), c=await getConversation(cid);
    if(!c||!['group','channel'].includes(c.type)||Number(c.owner_id)!==Number(req.user.id))return res.status(403).json({error:'فقط مالک می‌تواند ادمین اضافه کند'});
    if(!await isMember(cid,target))return res.status(400).json({error:'کاربر عضو گفتگو نیست'});
    const permissions=typeof req.body.permissions==='object'?req.body.permissions:{};
    await q(`INSERT INTO conversation_admins(conversation_id,user_id,role,permissions) VALUES($1,$2,'admin',$3) ON CONFLICT(conversation_id,user_id) DO UPDATE SET permissions=EXCLUDED.permissions,role='admin'`,[cid,target,JSON.stringify(permissions)]);
    await q("UPDATE conversation_members SET role='admin' WHERE conversation_id=$1 AND user_id=$2",[cid,target]);
    io.to('conv:'+cid).emit('admin_changed',{conversationId:cid,userId:target}); res.json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:'افزودن ادمین ناموفق بود'})}
});
app.delete('/api/conversations/:id/admins/:userId', auth, async (req,res)=>{
  try{const cid=Number(req.params.id),target=Number(req.params.userId),c=await getConversation(cid);if(!c||Number(c.owner_id)!==Number(req.user.id))return res.status(403).json({error:'فقط مالک می‌تواند ادمین را حذف کند'});await q('DELETE FROM conversation_admins WHERE conversation_id=$1 AND user_id=$2',[cid,target]);await q("UPDATE conversation_members SET role='member' WHERE conversation_id=$1 AND user_id=$2",[cid,target]);io.to('conv:'+cid).emit('admin_changed',{conversationId:cid,userId:target});res.json({ok:true})}catch(e){console.error(e);res.status(500).json({error:'حذف ادمین ناموفق بود'})}
});

app.get('/api/notifications/summary', auth, async (req,res)=>{
  try{
    const r=await q(`SELECT c.id,c.name,c.type,count(m.id)::int count,max(m.created_at) last_at
      FROM conversations c JOIN conversation_members cm ON cm.conversation_id=c.id AND cm.user_id=$1
      JOIN messages m ON m.conversation_id=c.id AND m.sender_id<>$1 AND m.deleted=false AND m.created_at>cm.last_read_at
      GROUP BY c.id,c.name,c.type ORDER BY max(m.created_at) DESC LIMIT 20`,[req.user.id]);
    res.json(r.rows.map(x=>({...x,id:Number(x.id)})));
  }catch(e){res.status(500).json({error:'اعلان‌ها در دسترس نیستند'})}
});

// ---- Zento Stage 4: Bot API + BotFather ----
function makeBotToken(){return 'znt_bot_'+crypto.randomBytes(28).toString('base64url');}
function botApiBase(req){return `${req.protocol}://${req.get('host')}`;}

async function getBotForOwner(id,uid){
  const r=await q('SELECT * FROM bots WHERE id=$1 AND owner_id=$2',[Number(id),Number(uid)]);
  return r.rows[0]||null;
}

async function ensureBotUser(bot){
  if(bot.bot_user_id){const u=await q('SELECT id FROM users WHERE id=$1',[Number(bot.bot_user_id)]);if(u.rowCount)return Number(bot.bot_user_id);}
  const email=`bot_${bot.id}@bots.zento.local`;
  const pass=await bcrypt.hash(crypto.randomBytes(32).toString('hex'),10);
  const r=await q(`INSERT INTO users(username,email,password_hash,display_name,avatar,bio)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(username) DO UPDATE SET display_name=EXCLUDED.display_name,avatar=EXCLUDED.avatar,bio=EXCLUDED.bio RETURNING id`,
    [bot.username,email,pass,bot.name,bot.avatar||'',bot.description||'']);
  await q('UPDATE bots SET bot_user_id=$1 WHERE id=$2',[Number(r.rows[0].id),Number(bot.id)]);
  return Number(r.rows[0].id);
}

app.get('/api/bots', auth, async (req,res)=>{
  try{const r=await q(`SELECT id,username,name,description,avatar,webhook_url,token,bot_user_id,created_at FROM bots WHERE owner_id=$1 ORDER BY id DESC`,[req.user.id]);
    for(const b of r.rows) if(!b.bot_user_id) await ensureBotUser(b);
    const fresh=await q(`SELECT id,username,name,description,avatar,webhook_url,token,bot_user_id,created_at FROM bots WHERE owner_id=$1 ORDER BY id DESC`,[req.user.id]);
    res.json(fresh.rows.map(x=>({...x,id:Number(x.id),bot_user_id:x.bot_user_id?Number(x.bot_user_id):null})));
  }catch(e){console.error(e);res.status(500).json({error:'دریافت ربات‌ها ناموفق بود'})}
});

app.post('/api/bots', auth, async (req,res)=>{
  try{
    const name=String(req.body.name||'').trim().slice(0,60);
    const username=String(req.body.username||'').replace(/^@/,'').trim().toLowerCase().replace(/[^a-z0-9_]/g,'').slice(0,32);
    const description=String(req.body.description||'').trim().slice(0,300);
    const webhook=String(req.body.webhookUrl||'').trim().slice(0,500);
    if(!name||!/^([a-z0-9_]{5,29})bot$/.test(username))return res.status(400).json({error:'نام و username معتبر لازم است؛ username باید به bot ختم شود'});
    if((await q('SELECT 1 FROM bots WHERE lower(username)=lower($1)',[username])).rowCount)return res.status(409).json({error:'این شناسه ربات قبلاً استفاده شده است'});
    if((await q('SELECT 1 FROM users WHERE lower(username)=lower($1)',[username])).rowCount)return res.status(409).json({error:'این شناسه قبلاً استفاده شده است'});
    const token=makeBotToken();
    const r=await q('INSERT INTO bots(owner_id,username,name,description,webhook_url,token) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[req.user.id,username,name,description,webhook,token]);
    const bot=r.rows[0], botUserId=await ensureBotUser(bot);
    res.json({...bot,id:Number(bot.id),bot_user_id:botUserId});
  }catch(e){console.error(e);res.status(500).json({error:'ساخت ربات ناموفق بود'})}
});

app.patch('/api/bots/:id', auth, async (req,res)=>{
  try{
    const bot=await getBotForOwner(req.params.id,req.user.id); if(!bot)return res.status(404).json({error:'ربات پیدا نشد'});
    const name=String(req.body.name??bot.name).trim().slice(0,60);
    const description=String(req.body.description??bot.description).trim().slice(0,300);
    const avatar=String(req.body.avatar??bot.avatar??'').trim().slice(0,1000);
    const webhook=String(req.body.webhookUrl??bot.webhook_url??'').trim().slice(0,500);
    if(!name)return res.status(400).json({error:'نام ربات نمی‌تواند خالی باشد'});
    const r=await q(`UPDATE bots SET name=$1,description=$2,avatar=$3,webhook_url=$4 WHERE id=$5 AND owner_id=$6 RETURNING *`,[name,description,avatar,webhook,bot.id,req.user.id]);
    const updated=r.rows[0], uid=await ensureBotUser(updated);
    await q('UPDATE users SET display_name=$1,avatar=$2,bio=$3,updated_at=now() WHERE id=$4',[name,avatar,description,uid]);
    res.json({...updated,id:Number(updated.id),bot_user_id:uid});
  }catch(e){console.error(e);res.status(500).json({error:'ذخیره تنظیمات ربات ناموفق بود'})}
});

app.delete('/api/bots/:id', auth, async (req,res)=>{
  const bot=await getBotForOwner(req.params.id,req.user.id);if(!bot)return res.status(404).json({error:'ربات پیدا نشد'});
  await q('DELETE FROM bots WHERE id=$1 AND owner_id=$2',[Number(req.params.id),req.user.id]);res.json({ok:true});
});

// Bot-to-group/channel management: the bot owner can explicitly add the bot to
// any group/channel where the owner has management rights, then control the bot's
// posting/reading/admin permissions independently from the owner's account.
app.get('/api/bots/:id/chats', auth, async (req,res)=>{
  try{
    const bot=await getBotForOwner(req.params.id,req.user.id);
    if(!bot)return res.status(404).json({error:'ربات پیدا نشد'});
    if(!bot.bot_user_id) bot.bot_user_id=await ensureBotUser(bot);
    const r=await q(`SELECT c.id,c.name,c.type,c.username,c.description,c.owner_id,
      EXISTS(SELECT 1 FROM conversation_members bm WHERE bm.conversation_id=c.id AND bm.user_id=$2) AS bot_member,
      COALESCE(bcs.can_post,true) AS can_post,COALESCE(bcs.can_read,true) AS can_read,COALESCE(bcs.can_manage,false) AS can_manage
      FROM conversations c
      JOIN conversation_members cm ON cm.conversation_id=c.id AND cm.user_id=$1
      LEFT JOIN bot_chat_settings bcs ON bcs.conversation_id=c.id AND bcs.bot_id=$3
      WHERE c.type IN ('group','channel')
        AND (c.owner_id=$1 OR EXISTS(SELECT 1 FROM conversation_admins ca WHERE ca.conversation_id=c.id AND ca.user_id=$1 AND COALESCE((ca.permissions->>'invite')::boolean,true)))
      ORDER BY c.updated_at DESC,c.id DESC`,[req.user.id,Number(bot.bot_user_id),Number(bot.id)]);
    res.json(r.rows.map(x=>({...x,id:Number(x.id),owner_id:x.owner_id?Number(x.owner_id):null,bot_member:!!x.bot_member,can_post:!!x.can_post,can_read:!!x.can_read,can_manage:!!x.can_manage})));
  }catch(e){console.error('bot chats',e);res.status(500).json({error:'دریافت گفتگوهای ربات ناموفق بود'})}
});

app.post('/api/bots/:id/chats/:cid', auth, async (req,res)=>{
  try{
    const bot=await getBotForOwner(req.params.id,req.user.id);
    const cid=Number(req.params.cid);
    const c=await getConversation(cid);
    if(!bot||!c||!['group','channel'].includes(c.type))return res.status(404).json({error:'ربات یا گفتگو پیدا نشد'});
    const manager=await conversationManager(cid,req.user.id);
    if(!manager.ok || (manager.permissions?.invite===false && !manager.owner))return res.status(403).json({error:'اجازه افزودن ربات به این گفتگو را ندارید'});
    if(!bot.bot_user_id)bot.bot_user_id=await ensureBotUser(bot);
    if(!bot.can_join_groups && c.type==='group')return res.status(403).json({error:'این ربات اجازه ورود به گروه‌ها را ندارد'});
    await q("INSERT INTO conversation_members(conversation_id,user_id,role) VALUES($1,$2,'member') ON CONFLICT DO NOTHING",[cid,Number(bot.bot_user_id)]);
    const canPost=req.body.canPost!==false,canRead=req.body.canRead!==false,canManage=!!req.body.canManage;
    await q(`INSERT INTO bot_chat_settings(bot_id,conversation_id,can_post,can_read,can_manage) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(bot_id,conversation_id) DO UPDATE SET can_post=EXCLUDED.can_post,can_read=EXCLUDED.can_read,can_manage=EXCLUDED.can_manage`,[bot.id,cid,canPost,canRead,canManage]);
    if(canManage){await q(`INSERT INTO conversation_admins(conversation_id,user_id,role,permissions) VALUES($1,$2,'admin',$3) ON CONFLICT(conversation_id,user_id) DO UPDATE SET role='admin',permissions=EXCLUDED.permissions`,[cid,Number(bot.bot_user_id),JSON.stringify({manage:true,post:true,edit:true,delete:true,invite:true,ban:true})]);await q("UPDATE conversation_members SET role='admin' WHERE conversation_id=$1 AND user_id=$2",[cid,Number(bot.bot_user_id)]);}
    io.to('conv:'+cid).emit('member_added',{conversationId:cid,userId:Number(bot.bot_user_id),isBot:true});
    res.json({ok:true,conversationId:cid,bot_user_id:Number(bot.bot_user_id),can_post:canPost,can_read:canRead,can_manage:canManage});
  }catch(e){console.error('bot add chat',e);res.status(500).json({error:'افزودن ربات ناموفق بود'})}
});

app.patch('/api/bots/:id/chats/:cid', auth, async (req,res)=>{
  try{
    const bot=await getBotForOwner(req.params.id,req.user.id),cid=Number(req.params.cid);
    const c=await getConversation(cid); if(!bot||!c)return res.status(404).json({error:'پیدا نشد'});
    const manager=await conversationManager(cid,req.user.id);if(!manager.ok)return res.status(403).json({error:manager.error});
    const canPost=req.body.canPost!==false,canRead=req.body.canRead!==false,canManage=!!req.body.canManage;
    await q(`INSERT INTO bot_chat_settings(bot_id,conversation_id,can_post,can_read,can_manage) VALUES($1,$2,$3,$4,$5) ON CONFLICT(bot_id,conversation_id) DO UPDATE SET can_post=EXCLUDED.can_post,can_read=EXCLUDED.can_read,can_manage=EXCLUDED.can_manage`,[bot.id,cid,canPost,canRead,canManage]);
    if(bot.bot_user_id){if(canManage){await q(`INSERT INTO conversation_admins(conversation_id,user_id,role,permissions) VALUES($1,$2,'admin',$3) ON CONFLICT(conversation_id,user_id) DO UPDATE SET role='admin',permissions=EXCLUDED.permissions`,[cid,Number(bot.bot_user_id),JSON.stringify({manage:true,post:true,edit:true,delete:true,invite:true,ban:true})]);await q("UPDATE conversation_members SET role='admin' WHERE conversation_id=$1 AND user_id=$2",[cid,Number(bot.bot_user_id)]);}else{await q('DELETE FROM conversation_admins WHERE conversation_id=$1 AND user_id=$2',[cid,Number(bot.bot_user_id)]);await q("UPDATE conversation_members SET role='member' WHERE conversation_id=$1 AND user_id=$2",[cid,Number(bot.bot_user_id)]);}}
    res.json({ok:true,can_post:canPost,can_read:canRead,can_manage:canManage});
  }catch(e){console.error(e);res.status(500).json({error:'ذخیره دسترسی ربات ناموفق بود'})}
});

app.delete('/api/bots/:id/chats/:cid', auth, async (req,res)=>{
  try{
    const bot=await getBotForOwner(req.params.id,req.user.id),cid=Number(req.params.cid);
    const c=await getConversation(cid);if(!bot||!c)return res.status(404).json({error:'پیدا نشد'});
    const manager=await conversationManager(cid,req.user.id);if(!manager.ok)return res.status(403).json({error:manager.error});
    if(bot.bot_user_id){await q('DELETE FROM conversation_members WHERE conversation_id=$1 AND user_id=$2',[cid,Number(bot.bot_user_id)]);}
    await q('DELETE FROM bot_chat_settings WHERE bot_id=$1 AND conversation_id=$2',[bot.id,cid]);
    io.to('conv:'+cid).emit('member_removed',{conversationId:cid,userId:Number(bot.bot_user_id)});
    res.json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:'خروج ربات از گفتگو ناموفق بود'})}
});

app.get('/api/bots/:id/commands', auth, async(req,res)=>{try{const bot=await getBotForOwner(req.params.id,req.user.id);if(!bot)return res.status(404).json({error:'ربات پیدا نشد'});const r=await q('SELECT * FROM bot_commands WHERE bot_id=$1 ORDER BY command',[bot.id]);res.json(r.rows.map(x=>({...x,id:Number(x.id),bot_id:Number(x.bot_id)})))}catch(e){res.status(500).json({error:'دریافت دستورات ناموفق بود'})}});
app.post('/api/bots/:id/commands', auth, async(req,res)=>{try{const bot=await getBotForOwner(req.params.id,req.user.id);if(!bot)return res.status(404).json({error:'ربات پیدا نشد'});const command=String(req.body.command||'').trim().replace(/^\//,'').slice(0,32),response=String(req.body.response||'').trim().slice(0,4000),replyMarkup=req.body.replyMarkup&&typeof req.body.replyMarkup==='object'?req.body.replyMarkup:null;if(!/^[a-zA-Z0-9_]{1,32}$/.test(command))return res.status(400).json({error:'دستور نامعتبر است'});const r=await q('INSERT INTO bot_commands(bot_id,command,response,reply_markup) VALUES($1,$2,$3,$4) ON CONFLICT(bot_id,command) DO UPDATE SET response=EXCLUDED.response,reply_markup=EXCLUDED.reply_markup RETURNING *',[bot.id,command,response,replyMarkup?JSON.stringify(replyMarkup):null]);res.json({...r.rows[0],id:Number(r.rows[0].id)})}catch(e){console.error(e);res.status(500).json({error:'ذخیره دستور ناموفق بود'})}});
app.delete('/api/bots/:id/commands/:command', auth, async(req,res)=>{const bot=await getBotForOwner(req.params.id,req.user.id);if(!bot)return res.status(404).json({error:'ربات پیدا نشد'});await q('DELETE FROM bot_commands WHERE bot_id=$1 AND command=$2',[bot.id,String(req.params.command).replace(/^\//,'')]);res.json({ok:true})});

// Telegram-style Bot API surface. Token is the only credential required by bot code.
async function botByToken(token){const r=await q('SELECT * FROM bots WHERE token=$1 LIMIT 1',[String(token||'')]);return r.rows[0]||null;}
app.get('/api/bot/:token/getMe', async(req,res)=>{const b=await botByToken(req.params.token);if(!b)return res.status(401).json({ok:false,error_code:401,description:'Unauthorized'});res.json({ok:true,result:{id:Number(b.id),is_bot:true,first_name:b.name,username:b.username,description:b.description||''}})});
app.get('/api/bot/:token', async(req,res)=>{const b=await botByToken(req.params.token);if(!b)return res.status(404).json({error:'توکن ربات نامعتبر است'});res.json({id:Number(b.id),username:b.username,name:b.name,description:b.description,avatar:b.avatar||''})});

async function botChatMember(bot,chatId){
  const cid=Number(chatId); if(!cid)return false;
  const r=await q('SELECT 1 FROM conversation_members WHERE conversation_id=$1 AND user_id=$2',[cid,Number(bot.bot_user_id)]); return r.rowCount>0;
}
async function botChatSetting(bot,chatId){
  const r=await q('SELECT can_post,can_read,can_manage FROM bot_chat_settings WHERE bot_id=$1 AND conversation_id=$2',[Number(bot.id),Number(chatId)]);
  return r.rows[0]||{can_post:true,can_read:true,can_manage:false};
}
async function botSendMessage(bot,chatId,text,replyMarkup=null){
  if(!(await botChatMember(bot,chatId)))return {ok:false,error_code:403,description:'Bot is not a member of this chat'};
  const setting=await botChatSetting(bot,chatId);
  if(setting.can_post===false)return {ok:false,error_code:403,description:'Bot does not have permission to send messages in this chat'};
  let markup=null;
  if(replyMarkup && typeof replyMarkup==='object'){
    const clean=(rows)=>Array.isArray(rows)?rows.slice(0,8).map(row=>Array.isArray(row)?row.slice(0,4).map(b=>({text:String(b?.text||'').slice(0,80),url:b?.url?String(b.url).slice(0,500):undefined,callback_data:b?.callback_data?String(b.callback_data).slice(0,128):undefined})).filter(x=>x.text):[]).filter(r=>r.length):[];
    if(Array.isArray(replyMarkup.inline_keyboard)) markup={inline_keyboard:clean(replyMarkup.inline_keyboard)};
    else if(Array.isArray(replyMarkup.keyboard)) markup={keyboard:clean(replyMarkup.keyboard),resize_keyboard:replyMarkup.resize_keyboard!==false,one_time_keyboard:!!replyMarkup.one_time_keyboard};
    else if(replyMarkup.remove_keyboard) markup={remove_keyboard:true};
  }
  const out=await insertMessage({cid:Number(chatId),uid:Number(bot.bot_user_id),text:String(text||'').slice(0,5000),kind:'bot',botId:Number(bot.id),replyMarkup:markup});
  io.to('conv:'+Number(chatId)).emit('message',out);
  return {ok:true,result:{message_id:Number(out.id),chat:{id:Number(chatId)},from:{id:Number(bot.id),is_bot:true,first_name:bot.name,username:bot.username},text:out.text||'',reply_markup:markup}};
}

// Execute a bot command configured in the Zento Bot Manager. This keeps the
// built-in command buttons useful even when the owner is not running a webhook.
async function handleConfiguredBotCommand(cid, uid, rawText){
  const text=String(rawText||'').trim();
  if(!text.startsWith('/')) return false;
  const command=text.split(/\s+/)[0].replace(/^\//,'').replace(/@[^\s]+$/,'').toLowerCase();
  if(!command) return false;
  const cr=await q(`SELECT b.*,bc.response,bc.reply_markup
    FROM bots b
    JOIN conversation_members cm ON cm.user_id=b.bot_user_id AND cm.conversation_id=$1
    JOIN bot_commands bc ON bc.bot_id=b.id AND lower(bc.command)=lower($2)
    WHERE b.bot_user_id IS NOT NULL AND b.bot_user_id<>$3
    LIMIT 1`,[cid,command,uid]);
  if(!cr.rowCount) return false;
  const bot=cr.rows[0];
  const out=await insertMessage({cid,uid:Number(bot.bot_user_id),text:String(bot.response||'').slice(0,5000),kind:'bot',botId:Number(bot.id),replyMarkup:bot.reply_markup||null});
  io.to('conv:'+cid).emit('message',out);
  return true;
}

// Inline button callback endpoint. The bot token is deliberately not exposed
// to the browser; the message itself identifies the bot that owns the button.
app.post('/api/messages/:id/bot-button', auth, async(req,res)=>{
  try{
    const mid=Number(req.params.id), buttonIndex=Number(req.body.buttonIndex);
    const mr=await q('SELECT * FROM messages WHERE id=$1 AND deleted=false',[mid]);
    const m=mr.rows[0];
    if(!m || !m.bot_id || !await isMember(m.conversation_id,req.user.id)) return res.status(404).json({error:'دکمه پیدا نشد'});
    const markup=m.reply_markup||{};
    const rows=Array.isArray(markup.inline_keyboard)?markup.inline_keyboard:[];
    const flat=rows.flatMap((row,rowIndex)=>(Array.isArray(row)?row:[]).map((b,colIndex)=>({...b,rowIndex,colIndex})));
    const b=flat.find(x=>x.rowIndex===Math.floor(buttonIndex/100) && x.colIndex===buttonIndex%100);
    if(!b) return res.status(400).json({error:'دکمه نامعتبر است'});
    const botR=await q('SELECT * FROM bots WHERE id=$1 LIMIT 1',[Number(m.bot_id)]); const bot=botR.rows[0];
    if(!bot) return res.status(404).json({error:'ربات پیدا نشد'});
    const callbackId=crypto.randomUUID();
    const update={update_id:Number(m.id)*1000+Math.floor(Math.random()*999),callback_query:{id:callbackId,from:{id:Number(req.user.id),is_bot:false,first_name:req.user.display_name||req.user.username||'کاربر',username:req.user.username||''},message:{message_id:Number(m.id),chat:{id:Number(m.conversation_id)},from:{id:Number(bot.id),is_bot:true,first_name:bot.name,username:bot.username},text:m.text||''},data:String(b.callback_data||b.text||'').slice(0,128)}};
    await q('INSERT INTO bot_updates(bot_id,update_json) VALUES($1,$2)',[Number(bot.id),JSON.stringify(update)]);
    const webhook=String(bot.webhook_url||'').trim();
    if(webhook && /^https:\/\//i.test(webhook)){
      fetch(webhook,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(update),signal:AbortSignal.timeout(5000)}).catch(e=>console.warn('bot callback webhook failed',bot.username,e.message));
    }
    res.json({ok:true,result:true});
  }catch(e){console.error('bot button',e);res.status(500).json({error:'اجرای دکمه ربات ناموفق بود'})}
});

app.post('/api/bot/:token/answerCallbackQuery', async(req,res)=>{
  const b=await botByToken(req.params.token); if(!b)return res.status(401).json({ok:false,error_code:401,description:'Unauthorized'});
  res.json({ok:true,result:true});
});

app.get('/api/bot/:token/getChat', async(req,res)=>{
  const b=await botByToken(req.params.token);if(!b)return res.status(401).json({ok:false,error_code:401,description:'Unauthorized'});
  const cid=Number(req.query.chat_id??req.query.chatId);const c=await getConversation(cid);if(!c||!(await botChatMember(b,cid)))return res.status(400).json({ok:false,error_code:400,description:'Chat not found or bot is not a member'});
  const setting=await botChatSetting(b,cid);const members=await q('SELECT count(*)::int AS n FROM conversation_members WHERE conversation_id=$1',[cid]);
  res.json({ok:true,result:{id:cid,type:c.type,title:c.name,username:c.username||'',description:c.description||'',member_count:Number(members.rows[0]?.n||0),can_post:setting.can_post!==false,can_read:setting.can_read!==false,can_manage:!!setting.can_manage}});
});
app.get('/api/bot/:token/getChatMember', async(req,res)=>{
  const b=await botByToken(req.params.token);if(!b)return res.status(401).json({ok:false,error_code:401,description:'Unauthorized'});
  const cid=Number(req.query.chat_id??req.query.chatId),uid=Number(req.query.user_id??req.query.userId);if(!(await botChatMember(b,cid)))return res.status(403).json({ok:false,error_code:403,description:'Bot is not a member of this chat'});
  const r=await q('SELECT cm.role,u.id,u.username,u.display_name,u.avatar,(EXISTS(SELECT 1 FROM bots bx WHERE bx.bot_user_id=u.id)) AS is_bot FROM conversation_members cm JOIN users u ON u.id=cm.user_id WHERE cm.conversation_id=$1 AND cm.user_id=$2',[cid,uid]);
  if(!r.rowCount)return res.status(404).json({ok:false,error_code:404,description:'User is not a member of the chat'});const x=r.rows[0];res.json({ok:true,result:{user:{id:Number(x.id),is_bot:!!x.is_bot,first_name:x.display_name||x.username||'',username:x.username||''},status:x.role==='admin'?'administrator':'member'}});
});
app.post('/api/bot/:token/leaveChat', async(req,res)=>{
  const b=await botByToken(req.params.token);if(!b)return res.status(401).json({ok:false,error_code:401,description:'Unauthorized'});const cid=Number(req.body.chat_id??req.body.chatId);if(!cid||!(await botChatMember(b,cid)))return res.status(400).json({ok:false,error_code:400,description:'Bot is not a member of this chat'});
  await q('DELETE FROM conversation_members WHERE conversation_id=$1 AND user_id=$2',[cid,Number(b.bot_user_id)]);await q('DELETE FROM bot_chat_settings WHERE bot_id=$1 AND conversation_id=$2',[b.id,cid]);io.to('conv:'+cid).emit('member_removed',{conversationId:cid,userId:Number(b.bot_user_id)});res.json({ok:true,result:true});
});
app.get('/api/bot/:token/getMyCommands', async(req,res)=>{const b=await botByToken(req.params.token);if(!b)return res.status(401).json({ok:false,error_code:401,description:'Unauthorized'});const r=await q('SELECT command,response FROM bot_commands WHERE bot_id=$1 ORDER BY command',[b.id]);res.json({ok:true,result:r.rows.map(x=>({command:x.command,description:String(x.response||'').split(/\n/)[0].slice(0,256)}))})});
app.post('/api/bot/:token/setMyCommands', async(req,res)=>{try{const b=await botByToken(req.params.token);if(!b)return res.status(401).json({ok:false,error_code:401,description:'Unauthorized'});const cmds=Array.isArray(req.body.commands)?req.body.commands.slice(0,100):[];for(const c of cmds){const command=String(c?.command||'').replace(/^\//,'').trim();const description=String(c?.description||'').trim().slice(0,256);if(!/^[a-zA-Z0-9_]{1,32}$/.test(command))continue;await q("INSERT INTO bot_commands(bot_id,command,response) VALUES($1,$2,$3) ON CONFLICT(bot_id,command) DO UPDATE SET response=CASE WHEN bot_commands.response='' THEN EXCLUDED.response ELSE bot_commands.response END",[b.id,command,description])}res.json({ok:true,result:true})}catch(e){console.error(e);res.status(500).json({ok:false,error_code:500,description:'Failed to set commands'})}});
app.post('/api/bot/:token/deleteMyCommands', async(req,res)=>{const b=await botByToken(req.params.token);if(!b)return res.status(401).json({ok:false,error_code:401,description:'Unauthorized'});await q('DELETE FROM bot_commands WHERE bot_id=$1',[b.id]);res.json({ok:true,result:true})});

app.post('/api/bot/:token/sendMessage', async(req,res)=>{try{const b=await botByToken(req.params.token);if(!b)return res.status(401).json({ok:false,error_code:401,description:'Unauthorized'});if(!b.bot_user_id)b.bot_user_id=await ensureBotUser(b);const chatId=Number(req.body.chat_id??req.body.conversationId),text=String(req.body.text||'').trim(),replyMarkup=req.body.reply_markup||req.body.replyMarkup||null;if(!chatId||!text)return res.status(400).json({ok:false,error_code:400,description:'chat_id and text are required'});res.json(await botSendMessage(b,chatId,text,replyMarkup));}catch(e){console.error(e);res.status(500).json({ok:false,error_code:500,description:'Internal server error'})}});
app.post('/api/bot/:token/send', async(req,res)=>{try{const b=await botByToken(req.params.token);if(!b)return res.status(401).json({error:'توکن ربات نامعتبر است'});if(!b.bot_user_id)b.bot_user_id=await ensureBotUser(b);const chatId=Number(req.body.conversationId??req.body.chat_id),text=String(req.body.text||'').trim(),replyMarkup=req.body.reply_markup||req.body.replyMarkup||null;if(!chatId||!text)return res.status(400).json({error:'conversationId/chat_id و text لازم است'});const result=await botSendMessage(b,chatId,text,replyMarkup);if(!result.ok)return res.status(result.error_code||403).json({error:result.description});res.json(result.result)}catch(e){console.error(e);res.status(500).json({error:'ارسال پیام ربات ناموفق بود'})}});

app.post('/api/bot/:token/setWebhook', async(req,res)=>{const b=await botByToken(req.params.token);if(!b)return res.status(401).json({ok:false,error_code:401,description:'Unauthorized'});const url=String(req.body.url||'').trim();if(url&&!/^https:\/\//i.test(url))return res.status(400).json({ok:false,error_code:400,description:'Webhook URL must use HTTPS'});await q('UPDATE bots SET webhook_url=$1 WHERE id=$2',[url,b.id]);res.json({ok:true,result:true})});
app.get('/api/bot/:token/getWebhookInfo', async(req,res)=>{const b=await botByToken(req.params.token);if(!b)return res.status(401).json({ok:false,error_code:401,description:'Unauthorized'});res.json({ok:true,result:{url:b.webhook_url||'',pending_update_count:0}})});
app.get('/api/bot/:token/getUpdates', async(req,res)=>{const b=await botByToken(req.params.token);if(!b)return res.status(401).json({ok:false,error_code:401,description:'Unauthorized'});const limit=Math.min(100,Math.max(1,Number(req.query.limit)||50));const r=await q('SELECT id,update_json FROM bot_updates WHERE bot_id=$1 AND consumed=false ORDER BY id LIMIT $2',[b.id,limit]);if(r.rowCount){await q('UPDATE bot_updates SET consumed=true WHERE id=ANY($1::bigint[])',[r.rows.map(x=>x.id)])}res.json({ok:true,result:r.rows.map(x=>x.update_json)})});
app.post('/api/bot/:token/deleteWebhook', async(req,res)=>{const b=await botByToken(req.params.token);if(!b)return res.status(401).json({ok:false,error_code:401,description:'Unauthorized'});await q('UPDATE bots SET webhook_url=\'\' WHERE id=$1',[b.id]);res.json({ok:true,result:true})});

// Backwards-compatible command automation endpoint.
app.post('/api/bot/:token/commands', async(req,res)=>{try{const b=await botByToken(req.params.token);if(!b)return res.status(401).json({error:'توکن ربات نامعتبر است'});const command=String(req.body.command||'').replace(/^\//,'').trim();const r=await q('SELECT response FROM bot_commands WHERE bot_id=$1 AND command=$2',[b.id,command]);res.json({ok:true,found:!!r.rowCount,response:r.rows[0]?.response||''})}catch(e){res.status(500).json({error:'دریافت پاسخ دستور ناموفق بود'})}});

app.post('/api/ai/chat', auth, async(req,res)=>{
  try{
    const endpoint=String(process.env.ZENTO_AI_ENDPOINT||process.env.GISH_AI_ENDPOINT||'').trim(), key=String(process.env.ZENTO_AI_KEY||process.env.GISH_AI_KEY||'').trim(), model=String(process.env.AI_MODEL||'').trim()||'gpt-4o-mini';
    if(!endpoint||!key)return res.status(503).json({error:'AI هنوز روی سرور فعال نشده است؛ متغیرهای AI_API_URL و AI_API_KEY و AI_MODEL را در Railway تنظیم کن.'});
    const prompt=String(req.body.prompt||'').trim().slice(0,12000);if(!prompt)return res.status(400).json({error:'متن سؤال خالی است'});
    const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},body:JSON.stringify({model,messages:[{role:'system',content:'You are the built-in assistant for Zento messenger. Answer clearly and safely. The user language is Persian unless another language is requested.'},{role:'user',content:prompt}],temperature:.4})});
    const data=await r.json().catch(()=>({}));if(!r.ok)return res.status(502).json({error:data?.error?.message||'سرویس AI پاسخ نداد'});
    const text=data?.choices?.[0]?.message?.content||data?.output_text||'';res.json({text:String(text)});
  }catch(e){console.error('AI',e);res.status(502).json({error:'ارتباط با AI ناموفق بود'})}
});

const activeGames=new Map();
function gameKey(cid){return 'chat:'+Number(cid)}
app.post('/api/games/start', auth, async(req,res)=>{const cid=Number(req.body.conversationId);if(!cid||!await isMember(cid,req.user.id))return res.status(403).json({error:'دسترسی ندارید'});const key=gameKey(cid);const existing=activeGames.get(key);if(existing)return res.json(existing);const g={id:crypto.randomUUID(),conversationId:cid,players:[Number(req.user.id)],turn:Number(req.user.id),board:Array(9).fill(''),winner:null};activeGames.set(key,g);io.to('conv:'+cid).emit('game:invite',g);res.json(g)});
app.get('/api/games/:conversationId', auth, async(req,res)=>{const cid=Number(req.params.conversationId);if(!await isMember(cid,req.user.id))return res.status(403).json({error:'دسترسی ندارید'});res.json(activeGames.get(gameKey(cid))||null)});

// ---- Replace the generic socket connection with Stage 4 sync/game hooks ----

app.use('/api',(req,res)=>res.status(404).json({error:'API endpoint not found'}));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));


async function ensureStage1Schema(){
  await q(`CREATE TABLE IF NOT EXISTS user_preferences (
    user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    theme JSONB NOT NULL DEFAULT '{}'::jsonb,
    settings JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await q(`ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb`);
  await q(`CREATE TABLE IF NOT EXISTS chat_folders (
    id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL, icon TEXT NOT NULL DEFAULT '📁', position INT NOT NULL DEFAULT 0,
    UNIQUE(user_id,name)
  )`);
  await q(`CREATE TABLE IF NOT EXISTS chat_folder_members (
    folder_id BIGINT NOT NULL REFERENCES chat_folders(id) ON DELETE CASCADE,
    conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    PRIMARY KEY(folder_id,conversation_id)
  )`);
  await q(`CREATE TABLE IF NOT EXISTS chat_locks (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    pin_hash TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(user_id,conversation_id)
  )`);
  await q(`CREATE TABLE IF NOT EXISTS user_profiles (
    id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL, username TEXT NOT NULL, avatar TEXT NOT NULL DEFAULT '', bio TEXT NOT NULL DEFAULT '',
    is_default BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id,username)
  )`);
  await q(`CREATE TABLE IF NOT EXISTS profile_media (
    id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('photo','song')), url TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
    mime TEXT NOT NULL DEFAULT '', size BIGINT NOT NULL DEFAULT 0, position INT NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await q(`CREATE INDEX IF NOT EXISTS idx_profile_media_user_kind ON profile_media(user_id,kind,position,id)`);
  await q(`CREATE TABLE IF NOT EXISTS conversation_profiles (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    profile_id BIGINT NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    PRIMARY KEY(user_id,conversation_id)
  )`);
  await q(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS profile_id BIGINT REFERENCES user_profiles(id) ON DELETE SET NULL`);
  await q(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`);
  await q(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS quote_ids JSONB NOT NULL DEFAULT '[]'::jsonb`);
  await q(`ALTER TABLE conversation_members ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMPTZ NOT NULL DEFAULT now()`);
  await q(`CREATE TABLE IF NOT EXISTS message_receipts (message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, delivered_at TIMESTAMPTZ, read_at TIMESTAMPTZ, PRIMARY KEY(message_id,user_id))`);
  await q(`CREATE TABLE IF NOT EXISTS message_hidden (message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, hidden_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(message_id,user_id))`);
  await q(`CREATE TABLE IF NOT EXISTS support_requests (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, subject TEXT NOT NULL DEFAULT '', message TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
}


async function ensureStage3Schema(){
  await q(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb`);
  await q(`CREATE TABLE IF NOT EXISTS conversation_admins (
    conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'admin',
    permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(conversation_id,user_id)
  )`);
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS conversations_public_username_uq ON conversations(username) WHERE username IS NOT NULL AND username <> ''`);
  await q(`CREATE INDEX IF NOT EXISTS messages_sender_idx ON messages(sender_id,id DESC)`);
  await q(`CREATE INDEX IF NOT EXISTS messages_file_idx ON messages(conversation_id,kind,id DESC)`);
}

async function ensureBotFather(){
  // System account used by the built-in @BotFather assistant.
  const existing=await q("SELECT id,username,display_name,avatar,bio FROM users WHERE lower(username)=lower('BotFather') LIMIT 1");
  if(existing.rowCount) return Number(existing.rows[0].id);
  const passwordHash=await bcrypt.hash(crypto.randomBytes(32).toString('hex'),10);
  const r=await q(`INSERT INTO users(username,email,password_hash,display_name,bio)
    VALUES('BotFather','botfather@zento.local',$1,'BotFather','مدیریت و ساخت ربات‌های زنتو')
    ON CONFLICT(username) DO UPDATE SET display_name='BotFather',bio='مدیریت و ساخت ربات‌های زنتو'
    RETURNING id`,[passwordHash]);
  return Number(r.rows[0].id);
}

async function ensureBotFatherSchema(){
  await q(`CREATE TABLE IF NOT EXISTS botfather_sessions(
    user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    step TEXT NOT NULL DEFAULT 'idle',
    pending_name TEXT NOT NULL DEFAULT '',
    pending_username TEXT NOT NULL DEFAULT '',
    pending_bot_id BIGINT REFERENCES bots(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await q(`CREATE INDEX IF NOT EXISTS botfather_sessions_updated_idx ON botfather_sessions(updated_at)`);
}

async function getBotFatherUser(){
  const r=await q("SELECT id,username,email,display_name,avatar,bio FROM users WHERE lower(username)=lower('BotFather') LIMIT 1");
  return r.rows[0]||null;
}

async function ensureDirectConversation(userA,userB){
  const existing=await q(`SELECT c.* FROM conversations c
    JOIN conversation_members a ON a.conversation_id=c.id AND a.user_id=$1
    JOIN conversation_members b ON b.conversation_id=c.id AND b.user_id=$2
    WHERE c.type='direct' AND (SELECT count(*) FROM conversation_members x WHERE x.conversation_id=c.id)=2 LIMIT 1`,[userA,userB]);
  if(existing.rowCount) return existing.rows[0];
  const cr=await q(`INSERT INTO conversations(name,type) VALUES('گفتگو','direct') RETURNING *`);
  const c=cr.rows[0];
  await q('INSERT INTO conversation_members(conversation_id,user_id) VALUES($1,$2),($1,$3)',[c.id,userA,userB]);
  return c;
}

function botToken(){
  return `${crypto.randomInt(100000000,999999999)}:${crypto.randomBytes(24).toString('base64url')}`;
}

async function sendBotFatherReply(cid, text){
  const bf=await getBotFatherUser();
  if(!bf) return null;
  const member=await q('SELECT 1 FROM conversation_members WHERE conversation_id=$1 AND user_id=$2',[Number(cid),Number(bf.id)]);
  if(!member.rowCount){
    await q('INSERT INTO conversation_members(conversation_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[Number(cid),Number(bf.id)]);
  }
  const out=await insertMessage({cid,uid:Number(bf.id),text,kind:'bot'});
  io.to('conv:'+cid).emit('message',out);
  return out;
}

async function isBotFatherConversation(cid){
  const bf=await getBotFatherUser();
  if(!bf) return false;
  const r=await q('SELECT 1 FROM conversation_members WHERE conversation_id=$1 AND user_id=$2',[cid,Number(bf.id)]);
  return r.rowCount>0;
}

async function handleBotFatherCommand(cid, uid, rawText){
  const bf=await getBotFatherUser();
  if(!bf || Number(uid)===Number(bf.id)) return false;
  const member=await q(`SELECT 1 FROM conversation_members WHERE conversation_id=$1 AND user_id=$2 AND EXISTS(
    SELECT 1 FROM conversation_members x WHERE x.conversation_id=$1 AND x.user_id=$3)`,[cid,uid,Number(bf.id)]);
  if(!member.rowCount) return false;
  const text=String(rawText||'').trim();
  const sr=await q('SELECT * FROM botfather_sessions WHERE user_id=$1',[uid]);
  let session=sr.rows[0]||{step:'idle',pending_name:'',pending_username:'',pending_bot_id:null};
  const command=text.startsWith('/')?text.split(/\s+/)[0].toLowerCase().replace(/@botfather$/,''):'';

  const help=`🤖 BotFather زنتو\n\nدستورهای اصلی:\n/newbot — ساخت ربات جدید\n/mybots — ربات‌های شما\n/help — راهنما\n/cancel — لغو عملیات فعلی\n/setname — تغییر نام ربات\n/setdescription — تغییر توضیحات ربات\n/setabouttext — متن درباره ربات\n/setphoto — تغییر عکس پروفایل ربات\n/setcommands — مدیریت منوی دستورات\n/token — دریافت توکن API\n/revoke — تعویض توکن API\n/setprivacy — حالت Privacy گروه\n/setinline — فعال/غیرفعال کردن Inline\n/setjoingroups — اجازه ورود به گروه‌ها\n/deletebot — حذف ربات\n/settings — تنظیمات ربات‌ها\n\nربات‌ها را می‌توانی از پنل «ربات‌ها» به گروه و کانال اضافه کنی و دسترسی ارسال/خواندن/مدیریت را جداگانه تنظیم کنی.`;
  if(command==='/help' || command==='/start'){
    await q(`INSERT INTO botfather_sessions(user_id,step) VALUES($1,'idle') ON CONFLICT(user_id) DO UPDATE SET step='idle',pending_name='',pending_username='',pending_bot_id=NULL,updated_at=now()`,[uid]);
    await sendBotFatherReply(cid,help); return true;
  }
  if(command==='/cancel'){
    await q(`INSERT INTO botfather_sessions(user_id,step) VALUES($1,'idle') ON CONFLICT(user_id) DO UPDATE SET step='idle',pending_name='',pending_username='',pending_bot_id=NULL,updated_at=now()`,[uid]);
    await sendBotFatherReply(cid,'لغو شد. هر وقت خواستی برای ساخت ربات /newbot را بفرست.'); return true;
  }
  if(command==='/mybots'){
    const r=await q('SELECT name,username,description,created_at FROM bots WHERE owner_id=$1 ORDER BY id DESC',[uid]);
    if(!r.rowCount){await sendBotFatherReply(cid,'هنوز رباتی نداری. برای ساخت اولین ربات /newbot را بفرست.');return true;}
    const list=r.rows.map((b,i)=>`${i+1}. 🤖 ${b.name}\n   @${b.username}\n   ${b.description||'بدون توضیحات'}`).join('\n\n');
    await sendBotFatherReply(cid,`🤖 ربات‌های شما:\n\n${list}\n\nبرای ساخت ربات جدید /newbot را بفرست.`); return true;
  }
  if(command==='/newbot'){
    await q(`INSERT INTO botfather_sessions(user_id,step,pending_name,pending_username,pending_bot_id) VALUES($1,'name','','',NULL)
      ON CONFLICT(user_id) DO UPDATE SET step='name',pending_name='',pending_username='',pending_bot_id=NULL,updated_at=now()`,[uid]);
    await sendBotFatherReply(cid,'عالیه! اول یک نام برای ربات بفرست.\n\nمثال: My Zento Bot'); return true;
  }
  if(session.step==='name' && !text.startsWith('/')){
    const name=text.slice(0,64);
    if(name.length<2){await sendBotFatherReply(cid,'نام ربات خیلی کوتاه است. دوباره یک نام بفرست.');return true;}
    await q(`UPDATE botfather_sessions SET step='username',pending_name=$2,updated_at=now() WHERE user_id=$1`,[uid,name]);
    await sendBotFatherReply(cid,'حالا یک username بفرست که به @ ختم می‌شود و باید به bot ختم شود.\n\nمثال: MyZentoBot یا my_zento_bot'); return true;
  }
  if(session.step==='username' && !text.startsWith('/')){
    const username=text.replace(/^@/,'').trim().toLowerCase();
    if(!/^[a-z0-9_]{5,32}bot$/.test(username)){await sendBotFatherReply(cid,'username نامعتبر است. فقط حروف انگلیسی، عدد و _ مجاز است و باید با bot تمام شود.');return true;}
    const dupe=await q('SELECT 1 FROM bots WHERE lower(username)=lower($1)',[username]);
    if(dupe.rowCount){await sendBotFatherReply(cid,'این username قبلاً استفاده شده است. یک username دیگر انتخاب کن.');return true;}
    const r=await q(`INSERT INTO bots(owner_id,username,name,description,webhook_url,token) VALUES($1,$2,$3,'','',$4) RETURNING *`,[uid,username,session.pending_name,botToken()]);
    const botUserId=await ensureBotUser(r.rows[0]);
    await q(`UPDATE botfather_sessions SET step='idle',pending_name='',pending_username='',pending_bot_id=$2,updated_at=now() WHERE user_id=$1`,[uid,Number(r.rows[0].id)]);
    await sendBotFatherReply(cid,`🎉 ربات با موفقیت ساخته شد!\n\nنام: ${r.rows[0].name}\nشناسه: @${r.rows[0].username}\n\n🔐 توکن API:\n${r.rows[0].token}\n\nاین توکن را محرمانه نگه دار.\n\nبرای ارسال پیام از API زنتو استفاده کن:\nPOST /api/bot/<TOKEN>/send`); return true;
  }
  if(command==='/token' || command==='/revoke'){
    const tokenStep=command==='/revoke'?'revoke_bot':'token_bot'; await q(`INSERT INTO botfather_sessions(user_id,step) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET step=$2,updated_at=now()`,[uid,tokenStep]);
    await sendBotFatherReply(cid,command==='/revoke'?'username ربات را بفرست تا توکن جدید برایش بسازم.':'username ربات را بفرست تا توکن API آن را نمایش بدهم.'); return true;
  }
  if(['token_bot','revoke_bot'].includes(session.step) && !text.startsWith('/')){
    const username=text.replace(/^@/,'').trim().toLowerCase();const r=await q('SELECT * FROM bots WHERE owner_id=$1 AND lower(username)=lower($2)',[uid,username]);
    if(!r.rowCount){await sendBotFatherReply(cid,'رباتی با این username در حساب شما پیدا نشد.');return true;}
    const bot=r.rows[0];
    if(session.step==='revoke_bot'){const token=makeBotToken();await q('UPDATE bots SET token=$1 WHERE id=$2',[token,bot.id]);await sendBotFatherReply(cid,`🔐 توکن ربات @${bot.username} تعویض شد.\n\n${token}`)}else await sendBotFatherReply(cid,`🔐 توکن API ربات @${bot.username}:\n\n${bot.token}`);
    await q(`UPDATE botfather_sessions SET step='idle',pending_bot_id=NULL,updated_at=now() WHERE user_id=$1`,[uid]);return true;
  }
  if(command==='/setabouttext'){
    await q(`INSERT INTO botfather_sessions(user_id,step) VALUES($1,'setabout_bot') ON CONFLICT(user_id) DO UPDATE SET step='setabout_bot',updated_at=now()`,[uid]);
    await sendBotFatherReply(cid,'username ربات را بفرست، مثلاً @my_zento_bot');return true;
  }
  if(session.step==='setabout_bot' && !text.startsWith('/')){
    const username=text.replace(/^@/,'').trim().toLowerCase();const r=await q('SELECT id FROM bots WHERE owner_id=$1 AND lower(username)=lower($2)',[uid,username]);
    if(!r.rowCount){await sendBotFatherReply(cid,'ربات پیدا نشد.');return true;}await q(`UPDATE botfather_sessions SET step='setabout_text',pending_bot_id=$2,updated_at=now() WHERE user_id=$1`,[uid,Number(r.rows[0].id)]);await sendBotFatherReply(cid,'متن About جدید را بفرست.');return true;
  }
  if(session.step==='setabout_text' && !text.startsWith('/')){await q('UPDATE bots SET about_text=$1 WHERE id=$2 AND owner_id=$3',[text.slice(0,120),session.pending_bot_id,uid]);await q(`UPDATE botfather_sessions SET step='idle',pending_bot_id=NULL,updated_at=now() WHERE user_id=$1`,[uid]);await sendBotFatherReply(cid,'متن About با موفقیت تغییر کرد.');return true;}
  if(command==='/setprivacy' || command==='/setinline' || command==='/setjoingroups'){
    const step=command==='/setprivacy'?'setprivacy_bot':command==='/setinline'?'setinline_bot':'setjoingroups_bot';
    await q(`INSERT INTO botfather_sessions(user_id,step) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET step=$2,updated_at=now()`,[uid,step]);await sendBotFatherReply(cid,'username ربات را بفرست، مثلاً @my_zento_bot');return true;
  }
  if(['setprivacy_bot','setinline_bot','setjoingroups_bot'].includes(session.step) && !text.startsWith('/')){
    const username=text.replace(/^@/,'').trim().toLowerCase();const r=await q('SELECT id FROM bots WHERE owner_id=$1 AND lower(username)=lower($2)',[uid,username]);if(!r.rowCount){await sendBotFatherReply(cid,'ربات پیدا نشد.');return true;}
    const labels={setprivacy_bot:['privacy_mode','Privacy'],setinline_bot:['inline_mode','Inline'],setjoingroups_bot:['can_join_groups','ورود به گروه‌ها']}[session.step];await q(`UPDATE botfather_sessions SET step=$2,pending_bot_id=$3,updated_at=now() WHERE user_id=$1`,[uid,session.step.replace('_bot','_value'),Number(r.rows[0].id)]);await sendBotFatherReply(cid,`برای ${labels[1]} بنویس: on یا off`);return true;
  }
  if(['setprivacy_value','setinline_value','setjoingroups_value'].includes(session.step) && !text.startsWith('/')){
    const val=/^(on|true|1|فعال)$/i.test(text);const col=session.step==='setprivacy_value'?'privacy_mode':session.step==='setinline_value'?'inline_mode':'can_join_groups';await q(`UPDATE bots SET ${col}=$1 WHERE id=$2 AND owner_id=$3`,[val,session.pending_bot_id,uid]);await q(`UPDATE botfather_sessions SET step='idle',pending_bot_id=NULL,updated_at=now() WHERE user_id=$1`,[uid]);await sendBotFatherReply(cid,`تنظیم ${col} روی ${val?'فعال':'غیرفعال'} قرار گرفت.`);return true;
  }
  if(command==='/deletebot'){
    await q(`INSERT INTO botfather_sessions(user_id,step) VALUES($1,'deletebot_bot') ON CONFLICT(user_id) DO UPDATE SET step='deletebot_bot',updated_at=now()`,[uid]);await sendBotFatherReply(cid,'username رباتی که می‌خواهی حذف شود را بفرست. این کار قابل برگشت نیست.');return true;
  }
  if(session.step==='deletebot_bot' && !text.startsWith('/')){
    const username=text.replace(/^@/,'').trim().toLowerCase();const r=await q('SELECT id,name FROM bots WHERE owner_id=$1 AND lower(username)=lower($2)',[uid,username]);if(!r.rowCount){await sendBotFatherReply(cid,'ربات پیدا نشد.');return true;}await q('DELETE FROM bots WHERE id=$1 AND owner_id=$2',[r.rows[0].id,uid]);await q(`UPDATE botfather_sessions SET step='idle',pending_bot_id=NULL,updated_at=now() WHERE user_id=$1`,[uid]);await sendBotFatherReply(cid,`🗑️ ربات @${username} حذف شد.`);return true;
  }
  if(command==='/setcommands'){
    await q(`INSERT INTO botfather_sessions(user_id,step) VALUES($1,'setcommands_bot') ON CONFLICT(user_id) DO UPDATE SET step='setcommands_bot',updated_at=now()`,[uid]);await sendBotFatherReply(cid,'username ربات را بفرست، مثلاً @my_zento_bot');return true;
  }
  if(session.step==='setcommands_bot' && !text.startsWith('/')){
    const username=text.replace(/^@/,'').trim().toLowerCase();const r=await q('SELECT id FROM bots WHERE owner_id=$1 AND lower(username)=lower($2)',[uid,username]);if(!r.rowCount){await sendBotFatherReply(cid,'ربات پیدا نشد.');return true;}await q(`UPDATE botfather_sessions SET step='setcommands_text',pending_bot_id=$2,updated_at=now() WHERE user_id=$1`,[uid,Number(r.rows[0].id)]);await sendBotFatherReply(cid,'دستورات را هر خط به شکل زیر بفرست:\nstart - شروع ربات\nhelp - راهنما\n\nبرای پاک کردن همه دستورات /deletecommands را بفرست.');return true;
  }
  if(command==='/deletecommands'){
    await q(`INSERT INTO botfather_sessions(user_id,step) VALUES($1,'deletecommands_bot') ON CONFLICT(user_id) DO UPDATE SET step='deletecommands_bot',updated_at=now()`,[uid]);await sendBotFatherReply(cid,'username ربات را بفرست.');return true;
  }
  if(session.step==='deletecommands_bot' && !text.startsWith('/')){const username=text.replace(/^@/,'').trim().toLowerCase();const r=await q('SELECT id FROM bots WHERE owner_id=$1 AND lower(username)=lower($2)',[uid,username]);if(!r.rowCount){await sendBotFatherReply(cid,'ربات پیدا نشد.');return true;}await q('DELETE FROM bot_commands WHERE bot_id=$1',[r.rows[0].id]);await q(`UPDATE botfather_sessions SET step='idle',pending_bot_id=NULL,updated_at=now() WHERE user_id=$1`,[uid]);await sendBotFatherReply(cid,'منوی دستورات ربات پاک شد.');return true;}
  if(session.step==='setcommands_text' && !text.startsWith('/')){
    const lines=text.split(/\r?\n/).map(x=>x.trim()).filter(Boolean).slice(0,100);await q('DELETE FROM bot_commands WHERE bot_id=$1',[session.pending_bot_id]);for(const line of lines){const m=line.match(/^\/?([a-zA-Z0-9_]{1,32})\s*(?:[-—:]\s*)?(.*)$/);if(!m)continue;await q('INSERT INTO bot_commands(bot_id,command,response) VALUES($1,$2,$3) ON CONFLICT(bot_id,command) DO UPDATE SET response=EXCLUDED.response',[session.pending_bot_id,m[1],m[2].slice(0,4000)])}await q(`UPDATE botfather_sessions SET step='idle',pending_bot_id=NULL,updated_at=now() WHERE user_id=$1`,[uid]);await sendBotFatherReply(cid,`✅ منوی دستورات ربات به‌روزرسانی شد (${lines.length} مورد).`);return true;
  }
  if(command==='/setdescription'){
    await q(`INSERT INTO botfather_sessions(user_id,step) VALUES($1,'setdescription_bot') ON CONFLICT(user_id) DO UPDATE SET step='setdescription_bot',updated_at=now()`,[uid]);
    await sendBotFatherReply(cid,'username ربات را بفرست، مثلاً @my_zento_bot'); return true;
  }
  if(session.step==='setdescription_bot' && !text.startsWith('/')){
    const username=text.replace(/^@/,'').trim().toLowerCase();
    const r=await q('SELECT id,name FROM bots WHERE owner_id=$1 AND lower(username)=lower($2)',[uid,username]);
    if(!r.rowCount){await sendBotFatherReply(cid,'رباتی با این username در حساب شما پیدا نشد.');return true;}
    await q(`UPDATE botfather_sessions SET step=$2,pending_bot_id=$3,updated_at=now() WHERE user_id=$1`,[uid,'setdescription_text',Number(r.rows[0].id)]);
    await sendBotFatherReply(cid,'حالا توضیحات جدید ربات را بفرست.'); return true;
  }
  if(session.step==='setdescription_text' && !text.startsWith('/')){
    await q('UPDATE bots SET description=$1 WHERE id=$2 AND owner_id=$3',[text.slice(0,300),session.pending_bot_id,uid]);
    await q(`UPDATE botfather_sessions SET step='idle',pending_bot_id=NULL,updated_at=now() WHERE user_id=$1`,[uid]);
    await sendBotFatherReply(cid,'توضیحات ربات با موفقیت تغییر کرد.'); return true;
  }
  if(command==='/settings' || command==='/mybotsettings'){
    const r=await q('SELECT id,name,username,description,avatar FROM bots WHERE owner_id=$1 ORDER BY id DESC',[uid]);
    if(!r.rowCount){await sendBotFatherReply(cid,'هنوز رباتی نداری. ابتدا /newbot را بفرست.');return true;}
    await sendBotFatherReply(cid,`⚙️ تنظیمات ربات‌ها\n\n${r.rows.map((b,i)=>`${i+1}. 🤖 ${b.name} (@${b.username})\nنام: /setname\nتوضیحات: /setdescription\nعکس: /setphoto\nAPI: /api/bot/<TOKEN>/getMe`).join('\n\n')}\n\nبرای تغییرات از دستورات بالا استفاده کن یا از پنل «ربات‌ها» در امکانات پیشرفته زنتو استفاده کن.`); return true;
  }
  if(command==='/setphoto'){
    await q(`INSERT INTO botfather_sessions(user_id,step) VALUES($1,'setphoto_bot') ON CONFLICT(user_id) DO UPDATE SET step='setphoto_bot',updated_at=now()`,[uid]);
    await sendBotFatherReply(cid,'username ربات را بفرست، مثلاً @my_zento_bot'); return true;
  }
  if(session.step==='setphoto_bot' && !text.startsWith('/')){
    const username=text.replace(/^@/,'').trim().toLowerCase();
    const r=await q('SELECT id FROM bots WHERE owner_id=$1 AND lower(username)=lower($2)',[uid,username]);
    if(!r.rowCount){await sendBotFatherReply(cid,'رباتی با این username در حساب شما پیدا نشد.');return true;}
    await q(`UPDATE botfather_sessions SET step='setphoto_url',pending_bot_id=$2,updated_at=now() WHERE user_id=$1`,[uid,Number(r.rows[0].id)]);
    await sendBotFatherReply(cid,'لینک HTTPS تصویر پروفایل را بفرست. برای آپلود فایل از پنل «ربات‌ها» استفاده کن.'); return true;
  }
  if(session.step==='setphoto_url' && !text.startsWith('/')){
    if(!/^https:\/\//i.test(text)){await sendBotFatherReply(cid,'لینک تصویر باید با HTTPS شروع شود.');return true;}
    const r=await q('UPDATE bots SET avatar=$1 WHERE id=$2 AND owner_id=$3 RETURNING *',[text.slice(0,1000),session.pending_bot_id,uid]);
    if(r.rowCount){const bot=r.rows[0];const botUid=await ensureBotUser(bot);await q('UPDATE users SET avatar=$1 WHERE id=$2',[bot.avatar,botUid]);}
    await q(`UPDATE botfather_sessions SET step='idle',pending_bot_id=NULL,updated_at=now() WHERE user_id=$1`,[uid]);
    await sendBotFatherReply(cid,'عکس پروفایل ربات با موفقیت تغییر کرد.'); return true;
  }
  if(command==='/setname'){
    await q(`INSERT INTO botfather_sessions(user_id,step) VALUES($1,'setname_bot') ON CONFLICT(user_id) DO UPDATE SET step='setname_bot',updated_at=now()`,[uid]);
    await sendBotFatherReply(cid,'username ربات را بفرست، مثلاً @my_zento_bot'); return true;
  }
  if(session.step==='setname_bot' && !text.startsWith('/')){
    const username=text.replace(/^@/,'').trim().toLowerCase();
    const r=await q('SELECT id FROM bots WHERE owner_id=$1 AND lower(username)=lower($2)',[uid,username]);
    if(!r.rowCount){await sendBotFatherReply(cid,'رباتی با این username در حساب شما پیدا نشد.');return true;}
    await q(`UPDATE botfather_sessions SET step='setname_text',pending_bot_id=$2,updated_at=now() WHERE user_id=$1`,[uid,Number(r.rows[0].id)]);
    await sendBotFatherReply(cid,'نام جدید ربات را بفرست.'); return true;
  }
  if(session.step==='setname_text' && !text.startsWith('/')){
    await q('UPDATE bots SET name=$1 WHERE id=$2 AND owner_id=$3',[text.slice(0,60),session.pending_bot_id,uid]);
    await q(`UPDATE botfather_sessions SET step='idle',pending_bot_id=NULL,updated_at=now() WHERE user_id=$1`,[uid]);
    await sendBotFatherReply(cid,'نام ربات با موفقیت تغییر کرد.'); return true;
  }
  if(text && !text.startsWith('/')){
    await sendBotFatherReply(cid,'دستور را متوجه نشدم. برای دیدن دستورهای قابل استفاده /help را بفرست.'); return true;
  }
  await sendBotFatherReply(cid,'دستور نامعتبر است. /help را بفرست تا فهرست دستورها را ببینی.'); return true;
}

async function ensureStage4Schema(){
  await q(`CREATE TABLE IF NOT EXISTS bots (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bot_user_id BIGINT UNIQUE REFERENCES users(id) ON DELETE SET NULL,
    username TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    avatar TEXT NOT NULL DEFAULT '',
    webhook_url TEXT NOT NULL DEFAULT '', token TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await q(`ALTER TABLE bots ADD COLUMN IF NOT EXISTS bot_user_id BIGINT UNIQUE REFERENCES users(id) ON DELETE SET NULL`);
  await q(`ALTER TABLE bots ADD COLUMN IF NOT EXISTS avatar TEXT NOT NULL DEFAULT ''`);
  await q(`CREATE TABLE IF NOT EXISTS bot_updates(
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    bot_id BIGINT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    update_json JSONB NOT NULL, consumed BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await q(`CREATE INDEX IF NOT EXISTS bot_updates_pending_idx ON bot_updates(bot_id,consumed,id)`);
  await q(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS bot_id BIGINT REFERENCES bots(id) ON DELETE SET NULL`);
  await q(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_markup JSONB`);
  await q(`CREATE TABLE IF NOT EXISTS bot_commands (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    bot_id BIGINT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    command TEXT NOT NULL, response TEXT NOT NULL DEFAULT '',
    reply_markup JSONB,
    UNIQUE(bot_id,command)
  )`);
  await q(`ALTER TABLE bot_commands ADD COLUMN IF NOT EXISTS reply_markup JSONB`);
  await q(`ALTER TABLE bots ADD COLUMN IF NOT EXISTS about_text TEXT NOT NULL DEFAULT ''`);
  await q(`ALTER TABLE bots ADD COLUMN IF NOT EXISTS privacy_mode BOOLEAN NOT NULL DEFAULT true`);
  await q(`ALTER TABLE bots ADD COLUMN IF NOT EXISTS inline_mode BOOLEAN NOT NULL DEFAULT false`);
  await q(`ALTER TABLE bots ADD COLUMN IF NOT EXISTS can_join_groups BOOLEAN NOT NULL DEFAULT true`);
  await q(`ALTER TABLE bots ADD COLUMN IF NOT EXISTS can_read_all_group_messages BOOLEAN NOT NULL DEFAULT false`);
  await q(`CREATE TABLE IF NOT EXISTS bot_chat_settings(
    bot_id BIGINT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    can_post BOOLEAN NOT NULL DEFAULT true,
    can_read BOOLEAN NOT NULL DEFAULT true,
    can_manage BOOLEAN NOT NULL DEFAULT false,
    added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(bot_id,conversation_id)
  )`);
  await q(`CREATE INDEX IF NOT EXISTS bot_chat_settings_conv_idx ON bot_chat_settings(conversation_id)`);
  await q(`CREATE INDEX IF NOT EXISTS bots_owner_idx ON bots(owner_id)`);
}

async function ensureStage5Schema(){
  await q(`CREATE TABLE IF NOT EXISTS stories (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('photo','video')),
    url TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
  )`);
  await q(`CREATE TABLE IF NOT EXISTS story_views (
    story_id BIGINT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    viewer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    viewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(story_id,viewer_id)
  )`);
  await q(`CREATE INDEX IF NOT EXISTS stories_user_exp_idx ON stories(user_id,expires_at)`);
  await q(`CREATE TABLE IF NOT EXISTS story_reactions (story_id BIGINT NOT NULL REFERENCES stories(id) ON DELETE CASCADE, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, reaction TEXT NOT NULL DEFAULT '❤️', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(story_id,user_id))`);
  await q(`CREATE INDEX IF NOT EXISTS story_reactions_story_idx ON story_reactions(story_id)`);
  await q(`CREATE TABLE IF NOT EXISTS conversation_user_settings (user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, pinned BOOLEAN NOT NULL DEFAULT false, muted BOOLEAN NOT NULL DEFAULT false, archived BOOLEAN NOT NULL DEFAULT false, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(user_id,conversation_id))`);

}

async function ensureStorageBucket(){
  const { data, error } = await supabase.storage.listBuckets();
  if (error) throw error;
  if (!data.some(b => b.name === STORAGE_BUCKET)) {
    const { error: createError } = await supabase.storage.createBucket(STORAGE_BUCKET, { public: true, fileSizeLimit: '50MB' });
    if (createError && !/already exists/i.test(createError.message || '')) throw createError;
  }
}

setInterval(async()=>{try{const r=await q(`DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at<=now() RETURNING id,conversation_id`);for(const x of r.rows)io.to('conv:'+x.conversation_id).emit('message_deleted',Number(x.id));}catch(e){console.error('expiry cleanup',e.message)}},5000);

async function start(){
  await q('SELECT 1');
  await ensureStage1Schema();
  await ensureStage3Schema();
  await ensureStage4Schema();
  await ensureBotFatherSchema();
  await ensureBotFather();
  await ensureStage5Schema();
  await ensureStorageBucket();
  server.listen(PORT,()=>console.log(`Zento PostgreSQL backend listening on port ${PORT}`));
}
start().catch(e=>{console.error('Startup failed:',e);process.exit(1)});
