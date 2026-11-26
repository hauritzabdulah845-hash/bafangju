'use strict';
/**
 * 广告额度制 V4.3：平台代投轮播、额度占用、到期结转与视频护栏回归。
 * 核心不变量：发放额度不记收入；代投只记一次收入；到期只结转，不重复扣款；旧订单隔离。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { createStore } = require('../src/store');
const ad = require('../src/domain/ad');
const ac = require('../src/domain/adCenter');
const merchant = require('../src/domain/merchant');
const { permsRequired } = require('../src/domain/adminUsers');

function fixture() {
  const db = createStore();
  db.merchants.insert({ id: 'm1', name: '鲜稻之家', status: 'active' });
  db.products.insert({ id: 'p1', merchantId: 'm1', title: '新米 5kg' });
  const slot = ad.createSlot(db, {
    name: '首页 Banner A', position: 'home_banner', minDays: 7, feePerCycleFen: 20000,
  });
  return { db, slot };
}

function book(db, slotId, over = {}) {
  return ac.adminBookAdSlot(db, {
    slotId, merchantId: 'm1', days: 7, title: '新米上市',
    imageUrl: '/uploads/banner.jpg', targetType: 'none', operator: 'operator1', ...over,
  });
}

function createVideo(db, over = {}) {
  return ac.createVideoWithQuota(db, {
    merchantId: 'm1', title: '新米视频', videoUrl: '/uploads/a.mp4', coverUrl: '/uploads/c.jpg',
    durationS: 30, productId: 'p1', budgetFen: 30000, chargePerIpFen: 100, dailyCap: 50,
    operator: 'operator1', ...over,
  });
}

test('平台代投：服务端计价、创建即上线、冻结额度且用户端可见', () => {
  const { db, slot } = fixture();
  ac.grantQuota(db, { merchantId: 'm1', fen: 100000, note: '线下收款' });
  const { booking, quota } = book(db, slot.id, {
    days: 14, targetType: 'product', targetId: 'p1',
  });

  assert.strictEqual(booking.feeFen, 40000); // 2 个 7 天档期，费用由服务端计算
  assert.strictEqual(booking.status, 'active');
  assert.strictEqual(booking.reviewStatus, 'approved');
  assert.strictEqual(booking.billingMode, 'quota');
  assert.ok(booking.startAt && booking.endAt && booking.revenueBookedAt);
  assert.strictEqual(db.adSlots.get(slot.id).status, 'occupied');
  const visible = ad.listAdsForPosition(db, 'home_banner');
  assert.strictEqual(visible.length, 1);
  assert.strictEqual(visible[0].targetId, 'p1');
  assert.strictEqual(quota.slotFrozenFen, 40000);
  assert.strictEqual(quota.availableFen, 60000);
  const freezes = db.adQuotaFlows.where((f) => f.type === 'slot_freeze');
  assert.strictEqual(freezes.length, 1);
  assert.strictEqual(freezes[0].deltaFen, -40000);
  assert.strictEqual(freezes[0].bookingId, booking.id);
  assert.strictEqual(ac.listQuotas(db).length, 1); // 只有轮播计划的商家也进入额度列表
  assert.strictEqual(ac.listQuotas(db)[0].slotBookingCount, 1);
});

test('额度不足：代投被拦截，不产生投放、额度流水或广告收入', () => {
  const { db, slot } = fixture();
  assert.throws(() => book(db, slot.id), /额度不足/);
  assert.strictEqual(db.adBookings.all().length, 0);
  assert.strictEqual(db.adQuotaFlows.all().length, 0);
  assert.strictEqual(db.reserveFlows.all().length, 0);
  assert.strictEqual(db.platformFlows.all().length, 0);
  assert.strictEqual(db.contributionFlows.all().length, 0);
  assert.strictEqual(db.adSlots.get(slot.id).status, 'available');
});

test('到期结转：冻结转已消耗、可用额度不变、收入只记一次且跑批幂等', () => {
  const { db, slot } = fixture();
  ac.grantQuota(db, { merchantId: 'm1', fen: 100000 });
  const { booking, quota: before } = book(db, slot.id);

  const reserves = () => db.reserveFlows.where((f) => f.ref === `ad_booking:${booking.id}`);
  const platform = () => db.platformFlows.where((f) => f.type === 'ad_revenue' && f.orderId === booking.id);
  const contributions = () => db.contributionFlows.where((f) => f.ref === `ad_booking:${booking.id}`);
  assert.strictEqual(reserves().length, 1);
  assert.strictEqual(platform().length, 1);
  assert.strictEqual(contributions().length, 1);
  assert.strictEqual(reserves()[0].fen, 20000);

  db.adBookings.update(booking.id, { endAt: new Date(Date.now() - 1000).toISOString() });
  assert.deepStrictEqual(merchant.releaseExpiredAdSlots(db), [booking.id]);
  const after = ac.quotaOf(db, 'm1');
  assert.strictEqual(after.slotFrozenFen, 0);
  assert.strictEqual(after.slotUsedFen, 20000);
  assert.strictEqual(after.availableFen, before.availableFen);
  assert.strictEqual(db.adSlots.get(slot.id).status, 'available');
  const expires = db.adQuotaFlows.where((f) => f.type === 'slot_expire' && f.bookingId === booking.id);
  assert.strictEqual(expires.length, 1);
  assert.strictEqual(expires[0].deltaFen, 0);
  assert.strictEqual(expires[0].amountFen, 20000);

  assert.deepStrictEqual(merchant.releaseExpiredAdSlots(db), []);
  assert.strictEqual(ac.settleSlotQuota(db, booking.id), false);
  assert.strictEqual(db.adQuotaFlows.where((f) => f.type === 'slot_expire').length, 1);
  assert.strictEqual(reserves().length, 1);
  assert.strictEqual(platform().length, 1);
  assert.strictEqual(contributions().length, 1);
});

test('legacy 商家自助轮播：不占额度、不出额度流水、到期也不结转', () => {
  const { db, slot } = fixture();
  const legacy = merchant.bookAdSlot(db, {
    slotId: slot.id, merchantId: 'm1', days: 7, title: '旧自助投放', imageUrl: '/uploads/old.jpg',
  });
  ad.reviewBooking(db, { bookingId: legacy.id, approved: true });
  assert.strictEqual(db.adBookings.get(legacy.id).billingMode, undefined);
  assert.deepStrictEqual(ac.quotaOf(db, 'm1'), {
    merchantId: 'm1', merchantName: '鲜稻之家', grantedFen: 0, usedFen: 0, frozenFen: 0,
    availableFen: 0, planCount: 0, videoUsedFen: 0, videoFrozenFen: 0,
    slotUsedFen: 0, slotFrozenFen: 0, slotBookingCount: 0,
  });
  assert.strictEqual(ac.listQuotas(db).length, 0);
  db.adBookings.update(legacy.id, { endAt: new Date(Date.now() - 1000).toISOString() });
  merchant.releaseExpiredAdSlots(db);
  assert.strictEqual(db.adQuotaFlows.all().length, 0);
});

test('视频驳回释放预算；重提审先校验额度，不足时素材与驳回态均不变', () => {
  const { db } = fixture();
  ac.grantQuota(db, { merchantId: 'm1', fen: 60000 });
  const rejected = createVideo(db, { title: '待驳回素材' });
  ac.reviewVideoWithQuota(db, { videoId: rejected.id, approved: false, note: '素材不清晰' });
  assert.strictEqual(ac.quotaOf(db, 'm1').availableFen, 60000);
  const releases = db.adQuotaFlows.where((f) => f.type === 'release' && f.videoId === rejected.id);
  assert.strictEqual(releases.length, 1);
  assert.strictEqual(releases[0].deltaFen, 30000);

  createVideo(db, { title: '占用全部额度', budgetFen: 60000 });
  assert.throws(() => ac.updateVideoMaterial(db, { videoId: rejected.id, title: '不应保存' }), /额度不足/);
  assert.strictEqual(db.adVideos.get(rejected.id).status, 'rejected');
  assert.strictEqual(db.adVideos.get(rejected.id).title, '待驳回素材');
  assert.strictEqual(db.adQuotaFlows.where((f) => f.type === 'freeze').length, 2);

  ac.grantQuota(db, { merchantId: 'm1', fen: 30000 });
  const resubmitted = ac.updateVideoMaterial(db, { videoId: rejected.id, title: '重新提交审核' });
  assert.strictEqual(resubmitted.status, 'draft');
  assert.strictEqual(resubmitted.reviewNote, '');
  assert.strictEqual(db.adQuotaFlows.where((f) => f.type === 'freeze').length, 3);
  assert.strictEqual(ac.quotaOf(db, 'm1').availableFen, 0);
});

test('后台代建与追加预算同样受额度约束', () => {
  const { db } = fixture();
  assert.throws(() => createVideo(db), /额度不足/);
  assert.strictEqual(db.adVideos.all().length, 0);
  assert.strictEqual(db.adQuotaFlows.all().length, 0);

  ac.grantQuota(db, { merchantId: 'm1', fen: 30000 });
  const video = createVideo(db);
  ac.reviewVideoWithQuota(db, { videoId: video.id, approved: true });
  assert.throws(() => ac.appendBudgetWithQuota(db, { videoId: video.id, amountFen: 1000 }), /额度不足/);
  assert.strictEqual(db.adVideos.get(video.id).budgetFen, 30000);
  assert.strictEqual(db.adQuotaFlows.where((f) => f.type === 'append').length, 0);

  ac.grantQuota(db, { merchantId: 'm1', fen: 1000 });
  const appended = ac.appendBudgetWithQuota(db, { videoId: video.id, amountFen: 1000 });
  assert.strictEqual(appended.budgetFen, 31000);
  assert.strictEqual(db.adQuotaFlows.where((f) => f.type === 'append').length, 1);
  assert.strictEqual(ac.quotaOf(db, 'm1').availableFen, 0);
});

test('轮播与视频共用额度账户：分类占用与汇总一致', () => {
  const { db, slot } = fixture();
  ac.grantQuota(db, { merchantId: 'm1', fen: 100000 });
  createVideo(db);
  book(db, slot.id, { days: 14 });
  const q = ac.quotaOf(db, 'm1');
  assert.strictEqual(q.videoFrozenFen, 30000);
  assert.strictEqual(q.slotFrozenFen, 40000);
  assert.strictEqual(q.frozenFen, 70000);
  assert.strictEqual(q.usedFen, 0);
  assert.strictEqual(q.availableFen, 30000);
  assert.strictEqual(q.planCount, 1);
  assert.strictEqual(q.slotBookingCount, 1);
});

test('平台代投路由归广告中心权限', () => {
  assert.strictEqual(permsRequired('POST', '/adslots/book'), 'adCenter');
});
