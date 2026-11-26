'use strict';
/**
 * UI / 安全回归（2026-11 全面复查后固化）—— 防止以下已修问题回潮：
 *
 * ① 根状态页把 Host 头原样插进 HTML（实测 `Host: x"><script>alert(1)</script>` 可执行）→ 反射型 XSS
 * ② 缺统一错误处理：畸形 JSON 返回 Express 默认 HTML 错误页，泄露完整堆栈与服务器绝对路径
 * ③ 后台「储备金账户 / 功能开关」两个面板没有加载函数，点进去只见空白卡片
 * ④ 官网类目区把类目名 / 图标地址直接拼 innerHTML（存储型 XSS）+ 未限制伪协议
 * ⑤ 全站无 favicon（每页都产生一条 404）；静态资源无缓存策略
 * ⑥ 后台搜索框在 14 个页面里可输入但毫无反应（用户会误以为卡死）
 * ⑦ 图片 404 时显示浏览器破图图标，而非占位块
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUB = path.join(__dirname, '../public');
const SRC = path.join(__dirname, '../src');
const read = (p) => fs.readFileSync(p, 'utf8');

test('根状态页：Host 头必须经白名单过滤后再插入 HTML（防反射型 XSS）', () => {
  const src = read(path.join(SRC, 'server.js'));
  assert.match(src, /function safeHost\(req\)/, '缺少 safeHost 过滤函数');
  // 状态页里不得再出现裸的 req.get('host')
  const rootBlock = src.slice(src.indexOf("app.get('/'"), src.indexOf('// ---------- 存储'));
  assert.ok(!/req\.get\('host'\)/.test(rootBlock), "状态页仍直接使用 req.get('host')");
  assert.match(rootBlock, /safeHost\(req\)/, '状态页应使用 safeHost(req)');
  // 过滤规则本身要拒绝引号与尖括号
  const re = /\^\[A-Za-z0-9\.:\[\\\]-\]\{1,80\}\$/;
  assert.ok(re.test(src), 'safeHost 正则应只允许字母数字与 . : [ ] -');
});

test('服务端：必须注册统一错误处理（JSON、生产不回显堆栈、隐藏 X-Powered-By）', () => {
  const src = read(path.join(SRC, 'server.js'));
  assert.match(src, /app\.disable\('x-powered-by'\)/, '应关闭 X-Powered-By');
  assert.match(src, /app\.use\(\(err, req, res, next\)/, '缺少统一错误处理中间件');
  assert.match(src, /res\.status\(404\)\.json\(\{ error: '接口不存在' \}\)/, '未知接口应返回 JSON 404');
  assert.match(src, /服务器开小差了/, '5xx 应给通用文案，避免泄露内部实现');
  // 404/错误中间件必须注册在所有业务路由之后
  const lastRoute = src.lastIndexOf("require('./routes/merchant')(app, ctx)");
  const errMw = src.indexOf('app.use((err, req, res, next)');
  assert.ok(errMw > lastRoute, '错误处理中间件必须在路由注册之后');
});

test('后台：每个侧栏面板都要有加载函数（储备金 / 功能开关曾整块空白）', () => {
  const html = read(path.join(PUB, 'admin.html'));
  const core = read(path.join(PUB, 'js/admin-core.js'));
  const panes = [...html.matchAll(/data-pane="([A-Za-z]+)"/g)].map((m) => m[1]);
  assert.ok(panes.length >= 16, '侧栏菜单数量异常');
  const mapBlock = core.slice(core.indexOf('const L = {'), core.indexOf('}[curPane];'));
  for (const pane of panes) {
    assert.match(mapBlock, new RegExp(`${pane}\\s*:`), `面板「${pane}」缺少加载函数，点开会是空白页`);
  }
  // 承载加载函数的两个业务页必须有实现
  const queue = read(path.join(PUB, 'js/admin-queue.js'));
  const gov = read(path.join(PUB, 'js/admin-governance.js'));
  assert.match(queue, /async function loadReserve\(\)/, '缺少 loadReserve');
  assert.match(gov, /async function loadSwitches\(/, '缺少 loadSwitches');
});

test('后台：储备金面板提供余额与流水查询接口', () => {
  const admin = read(path.join(SRC, 'routes/admin.js'));
  assert.match(admin, /app\.get\('\/api\/admin\/reserve'/, '缺少 GET /api/admin/reserve');
  assert.match(admin, /reserveBalanceFen\(db\)/, '应返回储备金余额');
  const html = read(path.join(PUB, 'admin.html'));
  assert.match(html, /id="reserveFlows"/, '储备金面板缺少流水表');
});

test('官网类目区：类目名与图标地址必须转义，且禁止伪协议 / 目录穿越', () => {
  const site = read(path.join(PUB, 'site/index.html'));
  assert.match(site, /const esc = \(v\) =>/, '缺少转义函数');
  assert.match(site, /const safeSrc = \(u\) =>/, '缺少图标地址白名单');
  assert.match(site, /!v\.includes\('\.\.'\)/, '图标地址应拒绝目录穿越');
  // 拼接处必须用转义后的变量
  const grid = site.slice(site.indexOf("document.getElementById('catGrid').innerHTML"), site.indexOf("}).catch(() => {})"));
  assert.ok(!/\$\{c\.name\}/.test(grid), '类目名仍直接拼接未转义');
  assert.ok(!/src="\$\{c\.iconImage\}"/.test(grid), '图标地址仍直接拼接未转义');
  assert.match(grid, /\$\{name\}/, '类目名应使用转义后的变量');
});

test('服务端：类目名与商品图路径有字符 / 长度 / 穿越约束', () => {
  const catalog = read(path.join(SRC, 'domain/catalog.js'));
  assert.match(catalog, /类目名称不超过 12 字/, '类目名应有长度上限');
  assert.match(catalog, /不能包含尖括号或控制字符/, '类目名应拒绝尖括号/控制字符');
  assert.match(catalog, /imageUrl 不允许包含 \.\./, '商品图应拒绝目录穿越');
});

test('静态资源：三端页面都有 favicon，且 HTML 不缓存 / 资源短缓存', () => {
  for (const f of ['admin.html', 'merchant.html', 'site/index.html']) {
    assert.match(read(path.join(PUB, f)), /href="\/favicon-32\.png"/, f + ' 缺少 favicon 引用');
  }
  for (const f of ['favicon-32.png', 'apple-touch-icon.png']) {
    const buf = fs.readFileSync(path.join(PUB, f));
    assert.strictEqual(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', f + ' 不是有效 PNG');
  }
  const src = read(path.join(SRC, 'server.js'));
  assert.match(src, /STATIC_CACHE/, '缺少静态资源缓存策略');
  assert.match(src, /no-cache/, 'HTML 应 no-cache（发版立即生效）');
});

test('后台搜索：非订单/商品页应禁用输入并说明范围（避免"输了没反应"）', () => {
  const core = read(path.join(PUB, 'js/admin-core.js'));
  assert.match(core, /function syncSearchState\(\)/, '缺少搜索可用性同步');
  assert.match(core, /box\.disabled = !label/, '不支持的页面应禁用搜索框');
  assert.match(core, /仅订单 \/ 商品页可用/, '应说明搜索覆盖范围');
  assert.match(core, /没有匹配「\$\{kw\}」的订单/, '搜索无结果时应给出反馈');
});

test('图片兜底：商家 H5 的商品图 / 封面图 404 时替换为占位块', () => {
  const core = read(path.join(PUB, 'js/merchant-core.js'));
  assert.match(core, /function imgFallback\(/, '缺少 imgFallback');
  const pages = read(path.join(PUB, 'js/merchant-pages.js'));
  const imgs = [...pages.matchAll(/<img /g)].length;
  const fallbacks = [...pages.matchAll(/onerror="imgFallback\(/g)].length;
  assert.strictEqual(imgs, fallbacks, `merchant-pages.js 有 ${imgs} 个 img，仅 ${fallbacks} 个有兜底`);
});

test('可访问性：后台与商家 H5 都提供键盘焦点环与减弱动效支持', () => {
  for (const f of ['css/admin-components.css', 'css/merchant.css']) {
    const css = read(path.join(PUB, f));
    assert.match(css, /:focus-visible/, f + ' 缺少 :focus-visible 焦点环');
    assert.match(css, /prefers-reduced-motion/, f + ' 未适配 prefers-reduced-motion');
  }
});

test('部署脚本：nginx 模板开启 gzip（后台首屏 60KB HTML + 20 个资源）', () => {
  const sh = read(path.join(__dirname, '../scripts/deploy.sh'));
  const gzips = [...sh.matchAll(/^\s+gzip on;$/gm)].length;
  assert.strictEqual(gzips, 2, 'HTTP 与 HTTPS 两个 server 块都应开启 gzip');
  assert.match(sh, /gzip_types text\/plain text\/css application\/javascript/, 'gzip_types 应覆盖 CSS/JS');
});
