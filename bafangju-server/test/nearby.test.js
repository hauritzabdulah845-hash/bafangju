'use strict';
/**
 * 附近商家（异业联盟 · 本地生活）测试：
 * 距离计算 / 半径与关键词过滤 / 未选点与停用商家不入列表 / 详情券领取状态 / 坐标贯通入驻审核。
 */
const test = require('node:test');
const assert = require('node:assert');
const { createStore } = require('../src/store');
const merchant = require('../src/domain/merchant');
const nearby = require('../src/domain/nearby');

const GZ = { lat: 23.1291, lng: 113.3644 }; // 广州天河（演示中心）

function seedStore() {
  const db = createStore();
  const mk = (name, lat, lng, category) => merchant.adminCreateMerchant(db, {
    name, lat, lng, category, address: `${name}门店`, password: 'pass123456', operator: 'test',
  }).merchant;
  return { db, mk };
}

test('距离计算：球面距离与文案格式（<1km 用米，≥1km 用 km）', () => {
  const a = { lat: GZ.lat, lng: GZ.lng };
  const same = nearby.distanceM(a, a);
  assert.strictEqual(same, 0);
  // 天河区 → 珠江新城约 1.5km 量级
  const d = nearby.distanceM(a, { lat: 23.1355, lng: 113.3502 });
  assert.ok(d > 1400 && d < 1800, `距离应在 1.4~1.8km，实际 ${d}`);
  assert.strictEqual(nearby.distanceText(850), '850m');
  assert.strictEqual(nearby.distanceText(1285), '1.3km');
  assert.strictEqual(nearby.distanceText(0), '0m');
});

test('附近列表：按距离升序，半径与关键词过滤生效', () => {
  const { db, mk } = seedStore();
  mk('近店', 23.13, 113.365, '餐饮美食');   // 约 110m
  mk('中店', 23.14, 113.37, '生鲜果蔬');    // 约 2km
  mk('远店', 23.25, 113.45, '休闲玩乐');    // 约 18km，超出 5km 半径
  const r = nearby.nearbyMerchants(db, { ...GZ, radiusM: 5000 });
  assert.strictEqual(r.total, 2);
  assert.strictEqual(r.merchants[0].name, '近店');
  assert.strictEqual(r.merchants[1].name, '中店');
  assert.ok(r.merchants[0].distanceM < r.merchants[1].distanceM);

  const kw = nearby.nearbyMerchants(db, { ...GZ, radiusM: 20000, keyword: '生鲜' });
  assert.strictEqual(kw.total, 1);
  assert.strictEqual(kw.merchants[0].name, '中店');

  const cat = nearby.nearbyMerchants(db, { ...GZ, radiusM: 5000, category: '餐饮美食' });
  assert.strictEqual(cat.total, 1);
});

test('附近列表：未选点 / 停用商家不进列表；无坐标时回落默认中心', () => {
  const { db, mk } = seedStore();
  const noLoc = mk('无坐标店', null, null, '餐饮美食');
  const off = mk('停用店', 23.13, 113.365, '餐饮');
  merchant.adminSetMerchantStatus(db, { merchantId: off.id, status: 'disabled' });
  mk('正常店', 23.13, 113.365, '餐饮美食');
  const r = nearby.nearbyMerchants(db, { ...GZ, radiusM: 5000 });
  assert.ok(!r.merchants.some((m) => m.id === noLoc.id), '未选点商家不应出现');
  assert.ok(!r.merchants.some((m) => m.id === off.id), '停用商家不应出现');
  assert.strictEqual(r.merchants.length, 1);
  // 不传坐标：回落默认中心，仍能返回列表（前端未定位时不白屏）
  const d = nearby.nearbyMerchants(db, { radiusM: 5000 });
  assert.strictEqual(d.center.lat, nearby.DEFAULT_CENTER.lat);
});

test('商家详情：券聚合 + 已领取状态 + 在售商品；不存在/停用返回 null', () => {
  const { db, mk } = seedStore();
  const m = mk('鲜果时光', 23.12, 113.372, '生鲜果蔬');
  merchant.issueCoupon(db, { merchantId: m.id, title: '满20减3', amountOffFen: 300, minSpendFen: 2000, code: 'NB2001' });
  db.products.insert({ id: 'p_fruit', merchantId: m.id, categoryId: 'cat_x', name: '应季水果礼盒', priceFen: 4900, costFen: 2600, status: 'on_sale' });
  db.products.insert({ id: 'p_off', merchantId: m.id, categoryId: 'cat_x', name: '下架商品', priceFen: 100, costFen: 50, status: 'off_sale' });

  const d = nearby.merchantDetail(db, { merchantId: m.id, ...GZ });
  assert.strictEqual(d.merchant.name, '鲜果时光');
  assert.ok(d.merchant.distanceM > 1000 && d.merchant.distanceText.endsWith('km'));
  assert.strictEqual(d.coupons.length, 1);
  assert.strictEqual(d.coupons[0].valueText, '¥3.00');
  assert.strictEqual(d.coupons[0].claimable, true);
  assert.strictEqual(d.products.length, 1, '下架商品不应出现');
  assert.strictEqual(d.products[0].name, '应季水果礼盒');
  assert.strictEqual(d.merchant.phone, '', '无联系方式时不展示电话');

  assert.strictEqual(nearby.merchantDetail(db, { merchantId: 'not-exist', ...GZ }), null);
  const off = mk('停用店', 23.13, 113.365, '餐饮');
  merchant.adminSetMerchantStatus(db, { merchantId: off.id, status: 'disabled' });
  assert.strictEqual(nearby.merchantDetail(db, { merchantId: off.id, ...GZ }), null);
});

test('已领取的券在详情里标记不可再领（每人限领 1 张）', () => {
  const { db, mk } = seedStore();
  const m = mk('悦剪美发', 23.1355, 113.3502, '丽人美发');
  const c = merchant.issueCoupon(db, { merchantId: m.id, title: '满100减20', amountOffFen: 2000, minSpendFen: 10000, code: 'NB3001' });
  db.couponClaims.insert({ couponId: c.id, merchantId: m.id, userId: 'u1', code: 'ABCD1234', status: 'unused', claimedAt: new Date().toISOString() });
  const d = nearby.merchantDetail(db, { merchantId: m.id, userId: 'u1', ...GZ });
  assert.strictEqual(d.coupons[0].claimedByMe, 1);
  assert.strictEqual(d.coupons[0].claimable, false);
  const d2 = nearby.merchantDetail(db, { merchantId: m.id, userId: 'u2', ...GZ });
  assert.strictEqual(d2.coupons[0].claimable, true, '未领过的用户仍可领');
});

test('入驻申请坐标贯通：申请 → 审核通过 → 商家带坐标并出现在附近列表', () => {
  const db = createStore();
  const app = merchant.submitEntryApplication(db, {
    name: '地图选点门店', contact: '张三', phone: '13800001234', category: '餐饮美食',
    address: '天河区测试路1号', licenseImgUrl: '/uploads/x.jpg', lat: 23.1301, lng: 113.3654,
  });
  assert.strictEqual(app.lat, 23.1301);
  assert.strictEqual(app.lng, 113.3654);
  const r = merchant.reviewEntryApplication(db, { applicationId: app.id, approved: true, operator: 'admin' });
  const m = db.merchants.get(r.merchant.id);
  assert.strictEqual(m.lat, 23.1301, '建档应透传坐标');
  assert.strictEqual(m.lng, 113.3654);
  assert.strictEqual(m.category, '餐饮美食');
  const list = nearby.nearbyMerchants(db, { ...GZ, radiusM: 3000 });
  assert.ok(list.merchants.some((x) => x.id === m.id), '审核通过后应出现在附近列表');

  // 未选点申请也允许提交（服务类门店），但记为 null
  const app2 = merchant.submitEntryApplication(db, {
    name: '无门店服务', contact: '李四', phone: '13800005678', category: '家政服务',
    address: '上门服务', licenseImgUrl: '/uploads/y.jpg',
  });
  assert.strictEqual(app2.lat, null);
  assert.strictEqual(app2.lng, null);
});
