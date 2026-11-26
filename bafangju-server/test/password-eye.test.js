'use strict';
/** 密码输入体验专项回归：可见切换（眼睛）+ 改密功能三端齐备
 *  覆盖：小程序商家分包（登录/改密）、H5 商家端（登录/改密）、管理后台（登录）。
 */
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const SUBPKG = path.join(ROOT, 'bafangju-miniprogram-user/subpkg-merchant');
const PUB = path.join(__dirname, '../public');
const read = (p) => fs.readFileSync(p, 'utf8');

test('小程序商家端：登录页密码可见切换', () => {
  const wxml = read(path.join(SUBPKG, 'pages/login/login.wxml'));
  const js = read(path.join(SUBPKG, 'pages/login/login.js'));
  assert.match(wxml, /password="\{\{!showPwd\}\}"/, '登录密码框须绑定 password="{{!showPwd}}"');
  assert.match(wxml, /bindtap="togglePwd"/, '登录页须有眼睛开关');
  assert.match(js, /togglePwd\(\)\s*\{/s, 'js 须实现 togglePwd');
  assert.match(js, /showPwd:\s*false/, '密码默认隐藏');
  // 图标基线：禁用 emoji，用内联 SVG
  assert.ok(!/👁|👀/.test(read(path.join(SUBPKG, 'merchant-base.wxss'))), '眼睛开关不得使用 emoji');
});

test('小程序商家端：改密页三个密码框可见切换，且改密接口闭环', () => {
  const wxml = read(path.join(SUBPKG, 'pages/password/password.wxml'));
  const js = read(path.join(SUBPKG, 'pages/password/password.js'));
  assert.strictEqual((wxml.match(/bindtap="toggleEye"/g) || []).length, 3, '原/新/确认三个框都要有眼睛开关');
  assert.match(wxml, /password="\{\{!showOld\}\}"/, '原密码框须绑定切换');
  assert.match(js, /toggleEye\(/, 'js 须实现 toggleEye（data-k 驱动）');
  assert.match(js, /\/api\/merchant\/change-password/, '改密须走服务端接口');
  assert.match(js, /removeStorageSync\('merchant_token'\)/, '改密成功须清会话强制重登');
});

test('H5 商家端：登录与改密的眼睛开关 + 改密闭环', () => {
  const html = read(path.join(PUB, 'merchant.html'));
  const core = read(path.join(PUB, 'js/merchant-core.js'));
  const pages = read(path.join(PUB, 'js/merchant-pages.js'));
  const css = read(path.join(PUB, 'css/merchant.css'));
  assert.match(html, /togglePassEye\(this\)/, 'H5 登录密码框须有眼睛开关');
  assert.match(core, /function togglePassEye\(/, 'togglePassEye 须为顶层函数（内联 onclick）');
  assert.strictEqual((pages.match(/togglePassEye\(this\)/g) || []).length, 3, '改密子页三个框都要有眼睛开关');
  assert.match(pages, /\/api\/merchant\/change-password/, 'H5 改密须走服务端接口');
  assert.match(css, /\.eye-btn\.on/, '眼睛开/关两态图标须齐全');
});

test('管理后台：登录页密码可见切换', () => {
  const html = read(path.join(PUB, 'admin.html'));
  const core = read(path.join(PUB, 'js/admin-core.js'));
  const css = read(path.join(PUB, 'css/admin-base.css'));
  assert.match(html, /id="loginPass"/, '登录密码框仍在（回车登录逻辑不受影响）');
  assert.match(html, /class="eye-btn"\s+onclick="togglePassEye\(this\)"/, '后台登录页须有眼睛开关');
  assert.match(core, /function togglePassEye\(/, 'admin-core 须定义顶层 togglePassEye');
  assert.match(css, /\.eye-btn\.on/, '后台眼睛两态图标齐全');
  // 回归：#loginMask button 通栏规则会把眼睛按钮拉成整行宽、绝对定位盖死密码框导致无法输入
  assert.match(css, /#loginMask \.eye-btn\s*\{\s*width:\s*36px/, '登录遮罩内眼睛按钮须显式收窄（覆盖通栏 button 规则）');
  assert.match(css, /#loginMask \.pwd-field input\s*\{\s*padding-right:\s*44px/, '登录遮罩内密码框须保留右侧留白（避免文字钻到眼睛图标下）');
});

test('改密入口三端齐备（含首次登录强制引导）', () => {
  // 小程序：我的页菜单 + 首次登录引导
  const profileWxml = read(path.join(SUBPKG, 'pages/profile/profile.wxml'));
  assert.match(profileWxml, /修改密码/, '小程序我的页须有改密入口');
  const loginJs = read(path.join(SUBPKG, 'pages/login/login.js'));
  assert.match(loginJs, /mustChangePassword/, '首次登录（初始密码）须引导改密');
  // H5：我的页子页入口
  const pages = read(path.join(PUB, 'js/merchant-pages.js'));
  assert.match(pages, /openSub\('password'\)/, 'H5 我的页须有改密入口');
});
