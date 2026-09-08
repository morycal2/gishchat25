export function toggleAudio(stream,enabled){
 stream.getAudioTracks().forEach(t=>t.enabled=enabled);
}

export function toggleVideo(stream,enabled){
 stream.getVideoTracks().forEach(t=>t.enabled=enabled);
}
