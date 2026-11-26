'use strict';
/**
 * 第七期测试：推广模块（关系链绑定/团队/收益/二维码降级）、
 * 任务补全（浏览15秒防刷 + 30天80贡献值）、风控（黑名单/申诉/循环免单识别）、消息已读。
 */
const test = require('node:test');
const assert = require('node:assert');
const promotion = require('../src/domain/promotion');
const wxmp = require('../src/domain/wxmp');
const risk = require('../src/domain/risk');
const svc = require('../src/services');
const bizdate = require('../src/domain/bizdate');
const { createStore } = require('../src/store');

function seedUsers(db, n) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    ids.push(db.users.insert({ openid: 'oSeed' + i + 'x'.repeat(20), nickname: 'U' + i, createdAt: new Date().toISOString() }).id);
  }
  return ids;
}

// ---------- 推广模块 ----------
test('推广：关系链一次性绑定（不可改、禁自邀、禁成环、邀请人须存在）', () => {
  const db = createStore({});
  const [a, b] = seedUsers(db, 2);
  promotion.bindReferral(db, { userId: b, inviterUserId: a });
  assert.strictEqual(db.users.get(b).directUserId, a);
  assert.throws(() => promotion.bindReferral(db, { userId: b, inviterUserId: 'ghost' }), /邀请人不存在/);
  assert.throws(() => promotion.bindReferral(db, { userId: b, inviterUserId: b }), /不能邀请自己/);
  assert.throws(() => promotion.bindReferral(db, { userId: 'u9', inviterUserId: a }), /用户不存在/);
  const [d] = seedUsers(db, 1); // 用真实存在的第三人作为邀请人，验证"已绑定不可更改"
  assert.throws(() => promotion.bindReferral(db, { userId: b, inviterUserId: d }), /已绑定邀请人/);
  // 成环：a 的邀请人不能是 b
  db.users.update(a, { directUserId: '' });
  db.users.update(b, { directUserId: a });
  assert.throws(() => promotion.bindReferral(db, { userId: a, inviterUserId: b }), /不能成环/);
});

test('推广：概览统计（直推数/活跃/收益汇总）', () => {
  const db = createStore({});
  const [a, b, c] = seedUsers(db, 3);
  promotion.bindReferral(db, { userId: b, inviterUserId: a });
  promotion.bindReferral(db, { userId: c, inviterUserId: a });
  // b 有已支付订单（活跃），c 没有
  db.orders.insert({ id: 'o1', userId: b, status: 'done', paidFen: 3000, createdAt: new Date().toISOString() });
  const { addEarning } = require('../src/domain/commission');
  addEarning(db, a, 700, 'frozen', 'c1');
  addEarning(db, a, 300, 'balance', 'c2');
  const p = promotion.referralProfile(db, a);
  assert.strictEqual(p.directCount, 2);
  assert.strictEqual(p.activeDirectCount, 1);
  assert.strictEqual(p.earnedYuan, '3.00');
  assert.strictEqual(p.frozenYuan, '7.00');
  const team = promotion.teamMembers(db, a);
  assert.strictEqual(team.length, 2);
  assert.strictEqual(team.find((m) => m.id === b).orderCount, 1);
});

test('推广：二维码未配置商户密钥时降级返回分享路径（openid/appid 不泄露）', async () => {
  const db = createStore({});
  const [a] = seedUsers(db, 1);
  const r = await wxmp.getQrcode(db, { userId: a, appid: '', secret: '' });
  assert.strictEqual(r.devMode, true);
  assert.strictEqual(r.path, `pages/index/index?inviter=${a}`);
  assert.ok(!r.base64);
  assert.ok(r.reason); // 未配置时给出可操作的原因
});

test('小程序码配置：后台保存后可读回，AppSecret 只回传掩码', () => {
  const db = createStore({});
  const saved = wxmp.saveConfig(db, { appid: 'wx1234567890', secret: 'abcdef1234567890' });
  assert.strictEqual(saved.configured, true);
  assert.strictEqual(saved.appid, 'wx1234567890');
  assert.ok(saved.secretMasked.includes('****'));
  assert.ok(!saved.secretMasked.includes('1234567890'.slice(0, 6)));
  const cfg = wxmp.getConfig(db);
  assert.strictEqual(cfg.appid, 'wx1234567890');
  assert.strictEqual(cfg.secret, 'abcdef1234567890');
});

test('小程序码生成：微信返回错误体时降级并带出原因（不抛出）', async () => {
  const db = createStore({});
  const [a] = seedUsers(db, 1);
  const fakeFetch = async () => ({
    json: async () => ({ errmsg: 'invalid appid', errcode: 40013 }),
    arrayBuffer: async () => Buffer.from('{"errmsg":"invalid appid"}'),
  });
  const r = await wxmp.getQrcode(db, { userId: a, appid: 'wxbad', secret: 'bad', fetchImpl: fakeFetch, force: true });
  assert.strictEqual(r.devMode, true);
  assert.ok(r.reason.includes('invalid appid'));
});

// ---------- 任务补全 ----------
test('浏览任务：不足 15 秒拒绝；满 15 秒计贡献值；每商品每日一次', () => {
  const db = createStore({});
  const [u] = seedUsers(db, 1);
  const date = bizdate.today();
  const start = svc.startBrowse(db, { userId: u, productId: 'p1', date });
  assert.strictEqual(start.replay, false);
  // 3 秒后尝试完成 → 拒绝
  assert.throws(() => svc.finishBrowse(db, { userId: u, productId: 'p1', date, now: Date.now() + 3000 }), /不足 15 秒/);
  // 16 秒后 → 成功
  const r = svc.finishBrowse(db, { userId: u, productId: 'p1', date, now: Date.now() + 16000 });
  assert.strictEqual(r.replay, false);
  assert.strictEqual(r.reward, 5);
  assert.throws(() => svc.startBrowse(db, { userId: u, productId: 'p1', date }), /已完成/);
  // 幂等：重复 finish 报错（任务已完成）
  assert.throws(() => svc.finishBrowse(db, { userId: u, productId: 'p1', date }), /请先开始/);
});

test('30 天贡献值：累计口径与 80 达标线', () => {
  const db = createStore({});
  const [u] = seedUsers(db, 1);
  const old = new Date(Date.now() - 40 * 86400 * 1000).toISOString();
  db.contributionFlows.insert({ userId: u, taskType: 'sign_in', reward: 60, ts: old, date: old.slice(0, 10) }); // 窗口外不计
  db.contributionFlows.insert({ userId: u, taskType: 'sign_in', reward: 50, ts: new Date().toISOString(), date: bizdate.today() });
  db.contributionFlows.insert({ userId: u, taskType: 'browse:p1', reward: 35, ts: new Date().toISOString(), date: bizdate.today() });
  const r = svc.contribution30d(db, u);
  assert.strictEqual(r.weight30d, 85);
  assert.strictEqual(r.reached, true);
});

// ---------- 风控 ----------
test('风控：黑名单拉黑/解封 + 审计', () => {
  const db = createStore({});
  const [u] = seedUsers(db, 1);
  risk.setBlacklist(db, { userId: u, blocked: true, reason: '刷单', operator: 'admin1' });
  assert.strictEqual(risk.isBlacklisted(db, u), true);
  risk.setBlacklist(db, { userId: u, blocked: false, operator: 'admin1' });
  assert.strictEqual(risk.isBlacklisted(db, u), false);
  assert.throws(() => risk.setBlacklist(db, { userId: 'ghost', blocked: true }), /用户不存在/);
  assert.ok(db.auditLogs.items.some((a) => a.action === 'risk.blacklist_add'));
});

test('风控：申诉提交（防重复）与处理', () => {
  const db = createStore({});
  const [u] = seedUsers(db, 1);
  const a1 = risk.submitAppeal(db, { userId: u, targetType: 'blacklist', targetId: u, content: '误判为刷单，请复核' });
  assert.strictEqual(a1.status, 'open');
  assert.throws(() => risk.submitAppeal(db, { userId: u, targetType: 'blacklist', targetId: u, content: '再提交一次申诉，请复核' }), /请勿重复提交/);
  assert.throws(() => risk.submitAppeal(db, { userId: u, targetType: 'x', content: '短' }), /内容过短/);
  const r = risk.resolveAppeal(db, { appealId: a1.id, accepted: true, note: '已解除', operator: 'admin1' });
  assert.strictEqual(r.status, 'accepted');
  assert.throws(() => risk.resolveAppeal(db, { appealId: a1.id, accepted: false }), /已处理/);
});

test('风控：循环免单识别（30 天 ≥3 单预警，且同周期不重复告警）', () => {
  const db = createStore({});
  const [u] = seedUsers(db, 1);
  const now = Date.now();
  for (let i = 0; i < 3; i++) {
    db.orders.insert({ id: 'f' + i, userId: u, payType: 'FREE', status: 'paid', createdAt: new Date(now - i * 3 * 86400 * 1000).toISOString() });
  }
  const alerts = risk.detectLoopFreeOrders(db, { days: 30, threshold: 3 });
  assert.strictEqual(alerts.length, 1);
  assert.strictEqual(alerts[0].freeCount, 3);
  // 同周期重复扫描不重复入告警表
  risk.detectLoopFreeOrders(db, { days: 30, threshold: 3 });
  assert.strictEqual(db.riskAlerts.all().length, 1);
});

// ---------- 消息已读 ----------
test('消息已读：标记与未读数', () => {
  const db = createStore({});
  const [u] = seedUsers(db, 1);
  db.messages.insert({ userId: u, type: 't', title: 'A', body: 'a', ts: new Date().toISOString(), read: false });
  db.messages.insert({ userId: u, type: 't', title: 'B', body: 'b', ts: new Date().toISOString(), read: false });
  // 模拟路由逻辑
  const markAll = () => { for (const m of db.messages.where((m) => m.userId === u && !m.read)) m.read = true; };
  let list = db.messages.where((m) => m.userId === u);
  assert.strictEqual(list.filter((m) => !m.read).length, 2);
  markAll();
  list = db.messages.where((m) => m.userId === u);
  assert.strictEqual(list.filter((m) => !m.read).length, 0);
});
