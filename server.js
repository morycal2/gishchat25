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
  if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
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
    display_name: row.display_name, avatar: row.avatar || '', bio: row.bio || ''
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
  const members = await q(`SELECT u.id,u.username,u.email,u.display_name,u.avatar,u.bio
    FROM conversation_members cm JOIN users u ON u.id=cm.user_id
    WHERE cm.conversation_id=$1 ORDER BY cm.user_id`, [c.id]);
  const last = await q(`SELECT id,text,kind,created_at FROM messages WHERE conversation_id=$1 AND deleted=false ORDER BY id DESC LIMIT 1`, [c.id]);
  const m = last.rows[0];
  let lastText = '';
  if (m) lastText = m.kind === 'voice' ? '🎙️ پیام صوتی' : m.kind === 'image' ? '🖼️ تصویر' : m.kind === 'video' ? '🎬 ویدیو' : m.kind === 'audio' ? '🎵 آهنگ' : (m.text || '📎 فایل');
  const unread = await q(`SELECT count(*)::int AS n FROM messages m JOIN conversation_members cm ON cm.conversation_id=m.conversation_id AND cm.user_id=$2 WHERE m.conversation_id=$1 AND m.sender_id<>$2 AND m.deleted=false AND m.created_at>cm.last_read_at`, [c.id, viewerId]);
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
  const r = await q(`SELECT id,username,email,display_name,avatar,bio FROM users
    WHERE id<>$1 AND ($2='' OR lower(username) LIKE '%'||$2||'%' OR lower(display_name) LIKE '%'||$2||'%') ORDER BY display_name LIMIT 50`, [req.user.id, qv]);
  res.json(r.rows.map(safeUser));
});

app.get('/api/conversations', auth, async (req, res) => {
  currentViewUserId=req.user.id;
  const r = await q(`SELECT c.* FROM conversations c JOIN conversation_members cm ON cm.conversation_id=c.id
    WHERE cm.user_id=$1 ORDER BY c.updated_at DESC, c.id DESC`, [req.user.id]);
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

async function insertMessage({ cid, uid, text, kind='text', fileUrl='', fileType='', fileName='', replyTo=null, profileId=null, expiresIn=null, quoteIds=[], botId=null }) {
  const expiresAt = expiresIn ? new Date(Date.now()+Number(expiresIn)*1000) : null;
  const r = await q(`INSERT INTO messages(conversation_id,sender_id,text,file_url,file_type,file_name,kind,reply_to,profile_id,expires_at,quote_ids,bot_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [cid, uid, text, fileUrl, fileType, fileName, kind, replyTo, profileId, expiresAt, JSON.stringify(Array.isArray(quoteIds)?quoteIds.map(Number).filter(Boolean):[]), botId]);
  await q('UPDATE conversations SET updated_at=now() WHERE id=$1', [cid]);
  return messageView(r.rows[0]);
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
    const out = await insertMessage({ cid, uid: req.user.id, text, kind, fileUrl, fileType, fileName, replyTo, profileId, expiresIn, quoteIds });
    io.to('conv:' + cid).emit('message', out);
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
    const r=await q(`SELECT id,conversation_id,sender_id,text,file_url,file_type,file_name,kind,reply_to,created_at,deleted,reactions,expires_at,quote_ids FROM messages WHERE ${where} ORDER BY id DESC LIMIT 100`,params);
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


// ---- Zento Stage 1: appearance, folders, chat locks, profiles ----
const defaultTheme={accent:'#3390ec',mine:'#2b6cff',theirs:'#ffffff',background:'#dce9f4',bubbleRadius:18,shadow:true,fontSize:15,compact:false};
app.get('/api/preferences', auth, async (req,res)=>{ const r=await q('SELECT theme FROM user_preferences WHERE user_id=$1',[req.user.id]); res.json({theme:{...defaultTheme,...(r.rows[0]?.theme||{})}}); });
app.put('/api/preferences', auth, async (req,res)=>{ const theme={...defaultTheme,...(req.body.theme||{})}; await q(`INSERT INTO user_preferences(user_id,theme) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET theme=EXCLUDED.theme,updated_at=now()`,[req.user.id,JSON.stringify(theme)]); res.json({theme}); });
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
    if (Number(c.owner_id) !== Number(req.user.id)) return res.status(403).json({ error: 'فقط مالک می‌تواند اطلاعات را ویرایش کند' });
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
  res.json({...u,blocked,blockedBy});
});
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
      if(!text&&!fileUrl)return; const out=await insertMessage({cid,uid,text,kind:String(d.kind||'text'),fileUrl,fileType,fileName,replyTo:d.replyTo?Number(d.replyTo):null,profileId:d.profileId?Number(d.profileId):null,expiresIn:d.expiresIn?Number(d.expiresIn):null,quoteIds:Array.isArray(d.quoteIds)?d.quoteIds:[]}); io.to('conv:'+cid).emit('message',out);
    } catch(e){ console.error('socket send_message',e); }
  });
  socket.on('react', async d => { try { const mid=Number(d.messageId), emoji=String(d.emoji||'').slice(0,8); const mr=await q('SELECT * FROM messages WHERE id=$1',[mid]); const m=mr.rows[0]; if(!m||!emoji||!await isMember(m.conversation_id,uid))return;
      const reactions=m.reactions||{}; const arr=Array.isArray(reactions[emoji])?reactions[emoji]:[]; const i=arr.indexOf(uid); if(i>=0)arr.splice(i,1);else arr.push(uid); if(arr.length)reactions[emoji]=arr;else delete reactions[emoji];
      const rr=await q('UPDATE messages SET reactions=$1 WHERE id=$2 RETURNING reactions',[JSON.stringify(reactions),mid]); io.to('conv:'+m.conversation_id).emit('reaction',{messageId:mid,reactions:rr.rows[0].reactions});
    }catch(e){console.error('socket react',e)} });
  socket.on('delete_message', async id => { try { const mr=await q('SELECT * FROM messages WHERE id=$1',[Number(id)]); const m=mr.rows[0]; if(!m||Number(m.sender_id)!==uid)return; await q("UPDATE messages SET deleted=true,text='',file_url='' WHERE id=$1",[m.id]); io.to('conv:'+m.conversation_id).emit('message_deleted',Number(m.id)); }catch(e){console.error('socket delete',e)} });
  socket.on('call:offer', d => io.to('user:'+Number(d.to)).emit('call:offer',{from:uid,offer:d.offer,video:!!d.video}));
  socket.on('call:answer', d => io.to('user:'+Number(d.to)).emit('call:answer',{from:uid,answer:d.answer}));
  socket.on('call:ice', d => io.to('user:'+Number(d.to)).emit('call:ice',{from:uid,candidate:d.candidate}));
  socket.on('call:end', d => io.to('user:'+Number(d.to)).emit('call:end',{from:uid}));
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

app.get('/api/conversations/:id/management', auth, async (req,res)=>{
  try{
    const cid=Number(req.params.id), c=await getConversation(cid); if(!c||!await isMember(cid,req.user.id))return res.status(404).json({error:'گفتگو پیدا نشد'});
    const role=await q('SELECT role FROM conversation_members WHERE conversation_id=$1 AND user_id=$2',[cid,req.user.id]);
    const admins=await q(`SELECT ca.user_id,ca.role,ca.permissions,u.username,u.display_name,u.avatar FROM conversation_admins ca JOIN users u ON u.id=ca.user_id WHERE ca.conversation_id=$1 ORDER BY ca.role,u.display_name`,[cid]);
    res.json({conversation:{id:Number(c.id),name:c.name,type:c.type,description:c.description,username:c.username,photo:c.photo||'',settings:c.settings||{}},role:role.rows[0]?.role||'member',owner_id:c.owner_id?Number(c.owner_id):null,admins:admins.rows.map(a=>({...a,user_id:Number(a.user_id)}))});
  }catch(e){console.error(e);res.status(500).json({error:'مدیریت گفتگو در دسترس نیست'})}
});

app.put('/api/conversations/:id/management', auth, async (req,res)=>{
  try{
    const cid=Number(req.params.id), c=await getConversation(cid); if(!c||!['group','channel'].includes(c.type))return res.status(404).json({error:'گفتگو پیدا نشد'});
    if(Number(c.owner_id)!==Number(req.user.id))return res.status(403).json({error:'فقط مالک می‌تواند تنظیمات را تغییر دهد'});
    const incoming=req.body.settings && typeof req.body.settings==='object'?req.body.settings:{};
    const allowed={slowMode:!!incoming.slowMode,onlyAdminsPost:!!incoming.onlyAdminsPost,approval:!!incoming.approval,hideMembers:!!incoming.hideMembers,comments:!!incoming.comments};
    await q('UPDATE conversations SET settings=$1,updated_at=now() WHERE id=$2',[JSON.stringify(allowed),cid]);
    res.json({settings:allowed});
  }catch(e){console.error(e);res.status(500).json({error:'ذخیره تنظیمات ناموفق بود'})}
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

// ---- Zento Stage 4: multi-device sync, Bot API, Mini Apps, AI and real-time games ----
function makeBotToken(){return 'znt_bot_'+crypto.randomBytes(28).toString('base64url');}
app.get('/api/bots', auth, async (req,res)=>{
  try{const r=await q('SELECT id,username,name,description,webhook_url,token,created_at FROM bots WHERE owner_id=$1 ORDER BY id DESC',[req.user.id]);res.json(r.rows.map(x=>({...x,id:Number(x.id)})))}catch(e){res.status(500).json({error:'دریافت ربات‌ها ناموفق بود'})}
});
app.post('/api/bots', auth, async (req,res)=>{
  try{
    const name=String(req.body.name||'').trim().slice(0,60), username=String(req.body.username||'').trim().toLowerCase().replace(/[^a-z0-9_]/g,'').slice(0,32), description=String(req.body.description||'').trim().slice(0,300), webhook=String(req.body.webhookUrl||'').trim().slice(0,500);
    if(!name||username.length<3)return res.status(400).json({error:'نام و شناسه ربات لازم است'});
    const token=makeBotToken(); const r=await q('INSERT INTO bots(owner_id,username,name,description,webhook_url,token) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,username,name,description,webhook_url,token,created_at',[req.user.id,username,name,description,webhook,token]);
    res.json({...r.rows[0],id:Number(r.rows[0].id)});
  }catch(e){res.status(409).json({error:'این شناسه ربات قبلاً استفاده شده است'})}
});
app.delete('/api/bots/:id', auth, async (req,res)=>{await q('DELETE FROM bots WHERE id=$1 AND owner_id=$2',[Number(req.params.id),req.user.id]);res.json({ok:true})});
app.post('/api/bots/:id/commands', auth, async(req,res)=>{try{const bot=await q('SELECT id FROM bots WHERE id=$1 AND owner_id=$2',[Number(req.params.id),req.user.id]);if(!bot.rowCount)return res.status(404).json({error:'ربات پیدا نشد'});const command=String(req.body.command||'').trim().replace(/^\//,'').slice(0,32),response=String(req.body.response||'').trim().slice(0,2000);if(!command)return res.status(400).json({error:'دستور لازم است'});const r=await q('INSERT INTO bot_commands(bot_id,command,response) VALUES($1,$2,$3) ON CONFLICT(bot_id,command) DO UPDATE SET response=EXCLUDED.response RETURNING *',[bot.rows[0].id,command,response]);res.json({...r.rows[0],id:Number(r.rows[0].id)})}catch(e){res.status(500).json({error:'ذخیره دستور ناموفق بود'})}});
app.delete('/api/bots/:id/commands/:command', auth, async(req,res)=>{await q('DELETE FROM bot_commands WHERE bot_id=$1 AND command=$2 AND EXISTS(SELECT 1 FROM bots WHERE id=$1 AND owner_id=$3)',[Number(req.params.id),String(req.params.command).replace(/^\//,''),req.user.id]);res.json({ok:true})});
app.get('/api/bot/:token', async(req,res)=>{const r=await q('SELECT id,username,name,description FROM bots WHERE token=$1',[String(req.params.token)]);if(!r.rowCount)return res.status(404).json({error:'توکن ربات نامعتبر است'});res.json({...r.rows[0],id:Number(r.rows[0].id)})});
app.post('/api/bot/:token/send', async(req,res)=>{try{const br=await q('SELECT id,owner_id,webhook_url FROM bots WHERE token=$1',[String(req.params.token)]);if(!br.rowCount)return res.status(401).json({error:'توکن ربات نامعتبر است'});const cid=Number(req.body.conversationId),text=String(req.body.text||'').trim().slice(0,5000);const check=await canMessage(cid,Number(br.rows[0].owner_id));if(!check.ok)return res.status(403).json({error:'ربات مالک این گفتگو نیست یا دسترسی ارسال ندارد'});const out=await insertMessage({cid,uid:Number(br.rows[0].owner_id),text,kind:'bot',botId:Number(br.rows[0].id)});io.to('conv:'+cid).emit('message',out);res.json(out)}catch(e){console.error(e);res.status(500).json({error:'ارسال پیام ربات ناموفق بود'})}});

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
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
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

async function ensureStage4Schema(){
  await q(`CREATE TABLE IF NOT EXISTS bots (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    username TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    webhook_url TEXT NOT NULL DEFAULT '', token TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await q(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS bot_id BIGINT REFERENCES bots(id) ON DELETE SET NULL`);
  await q(`CREATE TABLE IF NOT EXISTS bot_commands (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    bot_id BIGINT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    command TEXT NOT NULL, response TEXT NOT NULL DEFAULT '',
    UNIQUE(bot_id,command)
  )`);
  await q(`CREATE INDEX IF NOT EXISTS bots_owner_idx ON bots(owner_id)`);
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
  await ensureStorageBucket();
  server.listen(PORT,()=>console.log(`Zento PostgreSQL backend listening on port ${PORT}`));
}
start().catch(e=>{console.error('Startup failed:',e);process.exit(1)});
