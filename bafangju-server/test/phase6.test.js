'use strict';
/**
 * 第六期测试：管理后台鉴权（scrypt 口令、登录会话、登出吊销、改密失效、防时序）。
 */
const test = require('node:test');
const assert = require('node:assert');
const adminAuth = require('../src/domain/adminAuth');
const { createStore } = require('../src/store');

test('scrypt 摘要：可验证正确口令、拒绝错误口令；同口令两次摘要不同（随机盐）', () => {
  const h1 = adminAuth.hashPassword('secret123');
  const h2 = adminAuth.hashPassword('secret123');
  assert.notStrictEqual(h1, h2);
  assert.ok(adminAuth.verifyPassword('secret123', h1));
  assert.strictEqual(adminAuth.verifyPassword('wrong', h1), false);
  assert.strictEqual(adminAuth.verifyPassword('secret123', 'badformat'), false);
});

test('ensureAdminAccount：env 优先；未配置走开发默认并标记；幂等不重复建档', () => {
  const db = createStore({});
  let r = adminAuth.ensureAdminAccount(db, { ADMIN_USER: 'boss', ADMIN_PASSWORD: 'strongPass888' });
  assert.strictEqual(r.created, true);
  assert.strictEqual(r.devDefault, false);
  assert.strictEqual(db.adminAccounts.all().length, 1);

  // 幂等
  r = adminAuth.ensureAdminAccount(db, {});
  assert.strictEqual(r.created, false);

  // 未配置环境变量的新库 → 开发默认账号
  const db2 = createStore({});
  r = adminAuth.ensureAdminAccount(db2, {});
  assert.strictEqual(r.created, true);
  assert.strictEqual(r.devDefault, true);
  assert.strictEqual(r.username, 'admin');
});

test('登录/登出/改密闭环：错误口令拒绝、token 会话、登出吊销、改密后旧会话全失效', () => {
  const db = createStore({});
  adminAuth.ensureAdminAccount(db, { ADMIN_USER: 'boss', ADMIN_PASSWORD: 'start12345' });

  // 错误口令
  assert.throws(() => adminAuth.login(db, { username: 'boss', password: 'wrong' }), /账号或密码错误/);
  assert.throws(() => adminAuth.login(db, { username: 'nobody', password: 'x' }), /账号或密码错误/);

  // 正确登录 → token 可鉴权
  const { token } = adminAuth.login(db, { username: 'boss', password: 'start12345' });
  assert.ok(adminAuth.sessionByToken(db, token));

  // 改密（校验旧口令）→ 旧会话吊销、新口令可登录、旧口令失效
  // 显式传非生产 env，避免受运行测试时的 NODE_ENV 影响
  const devEnv = { NODE_ENV: 'test' };
  assert.throws(() => adminAuth.changePassword(db, { username: 'boss', oldPassword: 'bad', newPassword: 'newPass8888' }, devEnv), /原密码错误/);
  assert.throws(() => adminAuth.changePassword(db, { username: 'boss', oldPassword: 'start12345', newPassword: 'short' }, devEnv), /至少 8 位/);
  adminAuth.changePassword(db, { username: 'boss', oldPassword: 'start12345', newPassword: 'newPass8888' }, devEnv);
  assert.strictEqual(adminAuth.sessionByToken(db, token), null);
  assert.throws(() => adminAuth.login(db, { username: 'boss', password: 'start12345' }), /账号或密码错误/);
  const again = adminAuth.login(db, { username: 'boss', password: 'newPass8888' });
  assert.ok(again.token);
  assert.strictEqual(again.devDefault, false);

  // 登出
  adminAuth.logout(db, again.token);
  assert.strictEqual(adminAuth.sessionByToken(db, again.token), null);
});

test('审计留痕：登录失败/成功/改密均有记录', () => {
  const db = createStore({});
  adminAuth.ensureAdminAccount(db, { ADMIN_USER: 'boss', ADMIN_PASSWORD: 'pass12345' });
  try { adminAuth.login(db, { username: 'boss', password: 'nope' }); } catch (e) { /* 预期 */ }
  const { token } = adminAuth.login(db, { username: 'boss', password: 'pass12345' });
  // 显式传非生产 env：生产策略要求 ≥12 位且含大小写与数字，此处口令仅 10 位
  adminAuth.changePassword(db, { username: 'boss', oldPassword: 'pass12345', newPassword: 'changed9999' }, { NODE_ENV: 'test' });
  const actions = db.auditLogs.items.map((a) => a.action);
  assert.ok(actions.includes('admin.login_failed'));
  assert.ok(actions.includes('admin.login'));
  assert.ok(actions.includes('admin.password_changed'));
  assert.ok(actions.includes('admin.account_init'));
});

// ---------- 商品/类目管理 ----------
const catalog = require('../src/domain/catalog');

test('类目管理：创建校验 r 范围、n 自动推导、改 r 审计', () => {
  const db = createStore({});
  const c = catalog.createCategory(db, { name: '百货', r: 0.1, operator: 'op1' });
  assert.strictEqual(c.n, 11); // ⌈1/0.1⌉+1
  assert.throws(() => catalog.createCategory(db, { name: '错r', r: 1 }), /0 到 1/);
  assert.throws(() => catalog.createCategory(db, { name: '百货', r: 0.2 }), /已存在/);

  const c2 = catalog.updateCategory(db, { categoryId: c.id, r: 0.25, operator: 'op2' });
  assert.strictEqual(c2.n, 5);
  const logs = db.auditLogs.items.filter((a) => a.action.startsWith('catalog.'));
  assert.ok(logs.some((a) => a.action === 'catalog.category_r_change' && a.actor === 'op2'));
});

test('商品管理：上架校验价格、改价审计不追溯、上下架', () => {
  const db = createStore({});
  const c = catalog.createCategory(db, { name: '百货', r: 0.2 });
  assert.throws(() => catalog.createProduct(db, { categoryId: c.id, name: 'X', priceFen: 1000, costFen: 1200 }), /低于标价/);
  assert.throws(() => catalog.createProduct(db, { categoryId: 'no', name: 'X', priceFen: 1000, costFen: 100 }), /类目不存在/);

  const p = catalog.createProduct(db, { categoryId: c.id, name: '保温杯', priceFen: 3000, costFen: 900, operator: 'op1' });
  assert.strictEqual(p.status, 'on_sale');

  // 改价：变更明细留痕
  const p2 = catalog.updateProduct(db, { id: p.id, priceFen: 2800, costFen: 850, operator: 'op2' });
  assert.strictEqual(p2.priceFen, 2800);
  assert.strictEqual(p2.costFen, 850);
  const log = db.auditLogs.items.filter((a) => a.action === 'catalog.product_update').pop();
  const detail = JSON.parse(log.detail);
  assert.strictEqual(detail.changes.priceFen.from, 3000);
  assert.strictEqual(detail.changes.priceFen.to, 2800);

  // 上下架
  catalog.updateProduct(db, { id: p.id, status: 'off_sale' });
  assert.strictEqual(db.products.get(p.id).status, 'off_sale');

  // 列表带类目信息
  const list = catalog.adminListProducts(db);
  assert.strictEqual(list[0].categoryName, '百货');
  assert.strictEqual(list[0].n, 6);
});
