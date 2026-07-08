'use strict';

// ============================================================
// 牌型引擎：parseCombo + beats
// 牌值：3..10 => 3..10, J=11, Q=12, K=13, A=14, 2=15
//       小王=16, 大王=17
// ============================================================

function countMap(vals) {
  const m = {};
  for (const v of vals) m[v] = (m[v] || 0) + 1;
  return m;
}

function isSeq(sorted) {
  for (let i = 1; i < sorted.length; i++)
    if (sorted[i] !== sorted[i - 1] + 1) return false;
  return true;
}

// 飞机（带翅膀）解析
// 改进：显式校验翅膀是否为合法单张/对子，避免三张余牌+对子混合误判
function parsePlane(c) {
  const trips = Object.keys(c)
    .map(Number)
    .filter(v => c[v] >= 3 && v <= 14)
    .sort((a, b) => a - b);
  const total = Object.values(c).reduce((a, b) => a + b, 0);

  for (let i = 0; i < trips.length; i++) {
    for (let j = i + 1; j < trips.length; j++) {
      let consecutive = true;
      for (let k = i + 1; k <= j; k++)
        if (trips[k] !== trips[k - 1] + 1) { consecutive = false; break; }
      if (!consecutive) break;

      const t = j - i + 1;
      const win = trips.slice(i, j + 1);
      const rem = Object.assign({}, c);
      for (const v of win) rem[v] -= 3;

      let remCount = 0, remPairs = 0, remSingles = 0, remVals = 0;
      const remKeys = Object.keys(rem).map(Number);
      for (const k of remKeys) {
        const cc = rem[k];
        if (cc <= 0) continue;
        remCount += cc;
        remVals++;
        if (cc === 1) remSingles++;
        if (cc === 2) { remPairs++; remSingles += 2; }
        if (cc === 4) { remPairs += 2; remSingles += 4; }
      }

      // 纯飞机（无翅膀）
      if (remCount === 0 && total === 3 * t)
        return { type: 'plane', rank: win[win.length - 1], len: t };

      // 飞机带单：翅膀 = t 张单牌
      if (remCount === t && total === 4 * t)
        return { type: 'plane1', rank: win[win.length - 1], len: t };

      // 飞机带对：翅膀 = t 对（每个剩余值恰好 2 张，且剩余值的种类数 == t）
      if (remPairs === t && remSingles === 2 * t && remCount === 2 * t
          && total === 5 * t)
        return { type: 'plane2', rank: win[win.length - 1], len: t };
    }
  }
  return null;
}

// 解析一手牌 -> {type, rank, len} 或 null
function parseCombo(vals) {
  const n = vals.length;
  if (n === 0) return null;

  const c = countMap(vals);
  const uniq = Object.keys(c).map(Number).sort((a, b) => a - b);
  const vcounts = uniq.map(v => c[v]);
  const top = uniq[uniq.length - 1];

  // 王炸
  if (n === 2 && c[16] === 1 && c[17] === 1)
    return { type: 'rocket', rank: 1000, len: 1 };

  // 炸弹
  if (n === 4 && uniq.length === 1)
    return { type: 'bomb', rank: uniq[0], len: 1 };

  // 单张
  if (n === 1) return { type: 'single', rank: uniq[0], len: 1 };

  // 对子
  if (n === 2 && uniq.length === 1)
    return { type: 'pair', rank: uniq[0], len: 1 };

  // 三张
  if (n === 3 && uniq.length === 1)
    return { type: 'triple', rank: uniq[0], len: 1 };

  // 三带一
  if (n === 4) {
    const t = uniq.find(v => c[v] === 3);
    if (t !== undefined) return { type: 'triple1', rank: t, len: 1 };
  }

  // 三带二
  if (n === 5) {
    const t = uniq.find(v => c[v] === 3);
    if (t !== undefined && uniq.some(v => c[v] === 2))
      return { type: 'triple2', rank: t, len: 1 };
  }

  // 顺子 >=5（不含大小王和2）
  if (uniq.length === n && n >= 5 && top <= 14 && isSeq(uniq))
    return { type: 'straight', rank: top, len: n };

  // 连对 >=3（不含大小王和2）
  if (n >= 6 && n % 2 === 0 && vcounts.every(x => x === 2)
      && top <= 14 && isSeq(uniq))
    return { type: 'dstraight', rank: top, len: uniq.length };

  // 四带二（两张单牌）
  if (n === 6) {
    const q = uniq.find(v => c[v] === 4);
    if (q !== undefined) return { type: 'four2', rank: q, len: 1 };
  }

  // 四带两对
  if (n === 8) {
    const q = uniq.find(v => c[v] === 4);
    if (q !== undefined) {
      const rest = uniq.filter(v => v !== q);
      if (rest.length === 2 && rest.every(v => c[v] === 2))
        return { type: 'four2p', rank: q, len: 1 };
    }
  }

  // 飞机
  const plane = parsePlane(c);
  if (plane) return plane;

  return null;
}

// 后出的 cur 能否压过前一手 prev（prev 为 null 表示领出）
function beats(prev, cur) {
  if (!cur) return false;
  if (!prev) return true;

  // 王炸通杀
  if (cur.type === 'rocket') return true;

  // 炸弹互压
  if (cur.type === 'bomb') {
    if (prev.type === 'rocket') return false;
    if (prev.type === 'bomb') return cur.rank > prev.rank;
    return true; // 炸弹压一切非炸弹/非王炸
  }

  // 非炸弹不能压炸弹/王炸
  if (prev.type === 'bomb' || prev.type === 'rocket') return false;

  // 同类型同长度比点数
  return cur.type === prev.type && cur.len === prev.len && cur.rank > prev.rank;
}

module.exports = { parseCombo, beats, countMap, isSeq };
