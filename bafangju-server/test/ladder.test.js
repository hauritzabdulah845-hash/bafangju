'use strict';
const test = require('node:test');
const assert = require('node:assert');
const ladder = require('../src/domain/ladder');

test('全价段单数 m = floor(1/r) + 1；周期总单数 = m + 4', () => {
  assert.strictEqual(ladder.stepCount(0.2), 6);
  assert.strictEqual(ladder.stepCount(0.25), 5);
  assert.strictEqual(ladder.stepCount(0.3), 4);
  assert.strictEqual(ladder.stepCount(0.35), 3);
  assert.strictEqual(ladder.stepCount(1 / 3), 4);
  assert.strictEqual(ladder.stepCount(0.4), 3);
  assert.strictEqual(ladder.stepCount(0.5), 3);
  assert.strictEqual(ladder.totalSteps(0.2), 10);
  assert.strictEqual(ladder.totalSteps(0.35), 7);
});

test('10 元商品 r=20% 阶梯 = 6 单全价 + 4 单让利（90/80/70/60）', () => {
  const n = ladder.stepCount(0.2);
  assert.deepStrictEqual(ladder.ladderTable(1000, n),
    [1000, 1000, 1000, 1000, 1000, 1000, 900, 800, 700, 600]);
});

test('实付规则：第 1..m 单全价，第 m+1..m+4 单让利 10/20/30/40%，无免单', () => {
  const n = ladder.stepCount(0.2); // m=6
  assert.strictEqual(ladder.priceAtStep(800, n, 1), 800);
  assert.strictEqual(ladder.priceAtStep(800, n, 6), 800);  // 全价段最后一单仍全价
  assert.strictEqual(ladder.priceAtStep(800, n, 7), 720);  // 让利 10%
  assert.strictEqual(ladder.priceAtStep(800, n, 8), 640);  // 让利 20%
  assert.strictEqual(ladder.priceAtStep(800, n, 9), 560);  // 让利 30%
  assert.strictEqual(ladder.priceAtStep(800, n, 10), 480); // 让利 40%
  assert.throws(() => ladder.priceAtStep(800, n, 11));     // 超出周期
  assert.throws(() => ladder.priceAtStep(800, n, 0));
});

test('平台不亏：任意 r 下周期让利合计 = 标价×100%，恒小于周期利润', () => {
  for (const r of [0.2, 0.25, 0.3, 0.35, 0.5, 1]) {
    const n = ladder.stepCount(r);
    const table = ladder.ladderTable(1000, n);
    // 让利合计 = Σ(标价 − 实付) = 标价 × (10%+20%+30%+40%) = 标价 × 100%
    const rebateTotal = table.reduce((s, pay) => s + (1000 - pay), 0);
    assert.strictEqual(rebateTotal, 1000);
    // 周期利润 = 周期实付合计 × r；因 m = floor(1/r)+1 > 1/r，利润恒大于让利合计
    const paidTotal = table.reduce((s, pay) => s + pay, 0);
    assert.ok(paidTotal * r > rebateTotal, `r=${r} 时周期利润应大于让利合计`);
  }
});

test('可分配收益可为负、分佣基数记 0', () => {
  assert.strictEqual(ladder.allocatableIncome({ paidFen: 200, costFen: 300, taxAndFeeFen: 12, discountFen: 0, opCostFen: 50 }), -162);
});

test('快照固化 m/周期总单数/让利比例，配置变更不追溯', () => {
  const snap = ladder.makeSnapshot({ productId: 'p1', categoryId: 'c1', priceYuan: 10, r: 0.2 });
  assert.strictEqual(snap.n, 6);
  assert.strictEqual(snap.total, 10);
  assert.deepStrictEqual(snap.rebateRates, [0.1, 0.2, 0.3, 0.4]);
  assert.strictEqual(snap.priceFen, 1000);
});
