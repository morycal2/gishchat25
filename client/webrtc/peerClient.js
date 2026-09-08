export class PeerClient {
 constructor(config){
  this.peer = new RTCPeerConnection(config);
 }

 addStream(stream){
  stream.getTracks().forEach(track=>{
   this.peer.addTrack(track,stream);
  });
 }

 onRemote(callback){
  this.peer.ontrack = e=>{
   callback(e.streams[0]);
  };
 }
}
