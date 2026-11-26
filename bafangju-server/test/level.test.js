'use strict';
/**
 * 等级与有效人数（V3.3 §4.9 / §4.10）：
 * - 等级只作权益资格：V1 10 / V2 100 / V3 1000 / V4 1万 / V5 10万 / V6 100万；
 * - 有效人数 = 绑定关系 + ≥1 笔真实支付且已过售后期、无退款 + 无风控标记 + 近 30 天活跃；
 * - 团队 = 直推 + 间推（两层）。
 */
const test = require('node:test');
const assert = require('node:assert');
const { createStore } = require('../src/store');
const svc = require('../src/services');
const level = require('../src/domain/level');
const risk = require('../src/domain/risk');

function mkUser(db, id, directUserId) {
  return db.users.insert({ id, nickname: id, directUserId: directUserId || null, createdAt: new Date().toISOString() });
}

function mkPaidOrder(db, userId, daysAgo, status = 'done') {
  const iso = new Date(Date.now() - daysAgo * 86400000).toISOString();
  return db.orders.insert({
    userId, payType: 'WX_PAY', status, priceFen: 1000, paidFen: 1000,
    createdAt: iso, paidAt: iso, receivedAt: iso, storeVerifiedAt: iso,
  });
}

test('等级门槛：V1 10 / V2 100 / V3 1000 / V4 1万 / V5 10万 / V6 100万', () => {
  assert.strictEqual(level.levelOf(0), null);
  assert.strictEqual(level.levelOf(9), null);
  assert.strictEqual(level.levelOf(10).level, 'V1');
  assert.strictEqual(level.levelOf(99).level, 'V1');
  assert.strictEqual(level.levelOf(100).level, 'V2');
  assert.strictEqual(level.levelOf(999).level, 'V2');
  assert.strictEqual(level.levelOf(1000).level, 'V3');
  assert.strictEqual(level.levelOf(1000000).level, 'V6');
  // 档案：下一档与差额
  const p = level.levelProfileOf(42);
  assert.strictEqual(p.level, 'V1');
  assert.strictEqual(p.nextLevel, 'V2');
  assert.strictEqual(p.remaining, 58);
  assert.strictEqual(level.levelProfileOf(2000000).nextLevel, null);
});

test('有效人数：直推 + 间推，只算"已过售后期、未退款、有活跃"的真实支付用户', () => {
  const db = createStore();
  mkUser(db, 'u1');
  mkUser(db, 'd1', 'u1');   // 有效
  mkUser(db, 'd2', 'u1');   // 退过款 → 无效
  mkUser(db, 'd3', 'u1');   // 没下单 → 无效
  mkUser(db, 'i1', 'd1');   // 间推，有效
  mkUser(db, 'x1');         // 路人，不在团队

  mkPaidOrder(db, 'd1', 8);
  const refunded = mkPaidOrder(db, 'd2', 8);
  db.orders.update(refunded.id, { status: 'refunded' });
  mkPaidOrder(db, 'i1', 8);
  mkPaidOrder(db, 'x1', 8);

  const r = svc.validUserCount(db, 'u1');
  assert.strictEqual(r.teamSize, 4); // d1 d2 d3 i1
  assert.strictEqual(r.validUsers, 2); // d1 + i1
  assert.deepStrictEqual(r.userIds.sort(), ['d1', 'i1']);
});

test('有效人数：售后期未过 / 售后中 / 黑名单 / 30 天不活跃 均不计入', () => {
  const db = createStore();
  mkUser(db, 'u1');
  mkUser(db, 'a', 'u1'); // 2 天前支付，售后期未过
  mkUser(db, 'b', 'u1'); // 售后中
  mkUser(db, 'c', 'u1'); // 黑名单
  mkUser(db, 'd', 'u1'); // 40 天前活跃
  mkPaidOrder(db, 'a', 2);
  const bOrder = mkPaidOrder(db, 'b', 8);
  db.orders.update(bOrder.id, { afterSaleStatus: 'applying' });
  mkPaidOrder(db, 'c', 8);
  risk.setBlacklist(db, { userId: 'c', blocked: true, reason: '刷单', operator: 'test' });
  const dOrder = mkPaidOrder(db, 'd', 40);
  db.orders.update(dOrder.id, { createdAt: new Date(Date.now() - 40 * 86400000).toISOString() });

  const r = svc.validUserCount(db, 'u1');
  assert.strictEqual(r.validUsers, 0);
});

test('levelProfile：按有效人数给出等级与下一档进度', () => {
  const db = createStore();
  mkUser(db, 'u1');
  for (let i = 0; i < 10; i++) {
    mkUser(db, 'm' + i, 'u1');
    mkPaidOrder(db, 'm' + i, 8);
  }
  const p = svc.levelProfile(db, 'u1');
  assert.strictEqual(p.validUsers, 10);
  assert.strictEqual(p.level, 'V1');
  assert.strictEqual(p.nextLevel, 'V2');
  assert.strictEqual(p.remaining, 90);
  assert.ok(p.rights.length > 0);
});

test('等级门槛可配：后台 levelThresholds 覆盖默认值', () => {
  const db = createStore();
  mkUser(db, 'u1');
  for (let i = 0; i < 5; i++) {
    mkUser(db, 'm' + i, 'u1');
    mkPaidOrder(db, 'm' + i, 8);
  }
  assert.strictEqual(svc.levelProfile(db, 'u1').level, 'V0'); // 默认 V1=10 未达标
  db.switches.set('levelThresholds', { V1: 5, V2: 100, V3: 1000, V4: 10000, V5: 100000, V6: 1000000 });
  const p = svc.levelProfile(db, 'u1');
  assert.strictEqual(p.level, 'V1');
  assert.strictEqual(p.nextLevelAt, 100);
  assert.strictEqual(p.remaining, 95);
});
