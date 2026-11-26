/**
 * 风控模块：黑名单（登录/下单拦截）、用户申诉、循环免单识别预警。
 * 合规要点：免单正常态每周期一单；短周期高频免单仅预警标记，不自动处罚（由管理员人工处置）。
 */
const { audit } = require('../store');
const bizdate = require('./bizdate');

/** 拉黑/解封（管理员） */
function setBlacklist(db, { userId, blocked, reason, operator }) {
  userId = String(userId);
  if (!db.users.get(userId)) throw new Error('用户不存在');
  const row = db.blacklist.where((b) => b.userId === userId)[0];
  if (blocked) {
    if (row) db.blacklist.update(row.id, { reason: reason || row.reason, blockedAt: new Date().toISOString() });
    else db.blacklist.insert({ userId, reason: reason || '', blockedAt: new Date().toISOString() });
  } else if (row) {
    db.blacklist.delete(row.id);
  }
  audit(db, operator || 'admin', blocked ? 'risk.blacklist_add' : 'risk.blacklist_remove', { userId, reason });
  return { userId, blocked: !!blocked };
}

function isBlacklisted(db, userId) {
  return db.blacklist.where((b) => b.userId === String(userId)).length > 0;
}

/** 用户申诉（被封禁/驳回等场景；每用户对同一业务单一次） */
function submitAppeal(db, { userId, targetType, targetId, content }) {
  if (!content || String(content).trim().length < 5) throw new Error('申诉内容过短');
  const dup = db.appeals.where((a) => a.userId === String(userId) && a.targetType === targetType &&
    a.targetId === String(targetId || '') && a.status === 'open')[0];
  if (dup) throw new Error('该事项已有处理中的申诉，请勿重复提交');
  const row = db.appeals.insert({
    userId: String(userId), targetType: targetType || 'other', targetId: String(targetId || ''),
    content: String(content).slice(0, 500), status: 'open', // open -> accepted | rejected
    createdAt: new Date().toISOString(),
  });
  audit(db, `user:${userId}`, 'risk.appeal_submit', { appealId: row.id, targetType });
  return row;
}

/** 管理员处理申诉 */
function resolveAppeal(db, { appealId, accepted, note, operator }) {
  const a = db.appeals.get(String(appealId));
  if (!a) throw new Error('申诉不存在');
  if (a.status !== 'open') throw new Error('该申诉已处理');
  a.status = accepted ? 'accepted' : 'rejected';
  a.note = note || '';
  a.resolvedAt = new Date().toISOString();
  audit(db, operator || 'admin', accepted ? 'risk.appeal_accepted' : 'risk.appeal_rejected', { appealId: a.id, note: a.note });
  return a;
}

/**
 * 循环免单识别：近 N 天内免单领取次数 ≥ 阈值的用户 → 预警名单（不自动处置）。
 * 正常态：免单伴随完整返还周期，正常节奏下 N 天内极少连续多次。
 */
function detectLoopFreeOrders(db, { days = 30, threshold = 3, now = new Date() } = {}) {
  const cutoffDate = new Date(now.getTime() - days * 86400 * 1000);
  const cutoff = cutoffDate.toISOString();
  const period = bizdate.dayOf(cutoffDate);   // 窗口起始的北京时间自然日
  const counts = {};
  for (const o of db.orders.where((o) => o.payType === 'FREE' && o.createdAt >= cutoff)) {
    counts[o.userId] = (counts[o.userId] || 0) + 1;
  }
  return Object.entries(counts)
    .filter(([, n]) => n >= threshold)
    .map(([userId, freeCount]) => {
      const known = db.riskAlerts.where((a) => a.userId === userId && a.type === 'loop_free_order' && a.period === period)[0];
      if (!known) {
        db.riskAlerts.insert({ type: 'loop_free_order', userId, freeCount, period, ts: now.toISOString(), handled: false });
        audit(db, 'system', 'risk.loop_free_alert', { userId, freeCount, days });
      }
      return { userId, freeCount };
    });
}

module.exports = { setBlacklist, isBlacklisted, submitAppeal, resolveAppeal, detectLoopFreeOrders };
