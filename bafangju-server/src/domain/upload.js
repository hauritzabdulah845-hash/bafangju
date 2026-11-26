'use strict';
const bizdate = require('./bizdate');
/**
 * 上传安全域（P0-3）：修复「/api/upload 无任何鉴权，任何人可写服务器磁盘」。
 *
 * 四道防线：
 * ① 真实类型判定：读文件头 magic bytes，不信任客户端 ext 参数（伪造扩展名/伪装文件一律拒收）；
 * ② 不可预测文件名：crypto.randomUUID()，不使用 Date.now()+随机数（可预测、可枚举）；
 * ③ 身份分级：商家 / 用户 / 游客（游客仅可传入驻证照，素材上传必须登录）；
 * ④ 频率限制 + 每日配额：分钟级频控（内存）+ 每日次数/容量配额（落库，重启不重置）。
 *
 * 落盘位置按用途区分：入驻证照落私有目录（不经静态目录公开，仅管理后台可查看）；
 * 商品/广告素材落公开目录（用户端小程序需匿名浏览）。
 */

/** 允许的图片类型：以文件头（magic bytes）判定，不信任客户端传入的 ext */
const IMAGE_TYPES = [
  {
    ext: 'png', mime: 'image/png',
    test: (b) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
      && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  },
  {
    ext: 'jpg', mime: 'image/jpeg',
    test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    ext: 'webp', mime: 'image/webp',
    test: (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP',
  },
];

/** 允许的视频类型：ISO BMFF（MP4 / M4V / MOV），以 ftyp box 判定，不信任扩展名 */
const VIDEO_TYPES = [
  {
    ext: 'mp4', mime: 'video/mp4',
    test: (b) => b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp',
  },
];
const MAX_VIDEO_BYTES = 24 * 1024 * 1024;
const MIN_VIDEO_BYTES = 1024;

/** 视频真实类型判定：返回 { ext, mime } 或 null */
function detectVideoType(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  for (const t of VIDEO_TYPES) {
    if (t.test(buf)) return { ext: t.ext, mime: t.mime };
  }
  return null;
}

/** 解码 base64 视频报文（独立体积上限，防把 32MB 通道用于刷盘） */
function decodeVideoPayload(dataBase64) {
  const raw0 = String(dataBase64 == null ? '' : dataBase64).trim();
  if (!raw0) throw new UploadError('dataBase64 必填');
  let raw = raw0;
  if (raw.startsWith('data:')) {
    const i = raw.indexOf(',');
    if (i < 0) throw new UploadError('视频数据格式非法');
    raw = raw.slice(i + 1);
  }
  raw = raw.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new UploadError('视频数据不是合法的 base64');
  const buf = Buffer.from(raw, 'base64');
  if (buf.length < MIN_VIDEO_BYTES) throw new UploadError('视频内容无效');
  if (buf.length > MAX_VIDEO_BYTES) throw new UploadError('视频不能超过 24MB');
  return buf;
}

/** 单文件大小上下限 */
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MIN_FILE_BYTES = 100;

/**
 * 身份分级配额：perMinute 次/分钟，perDay 次/日，bytesPerDay 字节/日。
 * guest 为游客（仅入驻证照），ip 为同源 IP 总量，global 为全站总量（防止刷盘）。
 */
const LIMITS = {
  merchant: { perMinute: 20, perDay: 200, bytesPerDay: 200 * 1024 * 1024 },
  user: { perMinute: 10, perDay: 50, bytesPerDay: 50 * 1024 * 1024 },
  guest: { perMinute: 5, perDay: 20, bytesPerDay: 60 * 1024 * 1024 },
  ip: { perMinute: 30, perDay: 100, bytesPerDay: 200 * 1024 * 1024 },
  global: { perMinute: 600, perDay: 2000, bytesPerDay: 1024 * 1024 * 1024 },
};

/** 上传用途：entry=入驻证照（私有目录） / material=商品广告素材（公开目录，必须登录） */
const PURPOSE = { ENTRY: 'entry', MATERIAL: 'material' };

/** 带 HTTP 状态码的业务错误 */
class UploadError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'UploadError';
    this.status = status;
  }
}

// ---------- 基础工具 ----------

/** 真实类型判定：返回 { ext, mime } 或 null */
function detectImageType(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  for (const t of IMAGE_TYPES) {
    if (t.test(buf)) return { ext: t.ext, mime: t.mime };
  }
  return null;
}

/** 解码 base64 图片报文：格式校验 + 大小校验，非法数据一律 400 */
function decodeImagePayload(dataBase64) {
  const raw0 = String(dataBase64 == null ? '' : dataBase64).trim();
  if (!raw0) throw new UploadError('dataBase64 必填');
  let raw = raw0;
  if (raw.startsWith('data:')) {
    const i = raw.indexOf(',');
    if (i < 0) throw new UploadError('图片数据格式非法');
    raw = raw.slice(i + 1);
  }
  raw = raw.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new UploadError('图片数据不是合法的 base64');
  const buf = Buffer.from(raw, 'base64');
  if (!buf.length) throw new UploadError('图片内容无效');
  if (buf.length > MAX_FILE_BYTES) throw new UploadError('图片不能超过 4MB');
  if (buf.length < MIN_FILE_BYTES) throw new UploadError('图片内容无效');
  return buf;
}

/** 不可预测文件名（UUID v4），杜绝可枚举/可猜测的上传路径 */
function randomFileName(ext) {
  return `${require('crypto').randomUUID()}.${ext}`;
}

/** 客户端 IP（反向代理场景由 app.set('trust proxy') 解析 XFF） */
function clientIp(req) {
  const raw = String((req && (req.ip || (req.socket && req.socket.remoteAddress))) || '');
  return raw.replace(/^::ffff:/, '') || 'unknown';
}

/** 取 Bearer token（与商家端/管理后台一致，兼容 body.token） */
function bearerToken(req) {
  const h = String((req && req.headers && req.headers.authorization) || '');
  if (h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
  return String(((req && req.body) || {}).token || '').trim();
}

// ---------- 身份分级 ----------

/**
 * 解析上传者身份：商家 > 用户 > 游客。
 * 商家/用户为登录态（商家 token 或用户会话 token），游客仅允许传入驻证照。
 */
function resolveIdentity(req, db) {
  const token = bearerToken(req);
  if (token) {
    const merchant = require('./merchant');
    const m = merchant.merchantByToken(db, token);
    if (m) {
      if (m.status === 'disabled') throw new UploadError('商家已被停用，请联系平台管理员', 403);
      return { tier: 'merchant', id: m.id, actor: `merchant:${m.id}`, label: m.name || m.id, token };
    }
    const userAccount = require('./userAccount');
    const u = userAccount.userByToken(db, token);
    if (u) {
      const risk = require('./risk');
      if (risk.isBlacklisted(db, u.id)) throw new UploadError('账号已被限制使用，如有疑问请通过客服申诉', 403);
      return { tier: 'user', id: u.id, actor: `user:${u.id}`, label: u.id, token };
    }
  }
  const ip = clientIp(req);
  return { tier: 'guest', id: ip, actor: `guest:${ip}`, label: ip, token: '' };
}

/** 配额作用域：主体（身份）+ 同源 IP + 全站，三者任一超限即拒绝 */
function quotaScopes(identity, ip) {
  return [
    { scope: `id:${identity.tier}:${identity.id}`, limits: LIMITS[identity.tier] },
    { scope: `ip:${ip}`, limits: LIMITS.ip },
    { scope: 'global', limits: LIMITS.global },
  ];
}

// ---------- 频率限制（分钟级，内存窗口） ----------

const _minuteBuckets = new Map(); // key -> { start, count }

function assertMinuteRate(key, limit, now = Date.now()) {
  if (!limit || limit <= 0) return;
  let b = _minuteBuckets.get(key);
  if (!b || now - b.start >= 60000) {
    b = { start: now, count: 0 };
    _minuteBuckets.set(key, b);
  }
  b.count += 1;
  if (b.count > limit) throw new UploadError('上传过于频繁，请稍后再试', 429);
  if (_minuteBuckets.size > 5000) {
    for (const [k, v] of _minuteBuckets) {
      if (now - v.start >= 60000) _minuteBuckets.delete(k);
    }
  }
}

/** 清空频率计数（测试用） */
function resetRateLimits() {
  _minuteBuckets.clear();
}

// ---------- 每日配额（落库，跨重启有效） ----------

function today(now = Date.now()) {
  return bizdate.dayOf(now);
}

function quotaRowId(day, scope) {
  return `${day}|${scope}`;
}

/** 校验当日配额（不计数，写盘成功后再 consume） */
function assertDailyQuota(db, scope, limits, bytes, now = Date.now()) {
  const row = db.uploadQuota.get(quotaRowId(today(now), scope));
  const count = row ? Number(row.count || 0) : 0;
  const used = row ? Number(row.bytes || 0) : 0;
  if (count >= limits.perDay) {
    throw new UploadError(`今日上传次数已达上限（${limits.perDay} 次），请明日再试`, 429);
  }
  if (used + bytes > limits.bytesPerDay) {
    throw new UploadError('今日上传容量已达上限，请明日再试', 429);
  }
}

/** 记一次上传用量（次数 + 字节） */
function consumeDailyQuota(db, scope, bytes, now = Date.now()) {
  const day = today(now);
  const id = quotaRowId(day, scope);
  const row = db.uploadQuota.get(id);
  if (row) {
    row.count = Number(row.count || 0) + 1;
    row.bytes = Number(row.bytes || 0) + bytes;
  } else {
    db.uploadQuota.insert({ id, day, scope, count: 1, bytes });
  }
}

/** 清理历史配额计数（每日跑批调用，避免表无限增长） */
function purgeExpiredQuota(db, now = Date.now()) {
  const day = today(now);
  for (const row of db.uploadQuota.all()) {
    if (row.day !== day) db.uploadQuota.delete(row.id);
  }
}

module.exports = {
  IMAGE_TYPES,
  LIMITS,
  PURPOSE,
  MAX_FILE_BYTES,
  MIN_FILE_BYTES,
  UploadError,
  detectImageType,
  decodeImagePayload,
  detectVideoType,
  decodeVideoPayload,
  VIDEO_TYPES,
  MAX_VIDEO_BYTES,
  randomFileName,
  clientIp,
  bearerToken,
  resolveIdentity,
  quotaScopes,
  assertMinuteRate,
  resetRateLimits,
  assertDailyQuota,
  consumeDailyQuota,
  purgeExpiredQuota,
  today,
};
