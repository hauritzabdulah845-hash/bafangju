'use strict';
/**
 * 提现与结算（商家转账记账模拟，V3.3 §4.5/§6/待确认 19）—— 合规要点：
 * - 分佣不入微信分账，累计在收益账户余额；提现走"商家转账"通道（生产替换真实 API，本层只做记账与限额）；
 * - 单笔上限（默认 500 元）、单日单用户上限（默认 2000 元）：超限自动拆笔/顺延次日发放；
 * - 每笔转账后进入"待用户确认收款"状态，超时未确认 → 退回余额并自动重发；
 * - 有挂账（debtFen>0 / withdrawBlocked）的账户禁止提现（§4.7 退款扣回护栏）；
 * - 全链路幂等 + 审计，账实分离：本模块只改记账余额，真实资金变动由转账回执驱动。
 */
const { audit } = require('../store');
const bizdate = require('./bizdate');

/** 站内消息（§5.1 消息中心兜底通道） */
function pushMsg(db, userId, type, title, body) {
  db.messages.insert({ userId: String(userId), type, title, body, ts: new Date().toISOString(), read: false });
}

function switchVal(db, key) { return db.switches.get(key); }

/**
 * 绑定/换绑提现收款人（微信商家转账必需 openid，V3.3 §6/待确认 19）。
 * - openid 来源：小程序端 wx.login -> code2session（生产）；管理后台补录（过渡）；
 * - 同一 openid 允许属不同账户（微信侧允许）；换绑覆盖旧值并留审计；
 * - 绑定信息存收益账户行（一人一收款账户，随账户持久化）。
 */
function bindReceiver(db, { userId, openid, name, operator = 'self' }) {
  if (!db.users.get(userId) && !db.merchants.get(userId)) throw new Error('收款账户不存在（用户或商家）');
  if (!openid || typeof openid !== 'string' || openid.length < 20 || openid.length > 128) {
    throw new Error('openid 格式非法（长度 20-128）');
  }
  const acc = db.earnings.get(userId) || db.earnings.insert({ id: String(userId), userId: String(userId), balanceFen: 0, dividendBalanceFen: 0, frozenFen: 0 });
  const old = { openid: acc.receiverOpenid || null, name: acc.receiverName || null };
  acc.receiverOpenid = openid;
  acc.receiverName = name || null;
  acc.receiverBoundAt = new Date().toISOString();
  audit(db, operator, 'withdraw.bind_receiver', {
    userId, name: name || null, oldOpenid: old.openid, changed: !!(old.openid && old.openid !== openid),
  });
  return { userId: String(userId), openid, name: acc.receiverName, boundAt: acc.receiverBoundAt, changed: !!(old.openid && old.openid !== openid) };
}

/** 查询收款人绑定状态 */
function receiverOf(db, userId) {
  const acc = db.earnings.get(userId);
  return {
    userId,
    bound: !!(acc && acc.receiverOpenid),
    openid: acc ? acc.receiverOpenid : null,
    name: acc ? acc.receiverName : null,
    boundAt: acc ? acc.receiverBoundAt : null,
  };
}

/** 某用户某日已发放金额（分）—— 日限额口径按转账发放日计 */
function dailyIssuedFen(db, userId, date) {
  return db.withdrawTransfers.where((t) => t.userId === userId && t.issueDate === date
    && ['transferred_pending_confirm', 'confirmed'].includes(t.status))
    .reduce((s, t) => s + t.fen, 0);
}

/** 申请提现：余额扣减 → 生成提现单（待审核）。幂等。 */
function applyWithdraw(db, { userId, fen, idempotencyKey }) {
  if (switchVal(db, 'withdrawEnabled') !== true) {
    throw new Error('提现通道尚未开通（商户入驻满 90 天后开放，敬请关注公告）');
  }
  if (!Number.isInteger(fen) || fen < switchVal(db, 'withdrawMinFen')) {
    throw new Error(`提现金额须为整数分且不低于最低限额（${switchVal(db, 'withdrawMinFen')} 分）`);
  }
  const { value: request, replay } = db.idempotency.run(`withdraw:${idempotencyKey}`, () => {
    const acc = db.earnings.get(userId);
    if (!acc || acc.balanceFen < fen) throw new Error('收益账户余额不足');
    if (acc.withdrawBlocked || (acc.debtFen || 0) > 0) throw new Error('账户存在挂账，暂不可提现（请联系客服处理）');
    acc.balanceFen -= fen;
    acc.withdrawFrozenFen = (acc.withdrawFrozenFen || 0) + fen;
    const req = db.withdrawRequests.insert({
      userId, fen, status: 'pending_review', // pending_review -> approved(发放中) -> done | rejected
      remainingFen: fen,
      appliedAt: new Date().toISOString(),
    });
    db.earningFlows.insert({ userId, fen, status: 'withdraw_freeze', ref: `withdraw:${req.id}`, ts: new Date().toISOString() });
    audit(db, userId, 'withdraw.apply', { requestId: req.id, fen });
    return req;
  });
  return { request, replay };
}

/** 审核通过：按单笔/单日限额拆笔发放；当日额度不足的部分留在单内顺延（由 jobs/issue-queued 次日再发）。 */
function approveWithdraw(db, { requestId, operator = 'admin', date }) {
  const req = db.withdrawRequests.get(requestId);
  if (!req || req.status !== 'pending_review') throw new Error('提现单状态不可审核');
  req.status = 'approved';
  audit(db, operator, 'withdraw.approve', { requestId });
  return issueQueuedWithdrawals(db, { requestId, date });
}

/**
 * 对"发放中"提现单执行拆笔发放（幂等：按单内已发笔数推进）。
 * 返回 { issuedFen, deferredFen, done }。
 */
function issueQueuedWithdrawals(db, { requestId, date }) {
  const req = db.withdrawRequests.get(requestId);
  if (!req) throw new Error('提现单不存在');
  if (!['approved', 'issuing'].includes(req.status)) throw new Error('提现单状态不可发放');
  const issueDate = date || bizdate.today();
  const perTxn = switchVal(db, 'withdrawPerTxnLimitFen');
  const dailyCap = switchVal(db, 'withdrawDailyLimitFen');
  let quota = dailyCap - dailyIssuedFen(db, req.userId, issueDate);
  let issuedFen = 0;
  while (req.remainingFen > 0 && quota >= Math.min(perTxn, req.remainingFen)) {
    const fen = Math.min(perTxn, req.remainingFen, quota);
    // 收款人 openid 随单携带（真实转账通道必需；缺失时由 hook 标记 submit_failed，补录后重试）
    const recAcc = db.earnings.get(req.userId);
    const t = db.withdrawTransfers.insert({
      requestId, userId: req.userId, fen,
      status: 'transferred_pending_confirm', // -> confirmed | expired_refunded | submit_failed
      issueDate,
      transferNo: `TX${Date.now()}${Math.floor(Math.random() * 1000)}`,
      receiverOpenid: (recAcc && recAcc.receiverOpenid) || null,
      receiverName: (recAcc && recAcc.receiverName) || null,
      issuedAt: new Date().toISOString(),
      confirmDeadline: Date.now() + switchVal(db, 'transferConfirmTimeoutHours') * 3600 * 1000,
    });
    // 真实转账通道挂接时自动提交（wechat provider；mock/未挂接保持记账即发放）
    if (typeof db._transferHook === 'function') {
      try { db._transferHook(t); } catch (e) {
        t.status = 'submit_failed';
        t.submitError = String(e.message || e);
      }
    }
    req.remainingFen -= fen;
    quota -= fen;
    issuedFen += fen;
  }
  if (issuedFen > 0) {
    req.status = 'issuing';
    pushMsg(db, req.userId, 'withdraw_issued', '提现已发起',
      `本期已发放 ${(issuedFen / 100).toFixed(2)} 元，请在 ${switchVal(db, 'transferConfirmTimeoutHours')} 小时内确认收款，超时自动退回并重发。`);
    audit(db, 'system', 'withdraw.issue', { requestId, issueDate, issuedFen });
  }
  if (req.remainingFen === 0) {
    req.status = 'done';
    const acc = db.earnings.get(req.userId);
    acc.withdrawFrozenFen -= req.fen;
    audit(db, 'system', 'withdraw.done', { requestId, fen: req.fen });
  }
  return { issuedFen, deferredFen: req.remainingFen, done: req.status === 'done' };
}

/** 用户确认收款：单笔转账完成 */
function confirmTransfer(db, { transferId, userId }) {
  const t = db.withdrawTransfers.get(transferId);
  if (!t) throw new Error('转账记录不存在');
  if (userId && t.userId !== userId) throw new Error('无权操作该转账');
  if (t.status !== 'transferred_pending_confirm') throw new Error('转账状态不可确认');
  t.status = 'confirmed';
  t.confirmedAt = new Date().toISOString();
  pushMsg(db, t.userId, 'withdraw_done', '提现已完成', `${(t.fen / 100).toFixed(2)} 元转账已确认收款。`);
  audit(db, t.userId, 'withdraw.confirm', { transferId, fen: t.fen });
  return t;
}

/** 超时退回跑批：待确认超时的转账退回"提现冻结"并自动重发（重发受当日限额约束，不足部分继续顺延） */
function expireStaleTransfers(db, { now = Date.now(), date } = {}) {
  const issueDate = date || bizdate.today();
  let expiredFen = 0;
  const stale = db.withdrawTransfers.where((t) => t.status === 'transferred_pending_confirm' && t.confirmDeadline < now);
  const affectedRequests = new Set();
  for (const t of stale) {
    t.status = 'expired_refunded';
    // 资金回到提现冻结（提现承诺未完成，不退回可支配余额，防止双计）
    const acc = db.earnings.get(t.userId);
    acc.withdrawFrozenFen += t.fen;
    expiredFen += t.fen;
    const req = db.withdrawRequests.get(t.requestId);
    if (req) {
      req.status = 'approved'; // 重新进入发放流程
      req.remainingFen += t.fen;
      affectedRequests.add(req.id);
    }
    pushMsg(db, t.userId, 'withdraw_expired', '转账超时已退回',
      `${(t.fen / 100).toFixed(2)} 元转账超时未确认，已退回并自动重发，请在收到后及时确认收款。`);
    audit(db, 'system', 'withdraw.expire_refund', { transferId: t.id, fen: t.fen });
  }
  const reissued = [];
  for (const requestId of affectedRequests) {
    reissued.push(issueQueuedWithdrawals(db, { requestId, date: issueDate }));
  }
  return { expiredCount: stale.length, expiredFen, reissued };
}

/** 提现单进度查询 */
function withdrawStatus(db, userId) {
  const requests = db.withdrawRequests.where((r) => r.userId === userId)
    .sort((a, b) => (a.appliedAt < b.appliedAt ? 1 : -1));
  const transfers = db.withdrawTransfers.where((t) => t.userId === userId)
    .sort((a, b) => (a.issuedAt < b.issuedAt ? 1 : -1));
  const acc = db.earnings.get(userId) || {};
  return {
    requests,
    transfers,
    balanceFen: acc.balanceFen || 0,
    withdrawFrozenFen: acc.withdrawFrozenFen || 0,
    withdrawEnabled: switchVal(db, 'withdrawEnabled') === true,
    limits: {
      perTxnFen: switchVal(db, 'withdrawPerTxnLimitFen'),
      dailyFen: switchVal(db, 'withdrawDailyLimitFen'),
      minFen: switchVal(db, 'withdrawMinFen'),
    },
  };
}

module.exports = { applyWithdraw, approveWithdraw, issueQueuedWithdrawals, confirmTransfer, expireStaleTransfers, dailyIssuedFen, withdrawStatus, bindReceiver, receiverOf };
