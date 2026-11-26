// admin-users.js —— 账号与权限（V4.1）：总账号创建/授权/停用子管理员
// 服务端逐请求拦截权限；本页仅总账号可见（服务端 /api/admin/users* 对子管理员一律 403）。
let AU_USERS = [];
let AU_PERMS = [];

async function loadAdminUsers() {
  const box = document.getElementById('auPermChecks');
  try {
    const d = await authed('/api/admin/users').then((r) => r.json());
    if (d.error) return toast('加载失败：' + d.error, 'err');
    AU_USERS = d.users || [];
    AU_PERMS = d.perms || [];
    renderPermChecks();
    renderAdminUsers();
  } catch (e) { if (box) box.innerHTML = '<span class="muted">加载失败</span>'; }
}

/** 建号表单的权限勾选 chips */
function renderPermChecks() {
  const box = document.getElementById('auPermChecks');
  if (!box) return;
  box.innerHTML = AU_PERMS.map((p) => `
    <label class="perm-chip" data-key="${escHtml(p.key)}">
      <input type="checkbox" value="${escHtml(p.key)}">
      ${escHtml(p.label)}<span class="pc-g">${escHtml(p.group)}</span>
    </label>`).join('');
  box.querySelectorAll('input[type=checkbox]').forEach((cb) => {
    cb.addEventListener('change', () => cb.closest('.perm-chip').classList.toggle('on', cb.checked));
  });
}

function checkedPerms() {
  return [...document.querySelectorAll('#auPermChecks input[type=checkbox]:checked')].map((c) => c.value);
}

async function createAdminUser() {
  const username = document.getElementById('auName').value.trim();
  const password = document.getElementById('auPass').value;
  const note = document.getElementById('auNote').value.trim();
  const permissions = checkedPerms();
  const hint = document.getElementById('auCreateResult');
  hint.textContent = '';
  if (!username || !password) return toast('请填写账号与初始密码', 'err');
  if (!permissions.length) return toast('至少勾选一个模块权限', 'err');
  const r = await post('/api/admin/users/create', { username, password, note, permissions });
  if (r.error) return toast('创建失败：' + r.error, 'err');
  hint.textContent = '已创建：' + username;
  document.getElementById('auName').value = '';
  document.getElementById('auPass').value = '';
  document.getElementById('auNote').value = '';
  document.querySelectorAll('#auPermChecks input[type=checkbox]').forEach((c) => { c.checked = false; c.closest('.perm-chip').classList.remove('on'); });
  showSecret('管理员账号已创建', [
    { label: '登录地址', value: location.origin + '/admin.html' },
    { label: '账号', value: username },
    { label: '初始密码', value: password },
    { label: '已授权模块', value: permissions.map((k) => (AU_PERMS.find((p) => p.key === k) || {}).label || k).join('、') },
  ], '以下内容仅本次展示，请通过安全渠道转交；对方首次登录后建议立即修改密码。');
  loadAdminUsers();
}

function renderAdminUsers() {
  const tb = document.querySelector('#adminUsers tbody');
  if (!tb) return;
  tb.innerHTML = AU_USERS.map((u) => {
    const chips = AU_PERMS.map((p) => `<span class="ptag ${(u.permissions || []).includes(p.key) ? 'on' : ''}"
      data-act="toggleUserPerm" data-id="${escHtml(u.username)}" data-p1="${escHtml(p.key)}"
      title="点击${(u.permissions || []).includes(p.key) ? '收回' : '授予'}「${escHtml(p.label)}」">${escHtml(p.label)}</span>`).join('');
    const status = u.enabled ? '<span class="tag green">启用</span>' : '<span class="tag danger">已停用</span>';
    const ops = [
      u.enabled
        ? `<button class="sm ghost" data-act="toggleUserEnabled" data-id="${escHtml(u.username)}" data-p1="false">停用</button>`
        : `<button class="sm" data-act="toggleUserEnabled" data-id="${escHtml(u.username)}" data-p1="true">启用</button>`,
      `<button class="sm plain" data-act="resetUserPassword" data-id="${escHtml(u.username)}">重置密码</button>`,
      `<button class="sm plain" data-act="deleteAdminUser" data-id="${escHtml(u.username)}">删除</button>`,
    ];
    return `<tr>
      <td><b>${escHtml(u.username)}</b>${u.note ? `<div class="muted" style="font-size:11px">${escHtml(u.note)}</div>` : ''}</td>
      <td style="min-width:260px">${chips}</td>
      <td>${status}</td>
      <td class="muted">${escHtml(u.lastLoginAt || '-')}</td>
      <td class="muted">${escHtml((u.createdAt || '').slice(0, 16).replace('T', ' ') || '-')}<div style="font-size:11px">by ${escHtml(u.createdBy || '-')}</div></td>
      <td>${ops.join(' ')}</td></tr>`;
  }).join('') || '<tr><td colspan="6"><div class="empty"><div class="e-icon">👤</div>还没有管理员账号，先在上方创建一个</div></td></tr>';
}

/** 列表内点权限标签：即时授予/收回（服务端写审计） */
async function toggleUserPerm(username, permKey) {
  const u = AU_USERS.find((x) => x.username === username);
  if (!u) return;
  const set = new Set(u.permissions || []);
  set.has(permKey) ? set.delete(permKey) : set.add(permKey);
  const r = await post('/api/admin/users/update', { username, permissions: [...set] });
  if (r.error) return toast('更新失败：' + r.error, 'err');
  toast(set.has(permKey) ? '已授予权限，即时生效' : '已收回权限，即时生效');
  loadAdminUsers();
}

async function toggleUserEnabled(username, enabled) {
  if (!enabled && !confirm(`确认停用 ${username}？停用后该账号立即断开、无法登录（可随时重新启用）。`)) return;
  const r = await post('/api/admin/users/update', { username, enabled: !!enabled });
  if (r.error) return toast('操作失败：' + r.error, 'err');
  toast(enabled ? '已启用' : '已停用，现有会话已失效');
  loadAdminUsers();
}

async function resetUserPassword(username) {
  const pw = prompt(`为 ${username} 设置新密码（长度大于 10 位，含字母与数字）：`);
  if (!pw) return;
  const r = await post('/api/admin/users/reset-password', { username, newPassword: pw });
  if (r.error) return toast('重置失败：' + r.error, 'err');
  showSecret('密码已重置', [
    { label: '账号', value: username },
    { label: '新密码', value: pw },
  ], `该账号原有登录已全部失效（${r.revokedSessions || 0} 个会话被吊销），请通知对方重新登录。`);
  loadAdminUsers();
}

async function deleteAdminUser(username) {
  if (!confirm(`确认删除账号 ${username}？删除后审计记录仍保留，但账号不可恢复。若只是暂时不用，建议「停用」。`)) return;
  const r = await post('/api/admin/users/delete', { username });
  if (r.error) return toast('删除失败：' + r.error, 'err');
  toast('已删除');
  loadAdminUsers();
}
