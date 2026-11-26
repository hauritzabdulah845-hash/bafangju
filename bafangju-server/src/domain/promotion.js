/**
 * 推广模块：邀请关系链绑定 / 我的团队 / 推广收益 / 推广二维码。
 * 合规要点：关系链一次性绑定不可更改（防刷）；分佣仍走方案A记账结算，前端只读展示。
 */
const { audit } = require('../store');
const { fenToYuan } = require('./money');
const bizdate = require('./bizdate');

/** 绑定邀请关系（一次性、不可更改；禁止自邀与环） */
function bindReferral(db, { userId, inviterUserId }) {
  userId = String(userId); inviterUserId = String(inviterUserId);
  if (userId === inviterUserId) throw new Error('不能邀请自己');
  const user = db.users.get(userId);
  if (!user) throw new Error('用户不存在');
  const inviter = db.users.get(inviterUserId);
  if (!inviter) throw new Error('邀请人不存在');
  if (user.directUserId) throw new Error('已绑定邀请人，关系不可更改');
  if (inviter.directUserId === userId) throw new Error('邀请关系不能成环');
  db.users.update(userId, { directUserId: inviterUserId, boundAt: new Date().toISOString() });
  // 分享奖励（V3.3 §4.8-1）：成功邀请 1 人 +N 贡献值（后台可配），只记权重、不提现、不构成资产或债权
  const shareReward = Math.max(0, Math.floor(Number((db.switches.get('taskRewards') || {}).share ?? 10)));
  if (shareReward > 0) {
    const acc = db.contributions.get(inviterUserId) || db.contributions.insert({ id: inviterUserId, weight: 0 });
    acc.weight += shareReward;
    const today = bizdate.today();
    db.contributionFlows.insert({ userId: inviterUserId, taskType: 'share', reward: shareReward, date: today, ts: new Date().toISOString() });
  }
  audit(db, `user:${userId}`, 'promotion.bind_referral', { inviterUserId, shareReward });
  return { userId, inviterUserId, shareReward };
}

/** 推广中心概览：邀请码、直推人数、推广收益汇总、绑卡状态 */
function referralProfile(db, userId) {
  const directs = db.users.where((u) => u.directUserId === String(userId));
  const flows = db.earningFlows.where((f) => f.userId === String(userId));
  const totalFen = flows.reduce((s, f) => s + (f.status === 'balance' ? f.fen : 0), 0);
  const frozenFen = flows.reduce((s, f) => s + (f.status === 'frozen' ? f.fen : 0), 0);
  const acc = db.earnings.get(String(userId)) || {};
  // 活跃直推：近 30 天有已支付订单
  const cutoff = Date.now() - 30 * 86400 * 1000;
  const activeDirects = new Set(
    db.orders.where((o) => directs.some((d) => d.id === o.userId) &&
      o.status !== 'pending_pay' && o.status !== 'cancelled' &&
      new Date(o.createdAt || o.paidAt || 0).getTime() >= cutoff).map((o) => o.userId)
  );
  return {
    inviteCode: String(userId),
    directCount: directs.length,
    activeDirectCount: activeDirects.size,
    earnedYuan: (totalFen / 100).toFixed(2),
    frozenYuan: (frozenFen / 100).toFixed(2),
    balanceFen: acc.balanceFen || 0,
    withdrawEnabled: db.switches.get('withdrawEnabled') === true,
  };
}

/** 我的团队：直推成员列表（含其累计订单数，仅汇总不下单明细，保护隐私） */
function teamMembers(db, userId) {
  return db.users.where((u) => u.directUserId === String(userId))
    .map((u) => {
      const orders = db.orders.where((o) => o.userId === u.id && o.status !== 'pending_pay' && o.status !== 'cancelled');
      return {
        id: u.id,
        nickname: u.nickname,
        joinedAt: u.createdAt,
        orderCount: orders.length,
        paidTotalYuan: fenToYuan(orders.reduce((s, o) => s + (o.paidFen || 0), 0)),
      };
    }).sort((a, b) => (a.joinedAt < b.joinedAt ? 1 : -1));
}

/** 推广收益明细：本人作为直推/间推角色的分佣记录 + 收益流水 */
function promotionEarnings(db, userId) {
  const uid = String(userId);
  const commissions = db.commissionRecords
    .where((c) => c.directUserId === uid || c.indirectUserId === uid)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, 100)
    .map((c) => {
      const role = c.directUserId === uid ? 'direct' : 'indirect';
      const fen = (c.splitFen && c.splitFen[role]) || 0;
      return { orderId: c.orderId, role, fen, yuan: fenToYuan(fen), status: c.status, createdAt: c.createdAt };
    });
  const flows = db.earningFlows.where((f) => f.userId === uid)
    .sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, 100);
  return {
    commissions,
    flows: flows.map((f) => ({ ...f, yuan: fenToYuan(f.fen) })),
  };
}

// 小程序码已迁移到 domain/wxmp.js（统一配置源 + access_token/图片缓存 + 失败降级），此处不再重复实现。

module.exports = { bindReferral, referralProfile, teamMembers, promotionEarnings };
