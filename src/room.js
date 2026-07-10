'use strict';

// ============================================================
// 房间状态机：大厅 → 叫地主 → 出牌 → 亮牌 → 结算
// ============================================================

let pidSeq = 1;

function createRoom(id) {
  return {
    id,
    mode: 'classic',          // 'classic' | 'noshuffle' | 'endgame'：发牌模式（房主在大厅设置）
    endgamePreset: 0,         // 残局练习选用的预设下标
    players: [],
    phase: 'lobby',          // lobby | bidding | playing | showwin | reveal | finished
    bottom: [],
    landlordSeat: -1,
    firstBidder: 0,
    bidSeat: -1,
    calledSeat: -1,
    callMult: 1,
    bidRound: 'call',        // 'call' | 'grab'
    firstCallerSeat: -1,
    lastCaller: -1,          // 最近一次叫/抢地主者（地主候选人），最后叫者得地主
    bidSlots: [],            // 前 3 个叫抢座位 [A,B,C]
    bidPtr: 0,               // 当前轮到 bidSlots 的第几个
    passedSeats: [],         // 已“不叫/不抢”而失去叫抢资格的座位
    bidActions: {},           // 座位 -> 'call'|'grab'|'nocall'|'nograb'（前端昵称下展示用）
    curSeat: -1,
    lastPlay: null,
    passes: 0,
    landlordPlays: 0,
    peasantPlays: 0,
    winnerSide: null,
    baseScore: 1,
    bombCount: 0,
    revealAt: 0,
    winShowAt: 0,          // 展示赢家最后一手（showwin 阶段）起始时间
    finishedAt: 0,         // 进入结算（finished）起始时间
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
// 网络抖动容忍：6s 内无心跳仅标「重连中…」，10s 才真正托管代打，避免一抖就被代出牌
const DISCONNECT_MS = 6000;   // 超过此时长未收到心跳 → UI 标记「重连中…」（此前 3.5s，过于敏感）
const HOST_MS = 10000;        // 超过此时长 → 真正托管（代打 / 结算自动准备）
const LOBBY_STALE_MS = 30000;
const TURN_MS = 20000;          // 每人出牌/跟牌限时 20 秒
const LEAD_MS = 25000;          // 领出（含地主拿到底牌后的首出）限时 25 秒
const BOT_THINK_MS = 3000;     // 机器人思考约 3 秒
const REQUEST_TTL_MS = 60000;  // 加入申请超时（自动拒绝）

const SHOWWIN_MS = 3000;       // 展示赢家最后一手几秒后进入亮牌
const REVEAL_MS = 4500;        // 亮牌（展示各家余牌）几秒后进入结算
const NEXT_READY_MS = 3000;    // 结算后机器人/掉线真人自动准备下一局

// ---- 表情系统 ----
// 玩家与机器人共用的表情 id（与前端 public/emotes.js 保持一致）
const EMOTE_IDS = ['smile', 'cry', 'laugh', 'angry', 'shock', 'cool', 'cheer', 'awkward', 'think', 'thumbs'];
const EMOTE_TTL_MS = 3500;     // 表情在界面上展示/淡出的时长（前端据此判断是否仍可见）

// 设置某座位的表情（带时间戳），并 bump 让所有人立即看到
function setEmote(room, seat, id) {
  const p = playerBySeat(room, seat);
  if (!p || !EMOTE_IDS.includes(id)) return;
  p.emote = { id, at: Date.now() };
  bump(room);
}

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
  room.bidRound = 'call';
  room.firstCallerSeat = -1;
  room.lastCaller = -1;
  room.bidSlots = [];
  room.bidPtr = 0;
  room.passedSeats = [];
  room.bidActions = {};
  room.curSeat = -1;
  room.lastPlay = null;
  for (const p of room.players) p.emote = null;
  room.passes = 0;
  room.landlordPlays = 0;
  room.peasantPlays = 0;
  room.winnerSide = null;
  room.bombCount = 0;
  room.revealAt = 0;
  room.winShowAt = 0;
  room.finishedAt = 0;
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

function startDeal(room, opts) {
  const { buildDeck, shuffle, sortHand, labelOf } = require('./cards');
  const { ENDGAMES } = require('./presets');
  // 流局重发时 count:false，不计入总局数
  if (!opts || opts.count !== false) {
    room.roundNo = (room.roundNo || 0) + 1;
  }
  room.seenCards = {};
  room.playLog = [];
  room.bombCount = 0;
  room.landlordPlays = 0;
  room.peasantPlays = 0;

  // 残局练习模式：直接载入预设手牌，跳过叫地主，地主按预设先出
  if (room.mode === 'endgame') {
    const preset = ENDGAMES[(room.endgamePreset || 0) % ENDGAMES.length];
    loadEndgame(room, preset, labelOf);
    return;
  }

  const deck = room.mode === 'noshuffle' ? buildDeck() : shuffle(buildDeck());
  for (const s of [0, 1, 2]) playerBySeat(room, s).hand = [];
  for (let i = 0; i < 51; i++) playerBySeat(room, i % 3).hand.push(deck[i]);
  room.bottom = deck.slice(51);
  for (const s of [0, 1, 2]) sortHand(playerBySeat(room, s).hand);

  room.phase = 'bidding';
  room.firstBidder = Math.floor(Math.random() * 3);
  const A = room.firstBidder;
  room.bidSlots = [A, (A + 1) % 3, (A + 2) % 3]; // 前 3 轮：A→B→C
  room.bidPtr = 1; // 第 1 轮已取 bidSlots[0]，故下一次推进从下标 1 开始
  room.bidSeat = room.bidSlots[0];
  room.bidRound = 'call';
  room.calledSeat = -1;
  room.firstCallerSeat = -1;
  room.lastCaller = -1;
  room.passedSeats = [];
  room.bidActions = {};
  room.callMult = 1;
  room.landlordSeat = -1;
  room.lastPlay = null;
  room.passes = 0;
  room.winnerSide = null;
  room.turnStartAt = Date.now();
  room._lastTurnSeat = room.bidSeat;
  for (const s of [0, 1, 2]) { const pl = playerBySeat(room, s); if (pl) pl.emote = null; }

  bump(room, `第 ${room.roundNo}/${room.totalRounds} 局 · ${playerBySeat(room, room.bidSeat).name} 先叫地主`);
}

// 残局练习：把预设手牌直接装进三名玩家，跳过叫地主，地主按预设先出。
// preset.hands / preset.bottom 为 [{v, suit}] 数组；王 suit=-1。
function loadEndgame(room, preset, labelOf) {
  const { sortHand } = require('./cards');
  const toCard = (c) => ({
    id: c.v + '_' + (c.suit < 0 ? 'J' + c.v : c.suit),
    v: c.v,
    suit: c.suit,
    label: c.v >= 16 ? (c.v === 17 ? '大王' : '小王') : labelOf(c.v),
  });
  for (const s of [0, 1, 2]) { const p = playerBySeat(room, s); if (p) p.hand = []; }
  (preset.hands || []).forEach((cards, s) => {
    const p = playerBySeat(room, s);
    if (!p) return;
    p.hand = (cards || []).map(toCard);
    sortHand(p.hand);
  });
  room.bottom = (preset.bottom || []).map(toCard);
  room.landlordSeat = preset.landlordSeat;
  room.phase = 'playing';
  room.curSeat = preset.landlordSeat;
  room.lastPlay = null;
  room.passes = 0;
  room.callMult = 1;          // 残局无叫抢，倍数从 1 起算
  room.bombCount = 0;
  room.landlordPlays = 0;
  room.peasantPlays = 0;
  room.winnerSide = null;
  room.turnStartAt = Date.now();
  room._lastTurnSeat = preset.landlordSeat;
  for (const s of [0, 1, 2]) { const pl = playerBySeat(room, s); if (pl) pl.emote = null; }
  bump(room, `残局练习 · ${preset.name} · ${playerBySeat(room, room.landlordSeat).name} 当地主先出`);
}

// ---- 叫/抢地主 ----
// 规则（顺时针，最多 4 轮）：
//   1) 随机首位 A，顺序 A→B→C→A；若 A 不叫则失去资格，末尾回到的改为 B（即 B→C→B）。
//   2) 每名玩家“不叫/不抢”即失去后续叫抢资格。
//   3) 一旦有人叫过，后续环节变为“抢地主”；最近一次叫/抢者即地主候选人，最后叫者当选。
//   4) 仅剩一名叫地主者且其余皆已不叫 → 该玩家直接当选（如 A 叫、B/C 不叫 → A 当选；A/B 不叫、C 叫 → C 直接当选）。
//   5) 三人都不叫 → 流局，不计入总局数，重新发牌。

function nextBidSeat(room) {
  if (room.bidPtr < 3) {
    const s = room.bidSlots[room.bidPtr];
    room.bidPtr++;
    return s;
  }
  if (room.bidPtr === 3) {
    room.bidPtr++;
    const A = room.firstBidder;
    // 第 4 轮：A 仍在场则回到 A，否则顺延到 B
    return room.passedSeats.includes(A) ? (A + 1) % 3 : A;
  }
  return -1; // 已无回合
}

function finishBid(room) {
  if (room.lastCaller >= 0) {
    assignLandlord(room, room.lastCaller);
  } else {
    // 三家都不叫 → 流局，不计入总局数，重新发牌
    bump(room, '三家都不叫，本场流局，重新发牌…');
    startDeal(room, { count: false });
  }
}

function doBid(room, seat, action) {
  if (room.phase !== 'bidding' || room.bidSeat !== seat) return { err: '现在不是你' };
  const name = playerBySeat(room, seat).name;
  const isCall = (action === 'call' || action === 'grab');
  const isGrab = room.lastCaller >= 0; // 已有人叫过 → 抢地主阶段

  if (isCall) {
    const firstCall = room.lastCaller < 0;
    room.lastCaller = seat;
    room.callMult *= 2;
    room.bidActions[seat] = isGrab ? 'grab' : 'call';
    if (firstCall) {
      room.firstCallerSeat = seat;
      room.calledSeat = seat;
    }
    bump(room, `${name} ${isGrab ? '抢地主' : '叫地主'}！倍数升至 ${room.callMult}`);
  } else {
    room.passedSeats.push(seat);
    room.bidActions[seat] = isGrab ? 'nograb' : 'nocall';
    bump(room, `${name} ${isGrab ? '不抢' : '不叫'}`);
  }

  // 提前结束：仅剩一名叫地主者且其余皆已不叫
  const othersAllPassed = [0, 1, 2].every(s => s === room.lastCaller || room.passedSeats.includes(s));
  if (room.lastCaller >= 0 && othersAllPassed) {
    assignLandlord(room, room.lastCaller);
    return {};
  }

  const s = nextBidSeat(room);
  if (s < 0 || room.passedSeats.includes(s)) { finishBid(room); return {}; }
  room.bidSeat = s;
  room.bidRound = room.lastCaller >= 0 ? 'grab' : 'call';
  bump(room, `轮到 ${playerBySeat(room, s).name} ${room.bidRound === 'grab' ? '抢地主' : '叫地主'}`);
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
  // 抢/叫地主结束 → 地主拿到底牌，倒计时必须重置为完整时长（而非继承叫抢阶段已流逝的时间）
  room.turnStartAt = Date.now();
  room._lastTurnSeat = seat;
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
  room.phase = 'showwin';
  room.winShowAt = Date.now();
  room.revealAt = 0;

  const wname = playerBySeat(room, winnerSeat).name;
  const wrole = winnerSide === 'landlord' ? '地主' : '农民';
  let extra = spring ? '（春天！）' : (antiSpring ? '（反春天！）' : '');
  room.message = `${wrole} ${wname} 先出完${extra}，本局结束！`;

  // 败方机器人表情：哭泣（胜方机器人由出牌那一步已设为🎉庆祝）
  const nowE = Date.now();
  for (let s = 0; s < 3; s++) {
    const pl = playerBySeat(room, s);
    if (pl && pl.isBot && s !== winnerSeat) pl.emote = { id: 'cry', at: nowE };
  }

  bump(room);
}

// ---- 三人均准备后开始（大厅发牌 / 结算后下一局 通用）----
function tryStartAfterReady(room) {
  if (room.players.length !== 3) return false;
  if (!room.players.every(p => p.ready)) return false;
  if (room.phase === 'lobby') {
    startDeal(room);
    return true;
  }
  if (room.phase === 'finished') {
    if (room.roundNo >= room.totalRounds) {
      resetToLobby(room);
      for (const bp of room.players) if (bp.isBot) bp.ready = true;
    } else {
      startDeal(room);
    }
    return true;
  }
  return false;
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
  createRoom, bump, playerBySeat, isConnected, setEmote,
  resetToLobby, reseatAndReset, startDeal,
  doBid, assignLandlord, doPlay, doPass,
  finishGame, scoreboard, tryStartAfterReady,
  DISCONNECT_MS, HOST_MS, LOBBY_STALE_MS, TURN_MS, LEAD_MS, BOT_THINK_MS, REQUEST_TTL_MS,
  SHOWWIN_MS, REVEAL_MS, NEXT_READY_MS,
  EMOTE_IDS, EMOTE_TTL_MS,
};
