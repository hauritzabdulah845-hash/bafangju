// admin-withdraw.js —— 提现审核（提现单 / 转账笔 / 收款人绑定）
// ==================== 提现审核 ====================
async function loadWithdraws() {
  const data = await authed('/api/admin/withdraw/requests').then((r) => r.json());
  const list = data.requests || data;
  const receivers = data.receivers || {};
  const ST = { pending_review: ['待审核', ''], approved: ['发放中', 'blue'], issuing: ['发放中', 'blue'], done: ['完成', 'green'], rejected: ['驳回', 'danger'] };
  document.querySelector('#withdraws tbody').innerHTML = list.map((r) => {
    const [t, c] = ST[r.status] || [r.status, ''];
    const rec = receivers[r.userId];
    const bind = rec ? (rec.bound ? `<span class="tag green">已绑定</span> ${escHtml((rec.name || '') + ' ' + (rec.openid || '').slice(0, 8) + '…')}` : '<span class="tag danger">未绑定</span>') : '-';
    return `<tr><td class="muted">${r.id}</td><td>${escHtml(r.userId)}</td><td class="money">${yuan(r.fen)}</td><td><span class="tag ${c}">${t}</span></td><td>${yuan(r.remainingFen)}</td><td class="muted">${escHtml(r.appliedAt)}</td><td>${bind}</td>
      <td>${r.status === 'pending_review' ? `<button class="sm" data-act="approve" data-id="${escHtml(r.id)}">通过</button>` : ''}</td></tr>`;
  }).join('') || '<tr><td colspan="8"><div class="empty"><div class="e-icon">💰</div>暂无提现申请</div></td></tr>';
}
async function loadTransfers() {
  const list = await authed('/api/admin/withdraw/transfers').then((r) => r.json());
  const TST = { transferred_pending_confirm: ['待确认收款', 'blue'], confirmed: ['已确认', 'green'], expired_refunded: ['超时退回', 'orange'], submit_failed: ['提交失败', 'danger'] };
  document.querySelector('#transfers tbody').innerHTML = list.map((t) => {
    const [st, sc] = TST[t.status] || [t.status, ''];
    return `<tr><td class="muted">${t.id}</td><td>${t.requestId}</td><td>${escHtml(t.userId)}</td><td class="money">${yuan(t.fen)}</td><td><span class="tag ${sc}">${st}</span></td>
      <td>${t.receiverOpenid ? escHtml((t.receiverName || '') + ' ' + t.receiverOpenid.slice(0, 8) + '…') : '<span class="tag danger">未绑定</span>'}</td>
      <td class="muted">${t.issueDate}</td><td class="muted">${escHtml(t.submitError || '-')}</td>
      <td>${t.status === 'submit_failed' && !t.receiverOpenid ? `<button class="sm ghost" data-act="prefillBind" data-id="${escHtml(t.userId)}">补登记</button>` : ''}</td></tr>`;
  }).join('') || '<tr><td colspan="9"><div class="empty"><div class="e-icon">🧾</div>暂无转账记录</div></td></tr>';
}
function prefillBind(userId) {
  document.getElementById('bindUser').value = userId;
  document.getElementById('bindUser').scrollIntoView({ behavior: 'smooth' });
}
async function bindReceiver() {
  const userId = document.getElementById('bindUser').value.trim();
  const openid = document.getElementById('bindOpenid').value.trim();
  const name = document.getElementById('bindName').value.trim();
  const r = await post('/api/admin/withdraw/bind-receiver', { userId, openid, name });
  r.error ? toast('失败：' + r.error, 'err') : toast('绑定成功');
  if (!r.error) { document.getElementById('bindOpenid').value = ''; document.getElementById('bindName').value = ''; loadTransfers(); loadWithdraws(); }
}
async function retryTransfers() {
  const r = await post('/api/admin/jobs/retry-transfers', {});
  const ok = (r.results || []).filter((x) => x.retried).length;
  toast(`已重试 ${ok} 笔`);
  loadTransfers();
}
async function approve(id) {
  const r = await post('/api/admin/withdraw/approve', { requestId: id });
  r.error ? toast('失败：' + r.error, 'err') : toast(`已通过：本次发 ${yuan(r.issuedFen)}，剩余 ${yuan(r.deferredFen)} 次日接着发`);
  loadWithdraws(); loadOverview();
}

