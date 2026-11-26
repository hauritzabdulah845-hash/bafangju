'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createStore } = require('../src/store');
const commission = require('../src/domain/commission');

const PLAN = { platform: 0.02, leader: 0.08, direct: 0.70, indirect: 0.20 };

test('分佣拆分资金守恒：合计 = 基数（尾差入平台服务费）', () => {
  const s = commission.calcCommission(12345, PLAN, true);
  assert.strictEqual(s.platform + s.direct + s.indirect + s.leader, 12345);
});

test('间推默认关闭：份额转入分红池，间推不记账', () => {
  const s = commission.calcCommission(10000, PLAN, false);
  assert.strictEqual(s.indirect, 0);
  assert.strictEqual(s.indirectToPool, 2000);
  assert.strictEqual(s.platform + s.direct + s.leader + s.indirectToPool, 10000);
});

test('记账冻结 -> 售后期结算入余额', () => {
  const db = createStore();
  const { toPoolFen } = commission.bookCommission(db, {
    orderId: 'o1', baseFen: 10000, plan: PLAN, indirectEnabled: false,
    directUserId: 'u_direct', leaderUserId: 'L1',
  });
  assert.strictEqual(toPoolFen, 2200); // 平台 2% + 间推 20%
  const acc = db.earnings.get('u_direct');
  assert.strictEqual(acc.frozenFen, 7000);
  commission.settleOrder(db, 'o1');
  assert.strictEqual(acc.frozenFen, 0);
  assert.strictEqual(acc.balanceFen, 7000);
});

test('团队长份额：有归属才入辅导池，无归属归平台留存（V3.4 修正沉淀）', () => {
  const db = createStore();
  commission.bookCommission(db, { orderId: 'o1', baseFen: 10000, plan: PLAN, indirectEnabled: false, directUserId: 'u1', leaderUserId: 'L1' });
  const noLeader = commission.bookCommission(db, { orderId: 'o2', baseFen: 1000, plan: PLAN, indirectEnabled: false, directUserId: 'u2', leaderUserId: null });
  assert.strictEqual(commission.leaderPoolBalanceFen(db), 800); // 只有 10000×8% 进池
  assert.strictEqual(noLeader.unattributedFen, 80); // 无团队长：8% 归平台留存，不再永久沉淀
  const contribs = commission.leaderContributions(db);
  assert.strictEqual(contribs.get('L1'), 800);
});

test('退款按单回滚：不足部分挂账并限制提现（周期不重算）', () => {
  const db = createStore();
  commission.bookCommission(db, { orderId: 'o2', baseFen: 1000, plan: PLAN, indirectEnabled: false, directUserId: 'u1', leaderUserId: 'L1' });
  commission.settleOrder(db, 'o2');
  // 模拟用户已提现大部分：余额清零
  db.earnings.get('u1').balanceFen = 0;
  const rb = commission.rollbackOrder(db, 'o2');
  assert.strictEqual(rb.results[0].shortfallFen, 700);
  const acc = db.earnings.get('u1');
  assert.strictEqual(acc.debtFen, 700);
  assert.strictEqual(acc.withdrawBlocked, true);
});

test('团队长池按贡献权重分配（§4.8-11）', () => {
  const amounts = commission.distributeLeaderPool(null, 800, [
    { contributionFen: 300, coefficient: 1 },
    { contributionFen: 100, coefficient: 1 },
  ]);
  assert.strictEqual(amounts.reduce((a, b) => a + b, 0), 800);
  assert.strictEqual(amounts[0], 600);
  assert.strictEqual(amounts[1], 200);
});
