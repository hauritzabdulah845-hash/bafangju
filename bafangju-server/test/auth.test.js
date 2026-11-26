'use strict';
/**
 * 登录鉴权测试：code2session 真实模式参数拼装与错误处理、开发态降级、openid 幂等建档。
 */
const test = require('node:test');
const assert = require('node:assert');
const { createStore } = require('../src/store');
const auth = require('../src/domain/auth');

test('开发态降级：同一 code 稳定映射同一 openid，不调外部接口', async () => {
  const a = await auth.code2session({ code: 'dev-code-1' });
  const b = await auth.code2session({ code: 'dev-code-1' });
  assert.strictEqual(a.devMode, true);
  assert.strictEqual(a.openid, b.openid);
  assert.match(a.openid, /^dev_[0-9a-f]{16}$/);
});

test('真实模式：请求 URL 携带 appid/secret/js_code；返回 openid', async () => {
  let capturedUrl = '';
  const r = await auth.code2session({
    code: 'realcode', appid: 'wx123', secret: 'sec456',
    fetchImpl: async (url) => { capturedUrl = url; return { json: async () => ({ openid: 'oX-1', session_key: 'sk' }) }; },
  });
  assert.strictEqual(r.openid, 'oX-1');
  assert.strictEqual(r.devMode, false);
  assert.ok(capturedUrl.includes('appid=wx123'));
  assert.ok(capturedUrl.includes('secret=sec456'));
  assert.ok(capturedUrl.includes('js_code=realcode'));
  assert.ok(capturedUrl.includes('grant_type=authorization_code'));
});

test('真实模式：微信返回 errcode 时抛出可读错误', async () => {
  await assert.rejects(
    auth.code2session({
      code: 'bad', appid: 'wx123', secret: 'sec456',
      fetchImpl: async () => ({ json: async () => ({ errcode: 40029, errmsg: 'invalid code' }) }),
    }),
    /40029/,
  );
});

test('V4.0 合并后：商家提现绑定统一走用户端小程序配置（WX_MERCHANT_* 通道已废弃）', () => {
  const wxmp = require('../src/domain/wxmp');
  const routes = require('fs').readFileSync(require('path').join(__dirname, '../src/routes/merchant.js'), 'utf8');
  // 商家工作台并入用户端小程序（同一 AppID）：bind-receiver 必须用 getConfig(db)
  assert.ok(routes.includes("wxmp.getConfig(db)"), 'bind-receiver 应使用用户端小程序配置 getConfig(db)');
  assert.ok(!routes.includes('wxmp.getMerchantConfig('), '不得再使用已废弃的 getMerchantConfig 通道');
  assert.strictEqual(typeof wxmp.getMerchantConfig, 'undefined', 'wxmp 不应再导出 getMerchantConfig');
  // 未配置时生产拒绝的语义保留（由调用方判断 wx.appid）
  assert.ok(routes.includes('!wx.appid'), '应保留生产未配置拒绝逻辑');
});

test('openid 幂等建档：重复登录同一 userId；真实昵称不被覆盖，占位符昵称可更新', () => {
  const db = createStore();
  const a = auth.loginOrRegister(db, { openid: 'oA', nickname: '甲' });
  const b = auth.loginOrRegister(db, { openid: 'oA', nickname: '甲改' });
  assert.strictEqual(a.created, true);
  assert.strictEqual(b.created, false);
  assert.strictEqual(a.userId, b.userId);
  // 真实昵称不得被后续登录覆盖：静默重登不得冲掉用户昵称（P1-4）
  assert.strictEqual(db.users.get(b.userId).nickname, '甲');
  // 占位符昵称（'用户' + 4 位）允许被真实昵称替换
  const p = auth.loginOrRegister(db, { openid: 'oP', nickname: '用户ab12' });
  auth.loginOrRegister(db, { openid: 'oP', nickname: '真实昵称' });
  assert.strictEqual(db.users.get(p.userId).nickname, '真实昵称');
  const c = auth.loginOrRegister(db, { openid: 'oB', nickname: '乙' });
  assert.notStrictEqual(a.userId, c.userId);
});

test('完整流程 loginWithCode：sessionKey 不下发', async () => {
  const db = createStore();
  const r = await auth.loginWithCode(db, {
    code: 'c1', nickname: '测试',
    appid: 'wx', secret: 's',
    fetchImpl: async () => ({ json: async () => ({ openid: 'oZ', session_key: 'SECRET' }) }),
  });
  assert.ok(!('sessionKey' in r) && !('session_key' in r));
  assert.strictEqual(db.users.get(r.userId).openid, 'oZ');
});

test('开发态本地幂等：同一 devSeed（不同 code）映射同一 openid，不同设备不同账号', async () => {
  const a = await auth.code2session({ code: 'code-1', devSeed: 'device-A' });
  const b = await auth.code2session({ code: 'code-2', devSeed: 'device-A' });
  const c = await auth.code2session({ code: 'code-3', devSeed: 'device-B' });
  assert.strictEqual(a.openid, b.openid);
  assert.notStrictEqual(a.openid, c.openid);
});

test('loginWithCode 幂等：同一设备多次登录返回同一 userId，不重复建号', async () => {
  const db = createStore();
  const r1 = await auth.loginWithCode(db, { code: 'c1', devSeed: 'dev-1', nickname: '甲' });
  const r2 = await auth.loginWithCode(db, { code: 'c2', devSeed: 'dev-1', nickname: '甲' });
  assert.strictEqual(r1.userId, r2.userId);
  assert.strictEqual(r2.created, false);
  assert.strictEqual(db.users.all().length, 1);
});

test('老账号认领：持有效会话的无 openid 账号，首次微信登录绑定而非新建', async () => {
  const db = createStore();
  const legacy = db.users.insert({ nickname: '老用户', createdAt: new Date().toISOString() });
  const r = await auth.loginWithCode(db, { code: 'c1', devSeed: 'dev-9', nickname: '老用户', legacyUserId: legacy.id });
  assert.strictEqual(r.userId, legacy.id);
  assert.strictEqual(r.claimed, true);
  assert.ok(db.users.get(legacy.id).openid);
  assert.strictEqual(db.users.all().length, 1);
  // 不传 legacyUserId（未持有会话）时不会冒领，会新建账号
  const other = db.users.insert({ nickname: '另一个', createdAt: new Date().toISOString() });
  const r2 = await auth.loginWithCode(db, { code: 'c2', devSeed: 'dev-10' });
  assert.notStrictEqual(r2.userId, other.id);
});
