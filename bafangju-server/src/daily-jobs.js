'use strict';
/**
 * 每日跑批（开发版内置调度；生产替换为 crontab / 任务框架）。
 * 合规要点：
 * - 幂等：以自然日为键，同一自然日只执行一次；
 * - 单步异常只记审计不中断其余步骤，避免一个子任务失败导致当日全部资金动作停摆；
 * - 所有资金相关子任务（分红/提现/分佣结算/自动收货）均为域模块内的幂等实现，重复执行不会重复发放。
 */
module.exports = function createDailyJobs(ctx) {
  const { db, svc, audit, dividend, withdraw, commission, merchant, fulfillment, upload } = ctx;
  const bizdate = require('./domain/bizdate');
  const state = { lastDate: null };

  /**
   * 超时未支付订单释放（每分钟扫描，与"每日只跑一次"的跨日跑批解耦）。
   * createOrder 写入 expireAt = 下单 + 15 分钟，但 releaseOrder 此前从未被调用，
   * 导致 pending_pay 订单永不取消、15 分钟支付时限形同虚设。
   */
  function releaseExpiredOrders() {
    const now = Date.now();
    const expired = db.orders.where((o) => o.status === 'pending_pay'
      && o.expireAt && Number(o.expireAt) < now);
    for (const o of expired) svc.releaseOrder(db, o.id);
    return expired.length;
  }

  function runDailyJobsOnce() {
    const today = bizdate.today();   // 北京时间自然日（不再用 UTC 的 toISOString）
    // 超时订单每分钟都扫描，不能放进下面的"同日只执行一次"分支里
    const ordersReleased = releaseExpiredOrders();
    // 退款主动查单（S4 闭环）：每分钟触发，域内按订单节流；异步执行不阻塞跑批
    if (typeof ctx.sweepProcessingRefunds === 'function') {
      Promise.resolve()
        .then(() => ctx.sweepProcessingRefunds({ operator: 'system:cron' }))
        .catch((e) => audit(db, 'system:cron', 'refund.sweep_error', { error: e.message }));
    }
    if (state.lastDate === today) return;
    // 同日幂等（S3）：幂等键随库持久化，进程重启后当天不会把资金类步骤再跑一遍
    const { replay } = db.idempotency.run(`dailyJobs:${today}`, () => {
      state.lastDate = today;
      try {
        const yesterday = bizdate.yesterday();
        const activeUsers = svc.snapshotActivity(db, yesterday);
        // 30 天完成奖励（V3.15）：近 N 天有 N 个不同日期完成任务 → 奖励贡献值，每窗口只发一次
        const streak = svc.runTaskStreakBonus(db, { date: today });
        const div = dividend.dailyPayout(db, {
          date: today,
          poolBalanceFen: svc.poolBalanceFen(db),
          dailyRatio: db.switches.get('queueDividendDailyRatio'),
          maxSeats: db.switches.get('queueDividendDailySeats'),
          isUserActive: (userId, d) => svc.isUserActive(db, userId, d),
        });
        withdraw.expireStaleTransfers(db, { date: today });
        const queued = db.withdrawRequests.where((r) => ['approved', 'issuing'].includes(r.status))
          .map((r) => withdraw.issueQueuedWithdrawals(db, { requestId: r.id, date: today }));
        // 分佣到期结算（V3.4）：修掉"推广收益永远冻结"的问题
        const settledCommission = commission.settleDue(db, { afterHours: db.switches.get('settleAfterHours') });
        // 广告档期到期释放（V3.4）：修掉"广告位一次性投放后永久占用"
        const releasedAds = merchant.releaseExpiredAdSlots(db);
        // 自动收货（V3.5）：发货超时未确认 → 自动完成，售后期才起算
        const autoReceived = fulfillment.autoReceiveShipped(db, { days: db.switches.get('autoReceiveDays') });
        // 上传每日配额计数清理（P0-3）：只保留当天的计数，历史行不无限堆积
        upload.purgeExpiredQuota(db);
        audit(db, 'cron', 'daily_jobs', { date: today, yesterday, activeUsers, streakBonus: streak.awarded, dividendPaid: div.paidFen || 0, withdrawIssued: queued.length, commissionSettled: settledCommission.length, adsReleased: releasedAds.length, ordersAutoReceived: autoReceived.length });
        return { date: today };
      } catch (e) {
        audit(db, 'cron', 'daily_jobs_error', { error: e.message });
        return { date: today, error: e.message };
      }
    });
    if (replay) state.lastDate = today;
  }

  return { runDailyJobsOnce };
};
