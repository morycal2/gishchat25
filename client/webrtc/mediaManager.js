export async function getMedia(){
 return await navigator.mediaDevices.getUserMedia({
   audio:true,
   video:true
 });
}
