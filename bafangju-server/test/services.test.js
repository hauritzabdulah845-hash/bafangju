'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createStore } = require('../src/store');
const svc = require('../src/services');

function setup() {
  const db = createStore();
  const cat = db.categories.insert({ id: 'c1', name: '粮油食品', r: 0.2 }); // m=6，周期 10 单
  db.products.insert({ id: 'p1', categoryId: 'c1', name: '大米', priceFen: 1000, costFen: 300, deliveryType: 'store', status: 'on_sale' });
  return { db, cat };
}

test('下单按步位动态计价：6 单全价 + 4 单让利（900/800/700/600）', () => {
  const { db } = setup();
  db.users.insert({ id: 'u1', nickname: 'u1' });
  const pays = [];
  for (let i = 0; i < 10; i++) {
    const { order } = svc.createOrder(db, { userId: 'u1', productId: 'p1', idempotencyKey: `k${i}` });
    svc.onPaid(db, { orderId: order.id });
    pays.push(order.paidFen);
  }
  assert.deepStrictEqual(pays, [1000, 1000, 1000, 1000, 1000, 1000, 900, 800, 700, 600]);
});

test('周期完成：第 10 单支付后进度重置、发放队位、站内消息；第 11 单回标价', () => {
  const { db } = setup();
  db.users.insert({ id: 'u1', nickname: 'u1' });
  for (let i = 0; i < 10; i++) {
    const { order } = svc.createOrder(db, { userId: 'u1', productId: 'p1', idempotencyKey: `k${i}` });
    svc.onPaid(db, { orderId: order.id });
  }
  const cur = svc.currentStep(db, 'u1', 'c1');
  assert.strictEqual(cur.step, 1); // 周期重置
  assert.strictEqual(cur.done, 0);
  assert.strictEqual(db.progress.get('u1:c1').periodCount, 1);
  assert.strictEqual(db.queueSlots.where((s) => s.userId === 'u1' && s.status === 'waiting').length, 1);
  const types = db.messages.where((m) => m.userId === 'u1').map((m) => m.type);
  assert.ok(types.includes('cycle_completed'));
  assert.ok(types.includes('queue_granted'));
  // 第 2 周期第 1 单回到标价
  const { order: o2 } = svc.createOrder(db, { userId: 'u1', productId: 'p1', idempotencyKey: 'p2k1' });
  assert.strictEqual(o2.paidFen, 1000);
  assert.strictEqual(o2.step, 1);
});

test('退款：移出进度、仅影响其后步位；分佣与池按单回滚；周期不重算', () => {
  const { db } = setup();
  db.users.insert({ id: 'u1', nickname: 'u1' });
  const orders = [];
  for (let i = 0; i < 3; i++) {
    const { order } = svc.createOrder(db, { userId: 'u1', productId: 'p1', idempotencyKey: `k${i}` });
    svc.onPaid(db, { orderId: order.id });
    orders.push(order);
  }
  assert.strictEqual(svc.currentStep(db, 'u1', 'c1').done, 3);
  const poolBefore = svc.poolBalanceFen(db);
  svc.refundOrder(db, { orderId: orders[1].id }); // 退第 2 单（800）
  assert.strictEqual(svc.currentStep(db, 'u1', 'c1').done, 2);
  // 池入账回滚
  assert.ok(svc.poolBalanceFen(db) < poolBefore);
  // 分佣回滚
  const rec = db.commissionRecords.where((r) => r.orderId === orders[1].id)[0];
  assert.strictEqual(rec.status, 'rolled_back');
  // 已过售后期的低价单不追差：已支付订单不受影响
  assert.strictEqual(db.orders.get(orders[0].id).status, 'paid');
});

test('遗留免单订单（旧模型 payType=FREE）默认不支持退款（合规开关）', () => {
  const { db } = setup();
  db.users.insert({ id: 'u1', nickname: 'u1' });
  // 构造旧模型遗留数据：进行中的周期 + 一张 FREE 单 + 已发放队位
  const p = svc.ensureProgress(db, 'u1', db.categories.get('c1'), 6);
  p.done = 5;
  const freeOrder = db.orders.insert({
    userId: 'u1', productId: 'p1', categoryId: 'c1', payType: 'FREE', status: 'paid',
    priceFen: 1000, paidFen: 0, step: 6, periodId: p.id, createdAt: new Date().toISOString(),
  });
  db.queueSlots.insert({ userId: 'u1', periodId: p.id, status: 'waiting', grantedAt: new Date().toISOString() });
  assert.throws(() => svc.refundOrder(db, { orderId: freeOrder.id }), /免单订单默认不支持退款/);
  // 开启特殊通道后：周期作废、进度清零、队位收回
  db.switches.set('freeOrderRefundEnabled', true);
  svc.refundOrder(db, { orderId: freeOrder.id });
  assert.strictEqual(svc.currentStep(db, 'u1', 'c1').done, 0);
  assert.strictEqual(db.queueSlots.where((s) => s.userId === 'u1' && s.status === 'revoked').length, 1);
});

test('间推默认关闭（合规默认值）', () => {
  const { db } = setup();
  assert.strictEqual(db.switches.get('indirectReferralEnabled'), false);
});

test('每日任务：贡献值只记权重、幂等', () => {
  const { db } = setup();
  db.users.insert({ id: 'u1', nickname: 'u1' });
  svc.completeTask(db, { userId: 'u1', taskType: 'sign_in', date: '2026-10-24' });
  svc.completeTask(db, { userId: 'u1', taskType: 'sign_in', date: '2026-10-24' });
  assert.strictEqual(db.contributions.get('u1').weight, 10); // 幂等，只加一次
  assert.strictEqual(db.contributionFlows.all().length, 1);
});

test('活跃快照跑批', () => {
  const { db } = setup();
  db.users.insert({ id: 'u1', nickname: 'u1' });
  svc.completeTask(db, { userId: 'u1', taskType: 'sign_in', date: '2026-10-23' });
  const count = svc.snapshotActivity(db, '2026-10-23');
  assert.strictEqual(count, 1);
});
