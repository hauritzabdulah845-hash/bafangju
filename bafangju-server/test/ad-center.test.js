'use strict';
/**
 * 广告中心 V4.2 单测：素材闭环 / 效果埋点 / 商家额度自助 / 上传真实类型判定 / 权限映射。
 * 回归重点：用户端列表必须带 videoUrl（此前缺失导致视频无法播放）、sqlite 只读数组不可直接排序。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createStore } = require('../src/store');
const ac = require('../src/domain/adCenter');
const ar = require('../src/domain/adReward');
const upload = require('../src/domain/upload');
const { permsRequired } = require('../src/domain/adminUsers');

function fixture() {
  const db = createStore();
  db.merchants.insert({ id: 'm1', name: '鲜稻之家' });
  db.products.insert({ id: 'p1', title: '新米 5kg' });
  return db;
}
function plan(db, over = {}) {
  return ar.createVideo(db, {
    merchantId: 'm1', title: '新米上市', videoUrl: '/uploads/a.mp4', coverUrl: '/uploads/c.jpg',
    durationS: 30, productId: 'p1', budgetFen: 30000, chargePerIpFen: 100, dailyCap: 50, ...over,
  });
}
const mp4 = () => Buffer.concat([
  Buffer.from([0, 0, 0, 24]), Buffer.from('ftyp'), Buffer.from('isom'),
  Buffer.from([0, 0, 2, 0]), Buffer.from('isomiso2avc1mp41'), Buffer.alloc(2048),
]);

test('用户端列表必须返回播放地址与封面（历史断点回归）', () => {
  const db = fixture();
  const v = plan(db);
  ar.reviewVideo(db, { videoId: v.id, approved: true });
  const list = ar.listVideosForUser(db, 'u1');
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].videoUrl, '/uploads/a.mp4');
  assert.strictEqual(list[0].coverUrl, '/uploads/c.jpg');
});

test('封面路径非法被拒；合法站内路径可建', () => {
  const db = fixture();
  assert.throws(() => plan(db, { coverUrl: 'https://evil.example/a.jpg' }), /封面/);
  assert.strictEqual(plan(db, { coverUrl: '' }).coverUrl, '');
});

test('素材修改状态机：待审核可改 / 在投拒绝 / 驳回改完回到待审核', () => {
  const db = fixture();
  const v = plan(db);
  assert.strictEqual(ac.updateVideoMaterial(db, { videoId: v.id, coverUrl: '/uploads/c2.jpg' }).coverUrl, '/uploads/c2.jpg');
  ar.reviewVideo(db, { videoId: v.id, approved: true });
  assert.throws(() => ac.updateVideoMaterial(db, { videoId: v.id, title: '改标题' }), /仅待审核或已驳回/);
  const v2 = plan(db, { title: '会被驳回' });
  ar.reviewVideo(db, { videoId: v2.id, approved: false, note: '素材不清晰' });
  // V4.3 起驳回重提审需重新冻结整笔预算：先发放足够额度（在投的 v 已占 30000）
  ac.grantQuota(db, { merchantId: 'm1', fen: 60000 });
  const r = ac.updateVideoMaterial(db, { videoId: v2.id, title: '重新提交' });
  assert.strictEqual(r.status, 'draft');
  assert.strictEqual(r.reviewNote, '');
});

test('追加预算重算所需 IP，已抢完计划可恢复在投', () => {
  const db = fixture();
  const v = plan(db);
  ar.reviewVideo(db, { videoId: v.id, approved: true });
  const out = ac.appendBudget(db, { videoId: v.id, amountFen: 10000 });
  assert.strictEqual(out.budgetFen, 40000);
  assert.strictEqual(out.targetIpCount, 400);
  db.adVideos.update(v.id, { status: 'sold_out', claimedIpCount: 300 });
  assert.strictEqual(ac.appendBudget(db, { videoId: v.id, amountFen: 20000 }).status, 'active');
});

test('结算出具结算单；结算后不可再投、不可重复结算', () => {
  const db = fixture();
  const v = plan(db);
  ar.reviewVideo(db, { videoId: v.id, approved: true });
  const s = ac.settleVideo(db, { videoId: v.id });
  assert.strictEqual(s.refundFen, 30000);
  assert.strictEqual(db.adVideos.get(v.id).status, 'settled');
  assert.throws(() => ac.settleVideo(db, { videoId: v.id }), /当前状态不可结算/);
  assert.strictEqual(ac.markSettlementRefunded(db, { settlementId: s.id }).status, 'refunded');
  assert.throws(() => ac.markSettlementRefunded(db, { settlementId: s.id }), /已处理/);
});

test('额度：发放 → 冻结 → 不足拒绝 → 结算后回流', () => {
  const db = fixture();
  assert.strictEqual(ac.quotaOf(db, 'm1').availableFen, 0);
  ac.grantQuota(db, { merchantId: 'm1', fen: 100000, note: '线下收款' });
  const v = ac.merchantCreateVideo(db, {
    merchantId: 'm1', title: '自助计划', videoUrl: '/uploads/a.mp4', durationS: 20,
    budgetFen: 30000, chargePerIpFen: 100, dailyCap: 20,
  });
  assert.strictEqual(ac.quotaOf(db, 'm1').frozenFen, 30000);
  assert.strictEqual(ac.quotaOf(db, 'm1').availableFen, 70000);
  assert.throws(() => ac.merchantCreateVideo(db, {
    merchantId: 'm1', title: '超额', videoUrl: '/uploads/a.mp4', durationS: 20,
    budgetFen: 80000, chargePerIpFen: 100, dailyCap: 20,
  }), /额度不足/);
  ar.reviewVideo(db, { videoId: v.id, approved: true });
  ac.settleVideo(db, { videoId: v.id });
  assert.strictEqual(ac.quotaOf(db, 'm1').availableFen, 100000);
});

test('商家自助只能操作自己的计划', () => {
  const db = fixture();
  db.merchants.insert({ id: 'm2', name: '别家' });
  ac.grantQuota(db, { merchantId: 'm1', fen: 100000 });
  ac.grantQuota(db, { merchantId: 'm2', fen: 100000 });
  const v = ac.merchantCreateVideo(db, {
    merchantId: 'm1', title: 'A 的计划', videoUrl: '/uploads/a.mp4', durationS: 20,
    budgetFen: 10000, chargePerIpFen: 100, dailyCap: 20,
  });
  assert.throws(() => ac.merchantAppendBudget(db, { merchantId: 'm2', videoId: v.id, amountFen: 1000 }), /无权操作/);
  assert.strictEqual(ac.listVideosForMerchant(db, 'm2').length, 0);
  assert.strictEqual(ac.listVideosForMerchant(db, 'm1')[0].videoId, v.id);
});

test('效果埋点：曝光按人按日去重，漏斗与转化率正确', () => {
  const db = fixture();
  const v = plan(db);
  for (const t of ['expose', 'expose', 'click', 'start', 'completed', 'product_click']) ac.trackEvent(db, { videoId: v.id, userId: 'u1', type: t });
  ac.trackEvent(db, { videoId: v.id, userId: 'u1', type: 'order', orderId: 'o1', orderFen: 12900 });
  const s = ac.videoStats(db, v.id);
  assert.strictEqual(s.expose, 1);
  assert.strictEqual(s.completePercent, 100);
  assert.strictEqual(s.orderCvrPercent, 100);
  assert.strictEqual(s.orderAmountFen, 12900);
  assert.throws(() => ac.trackEvent(db, { videoId: v.id, type: 'bogus' }), /未知事件类型/);
});

test('效果看板汇总与 CSV 导出', () => {
  const db = fixture();
  const v = plan(db);
  ac.trackEvent(db, { videoId: v.id, userId: 'u1', type: 'expose' });
  const st = ac.adminStats(db);
  assert.strictEqual(st.rows.length, 1);
  assert.strictEqual(st.total.expose, 1);
  const csv = ac.statsCsv(db);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('完播率'));
  assert.ok(csv.includes('新米上市'));
});

test('sqlite 只读数组下效果看板不崩溃', () => {
  const p = path.join(os.tmpdir(), 'bfj-adcenter-' + Date.now() + '.db');
  try {
    const db = createStore({ sqlitePath: p });
    db.merchants.insert({ id: 'm1', name: '鲜稻之家' });
    db.products.insert({ id: 'p1', title: '新米 5kg' });
    plan(db);
    plan(db, { title: '第二条计划' });
    assert.doesNotThrow(() => ac.adminStats(db));
    assert.strictEqual(ac.adminStats(db).rows.length, 2);
    assert.ok(ac.statsCsv(db).includes('第二条计划'));
  } finally {
    try { fs.rmSync(p, { force: true }); } catch (_) { /* Windows 句柄占用时忽略 */ }
  }
});

test('视频上传：真实 ftyp 判定、非视频拒绝、超限拒绝', () => {
  assert.strictEqual(upload.detectVideoType(mp4()).ext, 'mp4');
  assert.strictEqual(upload.detectVideoType(Buffer.alloc(2048)), null);
  assert.throws(() => upload.decodeVideoPayload(Buffer.alloc(upload.MAX_VIDEO_BYTES + 1).toString('base64')), /24MB/);
  assert.strictEqual(upload.decodeVideoPayload(mp4().toString('base64')).length, mp4().length);
});

test('后台权限：视频上传与额度查看归广告中心，额度发放仅总账号', () => {
  assert.strictEqual(permsRequired('POST', '/upload/video'), 'adCenter');
  assert.strictEqual(permsRequired('POST', '/advideos/settle'), 'adCenter');
  assert.strictEqual(permsRequired('GET', '/ad-quotas'), 'adCenter');
  assert.strictEqual(permsRequired('POST', '/ad-quotas/grant'), 'super');
});
