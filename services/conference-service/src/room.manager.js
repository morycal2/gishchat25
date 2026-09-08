class RoomManager {
 constructor(){
  this.rooms = new Map();
 }

 join(room,user){
  if(!this.rooms.has(room)) this.rooms.set(room,[]);
  this.rooms.get(room).push(user);
 }

 leave(room,user){
  const users=this.rooms.get(room)||[];
  this.rooms.set(room,users.filter(u=>u!==user));
 }
}

module.exports = new RoomManager();
