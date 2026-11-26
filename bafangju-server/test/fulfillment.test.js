'use strict';
/**
 * 履约闭环回归用例（V3.5）：发货 / 到店核销 / 确认收货 / 自动收货 / 售后。
 * 重点：履约完成后售后期才有起点，分佣才能解冻；售后处理中不解冻。
 */
const test = require('node:test');
const assert = require('node:assert');
const { createStore } = require('../src/store');
const svc = require('../src/services');
const catalog = require('../src/domain/catalog');
const fulfillment = require('../src/domain/fulfillment');
const commission = require('../src/domain/commission');
const ua = require('../src/domain/userAccount');

function setup() {
  const db = createStore();
  db.merchants.insert({ id: 'm1', name: '测试商家', status: 'active' });
  db.categories.insert({ id: 'c1', name: '粮油食品', r: 0.2 });
  const express = catalog.createProduct(db, {
    categoryId: 'c1', name: '大米 5kg', priceFen: 1000, costFen: 300, deliveryType: 'express', merchantId: 'm1',
  });
  const store = catalog.createProduct(db, {
    categoryId: 'c1', name: '到店套餐', priceFen: 1000, costFen: 300, deliveryType: 'store', merchantId: 'm1',
  });
  db.users.insert({ id: 'u1', nickname: '买家', createdAt: new Date().toISOString() });
  const addr = ua.saveAddress(db, {
    userId: 'u1', name: '张三', phone: '13800000000', region: '广东省广州市天河区', address: '体育西路 1 号',
  });
  return { db, express, store, addr };
}

test('发货：paid -> shipped 并写运单；跨店商家越权被拒；重复发货被拒', () => {
  const { db, express, addr } = setup();
  const { order } = svc.createOrder(db, { userId: 'u1', productId: express.id, addressId: addr.id, idempotencyKey: 'k1' });
  svc.onPaid(db, { orderId: order.id });
  assert.throws(
    () => fulfillment.shipOrder(db, { orderId: order.id, trackingNo: 'SF123456789', merchantId: 'other_merchant' }),
    /无权操作/
  );
  const shipped = fulfillment.shipOrder(db, { orderId: order.id, company: '顺丰速运', trackingNo: 'SF123456789', merchantId: 'm1' });
  assert.strictEqual(shipped.status, 'shipped');
  assert.strictEqual(shipped.expressCompany, '顺丰速运');
  assert.strictEqual(shipped.expressNo, 'SF123456789');
  assert.ok(shipped.shippedAt);
  assert.throws(
    () => fulfillment.shipOrder(db, { orderId: order.id, trackingNo: 'SF999999999', merchantId: 'm1' }),
    /不可发货/
  );
});

test('到店核销：生成 6 位核销码；错码拒绝；正确码 -> done', () => {
  const { db, store } = setup();
  const { order } = svc.createOrder(db, { userId: 'u1', productId: store.id, idempotencyKey: 'k2' });
  svc.onPaid(db, { orderId: order.id });
  const code = db.orders.get(order.id).verifyCode;
  assert.match(String(code), /^\d{6}$/);
  assert.throws(
    () => fulfillment.verifyStoreOrder(db, { orderId: order.id, verifyCode: '000000', merchantId: 'm1' }),
    /核销码不正确/
  );
  const done = fulfillment.verifyStoreOrder(db, { orderId: order.id, verifyCode: code, merchantId: 'm1' });
  assert.strictEqual(done.status, 'done');
  assert.ok(done.storeVerifiedAt);
  assert.ok(done.doneAt);
});

test('确认收货后售后期起算：满 7 天分佣自动解冻', () => {
  const { db, express, addr } = setup();
  db.users.insert({ id: 'u2', nickname: '推广人' });
  db.users.update('u1', { directUserId: 'u2' });
  const { order } = svc.createOrder(db, { userId: 'u1', productId: express.id, addressId: addr.id, idempotencyKey: 'k3' });
  svc.onPaid(db, { orderId: order.id });
  const rec = db.commissionRecords.where((r) => r.orderId === order.id)[0];
  assert.strictEqual(rec.status, 'frozen');
  assert.strictEqual(commission.settleDue(db, { afterHours: 168 }).length, 0); // 刚支付，未到期
  fulfillment.shipOrder(db, { orderId: order.id, trackingNo: 'SF777777', merchantId: 'm1' });
  const done = fulfillment.confirmReceipt(db, { orderId: order.id, userId: 'u1' });
  assert.strictEqual(done.status, 'done');
  assert.ok(done.receivedAt);
  // 收货 8 天前 -> 售后期已过，解冻
  db.orders.update(order.id, { receivedAt: new Date(Date.now() - 8 * 86400000).toISOString() });
  assert.strictEqual(commission.settleDue(db, { afterHours: 168 }).length, 1);
  assert.strictEqual(db.earnings.get('u2').frozenFen, 0);
  assert.ok(db.earnings.get('u2').balanceFen > 0);
});

test('自动收货：发货超 7 天未确认 -> 自动完成', () => {
  const { db, express, addr } = setup();
  const { order } = svc.createOrder(db, { userId: 'u1', productId: express.id, addressId: addr.id, idempotencyKey: 'k4' });
  svc.onPaid(db, { orderId: order.id });
  fulfillment.shipOrder(db, { orderId: order.id, trackingNo: 'SF888888', merchantId: 'm1' });
  db.orders.update(order.id, { shippedAt: new Date(Date.now() - 8 * 86400000).toISOString() });
  const received = fulfillment.autoReceiveShipped(db, { days: 7 });
  assert.deepStrictEqual(received, [order.id]);
  const o = db.orders.get(order.id);
  assert.strictEqual(o.status, 'done');
  assert.strictEqual(o.receivedBy, 'auto');
});

test('售后：申请/驳回/再申请/受理退款；处理中不解冻分佣', () => {
  const { db, express, addr } = setup();
  const { order } = svc.createOrder(db, { userId: 'u1', productId: express.id, addressId: addr.id, idempotencyKey: 'k5' });
  svc.onPaid(db, { orderId: order.id });
  assert.throws(
    () => fulfillment.applyAfterSale(db, { orderId: order.id, userId: 'someone_else', reason: '质量问题' }),
    /无权操作/
  );
  assert.throws(
    () => fulfillment.applyAfterSale(db, { orderId: order.id, userId: 'u1', reason: '坏了' }),
    /不少于 4 个字/
  );
  const applied = fulfillment.applyAfterSale(db, { orderId: order.id, userId: 'u1', reason: '商品破损，申请退款' });
  assert.strictEqual(applied.afterSaleStatus, 'applying');
  // 售后处理中：即使售后期已过也不解冻
  db.orders.update(order.id, { paidAt: new Date(Date.now() - 30 * 86400000).toISOString() });
  assert.strictEqual(commission.settleDue(db, { afterHours: 168 }).length, 0);
  // 驳回后可再次申请
  fulfillment.resolveAfterSale(db, { orderId: order.id, approved: false, note: '请补充照片' });
  assert.strictEqual(db.orders.get(order.id).afterSaleStatus, 'rejected');
  const again = fulfillment.applyAfterSale(db, { orderId: order.id, userId: 'u1', reason: '已补充照片，再次申请' });
  assert.strictEqual(again.afterSaleStatus, 'applying');
  // 受理：走退款 + 分佣回滚
  fulfillment.resolveAfterSale(db, {
    orderId: order.id, approved: true, operator: 'admin',
    refund: (id) => svc.refundOrder(db, { orderId: id, operator: 'admin' }),
  });
  const o = db.orders.get(order.id);
  assert.strictEqual(o.status, 'refunded');
  assert.strictEqual(o.afterSaleStatus, 'approved');
  assert.strictEqual(db.commissionRecords.where((r) => r.orderId === order.id)[0].status, 'rolled_back');
});

test('售后受理：退款处理中/失败时不改售后与订单状态（S4）', () => {
  const { db, express, addr } = setup();
  const { order } = svc.createOrder(db, { userId: 'u1', productId: express.id, addressId: addr.id, idempotencyKey: 'k7' });
  svc.onPaid(db, { orderId: order.id });
  fulfillment.applyAfterSale(db, { orderId: order.id, userId: 'u1', reason: '商品破损，申请退款' });
  assert.throws(
    () => fulfillment.resolveAfterSale(db, {
      orderId: order.id, approved: true, operator: 'admin',
      refund: () => { throw new Error('微信退款处理中，尚未到账'); },
    }),
    /处理中/
  );
  const o = db.orders.get(order.id);
  assert.strictEqual(o.status, 'paid');
  assert.strictEqual(o.afterSaleStatus, 'applying');
});

test('平台强制完成：paid -> done（异常订单兜底）', () => {
  const { db, store } = setup();
  const { order } = svc.createOrder(db, { userId: 'u1', productId: store.id, idempotencyKey: 'k6' });
  svc.onPaid(db, { orderId: order.id });
  const done = fulfillment.forceCompleteOrder(db, { orderId: order.id, operator: 'admin', note: '线下已履约' });
  assert.strictEqual(done.status, 'done');
  assert.strictEqual(done.receivedBy, 'manual');
});
