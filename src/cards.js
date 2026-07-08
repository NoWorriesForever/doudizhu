'use strict';

// ============================================================
// 牌堆：建牌、洗牌、排序
// ============================================================

const SUITS = ['♠', '♥', '♣', '♦'];

function labelOf(v) {
  if (v <= 10) return String(v);
  return { 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 16: '小王', 17: '大王' }[v];
}

function buildDeck() {
  const deck = [];
  for (let v = 3; v <= 15; v++)
    for (let s = 0; s < 4; s++)
      deck.push({ id: `${v}_${s}`, v, suit: s, label: labelOf(v) });
  deck.push({ id: 'joker_s', v: 16, suit: -1, label: '小王' });
  deck.push({ id: 'joker_b', v: 17, suit: -1, label: '大王' });
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function sortHand(hand) {
  hand.sort((a, b) => (b.v - a.v) || (b.suit - a.suit));
  return hand;
}

module.exports = { SUITS, labelOf, buildDeck, shuffle, sortHand };
