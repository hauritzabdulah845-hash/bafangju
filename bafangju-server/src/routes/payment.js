'use strict';
/**
 * 支付路由（V3.10）：模式可切（mock / live），真实参数就绪即生效。
 * 覆盖：支付通道配置、预下单、模拟支付入账、微信支付回调（v3 验签 + 解密）。
 *
 * 合规要点：
 * - openid 只从会话取（真实微信登录时写入），**不接受**前端传入；
 * - 回调金额必须与订单快照一致；已退款/已取消的订单不得被回调改回已支付；
 * - 回调验签必须对"原始字节"验签，JSON 解析后重序列化会导致验签失败（原始字节由 express.json 的 verify 捕获）；
 * - 真实模式下模拟支付接口一律拒绝，杜绝"任何人可刷已支付白拿货"。
 */
const express = require('express');

module.exports = function register(app, ctx) {
  const { db, svc, audit, pay, requireUser } = ctx;

  // ---------- 微信支付回调（v3 验签+解密） ----------
  app.post('/api/payment/notify-wx', express.raw({ type: '*/*', limit: '256kb' }), async (req, res) => {
    try {
      if (pay.resolvePayMode(process.env) !== 'live') {
        return res.status(501).json({ code: 'FAIL', message: '微信支付通道未接入（当前为模拟模式）' });
      }
      const provider = pay.getPayProvider(process.env);
      // 优先用 express.json verify 捕获的原始字节（JSON.stringify 重排会破坏验签）
      const rawBody = req.rawBody
        ? req.rawBody.toString('utf8')
        : (Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body));
      const r = await provider.verifyNotify({ headers: req.headers, rawBody });
      if (r.ignored) return res.json({ code: 'SUCCESS', message: 'ignored' });
      // 金额与状态校验（V3.12）：回调金额必须与订单快照一致；已退款/已取消的订单不得被回调改回已支付
      const order = db.orders.get(r.orderId);
      if (!order) {
        audit(db, 'system', 'payment.notify_wx_unknown_order', { orderId: r.orderId });
        return res.status(404).json({ code: 'FAIL', message: '订单不存在' });
      }
      if (Number.isInteger(r.paidFen) && r.paidFen !== order.paidFen) {
        audit(db, 'system', 'payment.amount_mismatch', { orderId: r.orderId, notifyFen: r.paidFen, orderFen: order.paidFen });
        return res.status(400).json({ code: 'FAIL', message: '回调金额与订单金额不一致，已拒绝入账' });
      }
      if (['refunded', 'cancelled'].includes(order.status)) {
        audit(db, 'system', 'payment.notify_wx_late', { orderId: r.orderId, status: order.status });
        return res.status(200).json({ code: 'SUCCESS', message: '订单已退款/取消，回调忽略' });
      }
      const { replay } = svc.onPaid(db, { orderId: r.orderId, wxTransactionId: r.transactionId }); // 入账幂等
      audit(db, 'system', 'payment.notify_wx', { orderId: r.orderId, verified: true, replay });
      res.json({ code: 'SUCCESS', message: 'OK' });
    } catch (e) {
      audit(db, 'system', 'payment.notify_wx_rejected', { error: e.message });
      res.status(400).json({ code: 'FAIL', message: e.message });
    }
  });

  // ---------- 微信退款结果通知（v3 验签+解密；S4 闭环） ----------
  // 回调地址：POST /api/payment/refund-notify（微信商户平台退款 notify_url 需配置为
  //   https://<域名>/api/payment/refund-notify，并设置 WX_REFUND_NOTIFY_URL）
  app.post('/api/payment/refund-notify', express.raw({ type: '*/*', limit: '256kb' }), async (req, res) => {
    try {
      if (pay.resolvePayMode(process.env) !== 'live') {
        return res.status(501).json({ code: 'FAIL', message: '微信支付通道未接入（当前为模拟模式）' });
      }
      const provider = pay.getPayProvider(process.env);
      const rawBody = req.rawBody
        ? req.rawBody.toString('utf8')
        : (Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body));
      const r = await provider.verifyRefundNotify({ headers: req.headers, rawBody });
      if (r.ignored) {
        audit(db, 'system', 'refund.notify_ignored', { eventType: r.eventType || '' });
        return res.json({ code: 'SUCCESS', message: 'ignored' });
      }

      const order = db.orders.get(r.orderId);
      if (!order) {
        audit(db, 'system', 'refund.notify_unknown_order', { orderId: r.orderId || '', refundNo: r.refundNo || '' });
        return res.status(404).json({ code: 'FAIL', message: '订单不存在' });
      }
      // 退款单号/金额必须与本地发起记录一致，防止串单或伪造
      if (!order.refundNo || (r.refundNo && order.refundNo !== r.refundNo)) {
        audit(db, 'system', 'refund.notify_mismatch', {
          orderId: order.id, reason: 'refund_no', notifyRefundNo: r.refundNo || '', localRefundNo: order.refundNo || '',
        });
        return res.status(400).json({ code: 'FAIL', message: '退款单号与本地记录不一致，已拒绝' });
      }
      if (Number.isInteger(r.amountFen) && r.amountFen !== order.paidFen) {
        audit(db, 'system', 'refund.notify_mismatch', {
          orderId: order.id, reason: 'amount', notifyFen: r.amountFen, orderFen: order.paidFen,
        });
        return res.status(400).json({ code: 'FAIL', message: '退款金额与订单金额不一致，已拒绝' });
      }

      // 幂等：重复成功通知 / 重复失败通知直接 ack，不重复回滚资金
      const replay = (r.status === 'SUCCESS' && order.status === 'refunded')
        || (['ABNORMAL', 'CLOSED'].includes(r.status) && order.refundStatus === r.status);
      if (replay) {
        audit(db, 'system', 'refund.notify_received', {
          orderId: order.id, refundNo: order.refundNo, status: r.status, replay: true,
        });
        return res.json({ code: 'SUCCESS', message: 'already_handled' });
      }

      const out = ctx.applyRefundResult(order, {
        status: r.status, refundId: r.refundId, refundNo: r.refundNo,
      }, { source: 'notify', operator: 'system:refund-notify' });
      audit(db, 'system', 'refund.notify_received', {
        orderId: order.id, refundNo: order.refundNo, status: r.status,
        finalized: !!out.finalized, pending: !!out.pending, replay: false,
      });
      res.json({ code: 'SUCCESS', message: 'OK' });
    } catch (e) {
      audit(db, 'system', 'refund.notify_rejected', { error: e.message });
      res.status(400).json({ code: 'FAIL', message: e.message });
    }
  });

  // 支付环境（不含任何密钥，供前端与运维确认当前是否会真扣款）
  app.get('/api/payment/config', (req, res) => {
    const mode = pay.resolvePayMode(process.env);
    const ready = pay.checkLiveReadiness(process.env);
    res.json({
      mode, provider: mode === 'live' ? 'wxpay' : 'mock', mock: mode === 'mock',
      liveReady: ready.ok, problems: ready.problems,
    });
  });

  app.post('/api/payment/prepay', requireUser, async (req, res) => {
    try {
      const { orderId } = req.body || {};
      const order = db.orders.get(orderId);
      // 越权/状态校验：只能为自己的待支付订单发起预下单
      if (!order || order.userId !== req.user.id) return res.status(404).json({ error: '订单不存在' });
      if (order.payType !== 'WX_PAY' || order.status !== 'pending_pay') {
        return res.status(400).json({ error: '订单状态不可支付' });
      }
      // 真实通道未就绪（缺回调地址等）时不下单：否则用户会被扣款而订单永远不入账
      const ready = pay.checkLiveReadiness(process.env);
      if (pay.resolvePayMode(process.env) === 'live' && !ready.ok) {
        return res.status(503).json({ error: '支付通道未就绪，请联系平台：' + ready.problems.join('；') });
      }
      const provider = pay.getPayProvider(process.env);
      // 幂等：同一订单已有同一通道、且未超过 prepay_id 有效期（微信 JSAPI 约 2 小时）则直接返回；
      // 中途切换过支付模式（mock ↔ live）或已过期，则重新预下单
      const prepayFresh = order.prepayAt && (Date.now() - new Date(order.prepayAt).getTime() < 90 * 60 * 1000);
      if (order.prepayId && order.payProvider === provider.name && prepayFresh) {
        return res.json({
          ok: true, provider: order.payProvider, prepayId: order.prepayId,
          payParams: order.payParams || null, amountFen: order.paidFen, replay: true,
        });
      }
      // openid 只从会话取（真实微信登录时写入），不接受前端传入
      const openid = req.user.openid || null;
      const prepay = await provider.createPrepay({
        orderId, openid, amountFen: order.paidFen, description: '八方聚商品订单',
      });
      db.orders.update(orderId, {
        prepayId: prepay.prepayId,
        payProvider: prepay.provider,
        payParams: prepay.payParams || null,
        prepayAt: new Date().toISOString(),
      });
      audit(db, 'user', 'payment.prepay', { orderId, provider: prepay.provider, amountFen: order.paidFen });
      res.json({ ok: true, ...prepay, amountFen: order.paidFen });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/payment/notify', requireUser, (req, res) => {
    // 仅模拟模式允许；真实模式必须等微信回调（notify-wx）入账，杜绝"任何人可刷已支付白拿货"
    if (pay.resolvePayMode(process.env) !== 'mock') {
      return res.status(403).json({ error: '模拟支付已关闭（当前为真实支付模式），请等待微信支付回调入账' });
    }
    try {
      const order = db.orders.get(req.body.orderId);
      if (!order || order.userId !== req.user.id) return res.status(404).json({ error: '订单不存在' });
      if (order.status !== 'pending_pay') return res.status(400).json({ error: '订单状态不可支付' });
      const { value, replay } = svc.onPaid(db, { orderId: order.id });
      audit(db, 'user', 'payment.mock_paid', { orderId: order.id });
      res.json({ ok: true, replay, ...value });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
};
