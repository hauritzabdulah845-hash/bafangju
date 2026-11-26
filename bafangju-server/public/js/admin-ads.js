// admin-ads.js —— 广告与任务（广告位配置 / 平台代投 / 历史投放审核 / 任务奖励）
// ==================== 广告与任务 ====================
let AD_SLOT_QUOTAS = [];
let AD_SLOT_PRODUCTS = [];
let AD_SLOT_SUBMITTING = false;
async function loadAds() {
  const d = await authed('/api/admin/adslots').then((r) => r.json());
  const c = await authed('/api/admin/task-config').then((r) => r.json()).catch(() => ({}));
  const r = c.rewards || {};
  document.getElementById('trSign').value = r.sign_in ?? 10;
  document.getElementById('trBrowse').value = r.browse ?? 5;
  document.getElementById('trAd').value = r.ad ?? 15;
  document.getElementById('trShare').value = r.share ?? 10;
  document.getElementById('trDays').value = (c.streakBonus || {}).days ?? 30;
  document.getElementById('trBonus').value = (c.streakBonus || {}).reward ?? 80;
  document.getElementById('trAdEnabled').checked = c.adTaskEnabled === true;
  const sel = document.getElementById('slotPos');
  if (sel && sel.options.length === 0) {
    sel.innerHTML = (d.positions || []).map((p) => `<option value="${p.key}">${escHtml(p.label)}</option>`).join('');
  }
  await loadSlotBookingRefs(d.slots || []);
  document.querySelector('#adSlotList tbody').innerHTML = (d.slots || []).map((s) =>
    `<tr><td class="muted">${s.id}</td><td>${escHtml(s.name)}</td><td>${escHtml(s.positionLabel)}</td><td>${s.minDays} 天</td><td class="money">${yuan(s.feePerCycleFen)}</td>
      <td><span class="tag ${s.status === 'available' ? 'green' : 'orange'}">${s.status === 'available' ? '可投放' : '占用中'}</span></td>
      <td class="muted">${s.booking ? escHtml(s.booking.title + ' · ' + (s.booking.reviewStatus === 'pending' ? '待审核' : '投放中')) : '-'}</td></tr>`).join('')
    || '<tr><td colspan="7"><div class="empty"><div class="e-icon">📣</div>暂无广告位</div></td></tr>';
  document.querySelector('#adPending tbody').innerHTML = (d.pending || []).map((b) =>
    `<tr><td class="muted">${b.id}</td><td>${escHtml(b.merchantName)}</td><td>${escHtml(b.slotName)}</td><td>${escHtml(b.title || '-')}</td>
      <td>${b.imageUrl ? `<a href="${escHtml(b.imageUrl)}" target="_blank" title="查看大图"><img src="${escHtml(b.imageUrl)}" alt="投放素材" style="width:125px;height:50px;object-fit:cover;border-radius:4px;display:block;border:1px solid #eee"></a>` : '<span class="muted">纯文字</span>'}</td>
      <td>${b.days}</td><td class="money">${yuan(b.feeFen)}</td>
      <td><button class="sm" data-act="reviewAd" data-id="${escHtml(b.id)}" data-p1="true">通过</button> <button class="sm ghost" data-act="reviewAd" data-id="${escHtml(b.id)}" data-p1="false">驳回</button></td></tr>`).join('')
    || '<tr><td colspan="8"><div class="empty"><div class="e-icon">✅</div>暂无待审核投放</div></td></tr>';
  document.querySelector('#adActive tbody').innerHTML = (d.active || []).map((b) =>
    `<tr><td>${escHtml(b.merchantName)}</td><td>${escHtml(b.slotName)}</td><td>${escHtml(b.title || '-')}</td>
      <td class="muted">${escHtml(String(b.startAt || '').slice(0, 10))} ~ ${escHtml(String(b.endAt || '').slice(0, 10))}</td>
      <td>${b.impressionCount}</td><td>${b.clickCount}</td><td>${b.ctrPercent}%</td></tr>`).join('')
    || '<tr><td colspan="7"><div class="empty"><div class="e-icon">📈</div>暂无投放中广告</div></td></tr>';
  const s = d.summary || {};
  document.getElementById('adSummary').innerHTML =
    `投放 ${s.bookings || 0} 单 · 广告费 <b class="money">${yuan(s.spendFen)}</b> · 曝光 ${s.impressions || 0} · 点击 ${s.clicks || 0} · 点击率 ${s.ctrPercent || 0}%`;
}
async function saveTaskConfig() {
  const body = {
    rewards: {
      sign_in: Number(document.getElementById('trSign').value),
      browse: Number(document.getElementById('trBrowse').value),
      ad: Number(document.getElementById('trAd').value),
      share: Number(document.getElementById('trShare').value),
    },
    streakBonus: { days: Number(document.getElementById('trDays').value), reward: Number(document.getElementById('trBonus').value) },
    adTaskEnabled: document.getElementById('trAdEnabled').checked,
  };
  const r = await authed('/api/admin/task-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json());
  r.error ? toast('失败：' + r.error, 'err') : (document.getElementById('trResult').textContent = '已保存并生效', toast('任务奖励已保存'));
  if (!r.error) loadAds();
}
async function createSlot() {
  const body = {
    name: document.getElementById('slotName').value.trim(),
    position: document.getElementById('slotPos').value,
    minDays: parseInt(document.getElementById('slotMinDays').value, 10) || 7,
    feeYuan: Number(document.getElementById('slotFee').value),
  };
  const r = await post('/api/admin/adslots/create', body);
  r.error ? toast('失败：' + r.error, 'err') : toast('已创建');
  if (!r.error) { document.getElementById('slotName').value = ''; document.getElementById('slotFee').value = ''; loadAds(); }
}
async function reviewAd(id, approved) {
  let note = '';
  if (!approved) {
    note = prompt('驳回原因（必填）：') || '';
    if (!note) return;
  }
  const r = await post('/api/admin/adslots/review', { bookingId: String(id), approved, note });
  r.error ? toast('失败：' + r.error, 'err') : toast(approved ? '已通过，开始计算投放期' : '已驳回，广告位已释放');
  loadAds(); loadOverview();
}

// ==================== 平台代投（V4.3 额度制） ====================
// 流程：商家线下打款 → 「视频广告激励」页发放额度 → 本面板代上轮播广告，创建即上线并冻结额度。
// 费用一律由服务端按 quoteBooking 计算，前端只做预览，提交不传费用。
let AD_SLOT_BOOKING = { slots: [], quotas: [], products: [], merchants: [] };

async function loadSlotBookingRefs(slots) {
  AD_SLOT_BOOKING.slots = slots || [];
  const [merchants, quotas, products] = await Promise.all([
    authed('/api/admin/merchants').then((r) => r.json()).catch(() => []),
    authed('/api/admin/ad-quotas').then((r) => r.json()).catch(() => ({ quotas: [] })),
    authed('/api/admin/catalog/products').then((r) => r.json()).catch(() => []),
  ]);
  AD_SLOT_BOOKING.merchants = Array.isArray(merchants) ? merchants.filter((m) => m.status === 'active') : [];
  AD_SLOT_BOOKING.quotas = (quotas && quotas.quotas) || [];
  AD_SLOT_BOOKING.products = Array.isArray(products) ? products : [];

  const mSel = document.getElementById('slotBookMerchant');
  if (mSel) {
    const cur = mSel.value;
    mSel.innerHTML = '<option value="">选择商家…</option>' + AD_SLOT_BOOKING.merchants
      .map((m) => `<option value="${escHtml(m.id)}">${escHtml(m.name)}</option>`).join('');
    if (cur) mSel.value = cur;
  }
  const sSel = document.getElementById('slotBookSlot');
  if (sSel) {
    const cur = sSel.value;
    const free = AD_SLOT_BOOKING.slots.filter((s) => s.status === 'available');
    sSel.innerHTML = '<option value="">选择广告位…</option>' + free
      .map((s) => `<option value="${escHtml(s.id)}">${escHtml(s.name)} · ${s.minDays} 天/期 · ${yuan(s.feePerCycleFen)}</option>`).join('');
    if (cur) sSel.value = cur;
    if (!free.length) sSel.innerHTML = '<option value="">暂无可用广告位</option>';
  }
  slotBookMerchantChanged();
  syncSlotBookSubmit();
}

/** 商家切换：显示该商家可用额度，并按商家过滤可跳转商品 */
function slotBookMerchantChanged() {
  const mid = (document.getElementById('slotBookMerchant') || {}).value || '';
  const q = AD_SLOT_BOOKING.quotas.find((x) => String(x.merchantId) === String(mid));
  const box = document.getElementById('slotBookQuota');
  if (box) {
    box.innerHTML = !mid
      ? '请选择商家；额度在「视频广告激励 → 商家额度」中发放。'
      : (q
        ? `可用额度 <b class="money">${yuan(q.availableFen)}</b>（已发放 ${yuan(q.grantedFen)} · 已消耗 ${yuan(q.usedFen)} · 冻结 ${yuan(q.frozenFen)}）`
        : '该商家暂无广告额度，请先在「视频广告激励」页确认收款并发放额度。');
  }
  const pSel = document.getElementById('slotBookProduct');
  if (pSel) {
    const mine = AD_SLOT_BOOKING.products.filter((p) => String(p.merchantId) === String(mid));
    pSel.innerHTML = '<option value="">选择商品…</option>' + mine
      .map((p) => `<option value="${escHtml(p.id)}">${escHtml(p.name)}（${yuan(p.priceFen)}）</option>`).join('');
  }
  previewSlotBooking();
}

/** 广告位切换：清空天数按最短档位回填，避免 minDays 倍数校验失败 */
function slotBookSlotChanged() {
  const sid = (document.getElementById('slotBookSlot') || {}).value || '';
  const s = AD_SLOT_BOOKING.slots.find((x) => String(x.id) === String(sid));
  const daysEl = document.getElementById('slotBookDays');
  if (daysEl && s) daysEl.value = s.minDays;
  previewSlotBooking();
}

/** 本端预览费用（服务端为准）：每期价格 × (天数 ÷ 最短投放天数) */
function previewSlotBooking() {
  const sid = (document.getElementById('slotBookSlot') || {}).value || '';
  const s = AD_SLOT_BOOKING.slots.find((x) => String(x.id) === String(sid));
  const days = parseInt((document.getElementById('slotBookDays') || {}).value, 10) || 0;
  const box = document.getElementById('slotBookPricing');
  if (box) {
    if (!s) box.textContent = '选择广告位与天数后预览费用；实际费用由服务端计算，提交时不传费用。';
    else if (!days || days <= 0) box.textContent = `该广告位最短投放 ${s.minDays} 天，天数需为 ${s.minDays} 的整数倍。`;
    else if (days % s.minDays !== 0) box.innerHTML = `<span style="color:#B02A30">天数需为 ${s.minDays} 的整数倍（当前 ${days} 天）</span>`;
    else box.innerHTML = `本次预计 <b class="money">${yuan(s.feePerCycleFen * (days / s.minDays))}</b>（${s.minDays} 天 ${yuan(s.feePerCycleFen)} × ${days / s.minDays} 期），提交后从商家额度冻结。`;
  }
  syncSlotBookSubmit();
}

/** 跳转类型切换：选商品时才显示商品下拉 */
function slotBookTargetChanged() {
  const t = (document.getElementById('slotBookTargetType') || {}).value || 'none';
  const f = document.getElementById('slotBookProductField');
  if (f) f.style.display = t === 'product' ? '' : 'none';
  syncSlotBookSubmit();
}

/** 代投素材：触发隐藏的 file input（避免内联表达式里出现 getElementById/click 等非函数名） */
function pickSlotBookImage() {
  const el = document.getElementById('slotBookImageFile');
  if (el) el.click();
}

/** 代投素材上传：读成 base64 → /api/admin/upload → 回填路径并预览 */
async function uploadSlotBookImage(input) {
  const file = input && input.files && input.files[0];
  if (!file) return;
  if (file.size > 4 * 1024 * 1024) { toast('图片不能超过 4MB', 'err'); input.value = ''; return; }
  const dataBase64 = await new Promise((res) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = () => res(null);
    fr.readAsDataURL(file);
  });
  input.value = '';
  if (!dataBase64) return toast('图片读取失败', 'err');
  const r = await post('/api/admin/upload', { dataBase64 });
  if (!r || r.error || !r.url) return toast('上传失败：' + ((r && r.error) || '未知错误'), 'err');
  document.getElementById('slotBookImage').value = r.url;
  const pv = document.getElementById('slotBookImagePreview');
  if (pv) {
    // 5:2 通栏预览（用户端首页轮播实际裁切口径），避免方图上传后被裁掉大半却看不出来
    pv.innerHTML = `<div style="margin-top:8px">
      <img src="${escHtml(r.url)}" alt="素材预览" style="width:240px;height:96px;object-fit:cover;border-radius:8px;display:block;border:1px solid #eee" onload="slotBookImgLoaded(this)">
      <div id="slotBookImgInfo" class="muted" style="font-size:11px;margin-top:4px"></div></div>`;
  }
  toast('素材已上传');
  syncSlotBookSubmit();
}

/** 素材比例自检：首页轮播通栏为 750×300rpx（5:2），比例不符会被 aspectFill 裁切 */
function slotBookImgLoaded(img) {
  const el = document.getElementById('slotBookImgInfo');
  if (!el || !img) return;
  const w = img.naturalWidth || 0; const h = img.naturalHeight || 0;
  if (!w || !h) return;
  const ratio = w / h;
  const ok = Math.abs(ratio - 2.5) < 0.06;
  el.textContent = `${w}×${h}（${ratio.toFixed(2)}:1）· ` + (ok ? '比例合规' : '建议 5:2（如 1125×450），当前比例会被裁切');
  el.style.color = ok ? '' : '#C2410C';
}

/** 提交前置校验：商家 / 广告位 / 天数 / 标题；通过才允许点提交 */
function slotBookValid() {
  const mid = (document.getElementById('slotBookMerchant') || {}).value || '';
  const sid = (document.getElementById('slotBookSlot') || {}).value || '';
  const s = AD_SLOT_BOOKING.slots.find((x) => String(x.id) === String(sid));
  const days = parseInt((document.getElementById('slotBookDays') || {}).value, 10) || 0;
  const title = ((document.getElementById('slotBookTitle') || {}).value || '').trim();
  const type = (document.getElementById('slotBookTargetType') || {}).value || 'none';
  const pid = (document.getElementById('slotBookProduct') || {}).value || '';
  if (!mid || !s || !days || days % s.minDays !== 0 || title.length < 2) return false;
  if (type === 'product' && !pid) return false;
  return true;
}

function syncSlotBookSubmit() {
  const btn = document.getElementById('slotBookSubmit');
  if (btn && !AD_SLOT_SUBMITTING) btn.disabled = !slotBookValid();
}

async function submitSlotBooking() {
  if (AD_SLOT_SUBMITTING || !slotBookValid()) return;
  const body = {
    merchantId: document.getElementById('slotBookMerchant').value,
    slotId: document.getElementById('slotBookSlot').value,
    days: parseInt(document.getElementById('slotBookDays').value, 10),
    title: document.getElementById('slotBookTitle').value.trim(),
    imageUrl: (document.getElementById('slotBookImage') || {}).value || '',
    targetType: (document.getElementById('slotBookTargetType') || {}).value || 'none',
    targetId: (document.getElementById('slotBookProduct') || {}).value || '',
  };
  AD_SLOT_SUBMITTING = true;
  const btn = document.getElementById('slotBookSubmit');
  if (btn) { btn.disabled = true; btn.textContent = '提交中…'; }
  const r = await post('/api/admin/adslots/book', body);
  AD_SLOT_SUBMITTING = false;
  if (btn) { btn.disabled = false; btn.textContent = '确认代投并上线'; }
  if (r.error) { toast('失败：' + r.error, 'err'); syncSlotBookSubmit(); return; }
  const q = r.quota || {};
  toast(`已上线，冻结额度后可用 ${yuan(q.availableFen)}`);
  ['slotBookTitle', 'slotBookImage'].forEach((id) => { const el = document.getElementById(id); if (el) el.value = ''; });
  const pv = document.getElementById('slotBookImagePreview'); if (pv) pv.innerHTML = '';
  document.getElementById('slotBookTargetType').value = 'none';
  slotBookTargetChanged();
  loadAds();
}


