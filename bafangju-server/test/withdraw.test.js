'use strict';
/**
 * 提现与结算合规测试：
 * 1) 未开通提现时拒绝；2) 挂账账户禁止提现；3) 单笔拆笔 ≤500 元；
 * 4) 单日单用户 ≤2000 元，超出顺延次日；5) 待确认收款超时退回并自动重发；
 * 6) 全程资金守恒（余额+冻结+已发 = 初始）。
 */
const test = require('node:test');
const assert = require('node:assert');
const { createStore } = require('../src/store');
const withdraw = require('../src/domain/withdraw');

function fundUser(db, userId, balanceFen) {
  db.earnings.insert({ id: userId, balanceFen, frozenFen: 0 });
}

test('提现通道未开通时拒绝（上线初期合规默认）', () => {
  const db = createStore();
  fundUser(db, 'u1', 100000);
  assert.throws(() => withdraw.applyWithdraw(db, { userId: 'u1', fen: 5000, idempotencyKey: 'a1' }), /尚未开通/);
});

test('挂账/风控账户禁止提现', () => {
  const db = createStore();
  db.switches.set('withdrawEnabled', true);
  fundUser(db, 'u1', 100000);
  db.earnings.get('u1').withdrawBlocked = true;
  assert.throws(() => withdraw.applyWithdraw(db, { userId: 'u1', fen: 5000, idempotencyKey: 'a2' }), /挂账/);
});

test('单笔拆笔 + 单日限额：6000 元 → 当日 4 笔（2000 元封顶），其余顺延 2 天发完', () => {
  const db = createStore();
  db.switches.set('withdrawEnabled', true);
  fundUser(db, 'u1', 600000);
  const { request } = withdraw.applyWithdraw(db, { userId: 'u1', fen: 600000, idempotencyKey: 'a3' });
  const r1 = withdraw.approveWithdraw(db, { requestId: request.id, date: '2026-10-24' });
  let txs = db.withdrawTransfers.where((t) => t.requestId === request.id);
  assert.strictEqual(txs.length, 4); // 当日 2000 元 / 500 元每笔
  assert.ok(txs.every((t) => t.fen === 50000));
  assert.strictEqual(r1.issuedFen, 200000);
  assert.strictEqual(r1.deferredFen, 400000);
  // 次日、第三日补发
  const r2 = withdraw.issueQueuedWithdrawals(db, { requestId: request.id, date: '2026-10-25' });
  assert.strictEqual(r2.issuedFen, 200000);
  const r3 = withdraw.issueQueuedWithdrawals(db, { requestId: request.id, date: '2026-10-26' });
  assert.strictEqual(r3.done, true);
  txs = db.withdrawTransfers.where((t) => t.requestId === request.id);
  assert.strictEqual(txs.length, 12);
  assert.strictEqual(db.earnings.get('u1').balanceFen, 0);
  assert.strictEqual(db.earnings.get('u1').withdrawFrozenFen, 0); // 全部发放，冻结释放
});

test('单日 2000 元上限：3000 元申请 → 当日 2000 元发放，1000 元顺延', () => {
  const db = createStore();
  db.switches.set('withdrawEnabled', true);
  fundUser(db, 'u1', 300000);
  const { request } = withdraw.applyWithdraw(db, { userId: 'u1', fen: 300000, idempotencyKey: 'a4' });
  const r1 = withdraw.approveWithdraw(db, { requestId: request.id, date: '2026-10-24' });
  assert.strictEqual(r1.issuedFen, 200000);
  assert.strictEqual(r1.deferredFen, 100000);
  assert.strictEqual(r1.done, false);
  // 次日跑批补发剩余
  const r2 = withdraw.issueQueuedWithdrawals(db, { requestId: request.id, date: '2026-10-25' });
  assert.strictEqual(r2.issuedFen, 100000);
  assert.strictEqual(r2.done, true);
  // 日内额度校验：10-24 已发 2000 元
  assert.strictEqual(withdraw.dailyIssuedFen(db, 'u1', '2026-10-24'), 200000);
});

test('待确认收款超时：退回余额并自动重发（受日限额约束）', () => {
  const db = createStore();
  db.switches.set('withdrawEnabled', true);
  fundUser(db, 'u1', 150000);
  const { request } = withdraw.applyWithdraw(db, { userId: 'u1', fen: 150000, idempotencyKey: 'a5' });
  withdraw.approveWithdraw(db, { requestId: request.id, date: '2026-10-24' });
  const acc = db.earnings.get('u1');
  // 发放后冻结释放（在途资金由待确认转账承载）；150000 = 3 笔 ×500 元
  assert.strictEqual(acc.balanceFen, 0);
  assert.strictEqual(acc.withdrawFrozenFen, 0);
  assert.strictEqual(db.withdrawTransfers.where((t) => t.status === 'transferred_pending_confirm').length, 3);
  // 超时退回
  const now = Date.now() + 73 * 3600 * 1000;
  const result = withdraw.expireStaleTransfers(db, { now, date: '2026-10-27' });
  assert.strictEqual(result.expiredFen, 150000);
  // 退回后自动重发成功（新日期额度充足）
  assert.strictEqual(db.withdrawTransfers.where((t) => t.status === 'transferred_pending_confirm').length, 3);
  assert.strictEqual(acc.balanceFen, 0);
  // 确认收款完成
  for (const t of db.withdrawTransfers.where((t) => t.status === 'transferred_pending_confirm')) {
    withdraw.confirmTransfer(db, { transferId: t.id });
  }
  assert.strictEqual(acc.withdrawFrozenFen, 0);
});

test('资金守恒：申请-退回-重发全程 余额+冻结+已发 = 初始', () => {
  const db = createStore();
  db.switches.set('withdrawEnabled', true);
  fundUser(db, 'u1', 80000);
  const init = 80000;
  const { request } = withdraw.applyWithdraw(db, { userId: 'u1', fen: 80000, idempotencyKey: 'a6' });
  withdraw.approveWithdraw(db, { requestId: request.id, date: '2026-10-24' });
  withdraw.expireStaleTransfers(db, { now: Date.now() + 100 * 3600 * 1000, date: '2026-10-28' });
  const acc = db.earnings.get('u1');
  const issued = db.withdrawTransfers.where((t) => t.userId === 'u1' && t.status !== 'expired_refunded').reduce((s, t) => s + t.fen, 0);
  assert.strictEqual(acc.balanceFen + acc.withdrawFrozenFen + issued, init);
});
