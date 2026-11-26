'use strict';
/**
 * 订单聚合索引回归用例（P3-1）。
 * 重点：预聚合口径与改造前的逐条 where() 完全一致；写入后索引必须失效重建。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../src/store');
const orderIndex = require('../src/domain/orderIndex');

/** 直接造单（绕过下单业务流，只为构造聚合口径所需的最小字段集） */
function mkOrder(db, row) {
  return db.orders.insert({
    userId: 'u1', productId: 'p1', categoryId: 'c1', merchantId: 'm1',
    status: 'pending_pay', deliveryType: 'express', priceFen: 1000, paidFen: 1000,
    createdAt: new Date().toISOString(),
    ...row,
  });
}

function tmpDbPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bfj-idx-')), 'test.db');
}

/** 内存与 SQLite 两种驱动都跑一遍（口径必须一致） */
const DRIVERS = [
  ['memory', () => createStore({})],
  ['sqlite', () => createStore({ sqlitePath: tmpDbPath() })],
];

for (const [name, make] of DRIVERS) {
  test(`[${name}] 已拼数口径：仅 paid/done/shipped 计入`, () => {
    const db = make();
    mkOrder(db, { status: 'pending_pay' });   // 未支付：不计
    mkOrder(db, { status: 'paid' });          // 已支付：计
    mkOrder(db, { status: 'shipped' });       // 已发货：计
    mkOrder(db, { status: 'done' });          // 已完成：计
    mkOrder(db, { status: 'refunded' });      // 已退款：不计
    mkOrder(db, { status: 'cancelled' });     // 已取消：不计
    assert.strictEqual(orderIndex.soldCount(db, 'p1'), 3);
    assert.strictEqual(orderIndex.soldCount(db, 'p_not_exist'), 0);
  });

  test(`[${name}] 已拼数按商品隔离`, () => {
    const db = make();
    mkOrder(db, { productId: 'p1', status: 'paid' });
    mkOrder(db, { productId: 'p1', status: 'paid' });
    mkOrder(db, { productId: 'p2', status: 'paid' });
    assert.strictEqual(orderIndex.soldCount(db, 'p1'), 2);
    assert.strictEqual(orderIndex.soldCount(db, 'p2'), 1);
  });

  test(`[${name}] 写入后索引自动失效重建（insert/update/delete）`, () => {
    const db = make();
    mkOrder(db, { status: 'paid' });
    assert.strictEqual(orderIndex.soldCount(db, 'p1'), 1);

    // 新增已支付订单 → 计数增加
    const o2 = mkOrder(db, { status: 'paid' });
    assert.strictEqual(orderIndex.soldCount(db, 'p1'), 2);

    // 状态变更（未支付 -> 已支付）→ 计数增加
    const o3 = mkOrder(db, { status: 'pending_pay' });
    assert.strictEqual(orderIndex.soldCount(db, 'p1'), 2);
    db.orders.update(o3.id, { status: 'paid' });
    assert.strictEqual(orderIndex.soldCount(db, 'p1'), 3);

    // 退款 → 计数回退
    db.orders.update(o3.id, { status: 'refunded' });
    assert.strictEqual(orderIndex.soldCount(db, 'p1'), 2);

    // 删除订单 → 计数回退
    db.orders.delete(o2.id);
    assert.strictEqual(orderIndex.soldCount(db, 'p1'), 1);
  });

  test(`[${name}] 商家待办口径：express 计待发货、store 计待核销`, () => {
    const db = make();
    mkOrder(db, { merchantId: 'm1', status: 'paid', deliveryType: 'express' });
    mkOrder(db, { merchantId: 'm1', status: 'paid', deliveryType: 'store' });
    mkOrder(db, { merchantId: 'm1', status: 'pending_pay', deliveryType: 'express' });
    mkOrder(db, { merchantId: 'm2', status: 'paid', deliveryType: 'express' });

    const pending = orderIndex.merchantPending(db, 'm1');
    // 字段名与 /api/merchant/overview 响应契约一致
    assert.deepStrictEqual(Object.keys(pending).sort(), ['pendingShip', 'pendingVerify']);
    assert.strictEqual(pending.pendingShip, 1);
    assert.strictEqual(pending.pendingVerify, 1);

    const other = orderIndex.merchantPending(db, 'm2');
    assert.strictEqual(other.pendingShip, 1);
    assert.strictEqual(other.pendingVerify, 0);

    // 未知商家 → 零值
    assert.deepStrictEqual(orderIndex.merchantPending(db, 'm_unknown'), { pendingShip: 0, pendingVerify: 0 });
  });

  test(`[${name}] 商家待办：deliveryType 缺省视为快递（express）`, () => {
    const db = make();
    mkOrder(db, { merchantId: 'm1', status: 'paid', deliveryType: undefined });
    const pending = orderIndex.merchantPending(db, 'm1');
    assert.strictEqual(pending.pendingShip, 1);
    assert.strictEqual(pending.pendingVerify, 0);
  });

  test(`[${name}] 全站履约汇总口径`, () => {
    const db = make();
    mkOrder(db, { status: 'paid', deliveryType: 'express' });
    mkOrder(db, { status: 'paid', deliveryType: 'store' });
    mkOrder(db, { status: 'shipped' });
    mkOrder(db, { status: 'done' });
    mkOrder(db, { status: 'paid', deliveryType: 'express', afterSaleStatus: 'applying' });
    const s = orderIndex.fulfillmentStats(db);
    assert.strictEqual(s.pendingShip, 2);   // 两条 paid 且 express（含售后申请中那条）
    assert.strictEqual(s.pendingVerify, 1);
    assert.strictEqual(s.shipped, 1);
    assert.strictEqual(s.done, 1);
    assert.strictEqual(s.afterSaleApplying, 1);
  });
}

test('SQLite 驱动：直接改行字段也会使聚合缓存失效', () => {
  const db = createStore({ sqlitePath: tmpDbPath() });
  const o = mkOrder(db, { status: 'pending_pay' });
  assert.strictEqual(orderIndex.soldCount(db, 'p1'), 0);
  // 直接赋值（不经过 update()）也应被 Proxy 拦截并自增版本号
  db.orders.get(o.id).status = 'paid';
  assert.strictEqual(orderIndex.soldCount(db, 'p1'), 1);
});

test('索引不随其它表的写入而失效（按 orders 版本号判定）', () => {
  const db = createStore({});
  mkOrder(db, { status: 'paid' });
  assert.strictEqual(orderIndex.soldCount(db, 'p1'), 1);
  const before = db.orders._ver;
  db.products.insert({ id: 'p1', categoryId: 'c1', name: '米', priceFen: 1000 });
  assert.strictEqual(db.orders._ver, before, '其它表写入不应影响 orders 版本号');
  assert.strictEqual(orderIndex.soldCount(db, 'p1'), 1);
});
