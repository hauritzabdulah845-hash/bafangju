// merchant-pages.js —— H5 商家端页面：工作台 / 核销 / 商品 / 订单 / 我的 + 子页
'use strict';

// ==================== 工作台 ====================
async function loadHome() {
  const el = document.getElementById('pane-home');
  el.innerHTML = '<div class="muted-empty">加载中…</div>';
  try {
    const ov = await apiGet('/api/merchant/overview');
    const trend = (ov.trend && ov.trend.length ? ov.trend : []);
    const max = Math.max(1, ...trend.map((t) => t.count || 0));
    el.innerHTML = `
      <div class="grad-head">
        <div style="font-size:14px;opacity:.9">${escHtml(MERCHANT.name)}，欢迎回来</div>
        <div style="display:flex;margin-top:16px;text-align:center">
          <div style="flex:1"><div style="font-size:22px;font-weight:700">${yuan(ov.balanceFen)}</div><div style="font-size:12px;opacity:.85;margin-top:3px">可提现余额</div></div>
          <div style="flex:1"><div style="font-size:22px;font-weight:700">${yuan(ov.frozenFen)}</div><div style="font-size:12px;opacity:.85;margin-top:3px">冻结中</div></div>
        </div>
      </div>
      <div class="stat-grid">
        <div class="stat-card"><div class="stat-num">${ov.couponValid || 0}<span style="font-size:13px;color:#999;font-weight:400"> / ${ov.couponCount || 0}</span></div><div class="stat-label">发放中券 / 总券数</div></div>
        <div class="stat-card"><div class="stat-num">${ov.redeemedCount || 0}</div><div class="stat-label">累计核销</div></div>
        <div class="stat-card" onclick="switchTab('orders')" style="cursor:pointer"><div class="stat-num orange">${ov.pendingShip || 0}</div><div class="stat-label">待发货订单 ›</div></div>
        <div class="stat-card" onclick="switchTab('orders')" style="cursor:pointer"><div class="stat-num orange">${ov.pendingVerify || 0}</div><div class="stat-label">待核销订单 ›</div></div>
      </div>
      <div class="card" style="margin-top:12px">
        <div class="row-between"><b>近 7 日核销趋势</b><span class="t-weak">单位：笔</span></div>
        <div class="trend-bar">${trend.map((t) => `
          <div class="trend-col"><div class="bar" style="height:${Math.round((t.count || 0) / max * 100)}%"></div><div class="tx">${escHtml(t.date || '')}</div></div>`).join('')}
        </div>
      </div>
      <div class="card">
        <b>快捷操作</b>
        <div class="quick-grid" style="margin-top:10px">
          <div class="quick-item" onclick="switchTab('verify')"><div class="qi">✅</div><div class="qt">去核销</div></div>
          <div class="quick-item" onclick="switchTab('products')"><div class="qi">📦</div><div class="qt">传商品</div></div>
          <div class="quick-item" onclick="openSub('coupons')"><div class="qi">🎟️</div><div class="qt">发优惠券</div></div>
          <div class="quick-item" onclick="openSub('withdraw')"><div class="qi">💰</div><div class="qt">提现</div></div>
        </div>
      </div>`;
  } catch (e) {
    el.innerHTML = `<div class="muted-empty">加载失败：${escHtml(e.message)}<br><br><button class="btn-outline" onclick="loadHome()">重试</button></div>`;
  }
}

// ==================== 核销 ====================
function renderVerify() {
  const el = document.getElementById('pane-verify');
  el.innerHTML = `
    <div class="card">
      <b>到店核销</b>
      <div class="t-weak" style="margin-top:6px">输入用户出示的核销码与本次实际消费金额</div>
      <div class="form-label">核销码</div>
      <input id="vfCode" class="inp" type="text" placeholder="请输入核销码" autocomplete="off">
      <div class="form-label">实际消费金额（元）</div>
      <input id="vfAmount" class="inp" type="number" inputmode="decimal" placeholder="0.00" min="0" step="0.01">
      <button id="vfBtn" class="btn-primary btn-block" onclick="doRedeem()">确认核销</button>
      <div id="vfResult"></div>
    </div>
    <div class="card">
      <b>服务费说明</b>
      <div class="t-weak" style="margin-top:6px">券核销按消费金额计服务费（券 3% / 次卡 5%），核销成功后从收益中扣除，明细见「我的 → 收益明细」。</div>
    </div>`;
}

async function doRedeem() {
  const code = document.getElementById('vfCode').value.trim();
  const amount = Number(document.getElementById('vfAmount').value);
  const box = document.getElementById('vfResult');
  if (!code) { toast('请输入用户出示的核销码', 'err'); return; }
  if (!amount || amount <= 0) { toast('请填写本次实际消费金额', 'err'); return; }
  const btn = document.getElementById('vfBtn');
  btn.disabled = true;
  try {
    const r = await apiPost('/api/merchant/coupons/redeem', { code, amountFen: Math.round(amount * 100) });
    box.innerHTML = `<div class="verify-result ok">
      <b>✓ 核销成功</b><br>
      消费金额：${yuan(r.alliance.amountFen)}<br>
      券服务费：${yuan(r.couponFeeFen)}　核验费：${yuan(r.verifyFeeFen)}<br>
      服务费合计：${yuan(r.grossFeeFen)}
    </div>`;
    document.getElementById('vfCode').value = '';
    document.getElementById('vfAmount').value = '';
    toast('核销成功');
  } catch (e) {
    box.innerHTML = `<div class="verify-result fail"><b>✕ 核销失败</b><br>${escHtml(e.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
}

// ==================== 商品 ====================
let P = { cats: [], list: [], editingId: '', imageUrl: '' };

async function loadProducts() {
  const el = document.getElementById('pane-products');
  el.innerHTML = '<div class="muted-empty">加载中…</div>';
  try {
    const [cats, list] = await Promise.all([apiGet('/api/merchant/categories'), apiGet('/api/merchant/products')]);
    P.cats = cats || []; P.list = list || [];
    renderProducts();
  } catch (e) {
    el.innerHTML = `<div class="muted-empty">加载失败：${escHtml(e.message)}<br><br><button class="btn-outline" onclick="loadProducts()">重试</button></div>`;
  }
}

function productStatusHtml(p) {
  const map = {
    on_sale: ['在售', 'tag-green'],
    pending_review: ['审核中', 'tag-orange'],
    rejected: ['已驳回', 'tag-red'],
    off_sale: ['已下架', 'tag-gray'],
  };
  const [t, c] = map[p.status] || [p.status, 'tag-gray'];
  return `<span class="tag ${c}">${t}</span>`;
}

function renderProducts() {
  const el = document.getElementById('pane-products');
  const editing = P.editingId ? P.list.find((x) => x.id === P.editingId) : null;
  const catOpts = P.cats.map((c) => `<option value="${escHtml(c.id)}" ${editing && editing.categoryId === c.id ? 'selected' : ''}>${escHtml(c.name)}（让利比例由平台定）</option>`).join('');
  const listHtml = P.list.length ? P.list.map((p) => `
    <div class="list-item">
      <div class="row-flex">
        ${p.imageUrl ? `<img class="thumb" src="${escHtml(p.imageUrl)}" alt="">` : '<span class="thumb-ph">🛍️</span>'}
        <div class="col-flex">
          <div class="row-between"><span class="li-title">${escHtml(p.name)}</span>${productStatusHtml(p)}</div>
          <div class="li-sub">售价 ${yuan(p.priceFen)} · 成本 ${yuan(p.costFen)} · ${p.deliveryType === 'store' ? '到店自提/核销' : '快递到家'}</div>
          ${p.status === 'rejected' && p.reviewReason ? `<div class="li-sub" style="color:#C5221F">驳回原因：${escHtml(p.reviewReason)}</div>` : ''}
          <div class="li-actions"><button class="btn-outline btn-sm" onclick="editProduct('${escHtml(p.id)}')">修改重提</button></div>
        </div>
      </div>
    </div>`).join('') : '<div class="muted-empty">还没有商品，在上方提交第一个</div>';

  el.innerHTML = `
    <div class="card">
      <b>${editing ? '修改商品（保存后重新进入审核）' : '上传新商品'}</b>
      <div class="form-label">商品名称</div>
      <input id="pdName" class="inp" type="text" placeholder="如：东北大米 5kg" value="${editing ? escHtml(editing.name) : ''}">
      <div class="form-label">售价（元） / 成本（元）</div>
      <div style="display:flex;gap:10px">
        <input id="pdPrice" class="inp" type="number" inputmode="decimal" placeholder="售价" value="${editing ? fen2yuan(editing.priceFen) : ''}">
        <input id="pdCost" class="inp" type="number" inputmode="decimal" placeholder="成本" value="${editing ? fen2yuan(editing.costFen) : ''}">
      </div>
      <div class="form-label">类目</div>
      ${P.cats.length ? `<select id="pdCat" class="inp">${catOpts}</select>` : '<div class="t-weak" style="margin-bottom:12px">平台还没有可选类目，请联系平台客服</div>'}
      <div class="form-label">履约方式</div>
      <select id="pdDelivery" class="inp">
        <option value="express" ${editing && editing.deliveryType !== 'store' ? 'selected' : ''}>快递到家</option>
        <option value="store" ${editing && editing.deliveryType === 'store' ? 'selected' : ''}>到店自提/核销</option>
      </select>
      <div class="form-label">商品图</div>
      <div class="img-picker">
        <div id="pdImgBox">${P.imageUrl ? `<img class="img-preview" src="${escHtml(P.imageUrl)}">` : ''}</div>
        <div class="img-btn" id="pdImgBtn" onclick="pickProductImage()">＋</div>
      </div>
      <div style="display:flex;gap:10px;margin-top:16px">
        <button id="pdSubmit" class="btn-primary" style="flex:1" onclick="submitProduct()">${editing ? '保存并重新提交审核' : '提交审核'}</button>
        ${editing ? '<button class="btn-gray" onclick="cancelEditProduct()">取消</button>' : ''}
      </div>
      <div class="t-weak" style="margin-top:10px">提交后平台审核通过才会上架；修改在售商品会重新进入审核。</div>
    </div>
    <b style="display:block;margin:6px 2px 10px">我的商品（${P.list.length}）</b>
    ${listHtml}`;
}

function pickProductImage() {
  const btn = document.getElementById('pdImgBtn');
  btn.textContent = '…';
  pickImage((err, url) => {
    btn.textContent = '＋';
    if (err) { toast(err.message, 'err'); return; }
    P.imageUrl = url;
    document.getElementById('pdImgBox').innerHTML = `<img class="img-preview" src="${escHtml(url)}">`;
  });
}

function editProduct(id) {
  const p = P.list.find((x) => x.id === id);
  if (!p) return;
  P.editingId = id;
  P.imageUrl = p.imageUrl || '';
  renderProducts();
  document.getElementById('pageBody').scrollTop = 0;
}

function cancelEditProduct() {
  P.editingId = ''; P.imageUrl = '';
  renderProducts();
}

async function submitProduct() {
  const name = document.getElementById('pdName').value.trim();
  const priceYuan = Number(document.getElementById('pdPrice').value);
  const costYuan = Number(document.getElementById('pdCost').value);
  if (!P.cats.length) { toast('平台还没有可选类目，请联系平台客服', 'err'); return; }
  if (!name) { toast('请填写商品名称', 'err'); return; }
  if (!(priceYuan > 0)) { toast('请填写正确的售价', 'err'); return; }
  if (!(costYuan >= 0) || costYuan >= priceYuan) { toast('成本价需低于售价', 'err'); return; }
  const body = {
    categoryId: document.getElementById('pdCat').value,
    name,
    priceFen: Math.round(priceYuan * 100),
    costFen: Math.round(costYuan * 100),
    deliveryType: document.getElementById('pdDelivery').value,
    imageUrl: P.imageUrl,
  };
  const btn = document.getElementById('pdSubmit');
  btn.disabled = true;
  try {
    if (P.editingId) await apiPost('/api/merchant/products/update', { ...body, productId: P.editingId });
    else await apiPost('/api/merchant/products/create', body);
    toast('已提交，等平台审核');
    P.editingId = ''; P.imageUrl = '';
    loadProducts();
  } catch (e) {
    toast(e.message, 'err');
    btn.disabled = false;
  }
}

// ==================== 订单 ====================
let O = { tab: 'pending', list: [], shipId: '', verifyId: '' };
const OST_TEXT = { paid: '待处理', shipped: '已发货', done: '已完成', refunded: '已退款', cancelled: '已取消' };
const SHIP_COMPANIES = ['顺丰速运', '京东物流', '中通快递', '圆通速递', '韵达快递', '申通快递', '极兔速递', '邮政EMS', '其他'];

async function loadOrders() {
  const el = document.getElementById('pane-orders');
  el.innerHTML = '<div class="muted-empty">加载中…</div>';
  try {
    O.list = (await apiGet('/api/merchant/orders')) || [];
    renderOrders();
  } catch (e) {
    el.innerHTML = `<div class="muted-empty">加载失败：${escHtml(e.message)}<br><br><button class="btn-outline" onclick="loadOrders()">重试</button></div>`;
  }
}

function setOrderTab(tab) { O.tab = tab; O.shipId = ''; O.verifyId = ''; renderOrders(); }
function startShip(id) { O.shipId = id; O.verifyId = ''; renderOrders(); }
function startOrderVerify(id) { O.verifyId = id; O.shipId = ''; renderOrders(); }
function cancelOrderForm() { O.shipId = ''; O.verifyId = ''; renderOrders(); }

function renderOrders() {
  const el = document.getElementById('pane-orders');
  const match = { pending: (o) => o.status === 'paid', done: (o) => o.status === 'done', all: () => true }[O.tab];
  const visible = O.list.filter(match);
  const listHtml = visible.length ? visible.map((o) => {
    const statusText = o.status === 'paid' ? (o.deliveryType === 'store' ? '待到店核销' : '待发货') : (OST_TEXT[o.status] || o.status);
    const tagCls = o.status === 'paid' ? 'tag-orange' : (o.status === 'done' ? 'tag-green' : (o.status === 'refunded' ? 'tag-red' : 'tag-gray'));
    let action = '';
    if (o.status === 'paid' && o.deliveryType !== 'store') {
      action = O.shipId === o.id
        ? `<div class="divider"></div>
           <div style="display:flex;gap:8px">
             <select id="shipCo" class="inp" style="flex:1.2;margin-bottom:0">${SHIP_COMPANIES.map((c) => `<option>${c}</option>`).join('')}</select>
             <input id="shipNo" class="inp" style="flex:1.6;margin-bottom:0" placeholder="快递单号">
           </div>
           <div class="li-actions"><button class="btn-primary btn-sm" onclick="doShip('${escHtml(o.id)}')">确认发货</button><button class="btn-gray btn-sm" onclick="cancelOrderForm()">取消</button></div>`
        : `<div class="li-actions"><button class="btn-outline btn-sm" onclick="startShip('${escHtml(o.id)}')">发货</button></div>`;
    } else if (o.status === 'paid' && o.deliveryType === 'store') {
      action = O.verifyId === o.id
        ? `<div class="divider"></div>
           <input id="ovfCode" class="inp" placeholder="输入用户出示的核销码">
           <div class="li-actions"><button class="btn-primary btn-sm" onclick="doOrderVerify('${escHtml(o.id)}')">确认核销</button><button class="btn-gray btn-sm" onclick="cancelOrderForm()">取消</button></div>`
        : `<div class="li-actions"><button class="btn-outline btn-sm" onclick="startOrderVerify('${escHtml(o.id)}')">核销</button></div>`;
    }
    return `<div class="list-item">
      <div class="row-between"><span class="li-title">${escHtml(o.productName || o.productId)}</span><span class="tag ${tagCls}">${statusText}</span></div>
      <div class="li-sub">实付 ${yuan(o.paidFen)} · ${o.deliveryType === 'store' ? '到店核销' : '快递发货'} · ${fmtTime(o.createdAt)}</div>
      ${o.trackingNo ? `<div class="li-sub">物流：${escHtml(o.company || '')} ${escHtml(o.trackingNo)}</div>` : ''}
      ${action}
    </div>`;
  }).join('') : '<div class="muted-empty">当前分类下没有订单</div>';

  el.innerHTML = `
    <div class="seg">
      <div class="seg-item ${O.tab === 'pending' ? 'on' : ''}" onclick="setOrderTab('pending')">待处理</div>
      <div class="seg-item ${O.tab === 'done' ? 'on' : ''}" onclick="setOrderTab('done')">已完成</div>
      <div class="seg-item ${O.tab === 'all' ? 'on' : ''}" onclick="setOrderTab('all')">全部</div>
    </div>
    ${listHtml}`;
}

async function doShip(id) {
  const company = document.getElementById('shipCo').value;
  const trackingNo = document.getElementById('shipNo').value.trim();
  if (!trackingNo) { toast('请填写快递单号', 'err'); return; }
  try {
    await apiPost('/api/merchant/orders/ship', { orderId: id, company, trackingNo });
    toast('已发货');
    O.shipId = '';
    loadOrders();
  } catch (e) { toast(e.message, 'err'); }
}

async function doOrderVerify(id) {
  const verifyCode = document.getElementById('ovfCode').value.trim();
  if (!verifyCode) { toast('请输入核销码', 'err'); return; }
  try {
    await apiPost('/api/merchant/orders/verify', { orderId: id, verifyCode });
    toast('核销成功');
    O.verifyId = '';
    loadOrders();
  } catch (e) { toast(e.message, 'err'); }
}

// ==================== 我的 ====================
async function loadMe() {
  const el = document.getElementById('pane-me');
  let balance = '0.00', frozen = '0.00';
  try {
    const e = await apiGet('/api/merchant/earnings');
    balance = fen2yuan(e.balanceFen); frozen = fen2yuan(e.frozenFen);
  } catch (e) { /* ignore */ }
  const initial = (MERCHANT.name || '商').slice(0, 1);
  el.innerHTML = `
    <div class="card">
      <div class="me-head">
        <div class="me-avatar">${escHtml(initial)}</div>
        <div>
          <div class="me-name">${escHtml(MERCHANT.name)}</div>
          <div class="me-sub">商家号：${escHtml(MERCHANT.id)}</div>
        </div>
      </div>
      <div class="balance-box">
        <div class="balance-cell"><div class="bn">¥${balance}</div><div class="bl">可提现余额</div></div>
        <div class="balance-cell"><div class="bn" style="color:#333">¥${frozen}</div><div class="bl">冻结中</div></div>
      </div>
    </div>
    <div class="card">
      <div class="menu-item" onclick="openSub('earnings')"><span>收益明细</span><span class="menu-arrow">›</span></div>
      <div class="menu-item" onclick="openSub('withdraw')"><span>提现</span><span class="menu-arrow">›</span></div>
      <div class="menu-item" onclick="openSub('coupons')"><span>优惠券</span><span class="menu-arrow">›</span></div>
      <div class="menu-item" onclick="openSub('ads')"><span>轮播广告</span><span class="menu-arrow">›</span></div>
      <div class="menu-item" onclick="openSub('adVideos')"><span>视频广告</span><span class="menu-arrow">›</span></div>
      <div class="menu-item" onclick="openSub('password')"><span>修改密码</span><span class="menu-arrow">›</span></div>
      <div class="menu-item" onclick="logout()" style="color:#C5221F"><span>退出登录</span><span class="menu-arrow">›</span></div>
    </div>
    <div class="t-weak" style="text-align:center;margin-top:14px">八方聚商家端 H5 · 绑定收款微信请在微信小程序中完成</div>
    <div class="filing-h5" data-filing></div>`;
  if (typeof window.refreshFilingBadges === 'function') window.refreshFilingBadges();
}

// ==================== 子页：收益明细 ====================
async function loadEarnings(pane) {
  pane.innerHTML = subHeadHtml(SUB_TITLES.earnings) + '<div class="muted-empty">加载中…</div>';
  try {
    const e = await apiGet('/api/merchant/earnings');
    const flows = (e.flows || []).map((f) => `
      <div class="list-item">
        <div class="row-between">
          <span class="li-title" style="font-size:14px">${escHtml(f.remark || f.type || '收益变动')}</span>
          <span style="font-weight:700;color:${(f.fen || 0) >= 0 ? '#067F43' : '#C5221F'}">${(f.fen || 0) >= 0 ? '+' : ''}${fen2yuan(f.fen)}</span>
        </div>
        <div class="li-sub">${fmtTime(f.ts)}</div>
      </div>`).join('') || '<div class="muted-empty">暂无流水</div>';
    pane.innerHTML = subHeadHtml(SUB_TITLES.earnings) + `
      <div class="grad-head" style="border-radius:14px;padding-bottom:22px">
        <div style="display:flex;text-align:center">
          <div style="flex:1"><div style="font-size:22px;font-weight:700">${yuan(e.balanceFen)}</div><div style="font-size:12px;opacity:.85;margin-top:3px">可提现</div></div>
          <div style="flex:1"><div style="font-size:22px;font-weight:700">${yuan(e.frozenFen)}</div><div style="font-size:12px;opacity:.85;margin-top:3px">冻结中</div></div>
          <div style="flex:1"><div style="font-size:22px;font-weight:700">${yuan(e.withdrawFrozenFen)}</div><div style="font-size:12px;opacity:.85;margin-top:3px">提现冻结</div></div>
        </div>
      </div>
      <b style="display:block;margin:14px 2px 10px">最近流水</b>
      ${flows}`;
  } catch (err) {
    pane.innerHTML = subHeadHtml(SUB_TITLES.earnings) + `<div class="muted-empty">加载失败：${escHtml(err.message)}</div>`;
  }
}

// ==================== 子页：提现 ====================
const WD_ST = { pending_review: '待平台审核', approved: '发放中', issuing: '发放中', done: '发放完成', rejected: '已驳回' };
const WD_TX = { transferred_pending_confirm: '已转账 · 待确认收款', confirmed: '已到账', expired_refunded: '超时未确认 · 已退回重发' };

async function loadWithdraw(pane) {
  pane.innerHTML = subHeadHtml(SUB_TITLES.withdraw) + '<div class="muted-empty">加载中…</div>';
  try {
    const [s, rec] = await Promise.all([
      apiGet('/api/merchant/withdraw/status'),
      apiGet('/api/merchant/withdraw/receiver').catch(() => null),
    ]);
    const receiverHtml = rec && rec.bound
      ? `<div class="t-weak">收款微信：${escHtml(rec.name || '微信收款')}（${escHtml(rec.openid ? rec.openid.slice(0, 6) + '…' : '')}）</div>`
      : `<div class="verify-result fail" style="margin-top:0">还未绑定收款微信。请在「八方聚」微信小程序商家端完成绑定，或联系平台运营协助。</div>`;
    const reqs = (s.requests || []).map((r) => `
      <div class="list-item">
        <div class="row-between"><span class="li-title" style="font-size:14px">${yuan(r.fen)}</span><span class="tag ${r.status === 'done' ? 'tag-green' : (r.status === 'rejected' ? 'tag-red' : 'tag-orange')}">${WD_ST[r.status] || r.status}</span></div>
        <div class="li-sub">${fmtTime(r.appliedAt)}${r.remainingFen != null && r.status !== 'done' ? ' · 待发 ' + yuan(r.remainingFen) : ''}</div>
      </div>`).join('');
    const txs = (s.transfers || []).map((t) => `
      <div class="list-item">
        <div class="row-between"><span class="li-title" style="font-size:14px">${yuan(t.fen)}</span><span class="tag ${t.status === 'confirmed' ? 'tag-green' : 'tag-orange'}">${WD_TX[t.status] || t.status}</span></div>
        <div class="li-sub">${fmtTime(t.issuedAt)}</div>
        ${t.status === 'transferred_pending_confirm' ? `<div class="li-actions"><button class="btn-primary btn-sm" onclick="confirmTransfer('${escHtml(t.id)}')">确认已收款</button></div>` : ''}
      </div>`).join('');

    pane.innerHTML = subHeadHtml(SUB_TITLES.withdraw) + `
      <div class="card">
        <div class="row-between"><b>可提现余额</b><span style="font-size:22px;font-weight:700;color:#B02A30">${yuan(s.balanceFen)}</span></div>
        <div style="margin-top:10px">${receiverHtml}</div>
        ${!s.withdrawEnabled ? '<div class="t-weak" style="margin-top:8px;color:#8F1F26">提现功能尚未开通（入驻满 90 天后开放，具体可咨询平台运营）</div>' : ''}
        ${s.limits ? `<div class="t-weak" style="margin-top:8px">单笔 ≤ ${yuan(s.limits.perTxnFen)} · 每日 ≤ ${yuan(s.limits.dailyFen)} · 最低 ${yuan(s.limits.minFen)} 起提</div>` : ''}
        <div class="form-label">提现金额（元）</div>
        <div style="display:flex;gap:10px">
          <input id="wdAmount" class="inp" style="flex:1;margin-bottom:0" type="number" inputmode="decimal" placeholder="0.00" ${!s.withdrawEnabled ? 'disabled' : ''}>
          <button class="btn-primary" onclick="applyWithdraw()" ${!s.withdrawEnabled ? 'disabled' : ''}>申请</button>
        </div>
      </div>
      ${reqs ? `<b style="display:block;margin:6px 2px 10px">提现申请</b>${reqs}` : ''}
      ${txs ? `<b style="display:block;margin:6px 2px 10px">转账记录</b>${txs}` : ''}
      ${!reqs && !txs ? '<div class="muted-empty">暂无提现记录</div>' : ''}`;
  } catch (err) {
    pane.innerHTML = subHeadHtml(SUB_TITLES.withdraw) + `<div class="muted-empty">加载失败：${escHtml(err.message)}</div>`;
  }
}

async function applyWithdraw() {
  const fen = Math.round(parseFloat(document.getElementById('wdAmount').value || '0') * 100);
  if (!fen) { toast('请输入金额', 'err'); return; }
  try {
    await apiPost('/api/merchant/withdraw/apply', { fen, idempotencyKey: 'w' + Date.now() });
    toast('申请已提交');
    loadWithdraw(document.getElementById('pane-sub'));
  } catch (e) { toast(e.message, 'err'); }
}

async function confirmTransfer(id) {
  try {
    await apiPost('/api/merchant/withdraw/confirm', { transferId: id });
    toast('已确认收款');
    loadWithdraw(document.getElementById('pane-sub'));
  } catch (e) { toast(e.message, 'err'); }
}

// ==================== 子页：优惠券 ====================
let C = { list: [], type: 'cash' };

async function loadCoupons(pane) {
  pane.innerHTML = subHeadHtml(SUB_TITLES.coupons) + '<div class="muted-empty">加载中…</div>';
  try {
    C.list = (await apiGet('/api/merchant/coupons')) || [];
    renderCoupons();
  } catch (e) {
    pane.innerHTML = subHeadHtml(SUB_TITLES.coupons) + `<div class="muted-empty">加载失败：${escHtml(e.message)}</div>`;
  }
}

function couponTypeText(c) {
  if (c.type === 'discount') return (Number(c.discountRate) * 10).toFixed(1) + ' 折';
  if (c.type === 'package') return '次卡/服务';
  return '满 ' + fen2yuan(c.minSpendFen) + ' 减 ' + fen2yuan(c.amountOffFen);
}

function setCouponType(t) { C.type = t; renderCoupons(); }

function renderCoupons() {
  const pane = document.getElementById('pane-sub');
  const listHtml = C.list.length ? C.list.map((c) => `
    <div class="list-item">
      <div class="row-between"><span class="li-title" style="font-size:14px">${escHtml(c.title)}</span><span class="tag ${c.status === 'valid' ? 'tag-green' : 'tag-gray'}">${c.status === 'valid' ? '发放中' : '已停发'}</span></div>
      <div class="li-sub">${couponTypeText(c)} · 已领 ${c.claimedQty || 0}${c.totalQty ? ' / ' + c.totalQty : ''} · 已核销 ${c.redeemedQty || 0}</div>
    </div>`).join('') : '<div class="muted-empty">还没有优惠券</div>';

  pane.innerHTML = subHeadHtml(SUB_TITLES.coupons) + `
    <div class="card">
      <b>发新券</b>
      <div class="seg" style="margin-top:12px">
        <div class="seg-item ${C.type === 'cash' ? 'on' : ''}" onclick="setCouponType('cash')">满减券</div>
        <div class="seg-item ${C.type === 'discount' ? 'on' : ''}" onclick="setCouponType('discount')">折扣券</div>
        <div class="seg-item ${C.type === 'package' ? 'on' : ''}" onclick="setCouponType('package')">次卡/服务</div>
      </div>
      <div class="form-label">券名称</div>
      <input id="cpTitle" class="inp" type="text" placeholder="如：满 100 减 20">
      ${C.type === 'cash' ? `
        <div class="form-label">满（元） / 减（元）</div>
        <div style="display:flex;gap:10px">
          <input id="cpMin" class="inp" type="number" inputmode="decimal" placeholder="门槛金额">
          <input id="cpOff" class="inp" type="number" inputmode="decimal" placeholder="减金额">
        </div>` : ''}
      ${C.type === 'discount' ? `
        <div class="form-label">折扣（如 0.85 = 八五折）</div>
        <input id="cpDiscount" class="inp" type="number" inputmode="decimal" placeholder="0.85" step="0.01" min="0.01" max="1">` : ''}
      <div class="form-label">发放总量（留空不限） / 每人限领</div>
      <div style="display:flex;gap:10px">
        <input id="cpQty" class="inp" type="number" inputmode="numeric" placeholder="不限">
        <input id="cpLimit" class="inp" type="number" inputmode="numeric" placeholder="1" value="1">
      </div>
      <div class="form-label">有效天数</div>
      <input id="cpDays" class="inp" type="number" inputmode="numeric" value="30">
      <button id="cpBtn" class="btn-primary btn-block" onclick="createCoupon()">创建</button>
    </div>
    <b style="display:block;margin:6px 2px 10px">我的券（${C.list.length}）</b>
    ${listHtml}`;
}

async function createCoupon() {
  const title = document.getElementById('cpTitle').value.trim();
  if (!title) { toast('请填写券名称', 'err'); return; }
  const body = {
    title,
    type: C.type,
    amountOffFen: Math.round(Number((document.getElementById('cpOff') || {}).value || 0) * 100),
    discountRate: Number((document.getElementById('cpDiscount') || {}).value || 0),
    minSpendFen: Math.round(Number((document.getElementById('cpMin') || {}).value || 0) * 100),
    totalQty: document.getElementById('cpQty').value === '' ? null : parseInt(document.getElementById('cpQty').value, 10),
    perUserLimit: parseInt(document.getElementById('cpLimit').value, 10) || 1,
    validDays: parseInt(document.getElementById('cpDays').value, 10) || 30,
  };
  const btn = document.getElementById('cpBtn');
  btn.disabled = true;
  try {
    await apiPost('/api/merchant/coupons/create', body);
    toast('已创建');
    loadCoupons(document.getElementById('pane-sub'));
  } catch (e) {
    toast(e.message, 'err');
    btn.disabled = false;
  }
}

// ==================== 子页：轮播广告（只读，平台代投） ====================
// V4.3 起轮播广告位改为额度制：商家线下打款 → 平台发额度 → 平台工作人员代上广告。
// 商家端只保留「查看投放进度 / 效果 / 额度」，不再自助选位与提交。
const AD = { mine: [], summary: null, quota: null };

async function loadAds(pane) {
  pane.innerHTML = subHeadHtml(SUB_TITLES.ads) + '<div class="muted-empty">加载中…</div>';
  try {
    const [mine, center] = await Promise.all([
      apiGet('/api/merchant/adslots/mine'),
      apiGet('/api/merchant/ad-center'),
    ]);
    AD.mine = (mine && mine.list) || [];
    AD.summary = (mine && mine.summary) || null;
    AD.quota = (center && center.quota) || null;
    renderAds();
  } catch (e) {
    pane.innerHTML = subHeadHtml(SUB_TITLES.ads) + `<div class="muted-empty">加载失败：${escHtml(e.message)}</div>`;
  }
}

function renderAds() {
  const pane = document.getElementById('pane-sub');
  const q = AD.quota || {};
  const listHtml = AD.mine.length ? AD.mine.map((b) => `
    <div class="list-item">
      <div class="row-between">
        <span class="li-title" style="font-size:14px">${escHtml(b.title || b.slotName)}</span>
        <span class="tag ${b.statusText === '投放中' ? 'tag-green' : (b.statusText === '已驳回' ? 'tag-red' : 'tag-gray')}">${escHtml(b.statusText || '')}</span>
      </div>
      <div class="li-sub">广告位：${escHtml(b.slotName || b.slotId)} · 费用 ${yuan(b.feeFen)}</div>
      <div class="li-sub">${escHtml(String(b.startAt || '').slice(0, 10) || '待上线')} ~ ${escHtml(String(b.endAt || '').slice(0, 10) || '-')}${b.daysLeft ? ' · 剩余 ' + b.daysLeft + ' 天' : ''}</div>
      <div class="li-sub">曝光 ${b.impressionCount || 0} · 点击 ${b.clickCount || 0} · 点击率 ${b.ctrPercent || 0}%</div>
      ${b.reviewNote ? `<div class="li-sub" style="color:#C5221F">说明：${escHtml(b.reviewNote)}</div>` : ''}
    </div>`).join('') : '<div class="muted-empty">暂无轮播投放记录</div>';

  pane.innerHTML = subHeadHtml(SUB_TITLES.ads) + `
    <div class="card">
      <b>轮播广告由平台协助投放</b>
      <div class="t-weak" style="margin-top:8px;line-height:1.8">
        流程：与平台运营确认广告位与档期 → 线下打款 → 平台发放广告额度并代为上传素材上线。<br>
        本页可查看投放进度与曝光/点击效果；如需新增或调整投放，请联系平台运营。
      </div>
    </div>
    <div class="card">
      <div class="row-between"><b>广告额度</b><span class="t-weak">与视频广告共用</span></div>
      <div class="quota-grid">
        <div><div class="q-num">${yuan(q.availableFen)}</div><div class="q-label">可用</div></div>
        <div><div class="q-num">${yuan(q.frozenFen)}</div><div class="q-label">投放中</div></div>
        <div><div class="q-num">${yuan(q.usedFen)}</div><div class="q-label">已消耗</div></div>
        <div><div class="q-num">${yuan(q.grantedFen)}</div><div class="q-label">累计发放</div></div>
      </div>
      <div class="t-weak" style="margin-top:8px">额度由平台在确认线下收款后发放，投放结束后按实际消耗结算。</div>
    </div>
    ${AD.summary ? `<div class="card"><div class="row-between"><b>累计效果</b><span class="t-weak">曝光 ${AD.summary.impressions || 0} · 点击 ${AD.summary.clicks || 0} · 点击率 ${AD.summary.ctrPercent || 0}%</span></div></div>` : ''}
    <b style="display:block;margin:6px 2px 10px">我的轮播投放</b>
    ${listHtml}`;
}

// ==================== 子页：视频广告（商家自助，平台审核） ====================
const ADV_ST = {
  draft: ['待审核', 'tag-orange'], active: ['投放中', 'tag-green'], sold_out: ['已抢完', 'tag-gray'],
  rejected: ['已驳回', 'tag-red'], offline: ['已下架', 'tag-gray'], settled: ['已结算', 'tag-blue'],
};
const ADV_FLOW = { freeze: '创建计划冻结', append: '追加预算', release: '驳回释放', settle: '结算退回', slot_freeze: '轮播代投冻结', slot_expire: '轮播到期结转' };
let ADV = {
  quota: null, videos: [], settlements: [], flows: [], presets: [40, 60, 100], products: [],
  shareRate: 0.4, videoUrl: '', coverUrl: '', durationS: 0, submitting: false,
};

async function loadAdVideos(pane) {
  pane.innerHTML = subHeadHtml(SUB_TITLES.adVideos) + '<div class="muted-empty">加载中…</div>';
  try {
    const [center, flows, products] = await Promise.all([
      apiGet('/api/merchant/ad-center'),
      apiGet('/api/merchant/quota-flows').catch(() => ({ flows: [] })),
      apiGet('/api/merchant/products').catch(() => []),
    ]);
    ADV.quota = center.quota || null;
    ADV.videos = center.videos || [];
    ADV.settlements = center.settlements || [];
    ADV.presets = center.chargePresetsFen || [40, 60, 100];
    ADV.shareRate = typeof center.shareRate === 'number' ? center.shareRate : 0.4;
    ADV.flows = flows.flows || [];
    ADV.products = Array.isArray(products) ? products : [];
    renderAdVideos();
  } catch (e) {
    pane.innerHTML = subHeadHtml(SUB_TITLES.adVideos) + `<div class="muted-empty">加载失败：${escHtml(e.message)}</div>`;
  }
}

function renderAdVideos() {
  const pane = document.getElementById('pane-sub');
  const q = ADV.quota || {};
  const presetOpts = ADV.presets.map((f) => `<option value="${f}"${f === 60 ? ' selected' : ''}>${yuan(f)} / IP</option>`).join('');
  const prodOpts = '<option value="">不跳转</option>' + ADV.products
    .filter((p) => p.status !== 'rejected')
    .map((p) => `<option value="${escHtml(p.id)}">${escHtml(p.title || p.id)}</option>`).join('');
  const planHtml = ADV.videos.length ? ADV.videos.map((v) => {
    const [stText, stCls] = ADV_ST[v.status] || [v.status, 'tag-gray'];
    const s = v.stats || {};
    const canEdit = ['draft', 'rejected'].includes(v.status);
    const canAppend = ['active', 'sold_out'].includes(v.status);
    return `
    <div class="list-item">
      <div class="row-between">
        <span class="li-title" style="font-size:14px">${escHtml(v.title)}</span>
        <span class="tag ${stCls}">${escHtml(stText)}</span>
      </div>
      <div class="li-sub">${v.durationS} 秒 · 单 IP ${yuan(v.chargePerIpFen)} · 完播 ${v.rewardPoints || Math.max(1, Math.round(v.rewardPerIpFen))} 贡献值</div>
      <div class="li-sub">预算 ${yuan(v.budgetFen)} · 已耗 ${yuan(v.spentFen)} · 剩余 ${yuan(v.budgetLeftFen)}</div>
      <div class="li-sub">进度 ${v.claimedIpCount}/${v.targetIpCount}（${v.ipProgressPercent || 0}%）${v.estDays ? ' · 预计 ' + v.estDays + ' 天投完' : ''}</div>
      <div class="li-sub">曝光 ${s.expose || 0} · 点击 ${s.click || 0} · 完播率 ${s.completePercent || 0}%</div>
      ${v.reviewNote ? `<div class="li-sub" style="color:#C5221F">驳回原因：${escHtml(v.reviewNote)}</div>` : ''}
      ${canEdit || canAppend ? `<div class="li-actions">
        ${canEdit ? `<button class="btn-outline btn-sm" onclick="editAdVideo('${escHtml(v.videoId)}')">改标题</button>
        <button class="btn-outline btn-sm" onclick="changeAdVideoCover('${escHtml(v.videoId)}')">换封面</button>` : ''}
        ${canAppend ? `<button class="btn-outline btn-sm" onclick="appendAdBudget('${escHtml(v.videoId)}')">追加预算</button>` : ''}
      </div>` : ''}
    </div>`;
  }).join('') : '<div class="muted-empty">还没有视频广告计划</div>';

  const settleHtml = ADV.settlements.slice(0, 5).map((s) => `
    <div class="list-item">
      <div class="row-between"><span class="li-title" style="font-size:14px">退回可用额度 ${yuan(s.refundFen)}</span>
        <span class="tag ${s.status === 'refunded' ? 'tag-green' : 'tag-orange'}">${s.status === 'refunded' ? '已线下退款' : '待平台处理'}</span></div>
      <div class="li-sub">预算 ${yuan(s.budgetFen)} · 已耗 ${yuan(s.spentFen)} · ${fmtTime(s.settledAt)}</div>
    </div>`).join('');

  const flowHtml = ADV.flows.slice(0, 8).map((f) => `
    <div class="list-item">
      <div class="row-between"><span class="li-title" style="font-size:14px">${escHtml(ADV_FLOW[f.type] || f.type)}</span>
        <span style="font-weight:700;color:${(f.deltaFen || 0) >= 0 ? '#067F43' : '#8F1F26'}">${(f.deltaFen || 0) > 0 ? '+' : ''}${fen2yuan(f.deltaFen || 0)}</span></div>
      <div class="li-sub">${fmtTime(f.ts)}${f.note ? ' · ' + escHtml(f.note) : ''}</div>
    </div>`).join('');

  pane.innerHTML = subHeadHtml(SUB_TITLES.adVideos) + `
    <div class="card">
      <div class="row-between"><b>广告额度</b><span class="t-weak">轮播与视频共用</span></div>
      <div class="quota-grid">
        <div><div class="q-num">${yuan(q.availableFen)}</div><div class="q-label">可用</div></div>
        <div><div class="q-num">${yuan(q.frozenFen)}</div><div class="q-label">冻结中</div></div>
        <div><div class="q-num">${yuan(q.usedFen)}</div><div class="q-label">已消耗</div></div>
        <div><div class="q-num">${yuan(q.grantedFen)}</div><div class="q-label">累计发放</div></div>
      </div>
      <div class="t-weak" style="margin-top:8px">额度由平台在确认线下打款后发放。创建计划即整笔冻结预算，审核通过后开始投放；驳回或结算后预算退回可用额度。</div>
    </div>
    <div class="card">
      <b>新建视频广告计划</b>
      <div class="form-label">广告标题</div>
      <input id="avTitle" class="inp" placeholder="如：新米上市 · 到店自提">
      <div class="form-label">广告视频（MP4 / MOV，≤24MB）</div>
      <div class="img-picker">
        <div id="avVideoBox" class="video-box">${ADV.videoUrl ? '已上传，待填写参数' : '未上传'}</div>
        <div class="img-btn" onclick="pickAdVideo()">＋</div>
      </div>
      <div class="form-label">封面（可选，建议 16:9）</div>
      <div class="img-picker">
        <div id="avCoverBox">${ADV.coverUrl ? `<img class="img-preview" src="${escHtml(ADV.coverUrl)}">` : ''}</div>
        <div class="img-btn" onclick="pickAdCover()">＋</div>
      </div>
      <div class="form-label">视频时长（秒，上传后自动识别）</div>
      <input id="avDur" class="inp" type="number" inputmode="numeric" min="5" max="600" value="${ADV.durationS || ''}">
      <div class="form-label">总预算（元，从可用额度冻结）</div>
      <input id="avBudget" class="inp" type="number" inputmode="decimal" placeholder="如 300">
      <div class="form-label">单 IP 费用</div>
      <select id="avCharge" class="inp">${presetOpts}</select>
      <div class="form-label">每日发放上限（次）</div>
      <input id="avCap" class="inp" type="number" inputmode="numeric" value="50">
      <div class="form-label">跳转商品（可选）</div>
      <select id="avProduct" class="inp">${prodOpts}</select>
      <div id="avPreview" class="t-weak" style="margin-top:8px">填写总预算后显示预计可投 IP 数与用户完播可得贡献值。</div>
      <button class="btn-primary btn-block" style="margin-top:12px" onclick="submitAdVideo()">提交审核</button>
    </div>
    <b style="display:block;margin:6px 2px 10px">我的视频计划</b>
    ${planHtml}
    ${settleHtml ? `<b style="display:block;margin:14px 2px 10px">结算单</b>${settleHtml}` : ''}
    ${flowHtml ? `<b style="display:block;margin:14px 2px 10px">额度流水</b>${flowHtml}` : ''}`;

  previewAdBudget();
}

function pickAdVideo() {
  pickVideo((err, url, name) => {
    if (err) { toast(err.message, 'err'); return; }
    ADV.videoUrl = url;
    const box = document.getElementById('avVideoBox');
    if (box) box.textContent = '已上传：' + name;
    // 用上传后的站内地址探测时长，避免依赖服务端装 ffmpeg
    const probe = document.createElement('video');
    probe.preload = 'metadata';
    probe.onloadedmetadata = () => {
      ADV.durationS = Math.max(5, Math.min(600, Math.round(probe.duration || 0)));
      const d = document.getElementById('avDur');
      if (d) d.value = ADV.durationS;
    };
    probe.src = url;
    toast('视频上传成功');
  });
}

function pickAdCover() {
  pickImage((err, url) => {
    if (err) { toast(err.message, 'err'); return; }
    ADV.coverUrl = url;
    const box = document.getElementById('avCoverBox');
    if (box) box.innerHTML = `<img class="img-preview" src="${escHtml(url)}">`;
  });
}

function previewAdBudget() {
  const el = document.getElementById('avPreview');
  if (!el) return;
  const budgetFen = Math.round(Number((document.getElementById('avBudget') || {}).value || 0) * 100);
  const chargeFen = Number((document.getElementById('avCharge') || {}).value || 0);
  if (!(budgetFen >= 100) || !(chargeFen >= 10)) {
    el.textContent = '填写总预算后显示预计可投 IP 数与用户完播可得贡献值。';
    return;
  }
  const ips = Math.floor(budgetFen / chargeFen);
  const points = Math.max(1, Math.round(chargeFen * ADV.shareRate));
  el.innerHTML = `预计可投 <b>${ips}</b> 个 IP · 用户完播可得 <b>${points}</b> 贡献值（分成 ${Math.round(ADV.shareRate * 100)}%）· 本计划将冻结 <b>${yuan(budgetFen)}</b> 额度`;
}

document.addEventListener('input', (e) => {
  if (['avBudget', 'avCharge'].includes(e.target.id)) previewAdBudget();
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'avCharge') previewAdBudget();
});

async function submitAdVideo() {
  if (ADV.submitting) return;
  const body = {
    title: (document.getElementById('avTitle').value || '').trim(),
    videoUrl: ADV.videoUrl,
    coverUrl: ADV.coverUrl,
    durationS: parseInt((document.getElementById('avDur') || {}).value, 10),
    productId: (document.getElementById('avProduct') || {}).value || '',
    budgetFen: Math.round(Number((document.getElementById('avBudget') || {}).value || 0) * 100),
    chargePerIpFen: Number((document.getElementById('avCharge') || {}).value || 0),
    dailyCap: parseInt((document.getElementById('avCap') || {}).value, 10) || 1,
  };
  if (!body.videoUrl) return toast('请先上传广告视频', 'err');
  if (body.title.length < 2) return toast('广告标题至少 2 字', 'err');
  if (!(body.budgetFen >= 100)) return toast('总预算不低于 1 元', 'err');
  ADV.submitting = true;
  try {
    await apiPost('/api/merchant/ad-videos/create', body);
    toast('已提交，等待平台审核');
    ADV.videoUrl = ''; ADV.coverUrl = ''; ADV.durationS = 0;
    loadAdVideos(document.getElementById('pane-sub'));
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    ADV.submitting = false;
  }
}

async function editAdVideo(videoId) {
  const v = ADV.videos.find((x) => String(x.videoId) === String(videoId));
  const title = prompt('新的广告标题（修改后自动重新提交审核）：', v ? v.title : '');
  if (title === null) return;
  try {
    await apiPost('/api/merchant/ad-videos/material', { videoId, title: title.trim() });
    toast('已保存并重新提交审核');
    loadAdVideos(document.getElementById('pane-sub'));
  } catch (e) { toast(e.message, 'err'); }
}

function changeAdVideoCover(videoId) {
  pickImage(async (err, url) => {
    if (err) { toast(err.message, 'err'); return; }
    try {
      await apiPost('/api/merchant/ad-videos/material', { videoId, coverUrl: url });
      toast('封面已更新并重新提交审核');
      loadAdVideos(document.getElementById('pane-sub'));
    } catch (e) { toast(e.message, 'err'); }
  });
}

async function appendAdBudget(videoId) {
  const yuanStr = prompt('追加预算金额（元）：');
  if (yuanStr === null) return;
  const fen = Math.round(Number(yuanStr) * 100);
  if (!(fen > 0)) return toast('请输入有效金额', 'err');
  try {
    await apiPost('/api/merchant/ad-videos/append-budget', { videoId, amountFen: fen });
    toast('已追加，额度已冻结');
    loadAdVideos(document.getElementById('pane-sub'));
  } catch (e) { toast(e.message, 'err'); }
}

// ==================== 子页：修改密码 ====================
function renderPassword(pane) {
  pane.innerHTML = subHeadHtml(SUB_TITLES.password) + `
    <div class="card">
      <b>修改密码</b>
      <div class="t-weak" style="margin-top:6px">改密成功后需要重新登录</div>
      <div class="form-label">原密码</div>
      <div class="pwd-field">
        <input id="pwOld" class="inp" type="password" autocomplete="current-password">
        <button type="button" class="eye-btn" onclick="togglePassEye(this)" aria-label="显示密码"></button>
      </div>
      <div class="form-label">新密码</div>
      <div class="pwd-field">
        <input id="pwNew" class="inp" type="password" autocomplete="new-password" placeholder="建议 8 位以上，含字母与数字">
        <button type="button" class="eye-btn" onclick="togglePassEye(this)" aria-label="显示密码"></button>
      </div>
      <div class="form-label">确认新密码</div>
      <div class="pwd-field">
        <input id="pwNew2" class="inp" type="password" autocomplete="new-password">
        <button type="button" class="eye-btn" onclick="togglePassEye(this)" aria-label="显示密码"></button>
      </div>
      <button class="btn-primary btn-block" onclick="changePassword()">确认修改</button>
    </div>`;
}

async function changePassword() {
  const oldPassword = document.getElementById('pwOld').value;
  const p1 = document.getElementById('pwNew').value;
  const p2 = document.getElementById('pwNew2').value;
  if (!oldPassword || !p1) { toast('请填写完整', 'err'); return; }
  if (p1 !== p2) { toast('两次输入的新密码不一致', 'err'); return; }
  try {
    await apiPost('/api/merchant/change-password', { oldPassword, newPassword: p1 });
    toast('密码已修改，请重新登录');
    setTimeout(() => logout('密码已修改，请用新密码登录'), 1200);
  } catch (e) { toast(e.message, 'err'); }
}
