'use strict';
/**
 * 履约闭环（V3.5）：发货 / 到店核销 / 确认收货 / 自动收货 / 售后。
 *
 * 为什么必须有这一层：
 *   原实现里订单永远停在 `paid`，既不能发货也不能确认收货，"售后期"没有起点，
 *   于是分佣永远冻结、用户无法复购评价、售后也无处承接。
 *
 * 状态机：
 *   paid --(快递发货)--> shipped --(确认收货/超时自动)--> done
 *   paid --(到店核销)--> done
 *   paid / shipped / done --(退款/售后受理)--> refunded
 *
 * 售后与结算的关系：
 *   warrantyStart = 收货 > 到店核销 > 发货 > 支付（取最先发生的履约节点）
 *   分佣在 warrantyStart + settleAfterHours 后解冻；有进行中的售后申请时不解冻。
 */
const { audit } = require('../store');

const EXPRESS_COMPANIES = ['顺丰速运', '京东物流', '中通快递', '圆通速递', '韵达快递', '申通快递', '极兔速递', '邮政EMS', '其他'];

/** 6 位核销码（到店订单凭码核销） */
function makeVerifyCode() {
  return String(100000 + Math.floor(Math.random() * 900000));
}

/** 售后期起点：取已发生的履约节点中最先的一个 */
function warrantyStartOf(order) {
  return order.receivedAt || order.storeVerifiedAt || order.shippedAt || order.paidAt || order.createdAt || null;
}

/** 售后窗口是否仍开放（仅对已完成订单做时间限制；未履约订单随时可申请） */
function afterSaleWindowOpen(order, now = Date.now(), windowDays = 7) {
  const start = warrantyStartOf(order);
  if (!start) return false;
  return now <= new Date(start).getTime() + Math.max(0, Number(windowDays) || 0) * 86400000;
}

function getOrder(db, orderId) {
  const order = db.orders.get(String(orderId));
  if (!order) throw new Error('订单不存在');
  return order;
}

/** 商家只能操作自己商品的订单；平台后台调用时不传 merchantId */
function assertMerchant(order, merchantId) {
  if (merchantId == null || merchantId === '') return;
  if (String(order.merchantId || '') !== String(merchantId)) throw new Error('无权操作该订单（非本店商品）');
}

function pushMessage(db, userId, type, title, body) {
  db.messages.insert({ userId, type, title, body, ts: new Date().toISOString(), read: false });
}

/** 快递发货：paid -> shipped */
function shipOrder(db, { orderId, company, trackingNo, operator = 'system', merchantId }) {
  const order = getOrder(db, orderId);
  assertMerchant(order, merchantId);
  if ((order.deliveryType || 'express') !== 'express') throw new Error('到店核销订单无需发货');
  if (order.status !== 'paid') throw new Error('订单状态不可发货（仅待发货可发）');
  if (order.afterSaleStatus === 'applying') throw new Error('该订单有进行中的售后申请，暂不可发货');
  if (!trackingNo || String(trackingNo).trim().length < 4) throw new Error('请填写有效的快递单号');
  const now = new Date().toISOString();
  const co = company && String(company).trim() ? String(company).trim().slice(0, 20) : '其他';
  db.orders.update(order.id, {
    status: 'shipped',
    shippedAt: now,
    expressCompany: co,
    expressNo: String(trackingNo).trim().slice(0, 40),
    shippedBy: operator,
  });
  pushMessage(db, order.userId, 'order_shipped', '订单已发货', `订单 ${order.id} 已发货（${co}：${trackingNo}），收到后请确认收货。`);
  audit(db, operator, 'order.ship', { orderId: order.id, company: co, trackingNo: String(trackingNo).trim() });
  return db.orders.get(order.id);
}

/** 到店核销：paid -> done（凭核销码，一单一码；也支持只传核销码自动定位订单） */
function verifyStoreOrder(db, { orderId, verifyCode, operator = 'system', merchantId }) {
  if (!verifyCode) throw new Error('请填写核销码');
  let order;
  if (orderId != null && orderId !== '') {
    order = getOrder(db, orderId);
  } else {
    // 只给核销码：在"待核销 + 到店"订单里按码定位（商家端可只输码）
    const code = String(verifyCode).trim();
    const matches = db.orders.where((o) => String(o.verifyCode || '') === code
      && o.deliveryType === 'store' && o.status === 'paid'
      && (merchantId == null || merchantId === '' || String(o.merchantId || '') === String(merchantId)));
    if (matches.length === 0) throw new Error('未找到该核销码对应的待核销订单');
    if (matches.length > 1) throw new Error('核销码重复，请指定订单号核销');
    order = matches[0];
  }
  assertMerchant(order, merchantId);
  if ((order.deliveryType || 'express') !== 'store') throw new Error('该订单为快递订单，请走发货流程');
  if (order.status !== 'paid') throw new Error('订单状态不可核销（仅待核销可核）');
  if (order.afterSaleStatus === 'applying') throw new Error('该订单有进行中的售后申请，暂不可核销');
  if (String(verifyCode).trim() !== String(order.verifyCode || '')) throw new Error('核销码不正确');
  const now = new Date().toISOString();
  db.orders.update(order.id, { status: 'done', storeVerifiedAt: now, storeVerifiedBy: operator, doneAt: now });
  pushMessage(db, order.userId, 'order_verified', '到店核销成功', `订单 ${order.id} 已到店核销，欢迎再次复购。`);
  audit(db, operator, 'order.store_verify', { orderId: order.id });
  return db.orders.get(order.id);
}

/** 确认收货：shipped -> done（auto=true 为超时自动收货） */
function confirmReceipt(db, { orderId, userId, auto = false }) {
  const order = getOrder(db, orderId);
  if (userId != null && String(order.userId) !== String(userId)) throw new Error('无权操作该订单');
  if (order.status !== 'shipped') throw new Error('订单状态不可确认收货（仅已发货可确认）');
  const now = new Date().toISOString();
  db.orders.update(order.id, {
    status: 'done',
    receivedAt: now,
    doneAt: now,
    receivedBy: auto ? 'auto' : 'user',
  });
  audit(db, auto ? 'system' : `user:${order.userId}`, auto ? 'order.auto_receive' : 'order.receive', { orderId: order.id });
  return db.orders.get(order.id);
}

/** 自动收货跑批：发货超过 N 天未确认的订单自动完成 */
function autoReceiveShipped(db, { now = Date.now(), days = 7 } = {}) {
  const windowMs = Math.max(1, Number(days) || 7) * 86400000;
  const received = [];
  for (const order of db.orders.where((o) => o.status === 'shipped' && o.shippedAt)) {
    if (new Date(order.shippedAt).getTime() + windowMs > now) continue;
    confirmReceipt(db, { orderId: order.id, auto: true });
    received.push(order.id);
  }
  return received;
}

/** 售后申请（用户）：paid/shipped/done 均可申请；done 受窗口限制 */
function applyAfterSale(db, { orderId, userId, reason, windowDays = 7 }) {
  const order = getOrder(db, orderId);
  if (String(order.userId) !== String(userId)) throw new Error('无权操作该订单');
  if (order.payType === 'FREE') throw new Error('免单订单不支持售后申请，请联系客服');
  if (!['paid', 'shipped', 'done'].includes(order.status)) throw new Error('订单状态不可申请售后');
  if (order.afterSaleStatus && order.afterSaleStatus !== 'rejected') throw new Error('该订单已有售后记录，请联系客服');
  if (order.status === 'done' && !afterSaleWindowOpen(order, Date.now(), windowDays)) throw new Error('已超过售后申请期限，请联系客服');
  if (!reason || String(reason).trim().length < 4) throw new Error('请填写售后原因（不少于 4 个字）');
  const now = new Date().toISOString();
  db.orders.update(order.id, {
    afterSaleStatus: 'applying',
    afterSaleReason: String(reason).trim().slice(0, 200),
    afterSaleAppliedAt: now,
  });
  pushMessage(db, order.userId, 'after_sale_applying', '售后申请已提交', `订单 ${order.id} 的售后申请已提交，平台将在 48 小时内处理。`);
  audit(db, `user:${order.userId}`, 'order.after_sale_apply', { orderId: order.id });
  return db.orders.get(order.id);
}

/**
 * 售后处理（平台）：approved 时由调用方注入 refund（services.refundOrder，含分佣/池回滚），
 * 避免 fulfillment <-> services 循环依赖。
 */
function resolveAfterSale(db, { orderId, approved, note, operator = 'admin', refund }) {
  const order = getOrder(db, orderId);
  if (order.afterSaleStatus !== 'applying') throw new Error('该订单没有待处理的售后申请');
  const now = new Date().toISOString();
  if (approved) {
    if (typeof refund !== 'function') throw new Error('退款通道未就绪');
    refund(order.id);
    db.orders.update(order.id, {
      afterSaleStatus: 'approved',
      afterSaleHandledAt: now,
      afterSaleHandledBy: operator,
      afterSaleNote: String(note || '').slice(0, 200),
    });
    pushMessage(db, order.userId, 'after_sale_approved', '售后已受理', `订单 ${order.id} 的售后已受理，款项将原路退回。`);
  } else {
    db.orders.update(order.id, {
      afterSaleStatus: 'rejected',
      afterSaleHandledAt: now,
      afterSaleHandledBy: operator,
      afterSaleNote: String(note || '').slice(0, 200),
    });
    pushMessage(db, order.userId, 'after_sale_rejected', '售后未通过', `订单 ${order.id} 的售后申请未通过${note ? '：' + note : ''}。`);
  }
  audit(db, operator, 'order.after_sale_resolve', { orderId: order.id, approved, note: note || '' });
  return db.orders.get(order.id);
}

/**
 * 平台强制完成（异常订单人工处理，留审计）：paid/shipped -> done
 * 用于"到店未核销但已线下完成""快递丢件补发"等异常场景。
 */
function forceCompleteOrder(db, { orderId, operator = 'admin', note }) {
  const order = getOrder(db, orderId);
  if (!['paid', 'shipped'].includes(order.status)) throw new Error('订单状态不可强制完成');
  const now = new Date().toISOString();
  const patch = {
    status: 'done',
    doneAt: now,
    receivedAt: order.receivedAt || now,
    receivedBy: 'manual',
    manualNote: String(note || '').slice(0, 200),
  };
  if ((order.deliveryType || 'express') === 'store') patch.storeVerifiedAt = order.storeVerifiedAt || now;
  db.orders.update(order.id, patch);
  audit(db, operator, 'order.force_complete', { orderId: order.id, note: note || '' });
  return db.orders.get(order.id);
}

module.exports = {
  EXPRESS_COMPANIES,
  makeVerifyCode,
  warrantyStartOf,
  afterSaleWindowOpen,
  shipOrder,
  verifyStoreOrder,
  confirmReceipt,
  autoReceiveShipped,
  applyAfterSale,
  resolveAfterSale,
  forceCompleteOrder,
};
