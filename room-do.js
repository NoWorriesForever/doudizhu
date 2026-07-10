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

// 真人断线（关标签页/刷新/掉线）多久后视为“僵尸”而自动清理（毫秒）。
// 取 30s：避免游戏进行中短暂网络抖动误删；又能在关页/掉线后及时释放房间。
const ZOMBIE_MS = 30000;

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
    let roomId = url.searchParams.get('roomId');
    // 前端把 roomId 放在 POST body 里（join/addbot/play…），必须和 query 参数都兼容，
    // 否则会全部落入 'default' 实例，导致进房后状态错乱、页面假死。
    if (!roomId && request.method === 'POST') {
      try { const b = await request.clone().json(); roomId = b && b.roomId; } catch (e) {}
    }
    roomId = (roomId || 'default').toString();

    // 懒加载房间（优先从存储恢复）
    if (!this.room) {
      const saved = await this.state.storage.get('room');
      this.room = saved || roomModule.createRoom(roomId);
      this.room.id = roomId;
    }

    // 安排一次定时僵尸清理（即使无人连接，也能把“卡死满员”的房间清掉）。
    // 仅当尚无待触发 alarm 时才排期，避免每次请求都重排。
    try {
      const existing = await this.state.storage.getAlarm();
      if (!existing) await this.state.storage.setAlarm(Date.now() + ZOMBIE_MS);
    } catch (e) {}

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
        try {
          const msg = ev.data;
          if (msg === 'ping') { server.send('pong'); return; }
          let parsed;
          try { parsed = JSON.parse(msg); } catch (e) { return; }
          // 前端把出牌 / 叫地主等动作经 WS 发过来，省去一次穿隧道的 HTTP 往返
          if (parsed && parsed.route) {
            this.cleanupZombies();
            const result = processApi({
              room: this.room, route: parsed.route, q: parsed.q || {}, body: parsed.body || {},
              deps: { roomModule, botModule, broadcast: (r) => this.broadcast(r), now: Date.now() },
            });
            // 给发起者回执（含业务错误），其余客户端由上面的 broadcast 收到新状态
            if (parsed.reqId != null) {
              try {
                server.send(JSON.stringify({ reqId: parsed.reqId, res: result ? result.json : { err: 'no such api' } }));
              } catch (e) {}
            }
            this.afterAction();
          }
        } catch (e) {}
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
      this.cleanupZombies();
      runTick(this.room, {
        roomModule, botModule,
        broadcast: (r) => this.broadcast(r),
        now: Date.now(),
      });
      this.persist();
      this.syncLobby();
    }, 500);
  }

  // 清理“僵尸真人”：没有活跃 WebSocket 且 lastSeen 超过阈值的非机器人玩家。
  // 若清理后房间内已无任何真人（只剩机器人/空），则重置房间并标记删除（房间从大厅消失）。
  cleanupZombies() {
    if (!this.room) return;
    const now = Date.now();
    const live = (p) => {
      const ws = this.sessions.get(p.id);
      return !!(ws && ws.readyState === 1);
    };
    const before = this.room.players.length;
    this.room.players = this.room.players.filter(p =>
      p.isBot || live(p) || (now - (p.lastSeen || 0) < ZOMBIE_MS));

    // 房主失效则改派给仍在场的真人
    if (this.room.hostId && !this.room.players.some(p => p.id === this.room.hostId)) {
      const h = this.room.players.find(p => !p.isBot);
      this.room.hostId = h ? h.id : null;
    }
    // 无论人数是否变化，都要检查“是否还有真人”：仅剩机器人/空房间 → 重置并标记删除（房间消失）。
    // 注意：不能用 before===length 提前返回，否则仅剩机器人（人数不变）时不会触发重置。
    const humansLeft = this.room.players.filter(p => !p.isBot);
    if (humansLeft.length === 0) {
      this.room.players = [];
      this.room.hostId = null;
      roomModule.resetToLobby(this.room);
      this.room.__shouldDelete = true;
    }
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

  // 动作处理收尾：房间空则删存储并从大厅移除；否则持久化 + 同步大厅索引。
  // HTTP API 与 WS 动作通道共用，避免逻辑分叉。
  async afterAction() {
    if (this.room.__shouldDelete) {
      this.room.__shouldDelete = false;
      this.state.storage.delete('room').catch(() => {});
      await this.syncLobbyRemove();
    } else {
      this.persist();
      await this.syncLobby();
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

    // 任何请求都先清理僵尸（例如对“卡死满员”房间发起加入时，先清掉掉线真人，腾出空位/从大厅移除）
    this.cleanupZombies();

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

    await this.afterAction();
    return json(result.code, result.json);
  }

  // Durable Object 闹钟：即使无人连接，也会定期清理僵尸房间（解决“关页后房间卡满员”）
  async alarm() {
    if (!this.room) {
      const saved = await this.state.storage.get('room');
      this.room = saved || roomModule.createRoom('default');
      this.room.id = this.room.id || 'default';
    }
    this.cleanupZombies();
    if (this.room.__shouldDelete) {
      this.room.__shouldDelete = false;
      await this.state.storage.delete('room').catch(() => {});
      await this.state.storage.deleteAlarm().catch(() => {});
      await this.syncLobbyRemove();
      this.room = null;            // 下次 fetch 会重新懒加载（此时存储已空）
      return;
    }
    this.persist();
    await this.syncLobby();
    // 排期下一次清理
    try { await this.state.storage.setAlarm(Date.now() + ZOMBIE_MS); } catch (e) {}
  }
}
