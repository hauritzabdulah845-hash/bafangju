'use strict';
/**
 * 广告中心 V4.2：素材与投放闭环（A）+ 效果数据（B）+ 商家广告额度自助（C）。
 *
 * 设计原则：不改动 adReward.js 已跑绿的计费/发放内核，本模块只做「外围增强」，
 * 计费联动仍以 adReward.derivePricing / adminVideoView 为唯一口径。
 *
 * 额度模型（零资金风险：不接支付，只登记额度）：
 *   grantedFen  = 总后台审批发放的累计额度（商家线下付款后登记）
 *   frozenFen   = Σ 未结算且未驳回计划的 budgetFen（整笔冻结，防超卖）
 *   usedFen     = Σ 已结算计划的 spentFen（实际消耗）
 *   availableFen= grantedFen − frozenFen − usedFen
 * 额度占用全部由 adVideos 实时推导，不存易失配的冗余余额；结算后剩余额度自动回流。
 */
const { audit } = require('../store');
const adReward = require('./adReward');
const bizdate = require('./bizdate');
const ad = require('./ad');
const { reserveDeposit } = require('./quarter');

function nowISO() { return new Date().toISOString(); }
function toInt(v, label) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${label}须为正整数分`);
  return n;
}
function sitePath(v, label) {
  const s = String(v == null ? '' : v).trim();
  if (s && !/^\/(img|uploads)\/[\w\-./]+$/i.test(s)) throw new Error(`${label}必须为站内 /img/ 或 /uploads/ 路径`);
  return s;
}
function videoOrThrow(db, id) {
  const v = db.adVideos.get(String(id));
  if (!v) throw new Error('广告计划不存在');
  return v;
}

/* ==================== A 素材与投放闭环 ==================== */

/** 修改素材并重提审：仅「待审核 / 已驳回」可改；驳回态改完自动回到待审核 */
function updateVideoMaterial(db, { videoId, title, videoUrl, coverUrl, durationS, productId, operator = 'admin' }) {
  const v = videoOrThrow(db, videoId);
  if (!['draft', 'rejected'].includes(v.status)) throw new Error('仅待审核或已驳回的计划可修改素材');
  const patch = {};
  if (title !== undefined) {
    const t = String(title).trim();
    if (t.length < 2) throw new Error('广告标题至少 2 字');
    patch.title = t.slice(0, 40);
  }
  if (videoUrl !== undefined) patch.videoUrl = sitePath(videoUrl, '视频');
  if (coverUrl !== undefined) patch.coverUrl = sitePath(coverUrl, '封面');
  if (durationS !== undefined) {
    const d = Number(durationS);
    if (!Number.isInteger(d) || d < 5 || d > 600) throw new Error('视频时长须为 5~600 秒');
    patch.durationS = d;
  }
  if (productId !== undefined) {
    const p = String(productId || '');
    if (p && !db.products.get(p)) throw new Error('跳转商品不存在');
    patch.productId = p;
  }
  if (Object.keys(patch).length === 0) throw new Error('没有需要修改的内容');
  // 驳回后重新提交：额度在驳回时已释放，重提审需重新冻结整笔预算；
  // 可用额度不足时保持驳回态且素材不保存，防止"释放后挪作他用再重提"造成透支。
  if (v.status === 'rejected') {
    const budgetFen = v.budgetFen || 0;
    const q = quotaOf(db, v.merchantId);
    if (q.availableFen < budgetFen) {
      throw new Error(`可用广告额度不足，无法重新提交（当前 ¥${(q.availableFen / 100).toFixed(2)}，需 ¥${(budgetFen / 100).toFixed(2)}），请联系平台充值`);
    }
    patch.status = 'draft'; patch.reviewNote = ''; patch.resubmitAt = nowISO();
    db.adVideos.update(v.id, patch);
    db.adQuotaFlows.insert({ merchantId: v.merchantId, type: 'freeze', videoId: v.id, deltaFen: -budgetFen, note: '驳回后重新提交，重新冻结预算', operator, ts: nowISO() });
  } else {
    db.adVideos.update(v.id, patch);
  }
  audit(db, operator, 'adCenter.video_material_update', { videoId: v.id, fields: Object.keys(patch).join(',') });
  return adReward.adminVideoView(db, db.adVideos.get(v.id));
}

/** 追加预算：重算所需 IP 数；已抢完的计划若追加到可继续，自动恢复在投 */
function appendBudget(db, { videoId, amountFen, operator = 'admin' }) {
  const v = videoOrThrow(db, videoId);
  if (!['active', 'sold_out'].includes(v.status)) throw new Error('仅在投或已抢完的计划可追加预算');
  const add = toInt(amountFen, '追加金额');
  const budgetFen = v.budgetFen + add;
  const targetIpCount = Math.floor(budgetFen / v.chargePerIpFen);
  const status = v.claimedIpCount < targetIpCount ? 'active' : 'sold_out';
  db.adVideos.update(v.id, { budgetFen, targetIpCount, status, lastAppendAt: nowISO() });
  audit(db, operator, 'adCenter.video_append_budget', { videoId: v.id, add, budgetFen, targetIpCount });
  return adReward.adminVideoView(db, db.adVideos.get(v.id));
}

/** 结算：出具结算单，未消耗预算退回商家可用额度；结算后计划不可再投放 */
function settleVideo(db, { videoId, operator = 'admin' }) {
  const v = videoOrThrow(db, videoId);
  if (!['active', 'sold_out', 'offline'].includes(v.status)) throw new Error('当前状态不可结算');
  const refundFen = Math.max(0, v.budgetFen - v.spentFen);
  const row = db.adVideoSettlements.insert({
    videoId: v.id,
    merchantId: v.merchantId,
    budgetFen: v.budgetFen,
    spentFen: v.spentFen,
    refundFen,
    claimedIpCount: v.claimedIpCount,
    targetIpCount: v.targetIpCount,
    status: 'pending_refund', // 线下退款后由总后台标记 refunded
    settledAt: nowISO(),
    settledBy: operator,
  });
  db.adVideos.update(v.id, { status: 'settled', settledAt: nowISO() });
  db.adQuotaFlows.insert({
    merchantId: v.merchantId, type: 'settle', videoId: v.id,
    deltaFen: refundFen, note: `计划结算，释放未消耗 ${refundFen} 分`, ts: nowISO(),
  });
  audit(db, operator, 'adCenter.video_settle', { videoId: v.id, spentFen: v.spentFen, refundFen });
  return row;
}

/** 结算单列表；status 可选筛选 */
function listSettlements(db, { merchantId, status } = {}) {
  return db.adVideoSettlements.all()
    .filter((s) => (!merchantId || s.merchantId === String(merchantId)) && (!status || s.status === status))
    .sort((a, b) => (a.settledAt < b.settledAt ? 1 : -1))
    .map((s) => ({ ...s, merchantName: (db.merchants.get(s.merchantId) || {}).name || s.merchantId }));
}

/** 标记结算单已线下退款（只改状态，不动资金） */
function markSettlementRefunded(db, { settlementId, operator = 'admin' }) {
  const s = db.adVideoSettlements.get(String(settlementId));
  if (!s) throw new Error('结算单不存在');
  if (s.status !== 'pending_refund') throw new Error('该结算单已处理');
  const row = db.adVideoSettlements.update(s.id, { status: 'refunded', refundedAt: nowISO(), refundedBy: operator });
  audit(db, operator, 'adCenter.settlement_refunded', { settlementId: s.id, refundFen: s.refundFen });
  return row;
}

/* ==================== B 效果埋点 ==================== */

const EVENT_TYPES = ['expose', 'click', 'start', 'completed', 'product_click', 'order'];

/** 上报一条广告事件；曝光按 用户×计划×日 去重，避免刷新刷量 */
function trackEvent(db, { videoId, userId = '', type, ip = '', orderId = '', orderFen = 0 }) {
  const t = String(type);
  if (!EVENT_TYPES.includes(t)) throw new Error('未知事件类型');
  const vid = String(videoId);
  if (!db.adVideos.get(vid)) throw new Error('广告计划不存在');
  const date = bizdate.today();
  if (t === 'expose' && userId) {
    const dup = db.adVideoEvents.where((e) => e.videoId === vid && e.userId === String(userId) && e.type === 'expose' && e.date === date).length;
    if (dup) return { ok: true, dedup: true };
  }
  db.adVideoEvents.insert({
    videoId: vid, userId: String(userId || ''), type: t, ip, date,
    orderId: String(orderId || ''), orderFen: Number(orderFen) || 0, ts: nowISO(),
  });
  return { ok: true, dedup: false };
}

/** 单计划漏斗（全部时段） */
function videoStats(db, videoId, { from = '', to = '' } = {}) {
  const vid = String(videoId);
  const ev = db.adVideoEvents.where((e) => e.videoId === vid
    && (!from || e.ts >= from) && (!to || e.ts <= to));
  const cnt = (t) => ev.filter((e) => e.type === t).length;
  const expose = cnt('expose'), click = cnt('click'), start = cnt('start');
  const completed = cnt('completed'), productClick = cnt('product_click'), orders = cnt('order');
  const orderAmountFen = ev.filter((e) => e.type === 'order').reduce((s, e) => s + (e.orderFen || 0), 0);
  const rate = (a, b) => b > 0 ? Math.round((a / b) * 1000) / 10 : 0;
  return {
    videoId: vid, expose, click, start, completed, productClick, orders, orderAmountFen,
    ctrPercent: rate(click, expose),
    completePercent: rate(completed, start),
    productCtrPercent: rate(productClick, completed),
    orderCvrPercent: rate(orders, click),
  };
}

/** 后台看板：每计划一行 + 平台汇总 */
function adminStats(db) {
  const rows = db.adVideos.all().slice() // sqlite 驱动返回只读数组，排序前必须拷贝
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map((v) => {
      const s = videoStats(db, v.id);
      const m = db.merchants.get(v.merchantId) || {};
      return {
        videoId: v.id, title: v.title, merchantId: v.merchantId, merchantName: m.name || v.merchantId,
        status: v.status, budgetFen: v.budgetFen, spentFen: v.spentFen,
        chargePerIpFen: v.chargePerIpFen, claimedIpCount: v.claimedIpCount, targetIpCount: v.targetIpCount,
        createdAt: v.createdAt, ...s,
      };
    });
  const sum = (k) => rows.reduce((s, r) => s + (r[k] || 0), 0);
  return {
    rows,
    total: {
      plans: rows.length,
      budgetFen: sum('budgetFen'), spentFen: sum('spentFen'),
      expose: sum('expose'), click: sum('click'), start: sum('start'),
      completed: sum('completed'), productClick: sum('productClick'),
      orders: sum('orders'), orderAmountFen: sum('orderAmountFen'),
    },
  };
}

/** 消耗明细导出（CSV，带 BOM 便于Excel直开） */
function statsCsv(db) {
  const head = ['计划ID', '标题', '商家', '状态', '预算(元)', '已消耗(元)', '曝光', '点击', '开始播放', '完播', '跳商品', '下单', '下单金额(元)', '完播率%'];
  const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const yuan = (f) => (Number(f || 0) / 100).toFixed(2);
  const lines = adminStats(db).rows.map((r) => [
    r.videoId, r.title, r.merchantName, r.status, yuan(r.budgetFen), yuan(r.spentFen),
    r.expose, r.click, r.start, r.completed, r.productClick, r.orders, yuan(r.orderAmountFen), r.completePercent,
  ].map(esc).join(','));
  return '\uFEFF' + [head.map(esc).join(','), ...lines].join('\r\n');
}

/* ==================== C 商家广告额度 ==================== */

/** 额度账户视图：占用全部由计划实时推导，不存在冗余余额。
 *  V4.3 起轮播广告位也纳入同一额度账户（仅 billingMode='quota' 的平台代投记录；
 *  无该字段的旧商家自助订单已记过收入，一律不进额度，避免重复计账）。 */
function quotaOf(db, merchantId, { now = Date.now() } = {}) {
  const mid = String(merchantId);
  const acc = db.merchantAdQuota.get(mid) || { id: mid, grantedFen: 0, updatedAt: '' };
  const videos = db.adVideos.where((v) => v.merchantId === mid);
  const settled = videos.filter((v) => v.status === 'settled');
  const held = videos.filter((v) => !['settled', 'rejected'].includes(v.status));
  const videoUsedFen = settled.reduce((s, v) => s + (v.spentFen || 0), 0);
  const videoFrozenFen = held.reduce((s, v) => s + (v.budgetFen || 0), 0);
  // 轮播：投放中未到期=冻结；已结束（expired 或 endAt 已过）=已消耗；驳回不计
  const slots = db.adBookings.where((b) => b.merchantId === mid && b.billingMode === 'quota' && (b.reviewStatus || 'approved') === 'approved');
  const slotFrozenFen = slots
    .filter((b) => b.status === 'active' && b.endAt && new Date(b.endAt).getTime() > now)
    .reduce((s, b) => s + (b.feeFen || 0), 0);
  const slotUsedFen = slots
    .filter((b) => b.status === 'expired' || (b.endAt && new Date(b.endAt).getTime() <= now))
    .reduce((s, b) => s + (b.feeFen || 0), 0);
  const usedFen = videoUsedFen + slotUsedFen;
  const frozenFen = videoFrozenFen + slotFrozenFen;
  return {
    merchantId: mid,
    merchantName: (db.merchants.get(mid) || {}).name || mid,
    grantedFen: acc.grantedFen || 0, usedFen, frozenFen,
    availableFen: Math.max(0, (acc.grantedFen || 0) - usedFen - frozenFen),
    planCount: videos.length,
    videoUsedFen, videoFrozenFen, slotUsedFen, slotFrozenFen,
    slotBookingCount: slots.length,
  };
}

/** 总后台发放额度（商家线下付款后登记，不接在线支付） */
function grantQuota(db, { merchantId, fen, note = '', operator = 'admin' }) {
  const mid = String(merchantId);
  if (!db.merchants.get(mid)) throw new Error('商家不存在');
  const add = toInt(fen, '发放额度');
  const acc = db.merchantAdQuota.get(mid);
  if (acc) db.merchantAdQuota.update(mid, { grantedFen: (acc.grantedFen || 0) + add, updatedAt: nowISO() });
  else db.merchantAdQuota.insert({ id: mid, grantedFen: add, updatedAt: nowISO() });
  db.adQuotaFlows.insert({ merchantId: mid, type: 'grant', deltaFen: add, note: String(note).slice(0, 200), operator, ts: nowISO() });
  audit(db, operator, 'adCenter.quota_grant', { merchantId: mid, fen: add, note: String(note).slice(0, 200) });
  return quotaOf(db, mid);
}

function listQuotas(db) {
  const ids = new Set([
    ...db.merchantAdQuota.all().map((a) => a.id),
    ...db.adVideos.all().map((v) => v.merchantId),
    // 只有轮播代投、没有视频计划的商家也要出现在额度列表
    ...db.adBookings.all().filter((b) => b.billingMode === 'quota').map((b) => b.merchantId),
  ]);
  return [...ids].map((id) => quotaOf(db, id)).sort((a, b) => (b.grantedFen - a.grantedFen));
}

/** 商家自助：仅看自己的计划 */
function listVideosForMerchant(db, merchantId) {
  const mid = String(merchantId);
  return db.adVideos.all()
    .filter((v) => v.merchantId === mid)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map((v) => ({
      ...adReward.adminVideoView(db, v),
      videoId: v.id, // 与后台效果看板保持同名主键，商家端列表/操作按钮依赖它
      stats: videoStats(db, v.id),
    }));
}

/** 创建计划（商家自助与后台代建共用）：强制走额度，创建即冻结整笔预算 */
function createVideoWithQuota(db, { merchantId, operator = 'admin', ...rest }) {
  const mid = String(merchantId);
  if (!db.merchants.get(mid)) throw new Error('商家不存在');
  const budgetFen = toInt(rest.budgetFen, '总预算');
  const q = quotaOf(db, mid);
  if (q.availableFen < budgetFen) {
    throw new Error(`可用广告额度不足（当前 ¥${(q.availableFen / 100).toFixed(2)}，需 ¥${(budgetFen / 100).toFixed(2)}），请先确认收款并发放额度`);
  }
  const v = adReward.createVideo(db, { merchantId: mid, ...rest, budgetFen, operator });
  db.adQuotaFlows.insert({ merchantId: mid, type: 'freeze', videoId: v.id, deltaFen: -budgetFen, note: '创建计划冻结预算', operator, ts: nowISO() });
  audit(db, operator, 'adCenter.video_create', { videoId: v.id, budgetFen });
  return adReward.adminVideoView(db, v);
}

/** 商家自助创建计划 */
function merchantCreateVideo(db, { merchantId, ...rest }) {
  return createVideoWithQuota(db, { ...rest, merchantId, operator: `merchant:${merchantId}` });
}

/** 追加预算（商家自助与后台共用）：同样受可用额度约束 */
function appendBudgetWithQuota(db, { videoId, amountFen, operator = 'admin' }) {
  const v = videoOrThrow(db, videoId);
  const add = toInt(amountFen, '追加金额');
  if (quotaOf(db, v.merchantId).availableFen < add) throw new Error('可用广告额度不足，请先确认收款并发放额度');
  const out = appendBudget(db, { videoId, amountFen: add, operator });
  db.adQuotaFlows.insert({ merchantId: v.merchantId, type: 'append', videoId: v.id, deltaFen: -add, note: '追加预算', operator, ts: nowISO() });
  return out;
}

/** 商家自助追加预算：先校验归属 */
function merchantAppendBudget(db, { merchantId, videoId, amountFen }) {
  const mid = String(merchantId);
  const v = videoOrThrow(db, videoId);
  if (v.merchantId !== mid) throw new Error('无权操作该计划');
  return appendBudgetWithQuota(db, { videoId, amountFen, operator: `merchant:${mid}` });
}

/** 审核计划（后台）：驳回时补一条释放流水（视图层本就不再冻结，流水保证可追溯） */
function reviewVideoWithQuota(db, { videoId, approved, note = '', operator = 'admin' }) {
  const v = videoOrThrow(db, videoId);
  const out = adReward.reviewVideo(db, { videoId, approved, note, operator });
  if (!approved) {
    db.adQuotaFlows.insert({ merchantId: v.merchantId, type: 'release', videoId: v.id, deltaFen: v.budgetFen || 0, note: '审核驳回，释放冻结预算', operator, ts: nowISO() });
  }
  return out;
}

/* ==================== D 轮播广告位平台代投（V4.3 额度制） ==================== */

/** 广告收入三件套：储备专户 + 平台留存台账 + 广告贡献（季度分红门槛数据源）。
 *  仅平台代投轮播在创建成功时记一次；发放额度不记收入，到期结转也不再记。 */
function recordAdRevenue(db, { merchantId, fen, bookingId }) {
  if (!Number.isInteger(fen) || fen <= 0) return;
  const now = new Date();
  reserveDeposit(db, { source: 'ad_revenue', fen, ref: `ad_booking:${bookingId}` });
  db.platformFlows.insert({ type: 'ad_revenue', direction: 'in', fen, ts: now.toISOString(), note: `轮播广告平台代投·商家 ${merchantId}`, orderId: bookingId });
  db.contributionFlows.insert({
    userId: `merchant:${merchantId}`, merchantId, taskType: 'ad_booking', flowType: 'ad_booking',
    fen, reward: 0, month: now.toISOString().slice(0, 7), date: bizdate.today(),
    createdAt: now.toISOString(), ref: `ad_booking:${bookingId}`,
  });
}

/** 平台代投轮播广告位：商家线下打款 → 后台发额度 → 工作人员代上广告并扣额度。
 *  服务端算价、创建即上线（审核耗时不占商家档期），费用从商家广告额度冻结。 */
function adminBookAdSlot(db, { slotId, merchantId, days, title, imageUrl, targetType = 'none', targetId = '', operator = 'admin' }) {
  const m = db.merchants.get(String(merchantId));
  if (!m) throw new Error('商家不存在');
  if (m.status !== 'active') throw new Error('商家已停用，不能投放');
  const { slot, days: d, feeFen } = ad.quoteBooking(db, { slotId, days });
  if (targetType === 'product') {
    const p = db.products.get(targetId);
    if (!p) throw new Error('跳转商品不存在');
    if (String(p.merchantId) !== String(m.id)) throw new Error('只能跳转该商家自己的商品，防止给他人店铺引流');
  }
  const q = quotaOf(db, m.id);
  if (q.availableFen < feeFen) {
    throw new Error(`该商家广告可用额度不足（可用 ¥${(q.availableFen / 100).toFixed(2)}，本次需 ¥${(feeFen / 100).toFixed(2)}），请先确认收款并发放额度`);
  }
  const booking = ad.createBooking(db, {
    slotId: slot.id, merchantId: m.id, title, imageUrl, targetType, targetId,
    days: d, feeFen, approved: true, operator, billingMode: 'quota',
  });
  db.adQuotaFlows.insert({
    merchantId: m.id, type: 'slot_freeze', bookingId: booking.id, deltaFen: -feeFen, amountFen: feeFen,
    note: `轮播广告平台代投·广告位「${slot.name}」${d} 天`, operator, ts: nowISO(),
  });
  recordAdRevenue(db, { merchantId: m.id, fen: feeFen, bookingId: booking.id });
  const saved = db.adBookings.update(booking.id, { revenueBookedAt: nowISO() });
  audit(db, operator, 'adCenter.slot_book', { bookingId: booking.id, merchantId: m.id, slotId: slot.id, days: d, feeFen, targetType, targetId: saved.targetId });
  return { booking: saved, quota: quotaOf(db, m.id) };
}

/** 轮播到期结转（由 merchant.releaseExpiredAdSlots 在到期时调用）：冻结转已消耗，幂等。 */
function settleSlotQuota(db, bookingId) {
  const b = db.adBookings.get(String(bookingId));
  if (!b || b.billingMode !== 'quota' || b.quotaUsedAt) return false;
  db.adBookings.update(b.id, { quotaUsedAt: nowISO() });
  db.adQuotaFlows.insert({
    merchantId: b.merchantId, type: 'slot_expire', bookingId: b.id, deltaFen: 0, amountFen: b.feeFen || 0,
    note: '轮播广告档期结束，冻结额度转为已消耗（不再重复扣减）', operator: 'system', ts: nowISO(),
  });
  return true;
}

module.exports = {
  EVENT_TYPES,
  updateVideoMaterial, appendBudget, settleVideo, listSettlements, markSettlementRefunded,
  trackEvent, videoStats, adminStats, statsCsv,
  quotaOf, grantQuota, listQuotas, listVideosForMerchant, merchantCreateVideo, merchantAppendBudget,
  createVideoWithQuota, appendBudgetWithQuota, reviewVideoWithQuota,
  adminBookAdSlot, settleSlotQuota, recordAdRevenue,
};
