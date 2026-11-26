'use strict';
/**
 * 上传安全回归（P0-3 修复）：
 * ① 真实类型判定（读文件头 magic bytes，不信任客户端 ext），伪装文件一律拒收；
 * ② 文件名用 crypto.randomUUID（不可预测，不含时间戳）；
 * ③ 身份分级：素材上传必须登录；未登录只允许传入驻证照（落私有目录，外部不可访问）；
 * ④ 频率限制（分钟级）与每日配额（主体/IP/全站，落库跨重启有效）；
 * ⑤ 入驻证照私有化：公开静态路由取不到，仅管理后台鉴权后可查看。
 *
 * 说明：以内存库启动真实 Express 应用（不落盘），上传目录指向系统临时目录，避免污染仓库。
 */
process.env.BAFANGJU_DB_DRIVER = 'memory';
process.env.WX_APPID = '';
process.env.WX_SECRET = '';
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASSWORD = 'TestAdminPwd2026';

const os = require('os');
const path = require('path');
const fs = require('fs');
// 上传目录指向临时目录（必须在 require('../src/server') 之前设置）
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bfj-upload-'));
process.env.BAFANGJU_UPLOAD_DIR = path.join(TMP_ROOT, 'public');
process.env.BAFANGJU_UPLOAD_PRIVATE_DIR = path.join(TMP_ROOT, 'private');

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { app, db } = require('../src/server');
const upload = require('../src/domain/upload');
const merchant = require('../src/domain/merchant');
const { createStore } = require('../src/store');

let server;
let base;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

async function api(p, { method = 'GET', token, body } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: 'Bearer ' + token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

// ---------- 图片样本（按真实文件头构造） ----------
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 2)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(200, 3)]);
const TEXT = Buffer.from('这不是图片，只是一段普通文本内容。'.repeat(20), 'utf8');
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(200, 4)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(200, 5)]);

const b64 = (buf) => buf.toString('base64');

/** 清空频率计数与当日配额计数（用例之间互不干扰） */
function resetUploads() {
  upload.resetRateLimits();
  for (const row of db.uploadQuota.all()) db.uploadQuota.delete(row.id);
}

// ---------- 单元：类型判定与报文校验 ----------

test('魔数校验：按文件真实内容判定类型，不信任 ext', () => {
  assert.strictEqual(upload.detectImageType(PNG).ext, 'png');
  assert.strictEqual(upload.detectImageType(JPEG).ext, 'jpg');
  assert.strictEqual(upload.detectImageType(WEBP).ext, 'webp');
  assert.strictEqual(upload.detectImageType(TEXT), null);
  assert.strictEqual(upload.detectImageType(PDF), null);
  assert.strictEqual(upload.detectImageType(GIF), null, 'GIF 不在白名单内');
  assert.strictEqual(upload.detectImageType(Buffer.alloc(0)), null);
});

test('报文校验：非法 base64 / 超限 / 过小一律拒绝', () => {
  assert.throws(() => upload.decodeImagePayload(''), /dataBase64 必填/);
  assert.throws(() => upload.decodeImagePayload('!!! 不是 base64 !!!'), /base64/);
  assert.throws(() => upload.decodeImagePayload(b64(Buffer.alloc(10))), /无效/);
  assert.throws(() => upload.decodeImagePayload(b64(Buffer.alloc(5 * 1024 * 1024))), /4MB/);
  assert.strictEqual(upload.decodeImagePayload(b64(PNG)).length, PNG.length);
  assert.strictEqual(upload.decodeImagePayload(b64(PNG)).readUInt32BE(0), PNG.readUInt32BE(0));
});

test('文件名使用 UUID v4：不可预测、不含时间戳尾巴', () => {
  const n1 = upload.randomFileName('jpg');
  const n2 = upload.randomFileName('jpg');
  assert.match(n1, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$/);
  assert.notStrictEqual(n1, n2);
});

// ---------- 端到端：接口行为 ----------

test('未登录上传入驻证照：落私有目录，公开静态路由取不到', async () => {
  resetUploads();
  const r = await api('/api/upload', {
    method: 'POST',
    body: { dataBase64: b64(PNG), ext: 'png', purpose: 'entry' },
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.url, /^\/uploads-private\/[0-9a-f-]{36}\.png$/);
  assert.strictEqual(r.data.scope, 'private');

  const name = r.data.url.split('/').pop();
  assert.ok(fs.existsSync(path.join(process.env.BAFANGJU_UPLOAD_PRIVATE_DIR, name)), '证照应落在私有目录');
  assert.ok(!fs.existsSync(path.join(process.env.BAFANGJU_UPLOAD_DIR, name)), '证照不得落公开目录');

  // 公开静态路由（含私有目录前缀）都取不到
  assert.strictEqual((await fetch(base + '/uploads/' + name)).status, 404);
  assert.strictEqual((await fetch(base + '/uploads-private/' + name)).status, 404);
  // 管理后台接口未登录 → 401
  assert.strictEqual((await fetch(base + '/api/admin/uploads/private/' + name)).status, 401);
});

test('未登录上传素材（purpose=material）一律 401：公开目录不得被匿名写入', async () => {
  resetUploads();
  const r = await api('/api/upload', {
    method: 'POST',
    body: { dataBase64: b64(PNG), ext: 'png', purpose: 'material' },
  });
  assert.strictEqual(r.status, 401);
  assert.match(r.data.error, /登录/);
});

test('伪装文件被拒：文本/PDF 内容即便声明 ext=jpg 也无法通过', async () => {
  resetUploads();
  for (const payload of [TEXT, PDF, GIF]) {
    const r = await api('/api/upload', {
      method: 'POST',
      body: { dataBase64: b64(payload), ext: 'jpg', purpose: 'entry' },
    });
    assert.strictEqual(r.status, 400, '伪装文件应被拒绝');
    assert.match(r.data.error, /PNG\/JPEG\/WEBP/);
  }
});

test('扩展名以真实内容为准：声明 ext=exe 的 PNG 仍按 png 落盘', async () => {
  resetUploads();
  const r = await api('/api/upload', {
    method: 'POST',
    body: { dataBase64: b64(PNG), ext: 'exe', purpose: 'entry' },
  });
  assert.strictEqual(r.status, 200);
  assert.match(r.data.url, /\.png$/);
  assert.strictEqual(r.data.ext, 'png');
});

test('频率限制：同一游客连续上传超限返回 429', async () => {
  resetUploads();
  const lim = upload.LIMITS.guest.perMinute;
  for (let i = 0; i < lim; i++) {
    const r = await api('/api/upload', { method: 'POST', body: { dataBase64: b64(PNG), purpose: 'entry' } });
    assert.strictEqual(r.status, 200, `第 ${i + 1} 次上传应成功`);
  }
  const over = await api('/api/upload', { method: 'POST', body: { dataBase64: b64(PNG), purpose: 'entry' } });
  assert.strictEqual(over.status, 429);
  assert.match(over.data.error, /频繁/);
});

test('每日配额：达到当日次数上限后拒绝（429），且计数落库可跨重启', async () => {
  resetUploads();
  const first = await api('/api/upload', { method: 'POST', body: { dataBase64: b64(PNG), purpose: 'entry' } });
  assert.strictEqual(first.status, 200);
  const row = db.uploadQuota.all().find((r) => r.scope.startsWith('id:guest:'));
  assert.ok(row, '应产生主体维度的配额计数行');
  assert.strictEqual(row.count, 1);
  row.count = upload.LIMITS.guest.perDay; // 打满当日次数

  const over = await api('/api/upload', { method: 'POST', body: { dataBase64: b64(PNG), purpose: 'entry' } });
  assert.strictEqual(over.status, 429);
  assert.match(over.data.error, /次数已达上限/);
});

test('已登录商家上传素材：落公开目录，URL 匿名可读', async () => {
  resetUploads();
  const created = merchant.adminCreateMerchant(db, {
    name: '上传测试商家', contact: '张三', username: 'up_merchant',
    password: 'Test123456', category: '餐饮美食', address: '测试路 1 号',
  });
  const r = await api('/api/upload', {
    method: 'POST',
    token: created.merchant.token,
    body: { dataBase64: b64(JPEG), ext: 'jpg', purpose: 'material' },
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.url, /^\/uploads\/[0-9a-f-]{36}\.jpg$/);
  assert.strictEqual(r.data.scope, 'public');
  const pub = await fetch(base + r.data.url);
  assert.strictEqual(pub.status, 200, '素材图需能被用户端小程序匿名浏览');
});

test('管理后台可查看私有证照；路径非法一律拒绝', async () => {
  resetUploads();
  const up = await api('/api/upload', { method: 'POST', body: { dataBase64: b64(PNG), purpose: 'entry' } });
  const name = up.data.url.split('/').pop();

  const login = await api('/api/admin/login', {
    method: 'POST', body: { username: 'admin', password: 'TestAdminPwd2026' },
  });
  assert.strictEqual(login.status, 200);
  const ok = await fetch(base + '/api/admin/uploads/private/' + name, {
    headers: { authorization: 'Bearer ' + login.data.token },
  });
  assert.strictEqual(ok.status, 200);
  const got = Buffer.from(await ok.arrayBuffer());
  assert.ok(got.slice(0, 8).equals(PNG.slice(0, 8)), '返回的应是原始图片字节');

  // 路径穿越 / 非法文件名
  for (const bad of ['..%2F..%2Fpackage.json', 'not-a-uuid.jpg', 'a.png']) {
    const r = await fetch(base + '/api/admin/uploads/private/' + bad, {
      headers: { authorization: 'Bearer ' + login.data.token },
    });
    assert.ok(r.status === 400 || r.status === 404, `非法文件名应被拒绝：${bad}`);
  }
});

test('上传行为有审计留痕（成功与被拒）', async () => {
  resetUploads();
  await api('/api/upload', { method: 'POST', body: { dataBase64: b64(PNG), purpose: 'entry' } });
  await api('/api/upload', { method: 'POST', body: { dataBase64: b64(PNG), purpose: 'material' } });
  assert.ok(db.auditLogs.items.some((a) => a.action === 'upload.image'), '成功上传应留痕');
  assert.ok(db.auditLogs.items.some((a) => a.action === 'upload.rejected'), '被拒上传应留痕');
});

test('入驻申请：证照地址必须是站内上传路径（杜绝外站图片混入审核页）', () => {
  const dbi = createStore({});
  const baseArgs = {
    name: '路径校验商家', contact: '李四', phone: '13800003333',
    category: '餐饮美食', address: '校验路 1 号',
  };
  assert.throws(
    () => merchant.submitEntryApplication(dbi, { ...baseArgs, licenseImgUrl: 'https://evil.example/x.jpg' }),
    /地址非法/,
  );
  assert.throws(
    () => merchant.submitEntryApplication(dbi, { ...baseArgs, name: '路径校验商家2', licenseImgUrl: '/uploads-private/../secret.jpg' }),
    /地址非法/,
  );
  const ok = merchant.submitEntryApplication(dbi, { ...baseArgs, licenseImgUrl: '/uploads-private/abc-123.jpg' });
  assert.strictEqual(ok.status, 'pending_review');
});
