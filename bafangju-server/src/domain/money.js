'use strict';
/**
 * 金额工具 —— 合规要求：所有资金计算使用整数"分"，杜绝浮点误差。
 * 对外展示（元）仅在序列化层转换。
 */

/** 元(数字/字符串) -> 分(整数) */
function yuanToFen(yuan) {
  const n = Number(yuan);
  if (!Number.isFinite(n)) throw new Error('invalid yuan: ' + yuan);
  const fen = Math.round(n * 100);
  if (Math.abs(n * 100 - fen) > 1e-6) throw new Error('amount precision loss: ' + yuan);
  return fen;
}

/** 分(整数) -> 元(数字，仅展示用) */
function fenToYuan(fen) {
  if (!Number.isInteger(fen)) throw new Error('fen must be integer: ' + fen);
  return fen / 100;
}

/** 整数除法：商与余数（分） */
function divMod(total, parts) {
  if (!Number.isInteger(total) || !Number.isInteger(parts) || parts <= 0) {
    throw new Error('divMod requires positive integers');
  }
  const q = Math.floor(total / parts);
  const r = total - q * parts;
  return { q, r };
}

/**
 * 均分金额（分）：前 rem 份各多 1 分，合计严格等于 total（分账/分红均分用，总和守恒）。
 */
function splitEven(total, parts) {
  const { q, r } = divMod(total, parts);
  const list = new Array(parts).fill(q);
  for (let i = 0; i < r; i++) list[i] += 1;
  return list;
}

/**
 * 按权重分摊金额（分）：最大余数法，保证合计严格等于 total 且每份 >= 0。
 * weights 为非负整数权重数组。
 */
function splitByWeights(total, weights) {
  if (!Number.isInteger(total) || total < 0) throw new Error('invalid total');
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const base = raw.map((x) => Math.floor(x));
  let rest = total - base.reduce((a, b) => a + b, 0);
  // 按小数部分从大到小补 1 分
  const order = raw
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < order.length && rest > 0; k++, rest--) {
    base[order[k].i] += 1;
  }
  const allocated = base.reduce((a, b) => a + b, 0);
  if (allocated !== total) throw new Error('splitByWeights conservation failed');
  return base;
}

module.exports = { yuanToFen, fenToYuan, splitEven, splitByWeights };
