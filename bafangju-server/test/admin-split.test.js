'use strict';
/**
 * 后台页面拆分（P3-5）回归用例。
 *
 * 背景：admin.html 原为 1903 行的单文件（内联 <style> + 内联 <script>），
 * P3-5 拆分为 3 个 CSS + 13 个 JS 外置文件。此用例锁定拆分后的不变量，防止后续改动破坏：
 * ① admin.html 不再残留内联样式/内联脚本；
 * ② 所有引用的 css/js 文件真实存在；
 * ③ 跨文件顶层声明无重名（否则浏览器直接 SyntaxError 或静默覆盖）；
 * ④ 所有 data-act 与内联 onclick 目标均为顶层 function（事件委托用 window[act] 分发）；
 * ⑤ 按引入顺序拼接的 JS 仍是合法脚本（拆分未破坏语法）；
 * ⑥ CSS 中用到的自定义属性均已在 admin-base.css 定义。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const ADMIN_HTML = path.join(PUBLIC_DIR, 'admin.html');

const html = fs.readFileSync(ADMIN_HTML, 'utf8');

/** admin.html 中引用的 CSS（按出现顺序） */
const cssSrcs = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
/** admin.html 中引用的 JS（按出现顺序） */
const jsSrcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);

/** 读取外置脚本内容 */
const jsCode = jsSrcs.map((src) => fs.readFileSync(path.join(PUBLIC_DIR, src), 'utf8'));

/**
 * 收集顶层声明名。
 * 仅匹配「行首无缩进」的声明，避免把函数体内的局部变量当成顶层声明。
 * @param {string[]} codeList
 */
function collectTopLevel(codeList) {
  const fns = new Map();     // function 声明（会挂到 window）
  const lexicals = new Map(); // const/let/var/class（挂到全局词法环境）
  for (const code of codeList) {
    for (const line of code.split('\n')) {
      let m = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(line);
      if (m) {
        if (!fns.has(m[1])) fns.set(m[1], []);
        fns.get(m[1]).push(line);
        continue;
      }
      m = /^(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/.exec(line);
      if (m) {
        if (!lexicals.has(m[1])) lexicals.set(m[1], []);
        lexicals.get(m[1]).push(line);
      }
    }
  }
  return { fns, lexicals };
}

const { fns: topFns, lexicals: topLexicals } = collectTopLevel(jsCode);

/** 从内联事件属性里取出被调用的标识符（排除关键字与字符串字面量） */
const JS_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'return', 'function', 'typeof', 'new', 'await',
  'this', 'true', 'false', 'null', 'undefined', 'event', 'window', 'document',
]);

function extractHandlerCalls(handler) {
  // 去掉字符串字面量，避免把参数里的文字当成函数名
  const cleaned = handler.replace(/'[^']*'|"[^"]*"/g, '""');
  const out = new Set();
  for (const m of cleaned.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (JS_KEYWORDS.has(m[1])) continue;
    out.add(m[1]);
  }
  return [...out];
}

test('admin.html 不再残留内联样式与内联脚本', () => {
  const inlineStyle = /<style[^>]*>[\s\S]*?<\/style>/.test(html);
  assert.ok(!inlineStyle, 'admin.html 仍存在内联 <style>，应外置到 public/css/');
  // 内联脚本 = 没有 src 属性的 <script>；初始化脚本同样必须外置
  const inlineScript = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/g)];
  assert.strictEqual(inlineScript.length, 0, 'admin.html 仍存在内联 <script>，应外置到 public/js/');
});

test('admin.html 引用了预期的外置 CSS / JS 且文件全部存在', () => {
  assert.ok(cssSrcs.length >= 3, `外置 CSS 数量异常：${cssSrcs.length}`);
  assert.ok(jsSrcs.length >= 13, `外置 JS 数量异常：${jsSrcs.length}`);
  for (const src of [...cssSrcs, ...jsSrcs]) {
    const file = path.join(PUBLIC_DIR, src.replace(/^\/+/, ''));
    assert.ok(fs.existsSync(file), `引用了不存在的文件：${src}`);
  }
  // 引用路径必须是相对路径（express.static 以 public 为根）
  for (const src of [...cssSrcs, ...jsSrcs]) {
    assert.ok(!src.startsWith('/'), `静态资源引用应为相对路径：${src}`);
    assert.ok(!src.includes('..'), `静态资源引用不得越权：${src}`);
  }
});

test('外置 CSS / JS 均在 </body> 前按顺序加载（保持原执行顺序）', () => {
  const lastScript = html.lastIndexOf('js/admin-init.js');
  const bodyEnd = html.lastIndexOf('</body>');
  assert.ok(lastScript > 0 && lastScript < bodyEnd, 'admin-init.js 未在 </body> 前引入');
  const cssPos = cssSrcs.map((s) => html.indexOf(s));
  assert.ok(cssPos.every((p) => p > 0 && p < html.indexOf('</head>')), 'CSS 引用必须位于 </head> 前');
});

test('跨文件顶层声明无重名（避免 SyntaxError / 静默覆盖）', () => {
  const dupFns = [...topFns.entries()].filter(([, list]) => list.length > 1).map(([k]) => k);
  const dupLex = [...topLexicals.entries()].filter(([, list]) => list.length > 1).map(([k]) => k);
  assert.deepStrictEqual(dupFns, [], `顶层 function 重名（后者会静默覆盖前者）：${dupFns.join(', ')}`);
  assert.deepStrictEqual(dupLex, [], `顶层 const/let/var/class 重名（浏览器直接 SyntaxError）：${dupLex.join(', ')}`);
  // function 与 const/let 同名同样是 SyntaxError
  const cross = [...topFns.keys()].filter((k) => topLexicals.has(k));
  assert.deepStrictEqual(cross, [], `顶层 function 与 const/let 同名会抛 SyntaxError：${cross.join(', ')}`);
});

test('所有 data-act 目标均为顶层 function（事件委托经 window[act] 分发）', () => {
  const acts = new Set();
  for (const code of jsCode) {
    for (const m of code.matchAll(/data-act="([A-Za-z_$][\w$]*)"/g)) acts.add(m[1]);
  }
  for (const m of html.matchAll(/data-act="([A-Za-z_$][\w$]*)"/g)) acts.add(m[1]);
  assert.ok(acts.size >= 15, `data-act 目标解析异常：${acts.size}`);
  const missing = [...acts].filter((a) => !topFns.has(a)).sort();
  assert.deepStrictEqual(missing, [], `以下 data-act 目标不是顶层 function，点击将静默失效：${missing.join(', ')}`);
});

test('所有内联 onclick / onchange / onkeydown 目标均为顶层 function', () => {
  const sources = [html, ...jsCode];
  const missing = new Set();
  let total = 0;
  for (const src of sources) {
    for (const m of src.matchAll(/\son(?:click|change|keydown|input|submit)\s*=\s*"([^"]*)"/g)) {
      for (const name of extractHandlerCalls(m[1])) {
        total += 1;
        if (!topFns.has(name)) missing.add(name);
      }
    }
  }
  assert.ok(total >= 40, `内联事件处理器解析异常：${total}`);
  assert.deepStrictEqual([...missing].sort(), [], `以下内联事件目标不是顶层 function：${[...missing].sort().join(', ')}`);
});

test('按引入顺序拼接的 JS 仍是合法脚本（拆分未破坏语法）', () => {
  const joined = jsCode.join('\n');
  assert.doesNotThrow(() => new vm.Script(joined), '外置 JS 拼接后语法非法');
});

test('外置 JS 文件均带中文职责注释头', () => {
  for (const src of jsSrcs) {
    const first = fs.readFileSync(path.join(PUBLIC_DIR, src), 'utf8').split('\n')[0];
    assert.ok(/^\/\/\s*\S/.test(first), `${src} 首行缺少职责注释`);
    assert.ok(/[一-龥]/.test(first), `${src} 首行注释应为中文职责说明`);
  }
});

test('CSS 使用的自定义属性均已在 admin-base.css 定义', () => {
  const cssAll = cssSrcs.map((s) => fs.readFileSync(path.join(PUBLIC_DIR, s), 'utf8')).join('\n');
  const base = fs.readFileSync(path.join(PUBLIC_DIR, cssSrcs[0]), 'utf8');
  const defined = new Set([...base.matchAll(/(--[A-Za-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const used = new Set([...cssAll.matchAll(/var\((--[A-Za-z0-9-]+)/g)].map((m) => m[1]));
  const missing = [...used].filter((v) => !defined.has(v)).sort();
  assert.deepStrictEqual(missing, [], `CSS 引用了未定义的设计变量：${missing.join(', ')}`);
});

test('admin.html 结构精简后仍保留全部功能面板（含广告中心合并与账号权限）', () => {
  const panes = [...html.matchAll(/<div class="pane(?: on)?" id="pane-([A-Za-z]+)">/g)].map((m) => m[1]);
  const expected = ['overview', 'orders', 'catalog', 'merchants', 'adCenter', 'withdraw', 'queue',
    'reserve', 'jobs', 'switches', 'risk', 'messages', 'settings', 'audit', 'users'];
  for (const p of expected) {
    assert.ok(panes.includes(p), `admin.html 缺少功能面板 pane-${p}`);
  }
});
