const CACHE='zento-v4.21';
const CORE=['/','/index.html','/style.css','/app.js?v=104','/config.js','/manifest.json','/zento-icon.png'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('push',e=>{let d={title:'زنتو',body:'پیام جدید',url:'/'};try{d={...d,...e.data.json()}}catch{try{d.body=e.data?.text()||d.body}catch{}}
e.waitUntil(self.registration.showNotification(d.title,{body:d.body,icon:d.icon||'/zento-icon.png',badge:'/zento-icon.png',tag:d.tag||'zento-push',data:{url:d.url||'/'},vibrate:[120,60,120]}));});
self.addEventListener('notificationclick',e=>{e.notification.close();const url=e.notification.data?.url||'/';e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{for(const c of list){if('focus' in c){c.navigate(url);return c.focus()}}return clients.openWindow(url)}));});
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;const u=new URL(e.request.url);
  if(e.request.mode==='navigate'){e.respondWith(fetch(e.request,{cache:'no-store'}).then(r=>{const cp=r.clone();caches.open(CACHE).then(c=>c.put(e.request,cp)).catch(()=>{});return r}).catch(()=>caches.match(e.request).then(r=>r||caches.match('/index.html'))));return;}
  if(u.pathname.endsWith('/app.js')||u.pathname.endsWith('/style.css')||u.pathname.startsWith('/api/')){e.respondWith(fetch(e.request,{cache:'no-store'}));return;}
  e.respondWith(fetch(e.request).then(r=>{const cp=r.clone();if(u.origin===location.origin)caches.open(CACHE).then(c=>c.put(e.request,cp)).catch(()=>{});return r}).catch(()=>caches.match(e.request).then(r=>r||caches.match('/index.html'))));
});
