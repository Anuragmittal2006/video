const signalingURL = window.location.origin;
const socket = io(signalingURL, { transports: ['websocket'] });

const els = {
  roomId: document.getElementById('roomId'),
  joinBtn: document.getElementById('joinBtn'),
  leaveBtn: document.getElementById('leaveBtn'),
  voiceOnly: document.getElementById('voiceOnly'),
  toggleMic: document.getElementById('toggleMic'),
  toggleCam: document.getElementById('toggleCam'),
  shareScreen: document.getElementById('shareScreen'),
  switchCam: document.getElementById('switchCam'),
  localVideo: document.getElementById('localVideo'),
  remoteVideo: document.getElementById('remoteVideo'),
  status: document.getElementById('status'),
  log: document.getElementById('log')
};

let pc, localStream, remoteStream, iceConfig, roomJoined = false, partnerId = null;
let currentVideoDeviceId = null;
let screenTrack = null;

log('App loaded');

async function fetchIce() {
  const res = await fetch(`${signalingURL}/ice`);
  iceConfig = await res.json();
  log('ICE config loaded');
}

function log(msg) {
  console.log(msg);
  els.log.textContent += `${new Date().toLocaleTimeString()}  ${msg}\n`;
  els.log.scrollTop = els.log.scrollHeight;
}
function setStatus(s) { els.status.textContent = s; }

function setControls(inCall) {
  els.joinBtn.disabled = inCall;
  els.leaveBtn.disabled = !inCall;
  els.toggleMic.disabled = !inCall;
  els.toggleCam.disabled = !inCall || els.voiceOnly.checked;
  els.shareScreen.disabled = !inCall || els.voiceOnly.checked;
  els.switchCam.disabled = !inCall || els.voiceOnly.checked;
}

async function getMedia() {
  const voiceOnly = els.voiceOnly.checked;
  const constraints = {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    },
    video: voiceOnly ? false : {
      deviceId: currentVideoDeviceId ? { exact: currentVideoDeviceId } : undefined,
      width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }
    }
  };
  localStream = await navigator.mediaDevices.getUserMedia(constraints);
  els.localVideo.srcObject = localStream;
  log(`Got media: audio ${!!localStream.getAudioTracks().length}, video ${!!localStream.getVideoTracks().length}`);
}

async function createPC() {
  pc = new RTCPeerConnection(iceConfig);
  remoteStream = new MediaStream();
  els.remoteVideo.srcObject = remoteStream;

  pc.ontrack = (ev) => {
    ev.streams[0].getTracks().forEach(t => remoteStream.addTrack(t));
  };

  pc.onicecandidate = (ev) => {
    if (ev.candidate && partnerId) {
      socket.emit('ice-candidate', { candidate: ev.candidate, to: partnerId });
    }
  };

  pc.onconnectionstatechange = () => {
    log('PC state: ' + pc.connectionState);
    setStatus(pc.connectionState);
    if (pc.connectionState === 'failed') {
      // Try ICE restart
      log('ICE failed -> attempting restart');
      pc.restartIce?.();
    }
  };

  // add local tracks
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  // negotiation (caller side)
  pc.onnegotiationneeded = async () => {
    try {
      if (!partnerId) return;
      const offer = await pc.createOffer({ iceRestart: false });
      await pc.setLocalDescription(offer);
      socket.emit('offer', { sdp: pc.localDescription, to: partnerId });
      log('Sent offer');
    } catch (e) { log('negotiation error ' + e.message); }
  };
}

async function startCallFlow() {
  await fetchIce();
  await getMedia();
  await createPC();

  const roomId = els.roomId.value.trim();
  if (!roomId) return alert('Room ID required');
  socket.emit('join', { roomId });
  roomJoined = true;
  setControls(true);
  setStatus('joined');
}

async function leave() {
  if (roomJoined) socket.emit('leave');
  roomJoined = false; partnerId = null;

  if (screenTrack) { screenTrack.stop(); screenTrack = null; }

  if (pc) {
    pc.getSenders().forEach(s => { try { pc.removeTrack(s); } catch {} });
    pc.ontrack = pc.onicecandidate = pc.onconnectionstatechange = pc.onnegotiationneeded = null;
    pc.close();
    pc = null;
  }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (remoteStream) { remoteStream.getTracks().forEach(t => t.stop()); remoteStream = null; }
  els.localVideo.srcObject = null; els.remoteVideo.srcObject = null;
  setControls(false);
  setStatus('left');
  log('Left room and cleaned up');
}

/* UI handlers */
els.joinBtn.onclick = startCallFlow;
els.leaveBtn.onclick = leave;

els.toggleMic.onclick = () => {
  const t = localStream?.getAudioTracks()[0];
  if (!t) return;
  t.enabled = !t.enabled;
  els.toggleMic.textContent = t.enabled ? 'Mute' : 'Unmute';
  socket.emit('signal', { type: 'mic', enabled: t.enabled });
};

els.toggleCam.onclick = () => {
  const t = localStream?.getVideoTracks()[0];
  if (!t) return;
  t.enabled = !t.enabled;
  els.toggleCam.textContent = t.enabled ? 'Cam Off' : 'Cam On';
  socket.emit('signal', { type: 'cam', enabled: t.enabled });
};

els.shareScreen.onclick = async () => {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    screenTrack = stream.getVideoTracks()[0];
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
    await sender.replaceTrack(screenTrack);
    screenTrack.onended = async () => {
      // revert to camera
      const camTrack = localStream.getVideoTracks()[0];
      if (camTrack) await sender.replaceTrack(camTrack);
      socket.emit('signal', { type: 'screenshare', active: false });
    };
    socket.emit('signal', { type: 'screenshare', active: true });
  } catch (e) {
    log('Share screen error: ' + e.message);
  }
};

els.switchCam.onclick = async () => {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter(d => d.kind === 'videoinput');
  if (!cams.length) return alert('No camera devices');
  const current = localStream.getVideoTracks()[0];
  const idx = cams.findIndex(d => d.deviceId === current?.getSettings().deviceId || currentVideoDeviceId);
  const next = cams[(idx + 1) % cams.length];
  currentVideoDeviceId = next.deviceId;

  const newStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: currentVideoDeviceId } }, audio: false });
  const newTrack = newStream.getVideoTracks()[0];

  const sender = pc.getSenders().find(s => s.track?.kind === 'video');
  await sender.replaceTrack(newTrack);

  // update local preview
  localStream.removeTrack(current);
  current.stop();
  localStream.addTrack(newTrack);
  log('Switched camera');
};

/* Socket wiring */
socket.on('connect', () => log('Socket connected ' + socket.id));
socket.on('disconnect', () => { log('Socket disconnected'); setStatus('offline'); });

socket.on('room-full', () => {
  alert('Room already has 2 people');
  leave();
});

socket.on('peer-joined', async ({ id }) => {
  partnerId = id;
  log("Peer joined: " + id);
  await startNegotiation();
});

socket.on('ready', async () => {
  partnerId = partnerId || (await guessPartner());
  log('Room ready');
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
  try { await pc.addIceCandidate(candidate); } catch (e) { log('ICE add error ' + e.message); }
});

socket.on('peer-left', () => {
  log('Peer left. Keeping UI; you can wait or leave.');
  setStatus('waiting');
  // Optional: auto-clean after timeout
});

socket.on('signal', (payload) => {
  log('Signal: ' + JSON.stringify(payload));
});

async function guessPartner() {
  // not strictly needed; server relays by socket id on messages.
  return partnerId;
}
async function startNegotiation() {
  if (!pc || !partnerId) return;
  try {
    log("Starting negotiation...");
    const offer = await pc.createOffer({ iceRestart: false });
    await pc.setLocalDescription(offer);
    socket.emit("offer", { sdp: pc.localDescription, to: partnerId });
    log("Offer sent manually ✅");
  } catch (err) {
    log("Negotiation error: " + err.message);
  }
}
