import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors({ origin: "*" }));

// ✅ Static client files serve karo
app.use(express.static(path.join(__dirname, "client")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "client", "index.html"));
});
const rooms = new Map(); // roomId -> Set(socketId)

function getPeers(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Set());
  return rooms.get(roomId);
}

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join', ({ roomId }) => {
    if (!roomId) return socket.emit('error', { message: 'roomId required' });
    const peers = getPeers(roomId);
    if (peers.size >= 2) {
      return socket.emit('room-full');
    }
    peers.add(socket.id);
    currentRoom = roomId;
    socket.join(roomId);

    // tell others I'm here
    socket.to(roomId).emit('peer-joined', { id: socket.id });
    // if partner exists, both are ready to negotiate
    if (peers.size === 2) {
      io.to(roomId).emit('ready');
    }
  });

  socket.on('offer', ({ sdp, to }) => {
    if (!currentRoom) return;
    socket.to(to).emit('offer', { sdp, from: socket.id });
  });

  socket.on('answer', ({ sdp, to }) => {
    if (!currentRoom) return;
    socket.to(to).emit('answer', { sdp, from: socket.id });
  });

  socket.on('ice-candidate', ({ candidate, to }) => {
    if (!currentRoom) return;
    socket.to(to).emit('ice-candidate', { candidate, from: socket.id });
  });

  socket.on('signal', (payload) => {
    // generic small signals: mute, camera toggle, end call, screenshare etc.
    if (!currentRoom) return;
    socket.to(currentRoom).emit('signal', { from: socket.id, ...payload });
  });

  socket.on('leave', () => {
    cleanup();
  });

  socket.on('disconnect', () => {
    cleanup();
  });

  function cleanup() {
    if (!currentRoom) return;
    const peers = getPeers(currentRoom);
    if (peers) {
      peers.delete(socket.id);
      socket.to(currentRoom).emit('peer-left', { id: socket.id });
      if (peers.size === 0) rooms.delete(currentRoom);
    }
    currentRoom = null;
  }
});

app.get('/health', (_, res) => res.json({ ok: true }));
app.get('/ice', (_, res) => {
  // client fetches ICE config (avoid hardcoding in frontend)
  const stun = { urls: ['stun:stun.l.google.com:19302','stun:global.stun.twilio.com:3478'] };
  const turn = process.env.TURN_URL ? [{
    urls: [process.env.TURN_URL],
    username: process.env.TURN_USER,
    credential: process.env.TURN_PASS
  }] : [];
  res.json({ iceServers: [stun, ...turn] });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log('Signaling server on :' + PORT));
