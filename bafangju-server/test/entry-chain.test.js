'use strict';
/**
 * 商户上传资料 / 入驻审核链路回归测试。
 * 覆盖两个真实踩过的坑：
 * ① 小程序未选点时 JSON 显式传 null，Number(null)===0 会把门店坐标写成 (0,0)；
 * ② 后台列表渲染把 authed() 返回的 Response 当数组用，入驻申请/风控列表直接空白。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createStore } = require('../src/store');
const merchant = require('../src/domain/merchant');

const VALID = {
  name: '链路测试面馆', contact: '张三', phone: '13800001111',
  category: '餐饮美食', address: '益阳市赫山区测试路 1 号',
  licenseImgUrl: '/uploads-private/abcdef.png',
};

test('未选点（小程序显式 null）不会被写进 (0,0)，审核建档后仍为 null', () => {
  const db = createStore({});
  const a = merchant.submitEntryApplication(db, { ...VALID, lat: null, lng: null });
  assert.strictEqual(a.lat, null);
  assert.strictEqual(a.lng, null);
  const r = merchant.reviewEntryApplication(db, { applicationId: a.id, approved: true, operator: 'tester' });
  assert.strictEqual(r.application.status, 'approved');
  assert.strictEqual(r.merchant.lat, null);
  assert.strictEqual(r.merchant.lng, null);
});

test('已选点坐标原样保留；越界值与空串归一化为 null', () => {
  const db = createStore({});
  const a = merchant.submitEntryApplication(db, { ...VALID, lat: 23.1291, lng: 113.3644 });
  assert.deepEqual([a.lat, a.lng], [23.1291, 113.3644]);
  const b = merchant.submitEntryApplication(db, {
    ...VALID, name: '越界测试店', phone: '13800002222', lat: 999, lng: '',
  });
  assert.strictEqual(b.lat, null);
  assert.strictEqual(b.lng, null);
});

test('后台列表接口必须先解析 JSON 再渲染', () => {
  const root = path.join(__dirname, '../public/js');
  const targets = {
    'admin-merchants.js': ['/api/admin/merchant-applications'],
    'admin-governance.js': ['/api/admin/risk/blacklist', '/api/admin/risk/alerts', '/api/admin/risk/appeals'],
  };
  for (const [file, endpoints] of Object.entries(targets)) {
    const lines = fs.readFileSync(path.join(root, file), 'utf8').split('\n');
    for (const ep of endpoints) {
      const line = lines.find((l) => l.includes("authed('" + ep + "')"));
      assert.ok(line, file + ' 缺少 ' + ep + ' 调用');
      assert.match(line, /\.then\(\(r\) => r\.json\(\)\)/,
        file + ' 的 ' + ep + ' 必须解析 Response，否则 .map 会抛 TypeError');
    }
  }
});

test('商家资料接口：只读白名单，不下发证照地址与登录凭据', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/merchant.js'), 'utf8');
  const from = src.indexOf("app.get('/api/merchant/profile'");
  assert.ok(from >= 0, '缺少 /api/merchant/profile 路由');
  const body = src.slice(from, from + 1800);
  assert.match(body, /const m = req\.merchant/, '必须走商家鉴权后的自身身份');
  assert.match(body, /licenseSubmitted: !!a\.licenseImgUrl/, '证照只回传是否已提交');
  assert.ok(!/res\.json\(\{\s*\.\.\.m/.test(body), '不得整行 spread 商家记录');
  assert.ok(!/passwordHash|licenseImgUrl:/.test(body.replace('licenseSubmitted: !!a.licenseImgUrl', '')),
    '不得把摘要或证照 URL 返回给小程序');
});

test('商家「入驻资料」页（分包 subpkg-merchant）：登录态分流、绑定方法齐全、协议不再承诺可更新', () => {
  // V4.0 合并后商家端为用户端小程序分包，测试指向分包内真实代码
  const root = path.join(__dirname, '../../bafangju-miniprogram-user/subpkg-merchant/pages');
  const js = fs.readFileSync(path.join(root, 'entry/entry.js'), 'utf8');
  const wxml = fs.readFileSync(path.join(root, 'entry/entry.wxml'), 'utf8');
  assert.match(js, /isMember/, '需要按登录态区分申请表单与只读资料');
  assert.match(js, /api\.get\('\/api\/merchant\/profile'\)/, '已入驻商家应读取自身资料');
  assert.match(wxml, /wx:if="\{\{isMember\}\}"/);
  assert.match(wxml, /<block wx:else>/, '未登录访客仍需保留入驻申请表单');
  const binds = [...wxml.matchAll(/(?:bind|catch)(?:tap|input)="([A-Za-z_]\w*)"/g)].map((m) => m[1]);
  for (const fn of new Set(binds)) {
    assert.ok(new RegExp('(^|\\n)\\s*' + fn + '\\(').test(js), 'entry.js 缺少页面绑定的方法：' + fn);
  }
  const agreement = fs.readFileSync(path.join(root, 'agreement/agreement.wxml'), 'utf8');
  assert.ok(!/查看与更新店铺信息|我的 → 客服/.test(agreement), '协议不得再承诺页面内自助更新或不存在的客服入口');
});

test('入驻申请表单：本地预校验与后端同规则，提交成功不 reLaunch 清顾客页面栈', () => {
  const root = path.join(__dirname, '../../bafangju-miniprogram-user/subpkg-merchant/pages');
  const js = fs.readFileSync(path.join(root, 'entry/entry.js'), 'utf8');
  // 本地预校验（与服务端 submitEntryApplication 规则一致）
  assert.match(js, /至少 2 字/, '名称长度预校验');
  assert.match(js, /\/\^1\\d\{10\}\$\//, '手机号格式预校验');
  assert.match(js, /licenseImgUrl/, '执照必传预校验');
  // 提交成功 navigateBack 返回来源页；reLaunch 会清掉顾客端 tab 栈（申请人是顾客）
  assert.match(js, /wx\.navigateBack\(\{ delta: 1 \}\)/, '提交成功应返回来源页');
  assert.ok(!js.includes('wx.reLaunch('), '入驻页不得使用 reLaunch（会清顾客端页面栈）');
});

test('入驻进度自助查询：接口双因子匹配且信息收窄，前端有查询入口', () => {
  // 服务端：名称+手机号双因子，只回状态/时间/驳回原因，不回证照与申请内容
  const pub = fs.readFileSync(path.join(__dirname, '../src/routes/public.js'), 'utf8');
  const from = pub.indexOf("app.get('/api/merchant-entry/status'");
  assert.ok(from >= 0, '缺少 GET /api/merchant-entry/status 路由');
  const body = pub.slice(from, from + 1200);
  assert.match(body, /a\.name === name && a\.phone === phone/, '必须名称+手机号双因子匹配');
  assert.ok(!/licenseImgUrl|shopImgUrl|contact/.test(body), '进度查询不得返回证照地址或联系人信息');
  // 前端：查询入口、双因子表单、结果三态
  const root = path.join(__dirname, '../../bafangju-miniprogram-user/subpkg-merchant/pages');
  const js = fs.readFileSync(path.join(root, 'entry/entry.js'), 'utf8');
  const wxml = fs.readFileSync(path.join(root, 'entry/entry.wxml'), 'utf8');
  assert.match(js, /queryProgress/, '缺少查询方法');
  assert.match(js, /entry_last/, '提交成功应记住名称+手机号供查询预填');
  assert.match(wxml, /查询审核进度/, '表单视图须有进度查询入口');
  for (const s of ['pending_review', 'approved', 'rejected']) {
    assert.ok(new RegExp('[\'"]?' + s + '[\'"]?\\s*:\\s*\\{').test(js), '查询结果须覆盖状态：' + s);
  }
});
