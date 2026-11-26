// admin-governance.js —— 合规开关 + 风控（黑名单 / 申诉 / 循环免单预警（历史 FREE 单））
// ==================== 合规开关 ====================
async function loadSwitches(home) {
  const sw = home || await authed('/api/home').then((r) => r.json());
  const el = document.getElementById('switches');
  el.innerHTML = '';
  Object.entries(S).forEach(([k, label]) => {
    const item = document.createElement('label');
    item.className = 'switch-item';
    item.innerHTML = `<input type="checkbox" ${sw.switches[k] ? 'checked' : ''} onchange="setSwitch('${k}', this.checked)"> ${label}`;
    el.appendChild(item);
  });
  document.getElementById('swWithdraw').checked = !!sw.switches.withdrawEnabled;
}
async function setSwitch(key, value) {
  await authed('/api/admin/switches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, value }) });
  toast(`「${S[key] || key}」已${value ? '开启' : '关闭'}`);
  loadSwitches(); loadOverview();
}
async function setWithdraw(value) {
  await authed('/api/admin/switches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'withdrawEnabled', value }) });
  toast(`提现总开关已${value ? '开启' : '关闭'}`);
}

// ==================== 风控 ====================
async function loadRisk() {
  const bl = await authed('/api/admin/risk/blacklist').then((r) => r.json());
  document.querySelector('#blacklist tbody').innerHTML = bl.map((b) =>
    `<tr><td>${escHtml(b.userId)}</td><td>${escHtml(b.reason || '')}</td><td class="muted">${escHtml(b.blockedAt)}</td></tr>`).join('')
    || '<tr><td colspan="3"><div class="empty">黑名单为空</div></td></tr>';
  await loadAppeals();
  const al = await authed('/api/admin/risk/alerts').then((r) => r.json());
  document.querySelector('#alerts tbody').innerHTML = al.map((a) =>
    `<tr><td class="muted">${escHtml(a.ts)}</td><td>${escHtml(a.userId)}</td><td>${a.freeCount}</td><td>${a.type === 'loop_free_order' ? '重复免单预警（历史）' : escHtml(a.type)}</td></tr>`).join('')
    || '<tr><td colspan="4"><div class="empty">暂无预警</div></td></tr>';
}
/** 用户申诉表单独刷新（风控中心的「用户申诉」卡片刷新按钮） */
async function loadAppeals() {
  const ap = await authed('/api/admin/risk/appeals').then((r) => r.json());
  document.querySelector('#appeals tbody').innerHTML = ap.map((a) => {
    // 申诉内容没有固定长度，原渲染撑得整行特别高；截断到 32 字 + hover title
    const contentFull = escHtml(a.content || '');
    const contentShort = contentFull.length > 32 ? contentFull.slice(0, 32) + '…' : contentFull;
    return `<tr>
      <td class="muted">${a.id}</td><td>${escHtml(a.userId)}</td><td>${escHtml(a.targetType)}</td>
      <td style="max-width:260px"><span title="${contentFull}">${contentShort}</span></td>
      <td><span class="tag ${a.status === 'accepted' ? 'green' : a.status === 'rejected' ? 'danger' : 'blue'}">${a.status === 'open' ? '待处理' : a.status === 'accepted' ? '已受理' : '已驳回'}</span></td>
      <td>${a.status === 'open' ? `<button class="sm" data-act="resolveAppeal" data-id="${escHtml(a.id)}" data-p1="true">受理</button> <button class="sm ghost" data-act="resolveAppeal" data-id="${escHtml(a.id)}" data-p1="false">驳回</button>` : escHtml(a.note || '')}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="6"><div class="empty">暂无申诉</div></td></tr>';
}
async function addBlacklist() {
  const userId = document.getElementById('blUser').value.trim();
  if (!userId) return toast('请输入用户ID', 'err');
  await post('/api/admin/risk/blacklist', { userId, blocked: true, reason: document.getElementById('blReason').value });
  toast('已拉黑'); loadRisk();
}
async function removeBlacklist() {
  const userId = document.getElementById('blUser').value.trim();
  if (!userId) return toast('请输入用户ID', 'err');
  await post('/api/admin/risk/blacklist', { userId, blocked: false });
  toast('已解封'); loadRisk();
}
async function resolveAppeal(id, accepted) {
  const note = accepted ? '' : prompt('驳回原因（可选）') || '';
  await post('/api/admin/risk/appeals/resolve', { appealId: String(id), accepted, note });
  toast(accepted ? '已受理' : '已驳回'); loadRisk();
}
async function runRiskScan() {
  const r = await post('/api/admin/jobs/risk-scan', {});
  toast(`识别出 ${r.alerts.length} 个预警用户`); loadRisk();
}

