'use strict';

// ============================================================
// Node HTTP 适配层（本地版 / 兼容旧部署）
// 业务逻辑在 src/game-api.js（processApi），本文件只做 http 收发 + SSE + 大厅列表。
// ============================================================

const http = require('http');
const url = require('url');
const { viewFor } = require('./view');
const { processApi } = require('./game-api');

// SSE 广播：向房间内所有真人推送各自视角
function broadcastRoom(room) {
  const sseModule = require('./sse');
  for (const p of room.players) {
    if (!p.isBot) sseModule.pushToPlayer(room.id, p.id, viewFor(room, p.id));
  }
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { resolve({}); }
    });
  });
}

function getRoom(roomId, rooms) {
  const roomModule = require('./room');
  if (!rooms.has(roomId)) rooms.set(roomId, roomModule.createRoom(roomId));
  return rooms.get(roomId);
}

async function handleApi(req, res, rooms) {
  const roomModule = require('./room');
  const sseModule = require('./sse');

  const parsedUrl = url.parse(req.url, true);
  let pathname;
  try { pathname = decodeURIComponent(parsedUrl.pathname); }
  catch { pathname = parsedUrl.pathname; }

  const apiIdx = pathname.indexOf('/api/');
  if (apiIdx < 0) return false;

  const route = pathname.slice(apiIdx + 5);
  const q = parsedUrl.query;

  try {
    // ---- SSE 流（仅 Node 版）----
    if (route === 'stream' && req.method === 'GET') {
      const roomId = q.roomId || 'default';
      const pid = q.playerId;
      if (!pid) { send(res, 400, { err: 'missing playerId' }); return true; }
      const room = getRoom(roomId, rooms);
      const p = room.players.find(x => x.id === pid);
      if (!p) { send(res, 404, { err: 'not in room' }); return true; }
      p.lastSeen = Date.now();
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(`data: ${JSON.stringify(viewFor(room, pid))}\n\n`);
      const key = sseModule.addClient(roomId, pid, res);
      const heartbeat = setInterval(() => {
        try { p.lastSeen = Date.now(); res.write(': heartbeat\n\n'); } catch (e) { clearInterval(heartbeat); }
      }, 5000);
      req.on('close', () => { clearInterval(heartbeat); sseModule.removeClient(res, key); });
      return true;
    }

    // ---- 大厅房间浏览：进行中 + 未满大厅 ----
    if (route === 'rooms' && req.method === 'GET') {
      const now = Date.now();
      const list = [];
      for (const room of rooms.values()) {
        const humans = room.players.filter(p => !p.isBot);
        if (humans.length === 0) continue;
        const anyRecent = humans.some(p => now - (p.lastSeen || 0) < roomModule.LOBBY_STALE_MS);
        if (!anyRecent) continue;
        const inProgress = ['bidding', 'playing', 'reveal'].includes(room.phase);
        const notFull = room.phase === 'lobby' && room.players.length < 3;
        if (!inProgress && !notFull) continue;
        const host = room.players.find(p => p.id === room.hostId) || humans[0];
        list.push({
          roomId: room.id, hostName: host ? host.name : '—',
          phase: room.phase, playerCount: room.players.length, capacity: 3,
          isFull: room.players.length >= 3, canJoin: notFull,
        });
      }
      list.sort((a, b) => {
        if (a.canJoin !== b.canJoin) return a.canJoin ? -1 : 1;
        return String(a.roomId).localeCompare(String(b.roomId));
      });
      send(res, 200, { rooms: list });
      return true;
    }

    // ---- 申请加入状态（申请者轮询）----
    if (route === 'join-status' && req.method === 'GET') {
      const roomId = (q.roomId || '').trim();
      const requestId = q.requestId || '';
      const room = rooms.get(roomId);
      if (!room) return send(res, 200, { status: 'rejected', reason: '房间已关闭' });
      if (room.approvedRequests && room.approvedRequests[requestId]) {
        const a = room.approvedRequests[requestId];
        return send(res, 200, { status: 'approved', playerId: a.playerId, seat: a.seat, roomId: a.roomId });
      }
      if (room.pendingRequests.some(r => r.requestId === requestId)) return send(res, 200, { status: 'pending' });
      const rejected = room.rejectedRequests && room.rejectedRequests[requestId];
      return send(res, 200, { status: 'rejected', reason: rejected ? '房主拒绝了你的申请' : '申请已失效' });
    }

    // ---- 其余动作：委托平台无关的 processApi ----
    const body = (req.method === 'POST') ? await readBody(req) : {};
    const room = getRoom(q.roomId || body.roomId || 'default', rooms);
    const result = processApi({
      room, route, q, body,
      deps: { roomModule, botModule: require('./bot'), broadcast: broadcastRoom, now: Date.now() }
    });
    if (!result) return false; // 非 api 路由
    send(res, result.code, result.json);
    return true;
  } catch (e) {
    return send(res, 500, { err: 'server error: ' + e.message });
  }
}

// 大厅清理（lobby 掉线玩家）
function purgeStale(room, roomModule) {
  const now = Date.now();
  if (room.phase === 'lobby') {
    const before = room.players.length;
    room.players = room.players.filter(p => p.isBot || (now - (p.lastSeen || 0) < roomModule.LOBBY_STALE_MS));
    if (room.players.length !== before) roomModule.reseatAndReset(room);
  }
}

module.exports = { handleApi, viewFor, getRoom, broadcastRoom, purgeStale, processApi };
