/**
 * 生产拒绝默认口令（P0-2）回归：
 * ① NODE_ENV=production 且未配置 ADMIN_PASSWORD → 拒绝启动；
 * ② NODE_ENV=production 且 ADMIN_PASSWORD 强度不足（<12 位 / 缺大小写 / 缺数字）→ 拒绝启动；
 * ③ NODE_ENV=production 且口令达标 → 正常建档，devDefault=false；
 * ④ 库中残留"开发默认口令"账号 → 生产启动时轮换为环境变量口令，admin/admin123 立即失效；
 * ⑤ 非生产环境 → 保留开发默认账号行为（不破坏本地开发/测试流程）；
 * ⑥ 生产环境改密执行强口令策略；
 * ⑦ 端到端：真实启动服务，production 缺口令 → 进程非 0 退出并打印明确原因；口令达标 → 正常监听。
 *
 * 说明：本文件以内存库直接驱动域模块；⑦ 用子进程拉起真实 src/server.js。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const adminAuth = require('../src/domain/adminAuth');
const { createStore } = require('../src/store');

const SERVER_JS = path.join(__dirname, '..', 'src', 'server.js');
const STRONG_PWD = 'Str0ngAdm1nPwd2026';

/** 构造环境变量对象（可显式删除某个键） */
function envOf(extra = {}, remove = []) {
  const env = { ...extra };
  for (const k of remove) delete env[k];
  return env;
}

test('生产环境未配置 ADMIN_PASSWORD → 拒绝启动（不创建任何账号）', () => {
  const db = createStore({});
  assert.throws(
    () => adminAuth.ensureAdminAccount(db, envOf({ NODE_ENV: 'production' }, ['ADMIN_PASSWORD'])),
    /必须显式配置 ADMIN_PASSWORD/
  );
  assert.strictEqual(db.adminAccounts.all().length, 0, '拒绝启动时不应落库默认账号');
});

test('生产环境 ADMIN_PASSWORD 强度不足 → 拒绝启动', () => {
  // 覆盖：太短 / 恰好 10 位 / 纯数字 / 纯字母
  const weak = ['admin123', 'abcdefgh12', '12345678901', 'ADMINPASSWORDX', 'Adminadminadmin'];
  for (const pwd of weak) {
    const db = createStore({});
    assert.throws(
      () => adminAuth.ensureAdminAccount(db, { NODE_ENV: 'production', ADMIN_PASSWORD: pwd }),
      /ADMIN_PASSWORD 强度不足/,
      '弱口令应被拒绝：' + pwd
    );
    assert.strictEqual(db.adminAccounts.all().length, 0);
  }
});

test('生产环境口令达标 → 正常建档，devDefault=false，可直接登录', () => {
  const db = createStore({});
  const r = adminAuth.ensureAdminAccount(db, { NODE_ENV: 'production', ADMIN_USER: 'boss', ADMIN_PASSWORD: STRONG_PWD });
  assert.strictEqual(r.created, true);
  assert.strictEqual(r.devDefault, false);
  assert.strictEqual(r.username, 'boss');

  const { token } = adminAuth.login(db, { username: 'boss', password: STRONG_PWD });
  assert.ok(token);
  assert.throws(() => adminAuth.login(db, { username: 'boss', password: 'admin123' }), /账号或密码错误/);
});

test('生产环境残留开发默认口令账号 → 启动时轮换为环境变量口令，默认口令立即失效', () => {
  const db = createStore({});
  // 先以开发态建档（走默认口令 admin/admin123）
  const dev = adminAuth.ensureAdminAccount(db, {});
  assert.strictEqual(dev.devDefault, true);
  assert.ok(adminAuth.login(db, { username: 'admin', password: 'admin123' }).token);

  // 生产启动：要求配置强口令，并把残留默认口令账号轮换掉
  const r = adminAuth.ensureAdminAccount(db, { NODE_ENV: 'production', ADMIN_PASSWORD: STRONG_PWD });
  assert.strictEqual(r.created, false);
  assert.strictEqual(db.adminAccounts.get('admin').devDefault, false);

  // 旧默认口令失效，新口令生效
  assert.throws(() => adminAuth.login(db, { username: 'admin', password: 'admin123' }), /账号或密码错误/);
  assert.ok(adminAuth.login(db, { username: 'admin', password: STRONG_PWD }).token);

  // 轮换动作留痕
  assert.ok(db.auditLogs.items.some((a) => a.action === 'admin.password_reset_from_env'));
});

test('生产环境下已改过密码的账号不受轮换影响（不覆盖运维已设定的口令）', () => {
  const db = createStore({});
  adminAuth.ensureAdminAccount(db, {});
  adminAuth.changePassword(db, { username: 'admin', oldPassword: 'admin123', newPassword: 'OperatorChosen1' });

  adminAuth.ensureAdminAccount(db, { NODE_ENV: 'production', ADMIN_PASSWORD: STRONG_PWD });
  assert.ok(adminAuth.login(db, { username: 'admin', password: 'OperatorChosen1' }).token, '运维口令不应被环境变量覆盖');
  assert.throws(() => adminAuth.login(db, { username: 'admin', password: STRONG_PWD }), /账号或密码错误/);
});

test('非生产环境（未设置 NODE_ENV）→ 保留开发默认账号行为', () => {
  const db = createStore({});
  const r = adminAuth.ensureAdminAccount(db, {});
  assert.strictEqual(r.created, true);
  assert.strictEqual(r.devDefault, true);
  assert.strictEqual(r.username, 'admin');
  assert.ok(adminAuth.login(db, { username: 'admin', password: 'admin123' }).token);
});

test('口令强度校验：长度大于 10 位且含字母与数字', () => {
  assert.strictEqual(adminAuth.checkPasswordStrength(STRONG_PWD).ok, true);
  assert.strictEqual(adminAuth.checkPasswordStrength('admin123').ok, false);
  assert.strictEqual(adminAuth.checkPasswordStrength('Str0ngAdm1nPwd2026').ok, true);
  assert.strictEqual(adminAuth.checkPasswordStrength('short1A').ok, false);
  // 边界：10 位不通过，11 位通过
  assert.strictEqual(adminAuth.checkPasswordStrength('abcdefgh12').ok, false);
  assert.strictEqual(adminAuth.checkPasswordStrength('abcdefghi12').ok, true);
  // 不要求大小写混排，只要字母 + 数字
  assert.strictEqual(adminAuth.checkPasswordStrength('nouppercase1234').ok, true);
  assert.strictEqual(adminAuth.checkPasswordStrength('NOLOWERCASE1234').ok, true);
  assert.strictEqual(adminAuth.checkPasswordStrength('NoDigitsInHere').ok, false);
  assert.strictEqual(adminAuth.checkPasswordStrength('12345678901').ok, false);
  assert.ok(adminAuth.checkPasswordStrength('12345678901').issues.some((i) => i.includes('字母')));
});

test('生产环境改密执行强口令策略；非生产保持 ≥8 位基线', () => {
  const db = createStore({});
  adminAuth.ensureAdminAccount(db, { NODE_ENV: 'production', ADMIN_PASSWORD: STRONG_PWD });

  assert.throws(
    () => adminAuth.changePassword(db, { username: 'admin', oldPassword: STRONG_PWD, newPassword: 'short1A' }, { NODE_ENV: 'production' }),
    /安全策略不满足/
  );
  assert.throws(
    () => adminAuth.changePassword(db, { username: 'admin', oldPassword: STRONG_PWD, newPassword: 'abcdefgh12' }, { NODE_ENV: 'production' }),
    /安全策略不满足/
  );
  adminAuth.changePassword(db, { username: 'admin', oldPassword: STRONG_PWD, newPassword: 'An0therStr0ngPwd' }, { NODE_ENV: 'production' });
  assert.ok(adminAuth.login(db, { username: 'admin', password: 'An0therStr0ngPwd' }).token);
});

test('端到端：production 缺口令 → 服务进程非 0 退出并打印拒绝原因', () => {
  const env = { ...process.env, NODE_ENV: 'production', BAFANGJU_DB_DRIVER: 'memory' };
  delete env.ADMIN_PASSWORD;
  delete env.ADMIN_USER;
  const res = spawnSync(process.execPath, [SERVER_JS], { env, encoding: 'utf8', timeout: 30000 });
  assert.notStrictEqual(res.status, 0, '缺口令时不应正常退出');
  const out = (res.stderr || '') + (res.stdout || '');
  assert.match(out, /启动被拒绝/);
  assert.match(out, /ADMIN_PASSWORD/);
});

test('端到端：production 口令达标 → 服务正常启动并监听', async () => {
  // 生产环境除强口令外还要求真实支付通道（禁止模拟支付），否则启动被拒绝
  const { privateKey } = require('node:crypto').generateKeyPairSync('rsa', { modulusLength: 2048 });
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    BAFANGJU_DB_DRIVER: 'memory',
    PORT: '0',
    ADMIN_PASSWORD: STRONG_PWD,
    WX_MCHID: '1900000001',
    WX_APPID: 'wxapp',
    WX_MERCHANT_SERIAL: 'SERIAL01',
    WX_PRIVATE_KEY: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
  };
  delete env.ADMIN_USER;
  const child = spawn(process.execPath, [SERVER_JS], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const listening = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error('启动超时，输出：' + buf)), 20000);
      child.stdout.on('data', (d) => {
        buf += d.toString();
        if (buf.includes('listening on')) { clearTimeout(timer); resolve(buf); }
      });
      child.stderr.on('data', (d) => { buf += d.toString(); });
      child.on('exit', (code) => { clearTimeout(timer); reject(new Error('进程提前退出，code=' + code + '，输出：' + buf)); });
    });
    assert.match(listening, /listening on/);
  } finally {
    child.kill();
  }
});
