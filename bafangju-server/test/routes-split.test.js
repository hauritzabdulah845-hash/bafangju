'use strict';
/**
 * 路由拆分回归（P3-4）：
 * ① 路由清单与拆分前基线**完全一致**（171 条 method+path；2026-10-29 阶梯新模型废除免单领取路由；2026-10-30 新增商家商品上传与平台审核 6 条），防止拆分过程中漏接口、改路径或重复注册；
 * ② 注册顺序硬约束（Express 按注册顺序匹配，中间件注册在路由之后即被绕过 = P0-1 根因）：
 *    管理后台鉴权中间件先于全部 /api/admin/* 路由；商家端鉴权中间件先于全部 /api/merchant/* 路由；
 *    attachUser（可选登录）先于 /api/upload；express.json 先于微信支付回调（原始字节验签依赖）；
 * ③ 通配路由不得吞掉字面量路由（/api/merchants/nearby 与 /api/orders/list）；
 * ④ src/server.js 只做装配，不再直接注册业务 API 路由（业务路由全部落在 src/routes/*.js）；
 * ⑤ 各路由模块统一以 register(app, ctx) 形式导出，便于统一注入与审计。
 *
 * 说明：以内存库加载真实 Express 应用（不落盘、不启用定时器）。
 */
process.env.BAFANGJU_DB_DRIVER = 'memory';
process.env.WX_APPID = '';
process.env.WX_SECRET = '';
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASSWORD = 'TestAdminPwd2026';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('../src/server');

const SRC_DIR = path.join(__dirname, '..', 'src');
const ROUTES_DIR = path.join(SRC_DIR, 'routes');

/** 拆分前基线路由清单（method + path），拆分后必须逐一保持一致 */
const EXPECTED_ROUTES = `
GET /
GET /api/admin/adslots
GET /api/admin/advideos
GET /api/admin/advideos/pricing-preview
GET /api/admin/alliance-orders
GET /api/admin/audit
GET /api/admin/content
GET /api/admin/catalog/categories
GET /api/admin/catalog/products
GET /api/admin/catalog/products/pending
GET /api/admin/economics/preview
GET /api/admin/leader-pool
GET /api/admin/ops-slides
GET /api/admin/level-config
GET /api/admin/merchant-applications
GET /api/admin/merchants
GET /api/admin/merchants/settlement
GET /api/admin/messages
GET /api/admin/orders
GET /api/admin/orders/fulfillment-summary
GET /api/admin/platform-flows
GET /api/admin/refund-anomalies
GET /api/admin/queue-slots
GET /api/admin/risk/alerts
GET /api/admin/risk/appeals
GET /api/admin/risk/blacklist
GET /api/admin/rules
GET /api/admin/settings/wxmp
GET /api/admin/stats/daily
GET /api/admin/task-config
GET /api/admin/uploads/private/:name
GET /api/admin/withdraw/requests
GET /api/admin/withdraw/transfers
GET /api/ads
GET /api/ads/videos
GET /api/ads/videos/:id/product
GET /api/content
GET /api/contribution/value
GET /api/coupons/available
GET /api/dividend/my
GET /api/dividend/pool
GET /api/filing
GET /api/health
GET /api/home
GET /api/ladder
GET /api/merchant/adslots
GET /api/merchant/adslots/mine
GET /api/merchant/alliance-orders
GET /api/merchant/categories
GET /api/merchant/coupons
GET /api/merchant/earnings
GET /api/merchant/orders
GET /api/merchant/overview
GET /api/merchant/products
GET /api/merchant/withdraw/receiver
GET /api/merchant/withdraw/status
GET /api/merchants/:id
GET /api/merchants/nearby
GET /api/messages
GET /api/admin/reward-withdrawals
GET /api/user/cash
GET /api/orders/:id
GET /api/orders/list
GET /api/payment/config
GET /api/products
GET /api/products/:id
GET /api/return-plans
GET /api/rules/version
GET /api/stats/public
GET /api/tasks/today
GET /api/user/addresses
GET /api/user/appeals
GET /api/user/contribution/30d
GET /api/user/coupons
GET /api/user/reward-withdrawals
GET /api/user/level
GET /api/user/promotion/earnings
GET /api/user/promotion/profile
GET /api/user/promotion/qrcode
GET /api/user/promotion/team
GET /api/user/profile
GET /api/user/rebuy
GET /api/user/withdraw/status
POST /api/admin/adslots/create
POST /api/admin/adslots/review
POST /api/admin/adslots/book
POST /api/admin/advideos/create
POST /api/admin/advideos/offline
POST /api/admin/advideos/review
POST /api/admin/catalog/categories
POST /api/admin/catalog/categories/update
POST /api/admin/content/reset
POST /api/admin/content/update
POST /api/admin/reward-withdrawals/approve
POST /api/admin/reward-withdrawals/offline-confirm
POST /api/admin/reward-withdrawals/offline-mark
POST /api/admin/reward-withdrawals/pay
POST /api/admin/reward-withdrawals/reject
POST /api/admin/catalog/products
POST /api/admin/catalog/products/review
POST /api/admin/catalog/products/update
POST /api/admin/change-password
GET /api/admin/me
GET /api/admin/users
POST /api/admin/users/create
POST /api/admin/users/update
POST /api/admin/users/reset-password
POST /api/admin/users/delete
POST /api/admin/commission/settle
POST /api/admin/jobs/activity-snapshot
POST /api/admin/jobs/daily-dividend
POST /api/admin/jobs/expire-transfers
POST /api/admin/jobs/issue-queued
POST /api/admin/jobs/leader-dividend
POST /api/admin/jobs/retry-transfers
POST /api/admin/jobs/risk-scan
POST /api/admin/jobs/settle-commission
POST /api/admin/ops-slides
POST /api/admin/ops-slides/delete
POST /api/admin/ops-slides/move
POST /api/admin/ops-slides/update
POST /api/admin/level-config
POST /api/admin/login
POST /api/admin/logout
POST /api/admin/merchant-applications/review
POST /api/admin/merchants/create
POST /api/admin/merchants/reset-password
POST /api/admin/merchants/reset-token
POST /api/admin/merchants/status
POST /api/admin/messages/broadcast
POST /api/admin/orders/after-sale/resolve
POST /api/admin/orders/complete
POST /api/admin/orders/refund
POST /api/admin/orders/refund/sync
POST /api/admin/orders/ship
POST /api/admin/orders/verify
POST /api/admin/quarter/assess
POST /api/admin/quarter/payout
POST /api/admin/quarter/payout-auto
POST /api/admin/refund-anomalies/retry
POST /api/admin/reserve/deposit
POST /api/admin/risk/appeals/resolve
POST /api/admin/risk/blacklist
POST /api/admin/rules/version
POST /api/admin/settings/wxmp
POST /api/admin/settings/wxmp/test
POST /api/admin/switches
POST /api/admin/task-config
POST /api/admin/withdraw/approve
POST /api/admin/withdraw/bind-receiver
POST /api/admin/upload
POST /api/ads/click
POST /api/ads/impression
POST /api/ads/videos/:id/reward
POST /api/ads/videos/:id/start
POST /api/coupons/claim
POST /api/merchant-entry/apply
POST /api/merchant/adslots/book
POST /api/merchant/coupons/create
POST /api/merchant/coupons/redeem
POST /api/merchant/coupons/verify
POST /api/merchant/login
POST /api/merchant/change-password
POST /api/merchant/orders/ship
POST /api/merchant/orders/verify
POST /api/merchant/products/create
POST /api/merchant/products/update
POST /api/merchant/withdraw/apply
POST /api/merchant/withdraw/bind-receiver
POST /api/merchant/withdraw/confirm
POST /api/messages/read
POST /api/orders
POST /api/orders/after-sale
POST /api/orders/confirm
POST /api/payment/notify
POST /api/payment/notify-wx
POST /api/payment/prepay
POST /api/payment/refund-notify
POST /api/tasks/ad-finish
POST /api/tasks/ad-start
POST /api/tasks/browse-finish
POST /api/tasks/browse-start
POST /api/tasks/complete
POST /api/upload
POST /api/user/addresses
POST /api/user/addresses/default
POST /api/user/addresses/delete
POST /api/user/appeals
POST /api/user/bind-referral
POST /api/user/login
POST /api/user/logout
POST /api/user/profile
POST /api/user/realname
POST /api/user/reward-withdraw
POST /api/user/rules/confirm
POST /api/user/withdraw/apply
POST /api/user/withdraw/confirm
POST /api/admin/upload/video
POST /api/admin/advideos/material
POST /api/admin/advideos/append-budget
POST /api/admin/advideos/settle
GET /api/admin/advideos/settlements
POST /api/admin/advideos/settlements/refunded
GET /api/admin/advideos/stats
GET /api/admin/advideos/stats.csv
GET /api/admin/ad-quotas
POST /api/admin/ad-quotas/grant
POST /api/ads/videos/:id/event
POST /api/merchant/upload/video
GET /api/merchant/ad-center
POST /api/merchant/ad-videos/create
POST /api/merchant/ad-videos/material
POST /api/merchant/ad-videos/append-budget
GET /api/merchant/quota-flows
GET /api/merchant/profile
POST /api/merchant/shop
GET /api/merchant/coupons/lookup
GET /api/merchant/fee-bills
GET /api/admin/merchant-fee-bills
POST /api/admin/merchant-fee-bills/pay
POST /api/admin/merchant-fee-bills/pay-month
GET /api/merchant-entry/status
POST /api/merchant/coupons/status
`.trim().split('\n').map((s) => s.trim());

/** 提取已注册路由（method+path，排序后） */
function collectRoutes() {
  const out = [];
  for (const layer of app._router.stack) {
    if (!layer.route) continue;
    const methods = Object.keys(layer.route.methods || {}).filter((m) => m !== '_all');
    for (const m of methods) out.push(m.toUpperCase() + ' ' + layer.route.path);
  }
  return out.sort();
}

/** 提取路由层下标：method+path → 首次出现的 layer 下标 */
function collectRouteIndexes() {
  const idx = new Map();
  app._router.stack.forEach((layer, i) => {
    if (!layer.route) return;
    const methods = Object.keys(layer.route.methods || {}).filter((m) => m !== '_all');
    for (const m of methods) {
      const key = m.toUpperCase() + ' ' + layer.route.path;
      if (!idx.has(key)) idx.set(key, i);
    }
  });
  return idx;
}

/** 中间件层下标：按处理函数名定位（Express 4 注册期不保存挂载路径） */
function indexOfMiddleware(fnName) {
  for (let i = 0; i < app._router.stack.length; i++) {
    const l = app._router.stack[i];
    if (!l.route && l.handle && l.handle.name === fnName) return i;
  }
  return -1;
}

test('路由清单与拆分前基线完全一致（219 条）', () => {
  const actual = collectRoutes();
  assert.strictEqual(actual.length, EXPECTED_ROUTES.length, `路由总数应为 ${EXPECTED_ROUTES.length}，实际 ${actual.length}`);
  const missing = EXPECTED_ROUTES.filter((r) => !actual.includes(r));
  const added = actual.filter((r) => !EXPECTED_ROUTES.includes(r));
  assert.deepStrictEqual(missing, [], `基线中存在但未注册的路由：${missing.join(', ')}`);
  assert.deepStrictEqual(added, [], '基线中不存在但多注册的路由：' + added.join(', '));
});

test('注册顺序：管理后台鉴权中间件先于全部 /api/admin/* 路由', () => {
  const mw = indexOfMiddleware('adminAuthGuard');
  assert.ok(mw >= 0, '未找到管理后台鉴权中间件 adminAuthGuard');
  const idx = collectRouteIndexes();
  for (const [key, i] of idx) {
    if (key === 'GET /api/admin' || key.includes(' /api/admin/')) {
      assert.ok(i > mw, `管理后台路由早于鉴权中间件注册（会被绕过）：${key}`);
    }
  }
});

test('注册顺序：商家端鉴权中间件先于全部 /api/merchant/* 路由', () => {
  const mw = indexOfMiddleware('merchantAuthGuard');
  assert.ok(mw >= 0, '未找到商家端鉴权中间件 merchantAuthGuard');
  const idx = collectRouteIndexes();
  for (const [key, i] of idx) {
    if (key.includes(' /api/merchant/')) {
      assert.ok(i > mw, `商家端路由早于鉴权中间件注册（会被绕过）：${key}`);
    }
  }
});

test('注册顺序：attachUser 先于 /api/upload；express.json 先于微信支付回调', () => {
  const attach = indexOfMiddleware('attachUser');
  const idx = collectRouteIndexes();
  assert.ok(attach >= 0, '未找到 attachUser 中间件');
  assert.ok(attach < idx.get('POST /api/upload'), 'attachUser 必须先于 /api/upload（上传需解析上传者身份）');

  let jsonIdx = -1;
  app._router.stack.forEach((l, i) => {
    if (!l.route && l.name === 'jsonParser') jsonIdx = i;
  });
  assert.ok(jsonIdx >= 0, '未找到 express.json 中间件');
  assert.ok(jsonIdx < idx.get('POST /api/payment/notify-wx'), 'express.json 必须先于 /api/payment/notify-wx（原始字节验签依赖）');
});

test('注册顺序：通配路由不吞字面量路由', () => {
  const idx = collectRouteIndexes();
  assert.ok(idx.get('GET /api/merchants/nearby') < idx.get('GET /api/merchants/:id'),
    '/api/merchants/nearby 必须先于 /api/merchants/:id');
  assert.ok(idx.get('GET /api/orders/list') < idx.get('GET /api/orders/:id'),
    '/api/orders/list 必须先于 /api/orders/:id');
});

test('server.js 只做装配：业务 API 路由不再直接注册', () => {
  const code = fs.readFileSync(path.join(SRC_DIR, 'server.js'), 'utf8');
  assert.ok(!/app\.(get|post|put|delete)\(\s*['"`]\/api\//.test(code),
    'src/server.js 不应再直接注册 /api/* 路由（应下沉到 src/routes/*.js）');
  assert.ok(/require\('\.\/routes\//.test(code), 'src/server.js 应通过 require 注册各域路由模块');
});

test('路由模块齐备且统一以 register(app, ctx) 导出', () => {
  const files = ['public.js', 'user.js', 'payment.js', 'upload.js', 'admin.js', 'merchant.js'];
  for (const f of files) {
    const p = path.join(ROUTES_DIR, f);
    assert.ok(fs.existsSync(p), `缺少路由模块：src/routes/${f}`);
    const code = fs.readFileSync(p, 'utf8');
    assert.ok(/module\.exports = function register\(app, ctx\)/.test(code),
      `src/routes/${f} 应导出 register(app, ctx)`);
    assert.ok(/require\('\.\.\/domain\//.test(code) === false,
      `src/routes/${f} 不应自行 require 领域模块（统一由 ctx 注入，避免多入口）`);
  }
});

test('共享依赖经 app-context.js 统一注入', () => {
  const code = fs.readFileSync(path.join(SRC_DIR, 'app-context.js'), 'utf8');
  for (const dep of ['withdraw', 'catalog', 'commission', 'transfer', 'orderIndex', 'upload']) {
    assert.ok(code.includes(`require('./domain/${dep}')`), `app-context.js 应装配领域模块 ${dep}`);
  }
  assert.ok(/function attachUser\(/.test(code) && /function requireUser\(/.test(code),
    'app-context.js 应集中定义会话中间件（杜绝"鉴权后挂"被绕过）');
});
