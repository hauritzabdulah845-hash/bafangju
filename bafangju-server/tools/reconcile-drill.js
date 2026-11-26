'use strict';
/**
 * 月度对账演练（V3.11）
 *
 * 目的：用一个可复跑的确定性场景，把"一个月的经营动作"跑一遍，然后对四本账 + 平台留存 + 用户收益账户做交叉对账，
 *       并把 V3.4 之后的几条关键护栏变成硬断言（分佣不超发、池不超发、储备不透支、联盟线不进商品线池…）。
 *
 * 运行：node tools/reconcile-drill.js
 * 退出码：0 = 全部检查通过；1 = 有检查失败（会打印 FAIL 明细）
 *
 * 说明：使用内存库，不落盘、不联网、不涉及真实资金。
 */
const { createStore } = require('../src/store');
const svc = require('../src/services');
const catalog = require('../src/domain/catalog');
const ladder = require('../src/domain/ladder');
const merchant = require('../src/domain/merchant');
const fulfillment = require('../src/domain/fulfillment');
const coupon = require('../src/domain/coupon');
const ad = require('../src/domain/ad');
const commission = require('../src/domain/commission');
const dividend = require('../src/domain/dividend');

const yuan = (fen) => (Number(fen || 0) / 100).toFixed(2);
const sum = (arr, key) => arr.reduce((s, x) => s + (x[key] || 0), 0);

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail || '' });
}

/** 搭一个最小可运营的世界：3 商家 / 3 类目商品 / 12 用户（含 2 组推客关系） */
function buildWorld(options = {}) {
  const db = createStore();
  if (options.paidAlliance) {
    // 可选演练「收费模式」（V3.6/V4.4 口径）：显式开启 3%/5% 服务费率；生产默认（V4.5）为 0 = 免费导流
    db.switches.set('couponServiceFeeRate', 0.03);
    db.switches.set('verificationServiceFeeRate', 0.05);
  }

  for (const [id, name] of [['m1', '张记粮油店'], ['m2', '李记小馆'], ['m3', '王姐美业']]) {
    db.merchants.insert({ id, name, status: 'active', username: name, passwordHash: 'x', createdAt: new Date().toISOString() });
  }

  const grain = catalog.createCategory(db, { name: '粮油食品', r: 0.2 });   // n = 6
  const food = catalog.createCategory(db, { name: '餐饮美食', r: 0.25 });  // n = 5
  const beauty = catalog.createCategory(db, { name: '丽人美发', r: 0.5 }); // n = 3

  const pRice = catalog.createProduct(db, {
    categoryId: grain.id, name: '大米 5kg', priceFen: 1000, costFen: 300, deliveryType: 'store', merchantId: 'm1',
  });
  const pMeal = catalog.createProduct(db, {
    categoryId: food.id, name: '双人套餐', priceFen: 3000, costFen: 1200, deliveryType: 'store', merchantId: 'm2',
  });
  const pBeauty = catalog.createProduct(db, {
    categoryId: beauty.id, name: '洗剪吹', priceFen: 10000, costFen: 4000, deliveryType: 'store', merchantId: 'm3',
  });

  for (let i = 1; i <= 12; i++) {
    db.users.insert({ id: 'u' + i, nickname: '用户' + i, createdAt: new Date().toISOString() });
  }
  // 两组推广关系：u1 直推 u2-u5；u6 直推 u7-u8
  for (const u of ['u2', 'u3', 'u4', 'u5']) db.users.update(u, { directUserId: 'u1' });
  for (const u of ['u7', 'u8']) db.users.update(u, { directUserId: 'u6' });

  return { db, pRice, pMeal, pBeauty };
}

/** 跑一个月：下单/支付/到店核销/免单、发券领券核销、广告投放与曝光点击、退款、结算、排队分红 */
function runMonth(world) {
  const { db, pRice, pMeal, pBeauty } = world;
  let seq = 0;

  const buy = (userId, product) => {
    seq += 1;
    const { order } = svc.createOrder(db, { userId, productId: product.id, idempotencyKey: 'k' + seq });
    svc.onPaid(db, { orderId: order.id });
    fulfillment.verifyStoreOrder(db, { orderId: order.id, verifyCode: db.orders.get(order.id).verifyCode });
    return db.orders.get(order.id);
  };

  /** 跑完一个返还周期：全价段 n 单 + 让利段 4 单（V3.4 起无免单步位，全部实付） */
  const runCycle = (userId, product) => {
    const category = db.categories.get(product.categoryId);
    const total = ladder.totalSteps(category.r);
    for (let i = 0; i < total; i++) buy(userId, product);
  };

  // ① 商品线：3 个类目各跑若干周期（覆盖 n=3/5/6 三种阶梯）
  runCycle('u1', pRice);
  runCycle('u2', pRice);
  runCycle('u3', pMeal);
  runCycle('u4', pBeauty);
  runCycle('u5', pRice);

  // ② 联盟券：3 家各发 1 张，用户领取后到店核销（核销金额需满足各自最低消费）
  const couponPlan = [
    { mid: 'm1', title: '满50减5', off: 500, min: 5000, uid: 'u7', amountFen: 8000 },
    { mid: 'm2', title: '满100减10', off: 1000, min: 10000, uid: 'u8', amountFen: 12000 },
    { mid: 'm3', title: '满200减30', off: 3000, min: 20000, uid: 'u9', amountFen: 25000 },
  ];
  for (const c of couponPlan) {
    const tpl = coupon.createCoupon(db, { merchantId: c.mid, title: c.title, type: 'cash', amountOffFen: c.off, minSpendFen: c.min });
    const claim = coupon.claimCoupon(db, { couponId: tpl.id, userId: c.uid });
    const redeemed = coupon.redeemCoupon(db, { code: claim.code, merchantId: c.mid, amountFen: c.amountFen });
    // 收费模式下（V4.4）：核销只挂应收单，需后台确认收款后才计入储备专户/平台留存并允许分佣解冻
    if (redeemed.feeBillId) {
      coupon.markFeeBillPaid(db, { billId: redeemed.feeBillId, method: 'offline', operator: 'admin:drill' });
    }
  }

  // ③ 广告：2 个位置，各投 1 单；平台审核通过后产生曝光/点击
  const slotBanner = ad.createSlot(db, { name: '首页 Banner A', position: 'home_banner', minDays: 7, feePerCycleFen: 30000 });
  const slotDetail = ad.createSlot(db, { name: '详情页位', position: 'detail', minDays: 7, feePerCycleFen: 10000 });
  const bk1 = merchant.bookAdSlot(db, { slotId: slotBanner.id, merchantId: 'm1', days: 7, title: '粮油节' });
  const bk2 = merchant.bookAdSlot(db, { slotId: slotDetail.id, merchantId: 'm2', days: 7, title: '新店开业' });
  ad.reviewBooking(db, { bookingId: bk1.id, approved: true });
  ad.reviewBooking(db, { bookingId: bk2.id, approved: true });
  for (const u of ['u10', 'u11', 'u12', 'u1', 'u2']) ad.recordImpression(db, { bookingId: bk1.id, userId: u });
  ad.recordClick(db, { bookingId: bk1.id, userId: 'u10' });

  // ④ 退款：u10 只买了一单（未完成周期）后申请退款，校验按单回滚、周期不回算
  const oneOff = buy('u10', pRice);
  svc.refundOrder(db, { orderId: oneOff.id });

  // ⑤ 售后期结束：分佣冻结 -> 余额
  const settled = commission.settleDue(db, { afterHours: 0 });

  // ⑥ 排队分红：按池余额发放一次（5%、最多 100 席）
  const poolBefore = svc.poolBalanceFen(db);
  const payout = dividend.dailyPayout(db, {
    date: '2026-10-31',
    poolBalanceFen: poolBefore,
    dailyRatio: 0.05,
    maxSeats: 100,
    isUserActive: () => true,
  });

  return { settled: settled.length, poolBefore, payout };
}

function reconcile(world, monthResult) {
  const { db } = world;
  const orders = db.orders.all();
  const relevant = orders.filter((o) => o.status !== 'refunded' && o.status !== 'cancelled');
  const paidWx = relevant.filter((o) => o.payType === 'WX_PAY');
  const freeOrders = relevant.filter((o) => o.payType === 'FREE');

  const paidFen = sum(relevant, 'paidFen');
  const costFen = sum(relevant, 'costFen');
  const taxFen = sum(relevant, 'taxAndFeeFen');
  const opFen = sum(relevant, 'opCostFen');
  const allocFen = sum(relevant, 'allocFen');
  const records = db.commissionRecords.where((r) => r.status !== 'rolled_back');
  const rolledBack = db.commissionRecords.where((r) => r.status === 'rolled_back');
  const baseFen = sum(records, 'baseFen');
  const directFen = records.reduce((s, r) => s + (r.splitFen.direct || 0), 0);
  const leaderFen = records.reduce((s, r) => s + (r.splitFen.leader || 0), 0);
  const platformFeeFen = records.reduce((s, r) => s + (r.splitFen.platform || 0), 0);
  const indirectPoolFen = records.reduce((s, r) => s + (r.splitFen.indirect || 0) + (r.splitFen.indirectToPool || 0), 0);

  const poolIn = db.dividendPoolFlows.where((f) => f.direction === 'in').reduce((s, f) => s + f.fen, 0);
  const poolOut = db.dividendPoolFlows.where((f) => f.direction === 'out').reduce((s, f) => s + f.fen, 0);
  const poolBalance = poolIn - poolOut;

  const reserveIn = db.reserveFlows.where((f) => f.direction === 'in').reduce((s, f) => s + f.fen, 0);
  const reserveOut = db.reserveFlows.where((f) => f.direction === 'out').reduce((s, f) => s + f.fen, 0);

  const platformIn = db.platformFlows.where((f) => f.direction === 'in').reduce((s, f) => s + f.fen, 0);
  const platformOut = db.platformFlows.where((f) => f.direction === 'out').reduce((s, f) => s + f.fen, 0);

  const allianceOrders = db.allianceOrders.all();
  const couponFeeFen = sum(allianceOrders, 'couponServiceFeeFen');
  const verifyFeeFen = sum(allianceOrders, 'verifyServiceFeeFen');
  const allianceBaseFen = sum(allianceOrders, 'baseFen');
  const feeBills = db.merchantFeeBills.all();
  const paidFeeBills = feeBills.filter((b) => b.status === 'paid');
  const allianceFeeEnabled = (Number(db.switches.get('couponServiceFeeRate')) || 0) > 0
    || (Number(db.switches.get('verificationServiceFeeRate')) || 0) > 0;

  const adBookings = db.adBookings.all();
  const adSpendFen = sum(adBookings, 'feeFen');
  const impressions = sum(adBookings, 'impressionCount');
  const clicks = sum(adBookings, 'clickCount');

  // 收益账户：余额 + 冻结 应等于 frozen 流水 − rollback 流水（本期无提现）
  let expectedEarning = 0;
  for (const f of db.earningFlows.all()) {
    if (f.status === 'frozen') expectedEarning += f.fen;
    else if (f.status === 'rollback') expectedEarning -= f.fen;
  }
  const actualEarning = db.earnings.all().reduce((s, a) => s + (a.balanceFen || 0) + (a.frozenFen || 0), 0);

  // 每个返还周期的可分配收益（含免单负单）必须 ≥ 0
  const byPeriod = new Map();
  for (const o of orders) {
    if (!o.periodId) continue;
    byPeriod.set(o.periodId, (byPeriod.get(o.periodId) || 0) + (o.allocFen || 0));
  }
  const periodTotals = [...byPeriod.values()];
  const worstPeriod = periodTotals.length ? Math.min(...periodTotals) : 0;

  return {
    paidFen, costFen, taxFen, opFen, allocFen,
    baseFen, directFen, leaderFen, platformFeeFen, indirectPoolFen,
    rolledBackBase: sum(rolledBack, 'baseFen'), rolledBackCount: rolledBack.length,
    poolIn, poolOut, poolBalance, reserveIn, reserveOut, platformIn, platformOut,
    allianceCount: allianceOrders.length,
    couponFeeFen, verifyFeeFen, allianceBaseFen,
    feeBillsCount: feeBills.length, paidFeeBillsCount: paidFeeBills.length, allianceFeeEnabled,
    adSpendFen, impressions, clicks,
    expectedEarning, actualEarning, worstPeriod, periodCount: periodTotals.length,
    ordersCount: paidWx.length, freeCount: freeOrders.length,
  };
}

function runChecks(r, monthResult) {
  checks.length = 0;
  // ① 订单守恒：实付 = 成本 + 税费 + 运营 + 可分配（对每一单都成立，含免单负单）
  check('订单守恒（实付 = 成本+税费+运营+可分配）',
    r.paidFen === r.costFen + r.taxFen + r.opFen + r.allocFen,
    `实付 ${yuan(r.paidFen)} = 成本 ${yuan(r.costFen)} + 税费 ${yuan(r.taxFen)} + 运营 ${yuan(r.opFen)} + 可分配 ${yuan(r.allocFen)}`);

  // ② 分佣不超发：分佣基数合计 ≤ 商品线可分配收益（含免单负单冲减、已剔除退款单）
  check('分佣不超发（基数合计 ≤ 可分配收益）', r.baseFen <= r.allocFen, `基数 ${yuan(r.baseFen)} ≤ 可分配 ${yuan(r.allocFen)}`);

  // ③ 分佣拆分守恒：各角色合计 = 基数
  const splitTotal = r.directFen + r.leaderFen + r.platformFeeFen + r.indirectPoolFen;
  check('分佣拆分守恒（各角色合计 = 基数）', splitTotal === r.baseFen, `${yuan(splitTotal)} = ${yuan(r.baseFen)}`);

  // ③b 退款按单回滚：存在已回滚记录，且不再计入生效分佣
  check('退款按单回滚（已回滚记录不计入生效分佣）', r.rolledBackCount > 0 && r.rolledBackBase >= 0,
    `回滚 ${r.rolledBackCount} 单，回滚基数 ${yuan(r.rolledBackBase)}`);

  // ④ 分红池不透支
  check('分红池不透支（流出 ≤ 流入）', r.poolOut <= r.poolIn && r.poolBalance >= 0,
    `流入 ${yuan(r.poolIn)} / 流出 ${yuan(r.poolOut)} / 期末 ${yuan(r.poolBalance)}`);
  check('分红池当日发放 ≤ 池余额 5%', monthResult.payout.paidFen <= Math.floor(monthResult.poolBefore * 0.05) + 1,
    `发放 ${yuan(monthResult.payout.paidFen)} ≤ 5% × ${yuan(monthResult.poolBefore)}`);

  // ⑤ 储备专户不透支，且是平台留存的子账
  check('储备专户不透支（流出 ≤ 流入）', r.reserveOut <= r.reserveIn, `流入 ${yuan(r.reserveIn)} / 流出 ${yuan(r.reserveOut)}`);
  check('储备 ⊆ 平台留存', r.reserveIn - r.reserveOut <= r.platformIn - r.platformOut,
    `储备 ${yuan(r.reserveIn - r.reserveOut)} ≤ 平台留存 ${yuan(r.platformIn - r.platformOut)}`);

  // ⑥ 平台留存非负
  check('平台留存非负', r.platformIn - r.platformOut >= 0, `期末 ${yuan(r.platformIn - r.platformOut)}`);

  // ⑦ 收益账户账实相符（余额+冻结 = 冻结流水 − 回滚流水）
  check('收益账户账实相符', Math.abs(r.actualEarning - r.expectedEarning) <= 0,
    `账面 ${yuan(r.actualEarning)} / 流水推算 ${yuan(r.expectedEarning)}`);

  // ⑧ 每个返还周期可分配收益 ≥ 0（V3.4 修复的核心口径）
  check('每个返还周期可分配收益 ≥ 0', r.worstPeriod >= 0,
    `共 ${r.periodCount} 个周期，最差 ${yuan(r.worstPeriod)}`);

  // ⑨ 联盟线口径校验：
  // - V4.5 默认免费导流模式（费率 0）：核销落单、0 服务费、0 应收欠费挂账；
  // - 开启收费模式（--paid-alliance）：计提服务费、走应收单收款闭环，且只进平台留存/储备而不进商品线分红池
  const feeBase = r.couponFeeFen + r.verifyFeeFen;
  if (r.allianceFeeEnabled) {
    check('联盟服务费已计提且收款入账',
      r.allianceCount > 0 && feeBase > 0 && r.allianceBaseFen > 0
        && r.feeBillsCount === r.allianceCount && r.paidFeeBillsCount === r.feeBillsCount,
      `核销 ${r.allianceCount} 单｜券服务费 ${yuan(r.couponFeeFen)} + 核销服务费 ${yuan(r.verifyFeeFen)}，方案B 基数 ${yuan(r.allianceBaseFen)}，应收已结清 ${r.paidFeeBillsCount}/${r.feeBillsCount}`);
  } else {
    check('联盟券免费导流闭环（V4.5 默认 0 费率）',
      r.allianceCount > 0 && feeBase === 0 && r.allianceBaseFen === 0 && r.feeBillsCount === 0,
      `核销 ${r.allianceCount} 单｜服务费 0.00 元，应收挂账 ${r.feeBillsCount} 笔（纯导流不收费，可用 --paid-alliance 演练收费模式）`);
  }

  // ⑩ 广告收入入账
  check('广告收入入账', r.adSpendFen > 0 && r.impressions > 0,
    `投放费 ${yuan(r.adSpendFen)} / 曝光 ${r.impressions} / 点击 ${r.clicks}`);
}

function report(world, monthResult, r) {
  const line = '─'.repeat(64);
  console.log('\n' + '═'.repeat(64));
  console.log('  八方聚 · 月度对账演练（2026-10）');
  console.log('═'.repeat(64));
  console.log(`\n【一、商品线】`);
  console.log(`  有效订单 ${r.ordersCount} 笔 + 免单 ${r.freeCount} 笔`);
  console.log(`  实付合计        ${yuan(r.paidFen).padStart(10)} 元`);
  console.log(`  ├ 商品成本      ${yuan(r.costFen).padStart(10)} 元`);
  console.log(`  ├ 税费+通道费   ${yuan(r.taxFen).padStart(10)} 元`);
  console.log(`  ├ 运营成本      ${yuan(r.opFen).padStart(10)} 元`);
  console.log(`  └ 可分配收益    ${yuan(r.allocFen).padStart(10)} 元   ← 含免单负单冲减`);

  console.log(`\n【二、分佣（记账）】`);
  console.log(`  分佣基数合计    ${yuan(r.baseFen).padStart(10)} 元`);
  console.log(`  ├ 直推          ${yuan(r.directFen).padStart(10)} 元`);
  console.log(`  ├ 团队长份额    ${yuan(r.leaderFen).padStart(10)} 元   ← 无归属团队长时归平台`);
  console.log(`  ├ 平台服务费    ${yuan(r.platformFeeFen).padStart(10)} 元`);
  console.log(`  └ 间推/入池     ${yuan(r.indirectPoolFen).padStart(10)} 元`);
  console.log(`  平台留存（分佣后实收里未分出去的） ${yuan(r.baseFen - r.directFen - r.leaderFen).padStart(10)} 元（含入池部分）`);

  console.log(`\n【三、排队分红池】`);
  console.log(`  期初            ${yuan(0).padStart(10)} 元`);
  console.log(`  本期流入        ${yuan(r.poolIn).padStart(10)} 元`);
  console.log(`  本期发放        ${yuan(r.poolOut).padStart(10)} 元`);
  console.log(`  期末余额        ${yuan(r.poolBalance).padStart(10)} 元`);

  console.log(`\n【四、储备专户】`);
  console.log(`  划入（广告+交易服务费） ${yuan(r.reserveIn).padStart(10)} 元`);
  console.log(`  划出（季度分红）        ${yuan(r.reserveOut).padStart(10)} 元`);
  console.log(`  期末余额                ${yuan(r.reserveIn - r.reserveOut).padStart(10)} 元`);

  console.log(`\n【五、平台留存】`);
  console.log(`  流入            ${yuan(r.platformIn).padStart(10)} 元`);
  console.log(`  流出            ${yuan(r.platformOut).padStart(10)} 元`);
  console.log(`  期末            ${yuan(r.platformIn - r.platformOut).padStart(10)} 元`);

  console.log(`\n【六、联盟券与广告】`);
  console.log(`  券核销服务费    ${yuan(r.couponFeeFen).padStart(10)} 元（方案 B 基数 ${yuan(r.allianceBaseFen)}）`);
  console.log(`  核销服务费      ${yuan(r.verifyFeeFen).padStart(10)} 元`);
  console.log(`  广告投放        ${yuan(r.adSpendFen).padStart(10)} 元 / 曝光 ${r.impressions} / 点击 ${r.clicks}`);

  console.log(`\n【七、用户收益账户】`);
  console.log(`  账面（余额+冻结）${yuan(r.actualEarning).padStart(10)} 元`);
  console.log(`  流水推算        ${yuan(r.expectedEarning).padStart(10)} 元`);

  console.log('\n' + line);
  console.log('  对账检查');
  console.log(line);
  for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}｜${c.detail}`);
  const failed = checks.filter((c) => !c.ok);
  console.log(line);
  console.log(failed.length === 0
    ? `  ✅ 全部 ${checks.length} 项检查通过`
    : `  ❌ ${failed.length}/${checks.length} 项未通过`);
  console.log('═'.repeat(64) + '\n');
  return failed.length;
}

function main(argv = process.argv.slice(2)) {
  const paidAlliance = argv.includes('--paid-alliance');
  const world = buildWorld({ paidAlliance });
  const monthResult = runMonth(world);
  const r = reconcile(world, monthResult);
  runChecks(r, monthResult);
  const failed = report(world, monthResult, r);
  process.exitCode = failed === 0 ? 0 : 1;
}

if (require.main === module) main();

module.exports = { buildWorld, runMonth, reconcile, runChecks, report };
