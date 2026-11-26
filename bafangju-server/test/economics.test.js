'use strict';
/**
 * 财务回归用例（2026-10-29 新阶梯模型：全价段 m 单 + 让利段 4 单，无免单）
 * 目标：任何配置下，"分佣基数合计"都不得超过"周期可分配收益"，平台不因分佣而亏损。
 */
const test = require('node:test');
const assert = require('node:assert');
const { createStore } = require('../src/store');
const svc = require('../src/services');
const ladder = require('../src/domain/ladder');
const commission = require('../src/domain/commission');

function setup() {
  const db = createStore();
  db.categories.insert({ id: 'c1', name: '粮油食品', r: 0.2 }); // m=6，周期 10 单
  db.products.insert({
    id: 'p1', categoryId: 'c1', name: '大米', priceFen: 1000, costFen: 300,
    taxFeeRate: 0.06, opCostFen: 50, deliveryType: 'store', status: 'on_sale',
  });
  db.users.insert({ id: 'u1', nickname: '买家' });
  return db;
}

/** 跑完一个完整周期：6 单全价 + 4 单让利，全部走支付（无免单） */
function runCycle(db) {
  const pays = [];
  for (let i = 0; i < 10; i++) {
    const { order } = svc.createOrder(db, { userId: 'u1', productId: 'p1', idempotencyKey: `k${i}` });
    svc.onPaid(db, { orderId: order.id });
    pays.push(order.paidFen);
  }
  return { pays };
}

const sumBy = (rows, key) => rows.reduce((s, r) => s + (r[key] || 0), 0);

test('阶梯价：1000×6 + 900/800/700/600，第 10 单支付后周期收口', () => {
  const db = setup();
  const { pays } = runCycle(db);
  assert.deepStrictEqual(pays, [1000, 1000, 1000, 1000, 1000, 1000, 900, 800, 700, 600]);
  // 周期完成后进度归零，第 11 单开新周期回到标价
  const cur = svc.currentStep(db, 'u1', 'c1');
  assert.strictEqual(cur.step, 1);
  assert.strictEqual(cur.done, 0);
});

test('分佣基数不超过周期可分配收益（平台不亏）', () => {
  const db = setup();
  runCycle(db);
  const baseSum = sumBy(db.commissionRecords.all(), 'baseFen');
  const allocSum = db.orders.all().reduce((s, o) => s + (o.allocFen || 0), 0);
  assert.strictEqual(allocSum, 4960, '周期可分配收益应为 49.60 元');
  assert.ok(baseSum <= allocSum, `分佣基数 ${baseSum} 不得超过可分配 ${allocSum}`);
  // 默认平台留存 10%（commissionPlatformRetainRate），baseSum ≈ 4960 × 0.9
  assert.ok(baseSum >= 4400, `分佣基数应接近 44.64 元，实际 ${baseSum}`);
  // 平台留存 ≥ 0（本周期不亏）
  assert.ok(svc.platformBalanceFen(db) >= 0);
});

test('无推广人：直推 70% 与团队长 8% 归平台留存，不再消失/沉淀', () => {
  const db = setup();
  runCycle(db);
  const recs = db.commissionRecords.all();
  assert.ok(recs.filter((r) => r.baseFen > 0).every((r) => r.unattributedFen > 0), '无推广人时份额应计入未归属');
  assert.ok(svc.platformBalanceFen(db) > 0);
  // 不再产生 leaderId 为空的团队长池流水（原实现会永久沉淀）
  assert.strictEqual(db.leaderPoolFlows.where((f) => !f.leaderId).length, 0);
});

test('有直推：直推拿到 70%，平台留存仍 ≥ 0', () => {
  const db = setup();
  db.users.insert({ id: 'u2', nickname: '推广人' });
  db.users.update('u1', { directUserId: 'u2' });
  runCycle(db);
  const recs = db.commissionRecords.all();
  assert.ok(sumBy(recs, 'baseFen') > 0);
  assert.ok(recs.some((r) => r.splitFen.direct > 0));
  const allocSum = db.orders.all().reduce((s, o) => s + (o.allocFen || 0), 0);
  assert.ok(sumBy(recs, 'baseFen') <= allocSum, '有直推时也不得超发');
  assert.ok(svc.platformBalanceFen(db) >= 0);
});

test('售后期到期自动结算：冻结 → 余额（修掉"收益永远冻结"）', () => {
  const db = setup();
  db.users.insert({ id: 'u2', nickname: '推广人' });
  db.users.update('u1', { directUserId: 'u2' });
  const { order } = svc.createOrder(db, { userId: 'u1', productId: 'p1', idempotencyKey: 's1' });
  svc.onPaid(db, { orderId: order.id });
  assert.strictEqual(commission.settleDue(db, { afterHours: 168 }).length, 0, '未到期不应解冻');
  db.orders.update(order.id, { paidAt: new Date(Date.now() - 8 * 86400000).toISOString() });
  assert.strictEqual(commission.settleDue(db, { afterHours: 168 }).length, 1);
  assert.strictEqual(db.earnings.get('u2').frozenFen, 0);
  assert.ok(db.earnings.get('u2').balanceFen > 0);
});

test('cycleEconomics：Σ(正单 × factor) ≈ 周期可分配收益（取整误差 ≤ 10 分）', () => {
  const e = ladder.cycleEconomics({ priceFen: 1000, n: 6, costFen: 300, taxFeeRate: 0.06, opCostFen: 50 });
  assert.strictEqual(e.rows.length, 10);
  assert.strictEqual(e.allocTotalFen, 4960);
  assert.strictEqual(e.positiveSumFen, 4960); // 新模型全部单 alloc 为正，factor = 1
  assert.strictEqual(e.factor, 1);
  const applied = e.rows.reduce((s, r) => s + Math.floor(Math.max(0, r.allocFen) * e.factor), 0);
  assert.ok(Math.abs(applied - e.allocTotalFen) <= 10, `factor 应用后应≈4960，实际 ${applied}`);
});

test('退款：周期口径同步回退，平台留存不为负', () => {
  const db = setup();
  const orders = [];
  for (let i = 0; i < 3; i++) {
    const { order } = svc.createOrder(db, { userId: 'u1', productId: 'p1', idempotencyKey: `r${i}` });
    svc.onPaid(db, { orderId: order.id });
    orders.push(order);
  }
  svc.refundOrder(db, { orderId: orders[1].id });
  const p = db.progress.get('u1:c1');
  assert.ok(p.cycleAllocFen >= 0);
  assert.ok(svc.platformBalanceFen(db) >= 0);
});
