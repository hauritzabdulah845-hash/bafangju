'use strict';
/**
 * 管理后台登录限流：进程内滑动窗口，双维度（IP + 账号）。
 *
 * 设计要点（经验 1115753 教训反哺）：
 * - key 必须同时包含 IP 和 username，不能只按 IP 锁——否则同出口多管理员互相牵连；
 * - 429 只是拒绝本次请求，不触及 adminSessions/token，避免"限流→强制登出"连锁；
 * - 错误信息与账号/口令错误保持"统一文案"，防止被用来探测账号是否存在。
 *
 * 部署提示：状态只存在内存中，进程重启即清零；PM2 cluster 多实例之间不共享。
 * 管理后台 QPS 极低，生产建议单实例（或配 sticky session + 换 Redis 版本）。
 */

const LIMITS = {
  // 单 IP：10 次/10 分钟 → 锁 15 分钟
  perIp: { max: 10, windowMs: 10 * 60_000, lockMs: 15 * 60_000 },
  // 单账号：5 次/10 分钟 → 锁 30 分钟（账号维度锁得更久，打击枚举）
  perAccount: { max: 5, windowMs: 10 * 60_000, lockMs: 30 * 60_000 },
  // 兜底：单 IP 全部请求（成功+失败）30 次/分钟
  globalPerIp: { max: 30, windowMs: 60_000 },
};

/** @param {Map} map  @param {number} now */
function _prune(map, now) {
  for (const [k, v] of map) {
    if (v.lockedUntil && v.lockedUntil > now) continue;   // 锁定期间保留，过期才删
    if (v.resetAt <= now) map.delete(k);
  }
}
const ipFail = new Map();    // key=ip,  登录失败计数 + 锁定时间
const accFail = new Map();   // key=username.toLowerCase()
const ipGlobal = new Map();  // key=ip,  所有登录尝试（含成功）的窗口计数
setInterval(() => {
  const n = Date.now();
  _prune(ipFail, n); _prune(accFail, n); _prune(ipGlobal, n);
}, 60_000).unref();

function _hit(map, key, cfg, now) {
  const rec = map.get(key) || { count: 0, resetAt: now + cfg.windowMs };
  if (now > rec.resetAt) { rec.count = 0; rec.resetAt = now + cfg.windowMs; }
  rec.count += 1;
  map.set(key, rec);
  return rec;
}

/** 返回剩余锁定秒数，未锁返回 null */
function _lockRemainSec(map, key, now) {
  const rec = map.get(key);
  if (!rec || !rec.lockedUntil) return null;
  if (rec.lockedUntil <= now) { map.delete(key); return null; }
  return Math.ceil((rec.lockedUntil - now) / 1000);
}

/** 登录前调用：返回 null 表示放行；否则返回 { retryAfterSec, reason } */
function checkAllowed({ ip, username }) {
  const now = Date.now();
  const normUser = String(username || '').trim().toLowerCase();

  // 1) 全局限速：30 次/分钟/IP（成功+失败都计数，防止高速打）
  const g = _hit(ipGlobal, ip, LIMITS.globalPerIp, now);
  if (g.count > LIMITS.globalPerIp.max) {
    return { retryAfterSec: Math.max(1, Math.ceil((g.resetAt - now) / 1000)), reason: 'global' };
  }

  // 2) IP / 账号是否处于锁定期
  const ipLock = _lockRemainSec(ipFail, ip, now);
  if (ipLock) return { retryAfterSec: ipLock, reason: 'ip' };
  const accLock = _lockRemainSec(accFail, normUser, now);
  if (accLock) return { retryAfterSec: accLock, reason: 'account' };

  return null;
}

/** 登录失败：累加窗口计数，超限即进入锁定期 */
function recordFailure({ ip, username }) {
  const now = Date.now();
  const normUser = String(username || '').trim().toLowerCase();

  const r1 = _hit(ipFail, ip, LIMITS.perIp, now);
  if (r1.count >= LIMITS.perIp.max) r1.lockedUntil = now + LIMITS.perIp.lockMs;

  const r2 = _hit(accFail, normUser, LIMITS.perAccount, now);
  if (r2.count >= LIMITS.perAccount.max) r2.lockedUntil = now + LIMITS.perAccount.lockMs;

  return { ipLocked: !!r1.lockedUntil, accountLocked: !!r2.lockedUntil };
}

/** 登录成功：清零该 IP + 账号的失败计数（不影响全局限速窗口计数） */
function recordSuccess({ ip, username }) {
  const normUser = String(username || '').trim().toLowerCase();
  ipFail.delete(ip);
  accFail.delete(normUser);
}

/** 测试/运维钩子：清空所有状态 */
function _reset() { ipFail.clear(); accFail.clear(); ipGlobal.clear(); }

module.exports = { checkAllowed, recordFailure, recordSuccess, _reset, LIMITS };
