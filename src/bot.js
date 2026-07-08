'use strict';

// ============================================================
// 机器人 AI
// 改进：加记牌器、更优炸弹时机、拆牌不拆炸弹、农民配合增强
// ============================================================

const { parseCombo, countMap } = require('./engine');

// ---- 记牌器：推算对手可能持有的牌 ----

// 一副牌每个点数的总数（3..15各4张，16和17各1张）
const DECK_COUNT = {};
for (let v = 3; v <= 15; v++) DECK_COUNT[v] = 4;
DECK_COUNT[16] = 1;
DECK_COUNT[17] = 1;

// 返回对手可能持有的牌中，某点数最多剩几张
function remainingCount(room, seat, v) {
  const total = DECK_COUNT[v] || 0;
  const seen = room.seenCards[v] || 0;
  // 减去自己手牌
  const myHand = (room.players.find(p => p.seat === seat) || {}).hand || [];
  const myV = myHand.filter(c => c.v === v).length;
  return Math.max(0, total - seen - myV);
}

// 判断某点数对手是否已断（不剩）
function isDepleted(room, seat, v) {
  return remainingCount(room, seat, v) === 0;
}

// ---- 叫地主决策 ----

function botBid(room, seat) {
  const p = room.players.find(pl => pl.seat === seat);
  const c = countMap(p.hand.map(x => x.v));
  let power = 0;

  if (c[17]) power += 3;
  if (c[16]) power += 2;
  power += (c[15] || 0) * 0.5;
  for (const v in c) if (c[v] === 4) power += 2;

  if (room.bidRound === 'call') {
    room.bidSeat = seat;
    if (power >= 2.5) return 'call';
    return 'pass';
  } else {
    room.bidSeat = seat;
    if (power >= 4) return 'grab';
    return 'nograb';
  }
}

// ---- 拆牌：把一手牌拆成「组+炸弹」 ----

function decompose(cards) {
  const byV = {};
  for (const c of cards) (byV[c.v] = byV[c.v] || []).push(c);
  const cnt = v => (byV[v] ? byV[v].length : 0);
  const take = (v, k) => byV[v].splice(0, k);

  const groups = [], bombs = [];

  // 王炸
  if (cnt(16) && cnt(17))
    bombs.push({ type: 'rocket', cards: [...take(16, 1), ...take(17, 1)], rank: 1000 });

  // 炸弹优先保留（不拆）
  for (let v = 3; v <= 15; v++)
    if (cnt(v) === 4) bombs.push({ type: 'bomb', cards: take(v, 4), rank: v });

  // 顺子
  const grabStraight = () => {
    let bs = -1, bl = 0, v = 3;
    while (v <= 14) {
      const c = cnt(v);
      if (c >= 1 && c <= 2) {
        let len = 0, k = v;
        while (k <= 14) {
          const ck = cnt(k);
          if (ck >= 1 && ck <= 2) { len++; k++; }
          else break;
        }
        if (len >= 5 && len > bl) { bl = len; bs = v; }
        v = k;
      } else v++;
    }
    if (bl >= 5) {
      const cs = [];
      for (let k = bs; k < bs + bl; k++) cs.push(...take(k, 1));
      groups.push({ type: 'straight', cards: cs, rank: bs + bl - 1, len: bl });
      return true;
    }
    return false;
  };
  while (grabStraight()) {}

  // 连对
  const grabDs = () => {
    let bs = -1, bl = 0, v = 3;
    while (v <= 14) {
      if (cnt(v) >= 2) {
        let len = 0, k = v;
        while (k <= 14 && cnt(k) >= 2) { len++; k++; }
        if (len >= 3 && len > bl) { bl = len; bs = v; }
        v = k;
      } else v++;
    }
    if (bl >= 3) {
      const cs = [];
      for (let k = bs; k < bs + bl; k++) cs.push(...take(k, 2));
      groups.push({ type: 'dstraight', cards: cs, rank: bs + bl - 1, len: bl });
      return true;
    }
    return false;
  };
  while (grabDs()) {}

  // 三张、对子、单张
  const triples = [], pairs = [], singles = [];
  for (let v = 3; v <= 17; v++) while (cnt(v) >= 3) triples.push({ v, cards: take(v, 3) });
  for (let v = 3; v <= 17; v++) while (cnt(v) >= 2) pairs.push({ v, cards: take(v, 2) });
  for (let v = 3; v <= 17; v++) while (cnt(v) >= 1) singles.push({ v, cards: take(v, 1) });

  // 三张配翼
  for (const t of triples) {
    if (singles.length) {
      const k = singles.shift();
      groups.push({ type: 'triple1', cards: [...t.cards, ...k.cards], rank: t.v, len: 1 });
    } else if (pairs.length) {
      const k = pairs.shift();
      groups.push({ type: 'triple2', cards: [...t.cards, ...k.cards], rank: t.v, len: 1 });
    } else {
      groups.push({ type: 'triple', cards: t.cards, rank: t.v, len: 1 });
    }
  }

  for (const p of pairs) groups.push({ type: 'pair', cards: p.cards, rank: p.v, len: 1 });
  for (const s of singles) groups.push({ type: 'single', cards: s.cards, rank: s.v, len: 1 });

  return { groups, bombs };
}

// ---- 领出 ----

function botLead(hand, ctx) {
  const { groups, bombs } = decompose(hand);
  if (groups.length === 0) {
    if (bombs.length) return bombs.sort((a, b) => a.rank - b.rank)[0].cards.map(c => c.id);
    return [hand[0].id];
  }

  const minV = g => Math.min(...g.cards.map(c => c.v));

  // 对手快走完（≤2张）：不喂单张，优先出多张组合
  if (ctx && ctx.oppMin <= 2) {
    const multi = groups.filter(g => g.cards.length >= 2);
    if (multi.length) {
      multi.sort((a, b) => (b.cards.length - a.cards.length) || (minV(a) - minV(b)));
      return multi[0].cards.map(c => c.id);
    }
    const singles = groups.filter(g => g.type === 'single').sort((a, b) => b.rank - a.rank);
    if (singles.length) return singles[0].cards.map(c => c.id);
  }

  // 自己快走完（≤4张）：直接出最大组清牌，能走完就用炸弹
  if (hand.length <= 4 && bombs.length) {
    // 用最小炸弹开路后一次出完
    return bombs.sort((a, b) => a.rank - b.rank)[0].cards.map(c => c.id);
  }

  // 常态：最小组合领出
  groups.sort((a, b) => (minV(a) - minV(b)) || (b.cards.length - a.cards.length));
  return groups[0].cards.map(c => c.id);
}

// ---- 跟牌 ----

function genBeat(hand, last, preferHigh) {
  const byV = {};
  for (const c of hand) (byV[c.v] = byV[c.v] || []).push(c);
  const cnt = v => (byV[v] ? byV[v].length : 0);
  const vals = Object.keys(byV).map(Number).sort((a, b) => a - b);
  const ids = arr => arr.map(c => c.id);

  const t = last.type, rank = last.rank, len = last.len;

  const spareOne = ban => {
    for (const v of vals) { if (ban && ban.has(v)) continue; if (cnt(v) === 4) continue; if (cnt(v) >= 1) return byV[v][0]; }
    for (const v of vals) { if (ban && ban.has(v)) continue; if (cnt(v) >= 1) return byV[v][0]; }
    return null;
  };
  const sparePair = ban => {
    for (const v of vals) { if (ban && ban.has(v)) continue; if (cnt(v) === 4) continue; if (cnt(v) >= 2) return byV[v].slice(0, 2); }
    return null;
  };

  if (t === 'single') {
    const cand = vals.filter(v => v > rank);
    const order = preferHigh ? cand.slice().reverse() : cand;
    for (const v of order) if (cnt(v) < 4) return [byV[v][0].id];
    if (order.length) return [byV[order[0]][0].id];
  }
  if (t === 'pair') {
    const cand = vals.filter(v => v > rank && cnt(v) >= 2);
    const order = preferHigh ? cand.slice().reverse() : cand;
    for (const v of order) if (cnt(v) < 4) return ids(byV[v].slice(0, 2));
    if (order.length) return ids(byV[order[0]].slice(0, 2));
  }
  if (t === 'triple' || t === 'triple1' || t === 'triple2') {
    for (const v of vals) {
      if (v > rank && cnt(v) >= 3) {
        if (t === 'triple') return ids(byV[v].slice(0, 3));
        if (t === 'triple1') { const k = spareOne(new Set([v])); if (k) return ids([...byV[v].slice(0, 3), k]); }
        if (t === 'triple2') { const k = sparePair(new Set([v])); if (k) return ids([...byV[v].slice(0, 3), ...k]); }
      }
    }
  }
  if (t === 'straight') {
    for (let s = rank - len + 2; s + len - 1 <= 14; s++) {
      let ok = true, cs = [];
      for (let k = 0; k < len; k++) {
        const v = s + k;
        if (cnt(v) >= 1) cs.push(byV[v][0]);
        else { ok = false; break; }
      }
      if (ok) return ids(cs);
    }
  }
  if (t === 'dstraight') {
    for (let s = rank - len + 2; s + len - 1 <= 14; s++) {
      let ok = true, cs = [];
      for (let k = 0; k < len; k++) {
        const v = s + k;
        if (cnt(v) >= 2) cs.push(...byV[v].slice(0, 2));
        else { ok = false; break; }
      }
      if (ok) return ids(cs);
    }
  }
  if (t === 'plane') {
    for (let s = rank - len + 2; s + len - 1 <= 14; s++) {
      let ok = true, cs = [];
      for (let k = 0; k < len; k++) {
        if (cnt(s + k) >= 3) cs.push(...byV[s + k].slice(0, 3));
        else { ok = false; break; }
      }
      if (ok) return ids(cs);
    }
  }
  if (t === 'four2') {
    for (const v of vals) {
      if (v > rank && cnt(v) >= 4) {
        const ks = [];
        for (const x of vals) {
          if (x === v) continue;
          if (cnt(x) >= 1) { ks.push(byV[x][0]); if (ks.length === 2) break; }
        }
        if (ks.length === 2) return ids([...byV[v].slice(0, 4), ...ks]);
      }
    }
  }
  return null;
}

// ---- 炸弹信息 ----

function bombsOf(hand) {
  const byV = {};
  for (const c of hand) (byV[c.v] = byV[c.v] || []).push(c);
  const list = Object.keys(byV).map(Number).filter(v => byV[v].length === 4).sort((a, b) => a - b);
  const rocket = (byV[16] && byV[17]) ? [byV[16][0].id, byV[17][0].id] : null;
  return { byV, list, rocket };
}

function comboOfIds(hand, ids) {
  const set = new Set(ids);
  const cs = hand.filter(c => set.has(c.id));
  return parseCombo(cs.map(c => c.v));
}

// ---- 主决策 ----

function botMove(room, seat) {
  const p = room.players.find(pl => pl.seat === seat);
  if (!p) return;

  const sideOf = s => (s === room.landlordSeat ? 'L' : 'F');
  const mySide = sideOf(seat);

  // 对手最少剩牌数
  const oppLens = [0, 1, 2]
    .filter(s => s !== seat && sideOf(s) !== mySide)
    .map(s => {
      const pp = room.players.find(pl => pl.seat === s);
      return pp ? pp.hand.length : 99;
    });
  const oppMin = oppLens.length ? Math.min(...oppLens) : 99;

  // 领出
  if (room.lastPlay === null) {
    const ids = botLead(p.hand, { oppMin });
    if (ids && ids.length) { room.curSeat = seat; return { action: 'play', ids }; }
    return { action: 'pass' };
  }

  const last = room.lastPlay.combo;
  const lastSeat = room.lastPlay.seat;
  const iAmFarmer = seat !== room.landlordSeat;
  const lastIsFarmer = lastSeat !== room.landlordSeat;

  const normal = genBeat(p.hand, last, oppMin <= 1);

  // 队友出牌：默认过，除非特殊情况
  if (iAmFarmer && lastIsFarmer && lastSeat !== seat) {
    if (normal && normal.length === p.hand.length) {
      room.curSeat = seat;
      return { action: 'play', ids: normal };
    }
    // 地主危险（≤2张）且我能用小牌（≤Q且非炸弹）压住队友抢牌权
    if (normal) {
      const ll = room.players.find(pl => pl.seat === room.landlordSeat);
      const landlordDanger = ll && ll.hand.length <= 2;
      const bc = comboOfIds(p.hand, normal);
      if (landlordDanger && bc && bc.type !== 'bomb' && bc.type !== 'rocket' && bc.rank <= 12) {
        room.curSeat = seat;
        return { action: 'play', ids: normal };
      }
    }
    return { action: 'pass' };
  }

  // 对手出牌：正常跟
  if (normal) {
    room.curSeat = seat;
    return { action: 'play', ids: normal };
  }

  // 无同型可压 → 考虑炸
  const { byV, list, rocket } = bombsOf(p.hand);
  const oppClose = room.players.find(pl => pl.seat === lastSeat)
    && room.players.find(pl => pl.seat === lastSeat).hand.length <= 2;

  if (last.type === 'rocket') return { action: 'pass' };

  // 炸弹互压：只有对方快走完才跟
  if (last.type === 'bomb') {
    const bigger = list.find(v => v > last.rank);
    if (bigger !== undefined && oppClose) {
      room.curSeat = seat;
      return { action: 'play', ids: byV[bigger].map(c => c.id) };
    }
    if (rocket && oppClose) {
      room.curSeat = seat;
      return { action: 'play', ids: rocket };
    }
    return { action: 'pass' };
  }

  // 对手快走完才舍炸；自己快走完且炸完能一手出完则果断炸
  if (oppClose && !(iAmFarmer && lastIsFarmer)) {
    if (list.length) {
      room.curSeat = seat;
      return { action: 'play', ids: byV[list[0]].map(c => c.id) };
    }
    if (rocket) {
      room.curSeat = seat;
      return { action: 'play', ids: rocket };
    }
  }

  // 自己手牌少且炸弹能开路 → 果断炸
  if (p.hand.length <= 8 && !(iAmFarmer && lastIsFarmer)) {
    if (list.length && comboOfIds(p.hand, byV[list[0]].map(c => c.id))) {
      room.curSeat = seat;
      return { action: 'play', ids: byV[list[0]].map(c => c.id) };
    }
  }

  return { action: 'pass' };
}

module.exports = { botBid, botMove, decompose, genBeat, bombsOf, comboOfIds, remainingCount, isDepleted, bombBotLead: botLead };
