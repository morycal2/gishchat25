const { Server } = require('socket.io');

function initChat(server){
 const io=new Server(server,{cors:{origin:"*"}});
 io.on("connection",socket=>{
  socket.on("join_room",room=>socket.join(room));
  socket.on("send_message",data=>{
    io.to(data.room).emit("new_message",data);
  });
  socket.on("typing",data=>socket.to(data.room).emit("typing",data));
 });
 return io;
}
module.exports=initChat;
