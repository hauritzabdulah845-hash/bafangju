// admin-init.js —— 初始化（会话校验 / 身份与权限恢复 / 首屏加载）
// ==================== 初始化 ====================
// 用 /api/admin/me 探活：总账号与子管理员都能通过；随后按角色/权限裁剪侧栏。
(async function initAuth() {
  if (!TOKEN) { showLogin(''); return; }
  try {
    const r = await fetch('/api/admin/me', { headers: { Authorization: 'Bearer ' + TOKEN } });
    if (r.status === 401) { showLogin('会话已失效，请重新登录'); return; }
    if (!r.ok) { showLogin('会话异常，请重新登录'); return; }
    const me = await r.json();
    applyIdentity(me);
    showMain();
    loadOverview();
  } catch (e) { showLogin(''); }
})();
