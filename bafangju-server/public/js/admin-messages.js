// admin-messages.js —— 消息管理（系统公告群发 / 站内消息）
// ==================== 消息管理 ====================
async function loadMessages() {
  const list = await authed('/api/admin/messages?limit=100').then((r) => r.json()).catch(() => []);
  document.querySelector('#msgTable tbody').innerHTML = (list || []).map((m) =>
    `<tr><td class="muted">${escHtml((m.ts || '').replace('T', ' ').slice(0, 19))}</td><td>${escHtml(m.userId)}</td>
      <td><span class="tag">${escHtml(m.type)}</span></td><td>${escHtml(m.title)}</td>
      <td>${m.read ? '<span class="muted">已读</span>' : '<span class="tag orange">未读</span>'}</td></tr>`).join('')
    || '<tr><td colspan="5"><div class="empty"><div class="e-icon">✉️</div>暂无消息</div></td></tr>';
}
async function sendBroadcast() {
  const title = document.getElementById('msgTitle').value.trim();
  const body = document.getElementById('msgBody').value.trim();
  const raw = document.getElementById('msgUsers').value.trim();
  const userIds = raw ? raw.split(/[,，\s]+/).filter(Boolean) : undefined;
  const r = await authed('/api/admin/messages/broadcast', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, body, userIds }),
  }).then((x) => x.json());
  if (r.error) { document.getElementById('msgResult').textContent = '失败：' + r.error; return; }
  document.getElementById('msgResult').textContent = `已发送 ${r.count} 条`;
  document.getElementById('msgTitle').value = ''; document.getElementById('msgBody').value = ''; document.getElementById('msgUsers').value = '';
  toast(`公告已发送 ${r.count} 条`); loadMessages();
}

