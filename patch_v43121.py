from pathlib import Path
import re
root=Path('/mnt/data/zento_43120_work')
server=(root/'server.js').read_text()
app=(root/'public/app.js').read_text()
index=(root/'public/index.html').read_text()
css=(root/'public/style.css').read_text()

# 1) Remove Film from sidebar/drawer. Keep Film only in bottom navigation.
index=index.replace('<button id="drawerFilm" type="button" class="stage4-drawer-entry film-entry"><em class="drawer-icon">🎬</em><span>ZENTO PLAY · فیلم و سریال</span><i class="drawer-arrow">‹</i></button>\n','')
index=index.replace('<nav class="mobile-home-nav" aria-label="ناوبری اصلی"><button data-home-nav="movies"><span>◉</span><small>فیلم</small></button><button data-home-nav="showcase"><span>▦</span><small>ویترین</small></button><button data-home-nav="zino"><span>✦</span><small>زینو</small></button><button class="active" data-home-nav="chats"><span>✉</span><small>پیام‌رسان</small></button><button data-home-nav="games"><span>♟</span><small>بازی</small></button><button data-home-nav="home"><span>⌂</span><small>خانه</small></button></nav>',
'''<nav class="mobile-home-nav zento-bottom-nav" aria-label="ناوبری اصلی"><button data-home-nav="movies"><span>◉</span><small>فیلم</small></button><button data-home-nav="showcase"><span>▦</span><small>ویترین</small></button><button data-home-nav="zino"><span>✦</span><small>زینو</small></button><button class="active" data-home-nav="chats"><span>✉</span><small>پیام‌رسان</small></button><button data-home-nav="home"><span>⌂</span><small>خانه</small></button></nav>''')

# 2) Remove old drawer film hardening binding.
app=app.replace("    bind('drawerFilm',()=>openFilmCenter());\n","")
app=app.replace("    bind('drawerFilm',()=>openFilmCenter());","")
# Prevent legacy restore logic from recreating film drawer entries if any older code is cached.
app=app.replace("  ensureAdvancedDrawer();setTimeout(ensureAdvancedDrawer,400);setTimeout(ensureAdvancedDrawer,1200);", "  ensureAdvancedDrawer();setTimeout(ensureAdvancedDrawer,400);setTimeout(ensureAdvancedDrawer,1200);\n  document.getElementById('drawerFilm')?.remove();")

# 3) Replace home-nav handler to use full-screen film experience.
old="$('newChatMenu').onclick=()=>newMenu();$('menuBtn').onclick=openDrawer;$('mobileMenu').onclick=()=>{$('sidebar').classList.toggle('open')};$('backToChats').onclick=()=>leaveChatView();document.querySelectorAll('[data-home-nav]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[data-home-nav]').forEach(x=>x.classList.toggle('active',x===b));const n=b.dataset.homeNav;if(n==='chats'||n==='home'){leaveChatView()}else if(n==='zino'){leaveChatView();showToast('زینو به‌زودی در دسترس است')}else if(n==='games'){leaveChatView();showToast('بازی‌ها به‌زودی در دسترس است')}else if(n==='showcase'){leaveChatView();showToast('ویترین به‌زودی در دسترس است')}else if(n==='movies'){leaveChatView();openFilmCenter()}});"
new="""$('newChatMenu').onclick=()=>newMenu();$('menuBtn').onclick=openDrawer;$('mobileMenu').onclick=()=>{$('sidebar').classList.toggle('open')};$('backToChats').onclick=()=>leaveChatView();document.querySelectorAll('[data-home-nav]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[data-home-nav]').forEach(x=>x.classList.toggle('active',x===b));const n=b.dataset.homeNav;if(n==='movies'){enterFilmExperience()}else if(n==='chats'||n==='home'){exitFilmExperience();leaveChatView()}else if(n==='zino'){exitFilmExperience();leaveChatView();showToast('زینو به‌زودی در دسترس است')}else if(n==='showcase'){exitFilmExperience();leaveChatView();showToast('ویترین به‌زودی در دسترس است')}});"""
if old not in app:
    raise SystemExit('home nav pattern not found')
app=app.replace(old,new)

# 4) Replace film center/player functions with a full-screen experience + custom player.
start=app.index('async function openFilmCenter(){')
end=app.index('\nfunction showArchivedChats()', start)
new_funcs=r'''function filmEscape(s){return esc(s||'')}
let filmExperienceActive=false;
let filmRowsCache=[];
function exitFilmExperience(){
  const root=$('filmExperience');
  const player=$('filmPlayerOverlay');
  try{player?.remove();}catch{}
  if(root){root.classList.remove('is-open');setTimeout(()=>root.remove(),180)}
  filmExperienceActive=false;
  document.body.classList.remove('film-experience-mode');
  $('app')?.classList.remove('film-host-hidden');
  document.querySelectorAll('[data-home-nav]').forEach(x=>x.classList.toggle('active',x.dataset.homeNav==='chats'));
}
function filmCardMarkup(x){
  const poster=x.poster_url?`<img src="${esc(backendUrl(x.poster_url))}" loading="lazy" alt="${filmEscape(x.title)}">`:'<div class="film-poster-fallback">🎬</div>';
  return `<button type="button" class="zento-film-card" data-film-id="${x.id}"><div class="zento-film-poster">${poster}<span class="zento-film-badge">${x.content_type==='series'?'SERIES':'MOVIE'}</span><span class="zento-film-play">▶</span></div><div class="zento-film-copy"><b>${filmEscape(x.title)}</b><small>${filmEscape(x.genre||'عمومی')} ${x.year?`· ${x.year}`:''}</small></div></button>`;
}
function filmSection(title,items,cls=''){
  if(!items.length)return '';
  return `<section class="zento-film-section ${cls}"><div class="zento-film-section-head"><h2>${title}</h2><button type="button" class="zento-film-see" data-film-see="${cls||'all'}">مشاهده همه <span>‹</span></button></div><div class="zento-film-row">${items.map(filmCardMarkup).join('')}</div></section>`;
}
async function enterFilmExperience(){
  if(filmExperienceActive){$('filmExperience')?.scrollTo({top:0,behavior:'smooth'});return;}
  closeDrawer();
  $('app')?.classList.add('film-host-hidden');
  document.body.classList.add('film-experience-mode');
  filmExperienceActive=true;
  const old=$('filmExperience');old?.remove();
  const root=document.createElement('div');root.id='filmExperience';root.className='film-experience';
  root.innerHTML=`<div class="film-app-shell"><header class="film-app-top"><button id="filmBackMessenger" class="film-back-btn" type="button" aria-label="بازگشت به پیامرسان">⌂</button><div class="film-brand"><div class="film-brand-mark">Z</div><div><b>ZENTO PLAY</b><small>فیلم و سریال</small></div></div><div class="film-search-wrap"><span>⌕</span><input id="filmSearchInput" placeholder="جستجوی فیلم، سریال و ..."><button id="filmSearchMic" type="button">🎙</button></div><button id="filmMenuBtn" class="film-menu-btn" type="button">☰</button></header><main id="filmExperienceBody" class="film-experience-body"><div class="film-loading-state"><div class="film-loading-orb">✦</div><b>در حال آماده‌سازی ZENTO PLAY</b><small>فیلم‌ها و سریال‌های منتخب در حال بارگذاری هستند…</small></div></main><nav class="film-bottom-nav"><button class="active" data-film-nav="movies"><span>▣</span><small>فیلم</small></button><button data-film-nav="showcase"><span>▦</span><small>ویترین</small></button><button data-film-nav="zino"><span>✦</span><small>زینو</small></button><button data-film-nav="messenger"><span>✉</span><small>پیام‌رسان</small></button><button data-film-nav="home"><span>⌂</span><small>خانه</small></button></nav></div>`;
  document.body.appendChild(root);
  requestAnimationFrame(()=>root.classList.add('is-open'));
  $('filmBackMessenger').onclick=exitFilmExperience;
  $('filmMenuBtn').onclick=()=>showToast('دسته‌بندی‌ها و امکانات ZENTO PLAY به‌زودی در این منو قرار می‌گیرند');
  document.querySelectorAll('[data-film-nav]').forEach(b=>b.onclick=()=>{const n=b.dataset.filmNav;if(n==='messenger'||n==='home'){exitFilmExperience();leaveChatView()}else if(n==='movies'){root.scrollTo({top:0,behavior:'smooth'})}else showToast(n==='showcase'?'ویترین به‌زودی در دسترس است':'زینو به‌زودی در دسترس است')});
  $('filmSearchInput').oninput=()=>renderFilmExperience(filmRowsCache,$('filmSearchInput').value.trim());
  try{filmRowsCache=await api('/api/films');renderFilmExperience(filmRowsCache,'');}catch(e){$('filmExperienceBody').innerHTML=`<div class="film-error-state"><b>بارگذاری فیلم و سریال ناموفق بود</b><small>${filmEscape(e.message)}</small><button id="filmRetry" type="button">تلاش دوباره</button></div>`;$('filmRetry').onclick=()=>enterFilmExperience()}
}
function renderFilmExperience(rows,query=''){
  const body=$('filmExperienceBody');if(!body)return;
  const q=String(query||'').toLowerCase();const filtered=rows.filter(x=>!q||`${x.title} ${x.genre||''} ${x.year||''}`.toLowerCase().includes(q));
  const featured=filtered[0];const movies=filtered.filter(x=>x.content_type==='movie');const series=filtered.filter(x=>x.content_type==='series');
  const picks=filtered.slice(0,8);const genres=[...new Set(filtered.map(x=>x.genre).filter(Boolean))].slice(0,8);
  const hero=featured?`<section class="zento-film-hero" style="${featured.poster_url?`background-image:linear-gradient(90deg,rgba(5,8,18,.98) 8%,rgba(5,8,18,.72) 48%,rgba(5,8,18,.18)),url('${esc(backendUrl(featured.poster_url))}')`:''}"><div class="zento-film-hero-content"><span class="hero-kicker">ZENTO ORIGINAL · ${featured.content_type==='series'?'SERIES':'MOVIE'}</span><h1>${filmEscape(featured.title)}</h1><p>${filmEscape(featured.description||'بهترین فیلم‌ها و سریال‌های زنتو را با یک تجربه مدرن تماشا کنید.')}</p><div class="hero-meta"><b>${featured.year||'جدید'}</b><b>${filmEscape(featured.genre||'عمومی')}</b>${featured.duration_minutes?`<b>${featured.duration_minutes} دقیقه</b>`:''}</div><div class="hero-actions"><button class="hero-play" data-film-id="${featured.id}">▶ پخش</button><button class="hero-info" data-film-id="${featured.id}">＋ جزئیات</button></div></div></section>`:`<section class="zento-film-empty-hero"><div><b>دنیای ZENTO PLAY</b><small>هنوز محتوایی منتشر نشده است.</small></div></section>`;
  body.innerHTML=hero+filmSection('ویژه‌ها',picks,'featured')+filmSection('به سلیقه شما',filtered.slice(0,10),'for-you')+filmSection('فیلم‌ها',movies,'movies')+filmSection('سریال‌ها',series,'series')+(genres.length?`<section class="zento-film-section"><div class="zento-film-section-head"><h2>شبکه‌ها</h2></div><div class="zento-genre-row">${genres.map(g=>`<button type="button" data-film-genre="${filmEscape(g)}"><span>✦</span><b>${filmEscape(g)}</b><small>${filtered.filter(x=>x.genre===g).length} عنوان</small></button>`).join('')}</div></section>`:'');
  body.querySelectorAll('[data-film-id]').forEach(b=>b.onclick=()=>{const x=rows.find(r=>Number(r.id)===Number(b.dataset.filmId));if(x)openFilmPlayer(x)});
  body.querySelectorAll('[data-film-genre]').forEach(b=>b.onclick=()=>{const g=b.dataset.filmGenre;renderFilmExperience(rows.filter(x=>x.genre===g),q)});
}
function closeFilmPlayer(){
  const ov=$('filmPlayerOverlay');const v=$('zentoFilmVideo');if(v){try{v.pause()}catch{}}
  ov?.classList.remove('is-open');setTimeout(()=>ov?.remove(),180);
}
function openFilmPlayer(x){
  closeFilmPlayer();
  const ov=document.createElement('div');ov.id='filmPlayerOverlay';ov.className='film-player-overlay';
  const poster=x.poster_url?esc(backendUrl(x.poster_url)):'';
  ov.innerHTML=`<div class="film-player-card"><button id="filmPlayerClose" class="film-player-close" type="button">×</button><div class="film-player-video-wrap"><video id="zentoFilmVideo" preload="metadata" playsinline poster="${poster}" src="${esc(backendUrl(x.video_url||''))}"></video><div class="film-player-center"><button id="filmPlayerCenterPlay" type="button">▶</button></div><div class="film-player-gradient"></div></div><div class="film-player-bar"><div class="film-player-title"><span>${x.content_type==='series'?'SERIES':'MOVIE'}</span><b>${filmEscape(x.title)}</b></div><input id="filmPlayerSeek" class="film-player-seek" type="range" min="0" max="100" value="0"><div class="film-player-actions"><button id="filmPlayerPlay" type="button">▶</button><button id="filmPlayerMute" type="button">🔊</button><button id="filmPlayerSpeed" type="button">1×</button><button id="filmPlayerFull" type="button">⛶</button></div></div><div class="film-player-info-panel"><div><b>${filmEscape(x.title)}</b><small>${x.year||'جدید'} · ${filmEscape(x.genre||'عمومی')}${x.duration_minutes?` · ${x.duration_minutes} دقیقه`:''}</small></div><p>${filmEscape(x.description||'')}</p></div></div>`;
  document.body.appendChild(ov);requestAnimationFrame(()=>ov.classList.add('is-open'));
  const v=$('zentoFilmVideo');const play=$('filmPlayerPlay');const center=$('filmPlayerCenterPlay');const seek=$('filmPlayerSeek');const mute=$('filmPlayerMute');const speed=$('filmPlayerSpeed');
  $('filmPlayerClose').onclick=closeFilmPlayer;
  const toggle=()=>{if(!v)return;if(v.paused)v.play().catch(()=>{});else v.pause()};play.onclick=toggle;center.onclick=toggle;
  v.addEventListener('play',()=>{play.textContent='⏸';center.textContent='⏸'});v.addEventListener('pause',()=>{play.textContent='▶';center.textContent='▶'});
  v.addEventListener('timeupdate',()=>{seek.value=v.duration?((v.currentTime/v.duration)*100):0});seek.oninput=()=>{if(v.duration)v.currentTime=(Number(seek.value)/100)*v.duration};
  mute.onclick=()=>{v.muted=!v.muted;mute.textContent=v.muted?'🔇':'🔊'};
  speed.onclick=()=>{const speeds=[1,1.25,1.5,1.75,2];const i=speeds.indexOf(v.playbackRate);const n=speeds[(i+1)%speeds.length];v.playbackRate=n;speed.textContent=n+'×'};
  $('filmPlayerFull').onclick=()=>{(v.requestFullscreen?v:$('filmPlayerOverlay')).requestFullscreen?.().catch(()=>{})};
  ov.addEventListener('click',e=>{if(e.target===ov)closeFilmPlayer()});
  document.addEventListener('keydown',function filmKey(e){if(!document.body.contains(ov)){document.removeEventListener('keydown',filmKey);return}if(e.key==='Escape')closeFilmPlayer();if(e.code==='Space'&&document.activeElement!==seek){e.preventDefault();toggle()}});
  if(!x.video_url){v.removeAttribute('src');center.disabled=true;play.disabled=true;ov.querySelector('.film-player-video-wrap').classList.add('no-video');ov.querySelector('.film-player-video-wrap').insertAdjacentHTML('beforeend','<div class="film-no-video-premium">🎞️ ویدیوی این محتوا هنوز برای پخش ثبت نشده است.</div>')}
}
'''
app=app[:start]+new_funcs+app[end:]

# 5) Admin film editor: replace current renderAdminFilms with upload-enabled modern UI.
start=app.index('async function renderAdminFilms(){')
end=app.index('\nfunction shellTab', start)
new_admin=r'''async function uploadFilmAsset(file,kind){
  if(!file)return null;
  const fd=new FormData();fd.append('file',file);fd.append('kind',kind);
  const out=await api('/api/admin/films/upload',{method:'POST',body:fd});
  return out.url;
}
async function renderAdminFilms(){
  const host=$('saFilmBody');if(!host)return;host.innerHTML='<div class="sa-loading">در حال دریافت فیلم‌ها…</div>';
  try{
    const rows=await api('/api/admin/films');
    const poster=x=>x.poster_url?`<img src="${esc(backendUrl(x.poster_url))}" alt="">`:'🎬';
    host.innerHTML=`<section class="sa-card sa-film-admin sa-film-admin-pro"><div class="sa-card-head"><div><span class="sa-film-kicker">ZENTO PLAY · CONTENT STUDIO</span><b>🎬 مرکز حرفه‌ای فیلم و سریال</b><small>آپلود پوستر و ویدیو، انتشار، ویرایش، مدیریت وضعیت و آماده‌سازی محتوا برای ZENTO PLAY</small></div><button id="saFilmAdd" class="primary sa-film-add-btn">＋ افزودن محتوا</button></div><div class="sa-film-admin-stats"><div><b>${rows.length}</b><small>کل محتوا</small></div><div><b>${rows.filter(x=>x.content_type==='movie').length}</b><small>فیلم</small></div><div><b>${rows.filter(x=>x.content_type==='series').length}</b><small>سریال</small></div><div><b>${rows.filter(x=>x.active).length}</b><small>منتشر شده</small></div></div><div class="sa-list sa-film-list">${rows.map(x=>`<article class="sa-row sa-film-row sa-film-row-pro"><div class="sa-film-mini">${poster(x)}</div><div class="sa-film-row-copy"><b>${esc(x.title)}</b><small>${x.content_type==='series'?'📺 سریال':'🎬 فیلم'} · ${esc(x.genre||'عمومی')} · ${x.year||'—'}</small><small>${x.active?'🟢 منتشر شده':'⚪ مخفی'} · ${x.poster_url?'🖼️ پوستر':'◻️ بدون پوستر'} · ${x.video_url?'▶️ ویدیو آماده':'◻️ بدون ویدیو'}</small></div><div class="sa-user-actions"><button data-film-edit="${x.id}">✏️ ویرایش</button><button data-film-toggle="${x.id}">${x.active?'مخفی کردن':'انتشار'}</button><button data-film-del="${x.id}" class="danger">🗑 حذف</button></div></article>`).join('')||'<div class="sa-empty">هنوز فیلم یا سریالی ثبت نشده است.</div>'}</div></section>`;
    const edit=async x=>{
      const html=`<div class="film-admin-editor"><div class="film-editor-hero"><div class="film-editor-icon">🎬</div><div><b>${x?'ویرایش محتوا':'انتشار فیلم / سریال'}</b><small>پوستر و ویدیو را مستقیم آپلود کن؛ لینک دستی هم همچنان قابل استفاده است.</small></div></div><div class="film-editor-grid"><label>عنوان<input id="filmEditTitle" value="${esc(x?.title||'')}" maxlength="160"></label><label>نوع<select id="filmEditType"><option value="movie" ${x?.content_type==='movie'?'selected':''}>🎬 فیلم</option><option value="series" ${x?.content_type==='series'?'selected':''}>📺 سریال</option></select></label><label>سال<input id="filmEditYear" type="number" value="${x?.year||''}"></label><label>ژانر<input id="filmEditGenre" value="${esc(x?.genre||'')}" maxlength="120"></label><label>مدت (دقیقه)<input id="filmEditDuration" type="number" value="${x?.duration_minutes||''}"></label></div><div class="film-upload-grid"><div class="film-upload-box"><div class="film-upload-icon">🖼️</div><b>پوستر</b><small>JPG / PNG / WEBP / GIF</small><input id="filmPosterFile" type="file" accept="image/jpeg,image/png,image/webp,image/gif"><input id="filmPosterUrl" placeholder="یا لینک مستقیم پوستر" value="${esc(x?.poster_url||'')}"><div class="film-upload-preview" id="filmPosterPreview">${x?.poster_url?`<img src="${esc(backendUrl(x.poster_url))}">`:'پیش‌نمایش پوستر'}</div></div><div class="film-upload-box"><div class="film-upload-icon">🎞️</div><b>ویدیو</b><small>MP4 / WEBM / MOV / OGG</small><input id="filmVideoFile" type="file" accept="video/mp4,video/webm,video/quicktime,video/ogg"><input id="filmVideoUrl" placeholder="یا لینک مستقیم ویدیو" value="${esc(x?.video_url||'')}"><div class="film-video-file-name" id="filmVideoFileName">${x?.video_url?'ویدیوی ثبت‌شده آماده است':'هنوز ویدیویی انتخاب نشده'}</div></div></div><label>توضیحات<textarea id="filmEditDescription" maxlength="5000" placeholder="خلاصه داستان، معرفی یا توضیحات…">${esc(x?.description||'')}</textarea><div class="film-editor-status" id="filmEditorStatus">${x?.active===false?'⚪ این محتوا مخفی است':'🟢 این محتوا پس از ذخیره منتشر می‌شود'}</div><div class="film-editor-actions"><button id="filmEditorCancel" class="secondary">لغو</button><button id="filmEditorSave" class="primary">💾 ذخیره و انتشار</button></div></div>`;
      openModal(x?'✏️ ویرایش ZENTO PLAY':'🎬 افزودن به ZENTO PLAY',html,()=>{});$('modalOk').classList.add('hidden');$('modalCancel').classList.add('hidden');
      const pf=$('filmPosterFile'),vf=$('filmVideoFile');pf.onchange=()=>{const f=pf.files?.[0];if(f){$('filmPosterPreview').innerHTML=`<img src="${URL.createObjectURL(f)}">`}};vf.onchange=()=>{const f=vf.files?.[0];$('filmVideoFileName').textContent=f?`📁 ${f.name} · ${(f.size/1024/1024).toFixed(1)}MB`:'هنوز ویدیویی انتخاب نشده'};
      $('filmEditorCancel').onclick=closeModal;
      $('filmEditorSave').onclick=async()=>{const btn=$('filmEditorSave');try{const title=$('filmEditTitle').value.trim();if(!title)return showToast('عنوان محتوا الزامی است',true);btn.disabled=true;btn.textContent='⏳ در حال آماده‌سازی…';let poster=$('filmPosterUrl').value.trim(),video=$('filmVideoUrl').value.trim();if(pf.files?.[0]){btn.textContent='⬆️ در حال آپلود پوستر…';poster=await uploadFilmAsset(pf.files[0],'poster')}if(vf.files?.[0]){btn.textContent='⬆️ در حال آپلود ویدیو…';video=await uploadFilmAsset(vf.files[0],'video')}const payload={title,content_type:$('filmEditType').value,year:$('filmEditYear').value,genre:$('filmEditGenre').value,poster_url:poster,video_url:video,duration_minutes:$('filmEditDuration').value,description:$('filmEditDescription').value,active:x?.active!==false};btn.textContent='💾 در حال ذخیره…';await api(x?'/api/admin/films/'+x.id:'/api/admin/films',{method:x?'PATCH':'POST',body:JSON.stringify(payload)});closeModal();showToast(x?'محتوا ویرایش شد ✓':'محتوا منتشر شد ✓');renderAdminFilms()}catch(e){showToast(e.message,true);btn.disabled=false;btn.textContent='💾 ذخیره و انتشار'}};
    };
    $('saFilmAdd').onclick=()=>edit();host.querySelectorAll('[data-film-edit]').forEach(b=>b.onclick=()=>edit(rows.find(x=>Number(x.id)===Number(b.dataset.filmEdit))));host.querySelectorAll('[data-film-toggle]').forEach(b=>b.onclick=async()=>{const x=rows.find(x=>Number(x.id)===Number(b.dataset.filmToggle));try{await api('/api/admin/films/'+x.id,{method:'PATCH',body:JSON.stringify({title:x.title,content_type:x.content_type,year:x.year,genre:x.genre,poster_url:x.poster_url,video_url:x.video_url,duration_minutes:x.duration_minutes,description:x.description,active:!x.active})});renderAdminFilms()}catch(e){showToast(e.message,true)}});host.querySelectorAll('[data-film-del]').forEach(b=>b.onclick=async()=>{if(!await saConfirm('حذف محتوا','این فیلم/سریال حذف شود؟',true))return;try{await api('/api/admin/films/'+b.dataset.filmDel,{method:'DELETE'});renderAdminFilms()}catch(e){showToast(e.message,true)}});
  }catch(e){host.innerHTML=`<div class="sa-empty">${esc(e.message)}</div>`}
}
'''
app=app[:start]+new_admin+app[end:]

# 6) Backend upload route for admin film assets.
needle="app.get('/api/admin/films', auth, (req,res,next)=>requireAdminPermission('films',req,res,next), async (req,res)=>{"
insert=r'''const filmUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req,file,cb)=>{
    const ok=/^(image\/(jpeg|png|webp|gif)|video\/(mp4|webm|quicktime|ogg))$/.test(file.mimetype);
    cb(ok?null:new Error('فقط فایل پوستر تصویری یا ویدیوی فیلم مجاز است'),ok);
  }
});
app.post('/api/admin/films/upload', auth, (req,res,next)=>requireAdminPermission('films',req,res,next), (req,res)=>{
  filmUpload.single('file')(req,res,async err=>{
    try{
      if(err)return res.status(400).json({error:err.message||'آپلود ناموفق بود'});
      if(!req.file)return res.status(400).json({error:'فایلی انتخاب نشده است'});
      const kind=String(req.body.kind||'');
      const isPoster=/^image\//.test(req.file.mimetype),isVideo=/^video\//.test(req.file.mimetype);
      if(kind==='poster'&&!isPoster)return res.status(400).json({error:'برای پوستر یک تصویر انتخاب کنید'});
      if(kind==='video'&&!isVideo)return res.status(400).json({error:'برای ویدیو یک فایل ویدیویی انتخاب کنید'});
      const stored=await uploadToStorage(req.file,'films',req.user.id);
      res.json({ok:true,url:stored.url,path:stored.path,name:safeFileName(req.file.originalname),mime:req.file.mimetype,size:req.file.size});
    }catch(e){console.error('film upload',e);res.status(500).json({error:'ذخیره فایل فیلم ناموفق بود'});}
  });
});
'''
if needle not in server: raise SystemExit('admin films needle missing')
server=server.replace(needle,insert+needle)

# 7) Add film-mode CSS and admin upload CSS.
css += r'''
/* ===== ZENTO v4.31.21 — Premium full-screen ZENTO PLAY ===== */
body.film-experience-mode{overflow:hidden!important;background:#07090e!important}
#app.film-host-hidden{display:none!important}
.film-experience{position:fixed;inset:0;z-index:5000;background:#08090d;color:#f7f8fb;overflow:auto;opacity:0;transform:scale(.985);transition:opacity .25s ease,transform .25s ease;direction:rtl}
.film-experience.is-open{opacity:1;transform:none}
.film-app-shell{min-height:100dvh;background:radial-gradient(circle at 75% 0,rgba(65,105,255,.16),transparent 27%),radial-gradient(circle at 15% 30%,rgba(255,54,151,.12),transparent 30%),#08090d;padding-bottom:92px}
.film-app-top{position:sticky;top:0;z-index:12;display:flex;align-items:center;gap:16px;padding:15px 24px;background:rgba(8,9,13,.72);backdrop-filter:blur(24px);border-bottom:1px solid rgba(255,255,255,.07)}
.film-back-btn,.film-menu-btn{width:46px;height:46px;border:1px solid rgba(255,255,255,.1);border-radius:15px;background:rgba(255,255,255,.06);color:#fff;font-size:21px;cursor:pointer;transition:.2s}.film-back-btn:hover,.film-menu-btn:hover{transform:translateY(-2px);background:rgba(255,255,255,.12)}
.film-brand{display:flex;align-items:center;gap:10px;min-width:190px}.film-brand-mark{width:44px;height:44px;border-radius:14px;display:grid;place-items:center;font-weight:900;background:linear-gradient(135deg,#25d8ff,#695cff 52%,#ff3fa4);box-shadow:0 12px 35px rgba(83,92,255,.32)}.film-brand b,.film-brand small{display:block}.film-brand b{font-size:14px;letter-spacing:1px}.film-brand small{font-size:10px;color:#9da5b8;margin-top:2px}
.film-search-wrap{margin-inline:auto;max-width:580px;flex:1;display:flex;align-items:center;gap:9px;height:48px;padding:0 13px;border:1px solid rgba(255,255,255,.13);border-radius:17px;background:rgba(255,255,255,.06);box-shadow:inset 0 1px 0 rgba(255,255,255,.05)}.film-search-wrap span{font-size:20px;color:#7d8aa3}.film-search-wrap input{flex:1;border:0;outline:0;background:transparent;color:#fff;font:inherit}.film-search-wrap input::placeholder{color:#727d91}.film-search-wrap button{border:0;background:transparent;color:#9da5b8;font-size:18px;cursor:pointer}
.film-experience-body{max-width:1400px;margin:0 auto;padding:0 24px 40px}.zento-film-hero{min-height:500px;margin:20px 0 30px;border-radius:30px;background-color:#111722;background-position:center;background-size:cover;position:relative;overflow:hidden;display:flex;align-items:flex-end;box-shadow:0 35px 90px rgba(0,0,0,.35)}.zento-film-hero:after{content:'';position:absolute;inset:0;background:linear-gradient(0deg,rgba(5,7,12,.96),transparent 65%);pointer-events:none}.zento-film-hero-content{position:relative;z-index:2;max-width:650px;padding:50px}.hero-kicker{font-size:10px;letter-spacing:3px;color:#72d7ff;font-weight:800}.zento-film-hero h1{font-size:clamp(34px,5vw,66px);margin:10px 0 12px;line-height:1.05}.zento-film-hero p{color:#c2c7d4;line-height:2;font-size:14px;max-width:600px}.hero-meta{display:flex;gap:8px;flex-wrap:wrap}.hero-meta b{padding:7px 11px;border-radius:999px;background:rgba(255,255,255,.09);font-size:10px}.hero-actions{display:flex;gap:10px;margin-top:22px}.hero-actions button{border:0;border-radius:14px;padding:12px 19px;font:inherit;font-weight:800;cursor:pointer}.hero-play{background:#fff;color:#10131a}.hero-info{background:rgba(255,255,255,.1);color:#fff;border:1px solid rgba(255,255,255,.13)!important}.zento-film-empty-hero{height:340px;margin:20px 0;border-radius:30px;display:grid;place-items:center;background:linear-gradient(135deg,#151b2b,#242b4c,#11131a)}
.zento-film-section{margin:30px 0}.zento-film-section-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:13px}.zento-film-section-head h2{font-size:22px;margin:0}.zento-film-see{border:0;background:transparent;color:#aeb8ca;cursor:pointer}.zento-film-see span{font-size:22px}.zento-film-row{display:flex;gap:15px;overflow-x:auto;padding:5px 2px 14px;scrollbar-width:none}.zento-film-row::-webkit-scrollbar{display:none}.zento-film-card{flex:0 0 190px;text-align:right;border:0;background:transparent;color:#fff;cursor:pointer;padding:0;transition:.2s}.zento-film-card:hover{transform:translateY(-5px)}.zento-film-poster{height:270px;border-radius:18px;overflow:hidden;position:relative;background:linear-gradient(145deg,#1b2744,#553c8f,#c53d7e);box-shadow:0 14px 34px rgba(0,0,0,.26)}.zento-film-poster img{width:100%;height:100%;object-fit:cover;display:block}.film-poster-fallback{height:100%;display:grid;place-items:center;font-size:42px}.zento-film-badge{position:absolute;top:9px;right:9px;padding:5px 7px;border-radius:8px;background:rgba(5,8,14,.62);font-size:7px;letter-spacing:1.4px}.zento-film-play{position:absolute;left:10px;bottom:10px;width:38px;height:38px;border-radius:50%;display:grid;place-items:center;background:rgba(255,255,255,.9);color:#111;font-size:14px;opacity:0;transform:scale(.8);transition:.2s}.zento-film-card:hover .zento-film-play{opacity:1;transform:none}.zento-film-copy{padding:9px 2px}.zento-film-copy b,.zento-film-copy small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.zento-film-copy b{font-size:13px}.zento-film-copy small{font-size:10px;color:#8e97a9;margin-top:5px}.zento-genre-row{display:flex;gap:12px;overflow:auto;padding-bottom:10px;scrollbar-width:none}.zento-genre-row button{min-width:150px;padding:18px;border:1px solid rgba(255,255,255,.08);border-radius:18px;text-align:right;color:#fff;background:linear-gradient(135deg,rgba(55,91,180,.18),rgba(210,47,133,.13));cursor:pointer}.zento-genre-row span{display:block;font-size:22px;color:#6bd7ff}.zento-genre-row b,.zento-genre-row small{display:block}.zento-genre-row small{color:#8f98aa;margin-top:4px}
.film-bottom-nav{position:fixed;left:18px;right:18px;bottom:15px;height:70px;z-index:20;display:grid;grid-template-columns:repeat(5,1fr);background:rgba(24,30,42,.82);border:1px solid rgba(255,255,255,.09);backdrop-filter:blur(24px);border-radius:22px;box-shadow:0 18px 50px rgba(0,0,0,.35)}.film-bottom-nav button{border:0;background:transparent;color:#7e889a;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;cursor:pointer}.film-bottom-nav button span{font-size:23px}.film-bottom-nav button small{font-size:9px}.film-bottom-nav button.active{color:#69d9ff}.film-bottom-nav button.active span{filter:drop-shadow(0 0 9px rgba(105,217,255,.55))}
.film-loading-state,.film-error-state{min-height:60vh;display:grid;place-items:center;align-content:center;gap:9px;text-align:center}.film-loading-orb{width:72px;height:72px;border-radius:24px;display:grid;place-items:center;background:linear-gradient(135deg,#25d8ff,#695cff,#ff3fa4);font-size:30px;animation:filmOrb 1.8s ease-in-out infinite}.film-loading-state small,.film-error-state small{color:#8d96a7}.film-error-state button{border:0;border-radius:12px;padding:11px 16px;background:#fff;color:#111;font:inherit}@keyframes filmOrb{50%{transform:translateY(-8px) rotate(5deg);box-shadow:0 15px 45px rgba(85,92,255,.35)}}
.film-player-overlay{position:fixed;inset:0;z-index:7000;background:rgba(1,3,7,.92);backdrop-filter:blur(22px);display:flex;align-items:center;justify-content:center;padding:28px;opacity:0;transition:.2s}.film-player-overlay.is-open{opacity:1}.film-player-card{width:min(1100px,96vw);max-height:94vh;overflow:auto;border-radius:26px;background:#0d111a;border:1px solid rgba(255,255,255,.09);box-shadow:0 40px 120px rgba(0,0,0,.55);position:relative}.film-player-close{position:absolute;top:13px;right:13px;z-index:5;width:42px;height:42px;border:1px solid rgba(255,255,255,.15);border-radius:13px;background:rgba(0,0,0,.5);color:#fff;font-size:28px;cursor:pointer}.film-player-video-wrap{aspect-ratio:16/9;background:#020307;position:relative;overflow:hidden}.film-player-video-wrap video{width:100%;height:100%;object-fit:contain;display:block}.film-player-gradient{position:absolute;inset:auto 0 0;height:35%;background:linear-gradient(transparent,rgba(0,0,0,.65));pointer-events:none}.film-player-center{position:absolute;inset:0;display:grid;place-items:center}.film-player-center button{width:76px;height:76px;border-radius:50%;border:1px solid rgba(255,255,255,.2);background:rgba(0,0,0,.5);color:#fff;font-size:27px;cursor:pointer;backdrop-filter:blur(12px)}.film-player-video-wrap.no-video{display:grid;place-items:center}.film-no-video-premium{position:absolute;inset:0;display:grid;place-items:center;color:#aab2c2;font-size:14px}.film-player-bar{padding:13px 16px;display:grid;grid-template-columns:180px 1fr auto;gap:12px;align-items:center;background:#111722}.film-player-title span{display:block;color:#64d6ff;font-size:8px;letter-spacing:2px}.film-player-title b{display:block;font-size:13px;margin-top:3px}.film-player-seek{width:100%;accent-color:#68d9ff}.film-player-actions{display:flex;gap:6px}.film-player-actions button{width:39px;height:39px;border:1px solid rgba(255,255,255,.09);border-radius:11px;background:#1b2230;color:#fff;cursor:pointer}.film-player-info-panel{padding:17px 20px;background:linear-gradient(135deg,#111827,#171323)}.film-player-info-panel b{font-size:18px}.film-player-info-panel small{display:block;color:#8e97a9;margin-top:5px}.film-player-info-panel p{color:#adb5c4;line-height:2;margin-bottom:0}
/* Admin film studio */
.sa-film-admin-pro{overflow:hidden}.sa-film-kicker{display:block;color:#5e8fff;font-size:8px;letter-spacing:2px;margin-bottom:4px}.sa-film-add-btn{min-width:150px}.sa-film-admin-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:15px 0}.sa-film-admin-stats>div{padding:15px;border-radius:16px;background:linear-gradient(135deg,rgba(51,144,236,.08),rgba(123,97,255,.08));border:1px solid var(--line);text-align:center}.sa-film-admin-stats b{display:block;font-size:22px;color:var(--accent)}.sa-film-admin-stats small{color:var(--muted)}.sa-film-row-pro{padding:13px!important}.sa-film-row-copy{min-width:0;flex:1}.film-admin-editor{display:grid;gap:14px;max-height:72vh;overflow:auto;padding:4px}.film-editor-hero{display:flex;gap:12px;align-items:center;padding:15px;border-radius:18px;background:linear-gradient(135deg,#172c57,#5b4cc1,#bd3c88);color:#fff}.film-editor-icon{width:48px;height:48px;border-radius:15px;display:grid;place-items:center;background:rgba(255,255,255,.14);font-size:22px}.film-editor-hero b,.film-editor-hero small{display:block}.film-editor-hero small{opacity:.78;font-size:10px;margin-top:3px}.film-editor-grid{display:grid;grid-template-columns:2fr 1fr 1fr 1.4fr 1fr;gap:9px}.film-admin-editor label{display:grid;gap:6px;font-size:10px;color:var(--muted)}.film-admin-editor input,.film-admin-editor select,.film-admin-editor textarea{width:100%;box-sizing:border-box;border:1px solid var(--line);border-radius:12px;padding:10px 11px;background:var(--panel2);color:var(--text);font:inherit;outline:0}.film-admin-editor textarea{min-height:120px;resize:vertical}.film-upload-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.film-upload-box{padding:14px;border:1px dashed rgba(94,143,255,.35);border-radius:17px;background:linear-gradient(145deg,rgba(51,144,236,.06),rgba(255,78,205,.04));display:grid;gap:7px}.film-upload-icon{font-size:28px}.film-upload-box>b{font-size:13px}.film-upload-box>small{color:var(--muted);font-size:9px}.film-upload-box input[type=file]{padding:9px;border:1px dashed var(--line);background:transparent}.film-upload-preview{height:130px;border-radius:13px;display:grid;place-items:center;overflow:hidden;background:rgba(0,0,0,.12);color:var(--muted);font-size:10px}.film-upload-preview img{width:100%;height:100%;object-fit:cover}.film-video-file-name{padding:10px;border-radius:11px;background:rgba(51,144,236,.06);color:var(--muted);font-size:9px}.film-editor-status{padding:10px 12px;border-radius:12px;background:rgba(51,144,236,.06);font-size:10px}.film-editor-actions{display:flex;justify-content:flex-end;gap:8px;position:sticky;bottom:0;padding-top:6px;background:linear-gradient(transparent,var(--panel) 30%)}
@media(max-width:900px){.film-app-top{padding:11px 12px;gap:8px}.film-brand{min-width:auto}.film-brand small{display:none}.film-search-wrap{max-width:none}.film-experience-body{padding:0 10px 30px}.zento-film-hero{min-height:440px;border-radius:0;margin:0 -10px 24px}.zento-film-hero-content{padding:28px 20px}.zento-film-card{flex-basis:145px}.zento-film-poster{height:210px}.film-player-bar{grid-template-columns:1fr auto}.film-player-title{grid-column:1/-1}.film-player-seek{grid-column:1/-1}.film-player-actions{justify-content:flex-start}.film-editor-grid{grid-template-columns:1fr 1fr}.sa-film-admin-stats{grid-template-columns:repeat(2,1fr)}}
@media(max-width:560px){.film-menu-btn{display:none}.film-brand-mark{width:40px;height:40px}.film-search-wrap{height:43px}.zento-film-hero{min-height:470px}.zento-film-hero h1{font-size:34px}.zento-film-hero p{font-size:12px}.zento-film-section-head h2{font-size:18px}.zento-film-card{flex-basis:132px}.zento-film-poster{height:190px;border-radius:14px}.film-bottom-nav{left:8px;right:8px;bottom:8px;height:64px}.film-bottom-nav button span{font-size:20px}.film-bottom-nav button small{font-size:8px}.film-player-overlay{padding:0}.film-player-card{width:100vw;max-height:100dvh;height:100dvh;border-radius:0}.film-player-video-wrap{margin-top:60px}.film-player-info-panel{padding-bottom:100px}.film-upload-grid{grid-template-columns:1fr}.film-editor-grid{grid-template-columns:1fr 1fr}.film-admin-editor{max-height:76vh}}
'''

# 8) Update cache/version query and version.
index=index.replace('app.js?v=120','app.js?v=121')
css=css.replace('/* ===== ZENTO v4.31.21 — Premium full-screen ZENTO PLAY ===== */','/* ===== ZENTO v4.31.21 — Premium full-screen ZENTO PLAY ===== */')
(root/'public/index.html').write_text(index)
(root/'public/app.js').write_text(app)
(root/'public/style.css').write_text(css)
(root/'server.js').write_text(server)
(root/'VERSION.txt').write_text('4.31.21\n')
# package version
import json
pkgp=root/'package.json'
if pkgp.exists():
    pkg=json.loads(pkgp.read_text());pkg['version']='4.31.21';pkgp.write_text(json.dumps(pkg,ensure_ascii=False,indent=2)+'\n')
# service worker cache bump all v113/v120-like tokens to v121
sw=root/'public/sw.js'
s=sw.read_text()
s=re.sub(r'v\d+', 'v121', s)
s=s.replace('v121121','v121')
sw.write_text(s)
