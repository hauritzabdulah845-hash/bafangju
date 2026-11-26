'use strict';
/**
 * 退款闭环（S4 后续）：微信退款结果通知 / 主动查单 / 异常队列。
 *
 * 资金安全原则：
 * - PROCESSING 只记录查询时间与"退款中"标记，不落退款完成态、不动资金；
 * - 只有微信确认 SUCCESS 才允许调用 services.refundOrder 完成本地入账；
 * - ABNORMAL / CLOSED 落明确失败状态并进入异常队列，绝不落 refunded；
 * - 同一退款单重复通知 / 重复查询：已 refunded 直接 replay，不重复回滚分佣、分红池、团队长池；
 * - 凭证未就绪或查询失败时保持状态不变，错误原样上抛，不伪造成功。
 */
const { audit } = require('../store');

const DEFAULTS = {
  queryIntervalMinutes: 5,   // 同一订单两次主动查单的最小间隔
  timeoutHours: 24,          // 处理中超过 N 小时 → 进入异常队列（滞留）
  alertCount: 3,             // 打开状态的异常达到 N 笔 → 阈值告警（每小时最多一条审计）
};

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
}

/** 退款闭环运行参数（后台 switches 可调，未配置时用默认值） */
function configOf(db) {
  return {
    queryIntervalMinutes: num(db.switches.get('refundQueryIntervalMinutes'), DEFAULTS.queryIntervalMinutes),
    timeoutHours: num(db.switches.get('refundProcessingTimeoutHours'), DEFAULTS.timeoutHours),
    alertCount: num(db.switches.get('refundAnomalyAlertCount'), DEFAULTS.alertCount),
  };
}

function findOpen(db, orderId) {
  return db.refundAnomalies.where((a) => String(a.orderId) === String(orderId) && a.status === 'open')[0] || null;
}

/** 异常入队（同一订单只保留一条 open 记录；重复触发只更新原因） */
function openAnomaly(db, { orderId, refundNo, kind, lastStatus, reason, operator = 'system' }) {
  const existing = findOpen(db, orderId);
  const ts = new Date().toISOString();
  if (existing) {
    db.refundAnomalies.update(existing.id, {
      refundNo: refundNo || existing.refundNo,
      kind, lastStatus, reason: String(reason || '').slice(0, 300), updatedAt: ts,
    });
    return db.refundAnomalies.get(existing.id);
  }
  const row = db.refundAnomalies.insert({
    orderId, refundNo: refundNo || '', kind, lastStatus: lastStatus || '',
    reason: String(reason || '').slice(0, 300), attempts: 0,
    status: 'open', createdAt: ts, updatedAt: ts,
  });
  audit(db, operator, 'refund.anomaly_open', {
    orderId, refundNo: refundNo || '', kind, lastStatus: lastStatus || '', reason: reason || '',
  });
  return row;
}

/** 退款闭环完成/人工确认后关闭该订单的全部 open 异常 */
function closeAnomalies(db, orderId, note, operator = 'system') {
  const rows = db.refundAnomalies.where((a) => String(a.orderId) === String(orderId) && a.status === 'open');
  const ts = new Date().toISOString();
  for (const a of rows) {
    db.refundAnomalies.update(a.id, {
      status: 'closed', closedAt: ts, updatedAt: ts, closeNote: String(note || '').slice(0, 200),
    });
  }
  if (rows.length) audit(db, operator, 'refund.anomaly_closed', { orderId, count: rows.length, note: note || '' });
  return rows.length;
}

/** 人工重试次数 +1（后台可见"已重试 N 次"） */
function bumpAttempt(db, orderId) {
  const a = findOpen(db, orderId);
  if (!a) return null;
  db.refundAnomalies.update(a.id, { attempts: (a.attempts || 0) + 1, updatedAt: new Date().toISOString() });
  return db.refundAnomalies.get(a.id);
}

/** 微信确认到账：先落退款成功状态，再由调用方执行本地 refundOrder 入账 */
function markSuccess(db, order, { refundId, refundNo, source = 'notify' } = {}) {
  db.orders.update(order.id, {
    refundStatus: 'SUCCESS',
    refundPending: false,
    refundError: null,
    refundId: refundId || order.refundId || null,
    refundNo: refundNo || order.refundNo || `RF_${order.id}`,
    refundFinishedAt: new Date().toISOString(),
    refundSource: source,
  });
}

/** 微信退款失败/关闭：落明确失败状态 + 异常队列，绝不落 refunded */
function markFailure(db, order, { status, reason, source = 'notify', operator = 'system' }) {
  const s = ['ABNORMAL', 'CLOSED', 'FAILED'].includes(String(status).toUpperCase())
    ? String(status).toUpperCase() : 'FAILED';
  const detail = String(reason || `微信退款状态 ${s}`).slice(0, 300);
  db.orders.update(order.id, {
    refundStatus: s,
    refundPending: false,
    refundError: detail,
    refundFailedAt: new Date().toISOString(),
    refundSource: source,
  });
  openAnomaly(db, {
    orderId: order.id, refundNo: order.refundNo, kind: 'failed', lastStatus: s, reason: detail, operator,
  });
  audit(db, operator, 'refund.failed', {
    orderId: order.id, refundNo: order.refundNo || '', status: s, reason: detail, source,
  });
}

/** 记录本次查询时间（节流依据） */
function markChecked(db, orderId, now = Date.now()) {
  db.orders.update(orderId, { lastRefundCheckAt: new Date(now).toISOString() });
}

/** 是否到了下一次主动查单时间 */
function shouldQuery(order, now = Date.now(), intervalMinutes = DEFAULTS.queryIntervalMinutes) {
  if (!order || order.refundStatus !== 'PROCESSING' || !order.refundNo) return false;
  if (!order.lastRefundCheckAt) return true;
  const last = new Date(order.lastRefundCheckAt).getTime();
  if (!Number.isFinite(last)) return true;
  return now - last >= Math.max(1, intervalMinutes) * 60000;
}

/** 后台异常列表（附订单摘要、滞留时长、阈值判定） */
function listAnomalies(db, { now = Date.now() } = {}) {
  const config = configOf(db);
  const items = db.refundAnomalies.where((a) => a.status === 'open')
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
    .map((a) => {
      const o = db.orders.get(a.orderId) || {};
      // 滞留时长以退款发起时间为准（无则用入队时间），避免"刚入队但已卡很久"被低估
      const startedAt = o.refundRequestedAt || a.createdAt;
      return {
        ...a,
        ageHours: Math.max(0, Math.round(((now - new Date(startedAt).getTime()) / 3600000) * 10) / 10),
        orderStatus: o.status || '', refundStatus: o.refundStatus || '',
        paidFen: o.paidFen || 0, userId: o.userId || '', afterSaleStatus: o.afterSaleStatus || '',
        refundError: o.refundError || '', refundRequestedAt: o.refundRequestedAt || '',
      };
    });
  const oldestHours = items.length ? Math.max(...items.map((i) => i.ageHours)) : 0;
  return {
    items, count: items.length, oldestHours, config,
    threshold: config.alertCount,
    overThreshold: items.length > 0 && items.length >= config.alertCount,
  };
}

/** 阈值告警：未关闭异常达到阈值时每小时最多写一条审计（不重复刷屏） */
function raiseAlertIfNeeded(db, { now = Date.now(), operator = 'system:cron' } = {}) {
  const config = configOf(db);
  const rows = db.refundAnomalies.where((a) => a.status === 'open');
  if (!rows.length || rows.length < config.alertCount) return { alerted: false, count: rows.length };
  const bucket = `refundAnomalyAlert:${Math.floor(now / 3600000)}`;
  const { replay } = db.idempotency.run(bucket, () => {
    const oldest = Math.max(...rows.map((a) => {
      const o = db.orders.get(a.orderId) || {};
      return now - new Date(o.refundRequestedAt || a.createdAt).getTime();
    }));
    audit(db, operator, 'refund.anomaly_alert', {
      count: rows.length, threshold: config.alertCount, oldestHours: Math.round(oldest / 3600000),
    });
    return { count: rows.length };
  });
  return { alerted: !replay, count: rows.length };
}

module.exports = {
  DEFAULTS, configOf, openAnomaly, closeAnomalies, bumpAttempt, markSuccess, markFailure,
  markChecked, shouldQuery, listAnomalies, raiseAlertIfNeeded,
};
