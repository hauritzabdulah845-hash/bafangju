'use strict';
/**
 * 登录鉴权适配层（V3.9）—— 合规要点：
 * - 微信 code2session：配置 WX_APPID/WX_SECRET 后走真实接口；未配置自动降级开发态；
 * - **本地幂等**：生产按 openid 幂等建档；开发态按设备标识（devSeed）派生稳定 openid，
 *   同一设备多次登录/刷新不会重复建号；
 * - 老账号认领：昵称登录时代创建的账号（无 openid）在持有有效会话时，首次微信登录会绑定到该账号；
 * - openid/session_key 仅服务端持有，不下发前端。
 */
const crypto = require('crypto');

/** 开发态 openid：由稳定种子（设备标识）派生，保证同一设备同一账号 */
function deriveDevOpenid(seed) {
  return 'dev_' + crypto.createHash('sha1').update(String(seed)).digest('hex').slice(0, 16);
}

/**
 * code 换取 openid。fetchImpl 可注入（测试用）。
 * 开发态（未配置 appid/secret）：优先用 devSeed（设备标识）派生稳定 openid；
 * 没有 devSeed 时退回用 code 派生（一次性，仅供单次联调）。
 * @returns {{openid, sessionKey?, unionid?, devMode}}
 */
async function code2session({ code, appid, secret, devSeed, fetchImpl } = {}) {
  if (!code) throw new Error('code 必填');
  if (!appid || !secret) {
    const seed = devSeed ? String(devSeed) : String(code);
    return { openid: deriveDevOpenid(seed), devMode: true };
  }
  const f = fetchImpl || fetch;
  const url = 'https://api.weixin.qq.com/sns/jscode2session?appid=' + encodeURIComponent(appid)
    + '&secret=' + encodeURIComponent(secret)
    + '&js_code=' + encodeURIComponent(code)
    + '&grant_type=authorization_code';
  const res = await f(url);
  const data = await res.json();
  if (data.errcode) throw new Error(`code2session 失败：errcode=${data.errcode} errmsg=${data.errmsg}`);
  if (!data.openid) throw new Error('code2session 返回缺少 openid');
  return { openid: data.openid, sessionKey: data.session_key, unionid: data.unionid, devMode: false };
}

/** 昵称占位符判定：'用户' + 4 位派生码（openid 后 4 位或设备号后 4 位）。
 *  此类昵称是系统自动生成的，不是用户真实填写的，允许被后续真实昵称替换。 */
const PLACEHOLDER_NICK = /^用户[0-9A-Za-z]{4}$/;
function isPlaceholderNickname(nickname) {
  return !nickname || PLACEHOLDER_NICK.test(String(nickname));
}

/**
 * 按 openid 幂等建档/登录：同一 openid 永远返回同一 userId，并刷新最后登录时间。
 * 昵称只在「当前昵称是系统占位符」时才允许被传入值覆盖 —— 避免静默重登把用户
 * 已填写的真实昵称冲掉（数据正确性）。
 */
function loginOrRegister(db, { openid, nickname }) {
  if (!openid) throw new Error('openid 必填');
  const now = new Date().toISOString();
  const exist = db.users.where((u) => u.openid === openid)[0];
  if (exist) {
    const patch = { lastLoginAt: now };
    if (nickname && nickname !== exist.nickname && isPlaceholderNickname(exist.nickname)) {
      patch.nickname = nickname;
    }
    db.users.update(exist.id, patch);
    return { userId: exist.id, created: false };
  }
  const u = db.users.insert({
    openid,
    nickname: nickname || ('用户' + openid.slice(-4)),
    createdAt: now,
    lastLoginAt: now,
  });
  return { userId: u.id, created: true };
}

/**
 * 完整登录流程：code → openid → 建档。
 * @param {string} [p.legacyUserId] 当前会话对应的老账号（无 openid）：若 openid 尚未建号，则把该账号"认领"给这个微信身份，
 *        避免昵称登录时代创建的账号在升级后丢失历史订单（必须持有有效会话，防止冒领）。
 */
async function loginWithCode(db, { code, nickname, appid, secret, devSeed, legacyUserId, fetchImpl }) {
  const session = await code2session({ code, appid, secret, devSeed, fetchImpl });
  // 已有该 openid 的账号：直接登录
  const existing = db.users.where((u) => u.openid === session.openid)[0];
  if (!existing && legacyUserId) {
    const legacy = db.users.get(String(legacyUserId));
    if (legacy && !legacy.openid) {
      db.users.update(legacy.id, {
        openid: session.openid,
        lastLoginAt: new Date().toISOString(),
        ...(nickname && nickname !== legacy.nickname && isPlaceholderNickname(legacy.nickname) ? { nickname } : {}),
      });
      return { userId: legacy.id, created: false, claimed: true, openid: session.openid, devMode: session.devMode };
    }
  }
  const { userId, created } = loginOrRegister(db, { openid: session.openid, nickname });
  return { userId, created, claimed: false, openid: session.openid, devMode: session.devMode }; // sessionKey 不下发
}

module.exports = { deriveDevOpenid, code2session, loginOrRegister, loginWithCode };
