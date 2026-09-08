module.exports = {
 incomingCall(user){
   return {
    type:'incoming_call',
    user
   };
 },
 missedCall(){
   return {
    type:'missed_call'
   };
 }
};
