'use strict';
/**
 * 周期经济自检（V3.4 财务修正）
 * 不启动服务、不连数据库，直接跑域逻辑，打印一个返还周期的：
 *   步位 / 实付 / 可分配收益 / 分佣基数 / 平台留存
 *
 * 用法：
 *   node tools/economics-check.js                 # 默认 10 元 / r=20% / 成本 3 元
 *   node tools/economics-check.js 1000 300 0.2    # 标价(分) 成本(分) r
 *
 * 判定标准：平台留存（周期可分配收益 − 分佣基数合计）必须 ≥ 0。
 */
const ladder = require('../src/domain/ladder');

const yuan = (fen) => (fen / 100).toFixed(2);

function check({ priceFen, costFen, r, taxFeeRate = 0.06, opCostFen = 50, retainRate = 0.10 }) {
  const n = ladder.stepCount(r);
  const econ = ladder.cycleEconomics({ priceFen, n, costFen, taxFeeRate, opCostFen });
  const factor = econ.factor * (1 - retainRate);
  const rows = econ.rows.map((x) => ({
    step: x.step,
    paidFen: x.paidFen,
    allocFen: x.allocFen,
    baseFen: Math.floor(Math.max(0, x.allocFen) * factor),
  }));
  const baseTotal = rows.reduce((s, x) => s + x.baseFen, 0);
  const retain = econ.allocTotalFen - baseTotal;

  console.log('');
  console.log(`标价 ${yuan(priceFen)} 元 / r=${r} / n=${n} / 成本 ${yuan(costFen)} / 税费率 ${taxFeeRate} / 运营 ${yuan(opCostFen)} 元/单 / 平台留存率 ${retainRate}`);
  console.log('步位   实付    可分配收益   分佣基数');
  for (const x of rows) {
    console.log(`${String(x.step).padStart(3)}  ${yuan(x.paidFen).padStart(7)}  ${yuan(x.allocFen).padStart(10)}  ${yuan(x.baseFen).padStart(9)}`);
  }
  console.log(`周期可分配 ${yuan(econ.allocTotalFen)} | 分佣基数合计 ${yuan(baseTotal)} | 平台留存 ${yuan(retain)} ${retain >= 0 ? '✓ 不会亏' : '✗ 亏损'}`);
  console.log(`（旧口径：分佣基数 ${yuan(econ.positiveSumFen)} → 平台 ${yuan(econ.allocTotalFen - econ.positiveSumFen)}，即超发金额）`);
  return { n, rows, allocTotalFen: econ.allocTotalFen, baseTotal, retain };
}

if (require.main === module) {
  const priceP = parseInt(process.argv[2], 10);
  const costP = parseInt(process.argv[3], 10);
  const rP = Number(process.argv[4]);
  const priceFen = Number.isInteger(priceP) ? priceP : 1000;
  const costFen = Number.isInteger(costP) ? costP : 300;
  const r = Number.isFinite(rP) && rP > 0 && rP <= 1 ? rP : 0.2;

  check({ priceFen, costFen, r, opCostFen: 50 });      // 默认：市场价商品
  check({ priceFen, costFen: 420, r, opCostFen: 50 }); // 文档"成本红线 4.2 元"
  check({ priceFen, costFen: 220, r, opCostFen: 50 }); // 文档"≤2.2 元才维持 20% 利润口径"
  check({ priceFen: 10000, costFen: 3000, r: 0.5, opCostFen: 80 }); // 100 元 / r=50% / 3 步
}

module.exports = { check };
