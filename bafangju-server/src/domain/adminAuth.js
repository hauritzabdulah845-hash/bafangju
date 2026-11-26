'use strict';
/**
 * 管理后台鉴权（V3.3 §11 安全）—— 合规要点：
 * - 密码只存 scrypt 摘要（随机盐，永不存明文），登录比较用 timingSafeEqual 防时序攻击；
 * - 登录成功签发随机 token（持久化会话，重启不失效），全部 /api/admin/* 接口（除登录）必须携带；
 * - 首次启动初始化：环境变量 ADMIN_USER/ADMIN_PASSWORD 优先；未配置时创建开发默认账号
 *   admin/admin123 并在审计中标记 devDefault（仅限非生产环境）；
 * - 【生产拒绝默认口令】NODE_ENV=production 时，管理员口令必须由 ADMIN_PASSWORD 显式提供且满足强度
 *   （长度大于 10 位且含字母与数字），否则拒绝启动；库中若仍残留开发默认口令账号同样拒绝启动；
 * - 会话可吊销（登出），改密后可清空其他会话。
 */
const crypto = require('crypto');
const { audit } = require('../store');

/** 管理员口令强度基线：长度下限（口令长度必须「大于」此值，即 ≥11 位） */
const PASSWORD_MIN_LENGTH = 10;

/** scrypt 摘要：salt:hash（均 hex） */
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const cand = crypto.scryptSync(String(password), salt, 64);
  const expect = Buffer.from(hash, 'hex');
  return cand.length === expect.length && crypto.timingSafeEqual(cand, expect);
}

/**
 * 管理员口令强度校验（生产基线）：长度 > 10 位，且同时包含字母与数字（不区分大小写）。
 * @returns {{ok:boolean, issues:string[]}} issues 为未满足的具体原因（可直读）
 */
function checkPasswordStrength(password) {
  const pwd = String(password == null ? '' : password);
  const issues = [];
  if (pwd.length <= PASSWORD_MIN_LENGTH) issues.push(`长度需大于 ${PASSWORD_MIN_LENGTH} 位`);
  if (!/[A-Za-z]/.test(pwd)) issues.push('需包含字母');
  if (!/\d/.test(pwd)) issues.push('需包含数字');
  return { ok: issues.length === 0, issues };
}

/** 设置新口令时统一走此断言（不满足直接抛错，错误信息可直读） */
function assertPasswordPolicy(password) {
  const { ok, issues } = checkPasswordStrength(password);
  if (!ok) throw new Error(`新密码安全策略不满足：${issues.join('、')}`);
}

/**
 * 生产环境启动断言：拒绝默认口令上线。
 * ① ADMIN_PASSWORD 必须显式配置（禁止回落 admin/admin123）；
 * ② 口令必须满足强度（长度大于 10 位且含字母与数字）；
 * ③ 库中若残留仍使用开发默认口令的账号 → 轮换为 ADMIN_PASSWORD（默认口令即刻失效），并留痕审计。
 * 任何不满足均抛出 Error，由调用方拒绝启动。
 */
function assertProductionAdminPassword(db, env = process.env) {
  if (String(env.NODE_ENV || '').toLowerCase() !== 'production') return;
  const pwd = env.ADMIN_PASSWORD;
  if (!pwd) {
    throw new Error('生产环境必须显式配置 ADMIN_PASSWORD（禁止使用默认口令 admin/admin123），当前未配置，拒绝启动');
  }
  const { ok, issues } = checkPasswordStrength(pwd);
  if (!ok) {
    throw new Error(`生产环境 ADMIN_PASSWORD 强度不足：${issues.join('、')}，拒绝启动`);
  }
  // 残留默认口令账号：直接改写为环境变量口令，让 admin/admin123 立即失效
  for (const acc of db.adminAccounts.all()) {
    if (!acc.devDefault) continue;
    acc.passwordHash = hashPassword(pwd);
    acc.devDefault = false;
    audit(db, 'system', 'admin.password_reset_from_env', { username: acc.username, reason: '生产环境轮换开发默认口令' });
  }
}

/**
 * 确保存在至少一个管理员账号（启动时调用，幂等）。
 * 生产环境（NODE_ENV=production）缺少强口令时直接抛错，拒绝启动。
 * @returns {{username, devDefault:boolean, created:boolean}}
 */
function ensureAdminAccount(db, env = process.env) {
  assertProductionAdminPassword(db, env);
  const existing = db.adminAccounts.all();
  if (existing.length > 0) {
    // 历史库可能没有不可变账号 ID：启动时懒回填（删除重建同名总账号也仍可区分）
    for (const acc of existing) {
      if (!acc.uid) db.adminAccounts.update(acc.id, { uid: crypto.randomUUID() });
    }
    return { created: false, devDefault: !!existing[0].devDefault, username: existing[0].username };
  }
  const username = env.ADMIN_USER || 'admin';
  const devDefault = !env.ADMIN_PASSWORD;
  const password = env.ADMIN_PASSWORD || 'admin123';
  db.adminAccounts.insert({
    id: username, uid: crypto.randomUUID(), username, passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(), devDefault,
  });
  audit(db, 'system', 'admin.account_init', { username, devDefault, hint: devDefault ? '开发默认口令已启用（仅限非生产环境），生产必须配置 ADMIN_USER/ADMIN_PASSWORD' : '来自环境变量' });
  return { created: true, devDefault, username };
}

/** 登录：校验口令 → 签发 token（持久化会话） */
function login(db, { username, password }) {
  const acc = db.adminAccounts.get(username);
  // 统一错误信息，不暴露"账号不存在/口令错误"差异
  if (!acc || !verifyPassword(password, acc.passwordHash)) {
    audit(db, 'admin', 'admin.login_failed', { username: username || null });
    throw new Error('账号或密码错误');
  }
  const token = crypto.randomBytes(32).toString('hex');
  db.adminSessions.insert({ token, username, createdAt: new Date().toISOString() });
  audit(db, { id: acc.uid || username, name: username }, 'admin.login', { devDefaultWarn: !!acc.devDefault });
  return { token, username, uid: acc.uid || username, devDefault: !!acc.devDefault };
}

/** token -> 管理会话（中间件用） */
function sessionByToken(db, token) {
  if (!token) return null;
  return db.adminSessions.where((s) => s.token === token)[0] || null;
}

/** 登出：吊销会话 */
function logout(db, token) {
  const s = sessionByToken(db, token);
  if (!s) return false;
  db.adminSessions.delete(s.id);
  audit(db, s.username, 'admin.logout', {});
  return true;
}

/** 修改密码：校验旧口令 → 更新摘要 → 可选吊销其他会话 */
function changePassword(db, { username, oldPassword, newPassword, revokeOthers = true }, env = process.env) {
  const acc = db.adminAccounts.get(username);
  if (!acc) throw new Error('账号不存在');
  if (!verifyPassword(oldPassword, acc.passwordHash)) throw new Error('原密码错误');
  // 生产环境执行强口令策略（防止把口令改回弱值/default）；非生产保持 ≥8 位基线
  if (String(env.NODE_ENV || '').toLowerCase() === 'production') {
    assertPasswordPolicy(newPassword);
  } else if (!newPassword || String(newPassword).length < 8) {
    throw new Error('新密码至少 8 位');
  }
  acc.passwordHash = hashPassword(newPassword);
  acc.devDefault = false;
  if (revokeOthers) {
    for (const s of db.adminSessions.where((x) => x.username === username)) {
      db.adminSessions.delete(s.id); // 改密后全部会话失效，需重新登录
    }
  }
  audit(db, username, 'admin.password_changed', { revokedSessions: revokeOthers });
  return { ok: true };
}

module.exports = { ensureAdminAccount, login, logout, sessionByToken, changePassword, hashPassword, verifyPassword, checkPasswordStrength, assertPasswordPolicy, assertProductionAdminPassword };
