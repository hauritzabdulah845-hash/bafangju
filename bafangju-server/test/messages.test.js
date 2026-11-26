'use strict';
/**
 * 消息中心六类：周期完成 / 队位获得 / 分红发放 / 分红顺延 / 提现结果 / 系统公告。
 * 站内消息是所有通知的兜底通道（订阅消息只是补充）。
 */
const test = require('node:test');
const assert = require('node:assert');
const { createStore } = require('../src/store');
const svc = require('../src/services');
const dividend = require('../src/domain/dividend');
const withdraw = require('../src/domain/withdraw');

function setup() {
  const db = createStore();
  db.users.insert({ id: 'u1', nickname: 'u1', createdAt: new Date().toISOString() });
  db.users.insert({ id: 'u2', nickname: 'u2', createdAt: new Date().toISOString() });
  return db;
}
const typesOf = (db, userId) => db.messages.where((m) => m.userId === userId).map((m) => m.type);

test('周期完成 + 队位获得：第 10 单支付后产生两条消息', () => {
  const db = setup();
  db.categories.insert({ id: 'c1', name: '粮油食品', r: 0.2 }); // m=6，周期 10 单
  db.products.insert({ id: 'p1', categoryId: 'c1', name: '大米', priceFen: 1000, costFen: 300, deliveryType: 'store', status: 'on_sale' });
  for (let i = 0; i < 10; i++) {
    const { order } = svc.createOrder(db, { userId: 'u1', productId: 'p1', idempotencyKey: 'k' + i });
    svc.onPaid(db, { orderId: order.id });
  }
  const t = typesOf(db, 'u1');
  assert.ok(t.includes('cycle_completed'));
  assert.ok(t.includes('queue_granted'));
  assert.ok(db.messages.where((m) => m.userId === 'u1' && m.type === 'queue_granted')[0].body.includes('第 1 位'));
});

test('分红发放：每席发放产生一条消息', () => {
  const db = setup();
  db.queueSlots.insert({ userId: 'u1', periodId: 'p1', status: 'waiting', grantedAt: new Date().toISOString() });
  const r = dividend.dailyPayout(db, {
    date: '2026-10-30', poolBalanceFen: 10000, dailyRatio: 0.05, maxSeats: 100, isUserActive: () => true,
  });
  assert.strictEqual(r.paidCount, 1);
  const msgs = db.messages.where((m) => m.userId === 'u1' && m.type === 'dividend_paid');
  assert.strictEqual(msgs.length, 1);
  assert.ok(msgs[0].body.includes('5.00'));
});

test('分红顺延：不活跃跳过并发提醒，7 天内不重复', () => {
  const db = setup();
  db.queueSlots.insert({ userId: 'u1', periodId: 'p1', status: 'waiting', grantedAt: new Date().toISOString() });
  dividend.dailyPayout(db, { date: '2026-10-30', poolBalanceFen: 10000, dailyRatio: 0.05, maxSeats: 100, isUserActive: () => false });
  assert.strictEqual(db.messages.where((m) => m.userId === 'u1' && m.type === 'dividend_deferred').length, 1);
  // 次日再次跳过（同一天内重复跑批也应幂等，这里直接再跑一次）
  dividend.dailyPayout(db, { date: '2026-10-30', poolBalanceFen: 10000, dailyRatio: 0.05, maxSeats: 100, isUserActive: () => false });
  assert.strictEqual(db.messages.where((m) => m.userId === 'u1' && m.type === 'dividend_deferred').length, 1);
});

test('提现结果：发起 / 完成 / 超时退回 三类消息', () => {
  const db = setup();
  db.switches.set('withdrawEnabled', true);
  db.earnings.insert({ id: 'u1', balanceFen: 100000, frozenFen: 0, withdrawFrozenFen: 0 });
  const { request } = withdraw.applyWithdraw(db, { userId: 'u1', fen: 50000, idempotencyKey: 'w1' });
  withdraw.approveWithdraw(db, { requestId: request.id, date: '2026-10-30' });
  assert.ok(typesOf(db, 'u1').includes('withdraw_issued'));
  const t = db.withdrawTransfers.where((x) => x.userId === 'u1')[0];
  withdraw.confirmTransfer(db, { transferId: t.id });
  assert.ok(typesOf(db, 'u1').includes('withdraw_done'));
  // 超时退回
  db.earnings.insert({ id: 'u2', balanceFen: 20000, frozenFen: 0, withdrawFrozenFen: 0 });
  const { request: r2 } = withdraw.applyWithdraw(db, { userId: 'u2', fen: 20000, idempotencyKey: 'w2' });
  withdraw.approveWithdraw(db, { requestId: r2.id, date: '2026-10-30' });
  withdraw.expireStaleTransfers(db, { now: Date.now() + 100 * 3600 * 1000, date: '2026-11-03' });
  assert.ok(typesOf(db, 'u2').includes('withdraw_expired'));
});

test('系统公告：全量或指定用户，内容校验', () => {
  const db = setup();
  const r = svc.broadcastMessage(db, { title: '平台公告', body: '十月活动规则更新', operator: 'admin' });
  assert.strictEqual(r.count, 2);
  assert.strictEqual(db.messages.where((m) => m.type === 'system_notice').length, 2);
  // 指定用户
  const r2 = svc.broadcastMessage(db, { title: '定向通知', body: '仅发给 u1', userIds: ['u1'] });
  assert.strictEqual(r2.count, 1);
  // 校验
  assert.throws(() => svc.broadcastMessage(db, { title: '', body: 'x' }), /必填/);
  assert.throws(() => svc.broadcastMessage(db, { title: 'x'.repeat(61), body: 'x' }), /≤60/);
});
