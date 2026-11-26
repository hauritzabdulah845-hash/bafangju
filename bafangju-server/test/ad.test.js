'use strict';
/**
 * 广告位与曝光/点击回归用例（V3.7）：
 * 广告位配置 → 素材投放 → 审核 → 展示 → 曝光/点击去重计数。
 */
const test = require('node:test');
const assert = require('node:assert');
const { createStore } = require('../src/store');
const ad = require('../src/domain/ad');
const merchant = require('../src/domain/merchant');

function setup() {
  const db = createStore();
  db.merchants.insert({ id: 'm1', name: '张记粮油店', status: 'active' });
  db.categories.insert({ id: 'c1', name: '粮油食品', r: 0.2 });
  db.products.insert({ id: 'p1', categoryId: 'c1', name: '大米 5kg', priceFen: 1000, costFen: 300, status: 'on_sale' });
  const slot = ad.createSlot(db, { name: '首页 Banner A', position: 'home_banner', minDays: 7, feePerCycleFen: 20000 });
  return { db, slot };
}

function bookApproved(db, slotId, extra = {}) {
  const b = merchant.bookAdSlot(db, { slotId, merchantId: 'm1', days: 7, title: '粮油节', ...extra });
  return ad.reviewBooking(db, { bookingId: b.id, approved: true, operator: 'admin' });
}

test('广告位配置：位置与价格校验', () => {
  const db = createStore();
  assert.throws(() => ad.createSlot(db, { name: '测试位', position: 'nowhere', minDays: 7, feePerCycleFen: 100 }), /位置非法/);
  assert.throws(() => ad.createSlot(db, { name: '测试位', minDays: 0, feePerCycleFen: 100 }), /最短档期/);
  assert.throws(() => ad.createSlot(db, { name: '测试位', minDays: 7, feePerCycleFen: 0 }), /价格/);
  const s = ad.createSlot(db, { name: '详情页位', position: 'detail', minDays: 3, feePerCycleFen: 500 });
  assert.strictEqual(s.position, 'detail');
  assert.strictEqual(s.status, 'available');
});

test('展示：仅"已审核 + 档期内"的广告可见，过期即下线', () => {
  const { db, slot } = setup();
  const b = merchant.bookAdSlot(db, { slotId: slot.id, merchantId: 'm1', days: 7, title: '粮油节' });
  assert.strictEqual(ad.listAdsForPosition(db, 'home_banner').length, 0); // 待审核不展示
  const approved = ad.reviewBooking(db, { bookingId: b.id, approved: true });
  assert.strictEqual(ad.listAdsForPosition(db, 'home_banner').length, 1);
  assert.strictEqual(ad.listAdsForPosition(db, 'home_banner')[0].title, '粮油节');
  // 过期后不再展示
  db.adBookings.update(approved.id, { endAt: new Date(Date.now() - 1000).toISOString() });
  assert.strictEqual(ad.listAdsForPosition(db, 'home_banner').length, 0);
});

test('曝光统计：同用户同日只计一次，不同用户各计一次', () => {
  const { db, slot } = setup();
  const b = bookApproved(db, slot.id);
  assert.strictEqual(ad.recordImpression(db, { bookingId: b.id, userId: 'u1' }).counted, true);
  assert.strictEqual(ad.recordImpression(db, { bookingId: b.id, userId: 'u1' }).counted, false); // 去重
  assert.strictEqual(ad.recordImpression(db, { bookingId: b.id, userId: 'u2' }).counted, true);
  assert.strictEqual(db.adBookings.get(b.id).impressionCount, 2);
  // 未审核/已过期的投放不计数
  assert.strictEqual(ad.recordImpression(db, { bookingId: 'not_exist', userId: 'u1' }).counted, false);
});

test('点击统计：返回跳转目标，同用户同日只计一次', () => {
  const { db, slot } = setup();
  const b = bookApproved(db, slot.id, { targetType: 'product', targetId: 'p1' });
  const r1 = ad.recordClick(db, { bookingId: b.id, userId: 'u1' });
  assert.strictEqual(r1.counted, true);
  assert.strictEqual(r1.targetType, 'product');
  assert.strictEqual(r1.targetId, 'p1');
  const r2 = ad.recordClick(db, { bookingId: b.id, userId: 'u1' });
  assert.strictEqual(r2.counted, false);
  assert.strictEqual(r2.targetId, 'p1'); // 去重也不影响跳转
  assert.strictEqual(db.adBookings.get(b.id).clickCount, 1);
});

test('驳回：广告位立即释放；待审核超时：自动驳回并释放', () => {
  const { db, slot } = setup();
  const b = merchant.bookAdSlot(db, { slotId: slot.id, merchantId: 'm1', days: 7, title: '违规素材' });
  ad.reviewBooking(db, { bookingId: b.id, approved: false, note: '素材不合规' });
  assert.strictEqual(db.adSlots.get(slot.id).status, 'available');
  assert.strictEqual(db.adBookings.get(b.id).reviewStatus, 'rejected');

  const b2 = merchant.bookAdSlot(db, { slotId: slot.id, merchantId: 'm1', days: 7, title: '待审核超时' });
  db.adBookings.update(b2.id, { createdAt: new Date(Date.now() - 100 * 3600000).toISOString() });
  const released = merchant.releaseExpiredAdSlots(db, { now: Date.now() });
  assert.deepStrictEqual(released, [b2.id]);
  assert.strictEqual(db.adSlots.get(slot.id).status, 'available');
  assert.strictEqual(db.adBookings.get(b2.id).reviewStatus, 'rejected');
});

test('CTR 与投放汇总', () => {
  const { db, slot } = setup();
  const b = bookApproved(db, slot.id);
  ad.recordImpression(db, { bookingId: b.id, userId: 'u1' });
  ad.recordImpression(db, { bookingId: b.id, userId: 'u2' });
  ad.recordClick(db, { bookingId: b.id, userId: 'u1' });
  const s = ad.adSummary(db, {});
  assert.strictEqual(s.bookings, 1);
  assert.strictEqual(s.impressions, 2);
  assert.strictEqual(s.clicks, 1);
  assert.strictEqual(s.ctrPercent, 50);
  assert.strictEqual(ad.ctrOf(0, 0), 0);
  assert.strictEqual(ad.ctrOf(3, 1), 33.33);
});
