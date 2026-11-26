// admin-orders.js —— 订单管理（发货 / 核销 / 售后 / 退款）
// ==================== 订单管理 ====================
let orderTab = 'all';
let refundAnomalyMap = {};
document.querySelectorAll('#pane-orders .tr-item').forEach((el) => el.onclick = () => {
  document.querySelectorAll('#pane-orders .tr-item').forEach((x) => x.classList.remove('on'));
  el.classList.add('on');
  orderTab = el.dataset.f;
  if (paneData.orders) renderOrders(paneData.orders);
});
async function loadOrders() {
  const payType = document.getElementById('orderFilter').value;
  const [list, anomalies] = await Promise.all([
    authed('/api/admin/orders' + (payType ? '?payType=' + payType : '')).then((r) => r.json()),
    authed('/api/admin/refund-anomalies').then((r) => r.json()).catch(() => null),
  ]);
  paneData.orders = list;
  paneData.refundAnomalies = anomalies;
  refundAnomalyMap = {};
  ((anomalies && anomalies.items) || []).forEach((a) => { refundAnomalyMap[String(a.orderId)] = a; });
  renderRefundAlert(anomalies);
  const cnt = (f) => list.filter((o) => matchOrderTab(o, f)).length;
  document.getElementById('oc-all').textContent = list.length ? ' ' + list.length : '';
  document.getElementById('oc-pending_pay').textContent = cnt('pending_pay') ? ' ' + cnt('pending_pay') : '';
  document.getElementById('oc-toship').textContent = cnt('toship') ? ' ' + cnt('toship') : '';
  document.getElementById('oc-toverify').textContent = cnt('toverify') ? ' ' + cnt('toverify') : '';
  document.getElementById('oc-shipped').textContent = cnt('shipped') ? ' ' + cnt('shipped') : '';
  document.getElementById('oc-done').textContent = cnt('done') ? ' ' + cnt('done') : '';
  document.getElementById('oc-aftersale').textContent = cnt('aftersale') ? ' ' + cnt('aftersale') : '';
  document.getElementById('oc-refund_anomaly').textContent = anomalies && anomalies.count ? ' ' + anomalies.count : '';
  renderOrders(list);
  document.getElementById('refreshHint').textContent = '';
}
/** 退款异常阈值告警条（后台可见，点击标签查看原因并重试） */
function renderRefundAlert(a) {
  const el = document.getElementById('refundAlertBar');
  if (!el) return;
  if (!a || !a.count) { el.style.display = 'none'; el.innerHTML = ''; return; }
  el.style.display = 'block';
  el.innerHTML = `<b>${a.overThreshold ? '退款异常告警' : '退款异常待处理'}</b>：未关闭 ${a.count} 笔，最早已滞留 ${a.oldestHours} 小时（告警阈值 ${a.threshold} 笔）。请切换到「退款异常」标签查看原因并重试。`;
}
function matchOrderTab(o, f) {
  if (f === 'all') return true;
  if (f === 'toship') return o.status === 'paid' && (o.deliveryType || 'express') !== 'store';
  if (f === 'toverify') return o.status === 'paid' && o.deliveryType === 'store';
  if (f === 'refund_anomaly') return !!refundAnomalyMap[String(o.id)];
  if (f === 'aftersale') return o.afterSaleStatus === 'applying' || o.refundStatus === 'PROCESSING' || o.status === 'refunded' || o.status === 'cancelled';
  return o.status === f;
}
function renderOrders(list) {
  const kw = document.getElementById('globalSearch').value.trim();
  const view = list.filter((o) => matchOrderTab(o, orderTab) && (!kw || (o.name || '').includes(kw) || (o.productId || '').includes(kw) || String(o.id || '').includes(kw)));
  const tb = document.querySelector('#orders tbody');
  if (!view.length) { tb.innerHTML = '<tr><td colspan="8"><div class="empty"><div class="e-icon">📦</div>暂无订单</div></td></tr>'; return; }
  tb.innerHTML = view.map((o) => {
    const [pt, pc] = PAY[o.payType] || [o.payType, ''];
    // S4：微信退款处理中不显示"已退款"，展示"退款中"，与资金未变动保持一致；失败单展示明确失败态
    const anomaly = refundAnomalyMap[String(o.id)];
    const refunding = o.refundStatus === 'PROCESSING';
    const refundFailed = ['ABNORMAL', 'CLOSED', 'FAILED'].includes(o.refundStatus);
    const [st, sc] = refundFailed ? ['退款失败', 'danger'] : (refunding ? ['退款中', 'orange'] : (OST[o.status] || [o.status, '']));
    const [at, ac] = AST[o.afterSaleStatus] || ['', ''];
    const info = o.status === 'shipped'
      ? `${o.expressCompany || '快递'} ${o.expressNo || ''}`
      : (o.deliveryType === 'store' && o.status === 'paid'
        ? `核销码 ${o.verifyCode || '-'}`
        : (o.storeVerifiedAt ? '已核销 ' + String(o.storeVerifiedAt).slice(0, 16).replace('T', ' ')
          : (o.doneAt ? '完成 ' + String(o.doneAt).slice(0, 16).replace('T', ' ') : (DLV[o.deliveryType] || '快递'))));
    const btns = [];
    if (o.status === 'paid' && (o.deliveryType || 'express') !== 'store') btns.push(`<button class="sm" data-act="shipOrder" data-id="${escHtml(o.id)}">发货</button>`);
    if (o.status === 'paid' && o.deliveryType === 'store') btns.push(`<button class="sm" data-act="verifyOrder" data-id="${escHtml(o.id)}">核销</button>`, `<button class="sm ghost" data-act="completeOrder" data-id="${escHtml(o.id)}">强制完成</button>`);
    if (o.status === 'shipped') btns.push(`<button class="sm ghost" data-act="completeOrder" data-id="${escHtml(o.id)}">完成</button>`);
    if (['paid', 'shipped', 'done'].includes(o.status) && !refunding && !refundFailed && !anomaly) btns.push(`<button class="sm plain" data-act="refund" data-id="${escHtml(o.id)}">退款</button>`);
    if (refunding && o.refundNo) btns.push(`<button class="sm ghost" data-act="syncRefund" data-id="${escHtml(o.id)}">查询退款</button>`);
    if (anomaly) btns.push(`<button class="sm" data-act="retryRefund" data-id="${escHtml(o.id)}">重试</button>`);
    if (o.afterSaleStatus === 'applying' && !refunding && !anomaly) btns.push(`<button class="sm" data-act="handleAfterSale" data-id="${escHtml(o.id)}" data-p1="true">受理</button>`, `<button class="sm ghost" data-act="handleAfterSale" data-id="${escHtml(o.id)}" data-p1="false">驳回</button>`);
    const statusCell = `<span class="tag ${sc}">${st}</span>${at ? `<div><span class="tag ${ac}" style="margin-top:3px">${at}</span></div>` : ''}`;
    const anomalyLine = anomaly
      ? `<div class="muted" style="color:var(--danger)">异常：${escHtml(anomaly.reason || '')} · 已重试 ${anomaly.attempts || 0} 次</div>` : '';
    return `<tr>
      <td><div class="prod-cell">${thumbHtml(o.imageUrl, o.name)}<div><div class="p-name">${escHtml(o.name || o.productId)}</div><div class="muted">ID ${escHtml(o.id || '')} · ${escHtml(o.userId || '')}</div></div></div></td>
      <td><span class="tag ${pc}">${pt}</span></td>
      <td>${statusCell}</td>
      <td>${o.priceYuan}</td><td class="money">${o.paidYuan}</td><td>${o.step || '-'}</td>
      <td class="muted">${escHtml(info)}${anomalyLine}</td><td>${btns.join(' ') || '<span class="muted">-</span>'}</td></tr>`;
    }).join('');
}
// ---------- 履约（V3.5） ----------
async function shipOrder(id) {
  const company = prompt('快递公司：', '顺丰速运');
  if (!company) return;
  const trackingNo = prompt('快递单号：');
  if (!trackingNo) return;
  const r = await post('/api/admin/orders/ship', { orderId: String(id), company, trackingNo });
  r.error ? toast('失败：' + r.error, 'err') : toast('已发货');
  loadOrders();
}
async function verifyOrder(id) {
  const verifyCode = prompt('消费码（用户小程序端显示为「消费码」，6 位）：');
  if (!verifyCode) return;
  const r = await post('/api/admin/orders/verify', { orderId: String(id), verifyCode });
  r.error ? toast('失败：' + r.error, 'err') : toast('核销完成');
  loadOrders();
}
async function completeOrder(id) {
  const note = prompt('强制完成备注（选填）：') || '';
  if (!confirm('确认将该订单标记为已完成？售后期将从此开始计时。')) return;
  const r = await post('/api/admin/orders/complete', { orderId: String(id), note });
  r.error ? toast('失败：' + r.error, 'err') : toast('已完成');
  loadOrders();
}
async function handleAfterSale(id, approved) {
  const note = prompt(approved ? '受理备注（选填）：' : '驳回原因（必填）：') || '';
  if (!approved && !note) return;
  const r = await post('/api/admin/orders/after-sale/resolve', { orderId: String(id), approved, note });
  if (r.error) toast('失败：' + r.error, 'err');
  else if (r.pending) toast('微信退款处理中，到账后再完成售后');
  else toast('已处理');
  loadOrders();
}
async function refund(orderId) {
  if (!confirm('确认为该订单退款？已发的佣金和分红池会按这单退回。')) return;
  const r = await post('/api/admin/orders/refund', { orderId });
  if (r.error) toast('失败：' + r.error, 'err');
  else if (r.pending) toast('微信退款处理中，到账后自动完成');
  else toast('退款完成');
  loadOrders();
}
/** 主动查询微信退款单（处理中订单不再永久卡住） */
async function syncRefund(orderId) {
  const r = await post('/api/admin/orders/refund/sync', { orderId: String(orderId) });
  if (r.error) toast('查询失败：' + r.error, 'err');
  else if (r.finalized) toast('退款已到账，订单已完成退款');
  else if (r.failed) toast('微信退款失败：' + ((r.order && r.order.refundError) || r.status), 'err');
  else toast('微信退款仍在处理中，请稍后再查');
  loadOrders();
}
/** 异常重试：先查单，失败/关闭则重新发起微信退款 */
async function retryRefund(orderId) {
  const note = prompt('重试备注（选填）：') || '';
  if (!confirm('确认重试该笔退款？系统会先查询微信退款状态，必要时重新发起退款。')) return;
  const r = await post('/api/admin/refund-anomalies/retry', { orderId: String(orderId), note });
  if (r.error) toast('重试失败：' + r.error, 'err');
  else if (r.finalized) toast('退款已完成');
  else if (r.failed) toast('微信退款失败：' + ((r.order && r.order.refundError) || r.status), 'err');
  else toast('微信退款仍在处理中，已记录本次重试');
  loadOrders();
}

