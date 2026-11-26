'use strict';
/**
 * 储备专户与季度分红（V3.3 §4.8）—— 合规要点：
 * - 储备专户仅划入平台真实收益（交易服务费/广告收益/其他合规划入），与用户货款、商家结算款严格隔离；
 * - 贡献分不直接兑付现金：单位参考价值只读公示，无任何兑换接口；
 * - 兑现唯一通道为季度分红；不承诺只涨不跌；
 * - 分红资格三门槛（业绩/活跃/广告贡献）同时达标；权重 = 业绩60% + 活跃25% + 广告贡献15%，× 规模系数（封顶 3 倍）。
 */
const { splitByWeights } = require('./money');

/** 储备专户划入（平台真实收益，仅限来源白名单） */
const RESERVE_SOURCES = ['trade_service_fee', 'ad_revenue', 'other_approved'];
function reserveDeposit(db, { source, fen, ref }) {
  if (!RESERVE_SOURCES.includes(source)) throw new Error('reserve source not allowed: ' + source);
  if (!Number.isInteger(fen) || fen <= 0) throw new Error('invalid fen');
  return db.reserveFlows.insert({ direction: 'in', source, fen, ref, ts: new Date().toISOString() });
}

function reserveBalanceFen(db) {
  return db.reserveFlows.all().reduce((s, f) => s + (f.direction === 'in' ? f.fen : -f.fen), 0);
}

/** 储备专户出账（仅限白名单事由）：季度分红兑付扣减储备 */
const RESERVE_OUT_REASONS = ['quarter_payout'];
function reserveWithdraw(db, { reason, fen, ref }) {
  if (!RESERVE_OUT_REASONS.includes(reason)) throw new Error('reserve out reason not allowed: ' + reason);
  if (!Number.isInteger(fen) || fen <= 0) throw new Error('invalid fen');
  if (fen > reserveBalanceFen(db)) throw new Error('储备专户余额不足');
  return db.reserveFlows.insert({ direction: 'out', source: reason, fen, ref, ts: new Date().toISOString() });
}

/** 贡献分单位参考价值（只读公示，分/分）：储备 × 0.6 ÷ 流通贡献分总量 */
function contributionUnitValueFen(db) {
  if (db.switches.get('contributionValuePublishEnabled') === false) return null;
  const totalWeight = db.contributions.all().reduce((s, c) => s + c.weight, 0);
  if (totalWeight <= 0) return 0;
  const ratio = db.switches.get('reserveDistributableRatio');
  return Math.floor(reserveBalanceFen(db) * ratio / totalWeight);
}

/**
 * 季度分红资格核算（三门槛同时达标，生成资格快照）
 * @param {object} p
 * @param {string} p.quarter       如 '2026Q4'
 * @param {Array}  p.candidates    [{userId, quarterConsumptionFen, activeUserRatio, adSpendFen}]
 * @param {object} p.thresholds    {consumptionFenByLevel:{V1:500000,...}, activeRatio:0.15, adSpendFenByLevel:{...}}
 * @param {object} p.userLevels    {userId: 'V1'|'V2'...}
 */
function assessQuarterEligibility(db, { quarter, candidates, thresholds, userLevels }) {
  const results = candidates.map((c) => {
    const level = userLevels[c.userId] || 'V1';
    const needConsumption = (thresholds.consumptionFenByLevel || {})[level] ?? Infinity;
    const needAdSpend = (thresholds.adSpendFenByLevel || {})[level] ?? 0;
    const okPerformance = c.quarterConsumptionFen >= needConsumption;
    const okActivity = c.activeUserRatio >= thresholds.activeRatio;
    const okAd = c.adSpendFen >= needAdSpend;
    const eligible = okPerformance && okActivity && okAd;
    const row = db.quarterEligibility.insert({
      quarter, userId: c.userId, level,
      quarterConsumptionFen: c.quarterConsumptionFen, activeUserRatio: c.activeUserRatio, adSpendFen: c.adSpendFen,
      okPerformance, okActivity, okAd, eligible,
      ts: new Date().toISOString(),
    });
    return row;
  });
  return results;
}

/**
 * 季度分红发放：个人权重 = 业绩60% + 活跃25% + 广告贡献15%（×规模系数，封顶3倍）
 * @param {Array} p.weights 输入已归一化的分项权重 {userId, performance, activity, adContribution}（0~1）
 * @param {Map|object} p.scaleCoefficients userId -> 规模系数（1~3）
 * @param {object} [p.weightConfig] 权重配置，默认读 quarterWeights 开关
 */
function quarterPayout(db, { quarter, poolFen, weights, scaleCoefficients, weightConfig }) {
  const cfg = weightConfig || db.switches.get('quarterWeights') || { performance: 0.60, activity: 0.25, adContribution: 0.15 };
  const wp = Number(cfg.performance) || 0;
  const wa = Number(cfg.activity) || 0;
  const wad = Number(cfg.adContribution) || 0;
  const sumW = wp + wa + wad;
  const norm = sumW > 0 ? (x) => x / sumW : () => 0; // 配置未合计 1 时自动归一，避免多发/少发
  const ids = weights.map((w) => w.userId);
  const combined = weights.map((w) => {
    const sc = Math.min(3, Math.max(1, Number(scaleCoefficients?.[w.userId] ?? 1)));
    const base = norm(w.performance * wp + w.activity * wa + w.adContribution * wad);
    return base * sc; // V3.4 修正：规模系数真正参与计算（原实现算了 sc 却未使用）
  });
  // 权重放大用整数化（×1e6）后按权重分摊，保证合计守恒
  const intWeights = combined.map((x) => Math.max(0, Math.round(x * 1e6)));
  const amounts = splitByWeights(poolFen, intWeights);
  const payouts = ids.map((userId, i) => ({ userId, fen: amounts[i] }));
  for (const p of payouts) {
    if (p.fen > 0) {
      const acc = db.earnings.get(p.userId) || db.earnings.insert({ id: p.userId, balanceFen: 0, frozenFen: 0, dividendBalanceFen: 0 });
      acc.dividendBalanceFen += p.fen; // 季度分红默认入消费余额、不可提现（待确认 5）
      db.dividendPayouts.insert({ userId: p.userId, quarter, fen: p.fen, status: 'paid', kind: 'quarter' });
    }
  }
  return payouts;
}

module.exports = { RESERVE_SOURCES, RESERVE_OUT_REASONS, reserveDeposit, reserveWithdraw, reserveBalanceFen, contributionUnitValueFen, assessQuarterEligibility, quarterPayout };
