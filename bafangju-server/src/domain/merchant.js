'use strict';
/**
 * 商家（异业联盟）域逻辑（V3.3 §5 商家端 / §8 广告体系）—— 合规要点：
 * - 商家券核销幂等（一券一核销，重复核销报错并返回原记录）；
 * - 广告位投放费用属平台真实广告收益：划入储备专户（source=ad_revenue），计入商家广告贡献；
 * - 广告费用与用户货款、分佣资金严格分账。
 */
const crypto = require('crypto');
const quarter = require('./quarter');
const ad = require('./ad');
const adminAuth = require('./adminAuth');
const { audit } = require('../store');
const bizdate = require('./bizdate');

/**
 * 门店坐标归一化：小程序未选点时 JSON 里显式传 null / ''，
 * Number(null) === 0 会被误判成合法坐标 (0,0)，进而让后台审核列表显示「已选点 0.0000,0.0000」、
 * 建档商家带着几内亚湾坐标。先判空再转数值，并做经纬度范围校验。
 */
function toCoord(v, min, max) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

/**
 * 商家登录（V3.8）：账号 + 密码（scrypt 摘要，永不存明文）。
 * - 不再"输入名称即登录"，也不自动注册（必须经入驻审核 / 后台建档）；
 * - 密码错误统一提示"账号或密码错误"，不暴露账号是否存在；
 * - 停用商家直接拒绝；每次登录签发新 token（旧 token 仍有效，便于多端）。
 */
function merchantLogin(db, { username, password }) {
  const key = String(username || '').trim();
  if (!key || !password) throw new Error('请输入商家账号与密码');
  const exist = db.merchants.where((m) => m.username === key || m.name === key)[0];
  if (!exist) throw new Error('账号或密码错误');
  if (exist.status === 'disabled') throw new Error('商家已被停用，请联系平台管理员');
  const ok = !!exist.passwordHash && adminAuth.verifyPassword(password, exist.passwordHash);
  if (!ok) {
    audit(db, `merchant:${exist.id}`, 'merchant.login_failed', { username: key });
    throw new Error('账号或密码错误');
  }
  const token = crypto.randomBytes(24).toString('hex');
  db.merchants.update(exist.id, { token, lastLoginAt: new Date().toISOString() });
  audit(db, exist.id, 'merchant.login', { username: exist.username || exist.name });
  return { merchant: db.merchants.get(exist.id), replay: true };
}

/** token -> 商家（鉴权中间件用） */
function merchantByToken(db, token) {
  if (!token) return null;
  return db.merchants.where((m) => m.token === token)[0] || null;
}

/** 发放商家券（平台/商家操作）；券码唯一 */
function issueCoupon(db, { merchantId, title, amountOffFen, minSpendFen, code, validUntil }) {
  if (db.coupons.where((c) => c.code === code).length > 0) throw new Error('券码已存在');
  return db.coupons.insert({
    merchantId, title, amountOffFen, minSpendFen: minSpendFen || 0, code,
    status: 'valid', // valid -> used | expired
    validUntil: validUntil || null,
    createdAt: new Date().toISOString(),
  });
}

/** 核销商家券：幂等（同券重复核销返回首次结果）；核销须校验有效期与最低消费 */
function verifyCoupon(db, { code, merchantId, orderId, minSpendFen = 0 }) {
  const coupon = db.coupons.where((c) => c.code === code)[0];
  if (!coupon) throw new Error('券不存在');
  if (coupon.merchantId !== merchantId) throw new Error('券不属于当前商家');
  const dup = db.couponRedemptions.where((r) => r.code === code)[0];
  if (dup) return { redemption: dup, replay: true };
  if (coupon.status !== 'valid') throw new Error('券状态不可核销');
  if (coupon.validUntil && Date.now() > new Date(coupon.validUntil).getTime()) throw new Error('券已过期');
  if (minSpendFen < coupon.minSpendFen) throw new Error(`未满足最低消费 ${coupon.minSpendFen} 分`);
  const redemption = db.couponRedemptions.insert({
    couponId: coupon.id, code, merchantId, orderId: orderId || null,
    amountOffFen: coupon.amountOffFen, ts: new Date().toISOString(),
  });
  db.coupons.update(coupon.id, { status: 'used' });
  audit(db, merchantId, 'coupon.verify', { code, orderId });
  return { redemption, replay: false };
}

/**
 * 商家广告位投放（V3.7）：提交素材 → 待平台审核 → 通过后开始计算档期并展示。
 * 费用在下单时确认（划入储备专户 + 计入平台留存 + 广告贡献），审核只影响展示。
 */
function bookAdSlot(db, {
  slotId, merchantId, days, title, imageUrl, targetType = 'none', targetId, feeFen, ref,
}) {
  const slot = db.adSlots.get(slotId);
  if (!slot || slot.status !== 'available') throw new Error('广告位不可投放');
  if (!title || String(title).trim().length < 2) throw new Error('请填写广告标题（至少 2 字）');
  const d = Number(days);
  if (!Number.isInteger(d) || d <= 0) throw new Error('投放天数非法');
  const minDays = Number(slot.minDays) || 1;
  if (d % minDays !== 0) throw new Error(`投放天数须为 ${minDays} 的整数倍`);
  // 价格由服务端按档期计算，不信任前端传入的 feeFen（V3.4 修正 D9：原先前端可把 3000 元改成 1 分）
  const fee = Math.round(Number(slot.feePerCycleFen) * (d / minDays));
  if (!Number.isInteger(fee) || fee <= 0) throw new Error('广告位尚未定价，请联系平台运营');
  // targetType: none | product | merchant（V3.22：补齐 merchant，用户端首页已有该跳转分支，
  // 但此前服务端会强制降级为 none，导致"点击广告跳商家详情页"永远不生效）。
  const tType = ['product', 'merchant', 'none'].includes(targetType) ? targetType : 'none';
  let tId = '';
  if (tType === 'product') {
    tId = String(targetId || '').trim().slice(0, 40);
    if (!tId) throw new Error('请选择要跳转的商品');
    if (!db.products.get(tId)) throw new Error('跳转商品不存在');
  } else if (tType === 'merchant') {
    // 只允许跳转到当前投放商家自己的主页，忽略前端传入的 targetId，防止给他人店铺引流
    tId = String(merchantId);
    const m = db.merchants.get(tId);
    if (!m || m.status !== 'active') throw new Error('跳转商家不存在或已停用');
  }
  const booking = db.adBookings.insert({
    slotId, merchantId, days: d, feeFen: fee, ref: ref || null,
    status: 'active',
    reviewStatus: 'pending', // pending | approved | rejected；通过后才开始计算档期
    title: String(title).trim().slice(0, 40),
    imageUrl: ad.sanitizeImage(imageUrl),
    targetType: tType,
    targetId: tId,
    impressionCount: 0,
    clickCount: 0,
    createdAt: new Date().toISOString(),
    startAt: null,
    endAt: null,
    clientFeeFen: Number.isInteger(feeFen) ? feeFen : null, // 留痕前端报价，便于核对篡改
  });
  db.adSlots.update(slotId, { status: 'occupied' });
  // 广告收益划入储备专户（白名单来源 ad_revenue）
  quarter.reserveDeposit(db, { source: 'ad_revenue', fen: fee, ref: `ad_booking:${booking.id}` });
  // 平台留存台账：广告收益计入平台真实收益（储备专户是其中"专用于季度分红"的子账）
  db.platformFlows.insert({ direction: 'in', type: 'ad_revenue', orderId: booking.id, fen: fee, ts: new Date().toISOString() });
  // 广告贡献记录（季度分红"广告贡献门槛"核算数据源）
  db.contributionFlows.insert({ userId: merchantId, taskType: 'ad_booking', reward: 0, fen: fee, date: bizdate.today(), ts: new Date().toISOString() });
  audit(db, merchantId, 'ad.book', {
    slotId, days: d, feeFen: fee, title: booking.title, imageUrl: booking.imageUrl,
    targetType: tType, targetId: tId, clientFeeFen: booking.clientFeeFen,
  });
  return booking;
}

/**
 * 广告档期到期释放（V3.4 修正 D8）+ 待审核超时释放（V3.7）：
 * 到期未续投、或提交后长期未审核的投放，把广告位放回"可投放"。
 */
function releaseExpiredAdSlots(db, { now = Date.now(), pendingHours = 72 } = {}) {
  const released = [];
  for (const b of db.adBookings.where((x) => x.status === 'active')) {
    // 待审核超时：自动驳回并释放，避免占位不投放
    if ((b.reviewStatus || 'approved') === 'pending') {
      const created = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      if (created && created + Math.max(1, Number(pendingHours) || 72) * 3600000 <= now) {
        db.adBookings.update(b.id, { status: 'rejected', reviewStatus: 'rejected', reviewNote: '超时未审核，系统自动释放' });
        const slot = db.adSlots.get(b.slotId);
        if (slot && slot.status === 'occupied') db.adSlots.update(b.slotId, { status: 'available' });
        released.push(b.id);
      }
      continue;
    }
    if (!b.endAt) continue;
    if (new Date(b.endAt).getTime() > now) continue;
    db.adBookings.update(b.id, { status: 'expired' });
    // 额度制轮播（V4.3）：到期把冻结额度结转为已消耗（幂等；旧商家自助订单无 billingMode，不受影响）
    require('./adCenter').settleSlotQuota(db, b.id);
    const slot = db.adSlots.get(b.slotId);
    if (slot && slot.status === 'occupied') db.adSlots.update(b.slotId, { status: 'available' });
    released.push(b.id);
  }
  if (released.length > 0) audit(db, 'system', 'ad.release_expired', { count: released.length });
  return released;
}

// ---------- 管理后台商家管理（建档 / 启停 / 重置 token） ----------

/**
 * 管理员建档商家（V3.8）：同时创建登录账号（默认=商家名称）与密码（scrypt 摘要）。
 * 初始密码仅在本次返回，请管理员转交商家并提示登录后修改。
 * lat/lng：门店坐标（入驻地图选点），附近商家功能数据源，缺省不写。
 * @returns {{merchant:object, initialPassword:string}}
 */
function adminCreateMerchant(db, { name, contact, username, password, category, address, lat, lng, operator = 'admin' }) {
  if (!name) throw new Error('商家名称必填');
  if (db.merchants.where((m) => m.name === name).length > 0) throw new Error('商家名称已存在');
  const uname = String(username || name).trim();
  if (!uname) throw new Error('商家账号必填');
  if (db.merchants.where((m) => m.username === uname).length > 0) throw new Error('商家账号已存在');
  const pwd = password && String(password).length >= 6 ? String(password) : crypto.randomBytes(4).toString('hex');
  const token = crypto.randomBytes(24).toString('hex');
  const m = db.merchants.insert({
    name, contact: contact || '', status: 'active', token,
    username: uname,
    category: category || '',
    address: address || '',
    lat: toCoord(lat, -90, 90),
    lng: toCoord(lng, -180, 180),
    passwordHash: adminAuth.hashPassword(pwd),
    mustChangePassword: !password, // 自动生成的初始密码，首次登录后应修改
    createdAt: new Date().toISOString(), createdBy: operator,
  });
  audit(db, operator, 'merchant.create', { merchantId: m.id, name, username: uname, generatedPassword: !password });
  return { merchant: m, initialPassword: pwd };
}

/** 重置商家密码（V3.8）：旧 token 立即失效，需重新登录；返回新密码仅本次展示 */
function adminResetMerchantPassword(db, { merchantId, password, operator = 'admin' }) {
  const m = db.merchants.get(String(merchantId));
  if (!m) throw new Error('商家不存在');
  const pwd = password && String(password).length >= 6 ? String(password) : crypto.randomBytes(4).toString('hex');
  m.passwordHash = adminAuth.hashPassword(pwd);
  m.mustChangePassword = !password;
  m.token = crypto.randomBytes(24).toString('hex'); // 改密即踢下线
  audit(db, operator, 'merchant.reset_password', { merchantId: m.id, name: m.name, generatedPassword: !password });
  return { merchant: m, initialPassword: pwd };
}

/**
 * 商家自助改密（V3.22）：校验旧口令 → 写新摘要 → 清除"须改初始密码"标记 → 轮换 token 强制重新登录。
 * 此前登录页提示"请联系平台管理员重置为个人密码"，但商家端没有任何自助改密接口，
 * 提示与能力不一致、初始密码无法自行更换；补齐该闭环。
 */
function merchantChangePassword(db, { merchantId, oldPassword, newPassword }) {
  const m = db.merchants.get(String(merchantId));
  if (!m) throw new Error('商家不存在');
  if (!m.passwordHash || !adminAuth.verifyPassword(oldPassword, m.passwordHash)) throw new Error('原密码错误');
  const pwd = String(newPassword || '');
  if (pwd.length < 8) throw new Error('新密码至少 8 位');
  // 生产环境沿用管理员口令强度基线（长度大于 10 位且含字母与数字）
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') adminAuth.assertPasswordPolicy(pwd);
  m.passwordHash = adminAuth.hashPassword(pwd);
  m.mustChangePassword = false;
  m.token = crypto.randomBytes(24).toString('hex'); // 旧 token 立即失效，需重新登录
  audit(db, m.id, 'merchant.change_password', { merchantId: m.id });
  return m;
}

/**
 * 商家入驻申请（V3.3 §5 人工审核入驻）：提交资质材料，pending_review -> approved | rejected。
 * 审核通过自动建档发初始 token；同名称待审/在营不可重复提交。
 * lat/lng：门店地图选点坐标（附近商家功能用），选填但强烈建议（附近列表只展示已选点商家）。
 */
function submitEntryApplication(db, {
  name, contact, phone, category, address, licenseImgUrl, shopImgUrl, remark, lat, lng,
}) {
  if (!name || String(name).trim().length < 2) throw new Error('商家名称必填（至少 2 字）');
  if (!contact) throw new Error('联系人必填');
  if (!phone || !/^1\d{10}$/.test(String(phone))) throw new Error('手机号格式不正确');
  if (!category) throw new Error('经营类目必填');
  if (!address) throw new Error('门店地址必填');
  if (!licenseImgUrl) throw new Error('营业执照照片必传');
  // 证照地址必须是站内上传路径（P0-3）：杜绝外站图片/任意 URL 混入审核页
  if (!/^\/(uploads|uploads-private)\/[\w\-.]+$/.test(String(licenseImgUrl))) throw new Error('营业执照照片地址非法（须为站内上传路径）');
  if (shopImgUrl && !/^\/(uploads|uploads-private)\/[\w\-.]+$/.test(String(shopImgUrl))) throw new Error('门店照片地址非法（须为站内上传路径）');
  name = String(name).trim();
  if (db.merchants.where((m) => m.name === name).length > 0) throw new Error('该名称已入驻，请更换名称');
  if (db.merchantApplications.where((a) => a.name === name && a.status === 'pending_review').length > 0) {
    throw new Error('该名称已有审核中的申请，请勿重复提交');
  }
  const app = db.merchantApplications.insert({
    name, contact, phone, category,
    address: String(address).slice(0, 200),
    licenseImgUrl, shopImgUrl: shopImgUrl || '',
    lat: toCoord(lat, -90, 90),
    lng: toCoord(lng, -180, 180),
    remark: String(remark || '').slice(0, 300),
    status: 'pending_review', // -> approved | rejected
    appliedAt: new Date().toISOString(),
  });
  audit(db, `merchant-apply:${name}`, 'merchant.entry_apply', { applicationId: app.id, category });
  return app;
}

/** 审核入驻申请：通过自动建档（返回初始 token，仅展示一次）；驳回须给原因 */
function reviewEntryApplication(db, { applicationId, approved, reason, operator }) {
  const a = db.merchantApplications.get(String(applicationId));
  if (!a) throw new Error('申请不存在');
  if (a.status !== 'pending_review') throw new Error('该申请已处理');
  if (!approved && !reason) throw new Error('驳回必须填写原因');
  if (approved && db.merchants.where((m) => m.name === a.name).length > 0) throw new Error('商家名称已存在，无法通过');
  a.status = approved ? 'approved' : 'rejected';
  a.reviewReason = reason || '';
  a.reviewedAt = new Date().toISOString();
  a.reviewedBy = operator || 'admin';
  let merchantRow = null;
  let initialPassword = null;
  if (approved) {
    // 建档时透传门店坐标与类目（附近商家功能数据源）
    const created = adminCreateMerchant(db, {
      name: a.name, contact: `${a.contact} ${a.phone}`,
      category: a.category, address: a.address, lat: a.lat, lng: a.lng,
      operator: operator || 'admin',
    });
    merchantRow = created.merchant;
    initialPassword = created.initialPassword;
    a.merchantId = merchantRow.id;
  }
  audit(db, operator || 'admin', approved ? 'merchant.entry_approved' : 'merchant.entry_rejected', {
    applicationId: a.id, name: a.name, reason: a.reviewReason, merchantId: a.merchantId || null,
  });
  return { application: a, merchant: merchantRow, initialPassword };
}

function listEntryApplications(db, status) {
  const list = [...db.merchantApplications.all()]
    .sort((x, y) => (x.appliedAt < y.appliedAt ? 1 : -1));
  return status ? list.filter((a) => a.status === status) : list;
}

/** 启用/停用商家：停用后登录与既有 token 全部失效（接口层拦截） */function adminSetMerchantStatus(db, { merchantId, status, operator = 'admin' }) {
  const m = db.merchants.get(merchantId);
  if (!m) throw new Error('商家不存在');
  if (!['active', 'disabled'].includes(status)) throw new Error('status 只能为 active/disabled');
  m.status = status;
  audit(db, operator, 'merchant.status', { merchantId, name: m.name, to: status });
  return m;
}

/** 重置商家 token：旧 token 立即失效，返回新 token（仅本次展示） */
function adminResetMerchantToken(db, { merchantId, operator = 'admin' }) {
  const m = db.merchants.get(merchantId);
  if (!m) throw new Error('商家不存在');
  m.token = crypto.randomBytes(24).toString('hex');
  audit(db, operator, 'merchant.reset_token', { merchantId, name: m.name });
  return m;
}

/** 商家管理列表（含收益余额与收款绑定状态） */
function adminListMerchants(db) {
  return db.merchants.all().map((m) => {
    const acc = db.earnings.get(m.id) || {};
    return {
      id: m.id, name: m.name, contact: m.contact, status: m.status,
      username: m.username || m.name,
      mustChangePassword: !!m.mustChangePassword,
      category: m.category || '', address: m.address || '',
      lat: m.lat == null ? null : m.lat, lng: m.lng == null ? null : m.lng,
      createdAt: m.createdAt, lastLoginAt: m.lastLoginAt || null,
      balanceFen: acc.balanceFen || 0,
      withdrawFrozenFen: acc.withdrawFrozenFen || 0,
      debtFen: acc.debtFen || 0,
      receiverBound: !!acc.receiverOpenid,
      receiverName: acc.receiverName || null,
      couponCount: db.coupons.where((c) => c.merchantId === m.id).length,
      adBookings: db.adBookings.where((b) => b.merchantId === m.id).length,
    };
  });
}

/**
 * 商家自助维护「门店主页」信息（V4.5）：门头照 / 营业时间 / 电话 / 地址坐标 / 一句话简介。
 *
 * 定位：平台做本地商家展示 + 到店导流，门店信息是用户"敢不敢来"的关键，
 * 因此必须由商家自己维护，而不是只能由平台后台代填。
 * 约束：
 * - 名称不可改（券归属、账单归属均按 merchantId，改名会引发对账与用户认知混乱，需后台改）；
 * - 门头照只接受本站已上传的公开图片路径，禁止外链（防挂马/防盗链/防私有目录泄露）；
 * - 坐标与地址同时更新（只改地址不改坐标会让"距离/导航"失真）。
 */
function updateShopProfile(db, {
  merchantId, coverUrl, intro, businessHours, phone, address, lat, lng, operator = 'merchant',
}) {
  const m = db.merchants.get(String(merchantId));
  if (!m) throw new Error('商家不存在');
  if (m.status === 'disabled') throw new Error('商家已被停用，请联系平台管理员');

  const patch = {};

  if (coverUrl !== undefined) {
    const u = String(coverUrl || '').trim();
    if (u && !/^\/uploads\/[A-Za-z0-9._-]+$/.test(u)) throw new Error('门头照地址不合法，请重新上传');
    patch.coverUrl = u;
  }

  if (intro !== undefined) {
    const s = String(intro || '').trim();
    if (s.length > 120) throw new Error('门店简介最多 120 字');
    patch.intro = s;
  }

  if (businessHours !== undefined) {
    const s = String(businessHours || '').trim();
    if (s && !/^([01]\d|2[0-3]):[0-5]\d\s*-\s*([01]\d|2[0-3]):[0-5]\d$/.test(s)) {
      throw new Error('营业时间格式应为 09:00-21:00');
    }
    if (s) {
      const [a, b] = s.split('-').map((x) => x.trim());
      if (a === b) throw new Error('营业开始与结束时间不能相同');
    }
    patch.businessHours = s;
  }

  if (phone !== undefined) {
    const s = String(phone || '').trim();
    if (s && !/^[0-9+\-\s()]{6,20}$/.test(s)) throw new Error('联系电话格式不正确');
    patch.phone = s;
  }

  if (address !== undefined) {
    const s = String(address || '').trim();
    if (s.length > 100) throw new Error('门店地址最多 100 字');
    patch.address = s;
  }

  if (lat !== undefined || lng !== undefined) {
    const la = toCoord(lat, -90, 90);
    const ln = toCoord(lng, -180, 180);
    if (la == null || ln == null) throw new Error('门店坐标不合法，请在地图上重新选点');
    patch.lat = la;
    patch.lng = ln;
  }

  if (!Object.keys(patch).length) throw new Error('没有需要更新的内容');
  patch.profileUpdatedAt = new Date().toISOString();
  db.merchants.update(m.id, patch);
  audit(db, operator, 'merchant.shop_update', {
    merchantId: m.id, fields: Object.keys(patch).filter((k) => k !== 'profileUpdatedAt'),
  });
  return db.merchants.get(m.id);
}

module.exports = { merchantLogin, merchantByToken, merchantChangePassword, updateShopProfile, issueCoupon, verifyCoupon, bookAdSlot, releaseExpiredAdSlots, adminCreateMerchant, adminResetMerchantPassword, adminSetMerchantStatus, adminResetMerchantToken, adminListMerchants, submitEntryApplication, reviewEntryApplication, listEntryApplications };
