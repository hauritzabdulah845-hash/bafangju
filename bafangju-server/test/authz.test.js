'use strict';
/**
 * 鉴权回归用例（V3.8）：
 * ① 越权收口：个人数据只返回会话本人的，query 里的 userId 不再被信任；
 * ② 商家登录：账号 + 密码，错误密码/不存在账号拒绝，不自动注册；
 * ③ 公开接口不受影响。
 *
 * 说明：本文件以内存库启动真实 Express 应用（不落盘、不启用定时器），用 fetch 直接打接口。
 */
process.env.BAFANGJU_DB_DRIVER = 'memory';
// 强制走开发态登录（不依赖真实微信商户参数），保证鉴权用例在任何环境都能跑
process.env.WX_APPID = '';
process.env.WX_SECRET = '';
// 管理后台账号由环境注入（不再依赖默认口令 admin/admin123，P0-2）
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASSWORD = 'AuthzTestAdminPwd2026';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { app, db } = require('../src/server');

let server;
let base;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: 'Bearer ' + token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

test('越权：用户不能通过 query userId 读取他人订单（含收货信息）', async () => {
  const a = await api('/api/user/login', { method: 'POST', body: { nickname: '甲用户' } });
  const b = await api('/api/user/login', { method: 'POST', body: { nickname: '乙用户' } });
  assert.strictEqual(a.status, 200);
  assert.strictEqual(b.status, 200);
  const bId = String(b.data.userId);

  db.orders.insert({
    userId: bId, productId: 'p_rice', priceFen: 1000, paidFen: 1000, status: 'paid',
    receiverName: '乙', receiverPhone: '13911112222', receiverAddress: '隐私地址 1 号',
    createdAt: new Date().toISOString(),
  });

  // 甲用自己的 token，试图通过 query 读取乙的订单 → 只返回甲自己的（空）
  const r = await api('/api/orders/list?userId=' + bId, { token: a.data.token });
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.data));
  assert.strictEqual(r.data.some((o) => o.receiverPhone === '13911112222'), false);
  assert.strictEqual(r.data.some((o) => o.userId === bId), false);

  // 未登录直接访问 → 401
  const anon = await api('/api/orders/list?userId=' + bId);
  assert.strictEqual(anon.status, 401);
});

test('越权：分红队位 / 消息中心只返回本人数据', async () => {
  const a = await api('/api/user/login', { method: 'POST', body: { nickname: '丙用户' } });
  const b = await api('/api/user/login', { method: 'POST', body: { nickname: '丁用户' } });
  const bId = String(b.data.userId);
  db.queueSlots.insert({ userId: bId, periodId: 'p1', status: 'waiting', grantedAt: new Date().toISOString() });
  db.messages.insert({ userId: bId, type: 'free_claimed', title: '丁的免单', body: 'x', ts: new Date().toISOString(), read: false });

  const d = await api('/api/dividend/my?userId=' + bId, { token: a.data.token });
  assert.strictEqual(d.status, 200);
  assert.strictEqual(d.data.slots.length, 0);

  const m = await api('/api/messages?userId=' + bId, { token: a.data.token });
  assert.strictEqual(m.status, 200);
  assert.strictEqual(m.data.messages.length, 0);
  assert.strictEqual(m.data.unread, 0);

  // 未登录 → 401
  assert.strictEqual((await api('/api/messages?userId=' + bId)).status, 401);
});

test('商家登录：必须账号 + 密码；错密码拒绝；不存在账号不自动注册', async () => {
  const admin = await api('/api/admin/login', { method: 'POST', body: { username: process.env.ADMIN_USER, password: process.env.ADMIN_PASSWORD } });
  assert.strictEqual(admin.status, 200);

  const created = await api('/api/admin/merchants/create', {
    method: 'POST', token: admin.data.token,
    body: { name: '接口测试商户', contact: '13800001111', password: 'pass123456' },
  });
  assert.strictEqual(created.status, 200);
  assert.ok(created.data.initialPassword);
  assert.ok(created.data.merchant.username);

  // 密码错误 / 账号不存在：统一 400，且不自动注册
  assert.strictEqual((await api('/api/merchant/login', { method: 'POST', body: { username: '接口测试商户', password: 'wrong-pass' } })).status, 400);
  assert.strictEqual((await api('/api/merchant/login', { method: 'POST', body: { username: '幽灵商户', password: 'whatever' } })).status, 400);
  assert.strictEqual(db.merchants.where((m) => m.name === '幽灵商户').length, 0);

  // 正确登录 → 拿到 token，可访问商家接口
  const ok = await api('/api/merchant/login', { method: 'POST', body: { username: '接口测试商户', password: 'pass123456' } });
  assert.strictEqual(ok.status, 200);
  assert.ok(ok.data.token);
  assert.strictEqual((await api('/api/merchant/orders')).status, 401); // 无 token
  assert.strictEqual((await api('/api/merchant/orders', { token: ok.data.token })).status, 200);
});

test('公开接口：未登录仍可浏览首页与商品（不带个性化步位）', async () => {
  const home = await api('/api/home');
  assert.strictEqual(home.status, 200);
  assert.ok(Array.isArray(home.data.categories));

  const products = await api('/api/products');
  assert.strictEqual(products.status, 200);
  assert.ok(products.data.length > 0);
  assert.ok(products.data.every((p) => p.myStep === 1));
});

test('登录本地幂等：同一 deviceId 多次登录返回同一 userId（开发态无 WX_APPID 时）', async () => {
  const a = await api('/api/user/login', { method: 'POST', body: { deviceId: 'dev-A', nickname: '设备甲' } });
  const b = await api('/api/user/login', { method: 'POST', body: { deviceId: 'dev-A', nickname: '设备甲' } });
  assert.strictEqual(a.status, 200);
  assert.strictEqual(a.data.userId, b.data.userId);
  assert.strictEqual(b.data.created, false);
  const c = await api('/api/user/login', { method: 'POST', body: { deviceId: 'dev-B' } });
  assert.notStrictEqual(c.data.userId, a.data.userId);
});

test('支付：只能为自己的订单预下单；模拟支付仅本人可用', async () => {
  const a = await api('/api/user/login', { method: 'POST', body: { deviceId: 'pay-A' } });
  const b = await api('/api/user/login', { method: 'POST', body: { deviceId: 'pay-B' } });
  assert.strictEqual(a.status, 200);
  assert.strictEqual(b.status, 200);

  // 给乙造一笔待支付订单
  db.orders.insert({
    userId: String(b.data.userId), productId: 'p_rice', categoryId: 'cat_grain',
    payType: 'WX_PAY', status: 'pending_pay', priceFen: 1000, paidFen: 1000,
    createdAt: new Date().toISOString(),
  });
  const order = db.orders.where((o) => o.userId === String(b.data.userId) && o.status === 'pending_pay')[0];

  // 当前为模拟模式
  const cfg = await api('/api/payment/config');
  assert.strictEqual(cfg.status, 200);
  assert.strictEqual(cfg.data.mode, 'mock');

  // 甲不能为乙的订单预下单 / 模拟支付
  assert.strictEqual((await api('/api/payment/prepay', { method: 'POST', token: a.data.token, body: { orderId: order.id } })).status, 404);
  assert.strictEqual((await api('/api/payment/notify', { method: 'POST', token: a.data.token, body: { orderId: order.id } })).status, 404);

  // 乙可以：预下单返回 mock，模拟支付后订单变为已支付
  const prepay = await api('/api/payment/prepay', { method: 'POST', token: b.data.token, body: { orderId: order.id } });
  assert.strictEqual(prepay.status, 200);
  assert.strictEqual(prepay.data.provider, 'mock');
  const paid = await api('/api/payment/notify', { method: 'POST', token: b.data.token, body: { orderId: order.id } });
  assert.strictEqual(paid.status, 200);
  assert.strictEqual(db.orders.get(order.id).status, 'paid');

  // 单笔订单查询：仅本人可见
  assert.strictEqual((await api('/api/orders/' + order.id, { token: a.data.token })).status, 404);
  assert.strictEqual((await api('/api/orders/' + order.id, { token: b.data.token })).status, 200);
});
