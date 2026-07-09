'use strict';

// ============================================================
// 平台无关的房间 API 核心逻辑（server.js 与 Durable Object 共用）
// 返回 { code, json } 或 null（表示非本模块处理的路由）。
// 不含：SSE 流（/api/stream，仅 Node 版）、大厅房间列表（/api/rooms，由 Lobby DO 负责）。
// ============================================================

const roomModule = require('./room');
const botModule = require('./bot');
const { viewFor } = require('./view');

function ok(obj) { return { code: 200, json: obj }; }
function err(obj) { return { code: 200, json: obj }; } // 业务错误也走 200，前端按 json.err 判断

// 处理单个房间的动作。room 已确保存在。
// deps: { roomModule, botModule, broadcast(room), now }
function processApi({ room, route, q, body, deps }) {
  const { broadcast } = deps;
  const now = deps.now || Date.now();
  const findPlayer = (id) => room.players.find(x => x.id === id);

  try {
    // ---- 状态查询 ----
    if (route === 'state') {
      const p = findPlayer(q.playerId);
      if (p) p.lastSeen = now;
      return ok(viewFor(room, q.playerId));
    }

    // ---- 离开 ----
    if (route === 'leave') {
      const wasHost = room.hostId === body.playerId;
      if (wasHost) {
        const humans = room.players.filter(x => !x.isBot && x.id !== body.playerId);
        room.hostId = humans.length ? humans[0].id : null;
      }
      room.players = room.players.filter(x => x.id !== body.playerId);
      const result = roomModule.reseatAndReset(room);
      if (!result) { room.__shouldDelete = true; }
      broadcast(room);
      return ok({ ok: true });
    }

    // ---- 直接加入 ----
    if (route === 'join') {
      let p = body.playerId && findPlayer(body.playerId);
      if (!p) {
        if (room.players.length >= 3) return err({ err: '房间已满（3人）' });
        if (room.players.length === 0 && room.phase === 'lobby' && body.rounds) {
          room.totalRounds = Math.max(1, Math.min(20, body.rounds | 0));
        }
        const seat = [0, 1, 2].find(s => !roomModule.playerBySeat(room, s));
        p = {
          id: 'p' + (Date.now() % 100000),
          name: (body.name || '玩家').slice(0, 10),
          seat, hand: [], ready: false, isBot: false,
          score: 0, lastSeen: now
        };
        while (room.players.some(x => x.id === p.id)) p.id = 'p' + (Date.now() % 100000 + Math.random());
        room.players.push(p);
        if (!room.hostId) room.hostId = p.id;
        roomModule.bump(room, `${p.name} 加入了房间`);
      } else if (body.name) {
        p.name = body.name.slice(0, 10);
      }
      if (p) {
        p.lastSeen = now;
        roomModule.bump(room, `${p.name} 已连接`);
      }
      broadcast(room);
      return ok({ playerId: p.id, seat: p.seat, roomId: room.id, totalRounds: room.totalRounds });
    }

    // ---- 申请加入（待房主审批）----
    if (route === 'join-request') {
      if (room.phase !== 'lobby') return err({ err: '游戏已开始，无法加入' });
      if (room.players.length >= 3) return err({ err: '房间已满' });
      const name = (body.name || '玩家').slice(0, 10);
      const requestId = 'req' + Date.now() + '_' + Math.floor(Math.random() * 1000);
      room.pendingRequests.push({ requestId, name, createdAt: now });
      roomModule.bump(room);
      broadcast(room);
      return ok({ requestId });
    }

    // ---- 房主通过申请 ----
    if (route === 'join-approve') {
      const host = findPlayer(body.playerId);
      if (!host) return err({ err: '未加入房间' });
      if (room.hostId && host.id !== room.hostId) return err({ err: '只有房主可以审批' });
      const idx = room.pendingRequests.findIndex(r => r.requestId === body.requestId);
      if (idx < 0) return err({ err: '申请已失效' });
      if (room.players.length >= 3) {
        room.pendingRequests.splice(idx, 1);
        room.rejectedRequests[body.requestId] = true;
        roomModule.bump(room);
        broadcast(room);
        return err({ err: '房间已满' });
      }
      const rq = room.pendingRequests.splice(idx, 1)[0];
      const seat = [0, 1, 2].find(s => !roomModule.playerBySeat(room, s));
      const pid = 'p' + (Date.now() % 100000) + '_' + Math.floor(Math.random() * 100);
      const np = { id: pid, name: rq.name, seat, hand: [], ready: false, isBot: false, score: 0, lastSeen: now };
      room.players.push(np);
      if (!room.hostId) room.hostId = pid;
      room.approvedRequests[rq.requestId] = { playerId: pid, seat, roomId: room.id };
      roomModule.bump(room, `${np.name} 经房主通过后加入了房间`);
      broadcast(room);
      return ok({ ok: true, playerId: pid, seat, roomId: room.id });
    }

    // ---- 房主拒绝申请 ----
    if (route === 'join-reject') {
      const host = findPlayer(body.playerId);
      if (!host) return err({ err: '未加入房间' });
      if (room.hostId && host.id !== room.hostId) return err({ err: '只有房主可以审批' });
      const idx = room.pendingRequests.findIndex(r => r.requestId === body.requestId);
      if (idx < 0) return err({ err: '申请已失效' });
      const rq = room.pendingRequests.splice(idx, 1)[0];
      room.rejectedRequests[rq.requestId] = true;
      roomModule.bump(room);
      broadcast(room);
      return ok({ ok: true });
    }

    // ---- 申请者撤回申请 ----
    if (route === 'join-cancel') {
      const idx = room.pendingRequests.findIndex(r => r.requestId === body.requestId);
      if (idx >= 0) {
        const rq = room.pendingRequests.splice(idx, 1)[0];
        room.rejectedRequests[rq.requestId] = true;
        roomModule.bump(room);
        broadcast(room);
      }
      return ok({ ok: true });
    }

    // ---- 加机器人 ----
    if (route === 'addbot') {
      if (room.phase !== 'lobby') return err({ err: '游戏已开始' });
      if (room.players.length >= 3) return err({ err: '房间已满' });
      const seat = [0, 1, 2].find(s => !roomModule.playerBySeat(room, s));
      room.players.push({
        id: 'bot' + (Date.now() % 100000), name: '机器人' + seat, seat,
        hand: [], ready: true, isBot: true, score: 0, lastSeen: now
      });
      roomModule.bump(room, '一个机器人加入了房间');
      broadcast(room);
      return ok({ ok: true });
    }

    // ---- 准备 ----
    if (route === 'ready') {
      const p = findPlayer(body.playerId);
      if (!p) return err({ err: '未加入房间' });
      p.ready = !p.ready;
      roomModule.bump(room, `${p.name} ${p.ready ? '已准备' : '取消准备'}`);
      if (room.players.length === 3 && room.players.every(x => x.ready)) roomModule.startDeal(room);
      broadcast(room);
      return ok({ ok: true });
    }

    // ---- 叫/抢地主 ----
    if (route === 'bid') {
      const p = findPlayer(body.playerId);
      if (!p) return err({ err: '未加入房间' });
      const r = roomModule.doBid(room, p.seat, String(body.action || ''));
      if (!r.err) broadcast(room);
      return r.err ? err({ err: r.err }) : ok({ ok: true });
    }

    // ---- 出牌 ----
    if (route === 'play') {
      const p = findPlayer(body.playerId);
      if (!p) return err({ err: '未加入房间' });
      const r = roomModule.doPlay(room, p.seat, body.cardIds || []);
      if (!r.err) broadcast(room);
      return r.err ? err({ err: r.err }) : ok({ ok: true });
    }

    // ---- 不出 ----
    if (route === 'pass') {
      const p = findPlayer(body.playerId);
      if (!p) return err({ err: '未加入房间' });
      const r = roomModule.doPass(room, p.seat);
      if (!r.err) broadcast(room);
      return r.err ? err({ err: r.err }) : ok({ ok: true });
    }

    // ---- 设置局数 ----
    if (route === 'setrounds') {
      if (room.phase !== 'lobby') return err({ err: '游戏已开始，无法修改局数' });
      room.totalRounds = Math.max(1, Math.min(20, body.rounds | 0));
      roomModule.bump(room, `本轮设为 ${room.totalRounds} 局`);
      broadcast(room);
      return ok({ ok: true });
    }

    // ---- 下一局 ----
    if (route === 'next') {
      if (room.phase !== 'finished') return err({ err: '当前不能开始下一局' });
      if (room.roundNo >= room.totalRounds) return err({ err: '本轮已结束' });
      roomModule.startDeal(room);
      broadcast(room);
      return ok({ ok: true });
    }

    if (route === 'newmatch' || route === 'restart') {
      roomModule.resetToLobby(room);
      for (const bp of room.players) if (bp.isBot) bp.ready = true;
      broadcast(room);
      return ok({ ok: true });
    }

    return null; // 未匹配，交由调用方处理（如 rooms / stream）
  } catch (e) {
    return err({ err: 'server error: ' + e.message });
  }
}

module.exports = { processApi, viewFor };
