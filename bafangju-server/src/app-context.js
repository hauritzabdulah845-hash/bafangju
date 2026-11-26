'use strict';
/**
 * 应用上下文（Composition Root 支撑件）：
 * 集中装配「存储 + 领域模块 + 会话/鉴权中间件 + 跨域辅助函数」，供 src/routes/*.js 按域取用。
 *
 * 目的（P3-4）：
 * ① 路由层只做 HTTP 编排，领域逻辑与鉴权策略各自单一出处，便于合规审计；
 * ② 鉴权中间件在此定义一次，杜绝"路由已注册、鉴权后挂"被绕过（P0-1 根因）；
 * ③ 领域模块不在路由文件里各自 require，避免同一模块多实例/多入口。
 */
const { audit } = require('./store');
const svc = require('./services');
const auth = require('./domain/auth');
const pay = require('./domain/pay');
const adminAuth = require('./domain/adminAuth');
const adminUsers = require('./domain/adminUsers');
const promotion = require('./domain/promotion');
const wxmp = require('./domain/wxmp');
const risk = require('./domain/risk');
const fulfillment = require('./domain/fulfillment');
const refund = require('./domain/refund');
const coupon = require('./domain/coupon');
const ad = require('./domain/ad');
const ladder = require('./domain/ladder');
const quarter = require('./domain/quarter');
const dividend = require('./domain/dividend');
const levelDomain = require('./domain/level');
const nearby = require('./domain/nearby');
const orderIndex = require('./domain/orderIndex');
const merchant = require('./domain/merchant');
const userAccount = require('./domain/userAccount');
const upload = require('./domain/upload');
const catalog = require('./domain/catalog');
const commission = require('./domain/commission');
const transfer = require('./domain/transfer');
const withdraw = require('./domain/withdraw');
const adReward = require('./domain/adReward');
const adCenter = require('./domain/adCenter');
const ops = require('./domain/ops');
const content = require('./domain/content');
const { fenToYuan } = require('./domain/money');
const loginLimiter = require('./domain/loginLimiter');
const bizdate = require('./domain/bizdate');

function buildContext({ db, UPLOAD_DIR, PRIVATE_UPLOAD_DIR }) {
  /**
   * 可选登录：解析 Bearer token 挂到 req.user（未登录为 null）。
   * 公开接口据此做个性化，但**身份只来自会话**，不信任前端传入的 userId。
   */
  function attachUser(req, res, next) {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    req.user = token ? userAccount.userByToken(db, token) : null;
    next();
  }

  /**
   * 强制登录中间件：Authorization: Bearer <token>；userId 以服务端会话为准，不信任 body 传参。
   */
  function requireUser(req, res, next) {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : ((req.body || {}).token || '');
    const u = userAccount.userByToken(db, token);
    if (!u) return res.status(401).json({ error: '请先登录' });
    if (risk.isBlacklisted(db, u.id)) return res.status(403).json({ error: '账号已被限制使用，如有疑问请通过客服申诉' });
    req.user = u;
    req.userToken = token;
    next();
  }

  /** 订单对外视图：金额一律分→元统一出口，避免各路由自行换算导致口径不一致 */
  function pub(o) {
    return { ...o, priceYuan: fenToYuan(o.priceFen), paidYuan: fenToYuan(o.paidFen) };
  }

  /**
   * 退款编排（V3.12）：真实模式**先调微信退款**，受理成功后才落本地退款状态；
   * 模拟模式 / 免单订单不调微信。out_refund_no 固定 RF_<orderId>，重复提交幂等。
   */
  async function ensureWxRefund(order, operator = 'admin') {
    if (!order || order.payType !== 'WX_PAY') return null; // 免单订单无支付通道
    const provider = pay.getPayProvider(process.env);
    if (provider.name !== 'wxpay') return null; // mock 模式不动真钱
    // 已受理但未到账：返回处理中状态给调用方，禁止落退款完成态（S4）
    if (order.refundStatus === 'PROCESSING') {
      return { provider: provider.name, status: 'PROCESSING', refundNo: order.refundNo || `RF_${order.id}`, replay: true };
    }
    if (order.refundStatus === 'SUCCESS') return null; // 已成功：走本地幂等落库
    const refundNo = order.refundNo || `RF_${order.id}`;
    const r = await provider.refund({
      orderId: order.id,
      refundNo,
      amountFen: order.paidFen,
      totalFen: order.paidFen,
      reason: order.afterSaleReason || '用户申请退款',
    });
    db.orders.update(order.id, {
      refundNo,
      refundStatus: r.status,
      refundId: r.refundId,
      refundRequestedAt: new Date().toISOString(),
    });
    audit(db, operator, 'payment.refund_requested', { orderId: order.id, refundNo, fen: r.amountFen, status: r.status });
    return r;
  }

  /**
   * 退款终态落地（通知 / 查单 / 人工重试共用，S4 闭环）：
   * - PROCESSING：只刷新标记与查询时间，不动资金；
   * - SUCCESS：先落 SUCCESS 再走 refundOrder 本地入账；已 refunded 直接 replay（幂等）；
   * - ABNORMAL / CLOSED：落失败状态 + 异常队列，绝不落 refunded；
   * - 微信已到账但本地入账失败：进异常队列并抛错（通知会被微信重试，人工也可重试）。
   */
  function applyRefundResult(order, r, { source = 'notify', operator = 'system' } = {}) {
    if (!order) throw new Error('订单不存在');
    if (!r || !r.status) throw new Error('退款结果缺少状态');
    const current = db.orders.get(order.id) || order;
    const status = String(r.status).toUpperCase();
    const refundNo = r.refundNo || current.refundNo || `RF_${current.id}`;

    if (status === 'PROCESSING') {
      refund.markChecked(db, current.id);
      db.orders.update(current.id, {
        refundPending: true, refundNo, refundId: r.refundId || current.refundId || null,
        refundRequestedAt: current.refundRequestedAt || new Date().toISOString(),
      });
      return { ok: true, pending: true, status };
    }

    if (status === 'SUCCESS') {
      if (current.status === 'refunded') {
        refund.closeAnomalies(db, current.id, '已退款完成（重复通知/查询）', operator);
        return { ok: true, replay: true, finalized: true, status };
      }
      refund.markSuccess(db, current, { refundId: r.refundId, refundNo, source });
      try {
        const local = svc.refundOrder(db, { orderId: current.id, operator });
        refund.closeAnomalies(db, current.id, '退款完成', operator);
        audit(db, operator, 'refund.finalize_success', { orderId: current.id, refundNo, source });
        return { ok: true, finalized: true, status, local };
      } catch (e) {
        refund.openAnomaly(db, {
          orderId: current.id, refundNo, kind: 'finalize_error', lastStatus: 'SUCCESS',
          reason: e.message, operator,
        });
        audit(db, operator, 'refund.finalize_error', { orderId: current.id, refundNo, source, error: e.message });
        throw new Error('微信退款已到账，但本地退款入账失败：' + e.message);
      }
    }

    // 已成功/已退款后收到过期的失败通知：保持成功态，不回退
    if (current.status === 'refunded' || current.refundStatus === 'SUCCESS') {
      return { ok: true, replay: true, finalized: current.status === 'refunded', status: current.refundStatus || 'SUCCESS' };
    }

    refund.markFailure(db, current, {
      status, reason: r.message || r.reason || `微信退款状态 ${status}`, source, operator,
    });
    return { ok: true, failed: true, status };
  }

  /**
   * 主动查询退款单并推进终态：供后台人工查单与定时跑批共用。
   * 凭证/通道未就绪时明确报错，保持订单状态不变（不伪造成功）。
   */
  async function syncRefundOrder(orderId, { operator = 'system', source = 'query' } = {}) {
    const order = db.orders.get(orderId);
    if (!order) throw new Error('订单不存在');
    if (order.payType !== 'WX_PAY') throw new Error('仅微信支付订单支持退款查询');
    if (order.status === 'refunded') return { ok: true, replay: true, finalized: true, status: 'SUCCESS' };
    if (!order.refundNo) throw new Error('订单尚未发起微信退款，无法查询');
    const provider = pay.getPayProvider(process.env);
    if (provider.name !== 'wxpay') throw new Error('当前为模拟支付模式，无微信退款可查（不会伪造成功）');
    if (typeof provider.queryRefund !== 'function') throw new Error('当前支付通道不支持退款查询');
    const r = await provider.queryRefund(order.refundNo);
    refund.markChecked(db, order.id);
    audit(db, operator, 'refund.query', { orderId: order.id, refundNo: order.refundNo, status: r.status, source });
    const out = applyRefundResult(order, { ...r, refundNo: order.refundNo }, { source, operator });
    if (out.pending) {
      const cfg = refund.configOf(db);
      const ageH = order.refundRequestedAt
        ? (Date.now() - new Date(order.refundRequestedAt).getTime()) / 3600000 : 0;
      if (ageH >= cfg.timeoutHours) {
        refund.openAnomaly(db, {
          orderId: order.id, refundNo: order.refundNo, kind: 'stalled', lastStatus: 'PROCESSING',
          reason: `微信退款已处理中 ${Math.round(ageH)} 小时未完成`, operator,
        });
      }
    }
    return out;
  }

  /**
   * 定时推进所有处理中退款（按订单节流），失败/滞留入异常队列，并按阈值告警。
   * 由 daily-jobs 每分钟触发一次；不会重复回滚已完成的退款。
   */
  async function sweepProcessingRefunds({ now = Date.now(), operator = 'system:cron' } = {}) {
    const cfg = refund.configOf(db);
    const targets = db.orders.where((o) => refund.shouldQuery(o, now, cfg.queryIntervalMinutes));
    const result = { checked: 0, finalized: 0, failed: 0, errors: [] };
    for (const o of targets) {
      try {
        const r = await syncRefundOrder(o.id, { operator, source: 'cron' });
        result.checked += 1;
        if (r.finalized) result.finalized += 1;
        if (r.failed) result.failed += 1;
      } catch (e) {
        result.errors.push({ orderId: o.id, error: e.message });
        refund.markChecked(db, o.id, now);
        audit(db, operator, 'refund.query_error', { orderId: o.id, error: e.message });
        const ageH = o.refundRequestedAt
          ? (now - new Date(o.refundRequestedAt).getTime()) / 3600000 : 0;
        if (ageH >= cfg.timeoutHours) {
          refund.openAnomaly(db, {
            orderId: o.id, refundNo: o.refundNo, kind: 'query_error', lastStatus: 'PROCESSING',
            reason: `查询失败：${e.message}`, operator,
          });
        }
      }
    }
    result.alert = refund.raiseAlertIfNeeded(db, { now, operator });
    return result;
  }

  return {
    db, UPLOAD_DIR, PRIVATE_UPLOAD_DIR,
    audit, svc, auth, pay, adminAuth, adminUsers, loginLimiter, bizdate, promotion, wxmp, risk, fulfillment, coupon, ad,
    ladder, quarter, dividend, levelDomain, nearby, orderIndex, merchant, userAccount,
    upload, catalog, commission, transfer, withdraw, ops, content, adReward, adCenter, refund,
    fenToYuan,
    attachUser, requireUser, pub, ensureWxRefund, applyRefundResult, syncRefundOrder, sweepProcessingRefunds,
  };
}

module.exports = { buildContext };
