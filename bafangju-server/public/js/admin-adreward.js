// admin-adreward.js —— 广告中心 V4.2
// 视频广告计划（素材上传 / 计费联动 / 进度看板）+ 效果看板 + 商家额度 + 结算单 + 奖励提现审核
// 约定：列表按钮一律用 data-act + 顶层函数，由 admin-core.js 的全局分发器调用。
let ADV_PRODUCTS = [];
let ADV_MERCHANTS = [];
let ADV_VIDEOS = [];
let ADV_EDIT_ID = '';

// 广告中心拆成三个业务域，用页内 tab 切换（视频激励 / 轮播广告位 / 任务奖励）
function switchAdZone(zone) {
  document.querySelectorAll('#adCenterTabs .tr-item').forEach((x) => x.classList.toggle('on', x.dataset.zone === zone));
  document.querySelectorAll('#pane-adCenter .ad-zone').forEach((z) => z.classList.toggle('on', z.dataset.zone === zone));
}
document.querySelectorAll('#adCenterTabs .tr-item').forEach((it) => it.onclick = () => switchAdZone(it.dataset.zone));

async function loadAdRewardPane() {
  switchAdZone('video'); // 从侧栏进入时固定落在主业务域，避免停在上次看的配置页
  await ensureAdRewardRefs();
  loadAdVideos();
  loadAdStats();
  loadAdQuotas();
  loadAdSettlements();
  // 额度发放仅总账号可操作；子管理员只看额度表，代投时用于判断可用额度
  const qc = document.getElementById('advQuotaCard');
  if (qc && typeof MY !== 'undefined' && MY.role !== 'super') {
    const grantRow = document.getElementById('advQuotaGrantRow');
    const readRow = document.getElementById('advQuotaReadOnlyRow');
    if (grantRow) grantRow.style.display = 'none';
    if (readRow) readRow.style.display = '';
  }
}

/** 商品 / 商家下拉一次拉齐，复用到建号、素材编辑、额度发放、效果筛选 */
async function ensureAdRewardRefs() {
  if (ADV_PRODUCTS.length && ADV_MERCHANTS.length) return;
  try {
    const [v, ms] = await Promise.all([
      authed('/api/admin/advideos').then((r) => r.json()),
      authed('/api/admin/merchants').then((r) => r.json()).catch(() => ({})),
    ]);
    ADV_PRODUCTS = v.products || [];
    const list = ms.merchants || ms || [];
    ADV_MERCHANTS = Array.isArray(list) ? list : [];
    const prodOpts = '<option value="">不跳转</option>'
      + ADV_PRODUCTS.map((p) => `<option value="${escHtml(p.id)}">${escHtml(p.title || p.id)}</option>`).join('');
    ['advProduct', 'edProduct'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = prodOpts;
    });
    const mOpts = ADV_MERCHANTS.map((m) => `<option value="${escHtml(m.id)}">${escHtml(m.name || m.id)}</option>`).join('')
      || '<option value="">（暂无商家）</option>';
    ['advMerchant', 'quotaMerchant'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = mOpts;
    });
    const sf = document.getElementById('advStatMerchant');
    if (sf) sf.innerHTML = '<option value="">全部商家</option>' + mOpts;
  } catch (e) { /* 下拉失败不阻塞列表 */ }
}

/* ==================== 素材上传（A） ==================== */

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('文件读取失败'));
    r.readAsDataURL(file);
  });
}

/** 浏览器本地读视频元数据，自动回填时长，不依赖服务器装 ffmpeg */
function probeVideoDuration(src) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => resolve(v.duration || 0);
    v.onerror = () => reject(new Error('无法解析视频时长'));
    v.src = src;
  });
}

function pickAdvVideo() { document.getElementById('advVideoFile').click(); }
function pickAdvCover() { document.getElementById('advCoverFile').click(); }

async function uploadAdvVideo(input) {
  const f = input.files && input.files[0];
  if (!f) return;
  const box = document.getElementById('advMediaPreview');
  if (f.size > 24 * 1024 * 1024) { toast('视频不能超过 24MB', 'err'); input.value = ''; return; }
  box.textContent = '正在上传并解析视频…';
  try {
    const dataBase64 = await readAsDataURL(f);
    const dur = await probeVideoDuration(dataBase64).catch(() => 0);
    if (dur) document.getElementById('advDur').value = Math.max(5, Math.min(600, Math.round(dur)));
    const r = await post('/api/admin/upload/video', { dataBase64 });
    if (r.error) throw new Error(r.error);
    document.getElementById('advVideo').value = r.url;
    box.innerHTML = `<div class="media-preview"><span>视频已上传：<b>${escHtml(f.name)}</b>（${(f.size / 1048576).toFixed(1)}MB${dur ? ' · ' + Math.round(dur) + ' 秒' : ''}），时长已自动填入。继续上传封面或填写投放参数。</span></div>`;
    toast('视频上传成功');
  } catch (e) {
    box.textContent = '上传失败：' + e.message;
    toast('上传失败：' + e.message, 'err');
  }
  input.value = '';
}

async function uploadAdvCover(input) {
  const f = input.files && input.files[0];
  if (!f) return;
  const box = document.getElementById('advMediaPreview');
  if (f.size > 4 * 1024 * 1024) { toast('封面不能超过 4MB', 'err'); input.value = ''; return; }
  box.textContent = '正在上传封面…';
  try {
    const dataBase64 = await readAsDataURL(f);
    const r = await post('/api/admin/upload', { dataBase64, purpose: 'material' });
    if (r.error) throw new Error(r.error);
    document.getElementById('advCover').value = r.url;
    box.innerHTML = `<div class="media-preview"><img src="${escHtml(r.url)}" alt="封面预览"><span>封面已上传并填入路径，用户端广告卡片将显示这张图。</span></div>`;
    toast('封面上传成功');
  } catch (e) {
    box.textContent = '上传失败：' + e.message;
    toast('上传失败：' + e.message, 'err');
  }
  input.value = '';
}

/* ==================== 计费联动与建计划 ==================== */

async function previewAdPricing() {
  const el = document.getElementById('advPricing');
  const budgetYuan = parseFloat(document.getElementById('advBudget').value);
  const chargeYuan = parseFloat(document.getElementById('advCharge').value);
  if (!(budgetYuan > 0) || !(chargeYuan > 0)) { el.textContent = '填写总预算与单 IP 费用后，这里实时显示：所需 IP 数 / 完播可得贡献值 / 预计预算支出 / 平台留存'; return; }
  try {
    const d = await authed(`/api/admin/advideos/pricing-preview?budgetFen=${Math.round(budgetYuan * 100)}&chargePerIpFen=${Math.round(chargeYuan * 100)}`).then((r) => r.json());
    if (d.error) { el.textContent = '预览失败：' + d.error; return; }
    const spend = d.rewardPerIpFen * d.targetIpCount;
    el.innerHTML = `联动计算 → 所需 IP 数 <b>${d.targetIpCount}</b> ｜ 完播可得贡献值 <b>${Math.max(1, Math.round(d.rewardPerIpFen))} 点</b>（分成 ${Math.round(d.shareRate * 100)}%）｜ 预计预算支出 <b>${yuan(spend)}</b> ｜ 平台留存约 <b>${yuan(Math.max(0, Math.round(budgetYuan * 100) - spend))}</b>`;
  } catch (e) { el.textContent = '预览失败：' + e.message; }
}
document.addEventListener('input', (e) => {
  if (['advBudget', 'advCharge'].includes(e.target.id)) previewAdPricing();
});

async function createAdVideo() {
  const body = {
    merchantId: document.getElementById('advMerchant').value,
    title: document.getElementById('advTitle').value.trim(),
    videoUrl: document.getElementById('advVideo').value.trim(),
    coverUrl: document.getElementById('advCover').value.trim(),
    durationS: parseInt(document.getElementById('advDur').value, 10),
    productId: document.getElementById('advProduct').value || '',
    budgetFen: Math.round(parseFloat(document.getElementById('advBudget').value) * 100),
    chargePerIpFen: Math.round(parseFloat(document.getElementById('advCharge').value) * 100),
    dailyCap: parseInt(document.getElementById('advCap').value, 10),
  };
  if (!body.merchantId) return toast('请选择商家', 'err');
  if (!body.videoUrl) return toast('请先上传视频', 'err');
  const r = await post('/api/admin/advideos/create', body);
  if (r.error) return toast('创建失败：' + r.error, 'err');
  toast(`已创建（待审核）：需 ${r.video.targetIpCount} 个 IP，完播可得 ${Math.max(1, Math.round(r.video.rewardPerIpFen))} 贡献值`);
  ['advTitle', 'advVideo', 'advCover', 'advBudget', 'advCharge'].forEach((id) => { document.getElementById(id).value = ''; });
  document.getElementById('advMediaPreview').textContent = '上传视频后自动读取时长并生成预览；封面建议 16:9，未上传时用户端显示默认占位';
  previewAdPricing();
  loadAdVideos(); loadAdQuotas(); loadOverview();
}

/* ==================== 计划列表与投放操作（A） ==================== */

const ADV_STATUS = {
  draft: ['待审核', 'orange'], active: ['在投', 'green'], sold_out: ['已抢完', ''],
  rejected: ['已驳回', 'danger'], offline: ['已下架', ''], settled: ['已结算', 'blue'],
};

async function loadAdVideos() {
  const data = await authed('/api/admin/advideos').then((r) => r.json());
  ADV_VIDEOS = data.videos || [];
  document.querySelector('#adVideos tbody').innerHTML = ADV_VIDEOS.map((v) => {
    const [st, sc] = ADV_STATUS[v.status] || [v.status, ''];
    const prog = `<div class="prog"><div class="p-track"><div class="p-fill" style="width:${v.ipProgressPercent}%"></div></div><span class="p-num">${v.claimedIpCount}/${v.targetIpCount}</span></div>`;
    const cover = v.coverUrl
      ? `<img class="adv-thumb" src="${escHtml(v.coverUrl)}" alt="">`
      : '<span class="adv-thumb-ph">▶</span>';
    const ops = [];
    if (v.status === 'draft') ops.push(`<button class="sm" data-act="advReview" data-id="${escHtml(v.id)}" data-p1="true">通过</button><button class="sm ghost" data-act="advReview" data-id="${escHtml(v.id)}" data-p1="false">驳回</button>`);
    if (v.status === 'active') ops.push(`<button class="sm ghost" data-act="advOffline" data-id="${escHtml(v.id)}">下架</button>`);
    if (['draft', 'rejected'].includes(v.status)) ops.push(`<button class="sm plain" data-act="advEdit" data-id="${escHtml(v.id)}">改素材</button>`);
    if (['active', 'sold_out'].includes(v.status)) ops.push(`<button class="sm plain" data-act="advAppend" data-id="${escHtml(v.id)}">追加</button>`);
    if (['active', 'sold_out', 'offline'].includes(v.status)) ops.push(`<button class="sm plain" data-act="advSettle" data-id="${escHtml(v.id)}">结算</button>`);
    // 10 列 → 6 列：合并商家/跳转、投放参数（费用/贡献值/目标IP）、进度+预算
    const targetIp = v.targetIpCount + (v.estDays ? `（约 ${v.estDays} 天投完）` : '');
    const paramsCell = `<span class="muted" style="font-size:11px">每IP ${yuan(v.chargePerIpFen)} · 完播 <b>${v.rewardPoints || Math.max(1, Math.round(v.rewardPerIpFen))} 点</b> · 目标 ${targetIp}</span>`;
    const budgetCell = `${prog}<div class="muted" style="font-size:11px">已耗 ${yuan(v.spentFen)} · 剩余 <b class="money">${yuan(v.budgetLeftFen)}</b></div>`;
    return `<tr>
      <td>${cover}<b>${escHtml(v.title)}</b><div class="muted" style="font-size:11px">${v.durationS}s · ${escHtml(v.videoUrl)}</div></td>
      <td><b>${escHtml(v.merchantName)}</b><div class="muted" style="font-size:11px">${v.productTitle ? '跳 → ' + escHtml(v.productTitle) : '不跳转'}</div></td>
      <td>${paramsCell}</td>
      <td style="min-width:160px">${budgetCell}</td>
      <td><span class="tag ${sc}">${st}</span>${v.reviewNote ? `<div class="muted" style="font-size:11px">${escHtml(v.reviewNote)}</div>` : ''}</td>
      <td>${ops.join(' ')}</td></tr>`;
  }).join('') || '<tr><td colspan="6"><div class="empty"><div class="e-icon">📺</div>暂无广告计划，先在上方上传视频并创建</div></td></tr>';
}

/** 审核通过 / 驳回（由全局 data-act 分发器调用） */
function advReview(id, approved) {
  let note = '';
  if (!approved) { note = prompt('驳回原因（必填，商家可看到）：') || ''; if (!note) return; }
  post('/api/admin/advideos/review', { videoId: id, approved: !!approved, note }).then((x) => {
    x.error ? toast('失败：' + x.error, 'err') : toast(approved ? '已通过，开始投放' : '已驳回');
    loadAdVideos();
    if (!x.error) { loadAdQuotas(); loadOverview(); }
  });
}

function advOffline(id) {
  if (!confirm('确认下架该广告？下架后立即停止发放。')) return;
  post('/api/admin/advideos/offline', { videoId: id }).then((r) => {
    r.error ? toast('失败：' + r.error, 'err') : toast('已下架');
    loadAdVideos();
  });
}

function advEdit(id) {
  const v = ADV_VIDEOS.find((x) => String(x.id) === String(id));
  if (!v) return;
  ADV_EDIT_ID = String(id);
  document.getElementById('edTitle').value = v.title || '';
  document.getElementById('edVideo').value = v.videoUrl || '';
  document.getElementById('edCover').value = v.coverUrl || '';
  document.getElementById('edDur').value = v.durationS || 30;
  document.getElementById('edProduct').value = v.productId || '';
  const box = document.getElementById('advEditBox');
  box.style.display = '';
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function closeAdvEdit() {
  ADV_EDIT_ID = '';
  document.getElementById('advEditBox').style.display = 'none';
}

async function saveAdvMaterial() {
  if (!ADV_EDIT_ID) return;
  const body = {
    videoId: ADV_EDIT_ID,
    title: document.getElementById('edTitle').value.trim(),
    videoUrl: document.getElementById('edVideo').value.trim(),
    coverUrl: document.getElementById('edCover').value.trim(),
    durationS: parseInt(document.getElementById('edDur').value, 10),
    productId: document.getElementById('edProduct').value || '',
  };
  const r = await post('/api/admin/advideos/material', body);
  if (r.error) return toast('保存失败：' + r.error, 'err');
  toast('素材已更新，驳回计划自动回到待审核');
  closeAdvEdit();
  loadAdVideos(); loadAdQuotas(); loadOverview();
}

function advAppend(id) {
  const s = prompt('追加预算（元）：\n追加后自动重算所需 IP 数，已抢完的计划可恢复投放。');
  const n = parseFloat(s);
  if (!(n > 0)) return;
  post('/api/admin/advideos/append-budget', { videoId: id, amountFen: Math.round(n * 100) }).then((r) => {
    r.error ? toast('追加失败：' + r.error, 'err') : toast(`已追加，所需 IP 更新为 ${r.video.targetIpCount}`);
    loadAdVideos();
  });
}

function advSettle(id) {
  if (!confirm('确认结算？未消耗预算将退回商家可用额度，结算后该计划不可再投放。')) return;
  post('/api/admin/advideos/settle', { videoId: id }).then((r) => {
    if (r.error) return toast('结算失败：' + r.error, 'err');
    toast(`已结算，应退商家 ${yuan(r.settlement.refundFen)}`);
    loadAdVideos(); loadAdSettlements(); loadAdQuotas();
  });
}

function advFocusStats() {
  const el = document.getElementById('advStatTable');
  if (el) { loadAdStats(); el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
}

/* ==================== 效果看板（B） ==================== */

function statItem(num, lab) {
  return `<div class="s-item"><div class="s-num">${num}</div><div class="s-lab">${lab}</div></div>`;
}

async function loadAdStats() {
  const d = await authed('/api/admin/advideos/stats').then((r) => r.json());
  const mid = document.getElementById('advStatMerchant').value;
  const rows = (d.rows || []).filter((r) => !mid || String(r.merchantId) === String(mid));
  const sum = (k) => rows.reduce((s, r) => s + (r[k] || 0), 0);
  const t = {
    expose: sum('expose'), click: sum('click'), completed: sum('completed'),
    orders: sum('orders'), spentFen: sum('spentFen'), orderAmountFen: sum('orderAmountFen'),
  };
  document.getElementById('advStatTotal').innerHTML = [
    statItem(rows.length, '广告计划'), statItem(t.expose, '曝光'), statItem(t.click, '点击'),
    statItem(t.completed, '完播'), statItem(t.orders, '带来下单'),
    statItem(yuan(t.orderAmountFen), '下单金额'), statItem(yuan(t.spentFen), '预算消耗'),
  ].join('');
  document.querySelector('#advStatTable tbody').innerHTML = rows.map((r) => `<tr>
    <td>${escHtml(r.title)}<div class="muted" style="font-size:11px">${escHtml(r.merchantName)}</div></td>
    <td>${r.expose}</td><td>${r.click}</td><td>${r.ctrPercent}%</td>
    <td>${r.completed}</td><td>${r.completePercent}%</td><td>${r.productClick}</td>
    <td>${r.orders}</td><td class="money">${yuan(r.orderAmountFen)}</td><td class="money">${yuan(r.spentFen)}</td></tr>`).join('')
    || '<tr><td colspan="10"><div class="empty">暂无数据</div></td></tr>';
}

async function exportAdStats() {
  try {
    const r = await authed('/api/admin/advideos/stats.csv');
    if (!r.ok) throw new Error('导出失败');
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '广告效果对账单.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (e) { toast('导出失败：' + e.message, 'err'); }
}

/* ==================== 商家额度（C） ==================== */

async function loadAdQuotas() {
  const d = await authed('/api/admin/ad-quotas').then((r) => r.json()).catch(() => ({}));
  if (d.error) return;
  document.querySelector('#adQuotas tbody').innerHTML = (d.quotas || []).map((q) => `<tr>
    <td>${escHtml(q.merchantName)}</td><td class="money">${yuan(q.grantedFen)}</td>
    <td class="money">${yuan(q.usedFen)}</td><td class="money">${yuan(q.frozenFen)}</td>
    <td class="money"><b>${yuan(q.availableFen)}</b></td><td>${q.planCount}</td><td>${q.slotBookingCount || 0}</td></tr>`).join('')
    || '<tr><td colspan="7"><div class="empty">尚未给任何商家发放广告额度</div></td></tr>';
}

async function grantAdQuota() {
  const merchantId = document.getElementById('quotaMerchant').value;
  const y = parseFloat(document.getElementById('quotaYuan').value);
  if (!merchantId) return toast('请选择商家', 'err');
  if (!(y > 0)) return toast('请填写发放额度', 'err');
  if (!confirm(`确认给该商家发放 ${y.toFixed(2)} 元广告额度？\n请确认已收到线下款项。`)) return;
  const r = await post('/api/admin/ad-quotas/grant', {
    merchantId, fen: Math.round(y * 100), note: document.getElementById('quotaNote').value.trim(),
  });
  const el = document.getElementById('quotaResult');
  if (r.error) { el.textContent = '失败：' + r.error; return toast('发放失败：' + r.error, 'err'); }
  el.textContent = `已发放，当前可用 ${yuan(r.quota.availableFen)}`;
  document.getElementById('quotaYuan').value = '';
  document.getElementById('quotaNote').value = '';
  toast('额度已发放，商家端可立即使用');
  loadAdQuotas();
}

/* ==================== 结算单（A） ==================== */

async function loadAdSettlements() {
  const d = await authed('/api/admin/advideos/settlements').then((r) => r.json());
  document.querySelector('#adSettlements tbody').innerHTML = (d.settlements || []).map((s) => `<tr>
    <td class="muted">${escHtml(s.videoId)}</td><td>${escHtml(s.merchantName)}</td>
    <td class="money">${yuan(s.budgetFen)}</td><td class="money">${yuan(s.spentFen)}</td>
    <td class="money"><b>${yuan(s.refundFen)}</b></td><td class="muted">${escHtml(s.settledAt)}</td>
    <td><span class="tag ${s.status === 'refunded' ? 'green' : 'orange'}">${s.status === 'refunded' ? '已退款' : '待退款'}</span></td>
    <td>${s.status === 'pending_refund' ? `<button class="sm plain" data-act="advSettlementRefunded" data-id="${escHtml(s.id)}">标记已退</button>` : '-'}</td></tr>`).join('')
    || '<tr><td colspan="8"><div class="empty">暂无结算单，计划投放结束后点「结算」生成</div></td></tr>';
}

function advSettlementRefunded(id) {
  if (!confirm('确认已通过线下渠道把应退款项打给商家？')) return;
  post('/api/admin/advideos/settlements/refunded', { settlementId: id }).then((r) => {
    r.error ? toast('失败：' + r.error, 'err') : toast('已标记退款完成');
    loadAdSettlements();
  });
}

/* ==================== 奖励提现审核（存量余额兑付） ==================== */

const RW_STATUS = {
  pending_review: ['待初审', 'orange'], pending_offline: ['待线下打款', 'blue'],
  approved: ['待复核打款', 'blue'], paid: ['已打款', 'green'], rejected: ['已驳回', 'danger'], failed: ['打款失败', 'danger'],
};

/** 第二人复核身份判定：总账号天然具备，子管理员须显式授予 finance */
function canFinanceReview() {
  if (typeof MY === 'undefined') return false;
  if (MY.role === 'super' || MY.permissions === 'all') return true;
  return Array.isArray(MY.permissions) && MY.permissions.includes('finance');
}

/** 同一账号判定：优先不可变 uid，历史数据缺 uid 时退化为用户名 */
function isSameAdmin(byId, byName) {
  if (typeof MY === 'undefined') return false;
  if (MY.uid && byId) return MY.uid === byId;
  return !!(MY.username && byName && MY.username === byName);
}

/** 线下打款时间输入框默认值（YYYY-MM-DD HH:mm，后端接受该格式） */
function nowLocalInput() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function loadRewardWithdrawals() {
  const data = await authed('/api/admin/reward-withdrawals').then((r) => r.json());
  const switchOn = !!data.switchOn;
  const notice = document.getElementById('rwSwitchNotice');
  if (notice) {
    notice.style.display = switchOn ? 'none' : '';
    notice.textContent = switchOn ? '' : '广告奖励提现（adRewardEnabled）已关闭：不再接受新增提现申请。存量待审单请走「登记线下打款 → 第二位管理员复核发放」；关闭期间线上初审与复核打款两步均不可用，线下复核通道保持可用。';
  }
  const canReview = canFinanceReview();
  document.querySelector('#rewardWithdrawals tbody').innerHTML = (data.withdrawals || []).map((w) => {
    const [st, sc] = RW_STATUS[w.status] || [w.status, ''];
    const ops = [];
    if (w.status === 'pending_review') {
      // 开关关闭时线上初审/驳回入口不可用，仅保留独立的线下打款通道（H2：线上两步均停用）
      if (switchOn) {
        ops.push(`<button class="sm" data-act="rwApprove" data-id="${escHtml(w.id)}">初审通过</button>`);
        ops.push(`<button class="sm ghost" data-act="rwReject" data-id="${escHtml(w.id)}">驳回</button>`);
      }
      ops.push(`<button class="sm ghost" data-act="rwOfflineMark" data-id="${escHtml(w.id)}">登记线下打款</button>`);
    } else if (w.status === 'approved') {
      // H2 第二步：仅财务复核角色 / 总账号可打款；开关关闭时线上打款同样不可用
      if (switchOn) {
        const label = w.lastPayError ? '重试复核打款' : '复核打款';
        ops.push(canReview
          ? `<button class="sm" data-act="rwPay" data-id="${escHtml(w.id)}">${label}</button>`
          : `<button class="sm" disabled title="仅「财务复核」角色或总账号可复核打款">复核打款</button>`);
      }
    } else if (w.status === 'pending_offline') {
      const self = isSameAdmin(w.offlineMarkedById, w.offlineMarkedBy);
      if (!canReview) {
        ops.push('<button class="sm" disabled title="仅「财务复核」角色或总账号可复核发放">复核发放</button>');
      } else if (self) {
        ops.push('<button class="sm" disabled title="登记人不能自审，请由第二位管理员复核">复核发放</button>');
      } else {
        ops.push(`<button class="sm" data-act="rwOfflineConfirm" data-id="${escHtml(w.id)}">复核发放</button>`);
      }
    }
    const offline = [
      w.offlineVoucherNo ? `凭证 ${escHtml(w.offlineVoucherNo)}` : '',
      w.offlinePaidAt ? `打款 ${escHtml(String(w.offlinePaidAt).slice(0, 16).replace('T', ' '))}` : '',
      w.offlineMarkedBy ? `登记 ${escHtml(w.offlineMarkedBy)}` : '',
      w.offlineConfirmedBy ? `复核 ${escHtml(w.offlineConfirmedBy)}` : '',
    ].filter(Boolean).map((s) => `<div class="muted" style="font-size:11px">${s}</div>`).join('');
    const dim = !switchOn && w.status === 'pending_review' ? ' style="opacity:.55"' : '';
    return `<tr${dim}>
      <td class="muted">${escHtml(w.id)}</td>
      <td>${escHtml(w.userNickname || w.userId)}<div class="muted" style="font-size:11px">${escHtml(w.userId)}</div></td>
      <td>${escHtml(w.realnameName || '-')}<div class="muted" style="font-size:11px">${escHtml(w.realnameMasked || '')}</div></td>
      <td class="money">${yuan(w.fen)}</td>
      <td class="money">${yuan(w.taxFen)}</td>
      <td class="money">${w.paidFen ? yuan(w.paidFen) : '-'}</td>
      <td><span class="tag ${sc}">${st}</span>${w.transferNo ? `<div class="muted" style="font-size:11px">${escHtml(w.transferNo)}</div>` : ''}${w.reviewedBy ? `<div class="muted" style="font-size:11px">初审 ${escHtml(w.reviewedBy)}</div>` : ''}${w.paidBy ? `<div class="muted" style="font-size:11px">打款 ${escHtml(w.paidBy)}</div>` : ''}${offline}${w.lastPayError ? `<div style="font-size:11px;color:#C0392B">${escHtml(w.lastPayError)}</div>` : ''}${w.reviewNote ? `<div class="muted" style="font-size:11px">${escHtml(w.reviewNote)}</div>` : ''}</td>
      <td class="muted">${escHtml(w.appliedAt)}</td>
      <td>${ops.join(' ') || '-'}</td></tr>`;
  }).join('') || '<tr><td colspan="9"><div class="empty"><div class="e-icon">💰</div>暂无奖励提现申请</div></td></tr>';
}

function rwApprove(id) {
  if (!confirm('确认初审通过？本步只确认材料，不动资金、不调转账通道。\n通过后须由第二位具备「财务复核」权限的管理员复核打款。')) return;
  post('/api/admin/reward-withdrawals/approve', { withdrawalId: id }).then((r) => {
    if (r.error) return toast('失败：' + r.error, 'err');
    toast('初审通过，等待第二位管理员复核打款');
    loadRewardWithdrawals();
  });
}

function rwPay(id) {
  if (!confirm('确认复核并打款？本步将调用真实转账通道并置为已发放，请再次核对收款人与金额。')) return;
  post('/api/admin/reward-withdrawals/pay', { withdrawalId: id }).then((r) => {
    if (r.error) {
      // 通道未返回有效流水号时提现单保持「待复核打款」，可修正后重试
      toast('失败：' + r.error, 'err');
      loadRewardWithdrawals();
      return;
    }
    r.withdrawal.status === 'paid'
      ? toast(`已打款 ${yuan(r.withdrawal.paidFen)}（单号 ${r.withdrawal.transferNo}）`)
      : toast('打款失败：' + (r.withdrawal.failReason || ''), 'err');
    loadRewardWithdrawals();
  });
}

function rwReject(id) {
  const note = prompt('驳回原因（必填，将通知用户）：') || '';
  if (!note) return;
  post('/api/admin/reward-withdrawals/reject', { withdrawalId: id, note }).then((r) => {
    r.error ? toast('失败：' + r.error, 'err') : toast('已驳回，资金退回用户余额');
    loadRewardWithdrawals();
  });
}

function rwOfflineMark(id) {
  const voucherNo = (prompt('线下打款凭证号（银行/微信转账单号，必填）：') || '').trim();
  if (!voucherNo) return toast('凭证号必填，未登记', 'err');
  const paidAt = (prompt('实际打款时间（YYYY-MM-DD HH:mm，必填）：', nowLocalInput()) || '').trim();
  if (!paidAt) return toast('打款时间必填，未登记', 'err');
  const note = (prompt('备注（选填）：') || '').trim();
  post('/api/admin/reward-withdrawals/offline-mark', { withdrawalId: id, voucherNo, paidAt, note }).then((r) => {
    if (r.error) return toast('失败：' + r.error, 'err');
    toast('已登记线下打款，待第二位管理员复核');
    loadRewardWithdrawals();
  });
}

function rwOfflineConfirm(id) {
  if (!confirm('确认线下打款已到账？复核后置为「已发放」并写入资金流水。\n登记人不能自审，须由第二个管理员复核。')) return;
  post('/api/admin/reward-withdrawals/offline-confirm', { withdrawalId: id }).then((r) => {
    if (r.error) return toast('失败：' + r.error, 'err');
    toast('复核通过，已置为已发放并写入资金流水');
    loadRewardWithdrawals();
  });
}
