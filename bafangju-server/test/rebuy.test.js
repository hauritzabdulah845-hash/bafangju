'use strict';
/**
 * 复购中心（V3.3 §5.1）：按历史购买商品聚合 + 下一单实付 + 跨类目进度总览。
 */
const test = require('node:test');
const assert = require('node:assert');
const { createStore } = require('../src/store');
const svc = require('../src/services');

function setup() {
  const db = createStore();
  db.categories.insert({ id: 'c1', name: '粮油食品', r: 0.2 });   // n=6
  db.categories.insert({ id: 'c2', name: '餐饮美食', r: 0.5 });   // n=3
  db.products.insert({ id: 'p1', categoryId: 'c1', name: '大米', priceFen: 1000, costFen: 300, deliveryType: 'store', status: 'on_sale' });
  db.products.insert({ id: 'p2', categoryId: 'c1', name: '花生油', priceFen: 800, costFen: 240, deliveryType: 'store', status: 'on_sale' });
  db.products.insert({ id: 'p3', categoryId: 'c2', name: '双人餐', priceFen: 3000, costFen: 1200, deliveryType: 'store', status: 'on_sale' });
  db.users.insert({ id: 'u1', nickname: 'u1', createdAt: new Date().toISOString() });
  return db;
}

function buy(db, productId, key) {
  const { order } = svc.createOrder(db, { userId: 'u1', productId, idempotencyKey: key });
  svc.onPaid(db, { orderId: order.id });
  return order;
}

test('复购中心：按商品聚合历史购买、按类目给出进度与下一单实付', () => {
  const db = setup();
  buy(db, 'p1', 'k1'); // c1 第 1 单 1000（全价段）
  buy(db, 'p2', 'k2'); // c1 第 2 单（花生油标价 800，全价段 → 800）
  buy(db, 'p1', 'k3'); // c1 第 3 单（大米标价 1000，全价段 → 1000）
  buy(db, 'p3', 'k4'); // c2 第 1 单

  const r = svc.rebuyOverview(db, 'u1');
  assert.strictEqual(r.products.length, 3);
  const rice = r.products.find((p) => p.productId === 'p1');
  assert.strictEqual(rice.buyCount, 2);
  assert.strictEqual(rice.step, 4); // c1 已完成 3 单 → 当前第 4 步（全价段内）
  assert.strictEqual(rice.nextPayFen, 1000); // 第 4 步仍全价
  const oil = r.products.find((p) => p.productId === 'p2');
  assert.strictEqual(oil.nextPayFen, 800); // 全价段按标价
  assert.strictEqual(oil.buyCount, 1);

  const c1 = r.categories.find((c) => c.categoryId === 'c1');
  assert.strictEqual(c1.done, 3);
  assert.strictEqual(c1.n, 6);   // 全价段 6 单
  assert.strictEqual(c1.total, 10); // 周期总单数 = 6 + 4
  assert.strictEqual(c1.remaining, 7);
  const c2 = r.categories.find((c) => c.categoryId === 'c2');
  assert.strictEqual(c2.done, 1);
  assert.strictEqual(c2.n, 3);
});

test('复购中心：退款单不计入购买次数与进度', () => {
  const db = setup();
  const o1 = buy(db, 'p1', 'k1');
  buy(db, 'p1', 'k2');
  svc.refundOrder(db, { orderId: o1.id });
  const r = svc.rebuyOverview(db, 'u1');
  const rice = r.products.find((p) => p.productId === 'p1');
  assert.strictEqual(rice.buyCount, 1);
  const c1 = r.categories.find((c) => c.categoryId === 'c1');
  assert.strictEqual(c1.done, 1);
});
