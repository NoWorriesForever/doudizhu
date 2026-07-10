'use strict';

// ============================================================
// 斗地主联机模拟器 · 纯 Node WebSocket 服务器
// 适用：任意能跑 Node 的机器（本地电脑 / 云服务器 / 容器）。
// 复用 src/ 下全部业务逻辑（与 Cloudflare Workers 版同一套），前端零改动（同源同端口 WS）。
// 启动：node node-server.js   （端口由 PORT 环境变量控制，默认 3000）
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const roomModule = require('./src/room');
const botModule = require('./src/bot');
const { viewFor } = require('./src/view');
const { processApi } = require('./src/game-api');
const { runTick } = require('./src/tick');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ZOMBIE_MS = 30000;
const TICK_MS = 500;
const LOBBY_STALE_MS = roomModule.LOBBY_STALE_MS || 30000;

// 房间表：roomId -> { room, sessions: Map(pid->ws), tickTimer }
const rooms = new Map();

process.on('uncaughtException', (e) => console.error('[uncaughtException]', (e && e.stack) || e));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', (e && e.stack) || e));

function getEntry(roomId) {
  roomId = String(roomId || 'default');
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { room: roomModule.createRoom(roomId), sessions: new Map(), tickTimer: null });
  }
  return rooms.get(roomId);
}

function broadcast(entry) {
  const { room, sessions } = entry;
  for (const p of room.players) {
    if (p.isBot) continue;
    const ws = sessions.get(p.id);
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify(viewFor(room, p.id))); } catch (e) {}
    }
  }
}

function cleanupZombies(entry) {
  const { room, sessions } = entry;
  if (room.players.length === 0) return;
  const now = Date.now();
  const live = (p) => { const ws = sessions.get(p.id); return !!(ws && ws.readyState === 1); };
  room.players = room.players.filter(p =>
    p.isBot || live(p) || (now - (p.lastSeen || 0) < ZOMBIE_MS));
  if (room.hostId && !room.players.some(p => p.id === room.hostId)) {
    const h = room.players.find(p => !p.isBot);
    room.hostId = h ? h.id : null;
  }
  const humansLeft = room.players.filter(p => !p.isBot);
  if (humansLeft.length === 0) {
    room.players = [];
    room.hostId = null;
    roomModule.resetToLobby(room);
    room.__shouldDelete = true;
  }
}

function destroyEntry(id) {
  const entry = rooms.get(id);
  if (!entry) return;
  if (entry.tickTimer) { clearInterval(entry.tickTimer); entry.tickTimer = null; }
  rooms.delete(id);
}

function startTick(entry) {
  if (entry.tickTimer) return;
  entry.tickTimer = setInterval(() => {
    const id = entry.room.id;
    cleanupZombies(entry);
    if (entry.room.__shouldDelete) { destroyEntry(id); return; }
    runTick(entry.room, {
      roomModule, botModule,
      broadcast: () => broadcast(entry),
      now: Date.now(),
    });
    if (entry.room.__shouldDelete) { destroyEntry(id); return; }
  }, TICK_MS);
}

function stopTickIfIdle(entry) {
  if (entry.sessions.size === 0 && entry.room.phase === 'lobby') {
    if (entry.tickTimer) { clearInterval(entry.tickTimer); entry.tickTimer = null; }
  }
}

// 全局定时清理（模拟 DO alarm：即使无人连接也定期清理僵尸/空房间）
setInterval(() => {
  for (const [id, entry] of rooms) {
    if (entry.room.players.length === 0 && entry.sessions.size === 0) { destroyEntry(id); continue; }
    cleanupZombies(entry);
    if (entry.room.__shouldDelete) destroyEntry(id);
  }
}, ZOMBIE_MS);

// ============================================================
// HTTP 服务器
// ============================================================
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
  catch { pathname = req.url; }

  if (pathname === '/health' || pathname.endsWith('/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', rooms: rooms.size, ts: Date.now() }));
  }

  const apiIdx = pathname.indexOf('/api/');
  if (apiIdx >= 0) return handleApi(req, res, pathname, apiIdx);

  serveStatic(res, pathname);
});

async function handleApi(req, res, pathname, apiIdx) {
  const route = pathname.slice(apiIdx + 5);
  const parsedUrl = new URL(req.url, 'http://x');
  const q = Object.fromEntries(parsedUrl.searchParams.entries());

  let roomId = q.roomId;
  let body = {};
  if (req.method === 'POST') {
    body = await readBody(req);
    if (!roomId) roomId = body.roomId;
  }
  roomId = String(roomId || 'default');
  const entry = getEntry(roomId);
  cleanupZombies(entry);

  try {
    if (route === 'rooms' && req.method === 'GET') {
      const now = Date.now();
      const list = [];
      for (const e of rooms.values()) {
        const humans = e.room.players.filter(p => !p.isBot);
        if (humans.length === 0) continue;
        const anyRecent = humans.some(p => now - (p.lastSeen || 0) < LOBBY_STALE_MS);
        if (!anyRecent) continue;
        const inProgress = ['bidding', 'playing', 'reveal'].includes(e.room.phase);
        const notFull = e.room.phase === 'lobby' && e.room.players.length < 3;
        if (!inProgress && !notFull) continue;
        const host = e.room.players.find(p => p.id === e.room.hostId) || humans[0];
        list.push({
          roomId: e.room.id, hostName: host ? host.name : '—',
          phase: e.room.phase, playerCount: e.room.players.length, capacity: 3,
          isFull: e.room.players.length >= 3, canJoin: notFull,
        });
      }
      list.sort((a, b) => {
        if (a.canJoin !== b.canJoin) return a.canJoin ? -1 : 1;
        return String(a.roomId).localeCompare(String(b.roomId));
      });
      return send(res, 200, { rooms: list });
    }

    if (route === 'join-status') {
      const room = entry.room;
      const requestId = q.requestId || '';
      if (room.approvedRequests && room.approvedRequests[requestId]) {
        const a = room.approvedRequests[requestId];
        return send(res, 200, { status: 'approved', playerId: a.playerId, seat: a.seat, roomId: a.roomId });
      }
      if (room.pendingRequests.some(r => r.requestId === requestId)) return send(res, 200, { status: 'pending' });
      const rejected = room.rejectedRequests && room.rejectedRequests[requestId];
      return send(res, 200, { status: 'rejected', reason: rejected ? '房主拒绝了你的申请' : '申请已失效' });
    }

    const result = processApi({
      room: entry.room, route, q, body,
      deps: { roomModule, botModule, broadcast: () => broadcast(entry), now: Date.now() },
    });
    if (!result) return send(res, 404, { err: 'no such api' });

    if (entry.room.__shouldDelete) {
      entry.room.__shouldDelete = false;
      destroyEntry(roomId);
    }
    return send(res, result.code, result.json);
  } catch (e) {
    return send(res, 500, { err: 'server error: ' + e.message });
  }
}

function send(res, code, obj) {
  if (res.headersSent) return;
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function serveStatic(res, pathname) {
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(__dirname, 'public', filePath);
  const pub = path.join(__dirname, 'public');
  if (!filePath.startsWith(pub)) { if (!res.headersSent) { res.writeHead(403); res.end('Forbidden'); } return; }
  const mime = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.png': 'image/png', '.svg': 'image/svg+xml',
  };
  const ctype = mime[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      if (err.code === 'ENOENT') {
        fs.readFile(path.join(pub, 'index.html'), (e2, b2) => {
          if (e2) { if (!res.headersSent) { res.writeHead(500); res.end('Server error'); } return; }
          if (res.headersSent) return;
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(b2);
        });
        return;
      }
      if (!res.headersSent) { res.writeHead(500); res.end('Server error'); }
      return;
    }
    if (res.headersSent) return;
    res.writeHead(200, { 'Content-Type': ctype });
    res.end(buf);
  });
}

// ============================================================
// WebSocket（同端口 /ws?roomId=&playerId=）
// ============================================================
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  let parsedUrl;
  try { parsedUrl = new URL(req.url, 'http://x'); } catch (e) { socket.destroy(); return; }
  if (parsedUrl.pathname !== '/ws') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const roomId = parsedUrl.searchParams.get('roomId') || 'default';
    const pid = parsedUrl.searchParams.get('playerId') || '';
    const entry = getEntry(roomId);

    const old = entry.sessions.get(pid);
    if (old) { try { old.close(); } catch (e) {} }
    entry.sessions.set(pid, ws);

    const p = entry.room.players.find(x => x.id === pid);
    if (p) p.lastSeen = Date.now();

    try { ws.send(JSON.stringify(viewFor(entry.room, pid))); } catch (e) {}
    startTick(entry);

    ws.on('message', (msg) => {
      try {
        const s = msg.toString();
        if (s === 'ping') { ws.send('pong'); return; }
        let parsed;
        try { parsed = JSON.parse(s); } catch (e) { return; }
        // 前端把出牌 / 叫地主等动作经 WS 发过来，省去一次 HTTP 往返
        if (parsed && parsed.route) {
          cleanupZombies(entry);
          const result = processApi({
            room: entry.room, route: parsed.route, q: parsed.q || {}, body: parsed.body || {},
            deps: { roomModule, botModule, broadcast: () => broadcast(entry), now: Date.now() },
          });
          // 给发起者回执（含业务错误），其余客户端由上面的 broadcast 收到新状态
          if (parsed.reqId != null) {
            try { ws.send(JSON.stringify({ reqId: parsed.reqId, res: result ? result.json : { err: 'no such api' } })); } catch (e) {}
          }
          if (entry.room.__shouldDelete) destroyEntry(roomId);
        }
      } catch (e) {}
    });
    ws.on('close', () => {
      entry.sessions.delete(pid);
      const pp = entry.room.players.find(x => x.id === pid);
      if (pp) pp.lastSeen = Date.now();
      stopTickIfIdle(entry);
    });
    ws.on('error', () => { entry.sessions.delete(pid); });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[斗地主] 服务已启动  http://${HOST}:${PORT}  (Node WebSocket 版)`);
  console.log(`[斗地主] 本机访问:   http://localhost:${PORT}`);
  console.log(`[斗地主] 局域网访问: http://<本机IP>:${PORT}`);
});
