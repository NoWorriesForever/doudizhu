'use strict';

// ============================================================
// 房间定时推进（机器人 AI / 超时托管 / 申请超时 / 亮牌计时）
// server.js 与 Durable Object 共用；broadcast 由调用方注入。
// ============================================================

// deps: { roomModule, botModule, broadcast, now }
function runTick(room, deps) {
  const { roomModule, botModule, broadcast } = deps;
  const now = deps.now || Date.now();
  let changed = false;

  // lobby 清理掉线玩家（仅真人）
  if (room.phase === 'lobby') {
    const before = room.players.length;
    room.players = room.players.filter(p =>
      p.isBot || (now - (p.lastSeen || 0) < roomModule.LOBBY_STALE_MS));
    if (room.players.length !== before) {
      roomModule.reseatAndReset(room);
      changed = true;
    }
  }

  // 清理过期的加入申请（超时自动拒绝，供申请者轮询拿到 rejected）
  if (room.pendingRequests && room.pendingRequests.length) {
    const before = room.pendingRequests.length;
    room.pendingRequests = room.pendingRequests.filter(r => {
      if (now - (r.createdAt || 0) > roomModule.REQUEST_TTL_MS) {
        room.rejectedRequests[r.requestId] = true;
        return false;
      }
      return true;
    });
    if (room.pendingRequests.length !== before) {
      room.rejectedRequests = room.rejectedRequests || {};
      roomModule.bump(room);
      changed = true;
    }
  }

  // 展示赢家最后一手 3 秒后 → 进入亮牌（展示各家余牌）
  if (room.phase === 'showwin' && now - (room.winShowAt || 0) > roomModule.SHOWWIN_MS) {
    room.phase = 'reveal';
    room.revealAt = now;
    const r = room.lastResult;
    const who = r && r.winnerSide === 'landlord' ? '地主获胜！' : '农民获胜！';
    room.message = `亮牌中：${who}`;
    roomModule.bump(room);
    changed = true;
  }

  // 亮牌若干秒后进入结算；清空准备状态，进入“下一局”准备门控
  if (room.phase === 'reveal' && now - (room.revealAt || 0) > roomModule.REVEAL_MS) {
    room.phase = 'finished';
    room.finishedAt = now;
    room.players.forEach(p => { p.ready = false; });
    const r = room.lastResult;
    const who = r && r.winnerSide === 'landlord' ? '地主获胜！' : '农民获胜！';
    const matchOver = room.roundNo >= room.totalRounds;
    room.message = matchOver
      ? `最终结算：${room.totalRounds} 局打完`
      : `第 ${room.roundNo}/${room.totalRounds} 局：${who}`;
    roomModule.bump(room);
    changed = true;
  }

  // 结算后：机器人 / 掉线真人 3 秒自动准备下一局；三人全准备则自动开下一局/新一轮
  if (room.phase === 'finished' && now - (room.finishedAt || 0) >= roomModule.NEXT_READY_MS) {
    let autoed = false;
    for (const p of room.players) {
      if (!p.ready && (p.isBot || (now - (p.lastSeen || 0) > roomModule.HOST_MS))) {
        p.ready = true;
        autoed = true;
      }
    }
    if (autoed) { roomModule.bump(room); changed = true; }
    if (roomModule.tryStartAfterReady(room)) changed = true;
  }

  // 机器人思考 / 断线托管 / 在线超时
  const curTurnSeat = room.phase === 'bidding' ? room.bidSeat
    : (room.phase === 'playing' ? room.curSeat : -1);

  if (curTurnSeat >= 0) {
    const p = roomModule.playerBySeat(room, curTurnSeat);
    if (p) {
      const elapsed = now - (room.turnStartAt || now);
      const disconnected = !p.isBot && (now - (p.lastSeen || 0) > roomModule.HOST_MS);
      try {
        if (p.isBot) {
          // 机器人思考约 3 秒后行动
          if (elapsed >= roomModule.BOT_THINK_MS) {
            if (room.phase === 'bidding') {
              roomModule.doBid(room, curTurnSeat, botModule.botBid(room, curTurnSeat));
            } else {
              const move = botModule.botMove(room, curTurnSeat);
              if (move.action === 'play') roomModule.doPlay(room, curTurnSeat, move.ids);
              else roomModule.doPass(room, curTurnSeat);
            }
            changed = true;
          }
        } else if (disconnected) {
          // 断线托管：立即替决策
          if (room.phase === 'bidding') {
            roomModule.doBid(room, curTurnSeat, botModule.botBid(room, curTurnSeat));
          } else {
            const move = botModule.botMove(room, curTurnSeat);
            if (move.action === 'play') roomModule.doPlay(room, curTurnSeat, move.ids);
            else roomModule.doPass(room, curTurnSeat);
          }
          changed = true;
        } else {
          // 在线真人：15 秒超时
          if (elapsed >= roomModule.TURN_MS) {
            if (room.phase === 'bidding') {
              roomModule.doBid(room, curTurnSeat, room.bidRound === 'call' ? 'pass' : 'nograb');
            } else if (room.lastPlay === null) {
              // 领出超时：托管出最小牌
              const move = botModule.botMove(room, curTurnSeat);
              if (move.action === 'play') roomModule.doPlay(room, curTurnSeat, move.ids);
              else if (p.hand.length) roomModule.doPlay(room, curTurnSeat, [p.hand[0].id]);
            } else {
              roomModule.doPass(room, curTurnSeat);
            }
            changed = true;
          }
        }
      } catch (e) { /* 忽略单步异常 */ }
    }
  }

  if (changed && broadcast) broadcast(room);
}

module.exports = { runTick };
