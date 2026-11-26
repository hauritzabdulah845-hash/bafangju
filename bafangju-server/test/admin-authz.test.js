'use strict';
/**
 * 管理后台鉴权回归（P0-1 修复）：
 * ① 全部 /api/admin/* 接口（除 login/logout）未带 token 一律 401 —— 防止路由注册在鉴权中间件之前再次绕过；
 * ② 带无效 token 一律 401；
 * ③ 带有效 token 可正常访问；
 * ④ login 无 token 可用；logout 无 token 幂等返回 200。
 *
 * 说明：本文件以内存库启动真实 Express 应用（不落盘），用 fetch 直接打接口。
 */
process.env.BAFANGJU_DB_DRIVER = 'memory';
process.env.WX_APPID = '';
process.env.WX_SECRET = '';
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASSWORD = 'TestAdminPwd2026';

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

/** 全部管理后台接口清单（与 src/server.js 注册保持一致） */
const ADMIN_ROUTES = [
  ['GET', '/api/admin/rules'],
  ['GET', '/api/admin/level-config'],
  ['POST', '/api/admin/level-config'],
  ['POST', '/api/admin/rules/version'],
  ['GET', '/api/admin/settings/wxmp'],
  ['POST', '/api/admin/settings/wxmp'],
  ['POST', '/api/admin/settings/wxmp/test'],
  ['POST', '/api/admin/messages/broadcast'],
  ['GET', '/api/admin/messages'],
  ['POST', '/api/admin/switches'],
  ['GET', '/api/admin/audit'],
  ['GET', '/api/admin/task-config'],
  ['POST', '/api/admin/task-config'],
  ['GET', '/api/admin/catalog/products'],
  ['GET', '/api/admin/catalog/categories'],
  ['POST', '/api/admin/catalog/categories'],
  ['POST', '/api/admin/catalog/categories/update'],
  ['POST', '/api/admin/catalog/products'],
  ['POST', '/api/admin/catalog/products/update'],
  ['POST', '/api/admin/risk/blacklist'],
  ['GET', '/api/admin/risk/blacklist'],
  ['GET', '/api/admin/risk/appeals'],
  ['POST', '/api/admin/risk/appeals/resolve'],
  ['POST', '/api/admin/jobs/risk-scan'],
  ['GET', '/api/admin/risk/alerts'],
  ['GET', '/api/admin/merchants/settlement'],
  ['GET', '/api/admin/alliance-orders'],
  ['POST', '/api/admin/jobs/activity-snapshot'],
  ['POST', '/api/admin/jobs/daily-dividend'],
  ['GET', '/api/admin/leader-pool'],
  ['POST', '/api/admin/jobs/leader-dividend'],
  ['POST', '/api/admin/reserve/deposit'],
  ['POST', '/api/admin/quarter/assess'],
  ['POST', '/api/admin/quarter/payout-auto'],
  ['POST', '/api/admin/quarter/payout'],
  ['GET', '/api/admin/merchants'],
  ['POST', '/api/admin/merchants/create'],
  ['GET', '/api/admin/merchant-applications'],
  ['GET', '/api/admin/uploads/private/x.png'],
  ['POST', '/api/admin/merchant-applications/review'],
  ['POST', '/api/admin/merchants/status'],
  ['POST', '/api/admin/merchants/reset-token'],
  ['POST', '/api/admin/merchants/reset-password'],
  ['GET', '/api/admin/adslots'],
  ['POST', '/api/admin/adslots/create'],
  ['POST', '/api/admin/adslots/review'],
  ['POST', '/api/admin/adslots/book'],
  ['POST', '/api/admin/withdraw/bind-receiver'],
  ['GET', '/api/admin/withdraw/requests'],
  ['GET', '/api/admin/withdraw/transfers'],
  ['POST', '/api/admin/withdraw/approve'],
  ['POST', '/api/admin/jobs/issue-queued'],
  ['POST', '/api/admin/jobs/expire-transfers'],
  ['POST', '/api/admin/jobs/retry-transfers'],
  ['GET', '/api/admin/orders'],
  ['GET', '/api/admin/queue-slots'],
  ['GET', '/api/admin/stats/daily'],
  ['POST', '/api/admin/orders/refund'],
  ['POST', '/api/admin/orders/ship'],
  ['POST', '/api/admin/orders/verify'],
  ['POST', '/api/admin/orders/complete'],
  ['POST', '/api/admin/orders/after-sale/resolve'],
  ['GET', '/api/admin/orders/fulfillment-summary'],
  ['POST', '/api/admin/commission/settle'],
  ['POST', '/api/admin/jobs/settle-commission'],
  ['GET', '/api/admin/platform-flows'],
  ['GET', '/api/admin/economics/preview'],
];

/** 曾因注册顺序错误而绕过鉴权的 9 个接口（历史 P0-1） */
const PREVIOUSLY_OPEN_ROUTES = [
  ['GET', '/api/admin/rules'],
  ['GET', '/api/admin/level-config'],
  ['POST', '/api/admin/level-config'],
  ['POST', '/api/admin/rules/version'],
  ['GET', '/api/admin/settings/wxmp'],
  ['POST', '/api/admin/settings/wxmp'],
  ['POST', '/api/admin/settings/wxmp/test'],
  ['POST', '/api/admin/messages/broadcast'],
  ['GET', '/api/admin/messages'],
];

let adminToken;

test('准备：管理员登录可用并拿到 token', async () => {
  const r = await api('/api/admin/login', {
    method: 'POST',
    body: { username: 'admin', password: 'TestAdminPwd2026' },
  });
  assert.strictEqual(r.status, 200);
  assert.ok(r.data.token);
  adminToken = r.data.token;
});

test('全部 /api/admin/* 接口未带 token 一律 401', async () => {
  for (const [method, path] of ADMIN_ROUTES) {
    const r = await api(path, { method });
    assert.strictEqual(r.status, 401, `${method} ${path} 未认证应 401，实际 ${r.status}`);
  }
});

test('全部 /api/admin/* 接口带无效 token 一律 401', async () => {
  for (const [method, path] of ADMIN_ROUTES) {
    const r = await api(path, { method, token: 'not-a-real-session-token' });
    assert.strictEqual(r.status, 401, `${method} ${path} 无效 token 应 401，实际 ${r.status}`);
  }
});

test('历史上绕过的 9 个接口：未认证已无法读写', async () => {
  for (const [method, path] of PREVIOUSLY_OPEN_ROUTES) {
    const r = await api(path, { method });
    assert.strictEqual(r.status, 401, `${method} ${path} 应已被鉴权覆盖，实际 ${r.status}`);
    assert.ok(r.data && r.data.error, `${method} ${path} 应返回鉴权错误信息`);
  }
});

test('带上有效 token 后管理后台功能正常（读写均不再被拦截）', async () => {
  const reads = [
    '/api/admin/rules',
    '/api/admin/level-config',
    '/api/admin/settings/wxmp',
    '/api/admin/messages',
    '/api/admin/audit',
    '/api/admin/merchants',
    '/api/admin/orders',
    '/api/admin/platform-flows',
  ];
  for (const path of reads) {
    const r = await api(path, { token: adminToken });
    assert.strictEqual(r.status, 200, `${path} 携带有效 token 应 200，实际 ${r.status}`);
  }

  // 写接口：此前绕过鉴权，现在必须凭有效 token 才能执行
  const v = await api('/api/admin/rules/version', { method: 'POST', token: adminToken, body: { version: '2026-10-26' } });
  assert.strictEqual(v.status, 200);
  assert.strictEqual(v.data.version, '2026-10-26');
  assert.strictEqual(db.switches.get('rulesVersion'), '2026-10-26');

  const lv = await api('/api/admin/level-config', {
    method: 'POST', token: adminToken,
    body: { thresholds: { V1: 5, V2: 100, V3: 1000, V4: 10000, V5: 100000, V6: 1000000 } },
  });
  assert.strictEqual(lv.status, 200);

  const bc = await api('/api/admin/messages/broadcast', {
    method: 'POST', token: adminToken, body: { title: '鉴权回归测试公告', body: '仅用于验证鉴权链路' },
  });
  assert.strictEqual(bc.status, 200);
});

test('token 也可通过 query 传递（与商家端一致）', async () => {
  const r = await api('/api/admin/rules?token=' + adminToken);
  assert.strictEqual(r.status, 200);
});

test('login 无 token 可用；logout 无 token 幂等返回 200', async () => {
  const login = await api('/api/admin/login', { method: 'POST', body: { username: 'admin', password: 'TestAdminPwd2026' } });
  assert.strictEqual(login.status, 200);

  const bad = await api('/api/admin/login', { method: 'POST', body: { username: 'admin', password: 'wrong-password' } });
  assert.strictEqual(bad.status, 401);

  const logout = await api('/api/admin/logout', { method: 'POST' });
  assert.strictEqual(logout.status, 200);
  assert.strictEqual(logout.data.ok, false);
});

test('change-password 未认证 401，携带有效 token 可用', async () => {
  const anon = await api('/api/admin/change-password', { method: 'POST', body: { oldPassword: 'x', newPassword: 'yyyyyyyy' } });
  assert.strictEqual(anon.status, 401);

  const wrongOld = await api('/api/admin/change-password', {
    method: 'POST', token: adminToken, body: { oldPassword: 'not-the-password', newPassword: 'NewAdminPwd2026' },
  });
  assert.strictEqual(wrongOld.status, 400);
});

test('B2：季度手工发放已下线（410），手工候选入参不再写入资格快照', async () => {
  const manual = await api('/api/admin/quarter/payout', {
    method: 'POST', token: adminToken,
    body: { quarter: '2026Q3', poolFen: 999999, weights: [{ userId: 'attacker', performance: 1, activity: 0, adContribution: 0 }] },
  });
  assert.strictEqual(manual.status, 410);
  assert.match(manual.data.error, /已下线/);
  assert.ok(!db.earnings.get('attacker'), '手工入口不得凭空入账');
  assert.strictEqual(db.dividendPayouts.all().length, 0);

  // candidates/thresholds 被忽略：仅按真实数据核算
  const assess = await api('/api/admin/quarter/assess', {
    method: 'POST', token: adminToken,
    body: {
      quarter: '2026Q3',
      candidates: [{ userId: 'attacker', quarterConsumptionFen: 99999999, activeUserRatio: 1, adSpendFen: 99999999 }],
      thresholds: { activeRatio: 0 },
    },
  });
  assert.strictEqual(assess.status, 200);
  assert.ok(Array.isArray(assess.data));
  assert.ok(!assess.data.some((r) => r.userId === 'attacker'), '手工候选不得写入资格快照');

  const missing = await api('/api/admin/quarter/assess', { method: 'POST', token: adminToken, body: {} });
  assert.strictEqual(missing.status, 400);
  assert.match(missing.data.error, /季度必填/);
});

test('平台代投 HTTP：代投成功返回 booking+quota，商家自助 book 返回 410（V4.3）', async () => {
  const ad = require('../src/domain/ad');
  const adCenter = require('../src/domain/adCenter');
  const merchantDomain = require('../src/domain/merchant');

  db.merchants.insert({ id: 'm-quota-http', name: '额度测试店', status: 'active' });
  const slot = ad.createSlot(db, { name: '代投测试位', position: 'home_banner', minDays: 7, feePerCycleFen: 20000 });
  adCenter.grantQuota(db, { merchantId: 'm-quota-http', fen: 50000, note: 'HTTP 用例' });

  const r = await api('/api/admin/adslots/book', {
    method: 'POST', token: adminToken,
    body: { slotId: slot.id, merchantId: 'm-quota-http', days: 7, title: '代投测试', imageUrl: '/uploads/x.jpg' },
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.booking.status, 'active');
  assert.strictEqual(r.data.booking.billingMode, 'quota');
  assert.strictEqual(r.data.booking.feeFen, 20000);
  assert.strictEqual(r.data.quota.availableFen, 30000);

  // 额度不足时服务端拒绝（换一个空闲位，排除「广告位占用」干扰），且不产生第二条投放
  const slot2 = ad.createSlot(db, { name: '代投测试位二', position: 'category', minDays: 7, feePerCycleFen: 20000 });
  const over = await api('/api/admin/adslots/book', {
    method: 'POST', token: adminToken,
    body: { slotId: slot2.id, merchantId: 'm-quota-http', days: 14, title: '超额代投', imageUrl: '/uploads/y.jpg' },
  });
  assert.strictEqual(over.status, 400);
  assert.match(over.data.error, /额度不足/);
  assert.strictEqual(db.adSlots.get(slot2.id).status, 'available');

  // 商家端自助投放入口已下线
  const { merchant: m, initialPassword } = merchantDomain.adminCreateMerchant(db, { name: '自助测试店', operator: 'admin' });
  const login = await api('/api/merchant/login', { method: 'POST', body: { username: m.username, password: initialPassword } });
  assert.strictEqual(login.status, 200);
  const self = await api('/api/merchant/adslots/book', { method: 'POST', token: login.data.token, body: { slotId: slot.id, days: 7 } });
  assert.strictEqual(self.status, 410);
  assert.match(self.data.error, /平台协助投放/);
});
