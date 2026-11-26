'use strict';
/**
 * 订单聚合索引（P3-1）。
 *
 * 背景：/api/products 原先对每个商品做一次 `db.orders.where(...)` 全表扫描，
 * 复杂度 O(商品数 × 订单数)；商家工作台与后台履约汇总也各自重复扫描。
 *
 * 方案：一次遍历 orders 表同时算出三份聚合（商品已拼数 / 商家待办 / 全站履约统计），
 * 并以 orders 表的写入版本号 `_ver` 作为缓存失效依据 —— 任何 insert/update/delete
 * 都会自增 `_ver`，下次读取自动重建索引；无写入时复用上一次的 Map。
 *
 * 口径与改造前的逐条 where() 完全一致（有效订单 = paid/done/shipped）。
 */

/** 计入「已拼件数」的有效订单状态 */
const SOLD_STATUS = new Set(['paid', 'done', 'shipped']);

/** orders 表 -> { ver, soldByProduct, pendingByMerchant, fulfillment } */
const CACHE = new WeakMap();

function buildIndex(db) {
  const soldByProduct = new Map();       // productId -> 已拼件数
  const pendingByMerchant = new Map();   // merchantId -> { pendingShip, pendingVerify }
  const fulfillment = { pendingShip: 0, pendingVerify: 0, shipped: 0, afterSaleApplying: 0, done: 0 };
  for (const o of db.orders.all()) {
    const status = o.status;
    if (SOLD_STATUS.has(status)) {
      soldByProduct.set(o.productId, (soldByProduct.get(o.productId) || 0) + 1);
    }
    if (status === 'paid') {
      // 待发货：deliveryType 缺省视为 express；待核销：显式为 store
      if ((o.deliveryType || 'express') === 'express') fulfillment.pendingShip += 1;
      if (o.deliveryType === 'store') fulfillment.pendingVerify += 1;
      if (o.merchantId != null) {
        const mid = String(o.merchantId);
        const cur = pendingByMerchant.get(mid) || { pendingShip: 0, pendingVerify: 0 };
        if ((o.deliveryType || 'express') === 'express') cur.pendingShip += 1;
        if (o.deliveryType === 'store') cur.pendingVerify += 1;
        pendingByMerchant.set(mid, cur);
      }
    }
    if (status === 'shipped') fulfillment.shipped += 1;
    if (status === 'done') fulfillment.done += 1;
    if (o.afterSaleStatus === 'applying') fulfillment.afterSaleApplying += 1;
  }
  return { ver: db.orders._ver, soldByProduct, pendingByMerchant, fulfillment };
}

/** 取索引（按 orders 表写入版本号缓存） */
function index(db) {
  const hit = CACHE.get(db.orders);
  if (hit && hit.ver === db.orders._ver) return hit;
  const next = buildIndex(db);
  CACHE.set(db.orders, next);
  return next;
}

/** 某商品已拼件数（有效支付订单数） */
function soldCount(db, productId) {
  return index(db).soldByProduct.get(productId) || 0;
}

/** 某商家待办：待发货 / 待核销（字段名与 /api/merchant/overview 响应契约一致） */
function merchantPending(db, merchantId) {
  return index(db).pendingByMerchant.get(String(merchantId)) || { pendingShip: 0, pendingVerify: 0 };
}

/** 全站履约汇总（后台用） */
function fulfillmentStats(db) {
  return index(db).fulfillment;
}

module.exports = { soldCount, merchantPending, fulfillmentStats };
