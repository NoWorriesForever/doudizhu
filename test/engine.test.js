'use strict';

// ============================================================
// 牌型引擎自测（独立于 server.js，可直接 node test/engine.test.js）
// ============================================================

const { parseCombo, beats } = require('../src/engine');

let passed = 0, failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}: ${e.message}`);
  }
}

function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error(`${msg || 'assert fail'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

function ok(v, msg) { if (!v) throw new Error(msg || 'assert falsy'); }

// ---- 基础牌型 ----
test('single', () => { const r = parseCombo([5]); eq(r.type, 'single'); eq(r.rank, 5); });
test('pair', () => { const r = parseCombo([7, 7]); eq(r.type, 'pair'); eq(r.rank, 7); });
test('triple', () => { const r = parseCombo([9, 9, 9]); eq(r.type, 'triple'); eq(r.rank, 9); });
test('triple1', () => { const r = parseCombo([9, 9, 9, 3]); eq(r.type, 'triple1'); eq(r.rank, 9); });
test('triple2', () => { const r = parseCombo([9, 9, 9, 4, 4]); eq(r.type, 'triple2'); eq(r.rank, 9); });

// ---- 顺子 ----
test('straight 5', () => { eq(parseCombo([3, 4, 5, 6, 7]).type, 'straight'); });
test('straight 7', () => { const r = parseCombo([3, 4, 5, 6, 7, 8, 9]); eq(r.type, 'straight'); eq(r.len, 7); });
test('straight 不足5', () => { ok(parseCombo([3, 4, 5, 6]) === null, 'should be null'); });
test('straight 含2', () => { ok(parseCombo([11, 12, 13, 14, 15]) === null, '2不能顺'); });

// ---- 连对 ----
test('dstraight 3对', () => { eq(parseCombo([3, 3, 4, 4, 5, 5]).type, 'dstraight'); });
test('dstraight 失败', () => { ok(parseCombo([3, 3, 4, 4, 6, 6]) === null, '不连'); });

// ---- 飞机 ----
test('plane 纯', () => { eq(parseCombo([3, 3, 3, 4, 4, 4]).type, 'plane'); });
test('plane1 带单', () => { const r = parseCombo([3, 3, 3, 4, 4, 4, 5, 6]); eq(r.type, 'plane1'); eq(r.len, 2); });
test('plane2 带对', () => { const r = parseCombo([3, 3, 3, 4, 4, 4, 7, 7, 8, 8]); eq(r.type, 'plane2'); eq(r.len, 2); });

// ---- 新增边界 ----
test('plane2 不同点数带对', () => {
  eq(parseCombo([3, 3, 3, 4, 4, 4, 5, 5, 6, 6]).type, 'plane2');
});
test('plane 混合对+单不应识别', () => {
  ok(parseCombo([3, 3, 3, 4, 4, 4, 5, 5, 6]) === null, '9张 混合对+单 不是合法整手');
});
test('三个三张不连不是飞机', () => {
  ok(parseCombo([3, 3, 3, 5, 5, 5, 7, 7, 7]) === null, '3组不连三张 不是飞机');
});

// ---- 炸弹 ----
test('bomb', () => { eq(parseCombo([6, 6, 6, 6]).type, 'bomb'); });
test('rocket', () => { eq(parseCombo([16, 17]).type, 'rocket'); });

// ---- 四带二 ----
test('four2', () => { eq(parseCombo([8, 8, 8, 8, 3, 5]).type, 'four2'); });
test('four2p', () => { eq(parseCombo([8, 8, 8, 8, 3, 3, 5, 5]).type, 'four2p'); });

// ---- 非法 ----
test('null 1', () => ok(parseCombo([3, 5]) === null));
test('null 2', () => ok(parseCombo([3, 4, 5]) === null));
test('null empty', () => ok(parseCombo([]) === null));

// ---- beats ----
test('beat single', () => ok(beats(parseCombo([5]), parseCombo([6]))));
test('not beat single', () => ok(!beats(parseCombo([6]), parseCombo([5]))));
test('beat pair', () => ok(beats(parseCombo([5, 5]), parseCombo([6, 6]))));
test('beat straight', () => ok(beats(parseCombo([3, 4, 5, 6, 7]), parseCombo([4, 5, 6, 7, 8]))));
test('not beat straight len diff', () => ok(!beats(parseCombo([3, 4, 5, 6, 7]), parseCombo([4, 5, 6, 7, 8, 9]))));
test('bomb beats single', () => ok(beats(parseCombo([5]), parseCombo([6, 6, 6, 6]))));
test('rocket beats bomb', () => ok(beats(parseCombo([6, 6, 6, 6]), parseCombo([16, 17]))));
test('nothing beats rocket', () => ok(!beats(parseCombo([16, 17]), parseCombo([6, 6, 6, 6]))));
test('lead any', () => ok(beats(null, parseCombo([3]))));
test('plane diff type not beat', () => {
  ok(!beats(parseCombo([3, 3, 3, 4, 4, 4]), parseCombo([3, 3, 3, 4, 4, 4, 5, 6])));
});

console.log(`\n引擎测试完成: ${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
