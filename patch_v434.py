from pathlib import Path
p=Path('/mnt/data/zento_v434/server.js')
s=p.read_text()
marker="// Generic API 404 fallback (must be after all concrete /api routes)."
insert=r'''
// ---- Zento v4.34 Enterprise API ----
app.get('/api/enterprise/search', auth, async (req,res)=>{
  try{
    const term=String(req.query.q||'').trim().slice(0,120);
    if(term.length<2)return res.json({messages:[],users:[],conversations:[]});
    const like='%'+term.replace(/[%_]/g,'\\$&')+'%';
    const users=await q(`SELECT id,username,display_name,avatar,verified FROM users WHERE (username ILIKE $1 ESCAPE '\\' OR display_name ILIKE $1 ESCAPE '\\') ORDER BY verified DESC,id DESC LIMIT 30`,[like]);
    const conversations=await q(`SELECT c.id,c.type,c.name,c.username,c.photo,c.verified FROM conversations c JOIN conversation_members cm ON cm.conversation_id=c.id AND cm.user_id=$2 WHERE c.name ILIKE $1 ESCAPE '\\' OR c.username ILIKE $1 ESCAPE '\\' ORDER BY c.updated_at DESC LIMIT 30`,[like,req.user.id]);
    const messages=await q(`SELECT m.id,m.conversation_id,m.sender_id,m.text,m.kind,m.created_at,u.display_name,u.username FROM messages m JOIN conversation_members cm ON cm.conversation_id=m.conversation_id AND cm.user_id=$2 LEFT JOIN users u ON u.id=m.sender_id WHERE m.deleted=false AND m.text ILIKE $1 ESCAPE '\\' ORDER BY m.created_at DESC LIMIT 100`,[like,req.user.id]);
    res.json({users:users.rows.map(x=>({...x,id:Number(x.id),verified:!!x.verified})),conversations:conversations.rows.map(x=>({...x,id:Number(x.id),verified:!!x.verified})),messages:messages.rows.map(x=>({...x,id:Number(x.id),conversation_id:Number(x.conversation_id),sender_id:Number(x.sender_id)}))});
  }catch(e){console.error('enterprise search',e);res.status(500).json({error:'جستجوی پیشرفته ناموفق بود'});}
});

app.post('/api/enterprise/devices/register',auth,async(req,res)=>{
  try{
    const deviceId=String(req.body.deviceId||crypto.randomUUID()).slice(0,100),publicKey=String(req.body.publicKey||'').trim().slice(0,10000);
    if(!publicKey)return res.status(400).json({error:'کلید عمومی دستگاه الزامی است'});
    await q(`INSERT INTO e2ee_devices(user_id,device_id,public_key,label,algorithm) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(user_id,device_id) DO UPDATE SET public_key=EXCLUDED.public_key,label=EXCLUDED.label,algorithm=EXCLUDED.algorithm,last_seen_at=now(),revoked_at=NULL`,[req.user.id,deviceId,publicKey,String(req.body.label||'دستگاه Zento').slice(0,100),String(req.body.algorithm||'ECDH-P256').slice(0,40)]);
    res.json({ok:true,deviceId});
  }catch(e){res.status(500).json({error:'ثبت دستگاه رمزنگاری ناموفق بود'});}
});
app.get('/api/enterprise/devices',auth,async(req,res)=>{const r=await q(`SELECT device_id,label,algorithm,created_at,last_seen_at,revoked_at FROM e2ee_devices WHERE user_id=$1 ORDER BY created_at DESC`,[req.user.id]);res.json(r.rows);});
app.delete('/api/enterprise/devices/:deviceId',auth,async(req,res)=>{await q('UPDATE e2ee_devices SET revoked_at=now() WHERE user_id=$1 AND device_id=$2',[req.user.id,String(req.params.deviceId)]);res.json({ok:true});});

app.post('/api/enterprise/conversations/:id/e2ee/enable',auth,async(req,res)=>{
  const cid=Number(req.params.id); if(!await isMember(cid,req.user.id))return res.status(403).json({error:'عضو این گفتگو نیستید'});
  await q(`INSERT INTO conversation_security(conversation_id,e2ee_enabled,enabled_by) VALUES($1,true,$2) ON CONFLICT(conversation_id) DO UPDATE SET e2ee_enabled=true,enabled_by=EXCLUDED.enabled_by,updated_at=now()`,[cid,req.user.id]);
  res.json({ok:true,e2ee:true});
});
app.get('/api/enterprise/conversations/:id/e2ee',auth,async(req,res)=>{const cid=Number(req.params.id);if(!await isMember(cid,req.user.id))return res.status(403).json({error:'دسترسی ندارید'});const r=await q('SELECT e2ee_enabled,updated_at FROM conversation_security WHERE conversation_id=$1',[cid]);res.json({enabled:!!r.rows[0]?.e2ee_enabled,updated_at:r.rows[0]?.updated_at||null});});
app.get('/api/enterprise/conversations/:id/e2ee/devices',auth,async(req,res)=>{const cid=Number(req.params.id);if(!await isMember(cid,req.user.id))return res.status(403).json({error:'دسترسی ندارید'});const r=await q(`SELECT d.user_id,d.device_id,d.public_key,d.label,d.algorithm,d.revoked_at FROM e2ee_devices d JOIN conversation_members cm ON cm.user_id=d.user_id AND cm.conversation_id=$1 WHERE d.revoked_at IS NULL ORDER BY d.user_id,d.created_at`,[cid]);res.json(r.rows.map(x=>({...x,user_id:Number(x.user_id)})));});
app.post('/api/enterprise/conversations/:id/e2ee/keys',auth,async(req,res)=>{const cid=Number(req.params.id);if(!await isMember(cid,req.user.id))return res.status(403).json({error:'دسترسی ندارید'});const deviceId=String(req.body.deviceId||'').slice(0,100),envelope=String(req.body.envelope||'').slice(0,20000),version=Math.max(1,Number(req.body.version)||1);if(!deviceId||!envelope)return res.status(400).json({error:'Envelope ناقص است'});const d=await q('SELECT 1 FROM e2ee_devices WHERE user_id=$1 AND device_id=$2 AND revoked_at IS NULL',[req.user.id,deviceId]);if(!d.rowCount)return res.status(403).json({error:'دستگاه معتبر نیست'});await q(`INSERT INTO e2ee_key_envelopes(conversation_id,device_id,key_version,envelope) VALUES($1,$2,$3,$4) ON CONFLICT(conversation_id,device_id,key_version) DO UPDATE SET envelope=EXCLUDED.envelope,created_at=now()`,[cid,deviceId,version,envelope]);res.json({ok:true,version});});
app.get('/api/enterprise/conversations/:id/e2ee/keys',auth,async(req,res)=>{const cid=Number(req.params.id);if(!await isMember(cid,req.user.id))return res.status(403).json({error:'دسترسی ندارید'});const r=await q(`SELECT k.device_id,k.key_version,k.envelope,k.created_at FROM e2ee_key_envelopes k JOIN e2ee_devices d ON d.device_id=k.device_id WHERE k.conversation_id=$1 AND d.user_id=$2 AND d.revoked_at IS NULL ORDER BY k.key_version DESC,k.created_at DESC LIMIT 20`,[cid,req.user.id]);res.json(r.rows);});

app.post('/api/enterprise/messages/encrypted',auth,requireNotBanned,async(req,res)=>{
  try{
    const cid=Number(req.body.conversationId),check=await canMessage(cid,req.user.id);if(!check.ok)return res.status(403).json({error:check.error});
    const sec=await q('SELECT e2ee_enabled FROM conversation_security WHERE conversation_id=$1',[cid]);if(!sec.rows[0]?.e2ee_enabled)return res.status(409).json({error:'رمزنگاری سرتاسری برای این گفتگو فعال نیست'});
    const ciphertext=String(req.body.ciphertext||'').slice(0,200000);if(!ciphertext)return res.status(400).json({error:'داده رمزنگاری‌شده خالی است'});
    const r=await q(`INSERT INTO messages(conversation_id,sender_id,text,kind,e2ee_payload,e2ee) VALUES($1,$2,'','e2ee',$3::jsonb,true) RETURNING *`,[cid,req.user.id,JSON.stringify({ciphertext,iv:String(req.body.iv||'').slice(0,1000),version:Math.max(1,Number(req.body.version)||1),senderDeviceId:String(req.body.deviceId||'').slice(0,100)})]);
    const out=await messageView(r.rows[0]);io.to('conv:'+cid).emit('message',out);res.json(out);
  }catch(e){console.error('encrypted message',e);res.status(500).json({error:'ارسال پیام رمزنگاری‌شده ناموفق بود'});}
});

app.get('/api/enterprise/roles/:id',auth,async(req,res)=>{const cid=Number(req.params.id);if(!await isMember(cid,req.user.id))return res.status(403).json({error:'دسترسی ندارید'});const r=await q(`SELECT cr.id,cr.role_name,cr.permissions,cr.created_at,COUNT(cm.user_id)::int member_count FROM conversation_roles cr LEFT JOIN conversation_role_members crm ON crm.role_id=cr.id LEFT JOIN conversation_members cm ON cm.user_id=crm.user_id AND cm.conversation_id=cr.conversation_id WHERE cr.conversation_id=$1 GROUP BY cr.id ORDER BY cr.id`,[cid]);res.json(r.rows.map(x=>({...x,id:Number(x.id),permissions:x.permissions||{},member_count:Number(x.member_count||0)})));});
app.post('/api/enterprise/roles/:id',auth,async(req,res)=>{const cid=Number(req.params.id);if(!await canManageConversation(cid,req.user.id))return res.status(403).json({error:'فقط مدیر می‌تواند نقش بسازد'});const name=String(req.body.name||'نقش جدید').trim().slice(0,80);const permissions=req.body.permissions&&typeof req.body.permissions==='object'?req.body.permissions:{};const r=await q(`INSERT INTO conversation_roles(conversation_id,role_name,permissions) VALUES($1,$2,$3) RETURNING *`,[cid,name,JSON.stringify(permissions)]);res.json({...r.rows[0],id:Number(r.rows[0].id)});});
app.put('/api/enterprise/roles/:id',auth,async(req,res)=>{const rid=Number(req.params.id);const x=await q('SELECT conversation_id FROM conversation_roles WHERE id=$1',[rid]);if(!x.rowCount)return res.status(404).json({error:'نقش پیدا نشد'});if(!await canManageConversation(x.rows[0].conversation_id,req.user.id))return res.status(403).json({error:'دسترسی ندارید'});const name=String(req.body.name||'نقش').trim().slice(0,80),permissions=req.body.permissions&&typeof req.body.permissions==='object'?req.body.permissions:{};const r=await q(`UPDATE conversation_roles SET role_name=$1,permissions=$2,updated_at=now() WHERE id=$3 RETURNING *`,[name,JSON.stringify(permissions),rid]);res.json({...r.rows[0],id:Number(r.rows[0].id)});});
app.post('/api/enterprise/roles/:id/members/:userId',auth,async(req,res)=>{const rid=Number(req.params.id),uid=Number(req.params.userId);const x=await q('SELECT conversation_id FROM conversation_roles WHERE id=$1',[rid]);if(!x.rowCount)return res.status(404).json({error:'نقش پیدا نشد'});if(!await canManageConversation(x.rows[0].conversation_id,req.user.id))return res.status(403).json({error:'دسترسی ندارید'});if(!await isMember(x.rows[0].conversation_id,uid))return res.status(404).json({error:'کاربر عضو گفتگو نیست'});await q('INSERT INTO conversation_role_members(role_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[rid,uid]);res.json({ok:true});});

app.get('/api/enterprise/export',auth,async(req,res)=>{try{const uid=Number(req.user.id);const [u,c,m,b,f,s]=await Promise.all([q('SELECT id,username,email,display_name,bio,avatar,created_at,last_seen_at FROM users WHERE id=$1',[uid]),q('SELECT c.id,c.type,c.name,c.username,c.description,c.created_at FROM conversations c JOIN conversation_members cm ON cm.conversation_id=c.id WHERE cm.user_id=$1 ORDER BY c.id',[uid]),q('SELECT m.id,m.conversation_id,m.text,m.kind,m.created_at,m.sender_id FROM messages m JOIN conversation_members cm ON cm.conversation_id=m.conversation_id AND cm.user_id=$1 WHERE m.deleted=false ORDER BY m.created_at DESC LIMIT 10000',[uid]),q('SELECT * FROM message_bookmarks WHERE user_id=$1',[uid]),q('SELECT * FROM favorite_contacts WHERE user_id=$1',[uid]),q('SELECT * FROM user_preferences WHERE user_id=$1',[uid])]);res.setHeader('Content-Type','application/json');res.setHeader('Content-Disposition',`attachment; filename="zento-export-${uid}-${Date.now()}.json"`);res.json({version:'4.34',exportedAt:new Date().toISOString(),user:u.rows[0]||null,conversations:c.rows,messages:m.rows,bookmarks:b.rows,favorites:f.rows,preferences:s.rows[0]||null});}catch(e){console.error('export',e);res.status(500).json({error:'خروجی اطلاعات ناموفق بود'});}});

app.get('/api/enterprise/health',auth,async(_req,res)=>{try{const r=await q(`SELECT current_database() database,current_setting('server_version') postgres_version,pg_size_pretty(pg_database_size(current_database())) database_size`);res.json({ok:true,version:'4.34.0',database:r.rows[0]});}catch(e){res.status(500).json({ok:false,error:'Enterprise health check failed'});}});

'''
if marker not in s: raise SystemExit('marker missing')
s=s.replace(marker,insert+marker,1)
# add enterprise schema function before ensureFilmSchema
marker2='async function ensureFilmSchema(){'
schema=r'''
async function ensureEnterpriseSchema(){
  await q(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS e2ee BOOLEAN NOT NULL DEFAULT false`);
  await q(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS e2ee_payload JSONB`);
  await q(`CREATE INDEX IF NOT EXISTS messages_conversation_created_idx ON messages(conversation_id,created_at DESC)`);
  await q(`CREATE TABLE IF NOT EXISTS e2ee_devices (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    public_key TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT 'دستگاه Zento',
    algorithm TEXT NOT NULL DEFAULT 'ECDH-P256',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ,
    UNIQUE(user_id,device_id)
  )`);
  await q(`CREATE INDEX IF NOT EXISTS e2ee_devices_user_idx ON e2ee_devices(user_id,revoked_at)`);
  await q(`CREATE TABLE IF NOT EXISTS conversation_security (
    conversation_id BIGINT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    e2ee_enabled BOOLEAN NOT NULL DEFAULT false,
    enabled_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await q(`CREATE TABLE IF NOT EXISTS e2ee_key_envelopes (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    key_version INT NOT NULL DEFAULT 1,
    envelope TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(conversation_id,device_id,key_version)
  )`);
  await q(`CREATE TABLE IF NOT EXISTS conversation_roles (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role_name TEXT NOT NULL,
    permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(conversation_id,role_name)
  )`);
  await q(`CREATE TABLE IF NOT EXISTS conversation_role_members (
    role_id BIGINT NOT NULL REFERENCES conversation_roles(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(role_id,user_id)
  )`);
  await q(`CREATE INDEX IF NOT EXISTS conversation_role_members_user_idx ON conversation_role_members(user_id)`);
  await q(`CREATE TABLE IF NOT EXISTS notification_jobs (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','sent','failed')),
    attempts INT NOT NULL DEFAULT 0,
    available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at TIMESTAMPTZ,
    last_error TEXT
  )`);
  await q(`CREATE INDEX IF NOT EXISTS notification_jobs_pending_idx ON notification_jobs(status,available_at)`);
}

'''
if marker2 not in s: raise SystemExit('schema marker missing')
s=s.replace(marker2,schema+marker2,1)
# call schema
s=s.replace('  await ensureAdvancedSchema();\n', '  await ensureAdvancedSchema();\n  await ensureEnterpriseSchema();\n',1)
p.write_text(s)
