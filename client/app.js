// --- Signaling base ---
const signalingURL = window.location.origin; // same-origin = no CORS headaches
const socket = io(signalingURL, { transports: ['websocket'] });

// --- Elements ---
const els = {
  container: document.getElementById('callContainer'),
  remoteVideo: document.getElementById('remoteVideo'),
  localWrapper: document.getElementById('localWrapper'),
  localVideo: document.getElementById('localVideo'),
  roomId: document.getElementById('roomId'),
  joinBtn: document.getElementById('joinBtn'),
  leaveBtn: document.getElementById('leaveBtn'),
  voiceOnly: document.getElementById('voiceOnly'),
  status: document.getElementById('status'),
  controls: document.getElementById('controls'),
  endCall: document.getElementById('endCall'),
  toggleMic: document.getElementById('toggleMic'),
  toggleCam: document.getElementById('toggleCam'),
  switchCam: document.getElementById('switchCam'),
  shareScreen: document.getElementById('shareScreen'),
  pipBtn: document.getElementById('pipBtn'),
  touchLayer: document.getElementById('touchLayer'),
  log: document.getElementById('log')
};

let pc, localStream, remoteStream, iceConfig, roomJoined = false, partnerId = null;
let currentVideoDeviceId = null;
let screenTrack = null;
let hideHudTimer = null;

log('App loaded');

// --- Utils ---
function log(msg){ console.log(msg); els.log.textContent += `${new Date().toLocaleTimeString()}  ${msg}\n`; els.log.scrollTop = els.log.scrollHeight; }
function setStatus(s){ els.status.textContent = s; }
function showHud(autohideMs = 2500){
  els.controls.classList.remove('hidden');
  clearTimeout(hideHudTimer);
  hideHudTimer = setTimeout(()=> els.controls.classList.add('hidden'), autohideMs);
}

// --- ICE config from server ---
async function fetchIce(){
  const res = await fetch(`${signalingURL}/ice`);
  iceConfig = await res.json();
  log('ICE config loaded');
}

// --- Media + PC setup ---
async function getMedia(){
  const voiceOnly = els.voiceOnly.checked;
  const constraints = {
    audio: { echoCancellation:true, noiseSuppression:true, autoGainControl:true },
    video: voiceOnly ? false : {
      deviceId: currentVideoDeviceId ? { exact: currentVideoDeviceId } : undefined,
      width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }
    }
  };
  localStream = await navigator.mediaDevices.getUserMedia(constraints);
  els.localVideo.srcObject = localStream;
  log(`Got media: audio ${!!localStream.getAudioTracks().length}, video ${!!localStream.getVideoTracks().length}`);
}

async function createPC(){
  pc = new RTCPeerConnection(iceConfig);
  remoteStream = new MediaStream();
  els.remoteVideo.srcObject = remoteStream;

  pc.ontrack = (ev) => { ev.streams[0].getTracks().forEach(t => remoteStream.addTrack(t)); };
  pc.onicecandidate = (ev) => { if (ev.candidate && partnerId) socket.emit('ice-candidate', { candidate: ev.candidate, to: partnerId }); };
  pc.onconnectionstatechange = () => {
    log('PC state: '+pc.connectionState);
    setStatus(pc.connectionState);
    if (pc.connectionState === 'failed') pc.restartIce?.();
  };

  // Add local tracks
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
}

// Force negotiation when second peer arrives
async function startNegotiation(){
  if (!pc || !partnerId) return;
  try{
    log('Starting negotiation...');
    const offer = await pc.createOffer({ iceRestart:false });
    await pc.setLocalDescription(offer);
    socket.emit('offer', { sdp: pc.localDescription, to: partnerId });
    log('Offer sent manually ✅');
  }catch(err){ log('Negotiation error: '+err.message); }
}

async function startCallFlow(){
  await fetchIce();
  await getMedia();
  await createPC();

  const roomId = els.roomId.value.trim();
  if (!roomId) { alert('Room ID required'); return; }
  socket.emit('join', { roomId });
  roomJoined = true;
    enableControls(true);
  setStatus('joined');
  showHud();
}

async function leave(){
  if (roomJoined) socket.emit('leave');
  roomJoined = false; partnerId = null;
  enableControls(false);
  if (screenTrack){ screenTrack.stop(); screenTrack = null; }

  if (pc){
    pc.getSenders().forEach(s => { try{ pc.removeTrack(s); }catch{} });
    pc.ontrack = pc.onicecandidate = pc.onconnectionstatechange = null;
    pc.close(); pc = null;
  }
  if (localStream){ localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (remoteStream){ remoteStream.getTracks().forEach(t => t.stop()); remoteStream = null; }
  els.localVideo.srcObject = null; els.remoteVideo.srcObject = null;
  setStatus('left');
  log('Left & cleaned up');
}

// --- UI bindings ---
els.joinBtn.onclick = startCallFlow;
els.leaveBtn.onclick = leave;
els.endCall.onclick = leave;

els.toggleMic.onclick = () => {
  const t = localStream?.getAudioTracks()[0]; if (!t) return;
  t.enabled = !t.enabled;
  els.toggleMic.classList.toggle('off', !t.enabled);
  socket.emit('signal', { type:'mic', enabled:t.enabled });
  showHud();
};
els.toggleCam.onclick = () => {
  const t = localStream?.getVideoTracks()[0]; if (!t) return;
  t.enabled = !t.enabled;
  els.toggleCam.classList.toggle('off', !t.enabled);
  socket.emit('signal', { type:'cam', enabled:t.enabled });
  showHud();
};
els.switchCam.onclick = async () => {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter(d => d.kind==='videoinput');
  if (!cams.length) return alert('No camera devices');
  const cur = localStream.getVideoTracks()[0];
  const idx = cams.findIndex(d => d.deviceId === (cur?.getSettings().deviceId || currentVideoDeviceId));
  const next = cams[(idx+1) % cams.length];
  currentVideoDeviceId = next.deviceId;

  const newStream = await navigator.mediaDevices.getUserMedia({ video:{ deviceId:{ exact:currentVideoDeviceId } }, audio:false });
  const newTrack = newStream.getVideoTracks()[0];
  const sender = pc.getSenders().find(s => s.track?.kind==='video');
  await sender.replaceTrack(newTrack);

  localStream.removeTrack(cur); cur.stop();
  localStream.addTrack(newTrack);
  els.localVideo.srcObject = localStream;
  log('Switched camera');
  showHud();
};

els.shareScreen.onclick = async () => {
  try{
    // On mobile, this may require HTTPS and may not be available
    const stream = await navigator.mediaDevices.getDisplayMedia({ video:true, audio:false });
    screenTrack = stream.getVideoTracks()[0];
    const sender = pc.getSenders().find(s => s.track && s.track.kind==='video');
    await sender.replaceTrack(screenTrack);
    screenTrack.onended = async () => {
      const camTrack = localStream.getVideoTracks()[0];
      if (camTrack) await sender.replaceTrack(camTrack);
      socket.emit('signal', { type:'screenshare', active:false });
    };
    socket.emit('signal', { type:'screenshare', active:true });
    showHud();
  }catch(e){
    log('Share screen error: '+e.message);
    alert('Screen share not supported or permission denied on this device.');
  }
};

els.pipBtn.onclick = async () => {
  try{
    // Use remote video for PiP so user keeps seeing partner while multitasking
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else if (els.remoteVideo.disablePictureInPicture === false || 'requestPictureInPicture' in els.remoteVideo) {
      await els.remoteVideo.requestPictureInPicture();
    } else {
      alert('Picture-in-Picture not supported on this browser.');
    }
    showHud();
  }catch(err){ log('PiP error: '+err.message); }
};

// Tap anywhere to toggle HUD
els.touchLayer.addEventListener('click', () => {
  const hidden = els.controls.classList.contains('hidden');
  if (hidden) showHud(); else els.controls.classList.add('hidden');
});

// --- Draggable local preview (pointer events = works on touch + mouse) ---
(() => {
  const node = els.localWrapper;
  let dragging = false, sx=0, sy=0, startL=0, startT=0;

  const within = (val, min, max) => Math.max(min, Math.min(max, val));
  node.addEventListener('pointerdown', (e)=>{
    dragging = true; node.setPointerCapture(e.pointerId);
    sx = e.clientX; sy = e.clientY;
    startL = node.offsetLeft; startT = node.offsetTop;
  });
  node.addEventListener('pointermove', (e)=>{
    if(!dragging) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    const parent = els.container.getBoundingClientRect();
    const rect = node.getBoundingClientRect();
    const left = within(startL+dx, 6, parent.width-rect.width-6);
    const top  = within(startT+dy, 56, parent.height-rect.height-16); // keep off topbar
    node.style.left = left+'px';
    node.style.top  = top+'px';
  });
  node.addEventListener('pointerup', (e)=>{ dragging=false; node.releasePointerCapture(e.pointerId); });
})();

// --- Socket events ---
socket.on('connect', () => log('Socket connected '+socket.id));
socket.on('disconnect', () => { log('Socket disconnected'); setStatus('offline'); });

socket.on('room-full', () => { alert('Room already has 2 people'); leave(); });

socket.on('peer-joined', async ({ id }) => {
  partnerId = id; log('Peer joined: ' + id);
  await startNegotiation();
});
socket.on('ready', async () => {
  log('Room ready → forcing negotiation'); await startNegotiation();
});

socket.on('offer', async ({ sdp, from }) => {
  partnerId = from;
  await pc.setRemoteDescription(sdp);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('answer', { sdp: pc.localDescription, to: from });
  log('Received offer → sent answer');
});

socket.on('answer', async ({ sdp }) => {
  await pc.setRemoteDescription(sdp);
  log('Received answer');
});

socket.on('ice-candidate', async ({ candidate }) => {
  try { await pc.addIceCandidate(candidate); } catch (e) { log('ICE add error '+e.message); }
});

socket.on('signal', (payload) => { log('Signal: '+JSON.stringify(payload)); });

// --- Expose some controls once joined/left ---
function setControlsEnabled(inCall){
  els.leaveBtn.disabled = !inCall;
  els.toggleMic.disabled = !inCall;
  els.toggleCam.disabled = !inCall || els.voiceOnly.checked;
  els.switchCam.disabled = !inCall || els.voiceOnly.checked;
  els.shareScreen.disabled = !inCall || els.voiceOnly.checked;
}
function enableControls(inCall){
  els.leaveBtn.disabled = !inCall;
  els.toggleMic.disabled = !inCall;
  els.toggleCam.disabled = !inCall || els.voiceOnly.checked;
  els.switchCam.disabled = !inCall || els.voiceOnly.checked;
  els.shareScreen.disabled = !inCall || els.voiceOnly.checked;
}
document.addEventListener("visibilitychange", async () => {
  if (document.hidden && els.remoteVideo && !document.pictureInPictureElement) {
    try {
      await els.remoteVideo.requestPictureInPicture();
      log("Auto PiP triggered ✅");
    } catch (err) {
      log("Auto PiP failed: " + err.message);
      // This fails only if site is not PWA yet (Chrome security)
    }
  }
});
