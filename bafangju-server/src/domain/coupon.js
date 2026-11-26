'use strict';
/**
 * 异业联盟券闭环（V3.6）：发券 → 用户领券（一券一码）→ 到店核销 → 计服务费 → 方案 B 分佣。
 *
 * 合规与口径（对应 V3.3 §4.5 方案 B、§6.2 价目、§6.3 核销链路）：
 * - 券服务费 3%（满减/折扣券核销）、核销服务费 5%（次卡/服务核销），费率后台可配；
 * - 方案 B 分佣基数 = 服务费合计 − 联盟服务单运营成本；比例 平台10%/团队10%/直推70%/间推10%；
 * - 联盟服务单**不参与商品线阶梯进度、不产生排队队位、不产生分享贡献值**；
 * - 联盟线的平台份额（平台比例 + 间推关闭份额 + 未归属份额）记入平台留存，并按"交易服务费"划入储备专户。
 */
const { audit } = require('../store');
const commission = require('./commission');
const quarter = require('./quarter');
const bizdate = require('./bizdate');

const COUPON_TYPES = ['cash', 'discount', 'package'];

function nowISO() { return new Date().toISOString(); }

function makeClaimCode() {
  // 8 位数字：便于用户口头告知 / 商家手输，也够用（单码唯一性由 uniqueClaimCode 校验）
  return String(10000000 + Math.floor(Math.random() * 90000000));
}

function uniqueClaimCode(db) {
  for (let i = 0; i < 20; i++) {
    const code = makeClaimCode();
    if (db.couponClaims.where((c) => c.code === code).length === 0) return code;
  }
  throw new Error('核销码生成失败，请重试');
}

/** 券模板统计：领取数 / 已核销次数（次卡按次数累计，1 张 10 次卡核销 3 次记 3） */
function couponStats(db, couponId) {
  const claims = db.couponClaims.where((c) => c.couponId === couponId);
  const used = claims.reduce((s, c) => {
    // 旧数据无 usedTimes 字段：status=used 视为核销 1 次
    return s + (Number(c.usedTimes) || (c.status === 'used' ? 1 : 0));
  }, 0);
  return { claimed: claims.length, used };
}

/** 商家建券（满减 / 折扣 / 次卡）；次卡支持 totalTimes 多次核销（V4.6） */
function createCoupon(db, {
  merchantId, title, type = 'cash', amountOffFen, discountRate,
  minSpendFen = 0, totalQty, perUserLimit, validDays, validUntil, totalTimes,
}) {
  if (!db.merchants.get(String(merchantId))) throw new Error('商家不存在');
  if (!title || String(title).trim().length < 2) throw new Error('券名称必填（至少 2 字）');
  const t = COUPON_TYPES.includes(type) ? type : 'cash';
  const amount = Number(amountOffFen);
  const rate = Number(discountRate);
  if (t === 'cash' && (!Number.isInteger(amount) || amount <= 0)) throw new Error('满减金额必须为正整数分');
  if (t === 'discount' && (!(rate > 0 && rate < 1))) throw new Error('折扣率须在 0~1 之间（如 0.8 表示 8 折）');
  // 次卡次数：默认 1 = 单次服务兑换券；上限 99 防止误填成"无限次"
  let times = 1;
  if (t === 'package') {
    times = totalTimes == null || totalTimes === '' ? 1 : Number(totalTimes);
    if (!Number.isInteger(times) || times < 1 || times > 99) throw new Error('次卡可核销次数须为 1~99 的整数');
  }
  const min = Number(minSpendFen) || 0;
  if (!Number.isInteger(min) || min < 0) throw new Error('最低消费必须为非负整数分');
  const qty = totalQty == null || totalQty === '' ? null : Number(totalQty);
  if (qty !== null && (!Number.isInteger(qty) || qty <= 0)) throw new Error('发放总量必须为正整数');
  const limit = Number(perUserLimit) || Number(db.switches.get('couponPerUserLimit')) || 1;
  if (!Number.isInteger(limit) || limit <= 0) throw new Error('每人限领必须为正整数');
  const rawDays = Number(validDays) || Number(db.switches.get('couponDefaultValidDays')) || 30;
  const days = Math.max(1, Math.min(365, Math.round(rawDays)));
  const c = db.coupons.insert({
    merchantId: String(merchantId),
    title: String(title).trim().slice(0, 30),
    type: t,
    amountOffFen: t === 'cash' ? Math.round(amount) : 0,
    discountRate: t === 'discount' ? Number(rate.toFixed(4)) : 0,
    minSpendFen: Math.round(min),
    totalTimes: t === 'package' ? times : 1, // 次卡总次数；满减/折扣恒为 1
    totalQty: qty,
    perUserLimit: limit,
    validDays: days,
    validUntil: validUntil || null,
    status: 'valid', // valid | paused
    createdAt: nowISO(),
  });
  audit(db, `merchant:${merchantId}`, 'coupon.create', {
    couponId: c.id, title: c.title, type: t, minSpendFen: c.minSpendFen, totalTimes: c.totalTimes,
  });
  return c;
}

/** 商家券列表（带领取/核销统计） */
function listMerchantCoupons(db, merchantId) {
  return db.coupons.where((c) => c.merchantId === String(merchantId))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map((c) => ({ ...c, ...couponStats(db, c.id) }));
}

/**
 * 暂停/恢复发券（商家自助止损）：发错券可一键停发，已领取的券不受影响，仍可正常核销。
 * 停发只影响「用户端是否还能领」：listAvailableCoupons 与 claimCoupon 均校验 status==='valid'。
 */
function setCouponStatus(db, { merchantId, couponId, status, operator = 'merchant' }) {
  const c = db.coupons.get(String(couponId));
  if (!c) throw new Error('券不存在');
  if (String(c.merchantId) !== String(merchantId)) throw new Error('无权操作其他商家的券');
  if (!['valid', 'paused'].includes(status)) throw new Error('status 只能为 valid / paused');
  if (c.status === status) return c; // 幂等：重复点击不改状态、不重复记审计
  c.status = status;
  c.statusUpdatedAt = nowISO();
  // 审计动作用纯字面量分支：审计元数据扫描器（audit-meta.test）才能正确提取动作名，
  // 三元表达式会把 'paused' 这种普通字符串误当成审计动作。
  const detail = { couponId: c.id, merchantId: c.merchantId, title: c.title };
  if (status === 'paused') audit(db, String(operator), 'coupon.pause', detail);
  else audit(db, String(operator), 'coupon.resume', detail);
  return c;
}

/** 用户可领取的券（有效、有库存、未超限领） */
function listAvailableCoupons(db, { userId, merchantId } = {}) {
  const now = Date.now();
  const out = [];
  for (const c of db.coupons.all()) {
    if (c.status !== 'valid') continue;
    if (merchantId && String(c.merchantId) !== String(merchantId)) continue;
    if (c.validUntil && new Date(c.validUntil).getTime() < now) continue;
    const stats = couponStats(db, c.id);
    if (c.totalQty != null && stats.claimed >= c.totalQty) continue;
    let claimedByMe = 0;
    if (userId) claimedByMe = db.couponClaims.where((x) => x.couponId === c.id && x.userId === String(userId)).length;
    const limit = Number(c.perUserLimit) || 1;
    out.push({
      ...c,
      merchantName: (db.merchants.get(c.merchantId) || {}).name || '',
      remain: c.totalQty == null ? null : Math.max(0, c.totalQty - stats.claimed),
      claimedByMe,
      claimable: claimedByMe < limit,
    });
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** 领券：生成 8 位核销码，一券一码 */
function claimCoupon(db, { couponId, userId }) {
  const coupon = db.coupons.get(String(couponId));
  if (!coupon) throw new Error('券不存在');
  if (coupon.status !== 'valid') throw new Error('该券已停止发放');
  const now = Date.now();
  if (coupon.validUntil && new Date(coupon.validUntil).getTime() < now) throw new Error('该券已过期');
  const stats = couponStats(db, coupon.id);
  if (coupon.totalQty != null && stats.claimed >= coupon.totalQty) throw new Error('该券已领完');
  const uid = String(userId);
  const mine = db.couponClaims.where((x) => x.couponId === coupon.id && x.userId === uid);
  const limit = Number(coupon.perUserLimit) || 1;
  if (mine.length >= limit) throw new Error(`你已领取过该券（每人限领 ${limit} 张）`);
  const days = Number(coupon.validDays) || 30;
  const byDays = now + days * 86400000;
  const byCoupon = coupon.validUntil ? new Date(coupon.validUntil).getTime() : Infinity;
  const claim = db.couponClaims.insert({
    couponId: coupon.id,
    merchantId: coupon.merchantId,
    userId: uid,
    code: uniqueClaimCode(db),
    status: 'unused', // unused → using（次卡部分核销）→ used；expired
    // 次卡次数快照到券码：商家改券不影响已领取的券
    totalTimes: Math.max(1, Number(coupon.totalTimes) || 1),
    usedTimes: 0,
    claimedAt: nowISO(),
    expiresAt: new Date(Math.min(byDays, byCoupon)).toISOString(),
  });
  audit(db, `user:${uid}`, 'coupon.claim', { claimId: claim.id, couponId: coupon.id });
  return claim;
}

/** 我的券（含过期判定） */
function listUserCoupons(db, userId) {
  const uid = String(userId);
  const now = Date.now();
  return db.couponClaims.where((c) => c.userId === uid)
    .sort((a, b) => (a.claimedAt < b.claimedAt ? 1 : -1))
    .map((c) => {
      const coupon = db.coupons.get(c.couponId) || {};
      const m = db.merchants.get(c.merchantId) || {};
      // 次卡部分核销（using）同样会过期；旧数据无 totalTimes 视为 1
      const totalTimes = Math.max(1, Number(c.totalTimes) || Number(coupon.totalTimes) || 1);
      const usedTimes = Math.max(0, Number(c.usedTimes) || 0);
      const expired = (c.status === 'unused' || c.status === 'using')
        && c.expiresAt && new Date(c.expiresAt).getTime() < now;
      const exhausted = c.status === 'used' || usedTimes >= totalTimes;
      return {
        ...c,
        totalTimes,
        usedTimes,
        remainingTimes: Math.max(0, totalTimes - usedTimes),
        status: expired ? 'expired' : (exhausted ? 'used' : c.status),
        merchantName: m.name || '',
        // 到店消费导向：带上门店位置，用户可直接导航（V4.4）
        merchantAddress: m.address || '',
        merchantLat: m.lat == null ? null : m.lat,
        merchantLng: m.lng == null ? null : m.lng,
        coupon: {
          title: coupon.title || '联盟券',
          type: coupon.type || 'cash',
          amountOffFen: coupon.amountOffFen || 0,
          discountRate: coupon.discountRate || 0,
          minSpendFen: coupon.minSpendFen || 0,
          totalTimes,
        },
      };
    });
}

/**
 * 券面优惠计算（纯函数）：消费总额（券前）→ 优惠金额 / 消费者应付。
 * - cash 满减：优惠 = min(券面金额, 消费总额)，应付 = 总额 − 优惠；
 * - discount 折扣：应付 = 总额 × 折扣率（四舍五入到分），优惠 = 总额 − 应付；
 * - package 次卡/服务：无固定减免额度，由商家按套餐价线下收取，优惠计 0。
 * 口径：核销填写的 amountFen 一律是**券前消费总额**，服务费也按该总额计提（与最低消费校验一致）。
 */
function discountOf(coupon, amountFen) {
  const amount = Math.max(0, Math.floor(Number(amountFen) || 0));
  if (coupon.type === 'discount') {
    const rate = Number(coupon.discountRate);
    if (!(rate > 0 && rate < 1)) throw new Error('券折扣率配置异常，请联系平台');
    const payable = Math.round(amount * rate);
    return { discountFen: amount - payable, payableFen: payable };
  }
  if (coupon.type === 'package') {
    return { discountFen: 0, payableFen: amount };
  }
  const off = Math.min(amount, Math.max(0, Number(coupon.amountOffFen) || 0));
  return { discountFen: off, payableFen: amount - off };
}

/**
 * 到店核销（商家）：校验核销码 → 计服务费 → 生成联盟服务单 → 方案 B 分佣 → 挂服务费应收单。
 * @param {number} amountFen 本次**券前消费总额**（整数分）；服务费与最低消费均按此口径
 *
 * 资金口径（V4.4 修正）：
 * - 消费者只在线下向商家付「应付 = 总额 − 券优惠」，平台不碰货款；
 * - 服务费在核销时**挂应收单**（merchantFeeBills.status='due'），后台确认收款后才
 *   写平台留存流水并划入储备专户 —— 避免"账面有储备、银行没进钱"的账实背离；
 * - 联盟分佣同步冻结，服务费未收前不解冻（见 commission.settleDue）。
 */
function redeemCoupon(db, { code, merchantId, amountFen, operator = 'merchant' }) {
  const c = String(code || '').trim();
  if (!c) throw new Error('请输入核销码');
  const claim = db.couponClaims.where((x) => x.code === c)[0];
  if (!claim) throw new Error('核销码不存在（请确认是用户出示的 8 位券码）');
  if (merchantId != null && claim.merchantId !== String(merchantId)) throw new Error('该券不属于本店');
  // 次数管理（V4.6）：次卡按次数多次核销；旧数据无 totalTimes 视为 1（单次券）
  const totalTimes = Math.max(1, Number(claim.totalTimes) || 1);
  const usedTimes = Math.max(0, Number(claim.usedTimes) || 0);
  if (claim.status === 'used' || usedTimes >= totalTimes) {
    throw new Error(totalTimes > 1 ? `该次卡次数已用完（${usedTimes}/${totalTimes}）` : '该券已核销');
  }
  if (claim.status === 'expired') throw new Error('该券已过期');
  if (claim.expiresAt && new Date(claim.expiresAt).getTime() < Date.now()) {
    db.couponClaims.update(claim.id, { status: 'expired' });
    throw new Error('该券已过期（有效期至 ' + String(claim.expiresAt).slice(0, 10) + '）');
  }
  const coupon = db.coupons.get(claim.couponId);
  if (!coupon) throw new Error('券模板不存在');
  const amount = Number(amountFen);
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('请填写本次消费总额（券前金额，整数分）');
  const min = Number(coupon.minSpendFen) || 0;
  if (amount < min) throw new Error(`未达到最低消费 ${(min / 100).toFixed(2)} 元（当前券前总额 ${(amount / 100).toFixed(2)} 元）`);
  const { discountFen, payableFen } = discountOf(coupon, amount);

  // 服务费：券类（满减/折扣）3%，次卡/服务 5%（费率后台可配）
  const isPackage = coupon.type === 'package';
  const couponRate = Number(db.switches.get('couponServiceFeeRate')) || 0;
  const verifyRate = Number(db.switches.get('verificationServiceFeeRate')) || 0;
  const couponFee = isPackage ? 0 : Math.round(amount * couponRate);
  const verifyFee = isPackage ? Math.round(amount * verifyRate) : 0;
  const grossFee = couponFee + verifyFee;
  const opCost = Math.max(0, Number(db.switches.get('allianceOpCostFen')) || 0);
  const baseFen = Math.max(0, grossFee - opCost);

  const alliance = db.allianceOrders.insert({
    claimId: claim.id,
    couponId: coupon.id,
    merchantId: claim.merchantId,
    userId: claim.userId,
    type: coupon.type || 'cash',
    amountFen: amount, // 券前消费总额
    discountFen,       // 券面优惠（商家线下直接让利）
    payableFen,        // 消费者线下应付
    // 次卡：本次是第几次核销 / 总次数（单次券 1/1）
    redeemIndex: usedTimes + 1,
    totalTimes,
    couponServiceFeeFen: couponFee,
    verifyServiceFeeFen: verifyFee,
    opCostFen: opCost,
    baseFen,
    commissionFen: 0,
    // free = 平台未收费（默认）；due -> paid = 收费模式下的应收/已收
    feeStatus: grossFee > 0 ? 'due' : 'free',
    status: 'settled',
    createdAt: nowISO(),
  });
  // 次数管理：次卡未用完 → using（可继续核销）；用完/单次券 → used（终态）
  const newUsedTimes = usedTimes + 1;
  const claimPatch = { usedTimes: newUsedTimes };
  if (totalTimes > 1 && newUsedTimes < totalTimes) {
    claimPatch.status = 'using';
  } else {
    claimPatch.status = 'used';
    claimPatch.usedAt = nowISO();
    claimPatch.allianceOrderId = alliance.id; // 终态指向最后一次核销单
  }
  db.couponClaims.update(claim.id, claimPatch);

  let platformShare = 0;
  if (baseFen > 0) {
    const plan = db.switches.get('commissionPlanB') || { platform: 0.10, leader: 0.10, direct: 0.70, indirect: 0.10 };
    const booked = commission.bookCommission(db, {
      orderId: `alliance:${alliance.id}`,
      baseFen,
      plan,
      indirectEnabled: db.switches.get('indirectReferralEnabled') === true,
      directUserId: (db.users.get(claim.userId) || {}).directUserId || null,
      indirectUserId: null,
      leaderUserId: null,
    });
    // 联盟线平台份额 = 平台比例 + 间推关闭份额 + 未归属份额（无推广人/无团队长）
    // 注意：不进商品线排队分红池（联盟线不产生队位）；也不在核销时划储备，
    // 而是记入应收单，后台确认收款后再入 platformFlows + 储备专户（V4.4 账实一致）
    platformShare = booked.toPoolFen + booked.unattributedFen;
    db.allianceOrders.update(alliance.id, { commissionFen: baseFen - platformShare });
  }

  // 服务费应收单：仅在**实际产生服务费**时挂账。
  // 默认免费模式（费率 0）下不写任何应收单 —— 商家不会凭空多出一笔"欠费"。
  const bill = grossFee > 0 ? db.merchantFeeBills.insert({
    merchantId: claim.merchantId,
    allianceOrderId: alliance.id,
    month: bizdate.monthOfIso(nowISO()), // 账单归属月（北京时间）
    amountFen: amount,
    grossFeeFen: grossFee,
    platformShareFen: platformShare,
    commissionFen: Math.max(0, baseFen - platformShare),
    status: 'due', // due -> paid
    receivedFen: 0,
    method: '',
    note: '',
    createdAt: nowISO(),
  }) : null;

  audit(db, operator, 'coupon.redeem', {
    allianceId: alliance.id, claimId: claim.id, amountFen: amount, discountFen, payableFen,
    couponFee, verifyFee, baseFen, feeBillId: bill ? bill.id : null,
    usedTimes: newUsedTimes, totalTimes,
  });
  return {
    alliance: db.allianceOrders.get(alliance.id),
    claim: db.couponClaims.get(claim.id),
    couponFeeFen: couponFee,
    verifyFeeFen: verifyFee,
    grossFeeFen: grossFee,
    baseFen,
    platformShareFen: platformShare,
    discountFen,
    payableFen,
    feeBillId: bill ? bill.id : null,
    feeCharged: grossFee > 0,
    // 次卡：本次核销后剩余次数；单次券恒为 0
    remainingTimes: Math.max(0, totalTimes - newUsedTimes),
    totalTimes,
  };
}

/** 核销前查券（不产生任何副作用）：给商家端展示券面 + 判断可用性（含次卡剩余次数） */
function lookupCoupon(db, { code, merchantId }) {
  const c = String(code || '').trim();
  if (!c) throw new Error('请输入核销码');
  const claim = db.couponClaims.where((x) => x.code === c)[0];
  if (!claim) throw new Error('核销码不存在（请确认是用户出示的 8 位券码）');
  if (merchantId != null && claim.merchantId !== String(merchantId)) throw new Error('该券不属于本店');
  const coupon = db.coupons.get(claim.couponId) || {};
  const totalTimes = Math.max(1, Number(claim.totalTimes) || Number(coupon.totalTimes) || 1);
  const usedTimes = Math.max(0, Number(claim.usedTimes) || 0);
  const remainingTimes = Math.max(0, totalTimes - usedTimes);
  const expired = claim.status === 'expired'
    || ((claim.status === 'unused' || claim.status === 'using')
      && claim.expiresAt && new Date(claim.expiresAt).getTime() < Date.now());
  const exhausted = claim.status === 'used' || remainingTimes === 0;
  const status = expired ? 'expired' : (exhausted ? 'used' : claim.status);
  return {
    claimId: claim.id,
    code: claim.code,
    status, // unused | using | used | expired
    usable: status === 'unused' || status === 'using',
    totalTimes,
    usedTimes,
    remainingTimes,
    expiresAt: claim.expiresAt || null,
    usedAt: claim.usedAt || null,
    coupon: {
      title: coupon.title || '联盟券',
      type: coupon.type || 'cash',
      amountOffFen: coupon.amountOffFen || 0,
      discountRate: coupon.discountRate || 0,
      minSpendFen: coupon.minSpendFen || 0,
      totalTimes,
    },
  };
}

/** 服务费应收单筛选 */
function feeBillRows(db, { merchantId, month, status } = {}) {
  return db.merchantFeeBills.all()
    .filter((b) => (!merchantId || b.merchantId === String(merchantId))
      && (!month || b.month === month)
      && (!status || b.status === status))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** 账单列表（带商家名/券名，供商家端与后台展示） */
function listFeeBills(db, { merchantId, month, status, limit = 200 } = {}) {
  return feeBillRows(db, { merchantId, month, status }).slice(0, limit).map((b) => {
    const m = db.merchants.get(b.merchantId) || {};
    const a = db.allianceOrders.get(b.allianceOrderId) || {};
    const coupon = db.coupons.get(a.couponId) || {};
    return { ...b, merchantName: m.name || '', couponTitle: coupon.title || '', userId: a.userId || '' };
  });
}

/** 账单汇总：应缴 / 已缴 / 笔数 */
function feeBillSummary(db, { merchantId, month } = {}) {
  const rows = feeBillRows(db, { merchantId, month });
  const sum = (arr, key) => arr.reduce((s, x) => s + (x[key] || 0), 0);
  const due = rows.filter((b) => b.status === 'due');
  const paid = rows.filter((b) => b.status === 'paid');
  return {
    count: rows.length,
    dueCount: due.length,
    paidCount: paid.length,
    dueFen: sum(due, 'grossFeeFen'),
    paidFen: sum(paid, 'receivedFen'),
    grossFen: sum(rows, 'grossFeeFen'),
  };
}

/**
 * 确认服务费已收（后台）：应收单 due -> paid，此时才写平台留存并划入储备专户。
 * 幂等：已收单重复调用直接返回；部分收款按实收金额确认，平台份额不超过实收。
 */
function markFeeBillPaid(db, { billId, receivedFen, method = 'offline', note = '', operator = 'admin' }) {
  const bill = db.merchantFeeBills.get(String(billId));
  if (!bill) throw new Error('服务费账单不存在');
  if (bill.status === 'paid') return { bill, replay: true };
  if (bill.status !== 'due') throw new Error('账单状态不可确认收款');
  const received = receivedFen == null ? bill.grossFeeFen : Number(receivedFen);
  if (!Number.isInteger(received) || received <= 0) throw new Error('实收金额须为正整数分');
  if (received > bill.grossFeeFen) throw new Error('实收金额不能超过应缴金额');
  const recognized = Math.min(received, bill.grossFeeFen);
  // 平台份额与分佣份额都从服务费里出：实收不足时优先保平台份额，剩余由平台承担（差额留痕）
  const platformPart = Math.min(bill.platformShareFen || 0, recognized);
  if (recognized > 0) {
    db.platformFlows.insert({ direction: 'in', type: 'alliance_service_fee', orderId: bill.allianceOrderId, fen: recognized, ts: nowISO() });
    if (platformPart > 0) {
      quarter.reserveDeposit(db, { source: 'trade_service_fee', fen: platformPart, ref: `alliance:${bill.allianceOrderId}` });
    }
  }
  const updated = db.merchantFeeBills.update(bill.id, {
    status: 'paid',
    receivedFen: recognized,
    shortageFen: Math.max(0, bill.grossFeeFen - recognized),
    method: String(method || 'offline').slice(0, 20),
    note: String(note || '').slice(0, 200),
    paidAt: nowISO(),
    paidBy: operator,
  });
  if (bill.allianceOrderId) db.allianceOrders.update(bill.allianceOrderId, { feeStatus: 'paid' });
  audit(db, operator, 'merchant_fee.paid', {
    billId: bill.id, merchantId: bill.merchantId, grossFeeFen: bill.grossFeeFen, receivedFen: recognized, method,
  });
  return { bill: updated, replay: false };
}

/** 按月批量确认收款（后台月度对账用）：该商家当月所有待收单一并确认 */
function markFeeBillsPaidByMonth(db, { merchantId, month, method = 'offline', note = '', operator = 'admin' }) {
  if (!merchantId) throw new Error('请指定商家');
  const m = month || bizdate.monthOf();
  const due = feeBillRows(db, { merchantId, month: m, status: 'due' });
  let paidCount = 0;
  let receivedFen = 0;
  for (const b of due) {
    const r = markFeeBillPaid(db, { billId: b.id, method, note, operator });
    if (!r.replay) { paidCount += 1; receivedFen += r.bill.receivedFen || 0; }
  }
  return { month: m, merchantId: String(merchantId), paidCount, receivedFen, dueFen: receivedFen };
}

/** 联盟服务单列表（商家端/后台） */
function listAllianceOrders(db, { merchantId, month, limit = 100 } = {}) {
  return db.allianceOrders.all()
    .filter((a) => !merchantId || a.merchantId === String(merchantId))
    .filter((a) => !month || bizdate.monthOfIso(a.createdAt) === month)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, limit)
    .map((a) => {
      const m = db.merchants.get(a.merchantId) || {};
      const coupon = db.coupons.get(a.couponId) || {};
      return { ...a, merchantName: m.name || '', couponTitle: coupon.title || '' };
    });
}

/** 服务费汇总（按月），用于结算单/对账 */
function serviceFeeSummary(db, { merchantId, month } = {}) {
  const inMonth = (ts) => !month || bizdate.monthOfIso(ts) === month;
  const rows = db.allianceOrders.where((a) => (!merchantId || a.merchantId === String(merchantId)) && inMonth(a.createdAt));
  const sum = (key) => rows.reduce((s, a) => s + (a[key] || 0), 0);
  return {
    count: rows.length,
    amountFen: sum('amountFen'),
    couponServiceFeeFen: sum('couponServiceFeeFen'),
    verifyServiceFeeFen: sum('verifyServiceFeeFen'),
    baseFen: sum('baseFen'),
    commissionFen: sum('commissionFen'),
  };
}

module.exports = {
  COUPON_TYPES,
  couponStats,
  createCoupon,
  setCouponStatus,
  listMerchantCoupons,
  listAvailableCoupons,
  claimCoupon,
  listUserCoupons,
  discountOf,
  redeemCoupon,
  lookupCoupon,
  listFeeBills,
  feeBillSummary,
  markFeeBillPaid,
  markFeeBillsPaidByMonth,
  listAllianceOrders,
  serviceFeeSummary,
};
