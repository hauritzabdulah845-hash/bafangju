'use strict';
/**
 * 子管理员账号域（V4.1）：服务「交付后由平台方运营后台」的管控需求。
 *
 * 设计要点：
 * - **两级账号体系**：总账号（adminAccounts，环境变量引导，永不被本模块触碰）＞ 子管理员（本模块）。
 *   子管理员无法创建/修改/停用其他账号，只有总账号能管理本模块。
 * - **权限按模块勾选**：权限键 = 侧栏 pane 键，后端按请求路径映射拦截（见 permsRequired），
 *   前端只做展示层隐藏；真正生效的拦截在服务端，前后端不一致也不会越权。
 * - **即时生效**：停用账号或改权限后，既有会话下一次请求就按新权限判定（每次请求实时解析账号）。
 * - **可追溯**：建号/改权限/停用/重置密码/登录/登录失败全部写审计（操作者 = 总账号用户名）。
 * - 口令摘要复用 adminAuth 的 scrypt 实现，不引入第二套加密。
 */
const crypto = require('node:crypto');
const adminAuth = require('./adminAuth');
const { audit } = require('../store');

/** 可选权限（键与后台侧栏 pane 一致；overview 默认所有人可见，不列入勾选） */
const PERMS = [
  { key: 'orders', label: '订单管理', group: '运营' },
  { key: 'catalog', label: '商品管理', group: '运营' },
  { key: 'merchants', label: '商家管理', group: '运营' },
  { key: 'adCenter', label: '广告中心', group: '运营' },
  { key: 'content', label: '内容与运营', group: '运营' },
  { key: 'withdraw', label: '提现审核', group: '资金' },
  // 财务复核：提现/打款的第二人复核专用（与登记/初审权限分离；默认不授予存量账号）
  { key: 'finance', label: '财务复核', group: '资金' },
  { key: 'queue', label: '分红排队', group: '资金' },
  { key: 'reserve', label: '储备金账户', group: '资金' },
  { key: 'jobs', label: '每日任务 / 季度分红', group: '资金' },
  { key: 'switches', label: '功能开关', group: '安全' },
  { key: 'risk', label: '风控中心', group: '安全' },
  { key: 'messages', label: '消息管理', group: '安全' },
  { key: 'settings', label: '系统设置', group: '安全' },
  { key: 'audit', label: '操作日志', group: '安全' },
];
const PERM_KEYS = PERMS.map((p) => p.key);

/** 总账号专属（子管理员一律拒绝） */
const SUPER_ONLY = ['/users'];

/** 所有登录者均可访问（安全自查 / 看板只读数据 / 登出） */
const ANY_ROLES = ['/me', '/change-password', '/logout'];

/**
 * 请求路径 → 所需权限键。
 * 返回 'super' 表示仅总账号；返回 'any' 表示登录即可；返回权限键表示需该模块权限；
 * 返回数组表示「具备其中任一权限即可」（用于跨模块共用入口）。
 * 顺序敏感：先精确前缀，再模块前缀。
 */
function permsRequired(method, rawPath) {
  const p = String(rawPath || '/').replace(/\/+$/, '') || '/';
  if (p === '/login') return 'any';
  if (SUPER_ONLY.some((x) => p === x || p.startsWith(x + '/'))) return 'super';
  if (ANY_ROLES.some((x) => p === x || p.startsWith(x + '/'))) return 'any';

  // 经营看板需要的只读接口：任何登录者都能拿到自己可见的汇总
  const READ_ANY = ['/stats/daily', '/platform-flows', '/rules', '/orders/fulfillment-summary'];
  if (method === 'GET' && READ_ANY.includes(p)) return 'any';
  // 概览页读取开关状态（POST /switches 才是改开关，仍受 switches 权限约束）
  if (method === 'GET' && p === '/switches') return 'any';

  // 广告奖励提现：登记/初审/驳回走「提现或广告侧」权限；
  // 第二人复核（线下复核发放 / 线上复核打款）只认财务复核角色（总账号天然放行）。
  if (p === '/reward-withdrawals/offline-confirm' || p === '/reward-withdrawals/pay') return 'finance';
  if (p === '/reward-withdrawals/offline-mark' || p === '/reward-withdrawals/approve'
    || p === '/reward-withdrawals/reject') return ['adCenter', 'withdraw'];
  if (p === '/reward-withdrawals' || p.startsWith('/reward-withdrawals/')) {
    return ['adCenter', 'withdraw', 'finance'];
  }

  if (p.startsWith('/users')) return 'super';
  if (p.startsWith('/orders')) return 'orders';
  if (p.startsWith('/refund-anomalies')) return 'orders'; // 退款异常队列与订单同权限
  if (p.startsWith('/catalog')) return 'catalog';
  if (p.startsWith('/merchants') || p.startsWith('/merchant-applications')
    || p.startsWith('/alliance-orders') || p.startsWith('/uploads/private')) return 'merchants';
  // 广告中心可读取额度用于代投预览；发放/修改额度仍仅总账号
  if (method === 'GET' && p === '/ad-quotas') return 'adCenter';
  if (p.startsWith('/ad-quotas')) return 'super';
  if (p.startsWith('/advideos') || p.startsWith('/adslots') || p === '/upload/video'
    || p.startsWith('/task-config')) return 'adCenter';
  if (p.startsWith('/content') || p.startsWith('/ops-slides') || p === '/upload') return 'content';
  if (p.startsWith('/withdraw')) return 'withdraw';
  if (p.startsWith('/queue-slots')) return 'queue';
  if (p.startsWith('/reserve')) return 'reserve';
  if (p.startsWith('/jobs') || p.startsWith('/quarter')
    || p.startsWith('/leader-pool') || p.startsWith('/commission')) return 'jobs';
  if (p.startsWith('/risk')) return 'risk';
  if (p.startsWith('/switches')) return 'switches';   // GET 已在上面放行，此处命中写操作
  if (p.startsWith('/messages')) return 'messages';
  if (p.startsWith('/settings') || p.startsWith('/level-config')) return 'settings';
  if (p.startsWith('/audit')) return 'audit';
  // 未归类的后台接口：默认仅总账号（宁可误拒，不可误放）
  return 'super';
}

function assertUsername(username) {
  const u = String(username || '').trim();
  if (!/^[A-Za-z][A-Za-z0-9_-]{2,19}$/.test(u)) {
    throw new Error('账号需 3~20 位，字母开头，仅限字母 / 数字 / 下划线 / 连字符');
  }
  return u;
}

function assertPassword(password) {
  const pw = String(password || '');
  const r = adminAuth.checkPasswordStrength(pw);
  if (!r || !r.ok) {
    const issues = (r && r.issues) || [];
    throw new Error('密码强度不足：' + (issues.length ? issues.join('、') : '长度大于 10 位，含字母与数字'));
  }
  return pw;
}

function normalizePerms(list) {
  const arr = Array.isArray(list) ? list : [];
  const set = new Set(arr.filter((k) => PERM_KEYS.includes(k)));
  return PERM_KEYS.filter((k) => set.has(k)); // 固定顺序、去重、丢弃未知键
}

/** 对外视图：绝不返回摘要 */
function pub(u) {
  if (!u) return null;
  return {
    uid: u.uid || '',
    username: u.id,
    permissions: Array.isArray(u.permissions) ? u.permissions.slice() : [],
    enabled: u.enabled !== false,
    note: u.note || '',
    createdBy: u.createdBy || '',
    createdAt: u.createdAt || '',
    lastLoginAt: u.lastLoginAt || '',
    passwordUpdatedAt: u.passwordUpdatedAt || '',
  };
}

/** 为历史账号懒回填不可变账号 ID（删除重建同名账号后仍可区分） */
function ensureUid(db, u) {
  if (!u.uid) u.uid = crypto.randomUUID();
  return u.uid;
}

/** 审计操作者：统一落 actorId + 用户名 */
function actorRef(actorId, actor) {
  return { id: actorId != null ? String(actorId) : '', name: String(actor || '') };
}

function revokeSessions(db, username) {
  const rows = db.adminUserSessions.where((s) => s.username === username);
  for (const s of rows) db.adminUserSessions.delete(s.id);
  return rows.length;
}

/**
 * 创建子管理员（仅总账号调用；路由层已校验 super，本函数再做一次防御）。
 */
function create(db, { username, password, permissions, note, actor, actorId }) {
  const u = assertUsername(username);
  const pw = assertPassword(password);
  if (db.adminAccounts.get(u)) throw new Error('该账号为系统总账号，不可作为子管理员创建');
  if (db.adminUsers.get(u)) throw new Error('账号已存在');
  const now = new Date().toISOString();
  const row = {
    id: u,
    uid: crypto.randomUUID(),
    username: u,
    passHash: adminAuth.hashPassword(pw),
    permissions: normalizePerms(permissions),
    enabled: true,
    note: String(note || '').slice(0, 100),
    createdBy: String(actor || ''),
    createdById: actorId != null ? String(actorId) : '',
    createdAt: now,
    lastLoginAt: '',
    passwordUpdatedAt: now,
  };
  db.adminUsers.insert(row);
  audit(db, actorRef(actorId, actor), 'adminuser.create', {
    username: u, uid: row.uid, permissions: row.permissions, createdBy: row.createdBy,
  });
  return pub(row);
}

function list(db) {
  return db.adminUsers.all()
    .map(pub)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

/** 更新权限 / 备注 / 启用状态（仅总账号） */
function update(db, { username, permissions, enabled, note, actor, actorId }) {
  const u = db.adminUsers.get(String(username || ''));
  if (!u) throw new Error('账号不存在');
  ensureUid(db, u);
  const patch = {};
  if (permissions !== undefined) patch.permissions = normalizePerms(permissions);
  if (enabled !== undefined) patch.enabled = !!enabled;
  if (note !== undefined) patch.note = String(note || '').slice(0, 100);
  if (!Object.keys(patch).length) throw new Error('没有需要更新的字段');
  db.adminUsers.update(u.id, patch);
  if (patch.enabled === false) revokeSessions(db, u.id);
  const detail = {
    username: u.id,
    uid: u.uid,
    permissions: patch.permissions !== undefined ? patch.permissions : u.permissions,
    enabled: u.enabled !== false,
  };
  if (patch.enabled === false) audit(db, actorRef(actorId, actor), 'adminuser.disable', detail);
  else if (patch.enabled === true) audit(db, actorRef(actorId, actor), 'adminuser.enable', detail);
  else audit(db, actorRef(actorId, actor), 'adminuser.update', detail);
  return pub(db.adminUsers.get(u.id));
}

/** 重置子管理员密码：立即吊销其全部会话；记录重置人与时间（供复核独立性校验） */
function resetPassword(db, { username, newPassword, actor, actorId }) {
  const u = db.adminUsers.get(String(username || ''));
  if (!u) throw new Error('账号不存在');
  ensureUid(db, u);
  const pw = assertPassword(newPassword);
  const now = new Date().toISOString();
  db.adminUsers.update(u.id, {
    passHash: adminAuth.hashPassword(pw),
    passwordUpdatedAt: now,
    lastResetBy: String(actor || ''),
    lastResetById: actorId != null ? String(actorId) : '',
    lastResetAt: now,
  });
  const n = revokeSessions(db, u.id);
  audit(db, actorRef(actorId, actor), 'adminuser.reset_password', {
    username: u.id, uid: u.uid, revokedSessions: n,
  });
  return { ok: true, revokedSessions: n };
}

/** 删除子管理员（连带吊销会话）；通常优先「停用」保留痕迹 */
function remove(db, { username, actor, actorId }) {
  const u = db.adminUsers.get(String(username || ''));
  if (!u) throw new Error('账号不存在');
  ensureUid(db, u);
  revokeSessions(db, u.id);
  db.adminUsers.delete(u.id);
  audit(db, actorRef(actorId, actor), 'adminuser.delete', { username: u.id, uid: u.uid });
  return { ok: true };
}

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

/** 子管理员登录：账号不存在 / 已停用 / 口令错误 统一文案，不泄露账号状态 */
function login(db, { username, password, ip }) {
  const key = String(username || '').trim();
  const u = key ? db.adminUsers.get(key) : null;
  const fail = () => {
    audit(db, 'anonymous', 'adminuser.login_failed', { username: key || null, ip: ip || null });
    throw new Error('账号或密码错误');
  };
  if (!u || u.enabled === false) fail();
  if (!adminAuth.verifyPassword(String(password || ''), u.passHash)) fail();
  ensureUid(db, u);
  const token = crypto.randomBytes(24).toString('hex');
  db.adminUserSessions.insert({
    id: token,
    username: u.id,
    createdAt: new Date().toISOString(),
    ip: ip || '',
  });
  db.adminUsers.update(u.id, { lastLoginAt: new Date().toISOString() });
  audit(db, actorRef(u.uid, u.id), 'adminuser.login', { username: u.id, uid: u.uid, ip: ip || null });
  return { token, username: u.id, uid: u.uid, role: 'admin', permissions: u.permissions || [], devDefault: false };
}

function userByToken(db, token) {
  if (!token) return null;
  const s = db.adminUserSessions.get(String(token));
  if (!s) return null;
  if (Date.now() - Date.parse(s.createdAt || 0) > SESSION_TTL_MS) {
    db.adminUserSessions.delete(s.id);
    return null;
  }
  const u = db.adminUsers.get(s.username);
  if (!u || u.enabled === false) return null; // 停用即时生效
  ensureUid(db, u);
  return u;
}

function logout(db, token) {
  if (!token) return { ok: true };
  db.adminUserSessions.delete(String(token));
  return { ok: true };
}

module.exports = {
  PERMS, PERM_KEYS, permsRequired,
  create, list, update, resetPassword, remove,
  login, logout, userByToken, pub,
};
