module.exports = {
 canManageMembers(role){
   return role === "owner" || role === "admin";
 },
 canDeleteMessages(role){
   return ["owner","admin","moderator"].includes(role);
 }
};
