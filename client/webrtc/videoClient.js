export async function getCameraStream(){
 return await navigator.mediaDevices.getUserMedia({
   video:{
    width:{ideal:1280},
    height:{ideal:720}
   },
   audio:true
 });
}

export function setRemoteVideo(element,stream){
 if(element){
  element.srcObject=stream;
 }
}
