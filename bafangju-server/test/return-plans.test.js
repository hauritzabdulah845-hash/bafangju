'use strict';
/**
 * 返还页数据（/api/return-plans）：类目进度 + 整条阶梯价表。
 * 关键约束：阶梯价必须与下单同源（ladder 域），返还页显示多少，下单就扣多少。
 */
const test = require('node:test');
const assert = require('node:assert');
const { createStore } = require('../src/store');
const svc = require('../src/services');

function setup() {
  const db = createStore();
  db.categories.insert({ id: 'c1', name: '粮油食品', r: 0.2 });  // n = 6，total = 10
  db.categories.insert({ id: 'c2', name: '餐饮美食', r: 0.5 });  // n = 3，total = 7
  db.products.insert({ id: 'p1', categoryId: 'c1', name: '五常大米', priceFen: 1000, costFen: 300, deliveryType: 'store', status: 'on_sale' });
  db.products.insert({ id: 'p2', categoryId: 'c2', name: '双人餐', priceFen: 3000, costFen: 1200, deliveryType: 'store', status: 'on_sale' });
  db.users.insert({ id: 'u1', nickname: 'u1', createdAt: new Date().toISOString() });
  return db;
}

function buy(db, productId, key) {
  const { order } = svc.createOrder(db, { userId: 'u1', productId, idempotencyKey: key });
  svc.onPaid(db, { orderId: order.id });
  return order;
}

test('返还页：类目名不再是原始 id，且带出整条阶梯表', () => {
  const db = setup();
  buy(db, 'p1', 'k1');
  const { progress } = svc.returnPlans(db, 'u1');
  const c1 = progress.find((p) => p.categoryId === 'c1');

  assert.strictEqual(c1.categoryName, '粮油食品'); // 之前前端只能拿到 cat_grain 这类 id
  assert.strictEqual(c1.n, 6);
  assert.strictEqual(c1.total, 10);
  assert.strictEqual(c1.step, 2);       // 已完成 1 单 → 下一单是第 2 步
  assert.strictEqual(c1.refPriceFen, 1000);
  assert.strictEqual(c1.ladder.length, 10);

  // 前 6 单全价，尾 4 单 90/80/70/60%
  assert.deepStrictEqual(c1.ladder, [1000, 1000, 1000, 1000, 1000, 1000, 900, 800, 700, 600]);
  assert.strictEqual(c1.nextPayFen, 1000);
});

test('返还页：下一单实付随步位推进，且与真实下单价一致', () => {
  const db = setup();
  for (let i = 1; i <= 7; i++) buy(db, 'p1', 'k' + i); // 走完全价段，进入让利段第 1 单

  const { progress } = svc.returnPlans(db, 'u1');
  const c1 = progress.find((p) => p.categoryId === 'c1');
  assert.strictEqual(c1.step, 8);
  assert.strictEqual(c1.nextPayFen, 800); // 第 8 单 = 让利 20%

  // 真下单，扣款必须等于返还页显示的数
  const { order } = svc.createOrder(db, { userId: 'u1', productId: 'p1', idempotencyKey: 'k8' });
  assert.strictEqual(order.paidFen, c1.nextPayFen);
});

test('返还页：有进度但类目无在售商品时，阶梯表为空而不是报错', () => {
  const db = setup();
  // 有进度记录，但该类目下没有在售商品可作参考价
  db.products.get('p2').status = 'off_sale';
  db.progress.insert({ id: 'u1:c2', userId: 'u1', categoryId: 'c2', done: 0, n: 3, status: 'accumulating', periodId: null });

  const { progress } = svc.returnPlans(db, 'u1');
  const c2 = progress.find((p) => p.categoryId === 'c2');
  assert.strictEqual(c2.categoryName, '餐饮美食');
  assert.strictEqual(c2.refPriceFen, null);
  assert.strictEqual(c2.nextPayFen, null);
  assert.deepStrictEqual(c2.ladder, []); // 前端据此不渲染 chip，不崩
});

test('返还页：参考价取该类目在售最低价（无成交记录时）', () => {
  const db = setup();
  db.products.insert({ id: 'p3', categoryId: 'c2', name: '单人餐', priceFen: 1800, costFen: 700, deliveryType: 'store', status: 'on_sale' });
  db.progress.insert({ id: 'u1:c2', userId: 'u1', categoryId: 'c2', done: 0, n: 3, status: 'accumulating', periodId: null });

  const { progress } = svc.returnPlans(db, 'u1');
  const c2 = progress.find((p) => p.categoryId === 'c2');
  assert.strictEqual(c2.step, 1);
  assert.strictEqual(c2.refPriceFen, 1800); // 取 1800，不是 3000
  assert.strictEqual(c2.total, 7);          // r=0.5 → n=3 + 4
  assert.deepStrictEqual(c2.ladder, [1800, 1800, 1800, 1620, 1440, 1260, 1080]);
  assert.strictEqual(c2.nextPayFen, 1800);
});

test('返还页：累计少付只算已支付订单，不含待支付', () => {
  const db = setup();
  for (let i = 1; i <= 7; i++) buy(db, 'p1', 'k' + i);
  // 第 8 单只创建不支付（pending_pay），不应计入累计少付
  svc.createOrder(db, { userId: 'u1', productId: 'p1', idempotencyKey: 'k8' });

  const { savedFen } = svc.returnPlans(db, 'u1');
  // 前 6 单原价无让利，第 7 单 900 → 省 100
  assert.strictEqual(savedFen, 100);
});

test('返还页：无进度时返回空数组而不是报错', () => {
  const db = setup();
  const r = svc.returnPlans(db, 'u1');
  assert.deepStrictEqual(r.progress, []);
  assert.strictEqual(r.savedFen, 0);
});
