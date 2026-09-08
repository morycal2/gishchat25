class CallStateManager {
  constructor(){
    this.calls = new Map();
  }

  set(callId,status){
    this.calls.set(callId,status);
  }

  get(callId){
    return this.calls.get(callId);
  }
}

module.exports = new CallStateManager();
