import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/signal' });

const PORT = Number(process.env.PORT || 3000);
const rooms = new Map();
const CODE_TTL_MS = 60 * 60 * 1000;
const MAX_ROOMS = 5000;

app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html']
}));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

function makeCode() {
  for (let i = 0; i < 100; i += 1) {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    if (!rooms.has(code)) return code;
  }
  throw new Error('Unable to allocate room code');
}

function send(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function broadcast(room, sender, message) {
  for (const peer of room.peers) {
    if (peer !== sender) send(peer.ws, message);
  }
}

function cleanupRoom(room) {
  if (room.peers.size === 0) rooms.delete(room.code);
}

function makeRoom(ws) {
  if (rooms.size >= MAX_ROOMS) throw new Error('Server room capacity reached');
  const code = makeCode();
  const room = {
    code,
    createdAt: Date.now(),
    peers: new Set()
  };
  room.peers.add({ ws, role: 'host' });
  rooms.set(code, room);
  ws.roomCode = code;
  ws.role = 'host';
  send(ws, { type: 'room-created', code, role: 'host' });
}

function joinRoom(ws, rawCode) {
  const code = String(rawCode || '').replace(/\D/g, '').slice(0, 6);
  const room = rooms.get(code);
  if (!room) {
    send(ws, { type: 'error', code: 'ROOM_NOT_FOUND', message: 'Match not found.' });
    return;
  }
  if (room.peers.size >= 2) {
    send(ws, { type: 'error', code: 'ROOM_FULL', message: 'That match is already full.' });
    return;
  }

  const peer = { ws, role: 'guest' };
  room.peers.add(peer);
  ws.roomCode = code;
  ws.role = 'guest';
  send(ws, { type: 'room-joined', code, role: 'guest' });
  const host = [...room.peers].find(p => p.role === 'host');
  if (host) {
    send(host.ws, { type: 'peer-joined' });
  }
}

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      send(ws, { type: 'error', code: 'BAD_JSON', message: 'Invalid message.' });
      return;
    }

    try {
      if (message.type === 'create-room') {
        if (ws.roomCode) return;
        makeRoom(ws);
        return;
      }
      if (message.type === 'join-room') {
        if (ws.roomCode) return;
        joinRoom(ws, message.code);
        return;
      }

      if (!ws.roomCode) {
        send(ws, { type: 'error', code: 'NOT_IN_ROOM', message: 'Create or join a match first.' });
        return;
      }
      const room = rooms.get(ws.roomCode);
      if (!room) {
        send(ws, { type: 'error', code: 'ROOM_EXPIRED', message: 'The match room expired.' });
        return;
      }

      if (message.type === 'signal') {
        broadcast(room, ws, { type: 'signal', data: message.data });
      } else if (message.type === 'leave') {
        ws.close();
      }
    } catch (error) {
      send(ws, { type: 'error', code: 'SERVER_ERROR', message: error?.message || 'Server error.' });
    }
  });

  ws.on('close', () => {
    const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
    if (!room) return;
    for (const peer of room.peers) {
      if (peer.ws === ws) room.peers.delete(peer);
    }
    broadcast(room, ws, { type: 'peer-left' });
    cleanupRoom(room);
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.createdAt > CODE_TTL_MS && room.peers.size === 0) rooms.delete(code);
  }
}, 30_000);
heartbeat.unref();

server.listen(PORT, () => {
  console.log(`AeroTennis running on http://localhost:${PORT}`);
});

process.on('SIGTERM', () => {
  clearInterval(heartbeat);
  server.close(() => process.exit(0));
});
