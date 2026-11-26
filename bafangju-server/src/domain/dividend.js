'use strict';
/**
 * 排队分红（V3.3 §4.12）—— 合规要点：
 * - 只分平台真实利润（分佣后平台实收入池），绝不动用用户货款；
 * - 队位只按完成返还周期时间排序，人数/贡献值/推广关系不影响顺序；
 * - 每日跑批：先逐席活跃校验（T-1 快照）得出实际发放名单，再算每席金额，单事务（本函数同步执行即单事务语义）；
 * - 同一用户同日仅结算 1 个队位；池不足发完即止顺延；不承诺金额与到账时间；
 * - 分红入消费余额（dividendBalanceFen），默认不可提现。
 */
const { splitEven } = require('./money');

/**
 * 完成返还周期 -> 发放队位（按完成时间入队）
 */
function grantQueueSlot(db, userId, periodId) {
  const slot = db.queueSlots.insert({
    userId,
    periodId,
    status: 'waiting', // waiting -> paid | skipped | revoked
    grantedAt: new Date().toISOString(),
    paidDate: null,
  });
  return slot;
}

/**
 * 周期作废（免单退款等）-> 收回队位。
 * §4.7-3 / §4.12-3：已发放的分红也要追回（由调用方从收益账户扣回并回补池）。
 * @returns {{slots:number, paidFen:number}} 收回队位数 + 其中已发放的分红金额
 */
function revokeSlotsByPeriod(db, periodId) {
  const slots = db.queueSlots.where((s) => s.periodId === periodId && s.status !== 'revoked');
  let paidFen = 0;
  for (const s of slots) {
    if (s.status === 'paid') {
      for (const p of db.dividendPayouts.where((x) => x.slotId === s.id && x.status === 'paid')) {
        paidFen += p.fen;
        db.dividendPayouts.update(p.id, { status: 'revoked', revokeRef: 'period_void' });
      }
    }
    db.queueSlots.update(s.id, { status: 'revoked' });
  }
  return { slots: slots.length, paidFen };
}

/**
 * 每日分红发放跑批（单事务语义）。
 * @param {object} p
 * @param {string} p.date          结算日 YYYY-MM-DD
 * @param {number} p.poolBalanceFen 分红池当日余额（分）
 * @param {number} p.dailyRatio     发放比例（默认 0.05）
 * @param {number} p.maxSeats       每日最大席数（默认 100）
 * @param {function} p.isUserActive (userId, date) => boolean  以 T-1 活跃快照 + 当日任务判定
 * @returns {{paidFen, paidCount, skippedCount, perSeatFen, payouts}}
 */
function dailyPayout(db, { date, poolBalanceFen, dailyRatio, maxSeats, isUserActive }) {
  if (!queueEnabledCheck(db)) {
    return { paidFen: 0, paidCount: 0, skippedCount: 0, perSeatFen: 0, payouts: [], paused: true };
  }
  // 同日幂等（S3）：当天已有发放记录则直接回放，手动重跑 / 进程重启都不会再发一次钱
  const paidToday = db.dividendPayouts.where((p) => p.date === date && p.status === 'paid');
  if (paidToday.length > 0) {
    return {
      replay: true, paidFen: 0, paidCount: 0, skippedCount: 0, perSeatFen: 0, payouts: [],
      note: `${date} 已发放，重复执行已忽略`,
    };
  }
  const budgetFen = Math.floor(poolBalanceFen * dailyRatio);
  if (budgetFen <= 0) return { paidFen: 0, paidCount: 0, skippedCount: 0, perSeatFen: 0, payouts: [] };

  // 1) 自队首逐席校验，得出当日实际发放名单（跳过者不计席数、顺延）
  const waiting = db.queueSlots
    .where((s) => s.status === 'waiting' || (s.status === 'skipped' && s.lastSkipDate !== date))
    .sort((a, b) => (a.grantedAt < b.grantedAt ? -1 : 1));

  const eligible = [];
  const seenUsers = new Set();
  let skipped = 0;
  for (const slot of waiting) {
    if (eligible.length >= maxSeats) break;
    // 同一用户同日仅结算 1 个队位，其余保留后续日期（§4.12-2）
    if (seenUsers.has(slot.userId)) continue;
    if (isUserActive(slot.userId, date)) {
      eligible.push(slot);
      seenUsers.add(slot.userId);
    } else {
      db.queueSlots.update(slot.id, { status: 'skipped', lastSkipDate: date });
      skipped += 1;
      // 顺延提醒（§5.1「分红顺延」）：同类型 7 天内只提醒一次，避免每日打扰
      const since = Date.now() - 7 * 86400000;
      const recent = db.messages.where((m) => m.userId === slot.userId && m.type === 'dividend_deferred' && Date.parse(m.ts) >= since).length > 0;
      if (!recent) {
        db.messages.insert({
          userId: slot.userId, type: 'dividend_deferred', title: '本次分红跳过',
          body: `${date} 未达到活跃标准（当天做任务 + 当月签到），本次分红先跳过；排队号给你留着，恢复活跃后接着排。`,
          ts: new Date().toISOString(), read: false,
        });
      }
    }
  }
  if (eligible.length === 0) return { paidFen: 0, paidCount: 0, skippedCount: skipped, perSeatFen: 0, payouts: [] };

  // 2) 名单确定后计算每席金额（均分，尾差前置），单事务内完成发放记账
  const seatBudget = Math.min(budgetFen, poolBalanceFen); // 池不足发完即止
  const amounts = splitEven(seatBudget, eligible.length);
  const payouts = [];
  let paidFen = 0;
  eligible.forEach((slot, i) => {
    const fen = amounts[i];
    db.queueSlots.update(slot.id, { status: 'paid', paidDate: date });
    const acc = ensureUser(db, slot.userId);
    acc.dividendBalanceFen += fen; // 消费余额，默认不可提现
    db.dividendPayouts.insert({ userId: slot.userId, slotId: slot.id, date, fen, status: 'paid' });
    db.messages.insert({
      userId: slot.userId, type: 'dividend_paid', title: '分红已发放',
      body: `${date} 分红 ${(fen / 100).toFixed(2)} 元已计入消费余额（默认不可提现）。`,
      ts: new Date().toISOString(), read: false,
    });
    payouts.push({ userId: slot.userId, fen });
    paidFen += fen;
  });
  // 3) 分红池扣减（资金守恒：池流出 = 当日发放合计），退款回滚依赖此流水定位
  db.dividendPoolFlows.insert({ direction: 'out', fen: paidFen, ref: `dividend_payout:${date}`, ts: new Date().toISOString() });
  return { paidFen, paidCount: eligible.length, skippedCount: skipped, perSeatFen: amounts[0] || 0, payouts };
}

function queueEnabledCheck(db) {
  return db.switches.get('queueDividendEnabled') !== false;
}

function ensureUser(db, userId) {
  let acc = db.earnings.get(userId);
  if (!acc) acc = db.earnings.insert({ id: userId, balanceFen: 0, frozenFen: 0, dividendBalanceFen: 0 });
  if (acc.dividendBalanceFen == null) acc.dividendBalanceFen = 0;
  return acc;
}

module.exports = { grantQueueSlot, revokeSlotsByPeriod, dailyPayout };
