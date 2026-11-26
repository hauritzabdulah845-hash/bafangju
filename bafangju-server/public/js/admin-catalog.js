// admin-catalog.js —— 商品管理（类目 r 值 / 上下架 / 算账）
// ==================== 商品管理 ====================
let prodTab = 'on_sale';
let PRODUCT_CACHE = [];
let PD_CURRENT_ID = '';
document.querySelectorAll('#pane-catalog .tr-item').forEach((el) => el.onclick = () => {
  document.querySelectorAll('#pane-catalog .tr-item').forEach((x) => x.classList.remove('on'));
  el.classList.add('on');
  prodTab = el.dataset.f;
  if (paneData.catalog) renderProducts(paneData.catalog);
});
async function loadCatalog() {
  const [cats, prods, merchants, pending] = await Promise.all([
    authed('/api/admin/catalog/categories').then((r) => r.json()),
    authed('/api/admin/catalog/products').then((r) => r.json()),
    authed('/api/admin/merchants').then((r) => r.json()).catch(() => []),
    authed('/api/admin/catalog/products/pending').then((r) => r.json()).catch(() => []),
  ]);
  renderPendingProducts(pending || []);
  paneData.catalog = prods;
  const kw = document.getElementById('prodKeyword').value.trim();
  const view = prods.filter((p) => p.status === prodTab && (!kw || (p.name || '').includes(kw) || String(p.id || '').includes(kw)));
  document.getElementById('pc-on').textContent = prods.filter((p) => p.status === 'on_sale').length ? ' ' + prods.filter((p) => p.status === 'on_sale').length : '';
  document.getElementById('pc-off').textContent = prods.filter((p) => p.status === 'off_sale').length ? ' ' + prods.filter((p) => p.status === 'off_sale').length : '';
  renderProducts(prods);
  document.querySelector('#cats tbody').innerHTML = cats.map((c) =>
    `<tr><td>${c.id}</td>
      <td>${c.iconImage ? thumbHtml(c.iconImage, c.name) : ''}${c.icon || ''} ${escHtml(c.name)}</td><td>${c.r}</td><td>${c.n}</td>
      <td><input type="number" step="0.01" min="0.01" max="0.99" style="width:90px;padding:4px;" id="r_${c.id}" value="${c.r}">
          <button class="sm ghost" data-act="updateCategoryR" data-id="${escHtml(c.id)}">修改 r</button>
          <button class="sm plain" data-act="pickCatIcon" data-id="${escHtml(c.id)}">换图标</button>
          <input type="file" id="caticon_${escHtml(c.id)}" accept="image/png,image/jpeg,image/webp" style="display:none" onchange="uploadCatIcon(this,'${escHtml(c.id)}')"></td></tr>`).join('')
    || '<tr><td colspan="5"><div class="empty"><div class="e-icon">🗂️</div>还没有类目，先在上方新增一个</div></td></tr>';
  const msel = document.getElementById('prodMerchant');
  if (msel && msel.options.length <= 1 && merchants.length) {
    msel.innerHTML = '<option value="">平台自营</option>' + merchants.map((m) => `<option value="${m.id}">${escHtml(m.name)}</option>`).join('');
  }
  const sel = document.getElementById('prodCat');
  if (!sel.options.length) sel.innerHTML = cats.map((c) => `<option value="${c.id}">${escHtml(c.name)}（n=${c.n}）</option>`).join('');
}
function renderProducts(list) {
  const kw = document.getElementById('prodKeyword').value.trim();
  PRODUCT_CACHE = list || [];
  const view = PRODUCT_CACHE.filter((p) => p.status === prodTab && (!kw || (p.name || '').includes(kw) || String(p.id || '').includes(kw)));
  const tb = document.querySelector('#prods tbody');
  if (!view.length) { tb.innerHTML = '<tr><td colspan="8"><div class="empty"><div class="e-icon">🛍️</div>暂无商品</div></td></tr>'; return; }
  tb.innerHTML = view.map((p) =>
    `<tr><td><div class="prod-cell">${thumbHtml(p.imageUrl, p.name)}<div class="p-name">${escHtml(p.name)}<div class="muted" style="font-size:11px">ID ${escHtml(p.id)}</div></div></div></td>
      <td>${escHtml(p.categoryName || '-')}</td><td>${p.merchantId ? escHtml(p.merchantId) : '<span class="tag">自营</span>'}</td>
      <td class="money">${yuan(p.priceFen)}</td>
      <td><span class="muted" style="font-size:11px">成本 ${yuan(p.costFen)} · 税率 ${p.taxFeeRate ?? '-'} · 运营 ${p.opCostFen ?? '-'} · r=${p.r ?? '-'} · n=${p.n ?? '-'}</span></td>
      <td>${p.deliveryType === 'store' ? '<span class="tag blue">到店</span>' : '<span class="tag orange">快递</span>'}</td>
      <td><span class="tag ${p.status === 'on_sale' ? 'green' : 'accent'}">${p.status === 'on_sale' ? '在售' : '已下架'}</span></td>
      <td><button class="sm ghost" data-act="previewEcon" data-id="${escHtml(p.id)}">算账</button>
          <button class="sm plain" data-act="showProductDetail" data-id="${escHtml(p.id)}">详情</button>
          <button class="sm" data-act="toggleProduct" data-id="${escHtml(p.id)}" data-p1="${escHtml(p.status)}">${p.status === 'on_sale' ? '下架' : '上架'}</button></td></tr>`).join('');
  // 抽屉开着时同步刷新
  if (PD_CURRENT_ID && document.getElementById('productDrawer').classList.contains('on')) refreshProductDetail();
}
/** 商品详情抽屉：承接从列表里移出的 成本/税率/运营成本/让利率 r/原价单数 n/改价/归属商家 */
function showProductDetail(id) {
  const p = PRODUCT_CACHE.find((x) => String(x.id) === String(id));
  if (!p) return toast('商品信息已过期，请刷新列表', 'err');
  PD_CURRENT_ID = String(id);
  const row = (k, v) => `<div class="kv"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  document.getElementById('pdTitle').textContent = p.name || '商品详情';
  document.getElementById('pdBody').innerHTML =
    row('商品 ID', escHtml(p.id)) +
    row('类目', escHtml(p.categoryName || '-')) +
    row('归属商家', p.merchantId ? escHtml(p.merchantId) : '<span class="tag green">平台自营</span>') +
    row('标价', `<b class="money">${yuan(p.priceFen)}</b>`) +
    row('成本', yuan(p.costFen)) +
    row('税率', p.taxFeeRate ?? '-') +
    row('运营成本/单', (p.opCostFen ?? '-') + (typeof p.opCostFen === 'number' ? ' 分' : '')) +
    row('让利率 r', p.r ?? '-') +
    row('原价单数 n', p.n ?? '-') +
    row('配送方式', p.deliveryType === 'store' ? '到店自提/核销' : '快递到家') +
    row('状态', `<span class="tag ${p.status === 'on_sale' ? 'green' : 'accent'}">${p.status === 'on_sale' ? '在售' : '已下架'}</span>`) +
    row('图片路径', p.imageUrl ? `<a href="${escHtml(p.imageUrl)}" target="_blank">查看</a>` : '-') +
    `<div class="hint-live" style="margin:10px 0 0"><b>上架前算账</b> — 点下方按钮预览一整轮的收益/留存，留存为负必须调价。</div>
     <div class="drawer-acts">
      <button class="sm" data-act="previewEcon" data-id="${escHtml(p.id)}">算账</button>
      <button class="sm ghost" data-act="editPrice" data-id="${escHtml(p.id)}" data-p1="${escHtml(p.priceFen)}" data-p2="${escHtml(p.costFen)}">改价/成本</button>
      <button class="sm ghost" data-act="assignMerchant" data-id="${escHtml(p.id)}">改归属商家</button>
      <button class="sm plain" data-act="toggleProduct" data-id="${escHtml(p.id)}" data-p1="${escHtml(p.status)}">${p.status === 'on_sale' ? '下架' : '上架'}</button>
    </div>`;
  document.getElementById('productDrawer').classList.add('on');
}
function closeProductDetail() { closeDrawer('productDrawer'); PD_CURRENT_ID = ''; }
function refreshProductDetail() { if (PD_CURRENT_ID) showProductDetail(PD_CURRENT_ID); }
async function createCategory() {
  const name = document.getElementById('catName').value.trim();
  const r = Number(document.getElementById('catR').value);
  const icon = document.getElementById('catIcon').value.trim();
  const res = await post('/api/admin/catalog/categories', { name, r, icon });
  if (res.error) { toast('失败：' + res.error, 'err'); return; }
  document.getElementById('catResult').textContent = `已创建（n=${res.category.n}）`;
  document.getElementById('catName').value = ''; document.getElementById('catR').value = ''; document.getElementById('catIcon').value = '';
  document.getElementById('prodCat').innerHTML = '';
  loadCatalog();
}
// 类目图标后台可换（此前 iconImage 只能改种子数据，换金刚区图标要动数据库）
function pickCatIcon(id) {
  const el = document.getElementById('caticon_' + id);
  if (el) el.click();
}
async function uploadCatIcon(input, id) {
  const file = input.files && input.files[0];
  if (!file) return;
  if (file.size > 4 * 1024 * 1024) { toast('图片不能超过 4MB', 'err'); input.value = ''; return; }
  const dataBase64 = await new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = () => rej(new Error('读取失败'));
    fr.readAsDataURL(file);
  }).catch(() => null);
  input.value = '';
  if (!dataBase64) { toast('图片读取失败', 'err'); return; }
  const up = await post('/api/admin/upload', { dataBase64 });
  if (!up || up.error || !up.url) { toast('上传失败：' + ((up && up.error) || '未知错误'), 'err'); return; }
  const res = await post('/api/admin/catalog/categories/update', { categoryId: id, iconImage: up.url });
  res.error ? toast('失败：' + res.error, 'err') : toast('类目图标已更新');
  loadCatalog();
}
async function updateCategoryR(id) {
  const r = Number(document.getElementById('r_' + id).value);
  if (!confirm(`确认修改该类目的让利率 r？这会改变该类目一轮的单数和优惠力度，影响进行中的轮次（敏感操作，全程留痕）。`)) return;
  const res = await post('/api/admin/catalog/categories/update', { categoryId: id, r });
  res.error ? toast('失败：' + res.error, 'err') : toast(`已修改，新的原价单数 n=${res.category.n}`);
  document.getElementById('prodCat').innerHTML = '';
  loadCatalog();
}
async function createProduct() {
  const taxRaw = document.getElementById('prodTaxRate').value;
  const opRaw = document.getElementById('prodOpCost').value;
  const body = {
    categoryId: document.getElementById('prodCat').value,
    name: document.getElementById('prodName').value.trim(),
    priceFen: parseInt(document.getElementById('prodPrice').value, 10),
    costFen: parseInt(document.getElementById('prodCost').value, 10),
    deliveryType: document.getElementById('prodDelivery').value,
    merchantId: document.getElementById('prodMerchant').value || undefined,
    imageUrl: document.getElementById('prodImg').value.trim(),
    taxFeeRate: taxRaw === '' ? undefined : Number(taxRaw),
    opCostFen: opRaw === '' ? undefined : parseInt(opRaw, 10),
  };
  const res = await post('/api/admin/catalog/products', body);
  if (res.error) { toast('失败：' + res.error, 'err'); return; }
  toast('上架成功');
  document.getElementById('prodName').value = ''; document.getElementById('prodPrice').value = ''; document.getElementById('prodCost').value = '';
  document.getElementById('prodTaxRate').value = ''; document.getElementById('prodOpCost').value = '';
  previewEcon(res.product.id); // 上架即算账，留存为负立刻可见
  loadCatalog();
}
async function previewEcon(productId) {
  const el = document.getElementById('econPreview');
  try {
    const d = await authed('/api/admin/economics/preview?productId=' + encodeURIComponent(productId)).then((r) => r.json());
    if (d.error) { el.textContent = '算账失败：' + d.error; return; }
    const rows = d.rows.map((r) =>
      `<tr><td>第 ${r.step} 单</td><td>${(r.paidFen / 100).toFixed(2)}</td><td>${(r.allocFen / 100).toFixed(2)}</td><td>${(r.commissionBaseFen / 100).toFixed(2)}</td></tr>`).join('');
    const bad = d.platformRetainFen < 0;
    el.innerHTML = `<b>${escHtml(d.productName)}</b>（n=${d.n}，税率 ${d.taxFeeRate}，运营 ${d.opCostFen} 分/单）`
      + `<table style="margin-top:8px"><thead><tr><th>第几单</th><th>实付(元)</th><th>可分配收益(元)</th><th>佣金基数(元)</th></tr></thead><tbody>${rows}</tbody></table>`
      + `<p style="margin:8px 0 0" class="${bad ? 'warn' : 'ok'}">一整轮可分配 ${d.allocTotalYuan} 元 · 佣金基数合计 ${d.commissionBaseTotalYuan} 元 · <b>平台留存 ${d.platformRetainYuan} 元</b>`
      + (bad ? ' ⚠️ 为负：必须调价 / 调 r / 降成本' : ' ✓ 不会亏') + '</p>';
  } catch (e) { el.textContent = '算账失败：' + e.message; }
}
async function editPrice(id, oldPrice, oldCost) {
  const priceFen = parseInt(prompt(`新标价（分，当前 ${oldPrice}）：`, oldPrice), 10);
  if (!Number.isInteger(priceFen)) return;
  const costFen = parseInt(prompt(`新成本（分，当前 ${oldCost}）：`, oldCost), 10);
  if (!Number.isInteger(costFen)) return;
  const res = await post('/api/admin/catalog/products/update', { id, priceFen, costFen });
  res.error ? toast('失败：' + res.error, 'err') : toast('已更新（已成交订单按下单快照结算，不追溯）');
  loadCatalog();
}
async function assignMerchant(id) {
  const merchantId = prompt('输入商家 ID（留空表示平台自营）：', '');
  if (merchantId === null) return;
  const res = await post('/api/admin/catalog/products/update', { id, merchantId: merchantId.trim() });
  res.error ? toast('失败：' + res.error, 'err') : toast('已更新商家归属');
  loadCatalog();
}
async function toggleProduct(id, status) {
  const to = status === 'on_sale' ? 'off_sale' : 'on_sale';
  if (to === 'off_sale' && !confirm('确认下架？下架后用户不能新下单，已在进行中的轮次不受影响。')) return;
  const res = await post('/api/admin/catalog/products/update', { id, status: to });
  res.error ? toast('失败：' + res.error, 'err') : toast('已更新');
  loadCatalog();
}

// ==================== 商品审核（商家提交，V3.23） ====================
function renderPendingProducts(list) {
  const tb = document.querySelector('#prodPending tbody');
  if (!tb) return;
  if (!list.length) { tb.innerHTML = '<tr><td colspan="8"><div class="empty"><div class="e-icon">✅</div>暂无待审核商品</div></td></tr>'; return; }
  tb.innerHTML = list.map((p) =>
    `<tr><td class="muted">${escHtml(String(p.submittedAt || '').slice(0, 16).replace('T', ' '))}</td>
      <td>${escHtml(p.merchantName || '-')}</td>
      <td><div class="prod-cell">${thumbHtml(p.imageUrl, p.name)}<div class="p-name">${escHtml(p.name)}</div></div></td>
      <td>${escHtml(p.categoryName || '-')}（n=${p.n ?? '-'}）</td>
      <td class="money">${yuan(p.priceFen)}</td><td class="money">${yuan(p.costFen)}</td>
      <td>${p.deliveryType === 'store' ? '<span class="tag blue">到店</span>' : '<span class="tag orange">快递</span>'}</td>
      <td><button class="sm ghost" data-act="previewEcon" data-id="${escHtml(p.id)}">算账</button>
          <button class="sm" data-act="reviewProduct" data-id="${escHtml(p.id)}" data-p1="true">通过</button>
          <button class="sm ghost" data-act="reviewProduct" data-id="${escHtml(p.id)}" data-p1="false">驳回</button></td></tr>`).join('');
}
async function reviewProduct(id, approved) {
  let note = '';
  if (!approved) {
    note = prompt('驳回原因（必填，商家可见，修改后可重新提交）：') || '';
    if (!note.trim()) return;
  } else if (!confirm('确认通过？通过后商品立即上架售卖。建议先点「算账」确认平台留存 ≥ 0。')) return;
  const res = await post('/api/admin/catalog/products/review', { productId: String(id), approved, note: note.trim() });
  res.error ? toast('失败：' + res.error, 'err') : toast(approved ? '已通过，商品上架' : '已驳回');
  loadCatalog();
}
