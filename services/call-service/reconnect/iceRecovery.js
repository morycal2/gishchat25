function restartIce(peer){
  if(peer && peer.restartIce){
    peer.restartIce();
  }
}

module.exports = { restartIce };
