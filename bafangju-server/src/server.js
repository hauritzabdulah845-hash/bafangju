'use strict';
/**
 * 八方聚共享平台 API 服务 —— 应用装配根（Composition Root）。
 *
 * 本文件只负责"装配"：中间件 → 存储 → 领域上下文 → 按域注册路由 → 启动监听。
 * 业务路由已按域拆分至 src/routes/*.js（P3-4）：
 *   public.js   公开接口（首页/商品/附近商家/广告/公示）
 *   user.js     用户端（登录/地址/订单/任务/消息/申诉/推广/提现）
 *   payment.js  支付（预下单/模拟支付/微信回调）
 *   upload.js   图片上传（P0-3）
 *   admin.js    管理后台（内含鉴权中间件，先于本域全部路由注册）
 *   merchant.js 商家端（内含鉴权中间件，先于本域全部路由注册）
 *
 * 注册顺序硬约束（Express 按注册顺序匹配，注册在中间件之后的路由会被绕过 = P0-1 根因）：
 *   ① express.json 必须在 /api/payment/notify-wx 之前（原始字节由 verify 钩子捕获）；
 *   ② attachUser 必须在 /api/upload 之前（上传需要解析上传者身份）；
 *   ③ 各域鉴权中间件在各自路由模块内部**第一个**注册。
 *
 * 生产部署：接入微信支付 JSAPI（WX_PAY 订单）、商家转账（提现）、MySQL、定时任务框架；
 * 本服务保持域逻辑与传输层分离，便于合规审计与平滑迁移。
 */
const express = require('express');
const path = require('node:path');
const { createStore } = require('./store');
const { buildContext } = require('./app-context');
const { seed, seedNearbyMerchants } = require('./seed');
const { runMigrations } = require('./migrations');
const createDailyJobs = require('./daily-jobs');

const app = express();
// 反向代理（Nginx）后取真实客户端 IP：TRUST_PROXY=1 时信任 1 层代理转发的 X-Forwarded-For，
// 上传限流按 IP 计量时必须拿到真实来源 IP，否则同一出口 IP 的所有用户会被算成一个人。
app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : false);
// 不暴露框架指纹（降低被针对性扫描的价值）
app.disable('x-powered-by');
// 保留原始报文（微信支付回调验签必须对"原始字节"验签，JSON 解析后重序列化会导致验签失败）
// limit 提到 8MB：/api/upload 接收 base64 图片（4MB 原图 ≈ 5.4MB base64）
// 广告视频上传单独放宽到 40MB（24MB mp4 的 base64 约 32MB，留足 JSON 包头余量）；只对该路径生效，不扩大其余接口的攻击面
app.use(['/api/admin/upload/video', '/api/merchant/upload/video'], express.json({ limit: '40mb' }));
app.use(express.json({
  limit: '8mb',
  verify: (req, res, buf) => { req.rawBody = buf; },
}));
// 上传目录：商品/广告素材（公开，用户端需匿名浏览）；入驻证照（私有，仅管理后台可查看，P0-3）
const UPLOAD_DIR = process.env.BAFANGJU_UPLOAD_DIR || path.join(__dirname, '../data/uploads');
const PRIVATE_UPLOAD_DIR = process.env.BAFANGJU_UPLOAD_PRIVATE_DIR || path.join(__dirname, '../data/uploads-private');
// 静态资源缓存策略（无构建步骤，文件名不带 hash）：
// - HTML 每次都回源校验（ETag），保证发版后立刻生效；
// - CSS/JS 缓存 1 小时 + 回源校验，兼顾首屏与更新时效；
// - 用户上传的图片不变式强（UUID 文件名），可长缓存。
const STATIC_CACHE = {
  setHeaders(res, filePath) {
    if (/\.html?$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    else if (/\.(css|js)$/i.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=3600');
  },
};
app.use(express.static(path.join(__dirname, '../public'), STATIC_CACHE)); // 管理后台静态页 /admin.html
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d', immutable: true })); // 公开素材目录（静态只读）
// 私有证照目录**不挂静态路由**：只能经 /api/admin/uploads/private/:name 鉴权后获取

// 根路径：服务状态页（浏览器访问 / 时给出指引，避免 "Cannot GET /" 困惑）
// 安全：req.get('host') 完全由客户端控制，直接插进 HTML 会造成反射型 XSS（实测 Host: x"><script>... 可执行）。
// 这里只允许 字母/数字/点/横线/冒号/方括号（IPv6），其余一律丢弃，回落到 localhost。
function safeHost(req) {
  const raw = String(req.get('host') || '');
  return /^[A-Za-z0-9.:[\]-]{1,80}$/.test(raw) ? raw : 'localhost';
}
app.get('/', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"><title>八方聚共享平台 · API 服务</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:system-ui,sans-serif;background:#f5f6fa;margin:0;padding:40px 20px;color:#333}
.box{max-width:640px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;box-shadow:0 2px 12px rgba(0,0,0,.08)}
h1{color:#B02A30;font-size:22px;margin:0 0 8px}
.tag{display:inline-block;background:#e8f5e9;color:#2e7d32;border-radius:6px;padding:2px 10px;font-size:13px;margin-bottom:20px}
table{width:100%;border-collapse:collapse;font-size:14px}
td{padding:8px 4px;border-bottom:1px solid #f0f0f0}
a{color:#1565c0;text-decoration:none}
code{background:#f5f5f5;border-radius:4px;padding:1px 6px;font-size:13px}
.note{margin-top:20px;padding:14px;background:#fff8e1;border-radius:8px;font-size:13px;line-height:1.8}
</style></head><body><div class="box">
<h1>八方聚共享平台 · 后端 API 服务</h1>
<div class="tag">● 运行中</div>
<table>
<tr><td>管理后台</td><td><a href="/admin.html">/admin.html</a>（浏览器打开）</td></tr>
<tr><td>用户端小程序</td><td>微信开发者工具导入 <code>bafangju-miniprogram-user</code></td></tr>
<tr><td>商家端小程序</td><td>微信开发者工具导入 <code>bafangju-miniprogram-merchant</code></td></tr>
<tr><td>API 基础地址</td><td><code>${req.protocol}://${safeHost(req)}/api/*</code></td></tr>
</table>
<div class="note">⚠️ 本服务是小程序的后端 API，不是网页商城。<br>
小程序端请在 <b>微信开发者工具</b> 中打开对应目录运行；两个小程序的 <code>config.js</code> 中已配置本服务地址。</div>
</div></body></html>`);
});

// ---------- 存储：默认 SQLite 持久化（重启不丢数据）；BAFANGJU_DB_DRIVER=memory 可切回内存（测试用） ----------
const DRIVER = process.env.BAFANGJU_DB_DRIVER || 'sqlite';
const DB_PATH = process.env.BAFANGJU_DB_PATH || path.join(__dirname, '../data/bafangju.db');
const db = createStore(DRIVER === 'sqlite' ? { sqlitePath: DB_PATH } : {});
seed(db); // 幂等种子：持久化库已有数据时跳过

// ---------- 应用上下文：领域模块 + 会话/鉴权中间件 + 跨域辅助函数 ----------
const ctx = buildContext({ db, UPLOAD_DIR, PRIVATE_UPLOAD_DIR });
// 商家转账真实通道：配置 WX_MCHID/WX_PRIVATE_KEY 等环境变量后自动挂接（未配置保持 mock 行为）
ctx.transfer.attachIfConfigured(db, process.env);

// ---------- 管理后台账号初始化（生产环境缺强口令 → 拒绝启动，不允许带默认口令 admin/admin123 上线） ----------
try {
  ctx.adminAuth.ensureAdminAccount(db, process.env);
} catch (e) {
  console.error('\n[bafangju-server] 启动被拒绝：' + e.message);
  console.error('[bafangju-server] 请配置环境变量 ADMIN_PASSWORD（长度大于 10 位且含字母与数字）后重新启动。\n');
  if (require.main === module) process.exit(1);
  throw e;
}
// ---------- 支付通道守卫：生产环境禁止模拟支付（mock 下 notify 可把订单刷成已支付） ----------
try {
  ctx.pay.assertProductionPayMode(process.env);
} catch (e) {
  console.error('\n[bafangju-server] 启动被拒绝：' + e.message);
  console.error('[bafangju-server] 生产环境必须配置完整微信支付商户材料（WX_MCHID / WX_APPID / WX_MERCHANT_SERIAL / WX_PRIVATE_KEY）。\n');
  if (require.main === module) process.exit(1);
  throw e;
}
// ---------- live 通道就绪自检：缺回调地址/APIv3 密钥/平台证书会「扣款成功但订单不入账」 ----------
// 不阻断启动（避免影响未开通支付的部署），但 /api/payment/prepay 会直接 503，用户无法付款，不会产生资损。
const payReady = ctx.pay.checkLiveReadiness(process.env);
if (!payReady.ok) {
  console.error('\n[bafangju-server] 微信支付通道未就绪：');
  payReady.problems.forEach((p) => console.error('  - ' + p));
  console.error('[bafangju-server] 预下单接口将返回 503；执行 scripts/setup-wxpay-certs.sh 并补齐环境变量后重启即可恢复。\n');
}
ctx.catalog.seedDefaultCategories(db); // 本地生活标准类目幂等播种（含图标）
ctx.ops.seedDefaultOpsSlides(db);      // 首页运营帧首次播种（幂等：已有配置则不覆盖运营改动）
seedNearbyMerchants(db); // 附近商家演示数据（幂等：已播种则跳过）
runMigrations(db, { adminAuth: ctx.adminAuth, audit: ctx.audit }); // 存量数据幂等迁移（补齐缺失字段）

// ---------- 可选登录：解析 Bearer token 挂到 req.user（未登录为 null） ----------
// 必须注册在 /api/upload 之前：上传需要解析上传者身份（商家 > 用户 > 游客）
app.use(ctx.attachUser);

// ---------- 按域注册路由（顺序即优先级） ----------
require('./routes/payment')(app, ctx);
require('./routes/public')(app, ctx);
require('./routes/user')(app, ctx);
require('./routes/upload')(app, ctx);
require('./routes/admin')(app, ctx);   // 内含 /api/admin 鉴权中间件
require('./routes/merchant')(app, ctx); // 内含 /api/merchant 鉴权中间件

// ---------- 统一错误处理（必须在所有路由之后注册）----------
// 踩过的坑：没有这个中间件时，Express 默认错误页会把完整堆栈 + 服务器绝对路径
// （/opt/bafangju/node_modules/...）以 HTML 返回给客户端 —— 既是信息泄露，也让小程序
// 端的 r.json() 解析失败。这里统一改成 JSON，且生产环境不回显堆栈。
app.use((req, res, next) => {
  res.status(404).json({ error: '接口不存在' });
});
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  const isClient = status >= 400 && status < 500;
  if (!isClient) console.error(`[bafangju-server] ${req.method} ${req.originalUrl} 处理失败：`, err && err.stack ? err.stack : err);
  // 4xx 可安全回显原因（如请求体格式错误）；5xx 只给通用文案，避免泄露内部实现
  res.status(status).json({
    error: isClient ? (err.expose !== false && err.message) || '请求有误' : '服务器开小差了，请稍后重试',
  });
});

// ---------- 定时跑批（开发版内置调度；生产替换为 crontab/任务框架） ----------
const { runDailyJobsOnce } = createDailyJobs(ctx);

// 兜底：任何漏网的 Promise 拒绝不应让进程静默崩溃（PM2 会重启，但会丢日志上下文）
process.on('unhandledRejection', (reason) => {
  console.error('[bafangju-server] 未处理的 Promise 拒绝：', reason && reason.stack ? reason.stack : reason);
});

const PORT = process.env.PORT || 3000;
// 监听地址：生产建议 HOST=127.0.0.1（只允许 nginx 反代访问，3000 不暴露到公网）；
// 默认 0.0.0.0 保持本地联调可用（局域网真机调试需要）
const HOST = process.env.HOST || '0.0.0.0';
if (require.main === module) {
  // 每日跑批调度（开发版内置）：仅在直接启动服务时运行，测试导入模块不启动定时器
  const jobsTimer = setInterval(runDailyJobsOnce, 60 * 1000); // 每分钟检查一次，跨日时执行当日跑批
  const server = app.listen(PORT, HOST, () => console.log(`bafangju-server listening on ${HOST}:${PORT}`));

  // 优雅关闭：PM2 stop/reload 先发 SIGINT/SIGTERM，排干进行中请求后再退出。
  // 硬杀兜底 9s 须小于 ecosystem.config.js 的 kill_timeout（10s），否则 PM2 会先 SIGKILL。
  const shutdown = (sig) => {
    console.log(`[bafangju-server] 收到 ${sig}，优雅关闭中（不再接受新连接，等待进行中请求完成）`);
    clearInterval(jobsTimer);
    server.close(() => { console.log('[bafangju-server] 已关闭'); process.exit(0); });
    setTimeout(() => { console.error('[bafangju-server] 优雅关闭超时，强制退出'); process.exit(1); }, 9000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = { app, db };
