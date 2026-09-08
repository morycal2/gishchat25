const redis=require("redis");
const client=redis.createClient({url:process.env.REDIS_URL||"redis://localhost:6379"});
client.connect();
exports.online=async(id)=>client.set(`presence:${id}`,"online");
exports.offline=async(id)=>client.del(`presence:${id}`);
