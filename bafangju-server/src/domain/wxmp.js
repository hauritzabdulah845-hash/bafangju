/**
 * 微信小程程序配置 + 小程序码生成（推广邀请码用）。
 *
 * 配置来源优先级：管理后台「系统设置 - 小程序码配置」（存 db.switches.wxmp，可在线改）
 *   > 环境变量 WX_APPID / WX_SECRET（部署时注入，作为初始值与兜底）。
 * 未配置时一律降级为 devMode（返回占位信息 + 原因），前端展示占位码并提示去后台配置。
 *
 * 缓存：access_token 内存缓存（有效期 7200s，提前 5 分钟刷新）；
 *       小程序码按 userId 落盘 public/qrcodes/{userId}.png，避免每次请求都打微信接口。
 */
const fs = require('fs');
const path = require('path');
const { audit } = require('../store');

const KEY = 'wxmp';
const QR_DIR = path.join(__dirname, '../../public/qrcodes');

// access_token 内存缓存（进程级）
let tokenCache = { token: '', expireAt: 0, appid: '' };

/** 读取配置：后台配置优先，回退环境变量 */
function getConfig(db) {
  const saved = (db && db.switches && db.switches.get(KEY)) || {};
  const appid = String(saved.appid || process.env.WX_APPID || '').trim();
  const secret = String(saved.secret || process.env.WX_SECRET || '').trim();
  return { appid, secret, source: saved.appid ? 'db' : (process.env.WX_APPID ? 'env' : 'none') };
}

/**
 * 【已废弃】商家端独立小程序配置通道。
 * V4.0 单小程序双角色合并后，商家工作台运行在用户端小程序内（同一 AppID），
 * code2session 统一走 getConfig()；本函数仅保留移除记录，防止旧部署残留 WX_MERCHANT_* 误用。
 */

/** 给后台展示用：AppSecret 只回传掩码，不回明文 */
function mask(cfg) {
  return {
    appid: cfg.appid,
    secretMasked: cfg.secret ? cfg.secret.slice(0, 4) + '****' + cfg.secret.slice(-4) : '',
    configured: !!(cfg.appid && cfg.secret),
    source: cfg.source,
  };
}

/** 保存配置（管理员操作，留审计；清空 token 与已生成的小程序码缓存） */
function saveConfig(db, { appid, secret, operator = 'admin' }) {
  const prev = getConfig(db);
  const next = {
    appid: String(appid || '').trim(),
    // 允许传掩码占位（后台回显后原样提交）表示不修改
    secret: String(secret || '').includes('****') ? String(prev.secret || '') : String(secret || '').trim(),
    updatedAt: new Date().toISOString(),
  };
  db.switches.set(KEY, next);
  tokenCache = { token: '', expireAt: 0, appid: '' }; // 换 appid/secret 后旧 token 立即失效
  clearQrCache();
  audit(db, operator, 'wxmp.config_save', { appid: next.appid, changed: prev.appid !== next.appid || prev.secret !== next.secret });
  return mask(getConfig(db));
}

/** 清空已落盘的小程序码（配置变更后旧码的 scene 仍有效，但页面/主体可能变，统一重建） */
function clearQrCache() {
  try {
    if (!fs.existsSync(QR_DIR)) return;
    for (const f of fs.readdirSync(QR_DIR)) {
      if (f.endsWith('.png')) fs.unlinkSync(path.join(QR_DIR, f));
    }
  } catch (e) { /* 清理失败不影响主流程 */ }
}

/** 获取（带缓存的）access_token */
async function getAccessToken(cfg, fetchImpl = globalThis.fetch) {
  const now = Date.now();
  if (tokenCache.token && tokenCache.expireAt > now && tokenCache.appid === cfg.appid) return tokenCache.token;
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(cfg.appid)}&secret=${encodeURIComponent(cfg.secret)}`;
  const res = await fetchImpl(url);
  const data = await res.json();
  if (!data.access_token) {
    throw new Error('获取 access_token 失败：' + (data.errmsg || data.errcode || 'unknown'));
  }
  tokenCache = {
    token: data.access_token,
    expireAt: now + Math.max(60, (Number(data.expires_in) || 7200) - 300) * 1000,
    appid: cfg.appid,
  };
  return tokenCache.token;
}

/**
 * 生成用户专属小程序码（getwxacodeunlimit，无数量限制）。
 * scene = userId（≤32 字符），page = pages/index/index，进入后 index 读取 inviter 绑定直推关系。
 * @returns {{devMode:boolean, url?:string, base64?:string, scene:string, reason?:string, path?:string}}
 */
async function getQrcode(db, { userId, appid, secret, fetchImpl = globalThis.fetch, force = false }) {
  const scene = String(userId);
  const cfg = { appid: appid || getConfig(db).appid, secret: secret || getConfig(db).secret };
  const fallbackPath = `pages/index/index?inviter=${scene}`;

  if (!cfg.appid || !cfg.secret) {
    return { devMode: true, path: fallbackPath, scene, reason: '未配置 AppID / AppSecret，请在管理后台「系统设置 → 小程序码配置」填写' };
  }

  // 已生成过直接复用（配置变更时 clearQrCache 会清掉）
  try {
    fs.mkdirSync(QR_DIR, { recursive: true });
  } catch (e) { /* 只读文件系统时退化为不落盘 */ }
  const file = path.join(QR_DIR, `${scene}.png`);
  if (!force && fs.existsSync(file)) {
    const buf = fs.readFileSync(file);
    return { devMode: false, url: `/qrcodes/${scene}.png`, base64: buf.toString('base64'), scene, cached: true };
  }

  let buf;
  try {
    const token = await getAccessToken(cfg, fetchImpl);
    const res = await fetchImpl(
      `https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=${encodeURIComponent(token)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // check_path=false：页面未发布也能出码（上线前联调）；width 大一些便于保存到相册后识别
        body: JSON.stringify({ scene, page: 'pages/index/index', check_path: false, width: 430 }),
      }
    );
    buf = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    // 网络异常 / token 接口报错：降级为占位码，并把原因回传前端（不给用户看裸堆栈）
    return { devMode: true, path: fallbackPath, scene, reason: '小程序码生成失败：' + e.message };
  }
  if (buf.length < 1000 || buf[0] !== 0xff) {
    // 微信返回的是 JSON 错误体而非图片
    let msg = buf.toString('utf8').slice(0, 160);
    try { msg = JSON.parse(msg).errmsg || msg; } catch (e) { /* 非 JSON 原样透出 */ }
    return { devMode: true, path: fallbackPath, scene, reason: '小程序码生成失败：' + msg };
  }

  try { fs.writeFileSync(file, buf); } catch (e) { /* 落盘失败仍可用 base64 渲染 */ }
  return { devMode: false, url: `/qrcodes/${scene}.png`, base64: buf.toString('base64'), scene, cached: false };
}

module.exports = { KEY, QR_DIR, getConfig, mask, saveConfig, getQrcode, clearQrCache, getAccessToken };
