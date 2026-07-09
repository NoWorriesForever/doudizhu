'use strict';

// ============================================================
// 玩家视角状态视图（无 http/sse 依赖，server.js 与 DO 共用）
// ============================================================

const roomModule = require('./room');

// 生成玩家视角的状态视图
function viewFor(room, playerId) {
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
      bidAction: (room.bidActions && room.bidActions[s]) ? room.bidActions[s] : null,
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
    bottom: (room.phase === 'playing' || room.phase === 'reveal' || room.phase === 'showwin') ? room.bottom : [],
    bidSeat: room.bidSeat,
    curSeat: room.curSeat,
    lastPlay: room.lastPlay ? { seat: room.lastPlay.seat, cards: room.lastPlay.cards } : null,
    winnerSide: room.winnerSide,
    result: room.lastResult,
    playerCount: room.players.length,
    readyCount: room.players.filter(p => p.ready).length,
    allReady: room.players.length === 3 && room.players.every(p => p.ready),
    // 房主 + 加入申请（仅房主视角可见 pendingRequests）
    isHost: !!(me && room.hostId && me.id === room.hostId),
    pendingRequests: (me && room.hostId && me.id === room.hostId)
      ? room.pendingRequests.map(r => ({ requestId: r.requestId, name: r.name }))
      : undefined,
    // 回放日志（仅 reveal/finished 时返回）
    playLog: revealing ? room.playLog : undefined,
    seenCards: room.seenCards,
    // 出牌倒计时
    turnStartAt: room.turnStartAt || 0,
    turnMs: roomModule.TURN_MS,
    botThinkMs: roomModule.BOT_THINK_MS,
  };
}

module.exports = { viewFor };
