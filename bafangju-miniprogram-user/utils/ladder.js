/**
 * 阶梯 chip 的展示逻辑（首页与返还页共用）
 *
 * 业务口径与后端 src/domain/ladder.js 严格一致：
 * - 前 n 单（全价段）实付 = 标价；
 * - 尾段固定 4 单，让利 10% / 20% / 30% / 40%；
 * - 周期总单数 total = n + 4，第 total 单付完周期收口，回到第 1 单；
 * - 无 0 元免单（尾单是 6 折，不是免费）。
 *
 * 价格一律以「分」为入参、由后端算出，前端只做格式化与窗口切片，
 * 不在前端重算折扣，避免与下单金额对不上。
 */

/** 375 屏宽下超过 5 格文字会被挤成两行 */
const MAX_CHIP = 5;

/** 分 → chip 上的短金额（¥10 / ¥6.5 / ¥6.24），不带多余的 .00 */
function shortYuan(fen) {
  if (fen == null || !Number.isFinite(fen)) return '—';
  const yuan = fen / 100;
  const s = Number.isInteger(yuan) ? String(yuan) : yuan.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return '¥' + s;
}

/** 尾段 4 单的让利比例，与后端 domain/ladder.js 的 REBATE_RATES 保持一致 */
const REBATE_RATES = [0.1, 0.2, 0.3, 0.4];

/**
 * 按标价推演整条阶梯（分）。
 * 仅用于「假设再买这件商品」的展示场景（商品流里的复购卡）——此时没有后端快照，
 * 标价是页面数据里的商品价。已成交订单/返还页一律用后端返回的 ladder，不用这里重算。
 */
function buildLadder(priceFen, n) {
  if (!priceFen || !(n >= 2)) return [];
  const out = [];
  for (let k = 1; k <= n + REBATE_RATES.length; k++) {
    out.push(k <= n ? priceFen : Math.round(priceFen * (1 - REBATE_RATES[k - n - 1])));
  }
  return out;
}

/**
 * 生成 chip 窗口。
 *
 * 为什么不按「当前步往后顺排」：前 n 单都是原价，顺排会连续出现好几个一样的价格，
 * 用户看不出「越买越便宜」。所以窗口优先跨到让利段（第 n+1 单起），把便宜的那几格露出来。
 *
 * @param {number[]} ladderFen 后端 ladder 数组，下标 k-1 = 第 k 步实付（分）
 * @param {number} step 当前步位（1-based）
 * @param {number} n 全价段单数
 * @param {number} total 周期总单数
 * @param {number} [max] 最多几格
 * @returns {{i:number,k:string,v:string,state:string}[]}
 */
function chipWindow(ladderFen, step, n, total, max) {
  const limit = max || MAX_CHIP;
  if (!Array.isArray(ladderFen) || !ladderFen.length) return [];
  const priceOf = (i) => ladderFen[i - 1];
  const rows = [];
  const push = (i) => {
    if (i < 1 || i > total || rows.some((r) => r.i === i)) return;
    rows.push({
      i,
      k: i === step ? '当前' : '第' + i + '单',
      v: shortYuan(priceOf(i)),
      state: i < step ? 'done' : (i === step ? 'now' : (i === total ? 'goal' : 'next')),
    });
  };

  // ① 当前步
  push(step);
  // ② 优先补齐让利段（最便宜的几格，是这套机制的说服力所在）
  for (let i = n + 1; i <= total && rows.length < limit; i++) push(i);
  // ③ 还差格数就顺着当前步往后补（已进入让利段时全靠这一步）
  for (let i = step + 1; i <= total && rows.length < limit; i++) push(i);

  // ④ 步位之间可能隔着整段全价单（如当前第 3 单直接跳到第 7 单），
  //    中间插一个省略格，否则会被误读成「中间这几单没了」
  rows.sort((a, b) => a.i - b.i);
  const out = [];
  rows.forEach((r, idx) => {
    if (idx > 0 && r.i - rows[idx - 1].i > 1) out.push({ gap: true, i: 'g' + idx });
    out.push(r);
  });
  return out;
}

/** 当前周期卡里的一句说明：下一阶段是什么，别让用户自己数格 */
function stageHint(step, n) {
  if (step > n) {
    const idx = step - n; // 1..4，第几格让利
    const rates = ['10%', '20%', '30%', '40%'];
    return '本轮已进入让利段（第 ' + idx + ' / 4 段，让利 ' + rates[idx - 1] + '）';
  }
  return '再买 ' + (n - step + 1) + ' 单进入让利段，尾 4 单让利 10%~40%';
}

module.exports = { MAX_CHIP, REBATE_RATES, shortYuan, buildLadder, chipWindow, stageHint };
