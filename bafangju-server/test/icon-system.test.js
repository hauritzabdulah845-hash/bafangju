'use strict';
/**
 * 全系统图标一致性回归测试。
 * 踩过的坑：
 * ① 自定义 tabBar 的 SVG 选中色是亮橙 #FF6A00，文字却是深枣红 #8F1F26；
 *    同时 app.json 降级用的 PNG 是另一套颜色、另一套图形语义（喇叭/金币/台阶 vs 播放器/银行卡/柱状）；
 * ② 页面头部、后台 tab、空态图标混用 emoji，跨平台渲染各异且与红金线性图标语言冲突；
 * ③ SVG 网格 24/32 并存、描边 1.5/1.8/1.9/2 四种。
 * 统一基线：24×24 网格 / stroke-width 1.8 / 未选中 #666666 · 选中 #B02A30 / 功能位禁用 emoji。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '../..');
const USER = path.join(ROOT, 'bafangju-miniprogram-user');
// V4.0 合并后商家端 = 用户端分包 subpkg-merchant，底栏为分包组件 mtab（原 custom-tab-bar 迁移）
const SUBPKG = path.join(USER, 'subpkg-merchant');
const MTAB = path.join(SUBPKG, 'components/mtab/mtab.wxss');
const PUB = path.join(ROOT, 'bafangju-server/public');
const read = (p) => fs.readFileSync(p, 'utf8');
const EMOJI = /[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u;
// 用字符串构造，避开正则字面量里 / 与字符类 / 的双重转义问题
const B64_RE = new RegExp('data:image/svg\\+xml;base64,([A-Za-z0-9+/=]+)', 'g');

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

test('两端自定义底栏（用户端 tabBar / 商家分包 mtab）：颜色与描边统一，且不含旧亮橙', () => {
  for (const [tag, file] of [['用户端', path.join(USER, 'custom-tab-bar/index.wxss')], ['商家分包 mtab', MTAB]]) {
    const src = read(file);
    assert.ok(!src.includes('#FF6A00'), tag + ' 仍残留亮橙选中色');
    const colors = new Set();
    const strokes = new Set();
    const svgs = [...src.matchAll(B64_RE)];
    assert.ok(svgs.length >= 8, tag + ' 导航 SVG 数量异常');
    for (const m of svgs) {
      const svg = Buffer.from(m[1], 'base64').toString('utf8');
      for (const c of svg.match(/#[0-9A-Fa-f]{6}/g) || []) colors.add(c.toUpperCase());
      for (const w of svg.match(/stroke-width='([0-9.]+)'/g) || []) strokes.add(w);
      assert.match(svg, /viewBox='0 0 24 24'/, tag + ' 导航图标必须 24 网格');
    }
    assert.deepEqual([...colors].sort(), ['#666666', '#B02A30'], tag + ' 只允许灰/品牌枣红两态');
    assert.deepEqual([...strokes], ["stroke-width='1.8'"], tag + ' 描边必须统一 1.8');
  }
});

test('共享图标库唯一真源：主包 app.wxss 定义，分包不得另建副本', () => {
  const src = read(path.join(USER, 'app.wxss'));
  assert.match(src, /共享功能图标库（ICON TOKENS）/, '主包缺少共享图标库');
  const names = [...src.matchAll(/\.hi-([a-z]+)\s*\{\s*background-image:/g)].map((m) => m[1]);
  assert.ok(names.length >= 10, '图标数量不足');
  const uris = [...src.matchAll(/\.hi-[a-z]+\s*\{\s*background-image:\s*url\("data:image\/svg\+xml,([^"]+)"\)/g)];
  assert.strictEqual(uris.length, names.length, '图标定义与背景图数量不符');
  for (const m of uris) {
    const svg = decodeURIComponent(m[1]);
    assert.match(svg, /viewBox='0 0 24 24'/, '必须 24 网格');
    assert.match(svg, /stroke-width='1\.8'/, '描边必须 1.8');
    assert.match(svg, /stroke='#FFFFFF'/, '渐变头图标固定白色');
    assert.match(svg, /fill='none'/, '必须线性描边');
  }
  // 合并后分包靠全局 app.wxss 继承图标库，不得出现第二份定义（防漂移防重复）
  const base = read(path.join(SUBPKG, 'merchant-base.wxss'));
  assert.ok(!/\.hi-[a-z]+\s*\{/.test(base), '分包 merchant-base.wxss 不得重复定义图标库');
});

test('小程序功能图标位不再使用 emoji，且引用的图标类都有定义（主包 + 商家分包）', () => {
  for (const [tag, dir] of [['用户端', USER], ['商家分包', SUBPKG]]) {
    const lib = read(path.join(USER, 'app.wxss')); // 图标库唯一真源在主包，分包引用同库校验
    const defined = new Set([...lib.matchAll(/\.hi-([a-z]+)\s*\{/g)].map((m) => m[1]));
    for (const f of walk(dir, ['.wxml'])) {
      const src = read(f);
      const rel = path.relative(dir, f);
      // hero-icon / lp-icon 开标签后的直接文本不得是 emoji
      for (const m of src.matchAll(/<view class="(?:hero-icon|lp-icon)"[^>]*>([^<]{0,20})/g)) {
        assert.ok(!EMOJI.test(m[1]), tag + ' ' + rel + ' 功能图标位仍有 emoji：' + m[1]);
      }
      // 所有 hi-xxx 引用必须在图标库里
      for (const m of src.matchAll(/\bhi-([a-z]+)\b/g)) {
        assert.ok(defined.has(m[1]), tag + ' ' + rel + ' 引用了未定义的图标类 hi-' + m[1]);
      }
    }
  }
});

test('后台商家页 tab 与全站空态图标已改为线性图标', () => {
  const html = read(path.join(PUB, 'merchant.html'));
  assert.ok(!/<div class="tab-ic">[^<]*[\u{1F300}-\u{1FAFF}]/u.test(html), 'tab 仍是 emoji');
  assert.strictEqual((html.match(/class="tab-ic ic-[a-z]+"/g) || []).length, 5, '应有 5 个线性 tab 图标');
  const css = read(path.join(PUB, 'css/merchant.css'));
  assert.match(css, /\.tab\.on \.tab-ic \{ background-color: #B02A30; \}/);
  assert.match(css, /mask-image: url\("data:image\/svg\+xml,/);

  const adminCss = read(path.join(PUB, 'css/admin-components.css'));
  assert.match(adminCss, /\.empty \.e-icon \{[\s\S]*?mask: center \/ contain no-repeat/,
    '空态图标必须用统一 mask 线性图标');
  assert.match(adminCss, /font-size: 0; color: transparent/, '必须隐藏内嵌 emoji 文本');

  const site = read(path.join(PUB, 'site/index.html'));
  assert.ok(!site.includes("c.icon || '🏪'"), '官网类目仍以 emoji 兜底');
  assert.match(site, /FALLBACK_CAT_ICON/);
});

test('旧 /img/icons 类目 PNG 已废弃：种子不写 iconImage，启动幂等清理历史引用', () => {
  const catalog = require('../src/domain/catalog');
  const { createStore } = require('../src/store');
  const db = createStore({});
  const added = catalog.seedDefaultCategories(db);
  assert.ok(added.length >= 12, '标准类目应全部播种');
  for (const c of db.categories.all()) {
    assert.ok(!c.iconImage, c.name + ' 种子不得再写 iconImage');
  }
  // 历史残留：老库种子写入的 /img/icons/* 引用应在启动播种时被清空
  const row = db.categories.all()[0];
  row.iconImage = '/img/icons/icon_1.png';
  catalog.seedDefaultCategories(db);
  assert.strictEqual(row.iconImage, '', '历史 /img/icons 引用应被清理');
  // 运营自己上传的图标不受清理影响
  const keep = db.categories.all()[1];
  keep.iconImage = '/uploads/icon_custom.png';
  catalog.seedDefaultCategories(db);
  assert.strictEqual(keep.iconImage, '/uploads/icon_custom.png', '自传图标不得被误清');

  // 全库（服务端源码与静态页）不得再引用具体 PNG（/img/icons/icon_*）；清理器自身的前缀判断除外
  const serverFiles = walk(PUB, ['.html', '.css', '.js'])
    .concat(walk(path.join(ROOT, 'bafangju-server/src'), ['.js']));
  for (const f of serverFiles) {
    assert.ok(!read(f).includes('/img/icons/icon_'), path.relative(ROOT, f) + ' 仍引用已废弃的 /img/icons/icon_*');
  }
  assert.ok(!fs.existsSync(path.join(PUB, 'img/icons')), '旧 PNG 目录应已删除');
});

test('tabBar PNG 生成脚本与 SVG 同色同语义，且「赚实惠」图标语义正确', () => {
  const gen = read(path.join(ROOT, 'redesign-20261102/tools/gen_tabbar_icons.py'));
  assert.match(gen, /ON = \(176, 42, 48/, 'PNG 选中色必须是 #B02A30');
  assert.match(gen, /OFF = \(102, 102, 102/, 'PNG 普通态必须是 #666666');
  assert.match(gen, /G = OUT \/ 24/, 'PNG 必须按 24 网格生成');
  assert.match(gen, /draw_ads[\s\S]{0,200}购物袋/, '赚实惠图标应为购物袋（不再用喇叭）');
  assert.match(gen, /draw_earn[\s\S]{0,200}银行卡/, '收益图标应与 SVG 同为银行卡');
  assert.match(gen, /draw_returns[\s\S]{0,200}柱/, '阶梯图标应与 SVG 同为柱状');
  // custom-tab-bar 的赚实惠图标必须是购物袋路径
  const tab = read(path.join(USER, 'custom-tab-bar/index.wxss'));
  const svgs = [...tab.matchAll(B64_RE)]
    .map((m) => Buffer.from(m[1], 'base64').toString('utf8'));
  assert.ok(svgs.some((s) => s.includes('M4.6 8.4h14.8')), '导航缺少购物袋图标');
  assert.ok(!svgs.some((s) => s.includes('M10 9.5l5 2.5-5 2.5z')), '旧播放器图标仍在');
});
