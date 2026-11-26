'use strict';
/**
 * V3.22 全量核对修复的回归测试：
 * ① 业务自然日：小程序端与服务端统一北京时间，UTC 00:00–07:59 不再错日；
 * ② 超时未支付订单：releaseOrder 到点取消、未到期/已支付不动；
 * ③ 商家自助改密：校验旧密码与长度，改密后旧 token 失效、初始密码标记清除；
 * ④ 广告跳转目标 merchant：前后端契约一致，且只允许跳本店（忽略伪造的他人店铺 ID）。
 */
const test = require('node:test');
const assert = require('node:assert');
const { createStore } = require('../src/store');
const merchant = require('../src/domain/merchant');
const svc = require('../src/services');
const bizdateServer = require('../src/domain/bizdate');
const bizdateMp = require('../../bafangju-miniprogram-user/utils/bizdate');

test('业务自然日：北京时间 00:00 不再被记成 UTC 前一天（小程序与服务端一致）', () => {
  // UTC 16:00 = 北京时间次日 00:00
  const t = new Date('2026-10-29T16:00:00.000Z');
  assert.strictEqual(bizdateServer.today(t), '2026-10-30');
  assert.strictEqual(bizdateMp.today(t), '2026-10-30');
  // UTC 15:59 = 北京时间 23:59，仍是当天
  const t2 = new Date('2026-10-29T15:59:00.000Z');
  assert.strictEqual(bizdateMp.today(t2), '2026-10-29');
});

test('超时未支付订单：releaseOrder 到点取消，未到期/已支付不动', () => {
  const db = createStore();
  const mk = (status, expireAt) => db.orders.insert({
    status, expireAt, userId: 'u1', createdAt: new Date().toISOString(),
  });
  const expired = mk('pending_pay', Date.now() - 1000);
  const fresh = mk('pending_pay', Date.now() + 60000);
  const paid = mk('paid', Date.now() - 1000);
  svc.releaseOrder(db, expired.id);
  svc.releaseOrder(db, fresh.id);
  svc.releaseOrder(db, paid.id);
  assert.strictEqual(db.orders.get(expired.id).status, 'cancelled');
  assert.strictEqual(db.orders.get(fresh.id).status, 'pending_pay');
  assert.strictEqual(db.orders.get(paid.id).status, 'paid');
});

test('商家自助改密：校验旧密码/长度 → 改密后旧 token 失效且清除初始密码标记', () => {
  const db = createStore();
  const { merchant: m, initialPassword } = merchant.adminCreateMerchant(db, { name: '测试商家', operator: 'test' });
  assert.strictEqual(m.mustChangePassword, true);
  const oldToken = m.token;
  assert.ok(merchant.merchantByToken(db, oldToken));
  assert.throws(() => merchant.merchantChangePassword(db, {
    merchantId: m.id, oldPassword: 'wrong', newPassword: 'NewPass123456',
  }), /原密码错误/);
  assert.throws(() => merchant.merchantChangePassword(db, {
    merchantId: m.id, oldPassword: initialPassword, newPassword: 'short',
  }), /至少 8 位/);
  merchant.merchantChangePassword(db, {
    merchantId: m.id, oldPassword: initialPassword, newPassword: 'NewPass123456',
  });
  const after = db.merchants.get(m.id);
  assert.strictEqual(after.mustChangePassword, false);
  assert.strictEqual(merchant.merchantByToken(db, oldToken), null); // 旧 token 立即失效
  assert.throws(() => merchant.merchantLogin(db, { username: m.username, password: initialPassword }), /账号或密码错误/);
  assert.ok(merchant.merchantLogin(db, { username: m.username, password: 'NewPass123456' }).merchant.token);
});

test('广告跳转目标 merchant：只跳本店，伪造他人店铺 ID 被忽略', () => {
  const db = createStore();
  const a = merchant.adminCreateMerchant(db, { name: '甲店', operator: 'test' }).merchant;
  const b = merchant.adminCreateMerchant(db, { name: '乙店', operator: 'test' }).merchant;
  const mkSlot = (name, fee) => db.adSlots.insert({ name, status: 'available', minDays: 7, feePerCycleFen: fee });
  const slot = mkSlot('首页横幅', 20000);
  const booking = merchant.bookAdSlot(db, {
    slotId: slot.id, merchantId: a.id, days: 7, title: '进店看看',
    targetType: 'merchant', targetId: b.id, // 试图引流到乙店
  });
  assert.strictEqual(booking.targetType, 'merchant');
  assert.strictEqual(booking.targetId, a.id); // 服务端强制本店
  const slot2 = mkSlot('详情页', 8000);
  assert.throws(() => merchant.bookAdSlot(db, {
    slotId: slot2.id, merchantId: a.id, days: 7, title: '不存在的商品',
    targetType: 'product', targetId: 'not_exist',
  }), /跳转商品不存在/);
});
