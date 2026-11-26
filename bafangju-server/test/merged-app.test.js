'use strict';
/**
 * V4.0 单小程序双角色合并回归。
 * 背景：商家端原为独立工程（与用户端竟共用同一 AppID wxa8811b4cc88f9857，
 * 两个工程互传版本会互相覆盖，且服务端商家独立 appid 通道从未配置）。
 * 合并方案：商家端 16 页迁入用户端分包 subpkg-merchant，账号密码登录（merchant_token），
 * 与顾客微信身份并存；4 个主页面用 mtab 伪底栏（分包页不能做 tabBar 页）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '../..');
const USER = path.join(ROOT, 'bafangju-miniprogram-user');
const SUBPKG = path.join(USER, 'subpkg-merchant');
const read = (p) => fs.readFileSync(p, 'utf8');

const MERCHANT_PAGES = [
  'pages/login/login', 'pages/index/index', 'pages/orders/orders', 'pages/verify/verify',
  'pages/earnings/earnings', 'pages/profile/profile', 'pages/coupons/coupons',
  'pages/products/products', 'pages/ads/ads', 'pages/ad-videos/ad-videos',
  'pages/withdraw/withdraw', 'pages/fee-bills/fee-bills', 'pages/shop/shop',
  'pages/entry/entry', 'pages/agreement/agreement', 'pages/password/password',
];
const MTAB_HUBS = ['index', 'verify', 'earnings', 'profile'];

function walk(dir, exts) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, exts));
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

test('app.json：商家 16 页注册为分包 subpkg-merchant，主包 tabBar 保持 5 个用户 tab 不变', () => {
  const app = JSON.parse(read(path.join(USER, 'app.json')));
  assert.strictEqual(app.pages.length, 22, '主包页面数不应因合并变化');
  const subs = app.subPackages || [];
  assert.strictEqual(subs.length, 1, '应只有一个商家分包');
  assert.strictEqual(subs[0].root, 'subpkg-merchant');
  assert.deepStrictEqual(subs[0].pages.slice().sort(), MERCHANT_PAGES.slice().sort(), '商家页面清单应完整迁移');
  const tabs = app.tabBar.list.map((t) => t.pagePath);
  assert.deepStrictEqual(tabs, [
    'pages/index/index', 'pages/orders/orders', 'pages/ads/ads', 'pages/returns/returns', 'pages/profile/profile',
  ], '用户端 5 tab 结构不得被合并影响');
  // 分包页与主包页无同名冲突路径（subpkg 根前缀天然隔离）
  for (const p of subs[0].pages) assert.ok(!app.pages.includes('subpkg-merchant/' + p));
});

test('分包跳转路径全部带 subpkg 前缀，且分包内禁用 wx.switchTab', () => {
  const files = walk(SUBPKG, ['.js', '.wxml']);
  assert.ok(files.length > 35, '分包文件数量异常');
  for (const f of files) {
    const src = read(f);
    const rel = path.relative(SUBPKG, f);
    // 裸 /pages/ 前缀在分包内必然指向主包用户页（错误目标）
    assert.ok(!/(["'])\/pages\//.test(src), rel + ' 跳转必须加 /subpkg-merchant 前缀');
    assert.ok(!src.includes('wx.switchTab('), rel + ' 分包页非 tabBar 页，禁用 wx.switchTab');
  }
});

test('mtab 伪底栏：4 个主页面注册并挂载，组件用 redirectTo 平级切换', () => {
  const mtabJs = read(path.join(SUBPKG, 'components/mtab/mtab.js'));
  assert.match(mtabJs, /wx\.redirectTo/, '底栏切换必须 redirectTo（保持页面栈）');
  assert.ok(!mtabJs.includes('wx.switchTab'), '底栏不得使用 switchTab');
  for (const hub of MTAB_HUBS) {
    const j = JSON.parse(read(path.join(SUBPKG, `pages/${hub}/${hub}.json`)));
    assert.strictEqual(j.usingComponents && j.usingComponents.mtab, '/subpkg-merchant/components/mtab/mtab',
      hub + ' 页未注册 mtab 组件');
    const w = read(path.join(SUBPKG, `pages/${hub}/${hub}.wxml`));
    assert.ok(w.includes('<mtab'), hub + ' 页 wxml 未挂载底栏');
  }
});

test('角色并存：用户「我的」有商家工作台入口，按登录态分流；app.js 恢复商家身份', () => {
  const wxml = read(path.join(USER, 'pages/profile/profile.wxml'));
  assert.match(wxml, /goMerchant/, '我的页缺少商家工作台入口');
  assert.match(wxml, /\/subpkg-merchant\/pages\/entry\/entry/, '我的页应保留商家入驻申请入口');
  const js = read(path.join(USER, 'pages/profile/profile.js'));
  assert.match(js, /isMerchant/, '需要按商家登录态分流');
  assert.match(js, /\/subpkg-merchant\/pages\/index\/index/, '已登录商家应直达工作台');
  assert.match(js, /\/subpkg-merchant\/pages\/login\/login/, '未登录应去商家登录页');
  // 商家身份存独立 storage key，与用户 token 互不覆盖
  assert.match(js, /merchant_token/, '商家登录态应读 merchant_token');
  const appjs = read(path.join(USER, 'app.js'));
  assert.match(appjs, /merchantId/, 'app.js 应恢复商家 globalData');
});

test('商家登录成功用 redirectTo 保留用户页面栈（不得 reLaunch 清掉顾客端）', () => {
  const login = read(path.join(SUBPKG, 'pages/login/login.js'));
  assert.match(login, /wx\.redirectTo\(\{ url: '\/subpkg-merchant\/pages\/index\/index'/);
  assert.ok(!login.includes('wx.reLaunch('), 'reLaunch 会清空用户端页面栈，合并后禁用');
  // 双身份并存：商家 storage 与用户 storage 是不同的 key
  assert.ok(login.includes("wx.setStorageSync('merchantId'"), '商家身份应写 merchant key');
});

test('分包样式隔离：商家差异样式经 merchant-base 生效，不污染用户端全局', () => {
  const userApp = read(path.join(USER, 'app.wxss'));
  const base = read(path.join(SUBPKG, 'merchant-base.wxss'));
  // 商家差异选择器（.btn/.tag 商家版）不得进入全局 app.wxss
  assert.ok(!/\.btn \{/.test(userApp), '商家 .btn 通栏样式不得污染用户全局');
  assert.ok(/\.btn \{/.test(base), '商家差异样式应保留在 merchant-base');
  for (const pg of MERCHANT_PAGES) {
    const wxss = path.join(SUBPKG, pg + '.wxss');
    if (fs.existsSync(wxss)) {
      assert.ok(read(wxss).includes("merchant-base.wxss"), pg + ' 未引入商家差异样式');
    }
  }
});

test('旧商家独立工程留档不再被引用：用户端工程内无指向独立工程的路径', () => {
  const files = walk(USER, ['.js', '.json', '.wxml', '.wxss'])
    .filter((f) => !f.includes(path.join('subpkg-merchant', 'config.dev.js')));
  for (const f of files) {
    const src = read(f);
    assert.ok(!src.includes('bafangju-miniprogram-merchant'), path.relative(USER, f) + ' 引用了旧独立工程路径');
  }
});

test('401 会话失效不产生登录页/工作台互跳死循环（整组清除商家会话）', () => {
  // 场景：服务端轮换/重置 token（改密、后台 reset-token）后，storage 里 merchantId 仍在。
  // 旧实现：api.js 401 只清 merchant_token → login.onShow 见 globalData.merchantId 跳回工作台
  // → 工作台守卫也只查 merchantId → 放行 → 请求又 401 → 无限互跳。
  const api = read(path.join(SUBPKG, 'utils/api.js'));
  assert.match(api, /clearMerchantSession\(\)/, '401 兜底必须调用 clearMerchantSession');
  // 整组清除：token + merchantId + merchantName + globalData
  assert.match(api, /removeStorageSync\('merchantId'\)/, '必须同时清 merchantId');
  assert.match(api, /removeStorageSync\('merchantName'\)/, '必须同时清 merchantName');
  assert.match(api, /g\.merchantId = null/, '必须清 globalData.merchantId');
  // login 自动跳回必须同时要求 token 存在
  const login = read(path.join(SUBPKG, 'pages/login/login.js'));
  assert.match(login, /merchantId && token\)/, 'login.onShow 自动跳回须校验 merchant_token 存在');
  // 全部工作台守卫页跳登录用 reLaunch（清栈），401 兜底用 redirectTo（保顾客栈）——两跳不得互相回弹
  assert.match(api, /wx\.redirectTo\(\{ url: '\/subpkg-merchant\/pages\/login\/login' \}\)/);
});

test('商家发券页：暂停/恢复发券开关已接线（前端按钮 + 接口 + 权限）', () => {
  const js = read(path.join(SUBPKG, 'pages/coupons/coupons.js'));
  const wxml = read(path.join(SUBPKG, 'pages/coupons/coupons.wxml'));
  assert.match(js, /toggleStatus/, '缺少暂停/恢复方法');
  assert.match(js, /\/api\/merchant\/coupons\/status/, '未接停发接口');
  assert.match(wxml, /bindtap="toggleStatus"/, '券列表缺少停发开关');
  assert.match(wxml, /暂停发券|恢复发券/, '开关文案缺失');
  // 服务端：停发接口在商家鉴权前缀下（token 派生身份，不信任前端 merchantId）
  const routes = read(path.join(__dirname, '../src/routes/merchant.js'));
  assert.match(routes, /app\.post\('\/api\/merchant\/coupons\/status'/, '缺少停发路由');
  const from = routes.indexOf("app.post('/api/merchant/coupons/status'");
  assert.match(routes.slice(from, from + 600), /req\.merchant\.id/, '必须用会话商家身份，防止操作他人券');
});

test('后台凭据交付对齐单小程序合并：指引登录入口，不再让商家拿 token', () => {
  const js = read(path.join(__dirname, '../public/js/admin-merchants.js'));
  // 入驻通过 / 创建账号弹窗：必须给出合并后的登录入口指引
  assert.ok((js.match(/商家登录入口：/g) || []).length >= 2, '两处凭据弹窗都必须指明登录入口');
  assert.match(js, /「我的」→「商家服务」/, '须指引到小程序「我的」→「商家服务」');
  // 商家登录界面只输账号密码：入驻/建号弹窗不得再出现「初始 token」字段（token 是服务端会话凭据）
  assert.ok(!/label: '(初始 )?token'/.test(js.replace(/showSecret\('商家 token 已重置'[\s\S]*?\);/, '')),
    '入驻/创建账号弹窗不得出现 token 字段（重置 token 弹窗除外）');
  // admin.html 入驻审核标题不得再写「发密钥（token）」
  const html = read(path.join(__dirname, '../public/admin.html'));
  assert.ok(!html.includes('发密钥（token）'), '入驻审核标题应说明发账号与初始密码，而非 token');
  assert.match(html, /「八方聚」小程序 我的 → 商家服务/, '入驻审核标题须指引登录入口');
  // H5 商家端登录页指引同步小程序自助入驻入口
  const h5 = read(path.join(__dirname, '../public/merchant.html'));
  assert.match(h5, /商家入驻申请/, 'H5 登录页须指引小程序自助入驻入口');
});

test('商家端单源派生防漂移：独立包 bafangju-miniprogram-merchant 与分包真源严格同步且符合 tabBar 规范', () => {
  const { checkSync, TABBAR_HUBS } = require('../tools/sync-merchant-standalone');
  const res = checkSync();
  assert.strictEqual(
    res.ok,
    true,
    '独立商家端小程序与 subpkg-merchant 真源发生漂移（请运行 npm run sync:merchant）：'
      + res.drifts.map((d) => `${d.file}(${d.reason})`).join(', ')
  );

  const standalone = path.join(ROOT, 'bafangju-miniprogram-merchant');
  const files = walk(standalone, ['.js', '.wxml', '.wxss', '.json']);
  const tabRe = new RegExp(`wx\\.(?:redirectTo|navigateTo)\\(\\{\\s*url:\\s*['"]\\/pages\\/(${TABBAR_HUBS.join('|')})\\/`);
  for (const f of files) {
    const src = read(f);
    const rel = path.relative(standalone, f);
    assert.ok(!src.includes('/subpkg-merchant/'), rel + ' 残留分包路径前缀 /subpkg-merchant/');
    assert.ok(!src.includes('<mtab'), rel + ' 残留分包伪底栏 <mtab>');
    if (rel.endsWith('.js')) {
      assert.ok(!tabRe.test(src), rel + ' 独立包不得对系统 tabBar 页调用 redirectTo/navigateTo');
    }
  }
});
