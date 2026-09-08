module.exports = {
 iceServers:[
  {
   urls:[
    'stun:stun.l.google.com:19302'
   ]
  },
  {
   urls:'turn:your-turn-server:3478',
   username:'user',
   credential:'password'
  }
 ]
};
