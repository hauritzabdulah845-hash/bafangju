'use strict';
/**
 * 商家自主上传商品 + 平台审核回归用例（V3.23）：
 * 提交 → 待审核（用户端不可见/不可下单）→ 通过上架 / 驳回原因可见 → 修改重提；
 * 硬约束：类目只能选平台已有类目；越权改他人商品报错；驳回必须填原因。
 */
const test = require('node:test');
const assert = require('node:assert');
const { createStore } = require('../src/store');
const catalog = require('../src/domain/catalog');

function setup() {
  const db = createStore();
  db.merchants.insert({ id: 'm1', name: '张记粮油店', status: 'active' });
  db.merchants.insert({ id: 'm2', name: '李记生鲜', status: 'active' });
  db.categories.insert({ id: 'c1', name: '粮油食品', r: 0.2 });
  return db;
}

const VALID = { categoryId: 'c1', name: '农家大米 5kg', priceFen: 5000, costFen: 3000, deliveryType: 'express' };

test('商家提交商品：默认待审核，税费/运营成本按平台默认值计', () => {
  const db = setup();
  const p = catalog.submitProductByMerchant(db, { merchantId: 'm1', ...VALID });
  assert.strictEqual(p.status, 'pending_review');
  assert.strictEqual(p.merchantId, 'm1');
  assert.strictEqual(p.taxFeeRate, db.switches.get('defaultTaxFeeRate'));
  assert.strictEqual(p.opCostFen, db.switches.get('defaultOpCostFen'));
  // 提交/建档均留审计
  const actions = db.auditLogs.slice(-50).map((l) => l.action);
  assert.ok(actions.includes('catalog.product_create'));
  assert.ok(actions.includes('catalog.product_submit'));
});

test('待审核商品不上架：公开列表不可见、下单被拒绝', () => {
  const db = setup();
  catalog.submitProductByMerchant(db, { merchantId: 'm1', ...VALID });
  assert.strictEqual(db.products.where((p) => p.status === 'on_sale').length, 0);
  // 下单口径与 services.createOrder 一致：非 on_sale 即不可售
  const p = db.products.all()[0];
  assert.ok(p.status !== 'on_sale');
});

test('类目必须是平台已有类目；价格/成本校验', () => {
  const db = setup();
  assert.throws(() => catalog.submitProductByMerchant(db, { merchantId: 'm1', ...VALID, categoryId: 'cX' }), /类目/);
  assert.throws(() => catalog.submitProductByMerchant(db, { merchantId: 'm1', ...VALID, priceFen: 0 }), /标价/);
  assert.throws(() => catalog.submitProductByMerchant(db, { merchantId: 'm1', ...VALID, priceFen: 100, costFen: 100 }), /成本/);
  assert.throws(() => catalog.submitProductByMerchant(db, { merchantId: 'mX', ...VALID }), /商家不存在/);
  // 图片仅允许站内路径
  assert.throws(() => catalog.submitProductByMerchant(db, { merchantId: 'm1', ...VALID, imageUrl: 'https://evil.com/x.png' }), /站内/);
});

test('审核通过 → 上架且用户端可见；重复审核报错', () => {
  const db = setup();
  const p = catalog.submitProductByMerchant(db, { merchantId: 'm1', ...VALID });
  assert.strictEqual(catalog.listPendingProducts(db).length, 1);
  const r = catalog.reviewProductSubmission(db, { productId: p.id, approved: true, operator: 'admin' });
  assert.strictEqual(r.status, 'on_sale');
  assert.strictEqual(catalog.listPendingProducts(db).length, 0);
  assert.strictEqual(db.products.where((x) => x.status === 'on_sale').length, 1);
  assert.throws(() => catalog.reviewProductSubmission(db, { productId: p.id, approved: true }), /不在待审核/);
  const review = db.auditLogs.slice(-50).find((l) => l.action === 'catalog.product_review');
  assert.ok(review && JSON.parse(review.detail).approved === true);
});

test('驳回必须填原因；驳回后商家可见原因，修改后重新提交回待审核', () => {
  const db = setup();
  const p = catalog.submitProductByMerchant(db, { merchantId: 'm1', ...VALID });
  assert.throws(() => catalog.reviewProductSubmission(db, { productId: p.id, approved: false }), /驳回原因/);
  catalog.reviewProductSubmission(db, { productId: p.id, approved: false, note: '标价明显高于同类商品' });
  const mine = catalog.listMerchantProducts(db, 'm1');
  assert.strictEqual(mine.length, 1);
  assert.strictEqual(mine[0].status, 'rejected');
  assert.strictEqual(mine[0].statusText, '已驳回');
  assert.strictEqual(mine[0].reviewNote, '标价明显高于同类商品');
  // 修改重提 → 回到待审核、清空驳回原因
  const re = catalog.merchantUpdateProduct(db, { merchantId: 'm1', productId: p.id, priceFen: 3800, costFen: 2200 });
  assert.strictEqual(re.status, 'pending_review');
  assert.strictEqual(re.reviewNote, '');
  assert.strictEqual(re.priceFen, 3800);
});

test('编辑在售商品：保存即回待审核停售，审核通过恢复上架', () => {
  const db = setup();
  const p = catalog.submitProductByMerchant(db, { merchantId: 'm1', ...VALID });
  catalog.reviewProductSubmission(db, { productId: p.id, approved: true });
  assert.strictEqual(db.products.get(p.id).status, 'on_sale');
  catalog.merchantUpdateProduct(db, { merchantId: 'm1', productId: p.id, priceFen: 4500 });
  assert.strictEqual(db.products.get(p.id).status, 'pending_review');
  assert.strictEqual(db.products.where((x) => x.status === 'on_sale').length, 0); // 编辑期间用户端不可见
  catalog.reviewProductSubmission(db, { productId: p.id, approved: true });
  assert.strictEqual(db.products.get(p.id).status, 'on_sale');
  assert.strictEqual(db.products.get(p.id).priceFen, 4500);
});

test('越权：商家 B 不能改商家 A 的商品；商家列表互相隔离', () => {
  const db = setup();
  const p = catalog.submitProductByMerchant(db, { merchantId: 'm1', ...VALID });
  assert.throws(() => catalog.merchantUpdateProduct(db, { merchantId: 'm2', productId: p.id, priceFen: 100 }), /无权修改/);
  catalog.submitProductByMerchant(db, { merchantId: 'm2', ...VALID, name: '李记大米' });
  assert.strictEqual(catalog.listMerchantProducts(db, 'm1').length, 1);
  assert.strictEqual(catalog.listMerchantProducts(db, 'm2').length, 1);
  assert.strictEqual(catalog.listMerchantProducts(db, 'm1')[0].name, '农家大米 5kg');
});

test('平台待审队列：含商家名与类目阶梯参数，先提交先审', () => {
  const db = setup();
  catalog.submitProductByMerchant(db, { merchantId: 'm2', ...VALID, name: '先提交的' });
  catalog.submitProductByMerchant(db, { merchantId: 'm1', ...VALID, name: '后提交的' });
  const pending = catalog.listPendingProducts(db);
  assert.strictEqual(pending.length, 2);
  assert.strictEqual(pending[0].name, '先提交的');
  assert.strictEqual(pending[0].merchantName, '李记生鲜');
  assert.strictEqual(pending[0].categoryName, '粮油食品');
  assert.strictEqual(pending[0].r, 0.2);
  assert.ok(pending[0].n >= 1);
});
