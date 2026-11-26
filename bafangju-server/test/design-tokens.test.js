'use strict';
/**
 * 两端共享设计令牌（3.13）回归用例。
 * 重点：真源与两端副本必须逐字节一致，且两端 app.wxss 正确 @import 共享层。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const CANONICAL = path.join(ROOT, 'bafangju-design-tokens', 'design-tokens.wxss');
// V4.0 合并后商家端 = 用户端小程序分包 subpkg-merchant（旧独立工程仅留档参考）
const SUBPKG = path.join(ROOT, 'bafangju-miniprogram-user', 'subpkg-merchant');

function read(file) { return fs.readFileSync(file, 'utf8'); }

test('共享令牌真源存在', () => {
  assert.ok(fs.existsSync(CANONICAL), '缺少真源 bafangju-design-tokens/design-tokens.wxss');
});

test('用户端副本与真源逐字节一致（防漂移）；分包不得携带第二份令牌', () => {
  const canonical = fs.readFileSync(CANONICAL);
  const copy = path.join(ROOT, 'bafangju-miniprogram-user', 'design-tokens.wxss');
  assert.ok(fs.existsSync(copy), '用户端缺少 design-tokens.wxss');
  assert.ok(canonical.equals(fs.readFileSync(copy)), '用户端 design-tokens.wxss 与真源不一致，请同步复制');
  // 合并后全局只有一份令牌：主包 app.wxss @import；分包不得再引入或复制
  const SUBPKG_FORBIDDEN = ['design-tokens.wxss'];
  for (const f of SUBPKG_FORBIDDEN) {
    assert.ok(!fs.existsSync(path.join(SUBPKG, f)), '分包不得携带 ' + f + '（令牌唯一真源在主包）');
  }
});

test('用户端 app.wxss 以 @import 引入共享令牌（分包页面全局继承，无需各自引入）', () => {
  const src = read(path.join(ROOT, 'bafangju-miniprogram-user', 'app.wxss'));
  const first = src.split('\n').find((l) => l.trim() && !l.trim().startsWith('/*') && !l.trim().startsWith('*'));
  assert.ok(/@import\s+"design-tokens\.wxss";/.test(first || ''),
    '用户端 app.wxss 未在首行 @import "design-tokens.wxss";：' + (first || '').trim());
  assert.strictEqual((src.match(/@import\s+"design-tokens\.wxss";/g) || []).length, 1,
    '用户端 app.wxss 重复 @import design-tokens.wxss');
  // 分包差异样式不得重复引入令牌
  const base = read(path.join(SUBPKG, 'merchant-base.wxss'));
  assert.ok(!/@import\s+["']design-tokens/.test(base), 'merchant-base.wxss 不得重复引入共享令牌');
  // 分包 16 个页面 wxss 均需引入差异样式，保证迁移后视觉不回退
  const pages = fs.readdirSync(path.join(SUBPKG, 'pages'));
  for (const pg of pages) {
    const wxss = path.join(SUBPKG, 'pages', pg, pg + '.wxss');
    if (!fs.existsSync(wxss)) continue;
    assert.ok(read(wxss).includes("merchant-base.wxss"), '分包页面 ' + pg + ' 未引入 merchant-base.wxss，商家差异样式会丢失');
  }
});

test('共享层不含单端专属组件（阶梯价/进度条应留在用户端）', () => {
  const src = read(CANONICAL);
  for (const onlyUser of ['.ladder', '.progress', '.lc-badge', '.btn-primary', '.btn-ghost']) {
    assert.ok(!src.includes(onlyUser), '共享层不应包含用户端专属选择器：' + onlyUser);
  }
  for (const onlyMerchant of ['.btn-plain', '.btn-mini']) {
    assert.ok(!src.includes(onlyMerchant), '共享层不应包含商家端专属选择器：' + onlyMerchant);
  }
});

test('共享层覆盖两端共用的基础选择器', () => {
  const src = read(CANONICAL);
  const required = ['.t1', '.t2', '.t3', '.t-weak', '.t-accent', '.card', '.row', '.row-between',
    '.divider', '.muted', '.title', '.grad-header', '.price-symbol', '.price-num', '.notice'];
  for (const sel of required) {
    assert.ok(src.includes(sel), '共享层缺少共用选择器：' + sel);
  }
});

test('共享选择器不得被重复定义（唯一真源约束；用户端与分包差异层同守此规）', () => {
  const tokens = read(CANONICAL);
  // 提取共享层定义的选择器（顶层 class / page）
  const shared = new Set();
  for (const line of tokens.split('\n')) {
    const m = line.match(/^\s*(\.[A-Za-z][\w-]*|page)\s*[,{]/);
    if (m) shared.add(m[1]);
  }
  assert.ok(shared.size > 10, '共享层选择器解析异常：' + shared.size);

  // 允许的显式覆写（差异项，需就地覆盖）
  const TARGETS = [
    { name: 'user', file: path.join(ROOT, 'bafangju-miniprogram-user', 'app.wxss'),
      overrides: new Set(['page']) },                                     // 用户端底色 #F7F8FA
    { name: 'merchant-subpkg', file: path.join(SUBPKG, 'merchant-base.wxss'),
      overrides: new Set(['page', '.price-symbol', '.price-num']) },      // 商家底色与金额数字更紧凑
  ];

  for (const t of TARGETS) {
    const css = read(t.file);
    for (const line of css.split('\n')) {
      const m = line.match(/^\s*(\.[A-Za-z][\w-]*|page)\s*[,{]/);
      if (!m) continue;
      const sel = m[1];
      if (!shared.has(sel)) continue;
      assert.ok(t.overrides.has(sel),
        t.name + ' 重复定义了共享选择器 ' + sel + '，应删除或改到共享层');
    }
  }
});

test('品牌色板在共享层中保持唯一真源', () => {
  const src = read(CANONICAL);
  assert.ok(src.includes('#B02A30'), '共享层缺少品牌主色 #B02A30');
  assert.ok(src.includes('#8F1F26'), '共享层缺少文字版品牌红 #8F1F26');
  assert.ok(src.includes('#FAF0F0'), '共享层缺少品牌浅底 #FAF0F0');
});
