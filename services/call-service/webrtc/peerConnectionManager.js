class PeerConnectionManager {
  constructor(socket){
    this.socket = socket;
    this.peer = null;
  }

  create(config){
    this.peer = new RTCPeerConnection(config);

    this.peer.onicecandidate = (event)=>{
      if(event.candidate){
        this.socket.emit('ice_candidate', event.candidate);
      }
    };

    this.peer.ontrack = (event)=>{
      this.socket.emit('remote_stream_ready');
    };

    return this.peer;
  }
}

module.exports = PeerConnectionManager;
