'use strict';
/**
 * 阶梯定价引擎（纯函数，2026-10-29 新模型）
 *
 * 模型（用户确认口径）：
 * - 类目可分配利润率 r ∈ (0,1]，全价段单数 m = floor(1/r) + 1（r=0.2→6、0.25→5、0.3→4、0.4→3、0.5→3）；
 * - 全价段（第 1..m 单）实付 = 标价；
 * - 让利段固定 4 单（第 m+1..m+4 单）：让利 10%/20%/30%/40%，实付 = 标价的 90/80/70/60%；
 * - 周期总单数 total = m + 4；第 total 单支付完成后周期收口归零，下一单开新周期（实付回到标价）；
 * - 无 0 元免单。
 *
 * 平台不亏（数学保证）：周期让利合计 = 标价 × (10%+20%+30%+40%) = 标价 × 100%，
 * 恒小于周期利润 ≈ 标价 × r × (m+4)（因 m = floor(1/r)+1 > 1/r，仅全价段利润 r×m 就已 > 1）。
 *
 * 合规要点：
 * - 阶梯优惠内嵌于售价，不事后兑付、无专户、无应付负债；
 * - 进度计数按类目，实付价按"当前商品标价 + 用户当前步位"动态计算；
 * - 每单成交生成快照，配置变更不追溯。
 */
const { yuanToFen } = require('./money');

/** 让利段固定 4 单的让利比例（第 m+1..m+4 单） */
const REBATE_RATES = [0.1, 0.2, 0.3, 0.4];

/**
 * 全价段单数 m = floor(1/r) + 1（1e-9 为浮点保护，避免 1/r 因精度略低于整数而少算一单）
 * @param {number} r 可分配利润率，如 0.2
 */
function stepCount(r) {
  if (!(r > 0 && r <= 1)) throw new Error('r must be in (0,1]');
  return Math.floor(1 / r + 1e-9) + 1;
}

/** 周期总单数 = 全价段 m + 让利段 4 单 */
function totalSteps(r) {
  return stepCount(r) + REBATE_RATES.length;
}

/**
 * 计算某类目第 k 步（1-based）购买某商品时的实付（分）。
 * 第 1..m 单实付标价；第 m+i 单（i=1..4）实付 = 标价 × (1 − REBATE_RATES[i-1])，四舍五入到分。
 * @param {number} priceFen 商品标价（分）
 * @param {number} n 类目全价段单数 m（stepCount(r)）
 * @param {number} k 当前步位（1..m+4）
 */
function priceAtStep(priceFen, n, k) {
  if (!Number.isInteger(priceFen) || priceFen <= 0) throw new Error('invalid priceFen');
  if (!Number.isInteger(n) || n < 2) throw new Error('invalid n');
  const total = n + REBATE_RATES.length;
  if (!Number.isInteger(k) || k < 1 || k > total) throw new Error('step k out of range');
  if (k <= n) return priceFen; // 全价段
  const rate = REBATE_RATES[k - n - 1];
  return Math.round(priceFen * (1 - rate)); // 让利段
}

/**
 * 展示用阶梯表（分）：长度 m+4，前 m 项为标价，后 4 项为让利价。
 */
function ladderTable(priceFen, n) {
  const list = [];
  for (let k = 1; k <= n + REBATE_RATES.length; k++) list.push(priceAtStep(priceFen, n, k));
  return list;
}

/**
 * 生成订单阶梯价快照（成交时固化，配置变更不追溯）。
 */
function makeSnapshot({ productId, categoryId, priceYuan, r }) {
  const priceFen = yuanToFen(priceYuan);
  const n = stepCount(r);
  return {
    productId,
    categoryId,
    priceFen,
    r,
    n, // 全价段单数 m
    total: n + REBATE_RATES.length, // 周期总单数
    rebateRates: [...REBATE_RATES],
    createdAt: new Date().toISOString(),
  };
}

/**
 * 可分配收益（分）= 实付 - 成本 - 税费通道费 - 优惠 - 平台基础运营成本（全部整数分，可为负）。
 * 分佣基数 = max(0, 可分配收益)（为负记 0）。
 */
function allocatableIncome({ paidFen, costFen, taxAndFeeFen, discountFen, opCostFen }) {
  const parts = [paidFen, costFen, taxAndFeeFen, discountFen, opCostFen];
  for (const p of parts) if (!Number.isInteger(p)) throw new Error('allocatableIncome requires integer fen');
  return paidFen - costFen - taxAndFeeFen - discountFen - opCostFen;
}

/**
 * 周期经济推演：给定商品与类目全价段单数 n(=m)，把整个返还周期（第 1..m+4 单）算一遍，
 * 得到每单可分配收益、周期合计、以及"分佣基数系数" factor。
 *
 * factor = 周期可分配收益合计 ÷ 各正单可分配收益合计（clamp [0,1]），
 * 使 Σ(正单 × factor) = 周期合计，即"分佣只从本期真实赚到的钱里出"。
 * 新模型下无免单负单，factor 通常为 1；仅当成本/税费高到某些单 alloc 为负时才 < 1。
 *
 * @returns {{rows:Array, allocTotalFen:number, positiveSumFen:number, factor:number}}
 */
function cycleEconomics({ priceFen, n, costFen = 0, taxFeeRate = 0.06, opCostFen = 0 }) {
  if (!Number.isInteger(priceFen) || priceFen <= 0) throw new Error('invalid priceFen');
  if (!Number.isInteger(n) || n < 2) throw new Error('invalid n');
  if (!Number.isInteger(costFen) || costFen < 0) throw new Error('invalid costFen');
  if (!Number.isInteger(opCostFen) || opCostFen < 0) throw new Error('invalid opCostFen');
  if (!Number.isFinite(taxFeeRate) || taxFeeRate < 0 || taxFeeRate >= 1) throw new Error('invalid taxFeeRate');
  const total = n + REBATE_RATES.length;
  const rows = [];
  for (let k = 1; k <= total; k++) {
    const paidFen = priceAtStep(priceFen, n, k);
    const taxAndFeeFen = Math.round(paidFen * taxFeeRate);
    const allocFen = paidFen - costFen - taxAndFeeFen - opCostFen;
    rows.push({ step: k, paidFen, taxAndFeeFen, allocFen });
  }
  const allocTotalFen = rows.reduce((s, r) => s + r.allocFen, 0);
  const positiveSumFen = rows.reduce((s, r) => s + Math.max(0, r.allocFen), 0);
  const factor = positiveSumFen > 0 ? Math.max(0, Math.min(1, allocTotalFen / positiveSumFen)) : 0;
  return { rows, allocTotalFen, positiveSumFen, factor };
}

module.exports = { REBATE_RATES, stepCount, totalSteps, priceAtStep, ladderTable, makeSnapshot, allocatableIncome, cycleEconomics };
