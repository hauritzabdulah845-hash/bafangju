'use strict';
/**
 * 小程序生产包信息泄露防护回归（P0-4 修复）：
 * ① 两端 config.js 不得出现内网地址（192.168.x / 10.x / 172.16-31.x / 127.0.0.1 / localhost）；
 * ② 内网地址只允许出现在 config.dev.js，且该文件必须被 project.config.json 的 packOptions.ignore 排除（不进包体）；
 * ③ 用户端网络诊断入口（按钮 + diagnose()）必须被 develop 环境门控，正式版不可见；
 * ④ api.js 的 fail 分支不得把原始 errMsg / BASE_URL 拼进用户可见的 Error；
 * ⑤ 错误态渲染不得透出原始错误文本（loadError 不得作为文案输出）；
 * ⑥ utils/env.js 环境判定行为正确：取不到版本时按 release 处理（默认关闭调试入口）。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const ENDS = [
  { name: 'user', dir: path.join(ROOT, 'bafangju-miniprogram-user') },
  // V4.0 合并后商家端 = 用户端小程序分包 subpkg-merchant（config/api/env 自成一体，须同守防泄露规则）
  { name: 'merchant-subpkg', dir: path.join(ROOT, 'bafangju-miniprogram-user', 'subpkg-merchant'), projectConfig: path.join(ROOT, 'bafangju-miniprogram-user', 'project.config.json'), devConfig: 'subpkg-merchant/config.dev.js' },
];

// 内网地址特征（生产包内禁止出现）
const PRIVATE_IP = /(\b192\.168\.\d{1,3}\.\d{1,3}\b|\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|\b172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b|\b127\.0\.0\.1\b|\blocalhost\b)/i;

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

// 递归列出目录下所有源码文件（排除 node_modules / 隐藏目录）
function listFiles(dir, exts) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) out.push(...listFiles(full, exts));
    else if (exts.some((e) => name.endsWith(e))) out.push(full);
  }
  return out;
}

// ---------- ① / ② 配置与包体隔离 ----------

test('两端 config.js 不含任何内网地址', () => {
  for (const end of ENDS) {
    const src = read(path.join(end.dir, 'config.js'));
    assert.ok(
      !PRIVATE_IP.test(src),
      end.name + ' config.js 出现内网地址：' + (src.match(PRIVATE_IP) || [])[0]
    );
  }
});

test('内网地址仅存在于 config.dev.js', () => {
  for (const end of ENDS) {
    const hits = listFiles(end.dir, ['.js', '.json', '.wxml', '.wxss'])
      .filter((f) => PRIVATE_IP.test(read(f)))
      .map((f) => path.relative(end.dir, f));
    // config.dev.js 允许留空命中（联调期可能填的是公网 IP 而非内网地址）
    assert.ok(
      hits.every((f) => f === 'config.dev.js'),
      end.name + ' 端出现内网地址的文件不止 config.dev.js：' + hits.join(', ')
    );
  }
});

test('config.dev.js 被 packOptions.ignore 排除，不进生产包体', () => {
  for (const end of ENDS) {
    const cfg = JSON.parse(read(path.join(end.projectConfig || path.join(end.dir, 'project.config.json'))));
    const ignore = (cfg.packOptions && cfg.packOptions.ignore) || [];
    const values = ignore.map((x) => (typeof x === 'string' ? x : x.value));
    const devConfig = end.devConfig || 'config.dev.js';
    assert.ok(
      values.includes(devConfig),
      end.name + ' packOptions.ignore 未排除 ' + devConfig
    );
    // 存在本地覆盖文件，确保开发流程可用
    assert.ok(fs.existsSync(path.join(ROOT, 'bafangju-miniprogram-user', devConfig)), end.name + ' 缺少 ' + devConfig);
  }
});

test('config.js 通过 try/catch 加载本地覆盖，正式包缺文件不报错', () => {
  for (const end of ENDS) {
    const src = read(path.join(end.dir, 'config.js'));
    assert.ok(/require\('\.\/config\.dev'\)/.test(src), end.name + ' config.js 未 require config.dev');
    assert.ok(/try\s*\{[\s\S]*require\('\.\/config\.dev'\)[\s\S]*\}\s*catch/.test(src),
      end.name + ' config.js 对 config.dev 的 require 未包在 try/catch 中');
  }
});

// ---------- ③ 调试入口门控 ----------

test('用户端网络诊断入口仅开发环境可见', () => {
  const dir = ENDS[0].dir;
  const wxml = read(path.join(dir, 'pages', 'index', 'index.wxml'));
  const js = read(path.join(dir, 'pages', 'index', 'index.js'));

  // 按钮必须带 develop 门控条件
  const diagLine = wxml.split('\n').find((l) => l.includes('bindtap="diagnose"'));
  assert.ok(diagLine, 'index.wxml 未找到诊断按钮');
  assert.ok(/devMode/.test(diagLine), '诊断按钮未做环境门控：' + diagLine.trim());

  // diagnose() 方法内部必须二次校验环境
  const fn = js.slice(js.indexOf('diagnose()'));
  assert.ok(/if\s*\(!env\.isDev\(\)\)\s*return;/.test(fn),
    'diagnose() 缺少 env.isDev() 守卫，正式版仍可触发');
});

test('正式版诊断弹窗不展示后端地址（仅开发环境）', () => {
  const js = read(path.join(ENDS[0].dir, 'pages', 'index', 'index.js'));
  const fn = js.slice(js.indexOf('diagnose()'), js.indexOf('decorate('));
  // 弹窗内容含 URL / 状态码 / 原始错误 —— 必须整体位于 isDev 守卫之后
  const guard = fn.indexOf('env.isDev()');
  assert.ok(guard >= 0, 'diagnose() 未做环境守卫');
  assert.ok(fn.indexOf('showModal') > guard, 'showModal 出现在环境守卫之前');
});

// ---------- ④ 请求层脱敏 ----------

test('api.js fail 分支不把 errMsg / BASE_URL 抛给用户', () => {
  for (const end of ENDS) {
    const src = read(path.join(end.dir, 'utils', 'api.js'));
    const bad = src.match(/new Error\([^)]*(errMsg|BASE_URL|err\.errMsg)/g) || [];
    assert.deepStrictEqual(bad, [], end.name + ' api.js 存在把底层错误/地址抛给用户的 Error：' + bad.join(' | '));
    // 原始信息必须落到 console 而非 UI
    assert.ok(/console\.error/.test(src), end.name + ' api.js 未把原始错误写入 console');
  }
});

test('服务端业务错误文案仍可透出（不可一刀切脱敏）', () => {
  for (const end of ENDS) {
    const src = read(path.join(end.dir, 'utils', 'api.js'));
    assert.ok(/res\.data\s*&&\s*res\.data\.error/.test(src),
      end.name + ' api.js 未保留服务端业务错误文案');
  }
});

// ---------- ⑤ 错误态渲染 ----------

test('错误态不透出原始错误文本', () => {
  for (const end of ENDS) {
    for (const file of listFiles(end.dir, ['.wxml'])) {
      const rel = path.relative(end.dir, file);
      // 先剔除 wx:if / wx:elif 条件属性（其中引用 loadError 只是状态判断，不构成输出）
      const src = read(file).replace(/\bwx:(?:if|elif)="\{\{[^"]*\}\}"/g, '');
      assert.ok(!/\+\s*loadError/.test(src), rel + ' 把 loadError 拼进了展示文案');
      assert.ok(!/\{\{\s*loadError\s*\}\}/.test(src), rel + ' 直接输出了 loadError 原文');
    }
  }
});

test('网络异常文案统一为用户可读提示', () => {
  for (const end of ENDS) {
    const src = read(path.join(end.dir, 'utils', 'api.js'));
    assert.ok(/网络连接失败，请稍后重试/.test(src), end.name + ' api.js 缺少统一网络错误文案');
  }
});

// ---------- ⑥ 环境判定行为 ----------

function loadEnv(file, { wxImpl, wxConfig } = {}) {
  const ctx = { module: { exports: {} }, console };
  if (wxImpl) ctx.wx = wxImpl;
  if (wxConfig) ctx.__wxConfig = wxConfig;
  vm.createContext(ctx);
  vm.runInContext(read(file), ctx, { filename: file });
  return ctx.module.exports;
}

test('env.js 环境判定：取不到版本时按 release 处理', () => {
  for (const end of ENDS) {
    const file = path.join(end.dir, 'utils', 'env.js');

    const develop = loadEnv(file, {
      wxImpl: { getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' } }) },
    });
    assert.strictEqual(develop.isDev(), true, end.name + ' develop 环境应判定为开发模式');

    const release = loadEnv(file, {
      wxImpl: { getAccountInfoSync: () => ({ miniProgram: { envVersion: 'release' } }) },
    });
    assert.strictEqual(release.isDev(), false, end.name + ' release 环境不应开启调试入口');

    const trial = loadEnv(file, {
      wxImpl: { getAccountInfoSync: () => ({ miniProgram: { envVersion: 'trial' } }) },
    });
    assert.strictEqual(trial.isDev(), false, end.name + ' trial 环境不应开启调试入口');

    // 无 wx / wx 抛错 → 保守按 release
    const none = loadEnv(file, {});
    assert.strictEqual(none.envVersion(), 'release', end.name + ' 无 wx 时应回落 release');
    assert.strictEqual(none.isDev(), false);

    const broken = loadEnv(file, { wxImpl: { getAccountInfoSync: () => { throw new Error('unsupported'); } } });
    assert.strictEqual(broken.envVersion(), 'release', end.name + ' wx 抛错时应回落 release');
  }
});
