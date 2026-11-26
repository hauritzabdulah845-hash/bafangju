'use strict';
/**
 * 门店主页端到端（HTTP 层）：商家自助维护门头照 / 营业时间 / 电话 / 地址 / 简介
 * → 用户端「附近商家」「商家详情」立即可见。
 *
 * 定位（V4.5）：平台做本地商家线上展示与到店导流，门店信息由商家自己维护，
 * 且平台不参与线上收款，因此这里只验证"展示信息是否真实、可改、可见"。
 */
const test = require('node:test');
const assert = require('node:assert');

process.env.BAFANGJU_DB_DRIVER = 'memory';
process.env.ADMIN_PASSWORD = 'SmokeTest2026x';
process.env.NODE_ENV = 'development';

const { app, db } = require('../src/server');

let server;
let base;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
});

test.after(() => { if (server) server.close(); });

async function call(method, path, body, token) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

test('门店主页：商家自己填门头照/营业时间/简介 → 用户端详情与附近列表可见', async () => {
  const login = await call('POST', '/api/merchant/login', { username: '张记粮油店', password: 'demo123456' });
  assert.strictEqual(login.status, 200, JSON.stringify(login.data));
  const mToken = login.data.token;

  // 给种子商家一个可用坐标，才能进「附近商家」
  const shop = await call('POST', '/api/merchant/shop', {
    coverUrl: '/uploads/storefront_demo.jpg',
    intro: '本地 15 年老店，现磨粮油，可到店自提',
    businessHours: '09:00-21:00',
    phone: '13800138000',
    address: '北京市东城区示例路 88 号',
    lat: 39.9042,
    lng: 116.4074,
  }, mToken);
  assert.strictEqual(shop.status, 200, JSON.stringify(shop.data));
  assert.strictEqual(shop.data.shop.businessHours, '09:00-21:00');

  // 商家端回读
  const profile = await call('GET', '/api/merchant/profile', null, mToken);
  assert.strictEqual(profile.status, 200);
  assert.strictEqual(profile.data.coverUrl, '/uploads/storefront_demo.jpg');
  assert.strictEqual(profile.data.intro, '本地 15 年老店，现磨粮油，可到店自提');
  assert.strictEqual(profile.data.phone, '13800138000');

  // 用户端「商家详情」（公开接口）：门头照、营业时间、简介齐全
  const detail = await call('GET', '/api/merchants/' + profile.data.id + '?lat=39.9042&lng=116.4074');
  assert.strictEqual(detail.status, 200, JSON.stringify(detail.data));
  assert.strictEqual(detail.data.merchant.coverUrl, '/uploads/storefront_demo.jpg');
  assert.strictEqual(detail.data.merchant.businessHours, '09:00-21:00');
  assert.strictEqual(detail.data.merchant.intro, '本地 15 年老店，现磨粮油，可到店自提');
  assert.strictEqual(detail.data.merchant.phone, '13800138000');
  assert.ok(detail.data.merchant.distanceM === 0, '同一坐标距离应为 0');

  // 用户端「附近商家」：列表卡片能拿到门头照
  const nearby = await call('GET', '/api/merchants/nearby?lat=39.9042&lng=116.4074&radius=5000');
  assert.strictEqual(nearby.status, 200);
  const hit = (nearby.data.merchants || []).find((m) => m.id === profile.data.id);
  assert.ok(hit, '附近列表应包含该店');
  assert.strictEqual(hit.coverUrl, '/uploads/storefront_demo.jpg');
});

test('门店主页校验：外链门头照 / 非法营业时间 / 缺坐标都要拒绝', async () => {
  const login = await call('POST', '/api/merchant/login', { username: '张记粮油店', password: 'demo123456' });
  const mToken = login.data.token;

  const ext = await call('POST', '/api/merchant/shop', { coverUrl: 'https://evil.example.com/a.jpg' }, mToken);
  assert.strictEqual(ext.status, 400);
  assert.match(ext.data.error, /门头照/);

  const badHours = await call('POST', '/api/merchant/shop', { businessHours: '9点-21点' }, mToken);
  assert.strictEqual(badHours.status, 400);
  assert.match(badHours.data.error, /营业时间/);

  const badCoord = await call('POST', '/api/merchant/shop', { lat: 999, lng: 116.4 }, mToken);
  assert.strictEqual(badCoord.status, 400);
  assert.match(badCoord.data.error, /坐标/);

  // 未登录不得修改
  const anon = await call('POST', '/api/merchant/shop', { intro: 'x' });
  assert.ok(anon.status === 401 || anon.status === 403, '未登录应被拒绝，实际 ' + anon.status);
});
