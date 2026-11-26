'use strict';
/**
 * 广告位与投放（V3.7）：广告位配置 → 商家投素材 → 平台审核 → 前台展示 → 曝光/点击统计。
 *
 * 设计要点：
 * - 广告位按位置（首页 Banner / 分类页 / 详情页 / 支付结果页 / 个人中心）售卖，档期按天计价；
 * - 素材：标题 + 图片（可选，站内 /uploads/ 或 /img/ 路径）+ 跳转目标（商品/无）；
 * - 审核：投放提交后为 pending，平台通过后才展示；驳回或超时未审核自动释放广告位；
 * - 曝光/点击：按"投放 × 用户 × 天"去重后计数，明细落 adEvents 供防刷审计。
 */
const { audit } = require('../store');
const bizdate = require('./bizdate');

const POSITIONS = [
  { key: 'home_banner', label: '首页 Banner' },
  { key: 'category', label: '分类页顶部' },
  { key: 'detail', label: '商品详情页' },
  { key: 'pay_result', label: '支付结果页' },
  { key: 'profile', label: '个人中心' },
];

const POSITION_KEYS = POSITIONS.map((p) => p.key);

function nowISO() { return new Date().toISOString(); }
function dayKey(d = new Date()) { return bizdate.dayOf(d); }   // 北京时间自然日（不再用 UTC）

/** 素材图片：仅允许站内路径，防外链 */
function sanitizeImage(url) {
  if (!url) return '';
  const u = String(url).trim();
  if (!u) return '';
  if (!/^\/(img|uploads)\/[\w\-./]+$/i.test(u)) throw new Error('广告图片必须为站内 /img/ 或 /uploads/ 路径');
  return u;
}

/* ---------------- 广告位（平台配置） ---------------- */

function createSlot(db, { name, position = 'home_banner', minDays = 7, feePerCycleFen, operator = 'admin' }) {
  if (!name || String(name).trim().length < 2) throw new Error('广告位名称必填（至少 2 字）');
  if (!POSITION_KEYS.includes(position)) throw new Error('广告位位置非法');
  const d = Number(minDays);
  if (!Number.isInteger(d) || d <= 0) throw new Error('最短档期必须为正整数天');
  const fee = Number(feePerCycleFen);
  if (!Number.isInteger(fee) || fee <= 0) throw new Error('档期价格必须为正整数分');
  const s = db.adSlots.insert({
    name: String(name).trim().slice(0, 20),
    position,
    minDays: d,
    feePerCycleFen: fee,
    merchantId: null,
    status: 'available', // available | occupied
    createdAt: nowISO(),
  });
  audit(db, operator, 'ad.slot_create', { slotId: s.id, name: s.name, position, minDays: d, feePerCycleFen: fee });
  return s;
}

/** 广告位列表（含当前投放信息） */
function listSlots(db, { withBooking = true } = {}) {
  return db.adSlots.all().map((s) => {
    const position = s.position || 'home_banner';
    const label = (POSITIONS.find((p) => p.key === position) || {}).label || position;
    let booking = null;
    if (withBooking) {
      booking = db.adBookings.where((b) => b.slotId === s.id && b.status === 'active')
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0] || null;
    }
    return {
      ...s,
      position,
      positionLabel: label,
      booking: booking ? {
        id: booking.id, merchantId: booking.merchantId, title: booking.title,
        reviewStatus: booking.reviewStatus || 'approved',
        startAt: booking.startAt, endAt: booking.endAt,
        impressionCount: booking.impressionCount || 0, clickCount: booking.clickCount || 0,
      } : null,
    };
  });
}

/* ---------------- 前台展示 ---------------- */

/** 某位置当前生效的广告（已审核 + 在档期内） */
function listAdsForPosition(db, position, now = Date.now()) {
  if (!POSITION_KEYS.includes(position)) return [];
  const slots = db.adSlots.where((s) => (s.position || 'home_banner') === position);
  const out = [];
  for (const s of slots) {
    const b = db.adBookings.where((x) => x.slotId === s.id
      && x.status === 'active'
      && (x.reviewStatus || 'approved') === 'approved'
      && x.startAt && x.endAt
      && new Date(x.startAt).getTime() <= now
      && new Date(x.endAt).getTime() > now)
      .sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1))[0];
    if (!b) continue;
    const m = db.merchants.get(b.merchantId) || {};
    out.push({
      bookingId: b.id,
      slotId: s.id,
      position,
      merchantId: b.merchantId,
      merchantName: m.name || '', // 前台轮播的出处标识（非"广告"角标，仅表明内容来源）
      title: b.title || s.name,
      imageUrl: b.imageUrl || '',
      targetType: b.targetType || 'none',
      targetId: b.targetId || '',
    });
  }
  return out;
}

/* ---------------- 曝光 / 点击 ---------------- */

function activeBooking(db, bookingId, now = Date.now()) {
  const b = db.adBookings.get(String(bookingId));
  if (!b) return null;
  if (b.status !== 'active') return null;
  if ((b.reviewStatus || 'approved') !== 'approved') return null;
  if (b.endAt && new Date(b.endAt).getTime() <= now) return null;
  return b;
}

/**
 * 记录曝光（按"投放 × 用户 × 天"去重，防止刷新刷量）。
 * 未登录用户（无 userId）也计数，但不去重（无稳定标识）。
 */
function recordImpression(db, { bookingId, userId } = {}) {
  const b = activeBooking(db, bookingId);
  if (!b) return { counted: false };
  const uid = userId ? String(userId) : null;
  if (uid && db.adEvents.where((e) => e.bookingId === b.id && e.type === 'impression' && e.userId === uid && e.date === dayKey()).length > 0) {
    return { counted: false, replay: true };
  }
  db.adEvents.insert({ bookingId: b.id, slotId: b.slotId, merchantId: b.merchantId, type: 'impression', userId: uid, date: dayKey(), ts: nowISO() });
  db.adBookings.update(b.id, { impressionCount: (b.impressionCount || 0) + 1 });
  return { counted: true };
}

/** 记录点击：返回跳转目标，便于前端直接导航；同用户同日只计一次 */
function recordClick(db, { bookingId, userId } = {}) {
  const b = activeBooking(db, bookingId);
  if (!b) return { counted: false, targetType: 'none', targetId: '' };
  const uid = userId ? String(userId) : null;
  if (uid && db.adEvents.where((e) => e.bookingId === b.id && e.type === 'click' && e.userId === uid && e.date === dayKey()).length > 0) {
    return { counted: false, replay: true, targetType: b.targetType || 'none', targetId: b.targetId || '' };
  }
  db.adEvents.insert({ bookingId: b.id, slotId: b.slotId, merchantId: b.merchantId, type: 'click', userId: uid, date: dayKey(), ts: nowISO() });
  db.adBookings.update(b.id, { clickCount: (b.clickCount || 0) + 1 });
  return { counted: true, targetType: b.targetType || 'none', targetId: b.targetId || '' };
}

/* ---------------- 审核与统计 ---------------- */

/** 审核投放：通过后开始计算档期（审核耗时不计入商家档期） */
function reviewBooking(db, { bookingId, approved, note, operator = 'admin' }) {
  const b = db.adBookings.get(String(bookingId));
  if (!b) throw new Error('投放记录不存在');
  if ((b.reviewStatus || 'approved') !== 'pending') throw new Error('该投放已审核，无需重复处理');
  const now = new Date();
  if (approved) {
    const days = Number(b.days) || 1;
    const endAt = new Date(now.getTime() + days * 86400000);
    db.adBookings.update(b.id, {
      reviewStatus: 'approved',
      reviewedAt: nowISO(),
      reviewNote: String(note || '').slice(0, 200),
      startAt: now.toISOString(),
      endAt: endAt.toISOString(),
    });
  } else {
    db.adBookings.update(b.id, {
      reviewStatus: 'rejected',
      status: 'rejected',
      reviewedAt: nowISO(),
      reviewNote: String(note || '').slice(0, 200),
    });
    const slot = db.adSlots.get(b.slotId);
    if (slot && slot.status === 'occupied') db.adSlots.update(b.slotId, { status: 'available' });
  }
  audit(db, operator, 'ad.review', { bookingId: b.id, approved, note: note || '' });
  return db.adBookings.get(b.id);
}

function ctrOf(imp, clk) {
  if (!imp || imp <= 0) return 0;
  return Math.round((clk / imp) * 10000) / 100; // 百分比，两位小数
}

/** 商家投放列表（含统计） */
function listMerchantBookings(db, merchantId) {
  const mid = String(merchantId);
  const now = Date.now();
  return db.adBookings.where((b) => b.merchantId === mid)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map((b) => {
      const slot = db.adSlots.get(b.slotId) || {};
      return {
        ...b,
        slotName: slot.name || b.slotId,
        position: slot.position || 'home_banner',
        impressionCount: b.impressionCount || 0,
        clickCount: b.clickCount || 0,
        ctrPercent: ctrOf(b.impressionCount || 0, b.clickCount || 0),
        daysLeft: b.endAt ? Math.max(0, Math.ceil((new Date(b.endAt).getTime() - now) / 86400000)) : 0,
        statusText: statusTextOf(b, now),
      };
    });
}

function statusTextOf(b, now = Date.now()) {
  const review = b.reviewStatus || 'approved';
  if (review === 'pending') return '待审核';
  if (review === 'rejected') return '已驳回';
  if (b.status === 'expired') return '已结束';
  if (b.endAt && new Date(b.endAt).getTime() <= now) return '已结束';
  return '投放中';
}

/** 平台侧：投放总览（可按商家过滤） */
function listBookings(db, { merchantId, reviewStatus, limit = 100 } = {}) {
  return db.adBookings.all()
    .filter((b) => (!merchantId || b.merchantId === String(merchantId))
      && (!reviewStatus || (b.reviewStatus || 'approved') === reviewStatus))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, limit)
    .map((b) => {
      const slot = db.adSlots.get(b.slotId) || {};
      const m = db.merchants.get(b.merchantId) || {};
      return {
        ...b,
        slotName: slot.name || b.slotId,
        position: slot.position || 'home_banner',
        merchantName: m.name || b.merchantId,
        impressionCount: b.impressionCount || 0,
        clickCount: b.clickCount || 0,
        ctrPercent: ctrOf(b.impressionCount || 0, b.clickCount || 0),
        statusText: statusTextOf(b),
      };
    });
}

/** 广告效果汇总（商家/平台） */
function adSummary(db, { merchantId, month } = {}) {
  const inMonth = (ts) => !month || bizdate.monthOfIso(ts) === month;
  const rows = db.adBookings.where((b) => (!merchantId || b.merchantId === String(merchantId)) && inMonth(b.createdAt));
  const impressions = rows.reduce((s, b) => s + (b.impressionCount || 0), 0);
  const clicks = rows.reduce((s, b) => s + (b.clickCount || 0), 0);
  return {
    bookings: rows.length,
    spendFen: rows.reduce((s, b) => s + (b.feeFen || 0), 0),
    impressions,
    clicks,
    ctrPercent: ctrOf(impressions, clicks),
  };
}

/* ---------------- 轮播投放计价与创建（V4.3 额度制共用，不写任何账务） ---------------- */

/** 计价：校验广告位可投与天数，服务端算价（不信任前端报价） */
function quoteBooking(db, { slotId, days }) {
  const slot = db.adSlots.get(slotId);
  if (!slot || slot.status !== 'available') throw new Error('广告位不存在或已被占用');
  const d = Number(days);
  if (!Number.isInteger(d) || d <= 0) throw new Error('投放天数必须为正整数');
  if (d % slot.minDays !== 0) throw new Error(`该广告位最短投放 ${slot.minDays} 天，天数需为 ${slot.minDays} 的整数倍`);
  const feeFen = slot.feePerCycleFen * (d / slot.minDays);
  return { slot, days: d, feeFen };
}

/**
 * 投放记录创建（不写额度/收入，账务由调用方负责）。
 * approved=true：平台代投，直接上线并开始算档期（审核耗时不占商家时间）；
 * approved=false：旧商家自助流程，待平台审核（legacy）。
 */
function createBooking(db, { slotId, merchantId, title, imageUrl, targetType = 'none', targetId = '', days, feeFen, approved = false, operator = 'system', billingMode = '' }) {
  if (!title || String(title).trim().length < 2) throw new Error('广告标题至少 2 字');
  const img = sanitizeImage(imageUrl);
  if (targetType === 'product') {
    if (!db.products.get(targetId)) throw new Error('跳转商品不存在');
  } else if (targetType === 'merchant') {
    targetId = merchantId; // 商家自投，只能是自己的主页
  } else { targetType = 'none'; targetId = ''; }
  const now = new Date();
  const booking = {
    slotId, merchantId, title: String(title).trim(), imageUrl: img, targetType, targetId, days, feeFen,
    status: 'active', reviewStatus: approved ? 'approved' : 'pending',
    createdAt: now.toISOString(), createdBy: operator,
  };
  if (approved) {
    booking.startAt = now.toISOString();
    booking.endAt = new Date(now.getTime() + days * 86400000).toISOString();
    booking.reviewedAt = now.toISOString();
    booking.reviewedBy = operator;
    booking.reviewNote = '平台代投，创建即上线';
  }
  if (billingMode) booking.billingMode = billingMode;
  const b = db.adBookings.insert(booking);
  if (approved) db.adSlots.update(slotId, { status: 'occupied' });
  return b;
}

module.exports = {
  POSITIONS,
  POSITION_KEYS,
  sanitizeImage,
  createSlot,
  listSlots,
  listAdsForPosition,
  recordImpression,
  recordClick,
  reviewBooking,
  listMerchantBookings,
  listBookings,
  adSummary,
  ctrOf,
  statusTextOf,
  quoteBooking,
  createBooking,
};
