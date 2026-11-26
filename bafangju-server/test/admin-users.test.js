'use strict';
/**
 * 子管理员账号（V4.1）单测：两级账号 / 模块权限映射 / 登录会话 / 停用即时生效 /
 * 重置密码吊销会话 / 删除 / 账号与口令策略 / 审计留痕 / 对外视图不泄露摘要。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { createStore } = require('../src/store');
const au = require('../src/domain/adminUsers');

const PW = 'Admin-2026-Abcdefg';
const PW2 = 'Operator-2026-Xyzw';
const PW3 = 'Reset-2026-Qwerty';

describe('子管理员账号', () => {
  test('创建：账号/口令合规，权限去重排序，摘要不外泄', () => {
    const db = createStore({});
    const u = au.create(db, {
      username: 'yunying01', password: PW,
      permissions: ['orders', 'orders', 'nope', 'catalog'], note: '平台方运营', actor: 'root',
    });
    assert.strictEqual(u.username, 'yunying01');
    assert.deepStrictEqual(u.permissions, ['orders', 'catalog']); // 去重 + 固定顺序 + 丢弃未知键
    assert.strictEqual(u.enabled, true);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(u, 'passHash'), false, '对外视图不得包含摘要');
    assert.ok(!JSON.stringify(u).includes('scrypt'), '序列化结果不得包含摘要');
  });

  test('H1：不可变账号 ID 与创建人留痕；财务复核权限不默认授予', () => {
    const db = createStore({});
    const u1 = au.create(db, {
      username: 'op01', password: PW, permissions: ['orders', 'withdraw'], actor: 'root', actorId: 'uid_root',
    });
    assert.ok(u1.uid, '创建即分配不可变 uid');
    assert.strictEqual(u1.permissions.includes('finance'), false, '存量/新建账号默认无财务复核权限');
    const row = db.adminUsers.get('op01');
    assert.strictEqual(row.createdBy, 'root');
    assert.strictEqual(row.createdById, 'uid_root');
    const r = au.resetPassword(db, { username: 'op01', newPassword: PW3, actor: 'root', actorId: 'uid_root' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(db.adminUsers.get('op01').lastResetById, 'uid_root');
    assert.ok(db.adminUsers.get('op01').lastResetAt, '记录重置时间');
    const auditRow = db.auditLogs.items.find((x) => x.action === 'adminuser.reset_password');
    assert.strictEqual(auditRow.actorId, 'uid_root', '审计同时记录不可变账号 ID');
    assert.strictEqual(auditRow.actor, 'root');
    // 同名重建：uid 不同，可区分
    const oldUid = u1.uid;
    au.remove(db, { username: 'op01', actor: 'root', actorId: 'uid_root' });
    const u2 = au.create(db, { username: 'op01', password: PW, permissions: ['orders'], actor: 'root', actorId: 'uid_root' });
    assert.notStrictEqual(u2.uid, oldUid);
  });

  test('创建：非法账号名 / 弱口令 / 重名 / 冒用总账号名 均被拒', () => {
    const db = createStore({});
    db.adminAccounts.insert({ id: 'admin', username: 'admin', passHash: 'x', devDefault: false });
    au.create(db, { username: 'op01', password: PW, permissions: ['orders'], actor: 'root' });
    assert.throws(() => au.create(db, { username: '1abc', password: PW, permissions: ['orders'], actor: 'root' }), /账号需/);
    assert.throws(() => au.create(db, { username: 'op02', password: 'abc', permissions: ['orders'], actor: 'root' }), /密码强度不足/);
    assert.throws(() => au.create(db, { username: 'op01', password: PW, permissions: ['orders'], actor: 'root' }), /账号已存在/);
    assert.throws(() => au.create(db, { username: 'admin', password: PW, permissions: ['orders'], actor: 'root' }), /系统总账号/);
  });

  test('登录：正确口令签发会话；错误口令与不存在账号同文案', () => {
    const db = createStore({});
    au.create(db, { username: 'op01', password: PW, permissions: ['orders', 'catalog'], actor: 'root' });
    const s = au.login(db, { username: 'op01', password: PW, ip: '10.0.0.1' });
    assert.strictEqual(s.role, 'admin');
    assert.deepStrictEqual(s.permissions, ['orders', 'catalog']);
    assert.ok(s.token && s.token.length >= 32);
    assert.strictEqual(au.userByToken(db, s.token).id, 'op01');
    assert.throws(() => au.login(db, { username: 'op01', password: 'Wrong-Pass-123A' }), /账号或密码错误/);
    assert.throws(() => au.login(db, { username: 'ghost', password: PW }), /账号或密码错误/);
  });

  test('停用：立即吊销会话，登录被拒，重新启用后可登录', () => {
    const db = createStore({});
    au.create(db, { username: 'op01', password: PW, permissions: ['orders'], actor: 'root' });
    const s = au.login(db, { username: 'op01', password: PW });
    au.update(db, { username: 'op01', enabled: false, actor: 'root' });
    assert.strictEqual(au.userByToken(db, s.token), null, '停用后旧 token 应失效');
    assert.throws(() => au.login(db, { username: 'op01', password: PW }), /账号或密码错误/);
    au.update(db, { username: 'op01', enabled: true, actor: 'root' });
    assert.ok(au.login(db, { username: 'op01', password: PW }).token);
  });

  test('权限调整：即时生效（同一会话下一请求按新权限解析）', () => {
    const db = createStore({});
    au.create(db, { username: 'op01', password: PW, permissions: ['orders'], actor: 'root' });
    const s = au.login(db, { username: 'op01', password: PW });
    au.update(db, { username: 'op01', permissions: ['orders', 'withdraw'], actor: 'root' });
    const u = au.userByToken(db, s.token);
    assert.deepStrictEqual(u.permissions, ['orders', 'withdraw'], '改权限无需重新登录，下一请求即生效');
  });

  test('重置密码：旧会话全部吊销，旧口令失效新口令可登录', () => {
    const db = createStore({});
    au.create(db, { username: 'op01', password: PW, permissions: ['orders'], actor: 'root' });
    const s1 = au.login(db, { username: 'op01', password: PW });
    const s2 = au.login(db, { username: 'op01', password: PW });
    const r = au.resetPassword(db, { username: 'op01', newPassword: PW3, actor: 'root' });
    assert.strictEqual(r.revokedSessions, 2);
    assert.strictEqual(au.userByToken(db, s1.token), null);
    assert.strictEqual(au.userByToken(db, s2.token), null);
    assert.throws(() => au.login(db, { username: 'op01', password: PW }), /账号或密码错误/);
    assert.ok(au.login(db, { username: 'op01', password: PW3 }).token);
  });

  test('删除：账号与全部会话清除', () => {
    const db = createStore({});
    au.create(db, { username: 'op01', password: PW, permissions: ['orders'], actor: 'root' });
    const s = au.login(db, { username: 'op01', password: PW });
    au.remove(db, { username: 'op01', actor: 'root' });
    assert.strictEqual(db.adminUsers.get('op01'), null);
    assert.strictEqual(au.userByToken(db, s.token), null);
    assert.strictEqual(au.list(db).length, 0);
  });

  test('审计留痕：建号/改权限/停用/重置/删除/登录全有记录', () => {
    const db = createStore({});
    au.create(db, { username: 'op01', password: PW, permissions: ['orders'], actor: 'root' });
    au.login(db, { username: 'op01', password: PW });
    au.update(db, { username: 'op01', permissions: ['orders', 'withdraw'], actor: 'root' });
    au.update(db, { username: 'op01', enabled: false, actor: 'root' });
    au.update(db, { username: 'op01', enabled: true, actor: 'root' });
    au.resetPassword(db, { username: 'op01', newPassword: PW2, actor: 'root' });
    try { au.login(db, { username: 'op01', password: 'bad-password-x' }); } catch (e) { /* 预期失败 */ }
    au.remove(db, { username: 'op01', actor: 'root' });
    const actions = db.auditLogs.items.map((x) => x.action);
    for (const a of ['adminuser.create', 'adminuser.login', 'adminuser.update',
      'adminuser.disable', 'adminuser.enable', 'adminuser.reset_password',
      'adminuser.login_failed', 'adminuser.delete']) {
      assert.ok(actions.includes(a), `缺少审计动作 ${a}`);
    }
  });
});

describe('模块权限映射（服务端拦截口径）', () => {
  test('总账号专属 / 登录即可 / 模块前缀 三类判定', () => {
    assert.strictEqual(au.permsRequired('GET', '/users'), 'super');
    assert.strictEqual(au.permsRequired('POST', '/users/create'), 'super');
    assert.strictEqual(au.permsRequired('GET', '/me'), 'any');
    assert.strictEqual(au.permsRequired('POST', '/change-password'), 'any');
    assert.strictEqual(au.permsRequired('GET', '/orders'), 'orders');
    assert.strictEqual(au.permsRequired('POST', '/orders/ship'), 'orders');
    assert.strictEqual(au.permsRequired('GET', '/catalog/products'), 'catalog');
    assert.strictEqual(au.permsRequired('GET', '/merchant-applications'), 'merchants');
    assert.strictEqual(au.permsRequired('GET', '/advideos'), 'adCenter');
    assert.strictEqual(au.permsRequired('POST', '/advideos/create'), 'adCenter');
    assert.strictEqual(au.permsRequired('POST', '/adslots/book'), 'adCenter');
    assert.strictEqual(au.permsRequired('GET', '/ad-quotas'), 'adCenter');
    assert.strictEqual(au.permsRequired('POST', '/ad-quotas/grant'), 'super');
    assert.deepStrictEqual(au.permsRequired('GET', '/reward-withdrawals'), ['adCenter', 'withdraw', 'finance']);
    assert.deepStrictEqual(au.permsRequired('POST', '/reward-withdrawals/offline-mark'), ['adCenter', 'withdraw']);
    assert.deepStrictEqual(au.permsRequired('POST', '/reward-withdrawals/approve'), ['adCenter', 'withdraw']);
    assert.deepStrictEqual(au.permsRequired('POST', '/reward-withdrawals/reject'), ['adCenter', 'withdraw']);
    assert.strictEqual(au.permsRequired('POST', '/reward-withdrawals/offline-confirm'), 'finance');
    assert.strictEqual(au.permsRequired('POST', '/reward-withdrawals/pay'), 'finance');
    assert.strictEqual(au.permsRequired('GET', '/content'), 'content');
    assert.strictEqual(au.permsRequired('GET', '/withdraw/requests'), 'withdraw');
    assert.strictEqual(au.permsRequired('GET', '/queue-slots'), 'queue');
    assert.strictEqual(au.permsRequired('POST', '/reserve/deposit'), 'reserve');
    assert.strictEqual(au.permsRequired('POST', '/quarter/payout-auto'), 'jobs');
    assert.strictEqual(au.permsRequired('POST', '/switches'), 'switches');
    assert.strictEqual(au.permsRequired('GET', '/risk/alerts'), 'risk');
    assert.strictEqual(au.permsRequired('POST', '/messages/broadcast'), 'messages');
    assert.strictEqual(au.permsRequired('GET', '/settings/wxmp'), 'settings');
    assert.strictEqual(au.permsRequired('GET', '/audit'), 'audit');
  });

  test('看板只读接口对任何登录者放行，但写开关仍受权限约束', () => {
    assert.strictEqual(au.permsRequired('GET', '/stats/daily'), 'any');
    assert.strictEqual(au.permsRequired('GET', '/platform-flows'), 'any');
    assert.strictEqual(au.permsRequired('GET', '/rules'), 'any');
    assert.strictEqual(au.permsRequired('GET', '/switches'), 'any');
    assert.strictEqual(au.permsRequired('POST', '/switches'), 'switches');
  });

  test('未归类接口默认仅总账号（宁可误拒不可误放）', () => {
    assert.strictEqual(au.permsRequired('POST', '/unknown-dangerous'), 'super');
    assert.strictEqual(au.permsRequired('GET', '/some-new-module'), 'super');
  });
});
