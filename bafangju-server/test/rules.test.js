'use strict';
/**
 * 规则版本与确认留档（V3.3 §5.2-1 / §15-11 / §18-12）：
 * - 首次下单前必须确认当前版本；
 * - 用户确认过的版本落库留档（ruleConfirmations），供审核与客服查证；
 * - 版本升级后需重新确认。
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

test('未确认规则时下单校验失败，并带上规则版本', () => {
  const db = setup();
  const cur = svc.currentRules(db);
  assert.strictEqual(cur.version, '2026-10-24');
  assert.throws(() => svc.assertRulesConfirmed(db, 'u1'), (e) => {
    assert.strictEqual(e.code, 'RULES_NOT_CONFIRMED');
    assert.strictEqual(e.rulesVersion, cur.version);
    return true;
  });
});

test('确认后留档：版本、时间、用户字段；重复确认不重复留档', () => {
  const db = setup();
  const r = svc.confirmRules(db, { userId: 'u1', version: '2026-10-24', source: 'order' });
  assert.strictEqual(r.version, '2026-10-24');
  assert.strictEqual(r.replay, false);
  const rows = db.ruleConfirmations.where((x) => x.userId === 'u1');
  assert.strictEqual(rows.length, 1);
  assert.ok(rows[0].ts);
  assert.strictEqual(db.users.get('u1').rulesVersion, '2026-10-24');
  assert.ok(db.users.get('u1').rulesConfirmedAt);
  assert.ok(db.auditLogs.items.some((a) => a.action === 'rules.confirm'));
  // 幂等
  const again = svc.confirmRules(db, { userId: 'u1', version: '2026-10-24' });
  assert.strictEqual(again.replay, true);
  assert.strictEqual(db.ruleConfirmations.where((x) => x.userId === 'u1').length, 1);
  // 确认后可下单
  assert.strictEqual(svc.assertRulesConfirmed(db, 'u1').version, '2026-10-24');
});

test('规则改版后需重新确认；用旧版本号提交会被拒绝', () => {
  const db = setup();
  svc.confirmRules(db, { userId: 'u1', version: '2026-10-24' });
  db.switches.set('rulesVersion', '2026-11-01');
  assert.throws(() => svc.assertRulesConfirmed(db, 'u1'), /请先阅读并确认/);
  assert.throws(() => svc.confirmRules(db, { userId: 'u1', version: '2026-10-24' }), /规则已更新/);
  svc.confirmRules(db, { userId: 'u1', version: '2026-11-01' });
  assert.strictEqual(svc.assertRulesConfirmed(db, 'u1').version, '2026-11-01');
  // 历史确认留档保留
  assert.strictEqual(db.ruleConfirmations.where((x) => x.userId === 'u1').length, 2);
});
