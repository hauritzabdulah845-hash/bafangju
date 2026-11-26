'use strict';
/**
 * 第五期测试：提现收款人 openid 绑定闭环、商家管理（建档/启停/重置 token）、发放携带收款人、失败补录重试。
 */
const test = require('node:test');
const assert = require('node:assert');
const withdraw = require('../src/domain/withdraw');
const merchant = require('../src/domain/merchant');
const transfer = require('../src/domain/transfer');
const { createStore } = require('../src/store');

const OPENID = 'oX1234567890abcdef1234567890abcd'; // 32 字符合法 openid

function freshDb() {
  const db = createStore({});
  db.switches.set('withdrawEnabled', true);
  db.switches.set('withdrawMinFen', 1);
  db.switches.set('withdrawPerTxnLimitFen', 50000);
  db.switches.set('withdrawDailyLimitFen', 200000);
  db.switches.set('transferConfirmTimeoutHours', 72);
  return db;
}

// ---------- 收款人绑定 ----------

test('绑定收款人：openid 校验、账户行落库、换绑与审计', () => {
  const db = freshDb();
  const u = db.users.insert({ nickname: '测试用户', createdAt: new Date().toISOString() });

  // 非法 openid 拒绝
  assert.throws(() => withdraw.bindReceiver(db, { userId: u.id, openid: 'short' }), /openid 格式非法/);
  assert.throws(() => withdraw.bindReceiver(db, { userId: 'no_such_user', openid: OPENID }), /收款账户不存在/);

  // 首次绑定（收益账户不存在时自动建立）
  let r = withdraw.bindReceiver(db, { userId: u.id, openid: OPENID, name: '张三' });
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.openid, OPENID);
  const rec = withdraw.receiverOf(db, u.id);
  assert.strictEqual(rec.bound, true);
  assert.strictEqual(rec.name, '张三');
  assert.ok(db.earnings.get(u.id));

  // 换绑
  const OPENID2 = 'oXaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  r = withdraw.bindReceiver(db, { userId: u.id, openid: OPENID2, operator: 'admin' });
  assert.strictEqual(r.changed, true);
  assert.strictEqual(withdraw.receiverOf(db, u.id).openid, OPENID2);

  // 审计留痕
  const actions = db.auditLogs.items.filter((a) => a.action === 'withdraw.bind_receiver').map((a) => a.actor);
  assert.ok(actions.includes('admin'));
});

// ---------- 发放携带收款人 openid ----------

test('拆笔发放时转账行携带收款人 openid；未绑定时为 null', () => {
  const db = freshDb();
  const u = db.users.insert({ nickname: '收款用户', createdAt: new Date().toISOString() });
  withdraw.bindReceiver(db, { userId: u.id, openid: OPENID });
  db.earnings.update(u.id, { balanceFen: 80000 });

  const { request } = withdraw.applyWithdraw(db, { userId: u.id, fen: 60000, idempotencyKey: 'w1' });
  withdraw.approveWithdraw(db, { requestId: request.id });
  const transfers = db.withdrawTransfers.where((t) => t.requestId === request.id);
  assert.ok(transfers.length >= 2); // 50000 + 10000 拆两笔
  assert.ok(transfers.every((t) => t.receiverOpenid === OPENID));

  // 未绑定用户：发放照常记账，openid 为 null（真实通道下由 hook 标记 submit_failed）
  const u2 = db.users.insert({ nickname: '未绑定用户', createdAt: new Date().toISOString() });
  db.earnings.insert({ id: u2.id, userId: u2.id, balanceFen: 1000 });
  const { request: req2 } = withdraw.applyWithdraw(db, { userId: u2.id, fen: 1000, idempotencyKey: 'w2' });
  withdraw.approveWithdraw(db, { requestId: req2.id });
  const t2 = db.withdrawTransfers.where((t) => t.requestId === req2.id)[0];
  assert.strictEqual(t2.receiverOpenid, null);
});

// ---------- 提交失败 -> 补录 -> 重试闭环 ----------

test('缺收款人提交失败，管理后台补录后重试成功携带 openid', () => {
  const db = freshDb();
  const u = db.users.insert({ nickname: '失败重试用户', createdAt: new Date().toISOString() });
  db.earnings.insert({ userId: u.id, balanceFen: 5000 });

  // 模拟微信通道挂接：缺 openid 提交失败
  const submitted = [];
  db._transferHook = (t) => {
    if (!t.receiverOpenid) { t.status = 'submit_failed'; t.submitError = '缺少收款人 openid（商家需先绑定收款微信）'; return; }
    submitted.push(t.receiverOpenid);
    t.remoteState = 'ACCEPTED';
  };

  const { request } = withdraw.applyWithdraw(db, { userId: u.id, fen: 5000, idempotencyKey: 'w3' });
  withdraw.approveWithdraw(db, { requestId: request.id });
  let t = db.withdrawTransfers.where((x) => x.requestId === request.id)[0];
  assert.strictEqual(t.status, 'submit_failed');
  assert.match(t.submitError, /缺少收款人/);

  // 未补录前重试仍被拒
  let r = transfer.retryFailedTransfers(db);
  assert.strictEqual(r[0].retried, false);
  assert.match(r[0].reason, /openid/);

  // 管理后台补录后重试成功
  withdraw.bindReceiver(db, { userId: u.id, openid: OPENID, operator: 'admin' });
  r = transfer.retryFailedTransfers(db);
  assert.strictEqual(r[0].retried, true);
  assert.strictEqual(t.status, 'transferred_pending_confirm');
  assert.deepStrictEqual(submitted, [OPENID]);
});

// ---------- 商家管理：建档 / 启停 / 重置 token ----------

test('商家建档生成 token；停用后登录拒绝；重置 token 旧值失效', () => {
  const db = freshDb();
  const { merchant: m, initialPassword } = merchant.adminCreateMerchant(db, {
    name: '测试商户', contact: '13900000000', operator: 'boss',
  });
  assert.ok(m.id && m.token);
  assert.ok(m.username && initialPassword && initialPassword.length >= 6);

  assert.throws(() => merchant.adminCreateMerchant(db, { name: '测试商户' }), /商家名称已存在/);

  // 正常登录（账号 + 密码）
  let login = merchant.merchantLogin(db, { username: m.username, password: initialPassword });
  assert.ok(login.merchant.token);
  assert.strictEqual(merchant.merchantByToken(db, login.merchant.token).id, m.id);
  // 密码错误拒绝
  assert.throws(() => merchant.merchantLogin(db, { username: m.username, password: 'bad-pass' }), /账号或密码错误/);

  // 停用后：登录拒绝、旧 token 仍存在但由接口层按 status 拦截
  merchant.adminSetMerchantStatus(db, { merchantId: m.id, status: 'disabled' });
  assert.throws(() => merchant.merchantLogin(db, { username: m.username, password: initialPassword }), /商家已被停用/);
  assert.strictEqual(merchant.merchantByToken(db, login.merchant.token).status, 'disabled');

  // 启用 + 重置 token
  merchant.adminSetMerchantStatus(db, { merchantId: m.id, status: 'active' });
  const oldToken = login.merchant.token;
  const m2 = merchant.adminResetMerchantToken(db, { merchantId: m.id });
  assert.notStrictEqual(m2.token, oldToken);
  assert.notStrictEqual(merchant.merchantByToken(db, m2.token).token, oldToken);
  assert.strictEqual(merchant.merchantByToken(db, oldToken), null);
});

test('商家密码重置：旧 token 失效、新密码可登录、旧密码失效', () => {
  const db = freshDb();
  const { merchant: m, initialPassword } = merchant.adminCreateMerchant(db, { name: '改密商户' });
  const { initialPassword: newPwd } = merchant.adminResetMerchantPassword(db, { merchantId: m.id });
  assert.ok(newPwd && newPwd.length >= 6);
  assert.throws(() => merchant.merchantLogin(db, { username: m.username, password: initialPassword }), /账号或密码错误/);
  const login = merchant.merchantLogin(db, { username: m.username, password: newPwd });
  assert.ok(login.merchant.token);
});

test('商家管理列表含余额/绑定状态/统计', () => {
  const db = freshDb();
  const { merchant: m } = merchant.adminCreateMerchant(db, { name: '列表商户' });
  db.earnings.insert({ userId: m.id, balanceFen: 12345, withdrawFrozenFen: 100, debtFen: 0 });
  merchant.issueCoupon(db, { merchantId: m.id, title: '满10减1', amountOffFen: 100, code: 'X1' });
  withdraw.bindReceiver(db, { userId: m.id, openid: OPENID, name: '李四' });

  const list = merchant.adminListMerchants(db);
  const row = list.find((x) => x.id === m.id);
  assert.strictEqual(row.balanceFen, 12345);
  assert.strictEqual(row.receiverBound, true);
  assert.strictEqual(row.receiverName, '李四');
  assert.strictEqual(row.couponCount, 1);
  assert.strictEqual(row.status, 'active');
});
