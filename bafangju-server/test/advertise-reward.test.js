'use strict';
/**
 * 广告激励（V4.0）单测：计费联动 / 双幂等与 IP 去重 / 预算封顶 / 实名 / 提现状态机 / 个税。
 * 2026-11 合规整改：完播奖励改发贡献值（不可提现）；现金账本仅保留历史余额兑付路径。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { createStore } = require('../src/store');
const adReward = require('../src/domain/adReward');
const bizdate = require('../src/domain/bizdate');

function setup() {
  const db = createStore({});
  db.merchants.insert({ id: 'm1', name: '测试商家' });
  // B1：现金提现默认关闭（首期），本组用例显式开启以覆盖历史余额兑付路径
  db.switches.set('adRewardEnabled', true);
  return db;
}
function mkUser(db, id, hoursAgo = 48) {
  db.users.insert({ id, nickname: 'u' + id, createdAt: new Date(Date.now() - hoursAgo * 3600e3).toISOString() });
}
function mkActiveVideo(db, { budgetFen = 100000, charge = 60, durationS = 10, dailyCap = 1000 } = {}) {
  const v = adReward.createVideo(db, {
    merchantId: 'm1', title: '测试广告', videoUrl: '/uploads/a.mp4', durationS,
    productId: '', budgetFen, chargePerIpFen: charge, dailyCap,
  });
  adReward.reviewVideo(db, { videoId: v.id, approved: true });
  return db.adVideos.get(v.id);
}
const HOUR = 3600e3;

describe('计费参数联动', () => {
  test('预算÷单IP费用=所需IP数；奖励=费用×分成比例', () => {
    const db = setup();
    const d = adReward.derivePricing(db, 100000, 60);
    assert.strictEqual(d.rewardPerIpFen, 24);   // 60 × 0.4
    assert.strictEqual(d.targetIpCount, 1666);  // floor(100000/60)
  });
  test('非法参数拒绝', () => {
    const db = setup();
    assert.throws(() => adReward.derivePricing(db, 50, 60), /总预算/);
    assert.throws(() => adReward.derivePricing(db, 1000, 5), /单 IP 费用/);
  });
});

describe('观看与发放（双幂等 + IP 去重）', () => {
  test('时长不足拦截，足时发放贡献值（不再发现金）', () => {
    const db = setup();
    const v = mkActiveVideo(db);
    mkUser(db, 'u1');
    const ip = '1.2.3.4';
    adReward.startWatch(db, { videoId: v.id, userId: 'u1', ip, now: Date.now() });
    assert.throws(() => adReward.reward(db, { videoId: v.id, userId: 'u1', ip, now: Date.now() + 1000 }), /观看时长不足/);
    const r = adReward.reward(db, { videoId: v.id, userId: 'u1', ip, now: Date.now() + 9.6 * 1000 });
    assert.strictEqual(r.points, 24);
    assert.strictEqual(r.weight, 24);
    assert.strictEqual(r.replay, false);
    // 合规整改：奖励不再入现金账本
    assert.strictEqual(db.users.get('u1').cashBalanceFen || 0, 0);
    assert.strictEqual(db.contributionFlows.where((f) => f.userId === 'u1' && f.taskType === `adVideo:${v.id}`).length, 1);
  });
  test('同用户同广告重复领取拦截；reward 重放幂等', () => {
    const db = setup();
    const v = mkActiveVideo(db);
    mkUser(db, 'u1');
    adReward.startWatch(db, { videoId: v.id, userId: 'u1', ip: '1.1.1.1', now: Date.now() });
    adReward.reward(db, { videoId: v.id, userId: 'u1', ip: '1.1.1.1', now: Date.now() + 10e3 });
    assert.throws(() => adReward.startWatch(db, { videoId: v.id, userId: 'u1', ip: '1.1.1.1', now: Date.now() }), /已领取过/);
    const r = adReward.reward(db, { videoId: v.id, userId: 'u1', ip: '1.1.1.1', now: Date.now() + 10e3 });
    assert.strictEqual(r.replay, true, '重放返回首次结果且不重复入账');
    assert.strictEqual(db.contributions.get('u1').weight, 24);
    assert.strictEqual(db.users.get('u1').cashBalanceFen || 0, 0, '重放不产生现金入账');
  });
  test('同 IP 同广告每日只发一次（跨用户）', () => {
    const db = setup();
    const v = mkActiveVideo(db);
    mkUser(db, 'u1'); mkUser(db, 'u2');
    adReward.startWatch(db, { videoId: v.id, userId: 'u1', ip: '9.9.9.9', now: Date.now() });
    adReward.reward(db, { videoId: v.id, userId: 'u1', ip: '9.9.9.9', now: Date.now() + 10e3 });
    assert.throws(() => adReward.startWatch(db, { videoId: v.id, userId: 'u2', ip: '9.9.9.9', now: Date.now() }), /网络地址今日已领取/);
  });
  test('新用户冷却期拦截', () => {
    const db = setup();
    const v = mkActiveVideo(db);
    mkUser(db, 'u9', 1); // 1 小时前注册
    assert.throws(() => adReward.startWatch(db, { videoId: v.id, userId: 'u9', ip: '8.8.8.8', now: Date.now() }), /24 小时/);
  });
  test('每用户每日全站次数上限', () => {
    const db = setup();
    db.switches.set('adRewardDailyLimit', 2);
    mkUser(db, 'u1');
    for (let i = 0; i < 2; i++) {
      const v = mkActiveVideo(db);
      adReward.startWatch(db, { videoId: v.id, userId: 'u1', ip: `10.0.0.${i}`, now: Date.now() });
      adReward.reward(db, { videoId: v.id, userId: 'u1', ip: `10.0.0.${i}`, now: Date.now() + 10e3 });
    }
    const v3 = mkActiveVideo(db);
    assert.throws(() => adReward.startWatch(db, { videoId: v3.id, userId: 'u1', ip: '10.0.0.9', now: Date.now() }), /次数已达上限/);
  });
  test('预算封顶：IP 数点满自动 sold_out', () => {
    const db = setup();
    const v = mkActiveVideo(db, { budgetFen: 100, charge: 100 }); // 只够 1 个 IP（奖励 ¥0.40）
    mkUser(db, 'u1'); mkUser(db, 'u2');
    adReward.startWatch(db, { videoId: v.id, userId: 'u1', ip: '2.2.2.2', now: Date.now() });
    adReward.reward(db, { videoId: v.id, userId: 'u1', ip: '2.2.2.2', now: Date.now() + 10e3 });
    assert.strictEqual(db.adVideos.get(v.id).status, 'sold_out');
    assert.strictEqual(db.adVideos.get(v.id).claimedIpCount, 1);
    assert.throws(() => adReward.startWatch(db, { videoId: v.id, userId: 'u2', ip: '3.3.3.3', now: Date.now() }), /已抢完|不在投/);
  });
  test('广告跳转商品', () => {
    const db = setup();
    db.products.insert({ id: 'p1', title: '测试商品', priceFen: 990 });
    const v = adReward.createVideo(db, {
      merchantId: 'm1', title: '带跳转', videoUrl: '/uploads/b.mp4', durationS: 10,
      productId: 'p1', budgetFen: 6000, chargePerIpFen: 60, dailyCap: 10,
    });
    adReward.reviewVideo(db, { videoId: v.id, approved: true });
    assert.strictEqual(adReward.productOfVideo(db, v.id).id, 'p1');
    assert.throws(() => adReward.productOfVideo(db, 'nope'), /不在投|不存在/);
  });
});

describe('实名认证', () => {
  test('身份证校验码错误拒绝', () => {
    const db = setup(); mkUser(db, 'u1');
    assert.throws(() => adReward.submitRealname(db, { userId: 'u1', name: '张三', idCard: '110105194912310021' }), /校验失败/);
  });
  test('一人一证一账号', () => {
    const db = setup(); mkUser(db, 'u1'); mkUser(db, 'u2');
    adReward.submitRealname(db, { userId: 'u1', name: '张三', idCard: '11010519491231002X' });
    assert.throws(() => adReward.submitRealname(db, { userId: 'u2', name: '李四', idCard: '11010519491231002X' }), /一人一证/);
  });
});

describe('提现状态机', () => {
  function richUser(db, balanceFen, id = 'w1') {
    mkUser(db, id);
    adReward.submitRealname(db, { userId: id, name: '张三', idCard: '11010519491231002X' });
    // 直接注账（等价于历史奖励已过 T+1）
    adReward.grantCash(db, id, balanceFen, 'seed');
    db.cashLedger.all().forEach((l) => { l.ts = new Date(Date.now() - 25 * HOUR).toISOString(); });
    return db.users.get(id);
  }
  test('未满门槛拒绝；未实名拒绝', () => {
    const db = setup(); mkUser(db, 'w3');
    assert.throws(() => adReward.applyRewardWithdraw(db, { userId: 'w3' }), /实名/);
    richUser(db, 5000, 'w2'); // ¥50 < ¥100
    assert.throws(() => adReward.applyRewardWithdraw(db, { userId: 'w2' }), /满/);
  });
  test('T+1 未到账部分不计入可提现', () => {
    const db = setup();
    richUser(db, 15000);
    adReward.grantCash(db, 'w1', 5000, 'fresh'); // 刚发的 5000 在 T+1 内
    const info = adReward.cashInfo(db, 'w1');
    assert.strictEqual(info.balanceFen, 20000);
    assert.strictEqual(info.withdrawableFen, 15000);
  });
  test('无真实转账通道：初审可过，但复核打款被拒且不标记已打款', async () => {
    const db = setup();
    richUser(db, 15000);
    const w = adReward.applyRewardWithdraw(db, { userId: 'w1', fen: 12000 });
    assert.strictEqual(w.withdrawal.status, 'pending_review');
    assert.strictEqual(db.users.get('w1').cashBalanceFen, 3000); // 冻结扣减
    const first = await adReward.approveRewardWithdraw(db, {
      withdrawalId: w.withdrawal.id, operator: 'admin_a', operatorId: 'uid_a',
    });
    assert.strictEqual(first.status, 'approved', '初审只置已通过，不动资金、不调通道');
    assert.strictEqual(first.reviewedById, 'uid_a');
    assert.strictEqual(db.users.get('w1').cashBalanceFen, 3000, '初审不动资金');
    assert.strictEqual(db.cashLedger.where((l) => l.bizType === 'withdraw_paid').length, 0, '初审不写终态流水');
    await assert.rejects(
      () => adReward.payRewardWithdraw(db, { withdrawalId: w.withdrawal.id, operator: 'admin_b', operatorId: 'uid_b' }),
      /真实转账通道/,
    );
    const after = db.rewardWithdrawals.get(w.withdrawal.id);
    assert.strictEqual(after.status, 'approved', '状态保持待复核打款');
    assert.strictEqual(after.transferNo || '', '');
    assert.strictEqual(after.paidFen, undefined, '不得记已付金额');
  });
  test('两步审核：初审 + 第二人复核打款，个税与实付口径一致且流水成对', async () => {
    const db = setup();
    richUser(db, 15000);
    db._rewardTransferHook = async () => ({ transferNo: 'WX202611130001' });
    const w = adReward.applyRewardWithdraw(db, { userId: 'w1', fen: 12000 });
    const first = await adReward.approveRewardWithdraw(db, {
      withdrawalId: w.withdrawal.id, operator: 'admin_a', operatorId: 'uid_a',
    });
    assert.strictEqual(first.status, 'approved');
    // 同一人复核：即使 ID/用户名都相同也必须拒绝
    await assert.rejects(
      () => adReward.payRewardWithdraw(db, { withdrawalId: w.withdrawal.id, operator: 'admin_a', operatorId: 'uid_a' }),
      /第二个管理员/,
    );
    const paid = await adReward.payRewardWithdraw(db, {
      withdrawalId: w.withdrawal.id, operator: 'admin_b', operatorId: 'uid_b',
    });
    assert.strictEqual(paid.status, 'paid');
    assert.strictEqual(paid.transferNo, 'WX202611130001');
    assert.strictEqual(paid.paidById, 'uid_b');
    assert.strictEqual(paid.paidFen, paid.fen - paid.taxFen, '实付 = 税前 − 个税');
    assert.ok(paid.paidFen > 0);
    const ledger = db.cashLedger.where((l) => l.refId === `rewardWithdraw:${w.withdrawal.id}`);
    assert.deepStrictEqual(ledger.map((l) => [l.bizType, l.delta]), [
      ['withdraw_freeze', -12000], ['withdraw_paid', 0],
    ], '冻结与终态流水均指向本单');
    const actions = db.auditLogs.items.map((x) => x.action);
    assert.ok(actions.includes('adReward.withdraw_approve'), '初审有审计');
    assert.ok(actions.includes('adReward.withdraw_pay'), '复核打款有审计');
    assert.ok(db.auditLogs.items.some((x) => x.action === 'adReward.withdraw_pay' && x.actorId === 'uid_b'),
      '审计同时记录不可变账号 ID');
  });
  test('通道返回 RTMOCK 流水号：保持待复核可重试，修复通道后同一单可再次打款', async () => {
    const db = setup();
    richUser(db, 15000);
    db._rewardTransferHook = () => ({ transferNo: 'RTMOCK123' });
    const w = adReward.applyRewardWithdraw(db, { userId: 'w1', fen: 12000 });
    await adReward.approveRewardWithdraw(db, { withdrawalId: w.withdrawal.id, operator: 'admin_a', operatorId: 'uid_a' });
    await assert.rejects(
      () => adReward.payRewardWithdraw(db, { withdrawalId: w.withdrawal.id, operator: 'admin_b', operatorId: 'uid_b' }),
      /流水号/,
    );
    const after = db.rewardWithdrawals.get(w.withdrawal.id);
    assert.strictEqual(after.status, 'approved', '保持待复核打款，可重试');
    assert.match(after.lastPayError, /流水号/);
    assert.strictEqual(db.users.get('w1').cashBalanceFen, 3000, '不因未核实而退款');
    assert.strictEqual(db.cashLedger.where((l) => l.bizType === 'withdraw_paid').length, 0, '未写终态流水');
    // M8：通道恢复后重试成功，不会重复冻结/退款
    db._rewardTransferHook = async () => ({ transferNo: 'WX202611140010' });
    const retried = await adReward.payRewardWithdraw(db, {
      withdrawalId: w.withdrawal.id, operator: 'admin_b', operatorId: 'uid_b',
    });
    assert.strictEqual(retried.status, 'paid');
    assert.strictEqual(retried.transferNo, 'WX202611140010');
  });
  test('通道失败：置 failed 且资金退回余额', async () => {
    const db = setup();
    richUser(db, 15000);
    db._rewardTransferHook = async () => { throw new Error('通道超时'); };
    const w = adReward.applyRewardWithdraw(db, { userId: 'w1', fen: 12000 });
    await adReward.approveRewardWithdraw(db, { withdrawalId: w.withdrawal.id, operator: 'admin_a', operatorId: 'uid_a' });
    const after = await adReward.payRewardWithdraw(db, {
      withdrawalId: w.withdrawal.id, operator: 'admin_b', operatorId: 'uid_b',
    });
    assert.strictEqual(after.status, 'failed');
    assert.strictEqual(db.users.get('w1').cashBalanceFen, 15000);
    assert.ok(db.auditLogs.items.some((x) => x.action === 'adReward.withdraw_pay_failed' && /通道超时/.test(x.detail)));
  });
  test('审核驳回：冻结退回余额', () => {
    const db = setup();
    richUser(db, 15000);
    const w = adReward.applyRewardWithdraw(db, { userId: 'w1', fen: 12000 });
    const r = adReward.rejectRewardWithdraw(db, { withdrawalId: w.withdrawal.id, note: '风控复核不通过' });
    assert.strictEqual(r.status, 'rejected');
    assert.strictEqual(db.users.get('w1').cashBalanceFen, 15000);
  });
  test('每月次数上限', async () => {
    const db = setup();
    richUser(db, 50000);
    db._rewardTransferHook = () => ({ transferNo: 'WX202611130002' });
    adReward.applyRewardWithdraw(db, { userId: 'w1', fen: 12000 });
    const firstId = db.rewardWithdrawals.all()[0].id;
    await adReward.approveRewardWithdraw(db, { withdrawalId: firstId, operator: 'admin_a', operatorId: 'uid_a' });
    await adReward.payRewardWithdraw(db, { withdrawalId: firstId, operator: 'admin_b', operatorId: 'uid_b' });
    adReward.applyRewardWithdraw(db, { userId: 'w1', fen: 12000 });
    assert.throws(() => adReward.applyRewardWithdraw(db, { userId: 'w1', fen: 12000 }), /次数已达上限/);
  });
  test('单次上限 ¥2000', () => {
    const db = setup();
    richUser(db, 300000);
    assert.throws(() => adReward.applyRewardWithdraw(db, { userId: 'w1', fen: 250000 }), /不超过/);
  });
  test('首期默认关闭：不开放新增现金提现申请', () => {
    const db = createStore({});
    mkUser(db, 'd1');
    adReward.submitRealname(db, { userId: 'd1', name: '张三', idCard: '11010519491231002X' });
    adReward.grantCash(db, 'd1', 20000, 'seed');
    db.cashLedger.all().forEach((l) => { l.ts = new Date(Date.now() - 25 * HOUR).toISOString(); });
    assert.strictEqual(db.switches.get('adRewardEnabled'), false, '默认应为关闭');
    assert.throws(() => adReward.applyRewardWithdraw(db, { userId: 'd1' }), /维护/);
  });
  test('线下打款：登记 → 第二管理员复核 → 已发放；登记阶段不动资金、不写终态流水', () => {
    const db = setup();
    richUser(db, 15000);
    const w = adReward.applyRewardWithdraw(db, { userId: 'w1', fen: 12000 });
    const paidAt = new Date(Date.now() - HOUR).toISOString();
    const marked = adReward.markOfflinePayout(db, {
      withdrawalId: w.withdrawal.id, voucherNo: 'BANK20261114001', paidAt, operator: 'admin_a', note: '柜台转账',
    });
    assert.strictEqual(marked.status, 'pending_offline');
    assert.strictEqual(marked.offlineVoucherNo, 'BANK20261114001');
    assert.strictEqual(marked.offlineMarkedBy, 'admin_a');
    assert.strictEqual(db.users.get('w1').cashBalanceFen, 3000, '登记阶段不退款/不重复扣款');
    assert.strictEqual(db.cashLedger.where((l) => l.bizType === 'withdraw_paid').length, 0, '复核前不得写终态流水');
    assert.strictEqual(adReward.cashInfo(db, 'w1').frozenFen, 12000, '待线下打款仍计入冻结');
    assert.throws(
      () => adReward.confirmOfflinePayout(db, { withdrawalId: w.withdrawal.id, operator: 'admin_a' }),
      /第二个管理员/,
    );
    assert.strictEqual(db.rewardWithdrawals.get(w.withdrawal.id).status, 'pending_offline', '本人复核不得通过');
    const paid = adReward.confirmOfflinePayout(db, { withdrawalId: w.withdrawal.id, operator: 'admin_b' });
    assert.strictEqual(paid.status, 'paid');
    assert.strictEqual(paid.paidFen, paid.fen - paid.taxFen);
    assert.strictEqual(paid.offlineConfirmedBy, 'admin_b');
    assert.ok(paid.paidAt, '打款时间取线下登记时间');
    assert.deepStrictEqual(
      db.cashLedger.where((l) => l.refId === `rewardWithdraw:${w.withdrawal.id}`).map((l) => [l.bizType, l.delta]),
      [['withdraw_freeze', -12000], ['withdraw_paid', 0]],
      '冻结与终态流水均指向本单',
    );
    assert.throws(
      () => adReward.confirmOfflinePayout(db, { withdrawalId: w.withdrawal.id, operator: 'admin_b' }),
      /待线下打款/,
    );
    assert.strictEqual(db.cashLedger.where((l) => l.bizType === 'withdraw_paid').length, 1, '重复复核不重复写流水');
  });
  test('线下打款必填凭证号 / 打款时间 / 操作人', () => {
    const db = setup();
    richUser(db, 15000);
    const w = adReward.applyRewardWithdraw(db, { userId: 'w1', fen: 12000 });
    const paidAt = new Date(Date.now() - HOUR).toISOString();
    assert.throws(() => adReward.markOfflinePayout(db, { withdrawalId: w.withdrawal.id, paidAt, operator: 'a' }), /凭证号/);
    assert.throws(() => adReward.markOfflinePayout(db, { withdrawalId: w.withdrawal.id, voucherNo: 'V1', operator: 'a' }), /打款时间/);
    assert.throws(() => adReward.markOfflinePayout(db, { withdrawalId: w.withdrawal.id, voucherNo: 'V1', paidAt }), /操作人/);
    assert.strictEqual(db.rewardWithdrawals.get(w.withdrawal.id).status, 'pending_review', '校验失败状态不变');
  });
  test('H1 关系校验：复核账号由登记人创建 → 不得复核（线上/线下同一规则）', async () => {
    const db = setup();
    richUser(db, 40000);
    db._rewardTransferHook = async () => ({ transferNo: 'WX202611140011' });
    db.adminUsers.insert({
      id: 'fin01', uid: 'uid_fin01', username: 'fin01', passHash: 'x', permissions: ['finance'],
      enabled: true, createdBy: 'admin_a', createdById: 'uid_a', createdAt: new Date().toISOString(),
    });
    const w = adReward.applyRewardWithdraw(db, { userId: 'w1', fen: 12000 });
    await adReward.approveRewardWithdraw(db, { withdrawalId: w.withdrawal.id, operator: 'admin_a', operatorId: 'uid_a' });
    await assert.rejects(
      () => adReward.payRewardWithdraw(db, { withdrawalId: w.withdrawal.id, operator: 'fin01', operatorId: 'uid_fin01' }),
      /由初审人创建.*第三人/,
    );
    assert.strictEqual(db.rewardWithdrawals.get(w.withdrawal.id).status, 'approved', '关系校验失败状态不变');
    // 线下：登记人 uid_a 登记，同由其创建的 fin01 复核 → 拒绝
    const offline = adReward.applyRewardWithdraw(db, { userId: 'w1', fen: 12000 });
    adReward.markOfflinePayout(db, {
      withdrawalId: offline.withdrawal.id, voucherNo: 'BANK-H1', paidAt: new Date(Date.now() - HOUR).toISOString(),
      operator: 'admin_a', operatorId: 'uid_a',
    });
    assert.throws(
      () => adReward.confirmOfflinePayout(db, {
        withdrawalId: offline.withdrawal.id, operator: 'fin01', operatorId: 'uid_fin01',
      }),
      /由登记人创建.*第三人/,
    );
    assert.strictEqual(db.rewardWithdrawals.get(offline.withdrawal.id).status, 'pending_offline');
  });
  test('H1 关系校验：复核账号近期被登记人重置过密码 → 不得复核', async () => {
    const db = setup();
    richUser(db, 15000);
    const now = new Date().toISOString();
    db.adminUsers.insert({
      id: 'fin02', uid: 'uid_fin02', username: 'fin02', passHash: 'x', permissions: ['finance'],
      enabled: true, createdBy: 'root', createdById: 'uid_root',
      lastResetBy: 'admin_a', lastResetById: 'uid_a', lastResetAt: now, createdAt: now,
    });
    const w = adReward.applyRewardWithdraw(db, { userId: 'w1', fen: 12000 });
    adReward.markOfflinePayout(db, {
      withdrawalId: w.withdrawal.id, voucherNo: 'BANK-H1-R', paidAt: new Date(Date.now() - HOUR).toISOString(),
      operator: 'admin_a', operatorId: 'uid_a',
    });
    assert.throws(
      () => adReward.confirmOfflinePayout(db, { withdrawalId: w.withdrawal.id, operator: 'fin02', operatorId: 'uid_fin02' }),
      /重置过密码.*第三人/,
    );
    assert.strictEqual(db.rewardWithdrawals.get(w.withdrawal.id).status, 'pending_offline');
  });
  test('H1 不可变 ID：同名账号删除重建后视为不同人，不被误判自审', () => {
    const db = setup();
    richUser(db, 15000);
    const w = adReward.applyRewardWithdraw(db, { userId: 'w1', fen: 12000 });
    adReward.markOfflinePayout(db, {
      withdrawalId: w.withdrawal.id, voucherNo: 'BANK-H1-ID', paidAt: new Date(Date.now() - HOUR).toISOString(),
      operator: 'admin', operatorId: 'uid_old_account',
    });
    const paid = adReward.confirmOfflinePayout(db, {
      withdrawalId: w.withdrawal.id, operator: 'admin', operatorId: 'uid_new_account',
    });
    assert.strictEqual(paid.status, 'paid', '同名但账号 ID 不同，允许复核');
    assert.strictEqual(paid.offlineConfirmedById, 'uid_new_account');
    assert.strictEqual(paid.offlineMarkedById, 'uid_old_account');
  });
  test('H2 历史数据保护：旧流程遗留的 approved 单不得被新复核打款直接再次出款', async () => {
    const db = setup();
    richUser(db, 15000);
    db._rewardTransferHook = async () => ({ transferNo: 'WX202611140012' });
    const w = adReward.applyRewardWithdraw(db, { userId: 'w1', fen: 12000 });
    // 模拟旧版本遗留：approved 但无 reviewStage（流水未知，可能已出款）
    db.rewardWithdrawals.update(w.withdrawal.id, {
      status: 'approved', reviewedBy: 'admin_a', reviewedById: 'uid_a',
    });
    await assert.rejects(
      () => adReward.payRewardWithdraw(db, { withdrawalId: w.withdrawal.id, operator: 'admin_b', operatorId: 'uid_b' }),
      /历史.*人工核对/,
    );
    assert.strictEqual(db.rewardWithdrawals.get(w.withdrawal.id).status, 'approved', '状态不变');
    assert.strictEqual(db.cashLedger.where((l) => l.bizType === 'withdraw_paid').length, 0);
  });
  test('开关关闭：在线审核/驳回不可用，线下复核通道仍可用', async () => {
    const db = setup();
    richUser(db, 15000);
    const w = adReward.applyRewardWithdraw(db, { userId: 'w1', fen: 12000 });
    db.switches.set('adRewardEnabled', false);
    db._rewardTransferHook = async () => ({ transferNo: 'WX202611140009' });
    await assert.rejects(() => adReward.approveRewardWithdraw(db, { withdrawalId: w.withdrawal.id }), /已关闭/);
    // H2：开关关闭时线上两步均不可用（历史 approved 单也不能复核打款）
    db.rewardWithdrawals.update(w.withdrawal.id, { status: 'approved' });
    await assert.rejects(
      () => adReward.payRewardWithdraw(db, { withdrawalId: w.withdrawal.id, operator: 'admin_b', operatorId: 'uid_b' }),
      /已关闭/,
    );
    db.rewardWithdrawals.update(w.withdrawal.id, { status: 'pending_review' });
    assert.throws(() => adReward.rejectRewardWithdraw(db, { withdrawalId: w.withdrawal.id, note: 'x' }), /已关闭/);
    assert.strictEqual(db.rewardWithdrawals.get(w.withdrawal.id).status, 'pending_review', '被拦截后状态不变');
    const marked = adReward.markOfflinePayout(db, {
      withdrawalId: w.withdrawal.id, voucherNo: 'BANK2', paidAt: new Date(Date.now() - HOUR).toISOString(), operator: 'a',
    });
    assert.strictEqual(marked.status, 'pending_offline', '线下通道不受开关限制');
    const paid = adReward.confirmOfflinePayout(db, { withdrawalId: w.withdrawal.id, operator: 'b' });
    assert.strictEqual(paid.status, 'paid');
  });
});

describe('劳务报酬预扣（简化口径）', () => {
  test('分段：≤800 免征；800~4000 减 800 后 20%；>4000 按 80%×20%', () => {
    assert.strictEqual(adReward.cumTaxFen(80000), 0);
    assert.strictEqual(adReward.cumTaxFen(300000), Math.round((300000 - 80000) * 0.2));
    assert.strictEqual(adReward.cumTaxFen(500000), Math.round(500000 * 0.16));
  });
  test('劳务报酬月累计增量计税', () => {
    const db = setup(); mkUser(db, 't1');
    const t1 = adReward.taxFenFor(db, 't1', 100000);
    // 无历史时 1000 元：(1000-800)*20% = 40 元 = 4000 分
    assert.strictEqual(t1, 4000);
  });
});
