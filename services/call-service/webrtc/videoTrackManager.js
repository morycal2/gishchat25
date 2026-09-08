class VideoTrackManager {
  addVideoTrack(peer, stream){
    if(!stream) return;
    stream.getVideoTracks().forEach(track=>{
      peer.addTrack(track, stream);
    });
  }

  attachRemoteVideo(videoElement, stream){
    if(videoElement){
      videoElement.srcObject = stream;
      videoElement.play().catch(()=>{});
    }
  }
}
module.exports = new VideoTrackManager();
