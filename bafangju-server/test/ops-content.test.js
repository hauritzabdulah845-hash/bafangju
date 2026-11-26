'use strict';
/**
 * 首页运营位（opsSlides）与类目图标（iconImage）后台可配 —— 单元测试
 * 覆盖：字段校验、外链拒绝、启用过滤、排序上下移、删除、播种幂等、类目展示字段更新。
 */
const test = require('node:test');
const assert = require('node:assert');
const { createStore } = require('../src/store');
const ops = require('../src/domain/ops');
const catalog = require('../src/domain/catalog');
const content = require('../src/domain/content');

const base = { title: '测试活动', sub: '副标题', btn: '去看看', action: 'returns', tone: 2, emoji: '🎁' };

test('运营帧：创建后按 sort 升序下发，停用帧不下发', () => {
  const db = createStore();
  const a = ops.createOpsSlide(db, { ...base, operator: 'admin' });
  const b = ops.createOpsSlide(db, { ...base, title: '第二条', operator: 'admin' });
  const c = ops.createOpsSlide(db, { ...base, title: '停用帧', enabled: false, operator: 'admin' });
  assert.ok(a.sort < b.sort && b.sort < c.sort, 'sort 应递增');
  const pub = ops.listOpsSlides(db);
  assert.strictEqual(pub.length, 2, '前台只返回启用帧');
  assert.ok(!pub.some((s) => s.id === c.id));
  assert.strictEqual(ops.adminListOpsSlides(db).length, 3, '后台返回全部（含停用）');
});

test('运营帧：跳转目标走白名单，图片拒绝外链', () => {
  const db = createStore();
  assert.throws(() => ops.createOpsSlide(db, { ...base, action: 'http://evil.com' }), /跳转目标/);
  assert.throws(() => ops.createOpsSlide(db, { ...base, imageUrl: 'https://x.com/a.png' }), /站内/);
  assert.throws(() => ops.createOpsSlide(db, { ...base, title: '' }), /标题必填/);
  assert.throws(() => ops.createOpsSlide(db, { ...base, tone: 9 }), /配色档位/);
  const ok = ops.createOpsSlide(db, { ...base, imageUrl: '/uploads/abc.png' });
  assert.strictEqual(ok.imageUrl, '/uploads/abc.png', '站内路径应保留');
});

test('运营帧：首页文案拦截返利/提现类违规词', () => {
  const db = createStore();
  assert.throws(() => ops.createOpsSlide(db, { ...base, sub: '好友下单你得返利' }), /违规词「返利」/);
  assert.throws(() => ops.createOpsSlide(db, { ...base, title: '看广告随时提现' }), /违规词「提现」/);
  const s = ops.createOpsSlide(db, { ...base, title: '一起省钱' });
  // 更新路径同样拦截，避免绕过创建校验改回去
  assert.throws(() => ops.updateOpsSlide(db, { id: s.id, sub: '躺赚零花钱' }), /违规词「躺赚」/);
  // 只改开关等非文案字段不受影响
  assert.strictEqual(ops.updateOpsSlide(db, { id: s.id, enabled: false }).enabled, false);
});

test('运营帧：上移/下移交换 sort，边界不越界', () => {
  const db = createStore();
  const a = ops.createOpsSlide(db, { ...base, title: 'A' });
  const b = ops.createOpsSlide(db, { ...base, title: 'B' });
  ops.moveOpsSlide(db, { id: b.id, dir: 'up' });
  const list = ops.adminListOpsSlides(db);
  assert.strictEqual(list[0].title, 'B', 'B 上移后应排第一');
  assert.strictEqual(list[1].title, 'A');
  ops.moveOpsSlide(db, { id: list[0].id, dir: 'up' }); // 已在首位
  assert.strictEqual(ops.adminListOpsSlides(db)[0].title, 'B', '边界不动');
});

test('运营帧：修改与删除，审计留痕', () => {
  const db = createStore();
  const s = ops.createOpsSlide(db, { ...base });
  const upd = ops.updateOpsSlide(db, { id: s.id, title: '换个标题', enabled: false, operator: 'admin' });
  assert.strictEqual(upd.title, '换个标题');
  assert.strictEqual(ops.listOpsSlides(db).length, 0, '停用后前台不可见');
  assert.throws(() => ops.updateOpsSlide(db, { id: s.id, action: 'nope' }), /跳转目标/);
  assert.ok(db.auditLogs.items.some((x) => x.action === 'ops.slide_update'));
  ops.deleteOpsSlide(db, { id: s.id, operator: 'admin' });
  assert.strictEqual(db.opsSlides.all().length, 0);
  assert.ok(db.auditLogs.items.some((x) => x.action === 'ops.slide_delete'));
});

test('运营帧：默认三帧播种且幂等（已有配置不覆盖运营改动）', () => {
  const db = createStore();
  assert.strictEqual(ops.seedDefaultOpsSlides(db).length, 3);
  ops.updateOpsSlide(db, { id: db.opsSlides.all()[0].id, title: '运营改过的标题' });
  assert.strictEqual(ops.seedDefaultOpsSlides(db).length, 0, '已有数据时不重复播种');
  assert.strictEqual(ops.adminListOpsSlides(db)[0].title, '运营改过的标题', '运营改动不被覆盖');
});

test('文案：key 白名单 + 长度上限 + 留空回落内置', () => {
  const db = createStore();
  assert.throws(() => content.setContent(db, { key: 'evil.key', body: 'x' }), /不在可配置清单/);
  const short = content.CONTENT_DEFS.find((d) => d.key === 'rules.header');
  assert.throws(
    () => content.setContent(db, { key: 'rules.header', body: 'x'.repeat(short.maxLen + 1) }),
    /不超过/,
  );
  content.setContent(db, { key: 'rules.header', body: '版本 V4.0 · 阶梯机制', operator: 'admin' });
  const pub = content.listContent(db);
  assert.strictEqual(pub.items['rules.header'], '版本 V4.0 · 阶梯机制');
  assert.strictEqual(Object.keys(pub.items).length, 1, '未配置的 key 不下发（由小程序内置兜底）');
  content.setContent(db, { key: 'rules.header', body: '' });
  assert.strictEqual(Object.keys(content.listContent(db).items).length, 0, '清空 = 回落内置文案');
});

test('文案：恢复内置 + 审计留痕 + 清单分组', () => {
  const db = createStore();
  content.setContent(db, { key: 'tasks.note', body: '贡献值不兑现、不提现', operator: 'admin' });
  assert.ok(content.adminListContent(db).defs.find((d) => d.key === 'tasks.note').custom);
  content.resetContent(db, { key: 'tasks.note', operator: 'admin' });
  assert.strictEqual(content.adminListContent(db).defs.find((d) => d.key === 'tasks.note').custom, false);
  assert.ok(db.auditLogs.items.some((x) => x.action === 'content.update'));
  assert.ok(db.auditLogs.items.some((x) => x.action === 'content.reset'));
  assert.ok(content.adminListContent(db).defs.length >= 12, '文案清单覆盖规则/协议/合规声明');
});

test('类目：可只改图标不动 r，图标路径拒绝外链', () => {
  const db = createStore();
  catalog.seedDefaultCategories(db);
  const c = db.categories.all()[0];
  const before = c.r;
  const r = catalog.updateCategory(db, { categoryId: c.id, iconImage: '/uploads/icon_x.png', icon: '🍔', operator: 'admin' });
  assert.strictEqual(r.r, before, '只改图标时 r 不变');
  assert.strictEqual(c.iconImage, '/uploads/icon_x.png');
  assert.strictEqual(c.icon, '🍔');
  assert.throws(() => catalog.updateCategory(db, { categoryId: c.id, iconImage: 'http://x.com/a.png' }), /站内/);
  assert.throws(() => catalog.updateCategory(db, { categoryId: c.id, r: 1.5 }), /0 到 1/);
  assert.throws(() => catalog.updateCategory(db, { categoryId: c.id }), /没有需要更新/);
  assert.ok(db.auditLogs.items.some((x) => x.action === 'catalog.category_display_change'));
});
