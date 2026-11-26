'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createStore } = require('../src/store');
const dividend = require('../src/domain/dividend');
const quarter = require('../src/domain/quarter');

function seedSlots(db, users) {
  for (const [i, u] of users.entries()) {
    db.queueSlots.insert({ userId: u, periodId: `p${i}`, status: 'waiting', grantedAt: new Date(2026, 0, 1, 0, 0, i).toISOString() });
    db.earnings.insert({ id: u, balanceFen: 0, frozenFen: 0, dividendBalanceFen: 0 });
  }
}

test('每日分红：活跃校验跳过、席数=实际名单、金额守恒、T-1 快照口径', () => {
  const db = createStore();
  const users = ['a', 'b', 'c'];
  seedSlots(db, users);
  db.dividendPoolFlows.insert({ direction: 'in', fen: 100000, ts: new Date().toISOString() });
  const active = new Set(['a', 'c']); // b 不活跃
  const r = dividend.dailyPayout(db, {
    date: '2026-10-24', poolBalanceFen: 100000, dailyRatio: 0.05, maxSeats: 100,
    isUserActive: (u) => active.has(u),
  });
  assert.strictEqual(r.paidCount, 2);
  assert.strictEqual(r.skippedCount, 1);
  assert.strictEqual(r.paidFen, 5000); // 100000 × 5%
  assert.strictEqual(r.payouts.reduce((s, p) => s + p.fen, 0), 5000);
  // 跳过者顺延，队位不取消
  assert.strictEqual(db.queueSlots.get(2).status, 'skipped');
  // 次日 b 恢复活跃可发放
  const r2 = dividend.dailyPayout(db, {
    date: '2026-10-25', poolBalanceFen: 95000, dailyRatio: 0.05, maxSeats: 100,
    isUserActive: () => true,
  });
  assert.strictEqual(r2.paidCount, 1);
  assert.strictEqual(db.queueSlots.get(2).status, 'paid');
});

test('每日分红：同一用户同日仅结算 1 个队位（§4.12-2）', () => {
  const db = createStore();
  for (let i = 0; i < 3; i++) {
    db.queueSlots.insert({ userId: 'u1', periodId: `p${i}`, status: 'waiting', grantedAt: new Date(2026, 0, 1, i).toISOString() });
  }
  db.earnings.insert({ id: 'u1', balanceFen: 0, frozenFen: 0, dividendBalanceFen: 0 });
  const r = dividend.dailyPayout(db, {
    date: '2026-10-24', poolBalanceFen: 1000000, dailyRatio: 0.05, maxSeats: 100,
    isUserActive: () => true,
  });
  assert.strictEqual(r.paidCount, 1);
  assert.strictEqual(db.queueSlots.where((s) => s.status === 'paid').length, 1);
  assert.strictEqual(db.queueSlots.where((s) => s.status === 'waiting').length, 2);
});

test('每日分红：最大席数限制', () => {
  const db = createStore();
  const users = Array.from({ length: 10 }, (_, i) => `u${i}`);
  seedSlots(db, users);
  const r = dividend.dailyPayout(db, {
    date: '2026-10-24', poolBalanceFen: 1000000, dailyRatio: 0.05, maxSeats: 4,
    isUserActive: () => true,
  });
  assert.strictEqual(r.paidCount, 4);
});

test('暂停发放开关：池内资金留存、队位保留（§12.5 降级方案）', () => {
  const db = createStore();
  seedSlots(db, ['a']);
  db.switches.set('queueDividendEnabled', false);
  const r = dividend.dailyPayout(db, {
    date: '2026-10-24', poolBalanceFen: 100000, dailyRatio: 0.05, maxSeats: 100,
    isUserActive: () => true,
  });
  assert.strictEqual(r.paused, true);
  assert.strictEqual(r.paidFen, 0);
  assert.strictEqual(db.queueSlots.where((s) => s.status === 'waiting').length, 1);
});

test('每日分红同日幂等（S3）：重跑不重复发钱，同一用户同日只占一个队位', () => {
  const db = createStore();
  db.queueSlots.insert({ userId: 'u1', periodId: 'p1', status: 'waiting', grantedAt: '2026-01-01T00:00:00.000Z' });
  db.queueSlots.insert({ userId: 'u1', periodId: 'p2', status: 'waiting', grantedAt: '2026-01-01T00:00:01.000Z' });
  db.queueSlots.insert({ userId: 'u2', periodId: 'p3', status: 'waiting', grantedAt: '2026-01-01T00:00:02.000Z' });
  const args = { date: '2026-10-24', poolBalanceFen: 1000000, dailyRatio: 0.05, maxSeats: 100, isUserActive: () => true };
  const r1 = dividend.dailyPayout(db, args);
  assert.strictEqual(r1.paidCount, 2);
  const paidFen1 = r1.paidFen;
  const u1Balance = db.earnings.get('u1').dividendBalanceFen;

  // 手动重跑 / 重启后自动跑：直接回放，不产生第二笔
  const r2 = dividend.dailyPayout(db, args);
  assert.strictEqual(r2.replay, true);
  assert.strictEqual(r2.paidFen, 0);
  assert.strictEqual(db.dividendPayouts.where((p) => p.status === 'paid').length, 2, '同日不得新增发放记录');
  assert.strictEqual(db.dividendPoolFlows.where((f) => f.direction === 'out').length, 1, '池流出只有一条');
  assert.strictEqual(db.earnings.get('u1').dividendBalanceFen, u1Balance);
  assert.strictEqual(u1Balance, Math.floor(paidFen1 / 2) + (paidFen1 % 2), '同一用户同日只结算 1 个队位');
  assert.strictEqual(db.queueSlots.where((s) => s.userId === 'u1' && s.status === 'waiting').length, 1, '第二队位顺延');
});

test('日结跑批同日幂等（S3）：幂等键持久化，重启后同日重跑不再触发资金步骤', () => {
  const db = createStore();
  const createDailyJobs = require('../src/daily-jobs');
  let payoutCalls = 0;
  const noop = () => {};
  const ctx = {
    db,
    audit: require('../src/store').audit,
    svc: { snapshotActivity: () => 0, runTaskStreakBonus: () => ({ awarded: 0 }), poolBalanceFen: () => 0, isUserActive: () => true, releaseOrder: noop },
    dividend: { dailyPayout: () => { payoutCalls += 1; return { paidFen: 0 }; } },
    withdraw: { expireStaleTransfers: noop, issueQueuedWithdrawals: noop },
    commission: { settleDue: () => [] },
    merchant: { releaseExpiredAdSlots: () => [] },
    fulfillment: { autoReceiveShipped: () => [] },
    upload: { purgeExpiredQuota: noop },
  };
  createDailyJobs(ctx).runDailyJobsOnce();
  assert.strictEqual(payoutCalls, 1);
  // 模拟进程重启：新实例内存状态为空，同日再跑应被持久化幂等键拦截
  createDailyJobs(ctx).runDailyJobsOnce();
  assert.strictEqual(payoutCalls, 1, '同日重跑不得再次执行分红等资金步骤');
});

// ---------- 储备专户与季度分红 ----------

test('储备专户：仅白名单来源可划入', () => {
  const db = createStore();
  quarter.reserveDeposit(db, { source: 'ad_revenue', fen: 1000000, ref: 'wx_ad_2026Q4' });
  assert.throws(() => quarter.reserveDeposit(db, { source: 'user_deposit', fen: 100 }), /not allowed/);
  assert.strictEqual(quarter.reserveBalanceFen(db), 1000000);
});

test('贡献分单位参考价值 = 储备×0.6÷流通分总量（只读公示）', () => {
  const db = createStore();
  quarter.reserveDeposit(db, { source: 'ad_revenue', fen: 100000000, ref: 'q4' }); // 100 万元
  db.contributions.insert({ id: 'u1', weight: 6000000 });
  db.contributions.insert({ id: 'u2', weight: 4000000 });
  // 100 万元 × 0.6 ÷ 1000 万分 = 0.06 元 = 6 分
  assert.strictEqual(quarter.contributionUnitValueFen(db), 6);
  // 储备增至 150 万元（+50 万），流通分不变 -> 0.09 元 = 9 分
  quarter.reserveDeposit(db, { source: 'trade_service_fee', fen: 50000000, ref: 'q1' });
  assert.strictEqual(quarter.contributionUnitValueFen(db), 9);
  // 关闭公示开关 -> null（无任何兑付入口）
  db.switches.set('contributionValuePublishEnabled', false);
  assert.strictEqual(quarter.contributionUnitValueFen(db), null);
});

test('季度分红资格三门槛：同时达标（V3.3 §4.8-6）', () => {
  const db = createStore();
  const thresholds = {
    consumptionFenByLevel: { V1: 500000, V2: 3000000, V3: 15000000 },
    activeRatio: 0.15,
    adSpendFenByLevel: { V1: 0, V2: 100000 },
  };
  const rows = quarter.assessQuarterEligibility(db, {
    quarter: '2026Q4',
    userLevels: { a: 'V2', b: 'V2', c: 'V1' },
    candidates: [
      { userId: 'a', quarterConsumptionFen: 3000000, activeUserRatio: 0.20, adSpendFen: 100000 }, // 全达标
      { userId: 'b', quarterConsumptionFen: 2999999, activeUserRatio: 0.20, adSpendFen: 100000 }, // 业绩不足
      { userId: 'c', quarterConsumptionFen: 600000, activeUserRatio: 0.10, adSpendFen: 0 },       // 活跃不足
    ],
    thresholds,
  });
  assert.strictEqual(rows[0].eligible, true);
  assert.strictEqual(rows[1].eligible, false);
  assert.strictEqual(rows[2].eligible, false);
});

test('季度分红权重：业绩60%+活跃25%+广告贡献15%，×规模系数封顶3，金额守恒', () => {
  const db = createStore();
  db.earnings.insert({ id: 'a', balanceFen: 0, frozenFen: 0, dividendBalanceFen: 0 });
  db.earnings.insert({ id: 'b', balanceFen: 0, frozenFen: 0, dividendBalanceFen: 0 });
  const payouts = quarter.quarterPayout(db, {
    quarter: '2026Q4', poolFen: 600000,
    weights: [
      { userId: 'a', performance: 1.0, activity: 1.0, adContribution: 1.0 },
      { userId: 'b', performance: 0.0, activity: 0.0, adContribution: 0.0 },
    ],
    scaleCoefficients: { a: 3 },
  });
  assert.strictEqual(payouts.reduce((s, p) => s + p.fen, 0), 600000);
  assert.strictEqual(payouts[0].fen, 600000); // b 权重 0
  // 分红入消费余额（默认不可提现，待确认 5）
  assert.strictEqual(db.earnings.get('a').dividendBalanceFen, 600000);
});
