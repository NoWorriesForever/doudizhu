// ============================================================
// Durable Object：Room —— 一个房间一个实例
// 持有房间状态、WebSocket 连接广播、定时推进（机器人/超时）、持久化、同步大厅索引。
// 业务逻辑（出牌/叫地主等）复用 src/game-api.js 的 processApi（与本地 Node 版同一套）。
// ============================================================

import roomModule from './src/room.js';
import botModule from './src/bot.js';
import { viewFor } from './src/view.js';
import { processApi } from './src/game-api.js';
import { runTick } from './src/tick.js';

function json(code, obj) {
  return new Response(JSON.stringify(obj), {
    status: code,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.room = null;              // 房间状态（内存）
    this.sessions = new Map();     // playerId -> 服务端 WebSocket
    this.tickTimer = null;
    this._lastPersist = 0;
    this._lastLobby = 0;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const roomId = url.searchParams.get('roomId') || 'default';

    // 懒加载房间（优先从存储恢复）
    if (!this.room) {
      const saved = await this.state.storage.get('room');
      this.room = saved || roomModule.createRoom(roomId);
      this.room.id = roomId;
    }

    // WebSocket 实时通道
    if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
      return this.handleWS(request, roomId);
    }

    // HTTP API
    return this.handleApi(request, url, roomId);
  }

  // ---- WebSocket ----
  handleWS(request, roomId) {
    const pid = new URL(request.url).searchParams.get('playerId');
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    if (pid) {
      const old = this.sessions.get(pid);
      if (old) { try { old.close(); } catch (e) {} }
      this.sessions.set(pid, server);

      const p = this.room.players.find(x => x.id === pid);
      if (p) p.lastSeen = Date.now();

      // 立即推送当前视角
      try { server.send(JSON.stringify(viewFor(this.room, pid))); } catch (e) {}

      this.startTick();

      server.addEventListener('message', (ev) => {
        try { if (ev.data === 'ping') server.send('pong'); } catch (e) {}
      });
      server.addEventListener('close', () => {
        this.sessions.delete(pid);
        const pp = this.room.players.find(x => x.id === pid);
        if (pp) pp.lastSeen = Date.now();
        this.stopTickIfIdle();
      });
      server.addEventListener('error', () => { this.sessions.delete(pid); });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  startTick() {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => {
      runTick(this.room, {
        roomModule, botModule,
        broadcast: (r) => this.broadcast(r),
        now: Date.now(),
      });
      this.persist();
      this.syncLobby();
    }, 500);
  }

  stopTickIfIdle() {
    // 仅当无人连接且在大厅时才停表（游戏中有人掉线也由托管逻辑接管，但连接关闭即无 WS，tick 仍可停；下次连接再启）
    if (this.sessions.size === 0) {
      if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
    }
  }

  broadcast(room) {
    for (const p of room.players) {
      if (p.isBot) continue;
      const ws = this.sessions.get(p.id);
      if (ws && ws.readyState === 1) {
        try { ws.send(JSON.stringify(viewFor(room, p.id))); } catch (e) {}
      }
    }
  }

  persist() {
    const now = Date.now();
    if (now - this._lastPersist < 2000) return;
    this._lastPersist = now;
    this.state.storage.put('room', this.room).catch(() => {});
  }

  // 把房间摘要同步到全局 Lobby 索引
  async syncLobby() {
    const now = Date.now();
    if (now - this._lastLobby < 2000) return;
    this._lastLobby = now;
    try {
      const id = this.env.LOBBY.idFromName('global');
      const stub = this.env.LOBBY.get(id);
      const info = {
        roomId: this.room.id,
        hostName: (this.room.players.find(p => p.id === this.room.hostId)
          || this.room.players.find(p => !p.isBot) || {}).name || '—',
        phase: this.room.phase,
        playerCount: this.room.players.length,
        capacity: 3,
        isFull: this.room.players.length >= 3,
        canJoin: this.room.phase === 'lobby' && this.room.players.length < 3,
      };
      await stub.fetch('https://x/lobby-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(info),
      });
    } catch (e) { /* Lobby 不可用时忽略 */ }
  }

  async syncLobbyRemove() {
    try {
      const id = this.env.LOBBY.idFromName('global');
      const stub = this.env.LOBBY.get(id);
      await stub.fetch('https://x/lobby-remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: this.room.id }),
      });
    } catch (e) {}
  }

  async handleApi(request, url, roomId) {
    const route = url.pathname.startsWith('/api/')
      ? url.pathname.slice(5)
      : url.pathname.slice(1);

    let q = Object.fromEntries(url.searchParams.entries());
    let body = {};
    if (request.method === 'POST') {
      try { body = await request.json(); } catch (e) {}
    }

    // 申请加入状态（房间在 DO 内总存在）
    if (route === 'join-status') {
      const requestId = q.requestId || '';
      if (this.room.approvedRequests && this.room.approvedRequests[requestId]) {
        const a = this.room.approvedRequests[requestId];
        return json(200, { status: 'approved', playerId: a.playerId, seat: a.seat, roomId: a.roomId });
      }
      if (this.room.pendingRequests.some(r => r.requestId === requestId)) return json(200, { status: 'pending' });
      const rejected = this.room.rejectedRequests && this.room.rejectedRequests[requestId];
      return json(200, { status: 'rejected', reason: rejected ? '房主拒绝了你的申请' : '申请已失效' });
    }

    const result = processApi({
      room: this.room, route, q, body,
      deps: { roomModule, botModule, broadcast: (r) => this.broadcast(r), now: Date.now() },
    });

    if (!result) return json(404, { err: 'no such api' });

    // 离开后若房间空，清理存储并从大厅移除
    if (this.room.__shouldDelete) {
      this.room.__shouldDelete = false;
      this.state.storage.delete('room').catch(() => {});
      await this.syncLobbyRemove();
    } else {
      this.persist();
      await this.syncLobby();
    }

    return json(result.code, result.json);
  }
}
