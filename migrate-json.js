/* One-time migration from the old data/gish.json into PostgreSQL + Supabase Storage. */
require('dotenv').config();
const fs=require('fs'),path=require('path'),bcrypt=require('bcryptjs');
const {Pool}=require('pg');
const {createClient}=require('@supabase/supabase-js');
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
const supabase=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{autoRefreshToken:false,persistSession:false}});
const bucket=process.env.STORAGE_BUCKET||'gish-files';
const file=process.env.OLD_JSON||path.join(process.cwd(),'data','gish.json');
const oldPublic=path.join(process.cwd(),'public');
async function q(t,p=[]){return pool.query(t,p)}
async function storageUrl(localUrl,folder,userId){
 if(!localUrl||/^https?:\/\//i.test(localUrl))return localUrl||'';
 const clean=localUrl.replace(/^\//,'');
 const fp=path.join(oldPublic,clean.replace(/^uploads\//,''));
 if(!fs.existsSync(fp)) return localUrl;
 const buf=fs.readFileSync(fp); const ext=path.extname(fp).toLowerCase();
 const objectPath=`${folder}/${userId}/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
 const mime=ext==='.webm'?'audio/webm':ext==='.mp4'?'video/mp4':ext==='.png'?'image/png':ext==='.jpg'||ext==='.jpeg'?'image/jpeg':'application/octet-stream';
 const {error}=await supabase.storage.from(bucket).upload(objectPath,buf,{contentType:mime,upsert:false});
 if(error)throw error;
 return supabase.storage.from(bucket).getPublicUrl(objectPath).data.publicUrl;
}
async function run(){
 if(!fs.existsSync(file)) throw new Error(`Old JSON not found: ${file}`);
 const d=JSON.parse(fs.readFileSync(file,'utf8'));
 for(const u of d.users||[]){
  const email=String(u.email||(`${u.username}@gish.chat`)).toLowerCase();
  const hash=u.password_hash||await bcrypt.hash('123456',12);
  let avatar=await storageUrl(u.avatar,'avatars',u.id);
  await q(`insert into users(id,username,email,password_hash,display_name,avatar,bio,created_at) values($1,$2,$3,$4,$5,$6,$7,$8)
    on conflict(id) do update set username=excluded.username,email=excluded.email,password_hash=excluded.password_hash,display_name=excluded.display_name,avatar=excluded.avatar,bio=excluded.bio`,
    [u.id,u.username,email,hash,u.display_name||u.username,avatar||'',u.bio||'',u.created_at||new Date().toISOString()]);
 }
 for(const c of d.conversations||[]){
  const r=await q(`insert into conversations(id,name,type,owner_id,username,description,created_at) values($1,$2,$3,$4,$5,$6,$7)
    on conflict(id) do update set name=excluded.name,type=excluded.type,owner_id=excluded.owner_id,username=excluded.username,description=excluded.description returning id`,
    [c.id,c.name||'گفتگو',c.type||'group',c.owner_id||null,c.username||null,c.description||'',c.created_at||new Date().toISOString()]);
  for(const uid of c.members||[]) await q('insert into conversation_members(conversation_id,user_id) values($1,$2) on conflict do nothing',[r.rows[0].id,uid]);
 }
 for(const m of d.messages||[]){
  const fileUrl=await storageUrl(m.file_url,'files',m.sender_id);
  await q(`insert into messages(id,conversation_id,sender_id,text,file_url,file_type,file_name,kind,reply_to,created_at,deleted,reactions)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict(id) do update set text=excluded.text,file_url=excluded.file_url,file_type=excluded.file_type,file_name=excluded.file_name,kind=excluded.kind,reply_to=excluded.reply_to,deleted=excluded.deleted,reactions=excluded.reactions`,
    [m.id,m.conversation_id,m.sender_id,m.text||'',fileUrl||'',m.file_type||'',m.file_name||'',m.kind||'text',m.reply_to||null,m.created_at||new Date().toISOString(),!!m.deleted,JSON.stringify(m.reactions||{})]);
 }
 for(const s of d.saved||[]) await q('insert into saved_messages(user_id,message_id,created_at) values($1,$2,$3) on conflict do nothing',[s.user_id,s.message_id,s.created_at||new Date().toISOString()]);
 for(const b of d.blocks||[]) await q('insert into blocks(user_id,blocked_id,created_at) values($1,$2,$3) on conflict do nothing',[b.user_id,b.blocked_id,b.created_at||new Date().toISOString()]);
 for(const r of d.reports||[]) await q('insert into reports(reporter_id,reported_id,reason,created_at) values($1,$2,$3,$4)',[r.reporter_id,r.reported_id,r.reason||'',r.created_at||new Date().toISOString()]);
 await q(`select setval(pg_get_serial_sequence('users','id'), coalesce((select max(id) from users),1), true)`);
 await q(`select setval(pg_get_serial_sequence('conversations','id'), coalesce((select max(id) from conversations),1), true)`);
 await q(`select setval(pg_get_serial_sequence('messages','id'), coalesce((select max(id) from messages),1), true)`);
 console.log('Migration complete. Old local media is copied to Supabase when its files exist in public/uploads.');
 await pool.end();
}
run().catch(e=>{console.error(e);pool.end().finally(()=>process.exit(1))});
