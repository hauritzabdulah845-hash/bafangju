// admin-overview.js —— 经营看板（KPI / 履约待办 / 近 7 日趋势）
// ==================== 经营看板 ====================
const isToday = (iso) => { const d = new Date(iso); const n = new Date(); return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate(); };
const dateKey = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const todayKey = () => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`; };

async function loadOverview() {
  const [home, pool, contrib, platform, res, orders, merchants, entryApps, ads, publicStats, pendingProds, adVideos] = await Promise.all([
    fetch('/api/home').then((r) => r.json()),
    fetch('/api/dividend/pool').then((r) => r.json()).catch(() => ({})),
    fetch('/api/contribution/value').then((r) => r.json()).catch(() => ({})),
    authed('/api/admin/platform-flows').then((r) => r.json()).catch(() => ({ balanceFen: 0 })),
    authed('/api/admin/withdraw/requests').then((r) => r.json()).then((d) => d.requests || d).catch(() => []),
    authed('/api/admin/orders').then((r) => r.json()).catch(() => []),
    authed('/api/admin/merchants').then((r) => r.json()).catch(() => []),
    authed('/api/admin/merchant-applications').then((r) => r.json()).catch(() => []),
    authed('/api/admin/adslots').then((r) => r.json()).catch(() => ({})),
    fetch('/api/stats/public').then((r) => r.json()).catch(() => ({})),
    authed('/api/admin/catalog/products/pending').then((r) => r.json()).catch(() => []),
    authed('/api/admin/advideos?status=draft').then((r) => r.json()).catch(() => ({})),
  ]);
  const fulfill = await authed('/api/admin/orders/fulfillment-summary').then((r) => r.json()).catch(() => ({}));
  const daily = await authed('/api/admin/stats/daily').then((r) => r.json()).catch(() => []);

  // 今日经营（前端从订单流真实聚合）
  const todays = orders.filter((o) => isToday(o.createdAt));
  const todayPaid = todays.filter((o) => ['paid', 'shipped', 'done'].includes(o.status));
  const todayGmv = todayPaid.reduce((s, o) => s + (o.paidFen || 0), 0);
  const yesterday = daily.find((d) => d.date === dateKey(new Date(Date.now() - 86400000)));
  const todayStat = daily.find((d) => d.date === todayKey());
  const yOrd = yesterday ? yesterday.paidOrders : (todayStat ? todayStat.paidOrders : 0);
  const ordDelta = todayPaid.length - yOrd;
  const deltaHtml = ordDelta === 0 ? '<span class="muted">较昨日持平</span>' : `<span class="${ordDelta > 0 ? 'k-up' : 'k-down'}">较昨日 ${ordDelta > 0 ? '+' : ''}${ordDelta} 单</span>`;

  const pending = res.filter((r) => r.status === 'pending_review').length;
  const pendingEntry = entryApps.filter((a) => a.status === 'pending_review').length;
  const pendingAd = (ads.pending || []).length;
  const pendingVideo = (adVideos.videos || []).length;
  const pendingProd = Array.isArray(pendingProds) ? pendingProds.length : 0; // 商家提审商品：商品审核是平台守定价公信力的核心动作，必须在看板露出（无权限时接口返回错误对象，按 0 处理）
  const activeMerchants = merchants.filter((m) => m.status === 'active').length;

  const kpi = (label, value, note, hot) =>
    `<div class="kpi ${hot ? 'hot' : ''}"><div class="k-label">${label}</div><b>${value}</b><div class="k-note">${note || ''}</div></div>`;
  document.getElementById('kpis').innerHTML = [
    kpi('今日支付金额', yuan(todayGmv), `今日支付订单 ${todayPaid.length} 笔`, true),
    kpi('今日支付订单', todayPaid.length + ' <span style="font-size:13px;font-weight:400;color:var(--ink2)">笔</span>', deltaHtml),
    kpi('累计注册用户', publicStats.users == null ? '-' : publicStats.users + ' <span style="font-size:13px;font-weight:400;color:var(--ink2)">人</span>', `累计为用户节省 ${yuan(publicStats.savedFen || 0)}`),
    kpi('在营商家', activeMerchants + ' <span style="font-size:13px;font-weight:400;color:var(--ink2)">家</span>', `累计入驻 ${merchants.length} 家`),
  ].join('');

  // 履约待办大入口（全部真实计数，可点击跳转）
  const todos = [
    { n: pendingProd, label: '待审商品', pane: 'catalog', go: '去审核 ›' },
    { n: fulfill.pendingShip || 0, label: '待发货', pane: 'orders', tab: 'toship', go: '去发货 ›' },
    { n: fulfill.pendingVerify || 0, label: '待核销', pane: 'orders', tab: 'toverify', go: '去核销 ›' },
    { n: fulfill.afterSaleApplying || 0, label: '售后中', pane: 'orders', tab: 'aftersale', go: '去处理 ›' },
    { n: pending, label: '待审提现', pane: 'withdraw', go: '去审核 ›' },
    { n: pendingEntry, label: '待审入驻', pane: 'merchants', go: '去审核 ›' },
    { n: pendingAd, label: '待审轮播广告', pane: 'adCenter', zone: 'slot', go: '去审核 ›' },
    { n: pendingVideo, label: '待审核视频广告', pane: 'adCenter', zone: 'video', go: '去审核 ›' },
  ];
  document.getElementById('todoGrid').innerHTML = todos.map((t) => `
    <div class="todo-cell ${t.n > 0 ? 'alert' : ''}" data-act="gotoTodo" data-id="${escHtml(t.pane)}" data-p1="${escHtml(t.tab || '')}" data-p2="${escHtml(t.zone || '')}">
      <div class="tc-label"><span class="tc-dot"></span>${t.label}</div>
      <div class="tc-num">${t.n}</div>
      <div class="tc-go">${t.n > 0 ? t.go : '全部处理完成'}</div>
    </div>`).join('');
  document.getElementById('fulfillUpdated').textContent = '数据更新于 ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

  // 侧边角标
  const setBadge = (id, n) => { const el = document.getElementById(id); if (!el) return; el.textContent = n; el.classList.toggle('zero', !n); };
  setBadge('badge-catalog', pendingProd);
  setBadge('badge-withdraw', pending);
  setBadge('badge-merchants', pendingEntry);
  setBadge('badge-ads', pendingAd + pendingVideo);

  // 资金概况
  document.getElementById('fundCards').innerHTML = [
    `<div class="kpi"><div class="k-label">分红池余额（每日公示）</div><b>${yuan(pool.balanceFen)}</b><div class="k-note">只分平台真实利润</div></div>`,
    `<div class="kpi"><div class="k-label">平台留存（已对账）</div><b>${yuan(platform.balanceFen)}</b><div class="k-note">暂无归属的资金 + 周期留存 + 联盟/广告收入</div></div>`,
    `<div class="kpi"><div class="k-label">贡献值参考价值</div><b>${contrib.unitValueYuan == null ? '未公示' : '¥' + contrib.unitValueYuan + '/分'}</b><div class="k-note">流通总量 ${contrib.totalWeight == null ? '-' : contrib.totalWeight} 分</div></div>`,
  ].join('');

  // 系统开关 chips
  document.getElementById('swChips').innerHTML = Object.entries(S).map(([k, label]) => {
    const on = !!home.switches[k];
    const cls = k === 'auditDowngrade' && on ? 'alert' : (on ? 'on' : 'off');
    return `<span class="sw-chip ${cls}"><i></i>${label}${on ? ' · 开启' : ' · 关闭'}</span>`;
  }).join('') + `<span class="sw-chip ${home.switches.withdrawEnabled ? 'on' : 'off'}"><i></i>提现总开关${home.switches.withdrawEnabled ? ' · 开启' : ' · 关闭'}</span>`;

  loadTrend(daily);
  loadSwitches(home);
  loadAudit();
}
function gotoTodo(pane, tab, zone) {
  gotoPane(pane);
  if (tab) { setTimeout(() => { const el = document.querySelector(`#pane-${pane} .tr-item[data-f="${tab}"]`); if (el) el.click(); }, 60); }
  if (zone) setTimeout(() => switchAdZone(zone), 60);
}

// 近 7 日趋势图：零依赖内联 SVG（橙柱 = GMV / 蓝线 = 有效订单，渲染见 trend-chart.js）
function loadTrend(data) {
  const el = document.getElementById('trendChart');
  if (!el) return;
  el.innerHTML = (typeof TrendChart !== 'undefined')
    ? TrendChart.render(data)
    : '<div class="empty">趋势图组件未加载</div>';
}
