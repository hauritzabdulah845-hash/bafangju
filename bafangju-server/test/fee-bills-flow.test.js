'use strict';
/**
 * 券闭环端到端（HTTP 层）：商家发券 → 用户领券 → 核销（优惠/应付）→ 服务费挂账 → 后台确认收款。
 * 重点验证 V4.4 口径：核销挂账不划储备、收款后入账、金额口径为券前消费总额。
 */
const test = require('node:test');
const assert = require('node:assert');

process.env.BAFANGJU_DB_DRIVER = 'memory';
process.env.ADMIN_PASSWORD = 'SmokeTest2026x';
process.env.NODE_ENV = 'development';

const { app, db } = require('../src/server');
const coupon = require('../src/domain/coupon');

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

test('联盟券：发券→领券→查券→核销（优惠/应付）→服务费挂账→后台收款', async () => {
  // 本用例验证「收费模式」的完整账单链路，故显式打开发费率（生产默认 0 = 免费导流）
  db.switches.set('couponServiceFeeRate', 0.03);
  db.switches.set('verificationServiceFeeRate', 0.05);

  // 1) 商家登录（种子商家：张记粮油店 / demo123456）
  const login = await call('POST', '/api/merchant/login', { username: '张记粮油店', password: 'demo123456' });
  assert.strictEqual(login.status, 200, JSON.stringify(login.data));
  const mToken = login.data.token;
  assert.ok(mToken, '商家登录应返回 token');

  // 2) 商家发券：满30减5
  const created = await call('POST', '/api/merchant/coupons/create', {
    title: '满30减5', type: 'cash', amountOffFen: 500, minSpendFen: 3000, perUserLimit: 1,
  }, mToken);
  assert.strictEqual(created.status, 200, JSON.stringify(created.data));
  const couponId = created.data.coupon.id;

  // 3) 用户领券（域层造领券记录，避免依赖微信登录）
  db.users.insert({ id: 'u_e2e', nickname: '测试用户' });
  const claim = coupon.claimCoupon(db, { couponId, userId: 'u_e2e' });

  // 4) 查券：可用、券面正确
  const look = await call('GET', '/api/merchant/coupons/lookup?code=' + claim.code, null, mToken);
  assert.strictEqual(look.status, 200, JSON.stringify(look.data));
  assert.strictEqual(look.data.usable, true);
  assert.strictEqual(look.data.coupon.amountOffFen, 500);

  // 5) 核销：券前总额 32 元 → 优惠 5 元、顾客应付 27 元、服务费 3% = 0.96 元
  const redeem = await call('POST', '/api/merchant/coupons/redeem', { code: claim.code, amountFen: 3200 }, mToken);
  assert.strictEqual(redeem.status, 200, JSON.stringify(redeem.data));
  assert.strictEqual(redeem.data.discountFen, 500);
  assert.strictEqual(redeem.data.payableFen, 2700);
  assert.strictEqual(redeem.data.grossFeeFen, 96);
  assert.ok(redeem.data.feeBillId, '核销应生成服务费应收单');

  // 6) 商家端账单：待缴 0.96 元
  const bills = await call('GET', '/api/merchant/fee-bills', null, mToken);
  assert.strictEqual(bills.status, 200);
  assert.strictEqual(bills.data.summary.dueCount, 1);
  assert.strictEqual(bills.data.summary.dueFen, 96);

  // 7) 后台：登录 → 看到待收 → 标记已收
  const adminLogin = await call('POST', '/api/admin/login', { username: 'admin', password: 'SmokeTest2026x' });
  assert.strictEqual(adminLogin.status, 200, JSON.stringify(adminLogin.data));
  const aToken = adminLogin.data.token;
  const adminBills = await call('GET', '/api/admin/merchant-fee-bills', null, aToken);
  assert.strictEqual(adminBills.status, 200);
  const due = adminBills.data.list.find((b) => b.id === redeem.data.feeBillId);
  assert.ok(due && due.status === 'due');

  const paid = await call('POST', '/api/admin/merchant-fee-bills/pay', { billId: due.id, method: 'offline' }, aToken);
  assert.strictEqual(paid.status, 200, JSON.stringify(paid.data));
  assert.strictEqual(paid.data.bill.status, 'paid');
  assert.strictEqual(paid.data.bill.receivedFen, 96);

  const after = await call('GET', '/api/admin/merchant-fee-bills', null, aToken);
  assert.strictEqual(after.data.summary.dueCount, 0);
  assert.strictEqual(after.data.summary.paidFen, 96);
});

test('默认免费模式：核销只留交易记录，不产生服务费与应收单', async () => {
  // 关闭费率 = 生产默认（平台线上不收任何费用）
  db.switches.set('couponServiceFeeRate', 0);
  db.switches.set('verificationServiceFeeRate', 0);

  const login = await call('POST', '/api/merchant/login', { username: '张记粮油店', password: 'demo123456' });
  const mToken = login.data.token;

  const created = await call('POST', '/api/merchant/coupons/create', {
    title: '满50减10', type: 'cash', amountOffFen: 1000, minSpendFen: 5000, perUserLimit: 5,
  }, mToken);
  assert.strictEqual(created.status, 200, JSON.stringify(created.data));

  db.users.insert({ id: 'u_free', nickname: '免费模式用户' });
  const claim = coupon.claimCoupon(db, { couponId: created.data.coupon.id, userId: 'u_free' });

  const redeem = await call('POST', '/api/merchant/coupons/redeem', { code: claim.code, amountFen: 6000 }, mToken);
  assert.strictEqual(redeem.status, 200, JSON.stringify(redeem.data));
  // 交易事实清楚：消费 60、优惠 10、顾客线下付 50
  assert.strictEqual(redeem.data.discountFen, 1000);
  assert.strictEqual(redeem.data.payableFen, 5000);
  // 平台不收费：零费用、无账单
  assert.strictEqual(redeem.data.grossFeeFen, 0);
  assert.strictEqual(redeem.data.feeCharged, false);
  assert.strictEqual(redeem.data.feeBillId, null);

  const bills = await call('GET', '/api/merchant/fee-bills', null, mToken);
  assert.strictEqual(bills.status, 200);
  assert.strictEqual(bills.data.feeEnabled, false, '免费模式应告知商家平台不收费');
  assert.strictEqual(bills.data.summary.dueCount, 0);
});
