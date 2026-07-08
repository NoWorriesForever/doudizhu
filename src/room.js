'use strict';

// ============================================================
// 房间状态机：大厅 → 叫地主 → 出牌 → 亮牌 → 结算
// ============================================================

let pidSeq = 1;

function createRoom(id) {
  return {
    id,
    players: [],
    phase: 'lobby',          // lobby | bidding | playing | reveal | finished
    bottom: [],
    landlordSeat: -1,
    firstBidder: 0,
    bidSeat: -1,
    calledSeat: -1,
    callMult: 1,
    bidActed: 0,
    bidRound: 'call',        // 'call' | 'grab'
    grabCandidates: [],
    firstCallerSeat: -1,
    lastGrabber: -1,
    grabCount: 0,
    callerCounterUsed: false,
    curSeat: -1,
    lastPlay: null,
    passes: 0,
    landlordPlays: 0,
    peasantPlays: 0,
    winnerSide: null,
    baseScore: 1,
    bombCount: 0,
    revealAt: 0,
    lastResult: null,
    totalRounds: 3,
    roundNo: 0,
    message: '等待玩家加入…',
    version: 1,

    // 新增：记牌器 + 出牌回放日志 + 每局积分
    seenCards: {},        // {v: count} 已出牌点数统计（记牌用）
    playLog: [],          // [{seat, combo, cards, ts}] 本局出牌记录
    roundResults: [],     // 多局赛制下每局结算结果（展示用）

    // 出牌倒计时
    turnStartAt: 0,       // 当前轮次开始时间戳
    _lastTurnSeat: -1,    // 上次轮到的座位（检测轮次变化用）

    // 房主 + 加入申请（大厅浏览 / 房主审批）
    hostId: null,            // 房主玩家 id（首个加入的真人）
    pendingRequests: [],     // [{requestId, name, createdAt}] 待房主审批的申请
    approvedRequests: {},    // requestId -> {playerId, seat} 已通过（供申请者轮询拿 playerId）
    rejectedRequests: {},    // requestId -> true 已拒绝（供申请者轮询）
  };
}

function bump(room, msg) {
  room.version++;
  if (msg !== undefined) room.message = msg;
  // 轮次倒计时：bidSeat/curSeat 变化时刷新基准时间
  const t = room.phase === 'bidding' ? room.bidSeat
    : (room.phase === 'playing' ? room.curSeat : -1);
  if (t >= 0 && t !== room._lastTurnSeat) {
    room.turnStartAt = Date.now();
    room._lastTurnSeat = t;
  }
}

function playerBySeat(room, seat) {
  return room.players.find(p => p.seat === seat);
}

// 连接状态
const DISCONNECT_MS = 3500;
const HOST_MS = Number(process.env.HOST_MS) || 6000;
const LOBBY_STALE_MS = 30000;
const TURN_MS = Number(process.env.TURN_MS) || 15000;          // 每人出牌限时 15 秒
const BOT_THINK_MS = Number(process.env.BOT_THINK_MS) || 3000; // 机器人思考约 3 秒
const REQUEST_TTL_MS = Number(process.env.REQUEST_TTL_MS) || 60000; // 加入申请超时（自动拒绝）

function isConnected(p, now) {
  return !!(p && (p.isBot || (now - (p.lastSeen || 0) < DISCONNECT_MS)));
}

// ---- 重置 / 清理 ----

function resetToLobby(room) {
  room.phase = 'lobby';
  room.bottom = [];
  room.landlordSeat = -1;
  room.bidSeat = -1;
  room.calledSeat = -1;
  room.callMult = 1;
  room.bidActed = 0;
  room.bidRound = 'call';
  room.grabCandidates = [];
  room.firstCallerSeat = -1;
  room.lastGrabber = -1;
  room.grabCount = 0;
  room.callerCounterUsed = false;
  room.curSeat = -1;
  room.lastPlay = null;
  room.passes = 0;
  room.landlordPlays = 0;
  room.peasantPlays = 0;
  room.winnerSide = null;
  room.bombCount = 0;
  room.revealAt = 0;
  room.lastResult = null;
  room.seenCards = {};
  room.playLog = [];
  room.roundNo = 0;
  room.pendingRequests = [];
  room.approvedRequests = {};
  room.rejectedRequests = {};
  for (const p of room.players) { p.hand = []; p.ready = false; p.score = 0; }
  room.message = '等待玩家准备…';
  room.roundResults = [];
  bump(room);
}

function reseatAndReset(room) {
  room.players = room.players.filter(p => !p.isBot);
  room.players.forEach((p, i) => { p.seat = i; });
  // 房主若已离开，重派给剩余真人中的座位最小者
  if (room.hostId && !room.players.some(p => p.id === room.hostId)) {
    room.hostId = room.players.length ? room.players[0].id : null;
  }
  room.pendingRequests = [];
  room.approvedRequests = {};
  room.rejectedRequests = {};
  room.seenCards = {};
  room.playLog = [];
  if (room.players.length === 0) return null;
  resetToLobby(room);
  return room;
}

// ---- 发牌 ----

function startDeal(room) {
  const { buildDeck, shuffle, sortHand } = require('./cards');
  room.roundNo = (room.roundNo || 0) + 1;
  room.seenCards = {};
  room.playLog = [];
  room.bombCount = 0;
  room.landlordPlays = 0;
  room.peasantPlays = 0;

  const deck = shuffle(buildDeck());
  for (const s of [0, 1, 2]) playerBySeat(room, s).hand = [];
  for (let i = 0; i < 51; i++) playerBySeat(room, i % 3).hand.push(deck[i]);
  room.bottom = deck.slice(51);
  for (const s of [0, 1, 2]) sortHand(playerBySeat(room, s).hand);

  room.phase = 'bidding';
  room.firstBidder = Math.floor(Math.random() * 3);
  room.bidSeat = room.firstBidder;
  room.bidRound = 'call';
  room.calledSeat = -1;
  room.firstCallerSeat = -1;
  room.lastGrabber = -1;
  room.grabCount = 0;
  room.callerCounterUsed = false;
  room.callMult = 1;
  room.bidActed = 0;
  room.grabCandidates = [];
  room.landlordSeat = -1;
  room.lastPlay = null;
  room.passes = 0;
  room.winnerSide = null;
  room.turnStartAt = Date.now();
  room._lastTurnSeat = room.bidSeat;

  bump(room, `第 ${room.roundNo}/${room.totalRounds} 局 · ${playerBySeat(room, room.bidSeat).name} 先叫地主`);
}

// ---- 叫/抢地主 ----

function doBid(room, seat, action) {
  if (room.phase !== 'bidding' || room.bidSeat !== seat) return { err: '现在不是你' };
  const name = playerBySeat(room, seat).name;

  if (room.bidRound === 'call') {
    if (action === 'call') {
      room.calledSeat = seat;
      room.firstCallerSeat = seat;
      room.callMult *= 2;
      room.grabCount = 0;
      room.lastGrabber = -1;
      room.callerCounterUsed = false;
      room.bidRound = 'grab';
      room.grabCandidates = [(seat + 1) % 3, (seat + 2) % 3];
      room.bidSeat = room.grabCandidates.shift();
      bump(room, `${name} 叫地主！轮到 ${playerBySeat(room, room.bidSeat).name} 抢地主`);
      return {};
    }
    room.bidActed++;
    if (room.bidActed >= 3) {
      bump(room, '三家都不叫，重新发牌…');
      startDeal(room);
      return {};
    }
    room.bidSeat = (room.bidSeat + 1) % 3;
    bump(room, `${name} 不叫，轮到 ${playerBySeat(room, room.bidSeat).name} 叫地主`);
    return {};
  }

  // grab 阶段
  const firstCaller = room.firstCallerSeat;
  if (action === 'grab') {
    room.callMult *= 2;
    room.grabCount = (room.grabCount || 0) + 1;
    room.lastGrabber = seat;
    bump(room, `${name} 抢地主！倍数升至 ${room.callMult}`);
    if (seat !== firstCaller && !room.callerCounterUsed && room.grabCount < 3) {
      room.callerCounterUsed = true;
      room.grabCandidates.unshift(firstCaller);
    }
  } else {
    bump(room, `${name} 不抢`);
  }
  if (seat === firstCaller) room.callerCounterUsed = true;

  if (room.grabCandidates.length > 0 && room.grabCount < 3) {
    room.bidSeat = room.grabCandidates.shift();
    bump(room, `轮到 ${playerBySeat(room, room.bidSeat).name} 抢地主`);
    return {};
  }

  const landlord = (room.lastGrabber >= 0) ? room.lastGrabber : firstCaller;
  assignLandlord(room, landlord);
  return {};
}

function assignLandlord(room, seat) {
  const { sortHand } = require('./cards');
  room.landlordSeat = seat;
  room.baseScore = 1;
  room.bombCount = 0;
  room.landlordPlays = 0;
  room.peasantPlays = 0;
  const lp = playerBySeat(room, seat);
  lp.hand.push(...room.bottom);
  sortHand(lp.hand);
  room.phase = 'playing';
  room.curSeat = seat;
  room.lastPlay = null;
  room.passes = 0;
  bump(room, `${lp.name} 成为地主！叫抢倍数 ${room.callMult}，底牌已亮，地主先出`);
}

// ---- 出牌 ----

function removeCards(hand, ids) {
  const set = new Set(ids);
  const picked = hand.filter(c => set.has(c.id));
  if (picked.length !== ids.length) return null;
  const rest = hand.filter(c => !set.has(c.id));
  return { picked, rest };
}

function doPlay(room, seat, ids) {
  const { parseCombo, beats } = require('./engine');
  if (room.phase !== 'playing' || room.curSeat !== seat) return { err: '现在不是你出牌' };

  const p = playerBySeat(room, seat);
  const r = removeCards(p.hand, ids);
  if (!r || r.picked.length === 0) return { err: '选牌无效' };

  const combo = parseCombo(r.picked.map(c => c.v));
  if (!combo) return { err: '不是合法牌型' };

  const leading = room.lastPlay === null;
  if (!leading && !beats(room.lastPlay.combo, combo)) return { err: '压不过上家的牌' };

  // 记牌：记录本手已出的牌
  for (const c of r.picked) {
    room.seenCards[c.v] = (room.seenCards[c.v] || 0) + 1;
  }

  p.hand = r.rest;
  room.lastPlay = { seat, combo, cards: r.picked };
  room.passes = 0;

  if (combo.type === 'bomb' || combo.type === 'rocket') room.bombCount++;

  if (seat === room.landlordSeat) room.landlordPlays++;
  else room.peasantPlays++;

  // 出牌回放日志
  room.playLog.push({
    seat, seatName: p.name,
    combo: { type: combo.type, rank: combo.rank, len: combo.len },
    cardIds: r.picked.map(c => c.id),
    ts: Date.now()
  });

  const name = p.name;
  if (p.hand.length === 0) {
    finishGame(room, seat);
    return {};
  }

  room.curSeat = (seat + 1) % 3;
  bump(room, `${name} 出牌，轮到 ${playerBySeat(room, room.curSeat).name}`);
  return {};
}

function doPass(room, seat) {
  if (room.phase !== 'playing' || room.curSeat !== seat) return { err: '现在不是你出牌' };
  if (room.lastPlay === null) return { err: '你是领出方，必须出牌' };
  room.passes++;
  const name = playerBySeat(room, seat).name;
  if (room.passes >= 2) {
    room.curSeat = room.lastPlay.seat;
    room.lastPlay = null;
    room.passes = 0;
    bump(room, `${name} 不出，${playerBySeat(room, room.curSeat).name} 重新领出`);
  } else {
    room.curSeat = (seat + 1) % 3;
    bump(room, `${name} 不出，轮到 ${playerBySeat(room, room.curSeat).name}`);
  }
  return {};
}

// ---- 结算 ----

function finishGame(room, winnerSeat) {
  const winnerSide = (winnerSeat === room.landlordSeat) ? 'landlord' : 'peasant';
  const base = room.baseScore;

  let spring = false, antiSpring = false;
  if (winnerSide === 'landlord' && room.peasantPlays === 0) spring = true;
  if (winnerSide === 'peasant' && room.landlordPlays <= 1) antiSpring = true;

  const springMult = (spring || antiSpring) ? 2 : 1;
  const multiplier = room.callMult * Math.pow(2, room.bombCount) * springMult;
  const unit = base * multiplier;
  const deltas = {};

  for (let s = 0; s < 3; s++) {
    if (s === room.landlordSeat)
      deltas[s] = (winnerSide === 'landlord' ? +2 : -2) * unit;
    else
      deltas[s] = (winnerSide === 'landlord' ? -1 : +1) * unit;
  }

  for (let s = 0; s < 3; s++) {
    const pl = playerBySeat(room, s);
    if (pl) pl.score = (pl.score || 0) + deltas[s];
  }

  const resultEntry = {
    roundNo: room.roundNo,
    winnerSide, base, multiplier, unit, deltas,
    bombCount: room.bombCount, callMult: room.callMult,
    spring, antiSpring,
    scores: [0, 1, 2].map(s => {
      const pl = playerBySeat(room, s);
      return pl ? { seat: s, name: pl.name, score: pl.score } : null;
    }).filter(Boolean),
  };
  room.roundResults.push(resultEntry);
  room.lastResult = resultEntry;
  room.winnerSide = winnerSide;
  room.phase = 'reveal';
  room.revealAt = Date.now();

  const wname = playerBySeat(room, winnerSeat).name;
  let extra = spring ? '（春天！）' : (antiSpring ? '（反春天！）' : '');
  room.message = (winnerSide === 'landlord'
    ? `地主 ${wname} 先出完${extra}，亮牌中…`
    : `农民 ${wname} 先出完${extra}，亮牌中…`);
  bump(room);
}

// ---- 计分牌 ----

function scoreboard(room) {
  return [0, 1, 2].map(s => {
    const p = playerBySeat(room, s);
    if (!p) return null;
    return { seat: s, name: p.name, score: p.score || 0, isBot: p.isBot };
  }).filter(Boolean);
}

module.exports = {
  createRoom, bump, playerBySeat, isConnected,
  resetToLobby, reseatAndReset, startDeal,
  doBid, assignLandlord, doPlay, doPass,
  finishGame, scoreboard,
  DISCONNECT_MS, HOST_MS, LOBBY_STALE_MS, TURN_MS, BOT_THINK_MS, REQUEST_TTL_MS,
};
