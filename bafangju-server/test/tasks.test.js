'use strict';
/**
 * 任务体系（V3.3 §8.2 / §4.8-3）：
 * - 奖励值后台可配（签到 / 浏览 / 广告 / 分享）；
 * - 广告任务：开关默认关，开启后服务端校验观看时长；
 * - 30 天完成奖励 80 贡献值：每窗口只发一次，贡献值只记权重。
 */
const test = require('node:test');
const assert = require('node:assert');
const { createStore } = require('../src/store');
const svc = require('../src/services');

function setup() {
  const db = createStore();
  db.users.insert({ id: 'u1', nickname: 'u1', createdAt: new Date().toISOString() });
  return db;
}

test('奖励可配：签到/浏览/广告奖励来自后台配置', () => {
  const db = setup();
  db.switches.set('taskRewards', { sign_in: 20, browse: 3, ad: 7, share: 10 });
  svc.completeTask(db, { userId: 'u1', taskType: 'sign_in', date: '2026-10-24' });
  assert.strictEqual(db.contributions.get('u1').weight, 20);
  svc.completeTask(db, { userId: 'u1', taskType: 'browse:p1', date: '2026-10-24' });
  assert.strictEqual(db.contributions.get('u1').weight, 23);
  // 未知任务类型拒绝
  assert.throws(() => svc.completeTask(db, { userId: 'u1', taskType: 'hack', date: '2026-10-24' }), /未知任务类型/);
});

test('广告任务：默认关闭；开启后校验观看时长，完成计奖励', () => {
  const db = setup();
  const date = '2026-10-24';
  assert.throws(() => svc.startAdTask(db, { userId: 'u1', date }), /尚未开通/);
  db.switches.set('adTaskEnabled', true);
  assert.throws(() => svc.finishAdTask(db, { userId: 'u1', date }), /请先开始/);
  svc.startAdTask(db, { userId: 'u1', date });
  assert.throws(() => svc.finishAdTask(db, { userId: 'u1', date }), /观看时长不足/);
  const r = svc.finishAdTask(db, { userId: 'u1', date, now: Date.now() + 20000 });
  assert.strictEqual(r.reward, 15);
  assert.strictEqual(db.contributions.get('u1').weight, 15);
  // 同日重复完成拒绝
  assert.throws(() => svc.startAdTask(db, { userId: 'u1', date }), /已完成/);
});

test('30 天完成奖励：满 30 个不同日期发 80 分，每窗口只发一次', () => {
  const db = setup();
  db.users.insert({ id: 'u2', nickname: 'u2', createdAt: new Date().toISOString() });
  const pad = (n) => String(n).padStart(2, '0');
  for (let d = 1; d <= 30; d++) {
    const date = `2026-10-${pad(d)}`;
    db.taskRecords.insert({ userId: 'u1', taskType: 'sign_in', date, status: 'done' });
  }
  for (let d = 1; d <= 29; d++) {
    db.taskRecords.insert({ userId: 'u2', taskType: 'sign_in', date: `2026-10-${pad(d)}`, status: 'done' });
  }
  const r = svc.runTaskStreakBonus(db, { date: '2026-10-30' });
  assert.strictEqual(r.awarded, 1); // 只有 u1 满 30 天
  assert.strictEqual(db.contributions.get('u1').weight, 80);
  assert.ok(db.contributionFlows.where((f) => f.userId === 'u1' && f.taskType === 'streak_30d').length === 1);
  assert.strictEqual(db.messages.where((m) => m.userId === 'u1' && m.type === 'task_streak').length, 1);
  // 同窗口再次跑批不重复发
  assert.strictEqual(svc.runTaskStreakBonus(db, { date: '2026-10-30' }).awarded, 0);
  assert.strictEqual(db.contributions.get('u1').weight, 80);
});

test('连击奖励可配（天数与奖励值）', () => {
  const db = setup();
  db.switches.set('taskStreakBonus', { days: 3, reward: 12 });
  for (const d of ['2026-10-01', '2026-10-02', '2026-10-03']) {
    db.taskRecords.insert({ userId: 'u1', taskType: 'sign_in', date: d, status: 'done' });
  }
  const r = svc.runTaskStreakBonus(db, { date: '2026-10-03' });
  assert.strictEqual(r.awarded, 1);
  assert.strictEqual(db.contributions.get('u1').weight, 12);
});
