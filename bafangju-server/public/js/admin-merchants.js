// admin-merchants.js —— 商家管理（入驻审核 / 建档 / 结算 / 联盟服务单）
// ==================== 商家管理 ====================
async function loadEntryApps() {
  // authed() 返回 fetch 的 Response，必须先解析 JSON（此前直接 list.map 会抛 TypeError，
  // 导致「商家管理 → 入驻申请」表格永远空白，审核人员看不到证照与通过/驳回按钮）
  const list = await authed('/api/admin/merchant-applications').then((r) => r.json());
  const ST = { pending_review: ['待审核', 'blue'], approved: ['已通过', 'green'], rejected: ['已驳回', 'danger'] };
  document.querySelector('#entryApps tbody').innerHTML = list.map((a) => {
    const [txt, cls] = ST[a.status] || [a.status, ''];
    // 证照：两个按钮（照 / 头），统一调用带鉴权的私有文件查看
    const license = a.licenseImgUrl ? `<button class="sm" data-act="viewUpload" data-id="${escHtml(a.licenseImgUrl)}" title="营业执照">照</button>` : '<span class="muted">—</span>';
    const shop = a.shopImgUrl ? `<button class="sm ghost" data-act="viewUpload" data-id="${escHtml(a.shopImgUrl)}" title="门头照">头</button>` : '<span class="muted">—</span>';
    // 地址超长截断 + hover 提示；去掉经纬度（抽屉或详情里看），只保留选点状态
    const addrFull = escHtml(a.address || '');
    const addrTag = Number.isFinite(a.lat) && Number.isFinite(a.lng)
      ? '<span class="tag green">已选点</span>' : '<span class="tag orange">未选点</span>';
    const addrCell = `<span title="${addrFull}">${addrFull.length > 26 ? addrFull.slice(0, 26) + '…' : addrFull}</span> ${addrTag}`;
    const personCell = `<b>${escHtml(a.name)}</b><div class="muted" style="font-size:11px">${escHtml(a.contact || '-')} · ${escHtml(a.phone || '-')}</div>`;
    return `<tr>
      <td class="muted">${escHtml(a.appliedAt || '')}</td>
      <td>${personCell}</td>
      <td>${escHtml(a.category)}</td>
      <td style="max-width:200px">${addrCell}</td>
      <td>${license} ${shop}</td>
      <td><span class="tag ${cls}">${txt}</span></td>
      <td>${a.status === 'pending_review' ? `<button class="sm" data-act="reviewEntry" data-id="${escHtml(a.id)}" data-p1="true">通过</button> <button class="sm ghost" data-act="reviewEntry" data-id="${escHtml(a.id)}" data-p1="false">驳回</button>`
        : `${escHtml(a.reviewReason || '')}${a.merchantId ? ' 商家ID: ' + escHtml(a.merchantId) : ''}`}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="7"><div class="empty"><div class="e-icon">🏪</div>暂无申请</div></td></tr>';
}
// 入驻证照查看（P0-3）：证照存私有目录、不经静态路由公开，必须带管理后台会话拉取，
// 因此不能用 <a href> 直连（无 Authorization 头会被 401）。
async function viewUpload(url) {
  const u = String(url || '');
  if (!u) return toast('文件地址无效', 'err');
  if (u.startsWith('/uploads/')) { window.open(u, '_blank'); return; } // 历史遗留公开路径
  const name = u.split('/').pop();
  try {
    const r = await authed('/api/admin/uploads/private/' + encodeURIComponent(name));
    if (!r.ok) return toast('查看失败：文件不存在或已清理', 'err');
    const objUrl = URL.createObjectURL(await r.blob());
    const w = window.open(objUrl, '_blank');
    if (!w) { const a = document.createElement('a'); a.href = objUrl; a.target = '_blank'; a.click(); }
    setTimeout(() => URL.revokeObjectURL(objUrl), 60000);
  } catch (e) { toast('查看失败：' + e.message, 'err'); }
}
async function reviewEntry(id, approved) {
  let reason = '';
  if (approved) {
    if (!confirm('确认通过？通过后自动创建商家账号与初始密码。')) return;
  } else {
    reason = prompt('请填写驳回原因（必填）');
    if (!reason) return;
  }
  const r = await post('/api/admin/merchant-applications/review', { applicationId: id, approved, reason });
  if (r.token) {
    showSecret('商家入驻已通过，账号已创建', [
      { label: '商家 ID', value: r.merchant.id },
      { label: '登录账号', value: r.merchant.username },
      { label: '初始密码', value: r.initialPassword },
    ], '请把「登录账号 + 初始密码」通过安全渠道转交商家，并提醒首次登录后立即改密。\n商家登录入口：微信打开「八方聚」小程序 → 底部「我的」→「商家服务」→「商家登录」；商家也可在申请进度查询页看到已通过状态。');
  } else if (r.error) { toast('失败：' + r.error, 'err'); }
  loadEntryApps(); loadMerchants(); loadOverview();
}
// 列表瘦身（14 列 → 7 列）：完整资料进右侧详情抽屉，避免横向滚动看不到操作
let MERCHANT_CACHE = [];
let MD_CURRENT_ID = '';
async function loadMerchants() {
  const list = await authed('/api/admin/merchants').then((r) => r.json());
  MERCHANT_CACHE = Array.isArray(list) ? list : [];
  document.querySelector('#merchants tbody').innerHTML = MERCHANT_CACHE.map((m) =>
    `<tr><td>${escHtml(m.name)}<div class="muted">${escHtml(m.id)}</div></td>
      <td>${escHtml(m.username || m.name)}${m.mustChangePassword ? ' <span class="tag orange">初始密码</span>' : ''}</td>
      <td>${escHtml(m.contact || '-')}</td>
      <td><span class="tag ${m.status === 'active' ? 'green' : 'danger'}">${m.status === 'active' ? '正常' : '已停用'}</span></td>
      <td class="money">${yuan(m.balanceFen)}</td>
      <td>${m.debtFen ? `<span class="warn">${yuan(m.debtFen)}</span>` : '-'}</td>
      <td><button class="sm plain" data-act="showMerchant" data-id="${escHtml(m.id)}">详情</button>
          <button class="sm ghost" data-act="toggleMerchant" data-id="${escHtml(m.id)}" data-p1="${escHtml(m.status)}">${m.status === 'active' ? '停用' : '启用'}</button>
          <button class="sm ghost" data-act="resetPassword" data-id="${escHtml(m.id)}">重置密码</button></td></tr>`).join('')
    || '<tr><td colspan="7"><div class="empty"><div class="e-icon">🏪</div>暂无商家</div></td></tr>';
  // 抽屉开着时同步刷新（停用 / 重置密码后状态要立刻反映）
  if (MD_CURRENT_ID && document.getElementById('merchantDrawer').classList.contains('on')) showMerchant(MD_CURRENT_ID);
}
/** 商家详情抽屉：承接从列表里移出的收款微信 / 券数 / 广告投放 / 坐标 / 最近登录 */
function showMerchant(id) {
  const m = MERCHANT_CACHE.find((x) => String(x.id) === String(id));
  if (!m) return toast('商家信息已过期，请刷新列表', 'err');
  MD_CURRENT_ID = String(id);
  const row = (k, v) => `<div class="kv"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  const lat = Number(m.lat); const lng = Number(m.lng);
  document.getElementById('mdTitle').textContent = m.name || '商家详情';
  document.getElementById('mdBody').innerHTML =
    row('商家 ID', escHtml(m.id)) +
    row('登录账号', escHtml(m.username || m.name) + (m.mustChangePassword ? ' <span class="tag orange">初始密码</span>' : '')) +
    row('联系人', escHtml(m.contact || '-')) +
    row('状态', `<span class="tag ${m.status === 'active' ? 'green' : 'danger'}">${m.status === 'active' ? '正常' : '已停用'}</span>`) +
    row('余额', `<b class="money">${yuan(m.balanceFen)}</b>`) +
    row('冻结中（提现）', yuan(m.withdrawFrozenFen)) +
    row('挂账（欠款）', m.debtFen ? `<span class="warn">${yuan(m.debtFen)}</span>` : '-') +
    row('收款微信', m.receiverBound ? `<span class="tag green">已绑定</span> ${escHtml(m.receiverName || '')}` : '<span class="tag danger">未绑定</span>') +
    row('券数', m.couponCount == null ? '-' : String(m.couponCount)) +
    row('广告投放', m.adBookings == null ? '-' : String(m.adBookings)) +
    row('门店坐标', Number.isFinite(lat) && Number.isFinite(lng)
      ? `<span class="tag green">已选点</span> ${lat.toFixed(4)},${lng.toFixed(4)}`
      : '<span class="tag orange">未选点（不进附近）</span>') +
    row('最近登录', escHtml(m.lastLoginAt || '-')) +
    `<div class="drawer-acts">
      <button class="sm ghost" data-act="toggleMerchant" data-id="${escHtml(m.id)}" data-p1="${escHtml(m.status)}">${m.status === 'active' ? '停用商家' : '启用商家'}</button>
      <button class="sm ghost" data-act="resetPassword" data-id="${escHtml(m.id)}">重置密码</button>
      <button class="sm plain" data-act="resetToken" data-id="${escHtml(m.id)}">重置 token</button>
    </div>`;
  document.getElementById('merchantDrawer').classList.add('on');
}
function closeMerchantDrawer() { closeDrawer('merchantDrawer'); MD_CURRENT_ID = ''; }
async function loadSettlement() {
  const id = document.getElementById('settleMerchantId').value.trim();
  const el = document.getElementById('settleResult');
  if (!id) { el.textContent = '请输入商家 ID'; return; }
  try {
    const d = await authed('/api/admin/merchants/settlement?merchantId=' + encodeURIComponent(id)).then((r) => r.json());
    if (d.error) { el.textContent = '查询失败：' + d.error; return; }
    // 后端 /api/admin/merchants/settlement 返回的是「元」字段（earnedBalanceYuan / earnedFrozenYuan /
    // adSpendYuan / withdrawAppliedYuan / ...ServiceFeeYuan），只有 withdrawDoneFen 是分；
    // 此前前端按 xxxFen 读取不存在的字段，冻结/广告/提现金额恒显示 ¥0.00。
    const toFen = (y) => Math.round(Number(y || 0) * 100);
    el.innerHTML = `<b>${escHtml(d.merchantId)}</b> ｜ ${escHtml(d.month || '')} 结算口径<br>
      已赚余额：<b class="money">${yuan(toFen(d.earnedBalanceYuan))}</b> ｜ 冻结中：${yuan(toFen(d.earnedFrozenYuan))} ｜ 广告花费：${yuan(toFen(d.adSpendYuan))}<br>
      提现申请：${yuan(toFen(d.withdrawAppliedYuan))} ｜ 提现已发放：${yuan(d.withdrawDoneFen || 0)} ｜ 订单流水：${d.orderFlowCount || 0} 笔<br>
      联盟核销：${d.allianceCount || 0} 单 · 核销金额 ${yuan(toFen(d.allianceAmountYuan))} · 券服务费 ${yuan(toFen(d.couponServiceFeeYuan))} · 核销服务费 ${yuan(toFen(d.verifyServiceFeeYuan))} · 服务费合计 <b class="money">${yuan(toFen(d.serviceFeeTotalYuan))}</b><br>
      <span class="muted">${escHtml(d.notice || '')}</span>`;
  } catch (e) { el.textContent = '查询失败：' + e.message; }
}
// ---------- 联盟服务单（V3.6） ----------
async function loadAlliance() {
  const d = await authed('/api/admin/alliance-orders').then((r) => r.json());
  const s = d.summary || {};
  document.getElementById('allianceSummary').innerHTML =
    ` 核销 ${s.count || 0} 单 · 消费额 <b class="money">${yuan(s.amountFen)}</b> · 服务费 ${yuan((s.couponServiceFeeFen || 0) + (s.verifyServiceFeeFen || 0))} · 佣金基数 ${yuan(s.baseFen)}`;
  document.querySelector('#alliance tbody').innerHTML = (d.list || []).map((a) =>
    `<tr><td class="muted">${escHtml(String(a.createdAt || '').slice(0, 16).replace('T', ' '))}</td><td>${escHtml(a.merchantName || a.merchantId)}</td><td>${escHtml(a.couponTitle || a.couponId)}</td>
      <td>${yuan(a.amountFen)}</td><td>${yuan(a.couponServiceFeeFen)}</td><td>${yuan(a.verifyServiceFeeFen)}</td><td>${yuan(a.baseFen)}</td></tr>`).join('')
    || '<tr><td colspan="7"><div class="empty"><div class="e-icon">🤝</div>暂无核销记录</div></td></tr>';
}
// ---------- 联盟服务费应收台账（V4.4：核销挂账 → 确认收款 → 才入账） ----------
async function loadFeeBills() {
  const merchantId = (document.getElementById('feeMerchantId').value || '').trim();
  const month = (document.getElementById('feeMonth').value || '').trim();
  const q = [];
  if (merchantId) q.push('merchantId=' + encodeURIComponent(merchantId));
  if (month) q.push('month=' + encodeURIComponent(month));
  const d = await authed('/api/admin/merchant-fee-bills' + (q.length ? '?' + q.join('&') : '')).then((r) => r.json());
  const s = d.summary || {};
  document.getElementById('feeSummary').innerHTML =
    ` 应缴 ${s.dueCount || 0} 笔 / <b class="money">${yuan(s.dueFen || 0)}</b> ｜ 已收 ${s.paidCount || 0} 笔 / <b class="money">${yuan(s.paidFen || 0)}</b> ｜ 累计服务费 ${yuan(s.grossFen || 0)}`;
  document.querySelector('#feeBills tbody').innerHTML = (d.list || []).map((b) => {
    const paid = b.status === 'paid';
    const diff = b.shortageFen > 0 ? `<span class="muted">（欠 ${yuan(b.shortageFen)}）</span>` : '';
    return `<tr>
      <td class="muted">${escHtml(String(b.createdAt || '').slice(0, 16).replace('T', ' '))}</td>
      <td>${escHtml(b.merchantName || b.merchantId)}</td>
      <td>${escHtml(b.couponTitle || '')}</td>
      <td>${yuan(b.amountFen || 0)}</td>
      <td><b class="money">${yuan(b.grossFeeFen || 0)}</b>${diff}</td>
      <td>${paid ? '<span class="tag green">已收</span>' : '<span class="tag orange">待收</span>'}</td>
      <td>${paid
        ? `<span class="muted">${escHtml(String(b.paidAt || '').slice(0, 10))}</span>`
        : `<button class="sm" onclick="payFeeBill('${escHtml(String(b.id))}')">标记已收</button>`}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="7"><div class="empty"><div class="e-icon">🧾</div>暂无应收账单（平台默认不向商家收取服务费，如需计费请在「参数设置」调整联盟费率）</div></td></tr>';
}

async function payFeeBill(id) {
  if (!confirm('确认已实际收到该笔服务费？确认后将计入平台收入并划入储备专户，同时解冻对应联盟分佣。')) return;
  const r = await post('/api/admin/merchant-fee-bills/pay', { billId: id });
  if (r.error) { alert('操作失败：' + r.error); return; }
  loadFeeBills();
  loadAlliance();
}

async function payFeeMonth() {
  const merchantId = (document.getElementById('feeMerchantId').value || '').trim();
  const month = (document.getElementById('feeMonth').value || '').trim();
  if (!merchantId) { alert('请先填写商家 ID（按月收款必须指定商家）'); return; }
  if (!confirm(`确认已收到该商家 ${month || '当月'} 的全部待收服务费？`)) return;
  const r = await post('/api/admin/merchant-fee-bills/pay-month', { merchantId, month });
  if (r.error) { alert('操作失败：' + r.error); return; }
  alert(`已确认 ${r.paidCount || 0} 笔，合计 ${yuan(r.receivedFen || 0)}`);
  loadFeeBills();
  loadAlliance();
}

async function createMerchant() {
  const name = document.getElementById('mchName').value.trim();
  const contact = document.getElementById('mchContact').value.trim();
  const username = document.getElementById('mchUsername').value.trim();
  const password = document.getElementById('mchPassword').value;
  const r = await post('/api/admin/merchants/create', { name, contact, username, password });
  if (r.error) { document.getElementById('mchCreateResult').textContent = '失败：' + r.error; return; }
  document.getElementById('mchCreateResult').textContent = '创建成功，凭据见弹窗。';
  showSecret('商家账号创建成功', [
    { label: '商家 ID', value: r.merchant.id },
    { label: '登录账号', value: r.merchant.username },
    { label: '初始密码', value: r.initialPassword },
  ], '请把「登录账号 + 初始密码」通过安全渠道转交商家，并提醒首次登录后立即改密。\n商家登录入口：微信打开「八方聚」小程序 → 底部「我的」→「商家服务」→「商家登录」；电脑端也可用浏览器打开 /merchant.html 登录。');
  document.getElementById('mchName').value = ''; document.getElementById('mchContact').value = ''; document.getElementById('mchUsername').value = ''; document.getElementById('mchPassword').value = '';
  loadMerchants();
}
async function resetPassword(id) {
  const pwd = prompt('设置新密码（留空自动生成，至少 6 位）：', '');
  if (pwd === null) return;
  const r = await post('/api/admin/merchants/reset-password', { merchantId: String(id), password: pwd.trim() });
  if (r.error) { toast('失败：' + r.error, 'err'); return; }
  showSecret('商家密码已重置', [
    { label: '账号', value: r.username },
    { label: '新密码', value: r.initialPassword },
  ], '原登录已失效。新密码仅本次展示，请复制后通过安全渠道转交商家。');
  loadMerchants();
}
async function toggleMerchant(id, status) {
  const to = status === 'active' ? 'disabled' : 'active';
  if (to === 'disabled' && !confirm(`确认为停用商家 ${id}？其登录与接口访问将立即失效。`)) return;
  const r = await post('/api/admin/merchants/status', { merchantId: id, status: to });
  r.error ? toast('失败：' + r.error, 'err') : toast(`已${to === 'active' ? '启用' : '停用'}`);
  loadMerchants();
}
async function resetToken(id) {
  if (!confirm(`确认为商家 ${id} 重置登录 token？该商家的现有会话（小程序端/H5端）将全部失效，需重新登录。`)) return;
  const r = await post('/api/admin/merchants/reset-token', { merchantId: id });
  if (r.error) { toast('失败：' + r.error, 'err'); }
  else showSecret('商家 token 已重置', [{ label: '新 token', value: r.token }], '该商家其他设备已全部下线，重新登录即可（小程序「我的」→ 商家服务，或浏览器 /merchant.html）。新 token 仅本次展示；仅 API 对接方需要，商家日常用账号密码登录。');
  loadMerchants();
}

