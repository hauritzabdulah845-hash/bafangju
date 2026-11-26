'use strict';
/**
 * 分佣记账结算（V3.3 §4.5）—— 合规要点：
 * - 不使用微信分账（上限 30%），全部为平台收益账户记账（冻结 -> 结算 -> 余额）；
 * - 按单独立核算：退款只回滚该单，周期不做事后重算（§4.7-4）；
 * - 间推默认关闭，关闭期间份额实时转入排队分红池（§4.5-6）；
 * - 低价单（可分配收益为负）分佣基数为 0，不入分红池（§4.3-4）。
 */
const { splitByWeights } = require('./money');
const { audit } = require('../store');

/**
 * 计算某单分佣拆分（分）。基数 <= 0 时全为 0。
 * @returns {{platform,direct,indirect,leader,indirectToPool}} 各角色金额（分）
 */
function calcCommission(baseFen, plan, indirectEnabled) {
  if (!Number.isInteger(baseFen) || baseFen < 0) throw new Error('baseFen must be non-negative int');
  const raw = {
    platform: Math.floor(baseFen * plan.platform),
    direct: Math.floor(baseFen * plan.direct),
    indirect: Math.floor(baseFen * plan.indirect),
    leader: Math.floor(baseFen * plan.leader),
  };
  // 尾差并入平台服务费，保证合计 = 基数（资金守恒）
  const allocated = raw.platform + raw.direct + raw.indirect + raw.leader;
  raw.platform += baseFen - allocated;
  if (!indirectEnabled) {
    return { ...raw, indirectToPool: raw.indirect, indirect: 0 };
  }
  return { ...raw, indirectToPool: 0 };
}

/**
 * 记账：为角色收益账户写入冻结流水。返回待入分红池金额（间推关闭份额）。
 * 团队长份额写入 leaderPoolFlows 持久化流水（按预订时归属的团队长，V3.3 §4.8-11："距订单最近的在册团队长"）。
 */
function bookCommission(db, { orderId, baseFen, plan, indirectEnabled, directUserId, indirectUserId, leaderUserId }) {
  const split = calcCommission(baseFen, plan, indirectEnabled);
  const rec = db.commissionRecords.insert({
    orderId,
    baseFen,
    splitFen: split,
    status: 'frozen', // frozen -> settled | rolled_back
    directUserId: directUserId || null,
    indirectUserId: indirectEnabled ? indirectUserId || null : null,
    leaderUserId: leaderUserId || null,
    unattributedFen: 0,
    createdAt: new Date().toISOString(),
  });
  // 冻结入账（direct / indirect 冻结；平台服务费与团队长份额走池）
  let unattributedFen = 0;
  if (split.direct > 0) {
    if (directUserId) addEarning(db, directUserId, split.direct, 'frozen', `order:${orderId}:direct`);
    else unattributedFen += split.direct; // 无推广人：不得"消失"，归平台留存（V3.4 修正 D12）
  }
  if (split.indirect > 0) {
    if (rec.indirectUserId) addEarning(db, rec.indirectUserId, split.indirect, 'frozen', `order:${orderId}:indirect`);
    else unattributedFen += split.indirect;
  }
  if (split.leader > 0) {
    // 团队长份额：只有归属到具体团队长才进辅导池；无归属归平台留存，避免永久沉淀（V3.4 修正 D3）
    if (leaderUserId) db.leaderPoolFlows.insert({ direction: 'in', leaderId: leaderUserId, fen: split.leader, orderId, ts: new Date().toISOString() });
    else unattributedFen += split.leader;
  }
  rec.unattributedFen = unattributedFen;
  return { split, record: rec, toPoolFen: split.platform + split.indirectToPool, unattributedFen };
}

function addEarning(db, userId, fen, status, ref) {
  let acc = db.earnings.get(userId);
  if (!acc) acc = db.earnings.insert({ id: userId, balanceFen: 0, frozenFen: 0 });
  if (status === 'frozen') acc.frozenFen += fen;
  else if (status === 'balance') acc.balanceFen += fen;
  else throw new Error('unknown earning status ' + status);
  db.earningFlows.insert({ userId, fen, status, ref, ts: new Date().toISOString() });
}

/** 售后期结束：冻结 -> 余额（结算跑批按单调用） */
function settleOrder(db, orderId) {
  const rec = db.commissionRecords.where((r) => r.orderId === orderId && r.status === 'frozen')[0];
  if (!rec) return null;
  const s = rec.splitFen;
  const move = (userId, fen) => {
    if (!userId || fen <= 0) return;
    const acc = db.earnings.get(userId);
    acc.frozenFen -= fen;
    acc.balanceFen += fen;
    db.earningFlows.insert({ userId, fen, status: 'settle', ref: `order:${orderId}`, ts: new Date().toISOString() });
  };
  move(rec.directUserId, s.direct);
  move(rec.indirectUserId, s.indirect);
  rec.status = 'settled';
  return rec;
}

/** 退款回滚（按单独立核算，周期不重算）：冻结/余额扣回，不足挂账 */
function rollbackOrder(db, orderId) {
  const rec = db.commissionRecords.where((r) => r.orderId === orderId && r.status !== 'rolled_back')[0];
  if (!rec) return null;
  const s = rec.splitFen;
  const claw = (userId, fen) => {
    if (!userId || fen <= 0) return { userId, shortfallFen: 0 };
    const acc = db.earnings.get(userId);
    if (!acc) return { userId, shortfallFen: fen };
    const takeFrozen = Math.min(acc.frozenFen, fen);
    acc.frozenFen -= takeFrozen;
    let left = fen - takeFrozen;
    const takeBalance = Math.min(acc.balanceFen, left);
    acc.balanceFen -= takeBalance;
    left -= takeBalance;
    if (left > 0) {
      acc.debtFen = (acc.debtFen || 0) + left; // 挂账并限制提现
      acc.withdrawBlocked = true;
    }
    db.earningFlows.insert({ userId, fen: fen - left, status: 'rollback', ref: `order:${orderId}`, ts: new Date().toISOString() });
    return { userId, shortfallFen: left };
  };
  const results = [claw(rec.directUserId, s.direct), claw(rec.indirectUserId, s.indirect)];
  rec.status = 'rolled_back';
  return { record: rec, results, unattributedFen: rec.unattributedFen || 0 };
}

/**
 * 售后期到期自动结算跑批（V3.4 修正 P0-3）：支付成功满 settleAfterHours 小时、
 * 且订单未退款/取消的分佣记录，由"冻结"转入"余额"。
 * 生产应替换为"按真实售后到期日"结算；当前以支付时间为准，时长后台可配置。
 */
function settleDue(db, { now = Date.now(), afterHours = 168 } = {}) {
  const windowMs = Math.max(0, Number(afterHours) || 0) * 3600 * 1000;
  const settled = [];
  for (const rec of db.commissionRecords.where((r) => r.status === 'frozen')) {
    const ref = String(rec.orderId || '');
    let start = null;
    if (ref.startsWith('alliance:')) {
      // 联盟服务单（券核销）：以核销时间作为售后期起点
      const a = db.allianceOrders.get(ref.slice('alliance:'.length));
      if (!a || a.status !== 'settled') continue;
      // V4.4 账实一致：服务费未实际收到前不解冻联盟分佣（否则平台用没到账的钱发佣金）。
      // 历史单（无应收单）按旧口径直接结算。
      const bill = db.merchantFeeBills
        ? db.merchantFeeBills.where((b) => b.allianceOrderId === a.id)[0]
        : null;
      if (bill && bill.status !== 'paid') continue;
      start = a.createdAt;
    } else {
      const order = db.orders.get(ref);
      if (!order) continue;
      if (order.status === 'refunded' || order.status === 'cancelled') continue;
      if (order.afterSaleStatus === 'applying') continue; // 售后处理中不解冻，避免退款后追不回
      // 售后期起点：收货 > 到店核销 > 发货 > 支付（V3.5 履约口径）
      start = order.receivedAt || order.storeVerifiedAt || order.shippedAt || order.paidAt;
    }
    if (!start) continue;
    if (new Date(start).getTime() + windowMs > now) continue;
    const done = settleOrder(db, rec.orderId);
    if (done) settled.push(done);
  }
  return settled;
}

/** 团队长池权重分配（V3.3 §4.8-11）：权重 = 辅导商家分佣基数贡献 × 系数 */
function distributeLeaderPool(db, poolFen, leaderWeights) {
  const weights = leaderWeights.map((w) => Math.max(0, Math.round(w.contributionFen * w.coefficient)));
  return splitByWeights(poolFen, weights);
}

/** 团队长池余额（分）：按流水合计 */
function leaderPoolBalanceFen(db) {
  return db.leaderPoolFlows.all().reduce((s, f) => s + (f.direction === 'in' ? f.fen : -f.fen), 0);
}

/** 各团队长辅导贡献基数（分）：归属流水中未回滚的 in 部分合计 */
function leaderContributions(db) {
  const map = new Map();
  for (const f of db.leaderPoolFlows.where((x) => x.direction === 'in' && x.leaderId && !x.rolledBack)) {
    map.set(f.leaderId, (map.get(f.leaderId) || 0) + f.fen);
  }
  return map;
}

/**
 * 团队长池分配跑批（V3.3 §4.8-11）：池余额按"辅导贡献基数 × 系数"权重分配，
 * 发放至团队长收益账户余额（辅导佣金性质，可提现），幂等（同批次键只执行一次）。
 * 未归属份额（无团队长的订单）按权重分摊给在册团队长，无在册团队长时保留池中。
 */
function distributeLeaderPoolJob(db, { batchKey, coefficient = 1.0, operator = 'admin' }) {
  const key = String(batchKey || '').trim();
  if (!key) throw new Error('批次键必填（batchKey），用于团队长分红幂等');
  // 批次幂等（S3）：该批次已有出账流水即视为已分配，重跑不再发钱（即使上次中途异常也只少发不重发）
  const done = db.leaderPoolFlows.where((f) => f.direction === 'out' && f.ref === key);
  if (done.length > 0) {
    return { ok: true, replay: true, paidFen: done.reduce((s, f) => s + f.fen, 0), paidCount: done.length, note: `批次 ${key} 已分配，跳过` };
  }
  const { value, replay } = db.idempotency.run(`leaderDividend:${key}`, () => {
    const pool = leaderPoolBalanceFen(db);
    if (pool <= 0) return { paidFen: 0, paidCount: 0, note: '池内无可分配金额' };
    const contribs = leaderContributions(db);
    const leaders = [...contribs.entries()].map(([leaderId, contributionFen]) => ({ leaderId, contributionFen, coefficient }));
    if (leaders.length === 0) return { paidFen: 0, paidCount: 0, note: '无在册团队长，份额留存池中' };
    const amounts = distributeLeaderPool(db, pool, leaders);
    const payouts = [];
    leaders.forEach((l, i) => {
      const fen = amounts[i];
      if (fen > 0) {
        addEarning(db, l.leaderId, fen, 'balance', `leader_dividend:${key}`);
        db.leaderPoolFlows.insert({ direction: 'out', leaderId: l.leaderId, fen, ref: key, ts: new Date().toISOString() });
        payouts.push({ leaderId: l.leaderId, fen });
      }
    });
    audit(db, operator, 'leader_dividend.paid', { batchKey: key, poolFen: pool, paidFen: payouts.reduce((s, p) => s + p.fen, 0) });
    return { paidFen: payouts.reduce((s, p) => s + p.fen, 0), paidCount: payouts.length, payouts };
  });
  return { ok: true, replay, ...value };
}

module.exports = { calcCommission, bookCommission, settleOrder, settleDue, rollbackOrder, distributeLeaderPool, distributeLeaderPoolJob, leaderPoolBalanceFen, leaderContributions, addEarning };
