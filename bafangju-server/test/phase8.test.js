'use strict';
/**
 * 第八期测试：商家入驻资质表单（提交校验 → 审核通过自动建档发 token / 驳回留痕）+ 证照上传校验基础。
 */
const test = require('node:test');
const assert = require('node:assert');
const merchant = require('../src/domain/merchant');
const { createStore } = require('../src/store');

const VALID = {
  name: '张记早餐店', contact: '张老板', phone: '13800001111',
  category: '餐饮美食', address: '幸福路 12 号', licenseImgUrl: '/uploads/lic1.jpg',
};

test('入驻申请：必填校验（名称/联系人/手机号/类目/地址/执照）与重名拦截', () => {
  const db = createStore({});
  assert.throws(() => merchant.submitEntryApplication(db, { ...VALID, name: '张' }), /至少 2 字/);
  assert.throws(() => merchant.submitEntryApplication(db, { ...VALID, contact: '' }), /联系人必填/);
  assert.throws(() => merchant.submitEntryApplication(db, { ...VALID, phone: '12345' }), /手机号格式/);
  assert.throws(() => merchant.submitEntryApplication(db, { ...VALID, category: '' }), /类目必填/);
  assert.throws(() => merchant.submitEntryApplication(db, { ...VALID, address: '' }), /地址必填/);
  assert.throws(() => merchant.submitEntryApplication(db, { ...VALID, licenseImgUrl: '' }), /营业执照照片必传/);

  const app = merchant.submitEntryApplication(db, VALID);
  assert.strictEqual(app.status, 'pending_review');
  // 同名：已入驻拦截 / 待审中拦截
  assert.throws(() => merchant.submitEntryApplication(db, VALID), /审核中的申请/);
  merchant.reviewEntryApplication(db, { applicationId: app.id, approved: true, operator: 'admin1' });
  assert.throws(() => merchant.submitEntryApplication(db, VALID), /已入驻/);
});

test('入驻审核：通过自动建档发 token（仅一次）；驳回必须给原因；已处理不可重复', () => {
  const db = createStore({});
  const app = merchant.submitEntryApplication(db, VALID);
  // 驳回必须给原因
  assert.throws(() => merchant.reviewEntryApplication(db, { applicationId: app.id, approved: false, reason: '' }), /驳回必须填写原因/);
  const rj = merchant.reviewEntryApplication(db, { applicationId: app.id, approved: false, reason: '执照模糊', operator: 'admin1' });
  assert.strictEqual(rj.application.status, 'rejected');
  assert.strictEqual(rj.application.reviewReason, '执照模糊');
  assert.strictEqual(rj.merchant, null);
  assert.throws(() => merchant.reviewEntryApplication(db, { applicationId: app.id, approved: true }), /已处理/);

  // 重新提交后通过 → 自动建档
  const app2 = merchant.submitEntryApplication(db, VALID);
  const ok = merchant.reviewEntryApplication(db, { applicationId: app2.id, approved: true, operator: 'admin2' });
  assert.strictEqual(ok.application.status, 'approved');
  assert.ok(ok.merchant && ok.merchant.id);
  assert.ok(ok.merchant.token && ok.merchant.token.length >= 32);
  assert.ok(ok.initialPassword && ok.initialPassword.length >= 6);
  // 建档商家可凭"账号 + 初始密码"登录
  const login = merchant.merchantLogin(db, { username: ok.merchant.username, password: ok.initialPassword });
  assert.ok(login.merchant.token);
  assert.ok(db.auditLogs.items.some((a) => a.action === 'merchant.entry_approved'));
  assert.ok(db.auditLogs.items.some((a) => a.action === 'merchant.entry_rejected'));
});

test('入驻列表：按状态筛选', () => {
  const db = createStore({});
  merchant.submitEntryApplication(db, VALID);
  merchant.submitEntryApplication(db, { ...VALID, name: '李记面馆', phone: '13800002222' });
  assert.strictEqual(merchant.listEntryApplications(db, 'pending_review').length, 2);
  assert.strictEqual(merchant.listEntryApplications(db, 'approved').length, 0);
});

// ---------- 本地生活标准类目播种 ----------
const catalog = require('../src/domain/catalog');
const { seedDefaultCategories, DEFAULT_CATEGORIES } = catalog;

test('类目播种：幂等补齐标准类目并带图标，不覆盖运营已配置的 r', () => {
  const db = createStore({});
  // 运营已建"餐饮美食"但自定义了 r 且无图标
  const custom = catalog.createCategory(db, { name: '餐饮美食', r: 0.3, operator: 'boss' });
  const added = seedDefaultCategories(db);
  assert.ok(added.includes('甜点饮品') && added.includes('家政服务'));
  assert.ok(!added.includes('餐饮美食'), '已存在的类目不重复播种');
  // 已有类目仅补图标，r 不被覆盖
  const c = db.categories.get(custom.id);
  assert.strictEqual(c.r, 0.3);
  assert.strictEqual(c.icon, '🍜');
  // 全部标准类目就位且带图标
  for (const def of DEFAULT_CATEGORIES) {
    const row = db.categories.where((x) => x.name === def.name)[0];
    assert.ok(row, def.name + ' 应存在');
    assert.ok(row.icon, def.name + ' 应有图标');
  }
  // 二次播种零新增
  assert.deepStrictEqual(seedDefaultCategories(db), []);
});
