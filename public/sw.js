const CACHE='zento-v8.1.4-v90';
const CORE=['/','/index.html','/style.css','/app.js?v=90','/config.js','/manifest.json','/zento-icon.png'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  const u=new URL(e.request.url);
  if(e.request.mode==='navigate'){e.respondWith(fetch(e.request,{cache:'no-store'}).then(r=>{const copy=r.clone();caches.open(CACHE).then(c=>c.put(e.request,copy)).catch(()=>{});return r}).catch(()=>caches.match(e.request).then(r=>r||caches.match('/index.html'))));return;}
  if(u.pathname.endsWith('/app.js')||u.pathname.endsWith('/style.css')||u.pathname.startsWith('/api/')){
    e.respondWith(fetch(e.request,{cache:'no-store'}).catch(()=>new Response(JSON.stringify({error:'ارتباط با سرور برقرار نشد'}),{status:503,headers:{'Content-Type':'application/json; charset=utf-8'}})));
    return;
  }
  e.respondWith(fetch(e.request).then(r=>{const copy=r.clone();if(u.origin===location.origin)caches.open(CACHE).then(c=>c.put(e.request,copy)).catch(()=>{});return r}).catch(()=>caches.match(e.request).then(r=>r||caches.match('/index.html'))));
});
