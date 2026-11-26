'use strict';
/**
 * 商家域合规测试：券核销幂等 / 越权核销拒绝 / 广告费用划入储备专户（ad_revenue 白名单）。
 */
const test = require('node:test');
const assert = require('node:assert');
const { createStore } = require('../src/store');
const merchant = require('../src/domain/merchant');
const ad = require('../src/domain/ad');
const quarter = require('../src/domain/quarter');

function seedMerchant(db) {
  const { merchant: m } = merchant.adminCreateMerchant(db, { name: '张记粮油店', password: 'pass123456', operator: 'test' });
  return m;
}

test('商家登录（V3.8）：账号+密码；错密码/不存在账号拒绝，且不自动注册', () => {
  const db = createStore();
  const { merchant: m, initialPassword } = merchant.adminCreateMerchant(db, { name: '张记粮油店', operator: 'admin' });
  assert.ok(initialPassword && initialPassword.length >= 6);
  assert.throws(() => merchant.merchantLogin(db, { username: '张记粮油店', password: 'wrong-pass' }), /账号或密码错误/);
  assert.throws(() => merchant.merchantLogin(db, { username: '不存在的店', password: 'whatever' }), /账号或密码错误/);
  assert.strictEqual(db.merchants.where((x) => x.name === '不存在的店').length, 0); // 不再自动注册
  const a = merchant.merchantLogin(db, { username: m.username, password: initialPassword });
  const b = merchant.merchantLogin(db, { username: m.name, password: initialPassword });
  assert.strictEqual(a.merchant.id, b.merchant.id); // 账号或名称均可登录
  assert.ok(a.merchant.token);
});

test('券核销幂等：同券码二次核销返回首次记录', () => {
  const db = createStore();
  const m = seedMerchant(db);
  merchant.issueCoupon(db, { merchantId: m.id, title: '满30减5', amountOffFen: 500, minSpendFen: 3000, code: 'CPN001' });
  const r1 = merchant.verifyCoupon(db, { code: 'CPN001', merchantId: m.id, orderId: 'o1', minSpendFen: 3000 });
  const r2 = merchant.verifyCoupon(db, { code: 'CPN001', merchantId: m.id, orderId: 'o2', minSpendFen: 3000 });
  assert.strictEqual(r1.replay, false);
  assert.strictEqual(r2.replay, true);
  assert.strictEqual(r1.redemption.id, r2.redemption.id); // 第三次仍返回首次记录（核销回调重试安全）
});

test('越权核销与最低消费校验', () => {
  const db = createStore();
  const m = seedMerchant(db);
  merchant.issueCoupon(db, { merchantId: m.id, title: '满30减5', amountOffFen: 500, minSpendFen: 3000, code: 'CPN002' });
  assert.throws(() => merchant.verifyCoupon(db, { code: 'CPN002', merchantId: 'other' }), /不属于/);
  assert.throws(() => merchant.verifyCoupon(db, { code: 'CPN002', merchantId: m.id, minSpendFen: 1000 }), /最低消费/);
});

test('广告投放：服务端计价 → 待审核 → 通过后起算档期 → 到期释放', () => {
  const db = createStore();
  const m = seedMerchant(db);
  const slot = db.adSlots.insert({ merchantId: null, name: '首页横幅', status: 'available', minDays: 7, feePerCycleFen: 20000 });
  const before = quarter.reserveBalanceFen(db);
  // 前端谎报 1 分钱：服务端应按档期价 20000 分计
  const booking = merchant.bookAdSlot(db, {
    slotId: slot.id, merchantId: m.id, days: 7, feeFen: 1, title: '粮油节', imageUrl: '/uploads/demo.png',
  });
  assert.strictEqual(booking.feeFen, 20000);
  assert.strictEqual(booking.reviewStatus, 'pending');
  assert.strictEqual(quarter.reserveBalanceFen(db), before + 20000);
  const contrib = db.contributionFlows.where((c) => c.userId === m.id && c.taskType === 'ad_booking');
  assert.strictEqual(contrib.length, 1);
  assert.strictEqual(contrib[0].fen, 20000);
  assert.strictEqual(db.adSlots.get(slot.id).status, 'occupied');
  // 未审核不展示
  assert.deepStrictEqual(ad.listAdsForPosition(db, 'home_banner'), []);
  // 审核通过后才起算档期并可展示
  const approved = ad.reviewBooking(db, { bookingId: booking.id, approved: true, operator: 'admin' });
  assert.strictEqual(approved.reviewStatus, 'approved');
  assert.ok(approved.startAt && approved.endAt);
  const ads = ad.listAdsForPosition(db, 'home_banner');
  assert.strictEqual(ads.length, 1);
  assert.strictEqual(ads[0].title, '粮油节');
  // V3.4/V3.7：档期到期自动释放，避免一次性投放永久占用
  const released = merchant.releaseExpiredAdSlots(db, { now: new Date(approved.endAt).getTime() + 1000 });
  assert.deepStrictEqual(released, [booking.id]);
  assert.strictEqual(db.adSlots.get(slot.id).status, 'available');
});
