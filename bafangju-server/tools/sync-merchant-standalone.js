'use strict';
/**
 * 商家端小程序单源同步器（Single Source of Truth -> Standalone Package）
 *
 * 背景：
 *   V4.0 起 `bafangju-miniprogram-user/subpkg-merchant/` 为商家端唯一活跃维护真源；
 *   独立工程 `bafangju-miniprogram-merchant/` 保留供未来独立 AppID 编译发布使用。
 *   为彻底消除手工双份维护与代码漂移，所有商家端改动只在 `subpkg-merchant` 中开发，
 *   随后执行 `npm run sync:merchant` 自动转换并同步至独立工程。
 *
 * 用法：
 *   node tools/sync-merchant-standalone.js          # 同步写入独立包
 *   node tools/sync-merchant-standalone.js --check  # 只读校验（漂移时退出码 1，供 CI/单测使用）
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const TOKENS_SRC = path.join(ROOT, 'bafangju-design-tokens/design-tokens.wxss');
const USER_DIR = path.join(ROOT, 'bafangju-miniprogram-user');
const SUBPKG_DIR = path.join(USER_DIR, 'subpkg-merchant');
const STANDALONE_DIR = path.join(ROOT, 'bafangju-miniprogram-merchant');

/** 独立商家端 app.json 中注册为系统 tabBar 的 4 个页面 */
const TABBAR_HUBS = ['index', 'verify', 'earnings', 'profile'];
const TABBAR_URL_RE = new RegExp(
  `wx\\.redirectTo\\(\\{\\s*url:\\s*(['"])\\/pages\\/(${TABBAR_HUBS.join('|')})\\/\\2\\1\\s*\\}\\)`,
  'g'
);

function walkRel(baseDir, curDir = baseDir) {
  const out = [];
  for (const ent of fs.readdirSync(curDir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
    const full = path.join(curDir, ent.name);
    if (ent.isDirectory()) out.push(...walkRel(baseDir, full));
    else out.push(path.relative(baseDir, full).replace(/\\/g, '/'));
  }
  return out.sort();
}

/** 从用户端主包 app.wxss 提取共享线性图标库（.hi / .hi-*） */
function extractIconTokensWxss() {
  const userAppWxss = fs.readFileSync(path.join(USER_DIR, 'app.wxss'), 'utf8');
  const marker = '/* ============================================================\n   共享功能图标库（ICON TOKENS）';
  const idx = userAppWxss.indexOf(marker);
  if (idx < 0) throw new Error('未在 bafangju-miniprogram-user/app.wxss 中找到共享功能图标库段落');
  return userAppWxss.slice(idx).trimEnd() + '\n';
}

/** 合成独立包全局 app.wxss = @import design-tokens + merchant-base 差异层 + 共享图标库 */
function buildStandaloneAppWxss() {
  let base = fs.readFileSync(path.join(SUBPKG_DIR, 'merchant-base.wxss'), 'utf8');
  // 去掉分包顶部「不再引入 design-tokens」的专属说明行
  base = base.replace(/^\/\*[^\n]*design-tokens[^\n]*\*\/\s*\n+/, '');
  // 去掉 merchant-base 中空的共享图标库占位注释块（由主包完整图标库块替代）
  base = base.replace(
    /\/\* =+\s*\n\s*共享功能图标库（ICON TOKENS）[\s\S]*?\*\/\s*\n*/,
    ''
  );
  const icons = extractIconTokensWxss();
  return `@import "design-tokens.wxss";\n\n${base.trimEnd()}\n\n${icons}`;
}

function transformJs(src) {
  let out = src.replace(/\/subpkg-merchant\/pages\//g, '/pages/');
  // 独立包中 4 个主页面是原生系统 tabBar 页，微信禁止对其调用 redirectTo，必须转为 switchTab
  out = out.replace(TABBAR_URL_RE, 'wx.switchTab({ url: $1/pages/$2/$2$1 })');
  out = out.replace(
    /[ \t]*\/\/ 分包页非 tabBar 页[^\n]*\n([ \t]*)switchTab\(e\)\s*\{\s*wx\.redirectTo\(\{\s*url:\s*e\.currentTarget\.dataset\.url\s*\}\);\s*\}/,
    '$1switchTab(e) { wx.switchTab({ url: e.currentTarget.dataset.url }); }'
  );
  return out;
}

function transformWxml(src) {
  let out = src.replace(/\/subpkg-merchant\/pages\//g, '/pages/');
  // 移除分包伪底栏注释与 <mtab .../> 组件挂载
  out = out.replace(/\n*<!--\s*商家工作台底栏[^>]*-->\s*\n*<mtab\b[^>]*\/\s*>\s*$/m, '\n');
  out = out.replace(/\n*<mtab\b[^>]*\/\s*>\s*$/m, '\n');
  return out.endsWith('\n') ? out : out + '\n';
}

function transformWxss(src) {
  let out = src.replace(/^@import\s+['"]\.\.\/\.\.\/merchant-base\.wxss['"];\s*\n+/, '');
  return out;
}

function transformPageJson(src) {
  const obj = JSON.parse(src);
  if (obj.usingComponents && obj.usingComponents.mtab) {
    delete obj.usingComponents.mtab;
    if (Object.keys(obj.usingComponents).length === 0) {
      delete obj.usingComponents;
    }
  }
  return JSON.stringify(obj, null, 2) + '\n';
}

function buildStandaloneAppJson() {
  const userApp = JSON.parse(fs.readFileSync(path.join(USER_DIR, 'app.json'), 'utf8'));
  const sub = (userApp.subPackages || []).find((s) => s.root === 'subpkg-merchant');
  if (!sub || !Array.isArray(sub.pages)) throw new Error('未在用户端 app.json 中找到 subpkg-merchant 分包配置');
  const standaloneApp = JSON.parse(fs.readFileSync(path.join(STANDALONE_DIR, 'app.json'), 'utf8'));
  standaloneApp.pages = [...sub.pages];
  return JSON.stringify(standaloneApp, null, 2) + '\n';
}

/** 计算独立包所有受同步器托管的文件目标内容（relPath -> string/Buffer） */
function computeExpectedFiles() {
  const expected = new Map();

  // 1. 顶层共享令牌、全局样式、底栏样式、页面注册表
  expected.set('design-tokens.wxss', fs.readFileSync(TOKENS_SRC, 'utf8'));
  expected.set('app.wxss', buildStandaloneAppWxss());
  expected.set(
    'custom-tab-bar/index.wxss',
    fs.readFileSync(path.join(SUBPKG_DIR, 'components/mtab/mtab.wxss'), 'utf8')
  );
  expected.set('app.json', buildStandaloneAppJson());

  // 2. 分包内 config.js、utils/*、pages/* 转换映射
  for (const rel of walkRel(SUBPKG_DIR)) {
    if (rel === 'config.dev.js') continue; // 本地开发覆盖文件各自独立
    if (rel === 'merchant-base.wxss') continue; // 已合并入独立包 app.wxss
    if (rel.startsWith('components/mtab/')) continue; // 分包伪底栏仅分包使用

    const raw = fs.readFileSync(path.join(SUBPKG_DIR, rel), 'utf8');
    let transformed = raw;
    if (rel.endsWith('.js')) transformed = transformJs(raw);
    else if (rel.endsWith('.wxml')) transformed = transformWxml(raw);
    else if (rel.endsWith('.wxss')) transformed = transformWxss(raw);
    else if (rel.startsWith('pages/') && rel.endsWith('.json')) transformed = transformPageJson(raw);

    expected.set(rel, transformed);
  }
  return expected;
}

/** 对比当前磁盘上的独立包与真源派生结果，返回漂移项清单 */
function checkSync() {
  const expected = computeExpectedFiles();
  const drifts = [];

  for (const [rel, content] of expected.entries()) {
    const target = path.join(STANDALONE_DIR, rel);
    if (!fs.existsSync(target)) {
      drifts.push({ file: rel, reason: 'missing' });
      continue;
    }
    const actual = fs.readFileSync(target, 'utf8');
    if (actual !== content) {
      drifts.push({ file: rel, reason: 'modified' });
    }
  }

  // 检查独立包 pages/ 或 utils/ 中是否有分包已删除的孤儿文件
  for (const subDir of ['pages', 'utils']) {
    const absSub = path.join(STANDALONE_DIR, subDir);
    if (!fs.existsSync(absSub)) continue;
    for (const relInSub of walkRel(absSub)) {
      const rel = `${subDir}/${relInSub}`;
      if (!expected.has(rel)) {
        drifts.push({ file: rel, reason: 'extra_orphan' });
      }
    }
  }

  return { ok: drifts.length === 0, drifts, managedCount: expected.size };
}

/** 执行同步写入，将分包真源全量派生至独立包 */
function runSync() {
  const expected = computeExpectedFiles();
  let updated = 0;
  let removed = 0;

  for (const [rel, content] of expected.entries()) {
    const target = path.join(STANDALONE_DIR, rel);
    const prev = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    if (prev !== content) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
      updated += 1;
    }
  }

  for (const subDir of ['pages', 'utils']) {
    const absSub = path.join(STANDALONE_DIR, subDir);
    if (!fs.existsSync(absSub)) continue;
    for (const relInSub of walkRel(absSub)) {
      const rel = `${subDir}/${relInSub}`;
      if (!expected.has(rel)) {
        fs.unlinkSync(path.join(STANDALONE_DIR, rel));
        removed += 1;
      }
    }
  }

  return { managedCount: expected.size, updated, removed };
}

if (require.main === module) {
  const checkOnly = process.argv.slice(2).includes('--check');
  if (checkOnly) {
    const res = checkSync();
    if (res.ok) {
      console.log(`[sync:merchant] OK — ${res.managedCount} 个受管文件与 subpkg-merchant 真源完全一致`);
      process.exit(0);
    }
    console.error(`[sync:merchant] 发现 ${res.drifts.length} 个文件与 subpkg-merchant 真源不一致：`);
    for (const d of res.drifts) console.error(`  - ${d.file} (${d.reason})`);
    console.error('请执行: cd bafangju-server && npm run sync:merchant');
    process.exit(1);
  } else {
    const res = runSync();
    console.log(`[sync:merchant] 同步完成：受管 ${res.managedCount} 个文件，更新 ${res.updated} 个，清理孤儿 ${res.removed} 个`);
  }
}

module.exports = { computeExpectedFiles, checkSync, runSync, TABBAR_HUBS };
