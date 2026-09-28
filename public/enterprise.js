/* Zento Enterprise v4.34 - WebCrypto E2EE + enterprise controls. */
(()=>{
  const api=()=>window.zentoApi;
  const state={deviceId:localStorage.getItem('zento_e2ee_device')||crypto.randomUUID(),keyPair:null,publicJwk:null,rooms:new Map()};
  const b64=b=>{let s='';const a=new Uint8Array(b);for(const x of a)s+=String.fromCharCode(x);return btoa(s)};
  const unb64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
  const enc=new TextEncoder(),dec=new TextDecoder();
  async function ensureKeys(){
    if(state.keyPair)return state.keyPair;
    const raw=localStorage.getItem('zento_e2ee_private');
    if(raw){try{const j=JSON.parse(raw);state.keyPair={privateKey:await crypto.subtle.importKey('jwk',j.privateKey,{name:'ECDH',namedCurve:'P-256'},false,['deriveBits']),publicKey:await crypto.subtle.importKey('jwk',j.publicKey,{name:'ECDH',namedCurve:'P-256'},true,[])};state.publicJwk=j.publicKey;return state.keyPair}catch{localStorage.removeItem('zento_e2ee_private')}}
    const kp=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
    const privateJwk=await crypto.subtle.exportKey('jwk',kp.privateKey),publicJwk=await crypto.subtle.exportKey('jwk',kp.publicKey);
    localStorage.setItem('zento_e2ee_private',JSON.stringify({privateKey:privateJwk,publicKey:publicJwk}));state.keyPair=kp;state.publicJwk=publicJwk;return kp;
  }
  async function registerDevice(label='Zento Web'){
    await ensureKeys();localStorage.setItem('zento_e2ee_device',state.deviceId);
    return api()('/api/enterprise/devices/register',{method:'POST',body:JSON.stringify({deviceId:state.deviceId,publicKey:JSON.stringify(state.publicJwk),label,algorithm:'ECDH-P256 + AES-GCM'})});
  }
  async function getRoomKey(cid){
    if(state.rooms.has(Number(cid)))return state.rooms.get(Number(cid));
    const stored=localStorage.getItem('zento_e2ee_room_'+cid);if(stored){const key=await crypto.subtle.importKey('raw',unb64(stored),{name:'AES-GCM'},false,['encrypt','decrypt']);state.rooms.set(Number(cid),key);return key;}
    return null;
  }
  async function createRoomKey(cid){const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);const raw=await crypto.subtle.exportKey('raw',key);localStorage.setItem('zento_e2ee_room_'+cid,b64(raw));state.rooms.set(Number(cid),key);return key;}
  async function wrapRoomKey(roomRaw,device){
    const target=JSON.parse(device.public_key);const targetPub=await crypto.subtle.importKey('jwk',target,{name:'ECDH',namedCurve:'P-256'},true,[]);
    const eph=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
    const bits=await crypto.subtle.deriveBits({name:'ECDH',public:targetPub},eph.privateKey,256);
    const wrapKey=await crypto.subtle.importKey('raw',bits,{name:'AES-GCM'},false,['encrypt']);const iv=crypto.getRandomValues(new Uint8Array(12));
    const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv},wrapKey,roomRaw);const ep=await crypto.subtle.exportKey('jwk',eph.publicKey);
    return JSON.stringify({v:1,ephemeralPublicKey:ep,iv:b64(iv),ciphertext:b64(ct),algorithm:'ECDH-P256/AES-GCM'});
  }
  async function enableConversation(cid){
    await registerDevice();await api()('/api/enterprise/conversations/'+cid+'/e2ee/enable',{method:'POST',body:'{}'});
    const key=await getRoomKey(cid)||await createRoomKey(cid);const raw=await crypto.subtle.exportKey('raw',key);
    const devices=await api()('/api/enterprise/conversations/'+cid+'/e2ee/devices');
    for(const d of devices){try{const envelope=await wrapRoomKey(raw,d);await api()('/api/enterprise/conversations/'+cid+'/e2ee/keys',{method:'POST',body:JSON.stringify({deviceId:d.device_id,envelope,version:1})})}catch(e){console.warn('key envelope',d.device_id,e)}}
    return {enabled:true,deviceId:state.deviceId,devices:devices.length};
  }

  async function encryptText(cid,text){const key=await getRoomKey(cid);if(!key)throw Error('ابتدا رمزنگاری این گفتگو را فعال کنید');const iv=crypto.getRandomValues(new Uint8Array(12));const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,enc.encode(text));return {ciphertext:b64(ct),iv:b64(iv),version:1,deviceId:state.deviceId};}
  async function sendEncrypted(cid,text){const p=await encryptText(cid,text);return api()('/api/enterprise/messages/encrypted',{method:'POST',body:JSON.stringify({conversationId:Number(cid),...p})});}
  async function rotateConversationKey(cid){
    const info=await api()('/api/ultimate/conversations/'+cid+'/e2ee/rotate',{method:'POST',body:'{}'});
    const key=await createRoomKey(cid); const raw=await crypto.subtle.exportKey('raw',key); const devices=await api()('/api/enterprise/conversations/'+cid+'/e2ee/devices');
    for(const d of devices){try{const envelope=await wrapRoomKey(raw,d);await api()('/api/enterprise/conversations/'+cid+'/e2ee/keys',{method:'POST',body:JSON.stringify({deviceId:d.device_id,envelope,version:info.version})})}catch(err){console.warn('rotation envelope',err)}}
    return info;
  }
  async function fingerprints(cid){return api()('/api/ultimate/conversations/'+cid+'/e2ee/fingerprints');}
  async function encryptAttachment(buffer){
    const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']); const raw=await crypto.subtle.exportKey('raw',key); const iv=crypto.getRandomValues(new Uint8Array(12));
    const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,buffer); const hash=await crypto.subtle.digest('SHA-256',ciphertext);
    return {ciphertext,iv:b64(iv),key:b64(raw),sha256:Array.from(new Uint8Array(hash)).map(x=>x.toString(16).padStart(2,'0')).join('')};
  }
  function panel(){
    if(document.getElementById('zentoEnterpriseFab'))return;
    const b=document.createElement('button');b.id='zentoEnterpriseFab';b.className='enterprise-fab';b.textContent='🛡️ Enterprise';b.title='مرکز امکانات Enterprise';
    b.onclick=async()=>{try{await registerDevice();const d=await api()('/api/enterprise/devices');const h=await api()('/api/enterprise/health');const cid=window.current?.id||null;const e=cid?await api()('/api/enterprise/conversations/'+cid+'/e2ee'):null;const box=document.createElement('div');box.className='enterprise-panel';box.innerHTML=`<div class="enterprise-panel-head"><b>🛡️ Zento Enterprise</b><button id="zeClose">×</button></div><div class="enterprise-stat"><span>نسخه</span><b>${h.version}</b></div><div class="enterprise-stat"><span>دستگاه‌های رمزنگاری</span><b>${d.length}</b></div><div class="enterprise-stat"><span>E2EE این گفتگو</span><b>${e?.enabled?'فعال':'غیرفعال'}</b></div><div class="enterprise-actions">${cid?`<button id="zeEnable">🔐 فعال‌سازی E2EE</button><button id="zeRotate">🔄 چرخش کلید</button><button id="zeFingerprint">🧾 اثرانگشت کلیدها</button><button id="zeSend">✉️ ارسال پیام رمزنگاری‌شده</button>`:'<small>یک گفتگو را باز کنید تا کنترل‌های E2EE نمایش داده شوند.</small>'}<button id="zeExport">⬇️ خروجی امن اطلاعات</button><button id="zeSearch">🔎 جستجوی Enterprise</button></div>`;document.body.appendChild(box);box.querySelector('#zeClose').onclick=()=>box.remove();box.querySelector('#zeRotate')?.addEventListener('click',async()=>{try{const r=await rotateConversationKey(cid);showToast?.('کلید گفتگو چرخانده شد 🔄 v'+r.version);box.remove()}catch(x){alert(x.message)}});box.querySelector('#zeFingerprint')?.addEventListener('click',async()=>{try{const fs=await fingerprints(cid);alert(fs.map(x=>`${x.label}\n${x.fingerprint}`).join('\n\n')||'دستگاهی ثبت نشده')}catch(x){alert(x.message)}});box.querySelector('#zeEnable')?.addEventListener('click',async()=>{try{await enableConversation(cid);showToast?.('E2EE برای این گفتگو فعال شد 🔐');box.remove()}catch(x){alert(x.message)}});box.querySelector('#zeSend')?.addEventListener('click',async()=>{const text=prompt('متن پیام رمزنگاری‌شده:');if(!text)return;try{await sendEncrypted(cid,text);showToast?.('پیام رمزنگاری‌شده ارسال شد 🔐');box.remove()}catch(x){alert(x.message)}});box.querySelector('#zeExport').onclick=()=>{window.location.href=backendUrl('/api/enterprise/export')};box.querySelector('#zeSearch').onclick=async()=>{const term=prompt('جستجوی سراسری:');if(!term)return;const r=await api()('/api/enterprise/search?q='+encodeURIComponent(term));alert(`نتیجه: ${r.messages.length} پیام، ${r.users.length} کاربر، ${r.conversations.length} گفتگو`)};}catch(e){alert(e.message||'Enterprise در دسترس نیست')}};
    document.body.appendChild(b);
  }
  window.ZentoEnterprise={registerDevice,enableConversation,rotateConversationKey,encryptText,sendEncrypted,fingerprints,encryptAttachment,getDevices:()=>api()('/api/enterprise/devices')};
  window.addEventListener('load',()=>setTimeout(panel,1200));
})();
