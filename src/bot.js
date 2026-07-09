'use strict';

// ============================================================
// 机器人 AI
// 改进：领出保留 2/王/炸弹作为控牌、低牌优先；农民配合（不抢队友、必要时用大牌夺回牌权）
// ============================================================

const { parseCombo, beats, countMap } = require('./engine');

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

// ---- 拆牌：把一手牌拆成「组+炸弹」（仅保留给外部/测试用，领出不依赖它）----

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

// ============================================================
// 领出（自己握有牌权时）
// 原则：低牌优先、尽量出长牌型清牌；2/王/炸弹作为控牌，非必要时不主动领出
// ============================================================

function lowestOtherSingle(byV, excludeV) {
  for (let v = 3; v <= 17; v++) {
    if (v === excludeV) continue;
    const n = (byV[v] || []).length;
    if (n >= 1 && n !== 4) return byV[v][0];          // 不拆炸弹做翅膀
    if (n === 1 && v >= 16) return byV[v][0];          // 王仅作最后手段
  }
  return null;
}
function lowestOtherPair(byV, excludeV) {
  for (let v = 3; v <= 15; v++) {
    if (v === excludeV) continue;
    const n = (byV[v] || []).length;
    if (n >= 2 && n !== 4) return byV[v].slice(0, 2);  // 不拆炸弹做翅膀
  }
  return null;
}

// 生成所有「可领出」的候选牌组（不含炸弹/王炸，避免无谓拆炸）
function genLeadCandidates(hand) {
  const byV = {};
  for (const c of hand) (byV[c.v] = byV[c.v] || []).push(c);
  const cnt = v => (byV[v] ? byV[v].length : 0);
  const cand = [];
  const add = arr => cand.push(arr.map(c => c.id));

  // 单张 / 对子（不拆四张）
  for (let v = 3; v <= 17; v++) {
    if (cnt(v) >= 1 && cnt(v) !== 4) add([byV[v][0]]);
    if (v <= 15 && cnt(v) >= 2 && cnt(v) !== 4) add(byV[v].slice(0, 2));
  }
  // 三张（可带单/对），带牌用更低的非炸牌
  for (let v = 3; v <= 15; v++) {
    if (cnt(v) >= 3 && cnt(v) !== 4) {
      add(byV[v].slice(0, 3));
      const ws = lowestOtherSingle(byV, v);
      if (ws) add([...byV[v].slice(0, 3), ws]);
      const wp = lowestOtherPair(byV, v);
      if (wp) add([...byV[v].slice(0, 3), ...wp]);
    }
  }
  // 顺子 5..12（不含 2/王）
  for (let len = 5; len <= 12; len++)
    for (let s = 3; s + len - 1 <= 14; s++) {
      let ok = true, cs = [];
      for (let k = 0; k < len; k++) { const v = s + k; if (cnt(v) >= 1 && cnt(v) !== 4) cs.push(byV[v][0]); else { ok = false; break; } }
      if (ok) add(cs);
    }
  // 连对 3..10
  for (let len = 3; len <= 10; len++)
    for (let s = 3; s + len - 1 <= 14; s++) {
      let ok = true, cs = [];
      for (let k = 0; k < len; k++) { const v = s + k; if (cnt(v) >= 2 && cnt(v) !== 4) cs.push(...byV[v].slice(0, 2)); else { ok = false; break; } }
      if (ok) add(cs);
    }
  // 飞机（连续三张）2..6（纯飞机，不带翅膀，简单稳健）
  for (let len = 2; len <= 6; len++)
    for (let s = 3; s + len - 1 <= 14; s++) {
      let ok = true, cs = [];
      for (let k = 0; k < len; k++) { const v = s + k; if (cnt(v) >= 3 && cnt(v) !== 4) cs.push(...byV[v].slice(0, 3)); else { ok = false; break; } }
      if (ok) add(cs);
    }
  return cand;
}

// 领出代价：越小越优先（低牌先出、长牌型优先清、控牌不轻易动）
function leadCost(hand, ids) {
  const cs = hand.filter(c => ids.indexOf(c.id) >= 0);
  const combo = parseCombo(cs.map(c => c.v));
  if (!combo) return 9999;
  const maxv = Math.max(...cs.map(c => c.v));
  let cost = maxv;                          // 牌值越低越优先
  if (cs.some(c => c.v >= 15)) cost += 80;  // 2/王不主动领出
  if (combo.type === 'bomb' || combo.type === 'rocket') cost += 200;
  cost -= cs.length * 1.5;                  // 长牌型优先清（顺子/连对/飞机）
  return cost;
}

function lowestCardId(hand) {
  let best = hand[0];
  for (const c of hand) if (c.v < best.v) best = c;
  return best.id;
}

function botLead(hand, ctx) {
  // 一手即可出完：直接全出
  const whole = parseCombo(hand.map(c => c.v));
  if (whole) return hand.map(c => c.id);

  const cands = genLeadCandidates(hand);
  if (cands.length) {
    cands.sort((a, b) => leadCost(hand, a) - leadCost(hand, b));
    return cands[0];
  }

  // 候选为空（仅剩炸弹/王炸）→ 出最小炸弹或王炸
  const { byV, list, rocket } = bombsOf(hand);
  if (rocket) return rocket;
  if (list.length) return byV[list[0]].map(c => c.id);
  return [hand[0].id];
}

// ============================================================
// 跟牌
// ============================================================

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
    // 优先用非炸弹单张；无路可走才允许拆炸弹
    const cand = vals.filter(v => v > rank && cnt(v) < 4);
    const pool = cand.length ? cand : vals.filter(v => v > rank);
    if (pool.length) {
      const order = preferHigh ? pool.slice().reverse() : pool;
      return [byV[order[0]][0].id];
    }
  }
  if (t === 'pair') {
    const cand = vals.filter(v => v > rank && cnt(v) >= 2 && cnt(v) < 4);
    const pool = cand.length ? cand : vals.filter(v => v > rank && cnt(v) >= 2);
    if (pool.length) {
      const order = preferHigh ? pool.slice().reverse() : pool;
      return ids(byV[order[0]].slice(0, 2));
    }
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

// ---- 散牌识别：不参与任何牌型（顺子/连对/三张/四张）的单张或对子 ----
// 用于跟队友时「顺手把散牌清出去」——不影响牌型结构，也不浪费控牌

function findSpareSingles(hand) {
  const byV = {};
  for (const c of hand) (byV[c.v] = byV[c.v] || []).push(c);
  const vals = Object.keys(byV).map(Number).sort((a, b) => a - b);
  // 标记 5+ 连续单牌（潜在顺子）的成员，保护不拆
  const inStraight = new Set();
  let run = [];
  for (const v of vals) {
    if (run.length === 0 || v === run[run.length - 1] + 1) run.push(v);
    else { if (run.length >= 5) run.forEach(x => inStraight.add(x)); run = [v]; }
  }
  if (run.length >= 5) run.forEach(x => inStraight.add(x));
  const res = [];
  for (const v of vals) {
    if (byV[v].length !== 1) continue;          // 非单张（是某对/三/四的一部分）
    if (inStraight.has(v)) continue;            // 顺子成员保护
    res.push(byV[v][0]);
  }
  return res;                                    // 已按 v 升序
}

function findSparePairs(hand) {
  const byV = {};
  for (const c of hand) (byV[c.v] = byV[c.v] || []).push(c);
  const vals = Object.keys(byV).map(Number).sort((a, b) => a - b);
  // 标记 3+ 连续对子（潜在连对）的成员，保护不拆
  const inDs = new Set();
  let run = [];
  for (const v of vals) {
    if (byV[v].length >= 2) {
      if (run.length === 0 || v === run[run.length - 1] + 1) run.push(v);
      else { if (run.length >= 3) run.forEach(x => inDs.add(x)); run = [v]; }
    } else {
      if (run.length >= 3) run.forEach(x => inDs.add(x)); run = [];
    }
  }
  if (run.length >= 3) run.forEach(x => inDs.add(x));
  const res = [];
  for (const v of vals) {
    if (byV[v].length !== 2) continue;           // 仅恰好 2 张（三张/四张不算对）
    if (inDs.has(v)) continue;                   // 连对成员保护
    res.push(byV[v].slice(0, 2));
  }
  return res;                                    // 按 v 升序
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

// 一手出完（整手恰为一组合法牌且压得过上家）
function findWinningMove(hand, last) {
  const wc = parseCombo(hand.map(c => c.v));
  if (wc && beats(last, wc)) return hand.map(c => c.id);
  return null;
}

// 是否值得炸：当前持牌权者快走完，或强制（队友危急夺权）
function considerBomb(hand, last, lastSeat, room, force) {
  const { byV, list, rocket } = bombsOf(hand);
  if (last.type === 'rocket') return null;
  const pp = room.players.find(pl => pl.seat === lastSeat);
  const opponentNear = pp && pp.hand.length <= 2;
  if (!force && !opponentNear) return null;

  if (last.type === 'bomb') {
    const bigger = list.filter(v => v > last.rank);
    if (bigger.length) return byV[bigger[0]].map(c => c.id);
    if (rocket) return rocket;
    return null;
  }
  if (list.length) return byV[list[0]].map(c => c.id);
  if (rocket) return rocket;
  return null;
}

// 校验一手牌合法且（跟牌时）压得过上家
function tryPlay(p, ids, lastCombo) {
  const cs = p.hand.filter(c => ids.indexOf(c.id) >= 0);
  const combo = parseCombo(cs.map(c => c.v));
  if (!combo) return null;
  if (lastCombo && !beats(lastCombo, combo)) return null;
  return combo;
}

// ============================================================
// 主决策
// ============================================================

function botMove(room, seat) {
  const p = room.players.find(pl => pl.seat === seat);
  if (!p) return { action: 'pass' };

  const sideOf = s => (s === room.landlordSeat ? 'L' : 'F');
  const mySide = sideOf(seat);
  const iAmFarmer = seat !== room.landlordSeat;

  // 对手（不同阵营）最少剩牌数
  const oppLens = [0, 1, 2]
    .filter(s => s !== seat && sideOf(s) !== mySide)
    .map(s => {
      const pp = room.players.find(pl => pl.seat === s);
      return pp ? pp.hand.length : 99;
    });
  const oppMin = oppLens.length ? Math.min(...oppLens) : 99;

  // ---- 领出（握有牌权）：低牌先出，保留 2/王/炸弹作控牌 ----
  if (room.lastPlay === null) {
    const ids = botLead(p.hand, { oppMin });
    if (tryPlay(p, ids, null)) return { action: 'play', ids };
    // 兜底（不应发生）：出最小单张，保证推进
    return { action: 'play', ids: [lowestCardId(p.hand)] };
  }

  const last = room.lastPlay.combo;
  const lastSeat = room.lastPlay.seat;
  const lastIsFarmer = lastSeat !== room.landlordSeat;
  const teammate = iAmFarmer && lastIsFarmer && lastSeat !== seat;

  // ---- 能一手出完：直接出（含整手炸弹/王炸）----
  const winMove = findWinningMove(p.hand, last);
  if (winMove) return { action: 'play', ids: winMove };

  // ---- 跟对手（地主）：能压就压最小牌；必要时炸 ----
  if (!teammate) {
    const normal = genBeat(p.hand, last, false);
    if (normal && tryPlay(p, normal, last)) return { action: 'play', ids: normal };
    const bomb = considerBomb(p.hand, last, lastSeat, room, false);
    if (bomb && tryPlay(p, bomb, last)) return { action: 'play', ids: bomb };
    return { action: 'pass' };
  }

  // ---- 跟队友：顺手把「散牌」清出去（散牌不影响牌型、小幅压住队友不算压太多）----
  // 仅用散单/散对，且点数不超过 A（不用 2/王 接队友，避免压队友太多、浪费控牌）
  const ll = room.players.find(pl => pl.seat === room.landlordSeat);
  const landlordDanger = ll && ll.hand.length <= 2;

  if (last.type === 'single') {
    const sp = findSpareSingles(p.hand);
    for (const card of sp) {
      if (card.v > last.rank && card.v <= 14) {   // 散单牌小幅压住队友；不用 2/王
        const ids = [card.id];
        if (tryPlay(p, ids, last)) return { action: 'play', ids };
      }
    }
  } else if (last.type === 'pair') {
    const sp = findSparePairs(p.hand);
    for (const cards of sp) {
      const v = cards[0].v;
      if (v > last.rank && v <= 14) {             // 散对子小幅压住队友；不用 22
        const ids = cards.map(c => c.id);
        if (tryPlay(p, ids, last)) return { action: 'play', ids };
      }
    }
  }

  // 地主即将获胜（≤2 张）：用大牌/炸夺回牌权，地主多半压不住
  if (landlordDanger) {
    const strong = genBeat(p.hand, last, true);
    if (strong) {
      const bc = comboOfIds(p.hand, strong);
      if ((bc.type === 'bomb' || bc.type === 'rocket' || bc.rank >= 15) && tryPlay(p, strong, last))
        return { action: 'play', ids: strong };
    }
    const bomb = considerBomb(p.hand, last, lastSeat, room, true);
    if (bomb && tryPlay(p, bomb, last)) return { action: 'play', ids: bomb };
  }
  // 否则不抢队友，把牌权留给队友
  return { action: 'pass' };
}

module.exports = { botBid, botMove, decompose, genBeat, bombsOf, comboOfIds, remainingCount, isDepleted, bombBotLead: botLead };
