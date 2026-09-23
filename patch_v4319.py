from pathlib import Path
import re
root=Path('/mnt/data/zento_4318_work')
server=root/'server.js'
app=root/'public/app.js'
idx=root/'public/index.html'
css=root/'public/style.css'

s=server.read_text()
# Profile photo cap 10
s=s.replace("if(Number(count.rows[0].n)>=24)return res.status(400).json({error:'حداکثر ۲۴ عکس پروفایل مجاز است'});", "if(Number(count.rows[0].n)>=10)return res.status(400).json({error:'حداکثر ۱۰ عکس پروفایل مجاز است'});")

# Add film routes before app.get('*')
marker="app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));"
film_routes=r'''
// ---- Zento Film & Series ----
app.get('/api/films', auth, async (req,res)=>{
  try{
    const r=await q(`SELECT id,title,content_type,description,poster_url,video_url,year,genre,duration_minutes,active,created_at,updated_at FROM films WHERE active=true ORDER BY created_at DESC LIMIT 200`);
    res.json(r.rows.map(x=>({...x,id:Number(x.id),year:x.year?Number(x.year):null,duration_minutes:x.duration_minutes?Number(x.duration_minutes):null,active:!!x.active})));
  }catch(e){console.error('films',e);res.status(500).json({error:'بخش فیلم در دسترس نیست'})}
});
app.get('/api/films/:id', auth, async (req,res)=>{
  try{const r=await q(`SELECT id,title,content_type,description,poster_url,video_url,year,genre,duration_minutes,active,created_at,updated_at FROM films WHERE id=$1 AND active=true`,[Number(req.params.id)]);if(!r.rowCount)return res.status(404).json({error:'محتوا پیدا نشد'});res.json({...r.rows[0],id:Number(r.rows[0].id),year:r.rows[0].year?Number(r.rows[0].year):null,duration_minutes:r.rows[0].duration_minutes?Number(r.rows[0].duration_minutes):null,active:true});}catch(e){res.status(500).json({error:'محتوا در دسترس نیست'})}
});
app.get('/api/admin/films', auth, requireAdminPermission('films',req,res,next), async (req,res)=>{
  try{const r=await q(`SELECT id,title,content_type,description,poster_url,video_url,year,genre,duration_minutes,active,created_at,updated_at FROM films ORDER BY created_at DESC LIMIT 500`);res.json(r.rows.map(x=>({...x,id:Number(x.id),year:x.year?Number(x.year):null,duration_minutes:x.duration_minutes?Number(x.duration_minutes):null,active:!!x.active})))}catch(e){res.status(500).json({error:'دریافت فیلم‌ها ناموفق بود'})}
});
app.post('/api/admin/films', auth, requireAdminPermission('films',req,res,next), async (req,res)=>{
  try{
    const title=String(req.body.title||'').trim().slice(0,160),type=String(req.body.content_type||'movie')==='series'?'series':'movie',description=String(req.body.description||'').trim().slice(0,5000),poster=String(req.body.poster_url||'').trim().slice(0,1500),video=String(req.body.video_url||'').trim().slice(0,2000),year=req.body.year?Number(req.body.year):null,genre=String(req.body.genre||'').trim().slice(0,120),duration=req.body.duration_minutes?Number(req.body.duration_minutes):null;
    if(!title)return res.status(400).json({error:'عنوان محتوا الزامی است'});
    const r=await q(`INSERT INTO films(title,content_type,description,poster_url,video_url,year,genre,duration_minutes,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,true) RETURNING *`,[title,type,description,poster,video,Number.isFinite(year)?year:null,genre,Number.isFinite(duration)?duration:null]);
    await logAdmin(req.user.id,'create_film',Number(r.rows[0].id),{title,type});res.json({...r.rows[0],id:Number(r.rows[0].id)});
  }catch(e){console.error('create film',e);res.status(500).json({error:'ساخت محتوا ناموفق بود'})}
});
app.patch('/api/admin/films/:id', auth, requireAdminPermission('films',req,res,next), async (req,res)=>{
  try{
    const id=Number(req.params.id),title=String(req.body.title||'').trim().slice(0,160),type=String(req.body.content_type||'movie')==='series'?'series':'movie',description=String(req.body.description||'').trim().slice(0,5000),poster=String(req.body.poster_url||'').trim().slice(0,1500),video=String(req.body.video_url||'').trim().slice(0,2000),year=req.body.year?Number(req.body.year):null,genre=String(req.body.genre||'').trim().slice(0,120),duration=req.body.duration_minutes?Number(req.body.duration_minutes):null,active=req.body.active!==false;
    if(!title)return res.status(400).json({error:'عنوان محتوا الزامی است'});
    const r=await q(`UPDATE films SET title=$1,content_type=$2,description=$3,poster_url=$4,video_url=$5,year=$6,genre=$7,duration_minutes=$8,active=$9,updated_at=now() WHERE id=$10 RETURNING *`,[title,type,description,poster,video,Number.isFinite(year)?year:null,genre,Number.isFinite(duration)?duration:null,active,id]);
    if(!r.rowCount)return res.status(404).json({error:'محتوا پیدا نشد'});await logAdmin(req.user.id,'update_film',id,{title,active});res.json({...r.rows[0],id:Number(r.rows[0].id)});
  }catch(e){res.status(500).json({error:'ویرایش محتوا ناموفق بود'})}
});
app.delete('/api/admin/films/:id', auth, requireAdminPermission('films',req,res,next), async (req,res)=>{try{const id=Number(req.params.id);const r=await q('DELETE FROM films WHERE id=$1 RETURNING id',[id]);if(!r.rowCount)return res.status(404).json({error:'محتوا پیدا نشد'});await logAdmin(req.user.id,'delete_film',id,{});res.json({ok:true})}catch(e){res.status(500).json({error:'حذف محتوا ناموفق بود'})}});

'''
if film_routes not in s:
    s=s.replace(marker, film_routes+marker)

# Add schema before end of ensureStage1Schema function by injecting just before closing marker near ensureStorageBucket
schema=r'''
async function ensureFilmSchema(){
  await q(`CREATE TABLE IF NOT EXISTS films (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    title TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'movie' CHECK(content_type IN ('movie','series')),
    description TEXT NOT NULL DEFAULT '',
    poster_url TEXT NOT NULL DEFAULT '',
    video_url TEXT NOT NULL DEFAULT '',
    year INT,
    genre TEXT NOT NULL DEFAULT '',
    duration_minutes INT,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await q(`CREATE INDEX IF NOT EXISTS films_active_created_idx ON films(active,created_at DESC)`);
}
'''
if 'async function ensureFilmSchema()' not in s:
    s=s.replace('async function ensureStorageBucket(){', schema+'\nasync function ensureStorageBucket(){')
s=s.replace('  await ensureStage5Schema();\n  await ensureAdminSchema();', '  await ensureStage5Schema();\n  await ensureFilmSchema();\n  await ensureAdminSchema();')
server.write_text(s)

# App: 10-photo labels/limit
j=app.read_text()
j=j.replace('گالری (${photos.length}/24)', 'گالری (${photos.length}/10)')
j=j.replace('${photos.length}/24 عکس', '${photos.length}/10 عکس')
j=j.replace('photos.length>=24', 'photos.length>=10')
j=j.replace('slice(0,24-photos.length)', 'slice(0,10-photos.length)')
j=j.replace('/24 عکس', '/10 عکس')

# Add film center function before showArchivedChats
film_js=r'''
async function openFilmCenter(){
  try{
    const rows=await api('/api/films');
    const card=x=>`<button type="button" class="film-card" data-film-id="${x.id}"><div class="film-poster">${x.poster_url?`<img src="${esc(backendUrl(x.poster_url))}" loading="lazy">`:'<span>🎬</span>'}<i>${x.content_type==='series'?'SERIES':'MOVIE'}</i></div><div class="film-card-copy"><b>${esc(x.title)}</b><small>${esc(x.genre||'فیلم و سریال')} · ${x.year||'جدید'}</small></div></button>`;
    const body=`<div class="film-center"><div class="film-hero"><div class="film-hero-orb">✦</div><div><span> ZENTO PLAY · PREMIUM</span><b>دنیای فیلم و سریال زنتو</b><small>فیلم‌ها و سریال‌های منتخب را با یک رابط مدرن تماشا کن.</small></div></div><div class="film-filter"><button class="active" data-film-filter="all">همه</button><button data-film-filter="movie">🎬 فیلم</button><button data-film-filter="series">📺 سریال</button></div><div class="film-grid">${rows.map(card).join('')||'<div class="film-empty">هنوز محتوایی منتشر نشده است.</div>'}</div></div>`;
    openModal('🎬 ZENTO PLAY',body,()=>{});$('modalOk').classList.add('hidden');$('modalCancel').textContent='بستن';
    const bind=()=>{document.querySelectorAll('[data-film-filter]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[data-film-filter]').forEach(x=>x.classList.toggle('active',x===b));document.querySelectorAll('.film-card').forEach(x=>{const id=Number(x.dataset.filmId),item=rows.find(r=>Number(r.id)===id);x.classList.toggle('hidden',b.dataset.filmFilter!=='all'&&item?.content_type!==b.dataset.filmFilter)})});document.querySelectorAll('[data-film-id]').forEach(b=>b.onclick=()=>{const x=rows.find(r=>Number(r.id)===Number(b.dataset.filmId));if(!x)return;openFilmPlayer(x)});};bind();
  }catch(e){showToast(e.message,true)}
}
function openFilmPlayer(x){
  const media=x.video_url?`<video class="film-player" controls playsinline poster="${esc(backendUrl(x.poster_url||''))}"><source src="${esc(backendUrl(x.video_url))}"></video>`:'<div class="film-no-video">🎞️ لینک پخش برای این محتوا ثبت نشده است.</div>';
  openModal(x.content_type==='series'?'📺 سریال':'🎬 فیلم',`<div class="film-player-shell">${media}<div class="film-player-info"><span>${x.content_type==='series'?'SERIES':'MOVIE'}</span><h2>${esc(x.title)}</h2><p>${formatText(x.description||'توضیحی ثبت نشده است.')}</p><div class="film-meta"><b>${x.year||'—'}</b><b>${esc(x.genre||'عمومی')}</b>${x.duration_minutes?`<b>${x.duration_minutes} دقیقه</b>`:''}</div></div></div>`,()=>{});$('modalOk').classList.add('hidden');$('modalCancel').textContent='بستن';
}
'''
if 'async function openFilmCenter()' not in j:
    j=j.replace('function showArchivedChats()', film_js+'\nfunction showArchivedChats()')
# Home nav movies action
j=j.replace("else if(n==='movies'){leaveChatView();showToast('فیلم به‌زودی در دسترس است')}", "else if(n==='movies'){leaveChatView();openFilmCenter()}")
# Robust drawer handler: don't let closeDrawer happen before fn for modal actions, and add pointerdown fallback only for drawer
old="e.preventDefault();e.stopImmediatePropagation();closeDrawer();\n    try{await fn()}catch(err){showToast(err.message||'اجرای این گزینه ناموفق بود',true)}"
new="e.preventDefault();e.stopImmediatePropagation();\n    try{closeDrawer();await fn()}catch(err){showToast(err.message||'اجرای این گزینه ناموفق بود',true)}"
j=j.replace(old,new)
# add direct drawer pointerup fallback after robust handler block, but avoid duplicate via flag
needle="  ensureAdvancedDrawer();setTimeout(ensureAdvancedDrawer,400);setTimeout(ensureAdvancedDrawer,1200);"
extra=r'''
  // Final drawer click bridge for deployments where another UI layer captures click events.
  document.getElementById('drawer')?.addEventListener('pointerup',async e=>{
    const b=e.target.closest('button'); if(!b||b.dataset.bridgeDone==='1')return;
    b.dataset.bridgeDone='1'; setTimeout(()=>{try{delete b.dataset.bridgeDone}catch{}},250);
  },true);
'''
# We don't need extra action; avoid.

# Add admin film main section content and click handler by replacing placeholder
oldsec='<section id="saSectionFilm" class="sa-section-placeholder hidden"><h2>🎬 فیلم</h2><p>مدیریت فیلم و محتوای ویدیویی در این بخش قرار می‌گیرد.</p></section>'
newsec='<section id="saSectionFilm" class="sa-section-placeholder hidden"><div id="saFilmBody"></div></section>'
j=j.replace(oldsec,newsec)
# main section handler: film -> renderAdminFilms
j=j.replace("if(sec==='messenger'){$('saSectionMessenger')?.classList.remove('hidden');$('saBody')?.classList.remove('hidden')}else{$('saBody')?.classList.add('hidden')}", "if(sec==='messenger'){$('saSectionMessenger')?.classList.remove('hidden');$('saBody')?.classList.remove('hidden')}else{$('saBody')?.classList.add('hidden');if(sec==='film')renderAdminFilms()}")
# insert renderAdminFilms before shellTab
adminfilm=r'''
async function renderAdminFilms(){
  const host=$('saFilmBody');if(!host)return;host.innerHTML='<div class="sa-loading">در حال دریافت فیلم‌ها…</div>';
  try{const rows=await api('/api/admin/films');
    host.innerHTML=`<section class="sa-card sa-film-admin"><div class="sa-card-head"><div><b>🎬 مرکز فیلم و سریال</b><small>انتشار، ویرایش، فعال‌سازی و حذف محتوای ZENTO PLAY</small></div><button id="saFilmAdd" class="primary">＋ افزودن محتوا</button></div><div class="sa-list">${rows.map(x=>`<article class="sa-row sa-film-row"><div class="sa-film-mini">${x.poster_url?`<img src="${esc(backendUrl(x.poster_url))}">`:'🎬'}</div><div><b>${esc(x.title)}</b><small>${x.content_type==='series'?'📺 سریال':'🎬 فیلم'} · ${esc(x.genre||'عمومی')} · ${x.year||'—'}</small><small>${x.active?'🟢 منتشر شده':'⚪ مخفی'}${x.video_url?' · ▶ لینک پخش دارد':' · بدون لینک پخش'}</small></div><div class="sa-user-actions"><button data-film-edit="${x.id}">✏️ ویرایش</button><button data-film-toggle="${x.id}">${x.active?'مخفی کردن':'انتشار'}</button><button data-film-del="${x.id}" class="danger">🗑 حذف</button></div></article>`).join('')||'<div class="sa-empty">هنوز فیلم یا سریالی ثبت نشده است.</div>'}</div></section>`;
    const edit=async x=>{const v=await saDialog(x?'ویرایش محتوا':'افزودن فیلم / سریال',[{label:'عنوان',value:x?.title||''},{label:'نوع',type:'select',options:[{value:'movie',label:'فیلم'},{value:'series',label:'سریال'}],value:x?.content_type||'movie'},{label:'سال',type:'number',value:x?.year||''},{label:'ژانر',value:x?.genre||''},{label:'پوستر URL',value:x?.poster_url||''},{label:'ویدیو URL',value:x?.video_url||''},{label:'مدت (دقیقه)',type:'number',value:x?.duration_minutes||''},{label:'توضیحات',type:'textarea',value:x?.description||''}]);if(!v)return;const payload={title:v[0],content_type:v[1],year:v[2],genre:v[3],poster_url:v[4],video_url:v[5],duration_minutes:v[6],description:v[7],active:x?.active!==false};try{await api(x?'/api/admin/films/'+x.id:'/api/admin/films',{method:x?'PATCH':'POST',body:JSON.stringify(payload)});showToast(x?'محتوا ویرایش شد ✓':'محتوا منتشر شد ✓');renderAdminFilms()}catch(e){showToast(e.message,true)}};
    $('saFilmAdd').onclick=()=>edit();host.querySelectorAll('[data-film-edit]').forEach(b=>b.onclick=()=>edit(rows.find(x=>Number(x.id)===Number(b.dataset.filmEdit))));host.querySelectorAll('[data-film-toggle]').forEach(b=>b.onclick=async()=>{const x=rows.find(x=>Number(x.id)===Number(b.dataset.filmToggle));try{await api('/api/admin/films/'+x.id,{method:'PATCH',body:JSON.stringify({title:x.title,content_type:x.content_type,year:x.year,genre:x.genre,poster_url:x.poster_url,video_url:x.video_url,duration_minutes:x.duration_minutes,description:x.description,active:!x.active})});renderAdminFilms()}catch(e){showToast(e.message,true)}});host.querySelectorAll('[data-film-del]').forEach(b=>b.onclick=async()=>{if(!await saConfirm('حذف محتوا','این فیلم/سریال حذف شود؟',true))return;try{await api('/api/admin/films/'+b.dataset.filmDel,{method:'DELETE'});renderAdminFilms()}catch(e){showToast(e.message,true)}});
  }catch(e){host.innerHTML=`<div class="sa-empty">${esc(e.message)}</div>`}
}
'''
if 'async function renderAdminFilms()' not in j:
    j=j.replace('function shellTab(tab)', adminfilm+'\nfunction shellTab(tab)')
# admin permissions map
j=j.replace("broadcast:'admins',announcements:'admins',controls:'admins'", "broadcast:'admins',announcements:'admins',controls:'admins',films:'admins'")
app.write_text(j)

# HTML version and menu add film direct entry? Keep home nav.
h=idx.read_text()
h=h.replace('Zento · v4.31.18 · Premium Messenger','Zento · v4.31.19 · Premium Messenger')
# Add a Film drawer item near AI group
needle='<button id="stage4BotsBtn" type="button" class="stage4-drawer-entry"><em class="drawer-icon">🤖</em><span>مرکز ربات‌ها</span><i class="drawer-arrow">‹</i></button>'
if 'id="drawerFilm"' not in h:
    h=h.replace(needle, needle+'\n      <button id="drawerFilm" type="button" class="stage4-drawer-entry film-entry"><em class="drawer-icon">🎬</em><span>ZENTO PLAY · فیلم و سریال</span><i class="drawer-arrow">‹</i></button>')
idx.write_text(h)

# Add drawerFilm action in app
j=app.read_text()
j=j.replace("stage4AiBtn:()=>aiModal()", "stage4AiBtn:()=>aiModal(),\n      drawerFilm:()=>openFilmCenter()")
j=j.replace("bind('drawerAvatar',()=>openProfile());", "bind('drawerAvatar',()=>openProfile());\n    bind('drawerFilm',()=>openFilmCenter());")
app.write_text(j)

# CSS append premium modern overhaul
c=css.read_text()
modern=r'''
/* ===== ZENTO v4.31.19 — Neo Premium Visual System ===== */
:root{--z-blue:#3390ec;--z-violet:#7658f5;--z-cyan:#21d4fd;--z-pink:#ff4ecd;--z-orange:#ff9d42;--z-green:#36e39a;--z-bg:#edf4ff}
body{background:radial-gradient(circle at 8% 5%,rgba(51,144,236,.13),transparent 28%),radial-gradient(circle at 92% 8%,rgba(118,88,245,.13),transparent 30%),linear-gradient(135deg,#eef6ff 0%,#f8f7ff 48%,#fff4fb 100%);}
body:before{content:'';position:fixed;inset:-20%;pointer-events:none;background:conic-gradient(from 120deg,transparent,rgba(33,212,253,.045),transparent 30%,rgba(255,78,205,.04),transparent 55%);animation:zentoAurora 18s linear infinite;z-index:-1}
@keyframes zentoAurora{to{transform:rotate(360deg)}}
.sidebar,.chat{background:rgba(255,255,255,.62)!important;backdrop-filter:blur(24px) saturate(135%)}
.sidebar{border-inline-end:1px solid rgba(100,130,170,.14)!important;box-shadow:18px 0 55px rgba(60,80,120,.08)}
.chat-head{background:linear-gradient(90deg,rgba(255,255,255,.82),rgba(239,246,255,.7),rgba(255,242,251,.72))!important;border-bottom:1px solid rgba(100,130,170,.13)!important;box-shadow:0 8px 35px rgba(45,75,115,.07)}
.messages-wrap{background:radial-gradient(circle at 20% 20%,rgba(33,212,253,.055),transparent 26%),radial-gradient(circle at 80% 75%,rgba(255,78,205,.05),transparent 28%)}
.bubble-row{animation:zentoMsgIn .34s cubic-bezier(.2,.8,.2,1) both}.bubble{box-shadow:0 10px 30px rgba(42,65,100,.07)!important;border:1px solid rgba(130,155,185,.10)!important}
@keyframes zentoMsgIn{from{opacity:0;transform:translateY(10px) scale(.985)}to{opacity:1;transform:none}}
.composer{background:rgba(255,255,255,.82)!important;border:1px solid rgba(70,120,190,.15)!important;box-shadow:0 15px 45px rgba(35,70,115,.13),0 0 0 5px rgba(51,144,236,.025)!important;backdrop-filter:blur(20px);transition:.25s}.composer:focus-within{transform:translateY(-2px);border-color:rgba(118,88,245,.3)!important;box-shadow:0 20px 55px rgba(75,85,180,.16),0 0 0 6px rgba(118,88,245,.06)!important}
.send{background:linear-gradient(135deg,var(--z-blue),var(--z-violet),var(--z-pink))!important;box-shadow:0 9px 24px rgba(102,82,230,.28)!important}
.drawer-ai-group .film-entry{background:linear-gradient(135deg,rgba(255,157,66,.09),rgba(255,78,205,.07))!important;border-color:rgba(255,157,66,.15)!important}.film-entry .drawer-icon{background:linear-gradient(135deg,rgba(255,157,66,.18),rgba(255,78,205,.13))!important}
/* Premium support */
.premium-support{padding:0 2px 8px}.premium-support-hero{position:relative;overflow:hidden;display:flex;align-items:center;gap:15px;padding:22px;border-radius:26px;background:linear-gradient(135deg,#101d3d,#3a3b9b 52%,#9c3bc6);color:#fff;box-shadow:0 20px 55px rgba(53,53,135,.28);margin-bottom:14px}.premium-support-hero:after{content:'';position:absolute;width:190px;height:190px;border-radius:50%;right:-80px;top:-90px;background:rgba(255,255,255,.12);filter:blur(2px)}.support-hero-orb{width:58px;height:58px;flex:0 0 58px;border-radius:20px;display:grid;place-items:center;font-size:26px;background:linear-gradient(135deg,#35d7ff,#8065ff,#ff56cf);box-shadow:0 0 0 6px rgba(255,255,255,.08),0 12px 35px rgba(0,0,0,.22)}.support-hero-copy{position:relative;z-index:2;display:grid;gap:3px}.support-kicker{font-size:8px;letter-spacing:2px;opacity:.72;direction:ltr}.support-hero-copy b{font-size:19px}.support-hero-copy small{opacity:.78;font-size:10px;line-height:1.8}.support-live{margin-inline-start:auto;align-self:flex-start;display:flex;align-items:center;gap:6px;padding:7px 10px;border-radius:999px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.15);font-size:9px;position:relative;z-index:2}.support-live i{width:7px;height:7px;border-radius:50%;background:#54f4a4;box-shadow:0 0 14px #54f4a4}.support-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin:10px 0 16px}.support-stats>div{padding:14px;border-radius:18px;background:linear-gradient(145deg,rgba(255,255,255,.92),rgba(241,247,255,.72));border:1px solid rgba(100,135,180,.12);box-shadow:0 9px 25px rgba(45,75,115,.07);text-align:center}.support-stats b{display:block;font-size:19px;background:linear-gradient(135deg,var(--z-blue),var(--z-violet),var(--z-pink));-webkit-background-clip:text;color:transparent}.support-stats small{font-size:9px;color:var(--muted)}.support-section-title{display:flex;align-items:center;justify-content:space-between;margin:14px 2px 8px}.support-section-title b{display:block;font-size:12px}.support-section-title small{display:block;color:var(--muted);font-size:9px;margin-top:2px}.premium-ticket{width:100%;display:flex;align-items:center;gap:10px;padding:12px!important;margin:6px 0!important;border-radius:17px!important;background:rgba(255,255,255,.72)!important;border:1px solid rgba(100,135,180,.12)!important;box-shadow:0 7px 20px rgba(45,75,115,.05)!important;text-align:right}.premium-ticket:hover{transform:translateY(-2px)!important;box-shadow:0 13px 30px rgba(55,80,130,.10)!important}.support-ticket-icon{width:38px;height:38px;display:grid;place-items:center;border-radius:13px;background:linear-gradient(135deg,rgba(51,144,236,.13),rgba(118,88,245,.12));font-size:18px}.premium-ticket>div{flex:1}.premium-ticket b,.premium-ticket small{display:block}.premium-ticket b{font-size:11px}.premium-ticket small{font-size:8px;color:var(--muted);margin-top:4px}.premium-ticket>i{font-style:normal;color:var(--z-violet);font-size:22px}.support-composer-card{padding:16px;border-radius:22px;background:linear-gradient(145deg,rgba(255,255,255,.9),rgba(247,249,255,.78));border:1px solid rgba(100,135,180,.12);box-shadow:0 12px 30px rgba(45,75,115,.07)}.support-tabs{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-bottom:12px}.support-tabs button{padding:10px 6px;border-radius:13px;background:rgba(235,242,252,.75);font-size:9px;border:1px solid transparent}.support-tabs button.active{background:linear-gradient(135deg,rgba(51,144,236,.15),rgba(118,88,245,.16));border-color:rgba(118,88,245,.18);color:#5e4ac8;font-weight:800}.support-composer-card label{display:block;font-size:10px;margin:8px 0}.support-composer-card input,.support-composer-card textarea,.support-composer-card select{width:100%;margin-top:5px;border-radius:14px!important}.support-composer-card textarea{min-height:110px;resize:vertical}.support-send-btn{width:100%;height:48px!important;margin-top:8px;border-radius:15px!important;background:linear-gradient(135deg,var(--z-blue),var(--z-violet),var(--z-pink))!important;box-shadow:0 12px 28px rgba(102,82,230,.23)}
/* Film */
.film-center{padding:2px}.film-hero{display:flex;gap:14px;align-items:center;padding:20px;border-radius:25px;background:linear-gradient(135deg,#111b3d,#3557b9 48%,#d13a9b);color:#fff;box-shadow:0 20px 55px rgba(54,63,150,.22);overflow:hidden;position:relative}.film-hero:after{content:'';position:absolute;width:220px;height:220px;border-radius:50%;right:-100px;top:-100px;background:rgba(255,255,255,.1)}.film-hero-orb{width:54px;height:54px;border-radius:18px;display:grid;place-items:center;background:linear-gradient(135deg,#35d7ff,#7d68ff,#ff55c8);font-size:24px;box-shadow:0 10px 30px rgba(0,0,0,.2)}.film-hero b,.film-hero small,.film-hero span{display:block;position:relative;z-index:2}.film-hero b{font-size:18px;margin:3px 0}.film-hero span{font-size:8px;letter-spacing:2px;opacity:.7}.film-hero small{font-size:9px;opacity:.78}.film-filter{display:flex;gap:7px;margin:13px 0}.film-filter button{padding:9px 14px;border-radius:999px;background:rgba(230,238,250,.7);font-size:9px}.film-filter button.active{background:linear-gradient(135deg,var(--z-blue),var(--z-violet));color:#fff;box-shadow:0 8px 20px rgba(80,90,200,.2)}.film-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}.film-card{overflow:hidden;border-radius:19px;background:rgba(255,255,255,.84);border:1px solid rgba(100,135,180,.12);box-shadow:0 10px 28px rgba(45,75,115,.08);text-align:right;transition:.22s}.film-card:hover{transform:translateY(-5px) scale(1.01);box-shadow:0 18px 38px rgba(55,75,135,.15)}.film-poster{height:205px;position:relative;background:linear-gradient(135deg,#172544,#5c4bc5,#d442a2);display:grid;place-items:center;color:#fff;font-size:35px}.film-poster img{width:100%;height:100%;object-fit:cover}.film-poster i{position:absolute;top:9px;right:9px;padding:5px 7px;border-radius:8px;background:rgba(5,12,28,.55);backdrop-filter:blur(8px);font-style:normal;font-size:7px;letter-spacing:1px}.film-card-copy{padding:10px}.film-card-copy b,.film-card-copy small{display:block}.film-card-copy b{font-size:11px}.film-card-copy small{font-size:8px;color:var(--muted);margin-top:4px}.film-player-shell{display:grid;gap:12px}.film-player{width:100%;max-height:58vh;border-radius:18px;background:#080d18}.film-player-info{padding:15px;border-radius:18px;background:linear-gradient(145deg,rgba(242,247,255,.9),rgba(255,243,250,.82));border:1px solid rgba(100,135,180,.12)}.film-player-info>span{font-size:8px;letter-spacing:2px;color:var(--z-violet)}.film-player-info h2{margin:5px 0}.film-player-info p{font-size:11px;line-height:1.9}.film-meta{display:flex;gap:7px;flex-wrap:wrap}.film-meta b{padding:6px 9px;border-radius:999px;background:rgba(51,144,236,.08);font-size:8px}.sa-film-admin{min-height:500px}.sa-film-row{align-items:center}.sa-film-mini{width:54px;height:72px;border-radius:11px;overflow:hidden;display:grid;place-items:center;background:linear-gradient(135deg,#1a2748,#705de1,#d849a5);color:#fff;font-size:22px;flex:0 0 54px}.sa-film-mini img{width:100%;height:100%;object-fit:cover}
@media(max-width:700px){.premium-support-hero{padding:17px}.support-stats{gap:6px}.film-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.film-poster{height:170px}}
body.dark{background:radial-gradient(circle at 15% 10%,rgba(51,144,236,.12),transparent 28%),radial-gradient(circle at 90% 15%,rgba(255,78,205,.10),transparent 30%),#09111d}.dark .film-card,body.dark .film-card,.dark .support-composer-card,body.dark .support-composer-card{background:rgba(18,29,43,.82);border-color:rgba(130,160,190,.13)}
'''
if 'ZENTO v4.31.19 — Neo Premium Visual System' not in c:
    c += '\n'+modern
css.write_text(c)

# Version/cache
(root/'VERSION.txt').write_text('4.31.19\n')
import json
pkg=json.loads((root/'package.json').read_text());pkg['version']='4.31.19';(root/'package.json').write_text(json.dumps(pkg,ensure_ascii=False,indent=2)+'\n')
sw=root/'public/sw.js'; swt=sw.read_text(); swt=re.sub(r'v4\.31\.\d+', 'v4.31.19', swt); swt=re.sub(r'v11\d+', 'v119', swt); sw.write_text(swt)
# cache bust app.js in index
h=idx.read_text();h=re.sub(r'app\.js\?v=\d+', 'app.js?v=119', h);idx.write_text(h)
