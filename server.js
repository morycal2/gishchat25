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

const app = express();
const server = http.createServer(app);
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STORAGE_BUCKET = process.env.STORAGE_BUCKET || 'gish-files';
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
async function conversationView(c) {
  const members = await q(`SELECT u.id,u.username,u.email,u.display_name,u.avatar,u.bio
    FROM conversation_members cm JOIN users u ON u.id=cm.user_id
    WHERE cm.conversation_id=$1 ORDER BY cm.user_id`, [c.id]);
  const last = await q(`SELECT id,text,kind,created_at FROM messages WHERE conversation_id=$1 AND deleted=false ORDER BY id DESC LIMIT 1`, [c.id]);
  const m = last.rows[0];
  let lastText = '';
  if (m) lastText = m.kind === 'voice' ? '🎙️ پیام صوتی' : m.kind === 'image' ? '🖼️ تصویر' : m.kind === 'video' ? '🎬 ویدیو' : m.kind === 'audio' ? '🎵 آهنگ' : (m.text || '📎 فایل');
  return {
    id: Number(c.id), name: c.name, type: c.type || 'group', created_at: c.created_at,
    last_text: lastText, last_time: m ? m.created_at : c.created_at,
    members: members.rows.map(safeUser), owner_id: c.owner_id ? Number(c.owner_id) : null,
    description: c.description || '', username: c.username || ''
  };
}
async function messageView(row) {
  const u = await getUser(row.sender_id);
  return { ...row, id: Number(row.id), conversation_id: Number(row.conversation_id), sender_id: Number(row.sender_id),
    reply_to: row.reply_to ? Number(row.reply_to) : null, reactions: row.reactions || {}, display_name: u?.display_name,
    username: u?.username, avatar: u?.avatar };
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
  try { await q('SELECT 1'); res.json({ ok: true, service: 'gish-chat', database: 'postgres', storage: STORAGE_BUCKET, time: new Date().toISOString() }); }
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
  const r = await q(`SELECT c.* FROM conversations c JOIN conversation_members cm ON cm.conversation_id=c.id
    WHERE cm.user_id=$1 ORDER BY c.updated_at DESC, c.id DESC`, [req.user.id]);
  const views = []; for (const c of r.rows) views.push(await conversationView(c));
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
  res.json(await conversationView(c));
});

app.post('/api/conversations/group', auth, async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 60);
  const members = [...new Set([req.user.id, ...(Array.isArray(req.body.members) ? req.body.members.map(Number) : [])])].filter(Boolean);
  if (!name || members.length < 2) return res.status(400).json({ error: 'نام گروه و حداقل یک عضو دیگر لازم است' });
  const valid = await q('SELECT id FROM users WHERE id=ANY($1::bigint[])', [members]);
  const ids = valid.rows.map(x => Number(x.id));
  if (ids.length !== members.length) return res.status(400).json({ error: 'عضو نامعتبر است' });
  const cr = await q(`INSERT INTO conversations(name,type,owner_id,description) VALUES($1,'group',$2,$3) RETURNING *`, [name, req.user.id, String(req.body.description || '').trim().slice(0, 200)]);
  const c = cr.rows[0];
  for (const uid of ids) await q('INSERT INTO conversation_members(conversation_id,user_id) VALUES($1,$2)', [c.id, uid]);
  res.json(await conversationView(c));
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
  res.json(await conversationView(c));
});

app.post('/api/conversations/:id/join', auth, async (req, res) => {
  const c = await getConversation(req.params.id);
  if (!c || c.type !== 'channel') return res.status(404).json({ error: 'کانال پیدا نشد' });
  await q('INSERT INTO conversation_members(conversation_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [c.id, req.user.id]);
  res.json(await conversationView(c));
});

app.get('/api/conversations/:id/messages', auth, async (req, res) => {
  const cid = Number(req.params.id);
  if (!await isMember(cid, req.user.id)) return res.status(403).json({ error: 'ابتدا باید عضو این گفتگو باشید' });
  const r = await q(`SELECT id,conversation_id,sender_id,text,file_url,file_type,file_name,kind,reply_to,created_at,deleted,reactions
    FROM messages WHERE conversation_id=$1 ORDER BY id DESC LIMIT 300`, [cid]);
  const rows = r.rows.reverse(); const out = []; for (const m of rows) out.push(await messageView(m));
  res.json(out);
});

async function canMessage(cid, uid) {
  const c = await getConversation(cid);
  if (!c || !await isMember(cid, uid)) return { ok: false, error: 'گفتگو پیدا نشد یا عضو آن نیستید' };
  if (c.type === 'channel' && Number(c.owner_id) !== Number(uid)) return { ok: false, error: 'فقط مدیر کانال می‌تواند پیام بفرستد' };
  if (c.type === 'direct') {
    const mr = await q('SELECT user_id FROM conversation_members WHERE conversation_id=$1 AND user_id<>$2 LIMIT 1', [cid, uid]);
    const other = mr.rows[0]?.user_id;
    if (other && (await q(`SELECT 1 FROM blocks WHERE (user_id=$1 AND blocked_id=$2) OR (user_id=$2 AND blocked_id=$1)`, [uid, other])).rowCount)
      return { ok: false, error: 'ارسال پیام به این کاربر مجاز نیست' };
  }
  return { ok: true, conversation: c };
}

async function insertMessage({ cid, uid, text, kind='text', fileUrl='', fileType='', fileName='', replyTo=null }) {
  const r = await q(`INSERT INTO messages(conversation_id,sender_id,text,file_url,file_type,file_name,kind,reply_to)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [cid, uid, text, fileUrl, fileType, fileName, kind, replyTo]);
  await q('UPDATE conversations SET updated_at=now() WHERE id=$1', [cid]);
  return messageView(r.rows[0]);
}

app.post('/api/messages', auth, async (req, res) => {
  try {
    const cid = Number(req.body.conversationId); const check = await canMessage(cid, req.user.id);
    if (!check.ok) return res.status(403).json({ error: check.error });
    const text = String(req.body.text || '').trim().slice(0, 5000);
    const replyTo = req.body.replyTo ? Number(req.body.replyTo) : null;
    if (!text) return res.status(400).json({ error: 'پیام خالی است' });
    const out = await insertMessage({ cid, uid: req.user.id, text, replyTo });
    io.to('conv:' + cid).emit('message', out);
    res.json(out);
  } catch (e) { console.error(e); res.status(500).json({ error: 'ارسال پیام ناموفق بود' }); }
});

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
io.on('connection', socket => {
  const uid=Number(socket.user.id); online.set(uid,(online.get(uid)||0)+1); socket.join('user:'+uid); io.emit('presence',{userId:uid,online:true});
  socket.on('join', async cid => { if(await isMember(Number(cid),uid)) socket.join('conv:'+Number(cid)); });
  socket.on('typing', async d => { const cid=Number(d.conversationId); if(await isMember(cid,uid)) socket.to('conv:'+cid).emit('typing',{userId:uid,typing:!!d.typing}); });
  socket.on('send_message', async d => {
    try { const cid=Number(d.conversationId), check=await canMessage(cid,uid); if(!check.ok)return;
      const text=String(d.text||'').trim().slice(0,5000), fileUrl=String(d.fileUrl||'').slice(0,1000), fileType=String(d.fileType||'').slice(0,120), fileName=safeFileName(d.fileName||'');
      if(!text&&!fileUrl)return; const out=await insertMessage({cid,uid,text,kind:String(d.kind||'text'),fileUrl,fileType,fileName,replyTo:d.replyTo?Number(d.replyTo):null}); io.to('conv:'+cid).emit('message',out);
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
  socket.on('disconnect',()=>{const n=(online.get(uid)||1)-1;if(n<=0){online.delete(uid);io.emit('presence',{userId:uid,online:false})}else online.set(uid,n)});
});

app.use(express.static(path.join(__dirname, 'public')));

app.use('/api',(req,res)=>res.status(404).json({error:'API endpoint not found'}));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

async function ensureStorageBucket(){
  const { data, error } = await supabase.storage.listBuckets();
  if (error) throw error;
  if (!data.some(b => b.name === STORAGE_BUCKET)) {
    const { error: createError } = await supabase.storage.createBucket(STORAGE_BUCKET, { public: true, fileSizeLimit: '50MB' });
    if (createError && !/already exists/i.test(createError.message || '')) throw createError;
  }
}

async function start(){
  await q('SELECT 1');
  await ensureStorageBucket();
  server.listen(PORT,()=>console.log(`Gish Chat PostgreSQL backend listening on port ${PORT}`));
}
start().catch(e=>{console.error('Startup failed:',e);process.exit(1)});
