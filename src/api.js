'use strict';

// ============================================================
// HTTP API 路由 + SSE 端点
// ============================================================

const http = require('http');
const url = require('url');

// 向房间内所有真人玩家推送各自视角（用户操作后即时广播，无需等待 tick）
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

// 根据房间号获取或创建房间
function getRoom(roomId, rooms) {
  const room = require('./room');
  if (!rooms.has(roomId)) {
    rooms.set(roomId, room.createRoom(roomId));
  }
  return rooms.get(roomId);
}

// 生成玩家视角的状态视图
function viewFor(room, playerId) {
  const roomModule = require('./room');
  const me = room.players.find(p => p.id === playerId);
  const revealing = room.phase === 'reveal' || room.phase === 'finished';
  const now = Date.now();
  const turnSeat = room.phase === 'bidding' ? room.bidSeat
    : (room.phase === 'playing' ? room.curSeat : -1);

  const seats = [0, 1, 2].map(s => {
    const p = roomModule.playerBySeat(room, s);
    if (!p) return null;
    const conn = roomModule.isConnected(p, now);
    return {
      seat: s, name: p.name, isBot: p.isBot,
      handCount: p.hand.length,
      score: p.score || 0,
      isLandlord: room.landlordSeat === s,
      isCaller: room.calledSeat === s,
      connected: conn,
      hosting: !p.isBot && !conn && s === turnSeat
        && (now - (p.lastSeen || 0) > roomModule.HOST_MS),
      hand: revealing ? p.hand : undefined,
    };
  });

  return {
    version: room.version,
    roomId: room.id,
    phase: room.phase,
    message: room.message,
    seats,
    mySeat: me ? me.seat : -1,
    myHand: me ? me.hand : [],
    myReady: me ? !!me.ready : false,
    landlordSeat: room.landlordSeat,
    baseScore: room.baseScore,
    bombCount: room.bombCount,
    callMult: room.callMult,
    bidRound: room.bidRound,
    totalRounds: room.totalRounds,
    roundNo: room.roundNo,
    matchOver: room.phase === 'finished' && room.roundNo >= room.totalRounds,
    bottom: (room.phase === 'playing' || revealing) ? room.bottom : [],
    bidSeat: room.bidSeat,
    curSeat: room.curSeat,
    lastPlay: room.lastPlay ? { seat: room.lastPlay.seat, cards: room.lastPlay.cards } : null,
    winnerSide: room.winnerSide,
    result: room.lastResult,
    playerCount: room.players.length,
    allReady: room.players.length === 3 && room.players.every(p => p.ready),
    // 房主 + 加入申请（仅房主视角可见 pendingRequests）
    isHost: !!(me && room.hostId && me.id === room.hostId),
    pendingRequests: (me && room.hostId && me.id === room.hostId)
      ? room.pendingRequests.map(r => ({ requestId: r.requestId, name: r.name }))
      : undefined,
    // 新增：回放日志（仅 reveal/finished 时返回）
    playLog: revealing ? room.playLog : undefined,
    seenCards: room.seenCards,
    // 出牌倒计时
    turnStartAt: room.turnStartAt || 0,
    turnMs: roomModule.TURN_MS,
    botThinkMs: roomModule.BOT_THINK_MS,
  };
}

// 主路由处理器
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
    // ---- SSE 流 ----
    if (route === 'stream' && req.method === 'GET') {
      const roomId = q.roomId || 'default';
      const pid = q.playerId;
      if (!pid) { send(res, 400, { err: 'missing playerId' }); return true; }

      const room = getRoom(roomId, rooms);
      const p = room.players.find(x => x.id === pid);
      if (!p) { send(res, 404, { err: 'not in room' }); return true; }
      p.lastSeen = Date.now();

      // SSE 头
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      // 立即推送当前状态
      res.write(`data: ${JSON.stringify(viewFor(room, pid))}\n\n`);

      const key = sseModule.addClient(roomId, pid, res);

      // 心跳保活：每 5 秒发心跳并刷新 lastSeen，避免 SSE 在线玩家被误判掉线
      const heartbeat = setInterval(() => {
        try {
          p.lastSeen = Date.now();
          res.write(': heartbeat\n\n');
        } catch (e) {
          clearInterval(heartbeat);
        }
      }, 5000);

      req.on('close', () => {
        clearInterval(heartbeat);
        sseModule.removeClient(res, key);
      });

      return true; // 连接保持，不关闭
    }

    // ---- 大厅房间浏览：进行中 + 未满大厅 ----
    if (route === 'rooms' && req.method === 'GET') {
      const now = Date.now();
      const list = [];
      for (const room of rooms.values()) {
        const humans = room.players.filter(p => !p.isBot);
        if (humans.length === 0) continue;                 // 无真人，跳过
        const anyRecent = humans.some(p => now - (p.lastSeen || 0) < roomModule.LOBBY_STALE_MS);
        if (!anyRecent) continue;                           // 全是死连接，跳过
        const inProgress = ['bidding', 'playing', 'reveal'].includes(room.phase);
        const notFull = room.phase === 'lobby' && room.players.length < 3;
        if (!inProgress && !notFull) continue;              // 只展示进行中 / 未满大厅
        const host = room.players.find(p => p.id === room.hostId) || humans[0];
        list.push({
          roomId: room.id,
          hostName: host ? host.name : '—',
          phase: room.phase,
          playerCount: room.players.length,
          capacity: 3,
          isFull: room.players.length >= 3,
          canJoin: notFull,
        });
      }
      // 未满大厅优先，其次按房间号排序
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
      if (room.pendingRequests.some(r => r.requestId === requestId)) {
        return send(res, 200, { status: 'pending' });
      }
      const rejected = room.rejectedRequests && room.rejectedRequests[requestId];
      return send(res, 200, { status: 'rejected', reason: rejected ? '房主拒绝了你的申请' : '申请已失效' });
    }

    // ---- 状态查询（回退，非 SSE 场景）- ==
    if (route === 'state' && req.method === 'GET') {
      const room = getRoom(q.roomId || 'default', rooms);
      const p = room.players.find(x => x.id === q.playerId);
      if (p) p.lastSeen = Date.now();
      send(res, 200, viewFor(room, q.playerId));
      return true;
    }

    // ---- 以下 POST ----
    const body = (req.method === 'POST') ? await readBody(req) : {};

    if (route === 'leave' && req.method === 'POST') {
      const room = getRoom(body.roomId || 'default', rooms);
      const wasHost = room.hostId === body.playerId;
      if (wasHost) {
        const humans = room.players.filter(x => !x.isBot && x.id !== body.playerId);
        room.hostId = humans.length ? humans[0].id : null;
      }
      room.players = room.players.filter(x => x.id !== body.playerId);
      const result = roomModule.reseatAndReset(room);
      if (!result) rooms.delete(body.roomId || 'default');
      broadcastRoom(room);
      send(res, 200, { ok: true });
      return true;
    }

    if (route === 'join' && req.method === 'POST') {
      const roomId = (body.roomId || 'default').trim() || 'default';
      const room = getRoom(roomId, rooms);
      purgeStale(room, roomModule);

      let p = body.playerId && room.players.find(x => x.id === body.playerId);
      if (!p) {
        if (room.players.length >= 3) return send(res, 200, { err: '房间已满（3人）' });
        if (room.players.length === 0 && room.phase === 'lobby' && body.rounds) {
          room.totalRounds = Math.max(1, Math.min(20, body.rounds | 0));
        }
        const seat = [0, 1, 2].find(s => !roomModule.playerBySeat(room, s));
        p = {
          id: 'p' + (Date.now() % 100000),
          name: (body.name || '玩家').slice(0, 10),
          seat, hand: [], ready: false, isBot: false,
          score: 0, lastSeen: Date.now()
        };
        // 确保 pid 唯一
        while (room.players.some(x => x.id === p.id)) p.id = 'p' + (Date.now() % 100000 + Math.random());
        room.players.push(p);
        if (!room.hostId) room.hostId = p.id;   // 首个加入的真人成为房主
        roomModule.bump(room, `${p.name} 加入了房间`);
      } else if (body.name) {
        p.name = body.name.slice(0, 10);
      }
      if (p) {
        p.lastSeen = Date.now();
        roomModule.bump(room, `${p.name} 已连接`);
      }
      send(res, 200, { playerId: p.id, seat: p.seat, roomId: room.id, totalRounds: room.totalRounds });
      broadcastRoom(room);
      return true;
    }

    // ---- 申请加入（不直接进房，待房主审批）----
    if (route === 'join-request' && req.method === 'POST') {
      const roomId = (body.roomId || '').trim();
      if (!roomId) return send(res, 200, { err: '房间号不能为空' });
      const room = rooms.get(roomId);
      if (!room) return send(res, 200, { err: '房间不存在' });
      if (room.phase !== 'lobby') return send(res, 200, { err: '游戏已开始，无法加入' });
      if (room.players.length >= 3) return send(res, 200, { err: '房间已满' });
      const name = (body.name || '玩家').slice(0, 10);
      const requestId = 'req' + Date.now() + '_' + Math.floor(Math.random() * 1000);
      room.pendingRequests.push({ requestId, name, createdAt: Date.now() });
      roomModule.bump(room);
      broadcastRoom(room);
      send(res, 200, { requestId });
      return true;
    }

    // ---- 房主通过申请 ----
    if (route === 'join-approve' && req.method === 'POST') {
      const room = rooms.get(body.roomId || 'default');
      if (!room) return send(res, 200, { err: '房间不存在' });
      const host = room.players.find(x => x.id === body.playerId);
      if (!host) return send(res, 200, { err: '未加入房间' });
      if (room.hostId && host.id !== room.hostId) return send(res, 200, { err: '只有房主可以审批' });
      const idx = room.pendingRequests.findIndex(r => r.requestId === body.requestId);
      if (idx < 0) return send(res, 200, { err: '申请已失效' });
      if (room.players.length >= 3) {
        room.pendingRequests.splice(idx, 1);
        room.rejectedRequests[body.requestId] = true;
        roomModule.bump(room);
        broadcastRoom(room);
        return send(res, 200, { err: '房间已满' });
      }
      const rq = room.pendingRequests.splice(idx, 1)[0];
      const seat = [0, 1, 2].find(s => !roomModule.playerBySeat(room, s));
      const pid = 'p' + (Date.now() % 100000) + '_' + Math.floor(Math.random() * 100);
      const np = {
        id: pid, name: rq.name, seat, hand: [], ready: false,
        isBot: false, score: 0, lastSeen: Date.now()
      };
      room.players.push(np);
      if (!room.hostId) room.hostId = pid;
      room.approvedRequests[rq.requestId] = { playerId: pid, seat, roomId: room.id };
      roomModule.bump(room, `${np.name} 经房主通过后加入了房间`);
      broadcastRoom(room);
      send(res, 200, { ok: true, playerId: pid, seat, roomId: room.id });
      return true;
    }

    // ---- 房主拒绝申请 ----
    if (route === 'join-reject' && req.method === 'POST') {
      const room = rooms.get(body.roomId || 'default');
      if (!room) return send(res, 200, { err: '房间不存在' });
      const host = room.players.find(x => x.id === body.playerId);
      if (!host) return send(res, 200, { err: '未加入房间' });
      if (room.hostId && host.id !== room.hostId) return send(res, 200, { err: '只有房主可以审批' });
      const idx = room.pendingRequests.findIndex(r => r.requestId === body.requestId);
      if (idx < 0) return send(res, 200, { err: '申请已失效' });
      const rq = room.pendingRequests.splice(idx, 1)[0];
      room.rejectedRequests[rq.requestId] = true;
      roomModule.bump(room);
      broadcastRoom(room);
      send(res, 200, { ok: true });
      return true;
    }

    // ---- 申请者撤回申请 ----
    if (route === 'join-cancel' && req.method === 'POST') {
      const room = rooms.get(body.roomId || 'default');
      if (!room) return send(res, 200, { err: '房间不存在' });
      const idx = room.pendingRequests.findIndex(r => r.requestId === body.requestId);
      if (idx >= 0) {
        const rq = room.pendingRequests.splice(idx, 1)[0];
        room.rejectedRequests[rq.requestId] = true;
        roomModule.bump(room);
        broadcastRoom(room);
      }
      send(res, 200, { ok: true });
      return true;
    }

    if (route === 'addbot' && req.method === 'POST') {
      const room = getRoom(body.roomId || 'default', rooms);
      if (room.phase !== 'lobby') return send(res, 200, { err: '游戏已开始' });
      if (room.players.length >= 3) return send(res, 200, { err: '房间已满' });
      const seat = [0, 1, 2].find(s => !roomModule.playerBySeat(room, s));
      room.players.push({
        id: 'bot' + (Date.now() % 100000),
        name: '机器人' + seat,
        seat, hand: [], ready: true,
        isBot: true, score: 0, lastSeen: Date.now()
      });
      roomModule.bump(room, '一个机器人加入了房间');
      broadcastRoom(room);
      send(res, 200, { ok: true });
      return true;
    }

    if (route === 'ready' && req.method === 'POST') {
      const room = getRoom(body.roomId || 'default', rooms);
      const p = room.players.find(x => x.id === body.playerId);
      if (!p) return send(res, 200, { err: '未加入房间' });
      p.ready = !p.ready;
      roomModule.bump(room, `${p.name} ${p.ready ? '已准备' : '取消准备'}`);
      if (room.players.length === 3 && room.players.every(x => x.ready))
        roomModule.startDeal(room);
      broadcastRoom(room);
      send(res, 200, { ok: true });
      return true;
    }

    if (route === 'bid' && req.method === 'POST') {
      const room = getRoom(body.roomId || 'default', rooms);
      const p = room.players.find(x => x.id === body.playerId);
      if (!p) return send(res, 200, { err: '未加入房间' });
      const r = roomModule.doBid(room, p.seat, String(body.action || ''));
      if (!r.err) broadcastRoom(room);
      send(res, 200, r.err ? { err: r.err } : { ok: true });
      return true;
    }

    if (route === 'play' && req.method === 'POST') {
      const room = getRoom(body.roomId || 'default', rooms);
      const p = room.players.find(x => x.id === body.playerId);
      if (!p) return send(res, 200, { err: '未加入房间' });
      const r = roomModule.doPlay(room, p.seat, body.cardIds || []);
      if (!r.err) broadcastRoom(room);
      send(res, 200, r.err ? { err: r.err } : { ok: true });
      return true;
    }

    if (route === 'pass' && req.method === 'POST') {
      const room = getRoom(body.roomId || 'default', rooms);
      const p = room.players.find(x => x.id === body.playerId);
      if (!p) return send(res, 200, { err: '未加入房间' });
      const r = roomModule.doPass(room, p.seat);
      if (!r.err) broadcastRoom(room);
      send(res, 200, r.err ? { err: r.err } : { ok: true });
      return true;
    }

    if (route === 'setrounds' && req.method === 'POST') {
      const room = getRoom(body.roomId || 'default', rooms);
      if (room.phase !== 'lobby') return send(res, 200, { err: '游戏已开始，无法修改局数' });
      room.totalRounds = Math.max(1, Math.min(20, body.rounds | 0));
      roomModule.bump(room, `本轮设为 ${room.totalRounds} 局`);
      broadcastRoom(room);
      send(res, 200, { ok: true });
      return true;
    }

    if (route === 'next' && req.method === 'POST') {
      const room = getRoom(body.roomId || 'default', rooms);
      if (room.phase !== 'finished') return send(res, 200, { err: '当前不能开始下一局' });
      if (room.roundNo >= room.totalRounds) return send(res, 200, { err: '本轮已结束' });
      roomModule.startDeal(room);
      broadcastRoom(room);
      send(res, 200, { ok: true });
      return true;
    }

    if (route === 'newmatch' && req.method === 'POST') {
      const room = getRoom(body.roomId || 'default', rooms);
      roomModule.resetToLobby(room);
      for (const bp of room.players) if (bp.isBot) bp.ready = true;
      broadcastRoom(room);
      send(res, 200, { ok: true });
      return true;
    }

    if (route === 'restart' && req.method === 'POST') {
      const room = getRoom(body.roomId || 'default', rooms);
      roomModule.resetToLobby(room);
      for (const bp of room.players) if (bp.isBot) bp.ready = true;
      broadcastRoom(room);
      send(res, 200, { ok: true });
      return true;
    }

    return send(res, 404, { err: 'no such api' });
  } catch (e) {
    return send(res, 500, { err: 'server error: ' + e.message });
  }
}

// 大厅清理
function purgeStale(room, roomModule) {
  const now = Date.now();
  if (room.phase === 'lobby') {
    const before = room.players.length;
    room.players = room.players.filter(p =>
      p.isBot || (now - (p.lastSeen || 0) < roomModule.LOBBY_STALE_MS));
    if (room.players.length !== before) roomModule.reseatAndReset(room);
  }
}

// SSE 广播：对房间里所有已连接的玩家推送其个人视角
function pushStateToRoom(roomId, playerIds, rooms) {
  const sseModule = require('./sse');
  for (const pid of playerIds) {
    const room = rooms.get(roomId);
    if (!room) continue;
    sseModule.pushToPlayer(roomId, pid, viewFor(room, pid));
  }
}

module.exports = { handleApi, viewFor, getRoom, purgeStale, pushStateToRoom };
