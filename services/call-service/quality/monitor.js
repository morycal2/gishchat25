function getQuality(stats){
 return {
   packetsLost: stats.packetsLost || 0,
   jitter: stats.jitter || 0,
   bitrate: stats.bitrate || 0
 };
}

module.exports = { getQuality };
