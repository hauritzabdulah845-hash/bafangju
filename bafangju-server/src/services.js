'use strict';
/**
 * 业务编排层：订单（含免单）/复购进度/退款/周期与队位/贡献值/任务。
 * 合规要点见各方法注释；全部资金操作走幂等键 + 审计。
 */
const ladder = require('./domain/ladder');
const userAccount = require('./domain/userAccount');
const { yuanToFen } = require('./domain/money');
const commission = require('./domain/commission');
const dividend = require('./domain/dividend');
const fulfillment = require('./domain/fulfillment');
const level = require('./domain/level');
const risk = require('./domain/risk');
const bizdate = require('./domain/bizdate');
const { audit } = require('./store');

/** 计算用户在某类目的当前步位（1..n+4），周期完成后回 1 */
function currentStep(db, userId, categoryId) {
  const p = db.progress.get(`${String(userId)}:${categoryId}`);
  if (!p) return { step: 1, done: 0, periodId: null };
  // 旧模型遗留：已领取免单的周期视为已收口，从第 1 步开新周期
  if (p.status === 'free_claimed') return { step: 1, done: 0, periodId: p.periodId };
  const total = (p.n || 0) + ladder.REBATE_RATES.length; // 周期总单数 = 全价段 m + 让利段 4
  return { step: Math.min(p.done + 1, total), done: p.done, periodId: p.periodId, n: p.n, total, status: p.status };
}

function ensureProgress(db, userId, category, n) {
  const key = `${String(userId)}:${category.id}`;
  let p = db.progress.get(key);
  if (!p) {
    p = db.progress.insert({ id: key, userId, categoryId: category.id, done: 0, n, status: 'accumulating', periodId: null });
  }
  return p;
}

/**
 * 创建订单（预占步位，15 分钟未支付自动释放由外部定时任务调用 releaseOrder）。
 * 返回应付金额（分）；步位范围 1..m+4（全价段 m 单 + 让利段 4 单），无免单步位。
 */
function createOrder(db, { userId, productId, addressId, idempotencyKey, directUserId, indirectUserId, leaderUserId }) {
  const { value: order, replay } = db.idempotency.run(`create:${idempotencyKey}`, () => {
    const product = db.products.get(productId);
    if (!product || product.status !== 'on_sale') throw new Error('商品不可售');
    const category = db.categories.get(product.categoryId);
    if (!category) throw new Error('类目不存在');
    // 收货信息：快递到家商品必须选择地址簿地址（订单快照固化，后续改地址不追溯）
    let receiver = null;
    if ((product.deliveryType || 'express') === 'express') {
      if (!addressId) throw new Error('请先选择收货地址');
      receiver = userAccount.resolveReceiver(db, userId, addressId);
    }
    const n = ladder.stepCount(category.r); // 全价段单数 m
    const { step } = currentStep(db, userId, category.id);
    const paidFen = ladder.priceAtStep(product.priceFen, n, step);
    // ===== 成本项与分佣基数系数快照（V3.4 财务修正）=====
    // 税费/通道费按实付比例、运营成本按分/单；缺配置时取系统默认，避免"漏配即超发"
    const taxFeeRate = Number.isFinite(product.taxFeeRate) ? product.taxFeeRate : Number(db.switches.get('defaultTaxFeeRate') || 0);
    const opCostFen = Number.isInteger(product.opCostFen) ? product.opCostFen : Number(db.switches.get('defaultOpCostFen') || 0);
    const costFen = product.costFen || 0;
    const taxAndFeeFen = Math.round(paidFen * (Number.isFinite(taxFeeRate) ? taxFeeRate : 0));
    const allocFen = paidFen - costFen - taxAndFeeFen - opCostFen;
    // 周期系数：把"免单那张负单"的成本摊回本周期每一单，使分佣总额不超过周期真实可分配收益
    const econ = ladder.cycleEconomics({ priceFen: product.priceFen, n, costFen, taxFeeRate: Number.isFinite(taxFeeRate) ? taxFeeRate : 0, opCostFen });
    const retainRate = Math.min(0.9, Math.max(0, Number(db.switches.get('commissionPlatformRetainRate') ?? 0) || 0));
    const commissionFactor = econ.factor * (1 - retainRate);
    const snap = ladder.makeSnapshot({ productId, categoryId: category.id, priceYuan: product.priceFen / 100, r: category.r });
    snap.step = step;
    snap.paidFen = paidFen;
    snap.allocFen = allocFen;
    snap.commissionFactor = commissionFactor;
    db.snapshots.insert(snap);
    const order = db.orders.insert({
      userId, productId, categoryId: category.id,
      payType: 'WX_PAY',
      status: 'pending_pay', // pending_pay -> paid -> shipped -> done | refunded | cancelled
      priceFen: product.priceFen,
      paidFen,
      step,
      snapshotId: snap.id,
      periodId: null,
      // 直推归属：显式传参优先，否则取用户绑定的邀请关系（一次性绑定不可更改）
      directUserId: directUserId || (db.users.get(userId) || {}).directUserId || null,
      indirectUserId: indirectUserId || null,
      leaderUserId: leaderUserId || null, // 距订单最近的在册团队长（下单时归属，V3.3 §4.8-11）
      // 成本快照（下单时点）：分佣基数 = 实付 - 成本 - 税费通道费 - 运营成本，防成本变动追溯
      costFen,
      taxFeeRate: Number.isFinite(taxFeeRate) ? taxFeeRate : 0,
      taxAndFeeFen,
      opCostFen,
      allocFen,
      commissionFactor,
      deliveryType: product.deliveryType || 'express',
      // 履约归属：商品归属商家（平台自营为 null）；到店订单生成 6 位核销码
      merchantId: product.merchantId || null,
      verifyCode: (product.deliveryType || 'express') === 'store' ? fulfillment.makeVerifyCode() : null,
      ...(receiver || {}), // 收货人快照（express 时必有）
      createdAt: new Date().toISOString(),
      expireAt: Date.now() + 15 * 60 * 1000,
    });
    return order;
  });
  return { order, replay };
}

/** 释放超时未支付订单（归还步位由"计数仅在支付后累计"保证，无需显式回退） */
function releaseOrder(db, orderId) {
  const order = db.orders.get(orderId);
  if (order && order.status === 'pending_pay' && Date.now() > order.expireAt) {
    db.orders.update(orderId, { status: 'cancelled' });
    audit(db, 'system', 'order.release', { orderId });
  }
}

/**
 * 支付成功回调（WX_PAY 订单）：幂等；计入本人类目进度；分佣记账入池。
 */
function onPaid(db, { orderId, wxTransactionId }) {
  const { value, replay } = db.idempotency.run(`paid:${orderId}`, () => {
    const order = db.orders.get(orderId);
    if (!order) throw new Error('订单不存在');
    if (order.payType !== 'WX_PAY') throw new Error('订单状态不可支付');
    db.orders.update(orderId, { status: 'paid', wxTransactionId, paidAt: new Date().toISOString() });
    const category = db.categories.get(order.categoryId);
    const n = ladder.stepCount(category.r);
    const p = ensureProgress(db, order.userId, category, n);
    p.done += 1;
    p.n = n;
    db.orders.update(orderId, { periodId: p.id });
    audit(db, 'system', 'order.paid', { orderId, paidFen: order.paidFen, step: order.step });

    // ===== 分佣记账 =====
    // 基数 = 本单可分配收益 × 周期系数，且不超过"本周期累计可分配收益 − 已计提基数"的余额。
    // 这样偶发负单（成本/税费高于让利价时）会被真实冲减，分佣总额永远不超过周期赚到的钱。
    const allocFen = Number.isInteger(order.allocFen)
      ? order.allocFen
      : order.paidFen - (order.costFen || 0) - (order.taxAndFeeFen || 0) - (order.opCostFen || 0);
    const factor = Number.isFinite(order.commissionFactor) ? Math.max(0, Math.min(1, order.commissionFactor)) : 1;
    p.cycleAllocFen = (p.cycleAllocFen || 0) + allocFen;
    let baseFen = Math.floor(Math.max(0, allocFen) * factor);
    const headroom = Math.max(0, p.cycleAllocFen - (p.cycleBaseFen || 0));
    if (baseFen > headroom) baseFen = headroom; // 硬封顶：本周期已计提分佣不超过已赚到的钱
    const plan = db.switches.get('commissionPlanA');
    const booked = commission.bookCommission(db, {
      orderId, baseFen, plan,
      indirectEnabled: db.switches.get('indirectReferralEnabled') === true,
      directUserId: order.directUserId || null,
      indirectUserId: order.indirectUserId || null,
      leaderUserId: order.leaderUserId || null, // 团队长份额入持久化辅导分红池
    });
    p.cycleBaseFen = (p.cycleBaseFen || 0) + (booked.record.baseFen || 0);
    // 平台实收（服务费 + 间推关闭份额）进入排队分红池
    if (booked.toPoolFen > 0) db.dividendPoolFlows.insert({ direction: 'in', orderId, fen: booked.toPoolFen, ts: new Date().toISOString() });
    // 无归属份额（无推广人的直推份额 / 无团队长的辅导份额）归平台留存，账上留痕
    if (booked.unattributedFen > 0) {
      db.platformFlows.insert({ direction: 'in', type: 'unattributed_commission', orderId, fen: booked.unattributedFen, ts: new Date().toISOString() });
    }

    // ===== 周期收口：第 m+4 单（最后一单让利单）支付完成后，进度归零、发放队位 =====
    const total = n + ladder.REBATE_RATES.length;
    if (p.done >= total) {
      // 周期留存 = 周期可分配收益 − 已计提分佣基数（平台真实留存），落流水供对账
      const retainFen = Math.max(0, p.cycleAllocFen - (p.cycleBaseFen || 0));
      if (retainFen > 0) {
        db.platformFlows.insert({ direction: 'in', type: 'cycle_retain', orderId, fen: retainFen, ts: new Date().toISOString() });
      }
      const slot = dividend.grantQueueSlot(db, order.userId, p.id);
      const queued = db.queueSlots.where((s) => ['waiting', 'skipped'].includes(s.status)).length;
      db.messages.insert({ userId: order.userId, type: 'cycle_completed', title: '一轮购买完成', body: `恭喜！这一轮 ${total} 单全部买完了（最后 4 单已便宜 10%~40%），还获得 1 个分红排队号。下一单开始新一轮。`, ts: new Date().toISOString(), read: false });
      db.messages.insert({ userId: order.userId, type: 'queue_granted', title: '获得 1 个分红排队号', body: `排队号已生效，当前全场第 ${queued} 位。分红按大家完成轮次的先后发放；池内余额不足时会留到后面再发，排队号不会作废。`, ts: new Date().toISOString(), read: false });
      audit(db, 'system', 'order.cycle_completed', { orderId, userId: order.userId, slotId: slot.id, total });
      // 新周期重新累计
      p.done = 0;
      p.cycleAllocFen = 0;
      p.cycleBaseFen = 0;
      p.periodCount = (p.periodCount || 0) + 1;
    }
    return { orderId, step: order.step };
  });
  return { value, replay };
}

/**
 * 退款（V3.3 §4.7）：
 * - 按实付原路退；退款单移出进度（done-1），仅影响其后未发生步位；
 * - 分佣按单独立回滚、分红池入账同步回滚；周期不做事后重算；
 * - 旧模型遗留的免单订单（payType=FREE）默认不支持退款（开关开启时：周期作废、进度清零、队位收回、已发分红扣回走财务流程）。
 */
function refundOrder(db, { orderId, operator = 'system' }) {
  const order = db.orders.get(orderId);
  if (!order) throw new Error('订单不存在');
  if (order.payType === 'FREE') {
    if (db.switches.get('freeOrderRefundEnabled') !== true) {
      throw new Error('免单订单默认不支持退款');
    }
    const p = db.progress.get(order.periodId);
    if (p) { p.status = 'voided'; p.done = 0; p.cycleAllocFen = 0; p.cycleBaseFen = 0; }
    const revoked = dividend.revokeSlotsByPeriod(db, order.periodId);
    if (revoked.paidFen > 0) {
      // §4.7-3 / §4.12-3：已发放分红从后续收益扣回（先扣分红余额，再扣可用余额，不足挂账并限制提现）
      const acc = db.earnings.get(order.userId);
      if (acc) {
        let left = revoked.paidFen;
        const fromDiv = Math.min(acc.dividendBalanceFen || 0, left);
        acc.dividendBalanceFen = (acc.dividendBalanceFen || 0) - fromDiv; left -= fromDiv;
        const fromBal = Math.min(acc.balanceFen || 0, left);
        acc.balanceFen = (acc.balanceFen || 0) - fromBal; left -= fromBal;
        if (left > 0) { acc.debtFen = (acc.debtFen || 0) + left; acc.withdrawBlocked = true; }
      }
      db.dividendPoolFlows.insert({ direction: 'in', fen: revoked.paidFen, ref: 'dividend_clawback', orderId, ts: new Date().toISOString() });
      audit(db, operator, 'dividend.clawback', { userId: order.userId, orderId, fen: revoked.paidFen });
    }
    db.orders.update(orderId, { status: 'refunded' });
    audit(db, operator, 'order.refund_free', { orderId, periodVoided: true, revokedSlots: revoked.slots, clawedBackFen: revoked.paidFen });
    return { ok: true, kind: 'free_void_period', revokedSlots: revoked.slots, clawedBackFen: revoked.paidFen };
  }
  if (!['paid', 'shipped', 'done'].includes(order.status)) throw new Error('订单状态不可退款');
  // S4：微信退款仍在处理中时，不得提前落退款完成态、不回滚分佣/分红（等终态后再执行本函数）
  if (order.refundStatus === 'PROCESSING') {
    throw new Error('微信退款处理中，尚未到账；请待退款结果返回后再完成本地退款入账');
  }
  db.orders.update(orderId, { status: 'refunded' });
  // 进度回退：仅移出该单计数（其后未发生步位自然顺延；已过售后期的低价单不追差）
  const p = db.progress.get(order.periodId);
  if (p && p.done > 0) p.done -= 1;
  // 周期口径同步回退：把该单的可分配收益与已计提基数从"进行中周期"扣回（已收口的周期不动）
  if (p && p.status === 'accumulating') {
    if (Number.isInteger(order.allocFen)) p.cycleAllocFen = (p.cycleAllocFen || 0) - order.allocFen;
    const rec = db.commissionRecords.where((r) => r.orderId === orderId)[0];
    if (rec && Number.isInteger(rec.baseFen)) p.cycleBaseFen = Math.max(0, (p.cycleBaseFen || 0) - rec.baseFen);
  }
  // 分佣与分红池按单回滚
  const rb = commission.rollbackOrder(db, orderId);
  // 无归属份额（已计入平台留存）按单回滚
  if (rb && rb.unattributedFen > 0) {
    db.platformFlows.insert({ direction: 'out', type: 'unattributed_rollback', orderId, fen: rb.unattributedFen, ts: new Date().toISOString() });
  }
  const flow = db.dividendPoolFlows.where((f) => f.orderId === orderId && f.direction === 'in' && !f.rolledBack)[0];
  if (flow) {
    db.dividendPoolFlows.update(flow.id, { rolledBack: true });
    db.dividendPoolFlows.insert({ direction: 'out', orderId, fen: flow.fen, ref: 'refund_rollback', ts: new Date().toISOString() });
  }
  // 团队长辅导池按单回滚（归属份额退池）
  const lflow = db.leaderPoolFlows.where((f) => f.orderId === orderId && f.direction === 'in' && !f.rolledBack)[0];
  if (lflow) {
    db.leaderPoolFlows.update(lflow.id, { rolledBack: true });
    db.leaderPoolFlows.insert({ direction: 'out', orderId, fen: lflow.fen, ref: 'refund_rollback', ts: new Date().toISOString() });
  }
  audit(db, operator, 'order.refund', { orderId, refundFen: order.paidFen });
  return { ok: true, kind: 'wx_refund', commissionRollback: rb };
}

/** 任务奖励（V3.3 §8.2-1：任务类型与奖励值后台可配） */
function taskRewardOf(db, taskType) {
  const cfg = db.switches.get('taskRewards') || {};
  const pick = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : d);
  if (taskType === 'sign_in') return pick(cfg.sign_in, 10);
  if (taskType === 'ad') return pick(cfg.ad, 15);
  if (String(taskType).startsWith('browse:')) return pick(cfg.browse, 5);
  return 0;
}

/** 每日任务/签到（站内任务）：贡献值只记权重；活跃判定数据源 */
function completeTask(db, { userId, taskType, date }) {
  const known = taskType === 'sign_in' || taskType === 'ad' || String(taskType).startsWith('browse:');
  if (!known) throw new Error('未知任务类型');
  if (taskType === 'ad' && db.switches.get('adTaskEnabled') !== true) throw new Error('广告任务尚未开通');
  const { value, replay } = db.idempotency.run(`task:${userId}:${taskType}:${date}`, () => {
    const reward = taskRewardOf(db, taskType);
    let acc = db.contributions.get(userId);
    if (!acc) acc = db.contributions.insert({ id: userId, weight: 0 });
    if (reward > 0) {
      acc.weight += reward;
      db.contributionFlows.insert({ userId, taskType, reward, date, ts: new Date().toISOString() });
    }
    // 复用已有记录（如浏览任务的 started 行），避免同任务同日出现两行
    const exist = db.taskRecords.where((r) => r.userId === userId && r.taskType === taskType && r.date === date)[0];
    if (exist) db.taskRecords.update(exist.id, { status: 'done', doneAt: new Date().toISOString() });
    else db.taskRecords.insert({ userId, taskType, date, status: 'done' });
    return { reward };
  });
  return { value, replay };
}

/** 浏览商品任务：开始（每商品每日一次） */
function startBrowse(db, { userId, productId, date }) {
  const taskType = 'browse:' + productId;
  const exist = db.taskRecords.where((r) => r.userId === userId && r.taskType === taskType && r.date === date)[0];
  if (exist && exist.status === 'done') throw new Error('今日该商品浏览任务已完成');
  if (exist) return { startedAt: exist.startedAt, replay: true };
  const rec = db.taskRecords.insert({ userId, taskType, date, status: 'started', startedAt: new Date().toISOString() });
  return { startedAt: rec.startedAt, replay: false };
}

/** 浏览商品任务完成：校验真实停留 ≥15 秒（防刷），完成后按普通任务计贡献值 */
function finishBrowse(db, { userId, productId, date, minDwellMs = 15000, now = Date.now() }) {
  const taskType = 'browse:' + productId;
  const rec = db.taskRecords.where((r) => r.userId === userId && r.taskType === taskType && r.date === date)[0];
  if (!rec || rec.status !== 'started') throw new Error('请先开始浏览任务');
  const elapsed = now - new Date(rec.startedAt).getTime();
  if (elapsed < minDwellMs) throw new Error(`浏览时长不足 15 秒（还需 ${Math.ceil((minDwellMs - elapsed) / 1000)} 秒）`);
  const { value, replay } = completeTask(db, { userId, taskType, date });
  return { ...value, replay, dwellSeconds: Math.floor(elapsed / 1000) };
}

/** 近 30 天贡献值（活跃门槛数据源：30 天累计 ≥80 记为达标，V3.3 §4.8 三门槛之活跃） */
function contribution30d(db, userId, now = new Date()) {
  const cutoff = new Date(now.getTime() - 30 * 86400 * 1000).toISOString();
  const weight = db.contributionFlows.where((f) => f.userId === userId && f.ts >= cutoff)
    .reduce((s, f) => s + f.reward, 0);
  return { weight30d: weight, target: 80, reached: weight >= 80 };
}

/** T-1 活跃快照跑批（供分红/有效人数/规模系数使用） */
function snapshotActivity(db, date) {  const users = new Set();
  for (const t of db.taskRecords.where((r) => r.date === date)) users.add(t.userId);
  // createdAt 是 UTC ISO 字符串，需换算成北京时间自然日再与 date 比较
  for (const o of db.orders.where((o) => o.status === 'paid' && bizdate.dayOfIso(o.createdAt) === date)) users.add(o.userId);
  for (const u of users) {
    db.activitySnapshots.insert({ date, userId: u, active: true });
  }
  return users.size;
}

function poolBalanceFen(db) {
  return db.dividendPoolFlows.all().reduce((s, f) => s + (f.direction === 'in' ? f.fen : -f.fen), 0);
}

/** 平台留存余额（分）：未归属分佣份额 + 周期留存，只增不改，供财务对账 */
function platformBalanceFen(db) {
  return db.platformFlows.all().reduce((s, f) => s + (f.direction === 'in' ? f.fen : -f.fen), 0);
}

/**
 * 活跃校验（V3.4 修正 D2）：原实现"历史上任意一天有快照即永久活跃"，
 * 会让僵尸号长期领分红、稀释真实用户。改为：
 *   ① 必须有 T-1（允许 2 天补跑窗口）的活跃快照；
 *   ② 当月签到天数达到门槛（默认 22 天，月初按当月进度等比放宽）。
 */
function isUserActive(db, userId, date) {
  const rawNeed = db.switches.get('activityRequireMonthSignDays');
  const minSign = Number.isFinite(Number(rawNeed)) ? Number(rawNeed) : 22;
  const ramp = db.switches.get('activitySignDaysRamp') !== false;
  const prev = db.activitySnapshots
    .where((s) => s.userId === userId && s.date < date)
    .map((s) => s.date)
    .sort()
    .pop();
  if (!prev) return false;
  const gapDays = (new Date(`${date}T00:00:00.000Z`).getTime() - new Date(`${prev}T00:00:00.000Z`).getTime()) / 86400000;
  if (!(gapDays <= 2)) return false; // 超过 2 天未活跃（或快照跑批中断过久）视为不活跃
  const month = String(date).slice(0, 7);
  const signDays = db.taskRecords
    .where((t) => t.userId === userId && t.taskType === 'sign_in' && String(t.date).startsWith(month))
    .length;
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate() || 30;
  const dom = Number(String(date).slice(8, 10)) || 1;
  const need = ramp ? Math.min(minSign, Math.ceil((dom * minSign) / daysInMonth)) : minSign;
  return signDays >= need;
}

// ==================== 季度分红：真实数据核算与发放（V3.3 §4.8） ====================

/** '2026Q4' -> 起止 ISO 字符串 [start, end) */
function quarterRange(quarter) {
  const m = /^(\d{4})Q([1-4])$/.exec(String(quarter));
  if (!m) throw new Error("季度格式非法（应为 '2026Q4'）");
  const startMonth = (Number(m[2]) - 1) * 3;
  const start = new Date(Date.UTC(Number(m[1]), startMonth, 1));
  const end = new Date(Date.UTC(Number(m[1]), startMonth + 3, 1));
  return { startISO: start.toISOString(), endISO: end.toISOString() };
}

const quarter = require('./domain/quarter');

/**
 * 从真实数据核算季度分红候选（三门槛数据源，V3.3 §4.8-5）：
 * - 团队季度真实消费 = 本人 + 直推用户的已支付 WX_PAY 订单实付合计（免单不计，待确认 20 默认口径）；
 *   季度归属按支付/完成时间（paidAt / receivedAt），缺省才回退 createdAt；
 * - 活跃占比 = 团队成员在季度内有活跃快照的人数 / 团队人数；
 * - 广告贡献 = 名下商家账户（同 ID）季度内有效投放费用合计（仅 active/expired 且审核通过；
 *   未生效、已取消、被驳回不计）。
 */
function computeQuarterCandidates(db, { quarterLabel }) {
  const { startISO, endISO } = quarterRange(quarterLabel);
  const inRange = (ts) => ts >= startISO && ts < endISO;
  // G11：季度归属按支付/完成时间（paidAt，缺省回退 createdAt），不再只看下单时间
  const paidTimeOf = (o) => o.paidAt || o.receivedAt || o.createdAt;
  const paidOrders = db.orders.where((o) => o.payType === 'WX_PAY'
    && ['paid', 'shipped', 'done'].includes(o.status) && inRange(paidTimeOf(o)));
  // G11：广告投放只统计有效状态——已上线/已结束可计；未生效、被驳回、已取消一律排除
  const validAdBookings = db.adBookings.where((b) => (b.reviewStatus || 'approved') === 'approved'
    && ['active', 'expired'].includes(b.status || 'active') && !!b.startAt && inRange(b.startAt));
  // 团队成员：本人 + 直推用户
  const teamMap = new Map(); // userId -> Set(memberIds)
  const teamOf = (u) => {
    if (!teamMap.has(u)) {
      const members = new Set([String(u)]);
      for (const o of paidOrders) {
        if (o.directUserId && o.directUserId === String(u)) members.add(String(o.userId)); // 由 u 直推下单的用户
      }
      teamMap.set(u, members);
    }
    return teamMap.get(u);
  };
  const users = new Set();
  for (const o of paidOrders) users.add(String(o.userId));
  for (const a of validAdBookings) users.add(String(a.merchantId));
  const activeDatesByUser = new Map();
  for (const s of db.activitySnapshots.where((x) => inRange(`${x.date}T00:00:00.000Z`))) {
    if (!activeDatesByUser.has(s.userId)) activeDatesByUser.set(s.userId, new Set());
    activeDatesByUser.get(s.userId).add(s.date);
  }
  const candidates = [];
  for (const u of users) {
    const members = teamOf(u);
    const consumption = paidOrders.filter((o) => members.has(String(o.userId))).reduce((s, o) => s + o.paidFen, 0);
    const activeMembers = [...members].filter((m) => activeDatesByUser.has(m)).length;
    const adSpend = validAdBookings.filter((b) => String(b.merchantId) === u).reduce((s, b) => s + b.feeFen, 0);
    candidates.push({
      userId: u,
      quarterConsumptionFen: consumption,
      activeUserRatio: members.size > 0 ? activeMembers / members.size : 0,
      adSpendFen: adSpend,
      teamSize: members.size,
      activeMembers,
    });
  }
  return candidates;
}

/** 季度资格核算跑批：真实数据 + 后台门槛配置 -> 资格快照（不接受手工候选，B2） */
function runQuarterAssessment(db, { quarterLabel, operator = 'admin' }) {
  const thresholds = db.switches.get('quarterThresholds');
  if (!thresholds || typeof thresholds !== 'object') throw new Error('季度门槛配置缺失（quarterThresholds）');
  const candidates = computeQuarterCandidates(db, { quarterLabel });
  const results = quarter.assessQuarterEligibility(db, { quarter: quarterLabel, candidates, thresholds, userLevels: {} });
  audit(db, operator, 'quarter.assess', { quarter: quarterLabel, candidates: candidates.length, eligible: results.filter((r) => r.eligible).length });
  return results;
}

/**
 * 平台规模系数（V3.3 §4.8-10）：按"有效消费用户数"取档（1000→1.0、1万→1.5、10万→2、100万→3），
 * 封顶 3 倍；后台若对个别用户配置了覆盖值（scaleCoefficients），优先使用覆盖值。
 */
function buildScaleCoefficients(db, rows, overrides = {}) {
  const effectiveUsers = new Set(
    db.orders.where((o) => ['paid', 'shipped', 'done'].includes(o.status)).map((o) => String(o.userId))
  ).size;
  const ladderRows = db.switches.get('scaleCoefficientLadder') || [];
  let platformScale = 1;
  for (const row of ladderRows) {
    const need = Number(row.users);
    const coef = Number(row.coefficient);
    if (Number.isFinite(need) && Number.isFinite(coef) && effectiveUsers >= need && coef > platformScale) platformScale = coef;
  }
  platformScale = Math.min(3, Math.max(1, platformScale));
  const out = {};
  for (const r of rows) {
    const raw = overrides[r.userId];
    out[r.userId] = raw != null && Number.isFinite(Number(raw))
      ? Math.min(3, Math.max(1, Number(raw)))
      : platformScale;
  }
  return out;
}

/**
 * 季度分红发放跑批：资格用户归一化权重（60/25/15×规模系数），池 = 储备 × 可分配比例。
 * 幂等（B2）：以 quarterPayouts 持久化批次为唯一发放入口——
 * - 同季度已有批次（paid/paying）一律不再发放，重跑/重启不会重复加钱；
 * - 先落 paying 占位再入账，入账中途异常保留占位，二次调用要求人工核对而不是再发一次；
 * - 无达标用户 / 池不足时不落批次，避免"0 元批次"把该季度锁死。
 */
function runQuarterPayout(db, { quarterLabel, operator = 'admin' }) {
  quarterRange(quarterLabel); // 季度格式前置校验
  const existing = db.quarterPayouts.where((p) => p.quarter === quarterLabel)[0];
  if (existing) {
    if (existing.status === 'paying') {
      throw new Error(`季度 ${quarterLabel} 存在未完成发放批次（${existing.id}），请先人工核对储备与入账，禁止重复发放`);
    }
    return { replay: true, paidFen: existing.paidFen, paidCount: existing.paidCount, note: `本季度已发放（批次 ${existing.id}），跳过` };
  }
  const eligible = db.quarterEligibility.where((r) => r.quarter === quarterLabel && r.eligible);
  if (eligible.length === 0) return { replay: false, paidFen: 0, paidCount: 0, note: '无达标用户，本季度不分红' };
  // 同一用户多次核算取最近一次快照
  const latest = new Map();
  for (const r of eligible) {
    const prev = latest.get(r.userId);
    if (!prev || r.ts > prev.ts) latest.set(r.userId, r);
  }
  const rows = [...latest.values()];
  const sumPerf = rows.reduce((s, r) => s + r.quarterConsumptionFen, 0);
  const sumAct = rows.reduce((s, r) => s + r.activeUserRatio, 0);
  const sumAd = rows.reduce((s, r) => s + r.adSpendFen, 0);
  const weights = rows.map((r) => ({
    userId: r.userId,
    performance: sumPerf > 0 ? r.quarterConsumptionFen / sumPerf : 0,
    activity: sumAct > 0 ? r.activeUserRatio / sumAct : 0,
    adContribution: sumAd > 0 ? r.adSpendFen / sumAd : 0,
  }));
  const reserveBalance = quarter.reserveBalanceFen(db);
  const poolFen = Math.floor(reserveBalance * db.switches.get('reserveDistributableRatio'));
  if (poolFen <= 0) return { replay: false, paidFen: 0, paidCount: 0, note: '储备专户可分配金额不足' };
  const scaleCoefficients = db.switches.get('scaleCoefficients') || {};
  // 先占位（paying）再入账：中途异常时批次仍存在，重跑会被拦截，避免重复发钱
  const batch = db.quarterPayouts.insert({
    quarter: quarterLabel, poolFen, paidFen: 0, paidCount: 0,
    status: 'paying', operator, ts: new Date().toISOString(),
  });
  const payouts = quarter.quarterPayout(db, { quarter: quarterLabel, poolFen, weights, scaleCoefficients: buildScaleCoefficients(db, rows, scaleCoefficients) });
  const paidFen = payouts.reduce((s, p) => s + p.fen, 0);
  if (paidFen > 0) quarter.reserveWithdraw(db, { reason: 'quarter_payout', fen: paidFen, ref: `quarter:${quarterLabel}` });
  db.quarterPayouts.update(batch.id, { paidFen, paidCount: payouts.length, status: 'paid', paidAt: new Date().toISOString() });
  audit(db, operator, 'quarter.payout_auto', { quarter: quarterLabel, poolFen, paidFen, paidCount: payouts.length, batchId: batch.id });
  return { replay: false, paidFen, paidCount: payouts.length, payouts };
}

/** 广告任务（§8.2）：流量主开通后启用；观看 ≥15 秒由服务端校验，开通前开关默认关 */
function startAdTask(db, { userId, date }) {
  if (db.switches.get('adTaskEnabled') !== true) throw new Error('广告任务尚未开通');
  const exist = db.taskRecords.where((r) => r.userId === userId && r.taskType === 'ad' && r.date === date)[0];
  if (exist && exist.status === 'done') throw new Error('今日广告任务已完成');
  if (exist) return { startedAt: exist.startedAt, replay: true };
  const rec = db.taskRecords.insert({ userId, taskType: 'ad', date, status: 'started', startedAt: new Date().toISOString() });
  return { startedAt: rec.startedAt, replay: false };
}

function finishAdTask(db, { userId, date, minDwellMs = 15000, now = Date.now() }) {
  if (db.switches.get('adTaskEnabled') !== true) throw new Error('广告任务尚未开通');
  const rec = db.taskRecords.where((r) => r.userId === userId && r.taskType === 'ad' && r.date === date)[0];
  if (!rec || rec.status !== 'started') throw new Error('请先开始广告任务');
  const elapsed = now - new Date(rec.startedAt).getTime();
  if (elapsed < minDwellMs) throw new Error(`观看时长不足（还需 ${Math.ceil((minDwellMs - elapsed) / 1000)} 秒）`);
  const { value, replay } = completeTask(db, { userId, taskType: 'ad', date });
  return { ...value, replay, dwellSeconds: Math.floor(elapsed / 1000) };
}

/**
 * 30 天完成奖励（§4.8-3 / §8.2-2）：近 N 天里有 N 个不同日期完成任务 → 奖励 R 贡献值。
 * 每个 N 天窗口只发一次（user.taskBonusAt 记录），由每日跑批调用。
 */
function runTaskStreakBonus(db, { date = bizdate.today() } = {}) {
  const cfg = db.switches.get('taskStreakBonus') || {};
  const days = Number(cfg.days) > 0 ? Number(cfg.days) : 30;
  const reward = Number(cfg.reward) >= 0 ? Number(cfg.reward) : 80;
  const end = bizdate.endOfDayTs(date);      // 北京时间当日 23:59:59.999
  const startMs = end - (days - 1) * 86400000;
  const startDay = bizdate.dayOf(startMs);   // 窗口起始日也按北京时间算
  const byUser = new Map();
  for (const t of db.taskRecords.where((t) => t.status === 'done')) {
    if (String(t.date) < startDay || String(t.date) > date) continue;
    if (!byUser.has(t.userId)) byUser.set(t.userId, new Set());
    byUser.get(t.userId).add(t.date);
  }
  let awarded = 0;
  for (const [userId, dates] of byUser) {
    if (dates.size < days) continue;
    const u = db.users.get(userId);
    if (!u) continue;
    const last = Date.parse(u.taskBonusAt || '');
    if (!Number.isNaN(last) && last > startMs) continue; // 本窗口已发
    let acc = db.contributions.get(userId);
    if (!acc) acc = db.contributions.insert({ id: userId, weight: 0 });
    if (reward > 0) {
      acc.weight += reward;
      db.contributionFlows.insert({ userId, taskType: `streak_${days}d`, reward, date, ts: new Date().toISOString() });
    }
    db.users.update(userId, { taskBonusAt: date });
    db.messages.insert({
      userId, type: 'task_streak', title: `${days} 天任务达成`,
      body: `连续 ${days} 天完成任务，奖励 ${reward} 贡献值（只算活跃度，不能换现金）。`,
      ts: new Date().toISOString(), read: false,
    });
    awarded += 1;
  }
  if (awarded > 0) audit(db, 'system', 'task.streak_bonus', { date, awarded, days, reward });
  return { awarded, days, reward };
}

/** 系统公告（§5.1「系统公告」）：全量或指定用户，走站内消息兜底通道 */
function broadcastMessage(db, { title, body, userIds, operator = 'admin' }) {
  const t = String(title || '').trim();
  const b = String(body || '').trim();
  if (!t || !b) throw new Error('标题与内容必填');
  if (t.length > 60 || b.length > 500) throw new Error('标题 ≤60 字、内容 ≤500 字');
  const targets = Array.isArray(userIds) && userIds.length
    ? userIds.map(String).filter((id) => db.users.get(id))
    : db.users.all().map((u) => u.id);
  const ts = new Date().toISOString();
  for (const uid of targets) db.messages.insert({ userId: uid, type: 'system_notice', title: t, body: b, ts, read: false });
  audit(db, operator, 'message.broadcast', { title: t, count: targets.length });
  return { count: targets.length };
}

/**
 * 复购中心（V3.3 §5.1）：历史购买商品 + 跨类目进度总览。
 * "下一单实付"按用户当前步位 + 该商品标价实时计算（与商品详情/下单页同口径）。
 */
function rebuyOverview(db, userId) {
  const uid = String(userId);
  const paid = db.orders.where((o) => o.userId === uid && o.payType === 'WX_PAY'
    && ['paid', 'shipped', 'done'].includes(o.status));
  const byProduct = new Map();
  for (const o of paid) {
    const cur = byProduct.get(o.productId) || { count: 0, lastAt: '' };
    cur.count += 1;
    const at = o.paidAt || o.createdAt || '';
    if (at > cur.lastAt) cur.lastAt = at;
    byProduct.set(o.productId, cur);
  }
  const products = [];
  for (const [productId, agg] of byProduct) {
    const p = db.products.get(productId);
    if (!p) continue;
    const cat = db.categories.get(p.categoryId);
    if (!cat) continue;
    const n = ladder.stepCount(cat.r);
    const cur = currentStep(db, uid, cat.id);
    const step = cur.step || 1;
    products.push({
      productId, name: p.name, imageUrl: p.imageUrl || '', priceFen: p.priceFen,
      categoryId: cat.id, categoryName: cat.name, n, total: n + ladder.REBATE_RATES.length, step,
      nextPayFen: ladder.priceAtStep(p.priceFen, n, step),
      buyCount: agg.count, lastPaidAt: agg.lastAt,
    });
  }
  products.sort((a, b) => (a.lastPaidAt < b.lastPaidAt ? 1 : -1));

  const categories = db.progress.where((p) => p.userId === uid && p.status !== 'voided').map((p) => {
    const c = db.categories.get(p.categoryId);
    if (!c) return null;
    const n = p.n || ladder.stepCount(c.r); // 全价段单数 m
    const total = n + ladder.REBATE_RATES.length;
    const done = p.done || 0;
    return { categoryId: c.id, name: c.name, done, n, total, remaining: Math.max(0, total - done), status: p.status };
  }).filter(Boolean);

  return { products, categories };
}

/**
 * 返还页数据：每个类目的进度 + 整条阶梯价表。
 *
 * 阶梯价按「该类目最近成交商品的标价 + 当前步位」推演，走 ladder 域，与下单金额同源；
 * 前端只做格式化，不在客户端重算折扣，避免两端口径漂移（返还页显示的数必须就是下单扣的数）。
 * 该类目还没有成交时退回在售最低价，让未开始的类目也能看到将要进入的阶梯。
 */
function returnPlans(db, userId) {
  const uid = String(userId);
  const progress = db.progress.where((p) => p.userId === uid).map((p) => {
    const cat = db.categories.get(p.categoryId) || {};
    const n = Math.max(2, p.n || (cat.r != null ? ladder.stepCount(cat.r) : 6));
    const total = n + ladder.REBATE_RATES.length;
    // 旧模型遗留：已领取免单的周期视为已收口，从第 1 步开新周期
    const step = p.status === 'free_claimed' ? 1 : Math.min((p.done || 0) + 1, total);

    const last = db.orders
      .where((o) => o.userId === uid && o.categoryId === p.categoryId && o.status !== 'cancelled')
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
    const ref = (last && db.products.get(last.productId))
      || db.products.where((x) => x.categoryId === p.categoryId && x.status === 'on_sale')
        .sort((a, b) => a.priceFen - b.priceFen)[0];
    const refPriceFen = ref ? ref.priceFen : null;
    const table = refPriceFen ? ladder.ladderTable(refPriceFen, n) : [];

    return {
      categoryId: p.categoryId,
      categoryName: cat.name || p.categoryId,
      done: p.done || 0,
      n,
      total,
      step,
      status: p.status,
      periodCount: p.periodCount || 0,
      refPriceFen,
      refProductName: ref ? ref.name : '',
      nextPayFen: table.length ? table[step - 1] : null,
      ladder: table, // 下标 k-1 = 第 k 步实付（分），长度 = total
    };
  });

  // 累计少付 = Σ(标价 - 实付)，只统计已支付/已发货/已完成（不含待支付与已取消，避免虚高）
  const savedFen = db.orders
    .where((o) => o.userId === uid && ['paid', 'shipped', 'done'].includes(o.status) && o.payType === 'WX_PAY')
    .reduce((s, o) => s + (o.priceFen - o.paidFen), 0);

  return { progress, savedFen };
}

// ==================== 规则版本与确认留档（V3.3 §5.2-1 / §15-11） ====================

/** 当前规则版本（后台可改，改版后用户需重新确认） */
function currentRules(db) {
  return {
    version: String(db.switches.get('rulesVersion') || '2026-10-24'),
    updatedAt: String(db.switches.get('rulesUpdatedAt') || ''),
  };
}

/**
 * 记录用户对当前规则版本的确认（首次下单强制）。
 * 同一版本重复确认不重复留档（replay），版本升级后需重新确认。
 */
function confirmRules(db, { userId, version, source = 'order' }) {
  const uid = String(userId);
  const cur = currentRules(db);
  const v = String(version || cur.version);
  if (v !== cur.version) {
    const e = new Error(`规则已更新到 ${cur.version}，请阅读后重新确认`);
    e.code = 'RULES_VERSION_CHANGED';
    throw e;
  }
  const exist = db.ruleConfirmations.where((r) => r.userId === uid && r.version === v)[0];
  if (exist) return { version: v, replay: true };
  db.ruleConfirmations.insert({ userId: uid, version: v, source, ts: new Date().toISOString() });
  db.users.update(uid, { rulesVersion: v, rulesConfirmedAt: new Date().toISOString() });
  audit(db, `user:${uid}`, 'rules.confirm', { version: v, source });
  return { version: v, replay: false };
}

/** 下单/领取免单前校验：必须先确认当前版本；未确认抛错（带 code 供前端引导） */
function assertRulesConfirmed(db, userId) {
  const uid = String(userId);
  const cur = currentRules(db);
  const u = db.users.get(uid) || {};
  if (String(u.rulesVersion || '') === cur.version) return cur;
  const e = new Error('请先阅读并确认当前版本规则');
  e.code = 'RULES_NOT_CONFIRMED';
  e.rulesVersion = cur.version;
  throw e;
}

// ==================== 等级与有效人数（V3.3 §4.9 / §4.10） ====================

/** 团队 = 直推 + 间推（两层，与方案 A 的直推/间推口径一致） */
function teamUserIds(db, userId) {
  const uid = String(userId);
  const direct = db.users.where((u) => u.directUserId === uid).map((u) => u.id);
  const indirect = direct.length
    ? db.users.where((u) => direct.includes(u.directUserId)).map((u) => u.id)
    : [];
  return [...new Set([...direct, ...indirect])];
}

/** 最近一次活跃时间（下单 / 任务 / 活跃快照 / 登录，取最大值） */
function lastActiveAt(db, userId) {
  const uid = String(userId);
  let last = 0;
  const bump = (t) => {
    const v = Date.parse(t || '');
    if (!Number.isNaN(v) && v > last) last = v;
  };
  for (const o of db.orders.where((o) => o.userId === uid)) bump(o.createdAt || o.paidAt);
  for (const t of db.taskRecords.where((t) => t.userId === uid)) bump(t.doneAt || t.startedAt || t.date);
  for (const s of db.activitySnapshots.where((s) => s.userId === uid)) bump(s.date);
  const u = db.users.get(uid);
  if (u) bump(u.lastLoginAt);
  return last;
}

/** 是否有"已过售后期、未退款、无售后中"的真实支付订单（免单不计，待确认 20 默认口径） */
function hasSettledPaidOrder(db, userId, now) {
  const uid = String(userId);
  const windowDays = Number(db.switches.get('afterSaleWindowDays') || 7);
  return db.orders.where((o) => o.userId === uid && o.payType === 'WX_PAY'
    && ['paid', 'shipped', 'done'].includes(o.status)
    && o.afterSaleStatus !== 'applying').some((o) => {
    const start = o.receivedAt || o.storeVerifiedAt || o.shippedAt || o.paidAt || o.createdAt;
    const ts = Date.parse(start || '');
    return !Number.isNaN(ts) && ts + windowDays * 86400000 <= now;
  });
}

/**
 * 有效人数（V3.3 §4.10）：
 * 通过推广关系绑定 + ≥1 笔真实支付且已过售后期、无退款 + 无风控标记 + 近 30 天有活跃。
 * @returns {{validUsers:number, teamSize:number, userIds:string[]}}
 */
function validUserCount(db, userId, { date, days = 30 } = {}) {
  const day = date || bizdate.today();
  const now = bizdate.endOfDayTs(day);
  const cutoff = now - days * 86400000;
  const team = teamUserIds(db, userId);
  const userIds = team.filter((id) => {
    if (risk.isBlacklisted(db, id)) return false;
    if (!hasSettledPaidOrder(db, id, now)) return false;
    return lastActiveAt(db, id) >= cutoff;
  });
  return { validUsers: userIds.length, teamSize: team.length, userIds };
}

/** 等级档案（含有效人数与下一档进度），供"我的团队 / 个人中心 / 后台"展示 */
function levelProfile(db, userId, opts = {}) {
  const c = validUserCount(db, userId, opts);
  return { ...level.levelProfileOf(c.validUsers, db.switches.get('levelThresholds')), teamSize: c.teamSize };
}

module.exports = { currentStep, createOrder, releaseOrder, onPaid, refundOrder, completeTask, snapshotActivity, poolBalanceFen, platformBalanceFen, isUserActive, ensureProgress, quarterRange, computeQuarterCandidates, runQuarterAssessment, runQuarterPayout, startBrowse, finishBrowse, contribution30d, teamUserIds, validUserCount, levelProfile, taskRewardOf, startAdTask, finishAdTask, runTaskStreakBonus, broadcastMessage, currentRules, confirmRules, assertRulesConfirmed, rebuyOverview, returnPlans };
