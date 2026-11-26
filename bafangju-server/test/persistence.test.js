'use strict';
/**
 * 持久化存储测试：SQLite 驱动与内存驱动接口一致；重启（重新打开）后
 * 数据/自增序列/开关/幂等键/审计日志全部恢复。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../src/store');
const svc = require('../src/services');

function tmpDbPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bfj-')), 'test.db');
}

test('SQLite 与内存驱动接口一致：插入/查询/更新', () => {
  const db = createStore({ sqlitePath: tmpDbPath() });
  assert.strictEqual(db._driver, 'sqlite');
  const cat = db.categories.insert({ id: 'c1', name: '粮油', r: 0.2 });
  db.products.insert({ id: 'p1', categoryId: 'c1', name: '米', priceFen: 1000, deliveryType: 'store', status: 'on_sale' });
  assert.strictEqual(db.products.get('p1').priceFen, 1000);
  assert.strictEqual(db.products.where((p) => p.categoryId === 'c1').length, 1);
  db.products.update('p1', { status: 'off_sale' });
  assert.strictEqual(db.products.get('p1').status, 'off_sale');
  assert.ok(cat.id === 'c1');
});

test('重启恢复：业务数据、自增序列、开关、幂等键、审计全部不丢', () => {
  const dbPath = tmpDbPath();
  // 第一次"运行"
  const db1 = createStore({ sqlitePath: dbPath });
  const cat = db1.categories.insert({ id: 'c1', name: '粮油', r: 0.2 });
  db1.products.insert({ id: 'p1', categoryId: cat.id, name: '米', priceFen: 1000, costFen: 300, deliveryType: 'store', status: 'on_sale' });
  const { order } = svc.createOrder(db1, { userId: 'u1', productId: 'p1', idempotencyKey: 'k1' });
  db1.switches.set('withdrawEnabled', true);
  db1.auditLogs.push({ ts: 't', actor: 'x', action: 'test.event', detail: '{}' });
  const ordersCountBefore = db1.orders.all().length;

  // 第二次"运行"（模拟重启：全新实例打开同一文件）
  const db2 = createStore({ sqlitePath: dbPath });
  assert.strictEqual(db2._driver, 'sqlite');
  // 数据恢复
  assert.strictEqual(db2.orders.all().length, ordersCountBefore);
  assert.strictEqual(db2.orders.get(order.id).status, 'pending_pay');
  // 自增序列恢复：新插入不冲突
  const { order: order2, replay } = svc.createOrder(db2, { userId: 'u1', productId: 'p1', idempotencyKey: 'k2' });
  assert.strictEqual(replay, false);
  assert.notStrictEqual(String(order2.id), String(order.id));
  // 幂等键恢复：旧 key 重放返回首次结果
  const again = svc.createOrder(db2, { userId: 'u1', productId: 'p1', idempotencyKey: 'k1' });
  assert.strictEqual(again.replay, true);
  assert.strictEqual(again.order.id, order.id);
  // 开关恢复
  assert.strictEqual(db2.switches.get('withdrawEnabled'), true);
  // 审计恢复（append-only；createOrder 本身不写审计，重启后应含手动事件）
  assert.ok(db2.auditLogs.length >= 1);
  assert.ok(db2.auditLogs.slice(-5).some((a) => a.action === 'test.event'));
  // 开关删除也持久化
  db2.switches.delete('withdrawEnabled');
  const db3 = createStore({ sqlitePath: dbPath });
  assert.strictEqual(db3.switches.get('withdrawEnabled'), false); // 回落默认值
});

test('重启后完整业务链路可继续（周期收口跨重启）', () => {
  const dbPath = tmpDbPath();
  const db1 = createStore({ sqlitePath: dbPath });
  const cat = db1.categories.insert({ id: 'c1', name: '粮油', r: 0.2 }); // m=6，周期 10 单
  db1.products.insert({ id: 'p1', categoryId: cat.id, name: '米', priceFen: 1000, costFen: 300, deliveryType: 'store', status: 'on_sale' });
  for (let i = 1; i <= 9; i++) {
    const { order } = svc.createOrder(db1, { userId: 'u1', productId: 'p1', idempotencyKey: 'p' + i });
    svc.onPaid(db1, { orderId: order.id });
  }
  const db2 = createStore({ sqlitePath: dbPath });
  // 第 10 单（让利 40%）在重启后支付，周期收口、发放队位
  const { order } = svc.createOrder(db2, { userId: 'u1', productId: 'p1', idempotencyKey: 'p10' });
  assert.strictEqual(order.paidFen, 600);
  svc.onPaid(db2, { orderId: order.id });
  assert.strictEqual(db2.queueSlots.all().length, 1);
  assert.strictEqual(db2.progress.get('u1:c1').done, 0); // 新周期
});

test('内存驱动默认值不受影响（测试隔离）', () => {
  const db = createStore();
  assert.strictEqual(db._driver, 'memory');
  assert.strictEqual(db.switches.get('indirectReferralEnabled'), false);
  assert.strictEqual(db.auditLogs.length, 0);
});
