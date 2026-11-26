'use strict';
/**
 * 退款闭环（S4 后续）回归：
 * ① 微信退款结果通知 SUCCESS 只入账一次，重复通知不重复回滚分佣/分红池/团队长池；
 * ② ABNORMAL / CLOSED 落明确失败状态并进入异常队列，绝不落 refunded；
 * ③ 主动查单：SUCCESS 推进终态；长期处理中入异常队列；凭证未就绪安全失败；
 * ④ 异常队列阈值告警每小时最多一条，后台列表能看到原因与重试次数。
 */
process.env.BAFANGJU_DB_DRIVER = 'memory';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { createStore } = require('../src/store');
const { buildContext } = require('../src/app-context');

const ENV_KEYS = ['PAY_MODE', 'WX_MCHID', 'WX_APPID', 'WX_MERCHANT_SERIAL', 'WX_PRIVATE_KEY', 'WX_REFUND_NOTIFY_URL'];

/** 切到 live 模式（假证书即可，查询/退款签名用私钥生成）；返回恢复函数 */
function useLiveEnv() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const patch = {
    PAY_MODE: 'live',
    WX_MCHID: 'm', WX_APPID: 'a', WX_MERCHANT_SERIAL: 's',
    WX_PRIVATE_KEY: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    WX_REFUND_NOTIFY_URL: 'https://example.com/api/payment/refund-notify',
  };
  const old = {};
  for (const k of ENV_KEYS) { old[k] = process.env[k]; }
  for (const [k, v] of Object.entries(patch)) process.env[k] = v;
  return () => {
    for (const k of ENV_KEYS) {
      if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k];
    }
  };
}

function makeOrder(db, over = {}) {
  return db.orders.insert({
    userId: 'u1', payType: 'WX_PAY', status: 'paid', priceFen: 1000, paidFen: 1000,
    createdAt: new Date().toISOString(), ...over,
  });
}

function openAnomalies(db) {
  return db.refundAnomalies.where((a) => a.status === 'open');
}

test('退款通知 SUCCESS：入账一次；重复通知 replay，不重复回滚', () => {
  const restore = useLiveEnv();
  try {
    const db = createStore();
    const ctx = buildContext({ db, UPLOAD_DIR: 'unused', PRIVATE_UPLOAD_DIR: 'unused' });
    const order = makeOrder(db);
    const refundNo = `RF_${order.id}`;
    db.orders.update(order.id, { refundNo, refundStatus: 'PROCESSING', refundRequestedAt: new Date().toISOString() });
    db.dividendPoolFlows.insert({ direction: 'in', fen: 200, orderId: order.id, ts: new Date().toISOString() });

    const out = ctx.applyRefundResult(db.orders.get(order.id), { status: 'SUCCESS', refundId: 'wx_r1', refundNo }, { source: 'notify' });
    assert.strictEqual(out.finalized, true);
    let o = db.orders.get(order.id);
    assert.strictEqual(o.status, 'refunded');
    assert.strictEqual(o.refundStatus, 'SUCCESS');
    assert.strictEqual(db.dividendPoolFlows.where((f) => f.orderId === order.id && f.ref === 'refund_rollback').length, 1);

    // 重复通知：直接 replay，不再回滚、不再写退款流水
    const again = ctx.applyRefundResult(db.orders.get(order.id), { status: 'SUCCESS', refundId: 'wx_r1', refundNo }, { source: 'notify' });
    assert.strictEqual(again.replay, true);
    o = db.orders.get(order.id);
    assert.strictEqual(o.status, 'refunded');
    assert.strictEqual(db.dividendPoolFlows.where((f) => f.orderId === order.id && f.ref === 'refund_rollback').length, 1);
    assert.strictEqual(db.auditLogs.slice().filter((a) => a.action === 'order.refund'
      && JSON.parse(a.detail).orderId === order.id).length, 1);
  } finally {
    restore();
  }
});

test('退款通知失败/关闭：落明确失败态并进异常队列，绝不落 refunded', () => {
  const restore = useLiveEnv();
  try {
    const db = createStore();
    const ctx = buildContext({ db, UPLOAD_DIR: 'unused', PRIVATE_UPLOAD_DIR: 'unused' });
    const order = makeOrder(db);
    const refundNo = `RF_${order.id}`;
    db.orders.update(order.id, { refundNo, refundStatus: 'PROCESSING', refundRequestedAt: new Date().toISOString() });

    const out = ctx.applyRefundResult(db.orders.get(order.id), { status: 'CLOSED', refundNo, message: '退款关闭' }, { source: 'notify' });
    assert.strictEqual(out.failed, true);
    const o = db.orders.get(order.id);
    assert.strictEqual(o.status, 'paid');
    assert.strictEqual(o.refundStatus, 'CLOSED');
    assert.ok(o.refundError.includes('退款关闭'));
    assert.strictEqual(openAnomalies(db).length, 1);
    assert.strictEqual(openAnomalies(db)[0].lastStatus, 'CLOSED');
    // 重复的同类失败通知：状态幂等，不会重复入队
    ctx.applyRefundResult(db.orders.get(order.id), { status: 'CLOSED', refundNo, message: '退款关闭' }, { source: 'notify' });
    assert.strictEqual(openAnomalies(db).length, 1);
  } finally {
    restore();
  }
});

test('主动查单：SUCCESS 推进终态；长期处理中入异常队列；阈值告警每小时只报一次', async () => {
  const restore = useLiveEnv();
  const origFetch = globalThis.fetch;
  const longAgo = new Date(Date.now() - 30 * 3600000).toISOString();
  globalThis.fetch = async (url) => {
    if (String(url).includes('/refunds/RF_done')) {
      return { json: async () => ({ refund_id: 'wx_done', out_refund_no: 'RF_done', status: 'SUCCESS', amount: { refund: 1000 } }) };
    }
    return { json: async () => ({ refund_id: 'wx_stuck', out_refund_no: 'RF_stuck', status: 'PROCESSING', amount: { refund: 1000 } }) };
  };
  try {
    const db = createStore();
    const ctx = buildContext({ db, UPLOAD_DIR: 'unused', PRIVATE_UPLOAD_DIR: 'unused' });
    const done = makeOrder(db);
    db.orders.update(done.id, { refundNo: 'RF_done', refundStatus: 'PROCESSING', refundRequestedAt: new Date().toISOString() });
    const stuck = makeOrder(db);
    db.orders.update(stuck.id, { refundNo: 'RF_stuck', refundStatus: 'PROCESSING', refundRequestedAt: longAgo });

    const r1 = await ctx.syncRefundOrder(done.id, { operator: 'admin:test', source: 'test' });
    assert.strictEqual(r1.finalized, true);
    assert.strictEqual(db.orders.get(done.id).status, 'refunded');

    const r2 = await ctx.syncRefundOrder(stuck.id, { operator: 'admin:test', source: 'test' });
    assert.strictEqual(r2.pending, true);
    assert.strictEqual(db.orders.get(stuck.id).status, 'paid');
    assert.strictEqual(db.orders.get(stuck.id).refundStatus, 'PROCESSING');
    const rows = openAnomalies(db);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].kind, 'stalled');
    assert.ok(rows[0].reason.includes('处理中'));

    // 阈值默认 3 笔：再加两笔失败异常 → 告警一次，同一小时不重复
    for (let i = 0; i < 2; i += 1) {
      const o = makeOrder(db);
      db.orders.update(o.id, { refundNo: `RF_f${i}`, refundStatus: 'PROCESSING' });
      ctx.applyRefundResult(db.orders.get(o.id), { status: 'ABNORMAL', refundNo: `RF_f${i}`, message: '银行退票' }, { source: 'notify' });
    }
    const alert1 = ctx.refund.raiseAlertIfNeeded(db, { now: Date.now() });
    assert.strictEqual(alert1.alerted, true);
    const alert2 = ctx.refund.raiseAlertIfNeeded(db, { now: Date.now() });
    assert.strictEqual(alert2.alerted, false);
    assert.strictEqual(db.auditLogs.slice().filter((a) => a.action === 'refund.anomaly_alert').length, 1);

    const view = ctx.refund.listAnomalies(db);
    assert.strictEqual(view.count, 3);
    assert.strictEqual(view.overThreshold, true);
    assert.ok(view.oldestHours >= 29);
    assert.ok(view.items.every((i) => i.reason));
  } finally {
    globalThis.fetch = origFetch;
    restore();
  }
});

test('凭证/通道未就绪：主动查单明确报错，订单状态保持不变（不伪造成功）', async () => {
  const db = createStore();
  const ctx = buildContext({ db, UPLOAD_DIR: 'unused', PRIVATE_UPLOAD_DIR: 'unused' });
  const order = makeOrder(db);
  db.orders.update(order.id, { refundNo: 'RF_mock', refundStatus: 'PROCESSING', refundRequestedAt: new Date().toISOString() });
  await assert.rejects(ctx.syncRefundOrder(order.id, { operator: 'admin:test' }), /模拟支付模式/);
  const o = db.orders.get(order.id);
  assert.strictEqual(o.status, 'paid');
  assert.strictEqual(o.refundStatus, 'PROCESSING');
  assert.strictEqual(openAnomalies(db).length, 0);
});
