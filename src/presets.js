'use strict';

// ============================================================
// 残局练习预设：每张牌用紧凑记法表示
//   普通牌：点数+花色，如 3s 10h as 2d（花色 s/h/c/d）
//   小王：X   大王：D
// 每个预设的 3 手 + 底牌 必须互不重复（由校验脚本保证）。
// ============================================================

function parseCode(code) {
  if (code === 'X') return { v: 16, suit: -1 };
  if (code === 'D') return { v: 17, suit: -1 };
  const m = code.match(/^(\d+|[JQKA])([shcd])$/);
  if (!m) throw new Error('bad card code: ' + code);
  const vmap = { J: 11, Q: 12, K: 13, A: 14, 2: 15 };
  const v = (vmap[m[1]] != null) ? vmap[m[1]] : +m[1];
  const sm = { s: 0, h: 1, c: 2, d: 3 }[m[2]];
  return { v, suit: sm };
}

const C = (str) => str.trim().split(/\s+/).filter(Boolean).map(parseCode);

// 三个教学残局（手牌刻意做得小，模拟真实残局）
const ENDGAMES = [
  {
    name: '火箭对决',
    landlordSeat: 0,
    hands: [
      C('D X 5s 5h 6s'),          // 地主：王炸 + 一对5 + 单6
      C('7s 7h 8s 8h'),            // 农民：两对，可逐级压对子
      C('9s 9h 10s 10h'),          // 农民：两对更大的
    ],
    bottom: C(''),
  },
  {
    name: '顺子争锋',
    landlordSeat: 0,
    hands: [
      C('3s 4s 5s 6s 7s D'),       // 地主：顺子3-7 + 大王
      C('8h 9h 10h Jh Qh X'),       // 农民：顺子8-Q + 小王
      C('2c 2d 3h 3d 4c'),         // 农民：两对 + 单，参与不了顺子之争
    ],
    bottom: C(''),
  },
  {
    name: '残局收割',
    landlordSeat: 0,
    hands: [
      C('2s 2h 5s 5h D'),          // 地主：两对 + 大王，牢牢掌控出牌权
      C('3s'),                      // 农民：仅一张最小单牌
      C('4s'),                      // 农民：仅一张次小单牌
    ],
    bottom: C(''),
  },
];

module.exports = { ENDGAMES, parseCode };
