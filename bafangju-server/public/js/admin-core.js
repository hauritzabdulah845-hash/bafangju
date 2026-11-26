// admin-core.js —— 鉴权 / Toast / 凭据弹窗 / 常量 / 操作事件委托 / 页面导航
// ==================== 身份与权限（两级账号） ====================
// MY.role: 'super'（总账号，全部权限）| 'admin'（子管理员，按模块授权）
// 前端只做展示层隐藏；真正的权限拦截在服务端逐请求判定，改前端绕不过去。
let MY = { uid: '', username: sessionStorage.getItem('bfj_admin_user') || '', role: 'super', permissions: 'all' };
const PANE_PERM = {
  orders: 'orders', catalog: 'catalog', merchants: 'merchants', adCenter: 'adCenter', content: 'content',
  withdraw: 'withdraw', queue: 'queue', reserve: 'reserve', jobs: 'jobs',
  switches: 'switches', risk: 'risk', messages: 'messages', settings: 'settings', audit: 'audit',
  users: '__super',
};
function can(perm) {
  if (MY.role === 'super' || MY.permissions === 'all') return true;
  return Array.isArray(MY.permissions) && MY.permissions.includes(perm);
}
function canPane(pane) {
  const need = PANE_PERM[pane];
  if (!need) return true;          // 经营看板等公共页
  if (need === '__super') return MY.role === 'super';
  return can(need);
}
/** 登录/会话恢复后调用：写身份、按权限隐藏侧栏、校正当前页 */
function applyIdentity(me) {
  MY = {
    uid: me.uid || '',
    username: me.username || '',
    role: me.role === 'super' ? 'super' : 'admin',
    permissions: me.role === 'super' ? 'all' : (me.permissions || []),
  };
  sessionStorage.setItem('bfj_admin_user', MY.username);
  document.getElementById('whoami').textContent = MY.username + (MY.role === 'super' ? ' · 总账号' : ' · 管理员');
  document.querySelectorAll('.sidebar .tab').forEach((t) => {
    t.style.display = canPane(t.dataset.pane) ? '' : 'none';
  });
  // 分组标题：组内全部菜单被隐藏时，标题也一起隐藏
  document.querySelectorAll('.sidebar .nav-group').forEach((g) => {
    let n = g.nextElementSibling;
    let visible = false;
    while (n && !n.classList.contains('nav-group')) {
      if (n.classList.contains('tab') && n.style.display !== 'none') visible = true;
      n = n.nextElementSibling;
    }
    g.style.display = visible ? '' : 'none';
  });
  // 当前页若无权限，回落到经营看板
  if (!canPane(curPane)) {
    const home = document.querySelector('.sidebar .tab[data-pane="overview"]');
    if (home) home.click();
  }
}

// ==================== 鉴权 ====================
let TOKEN = sessionStorage.getItem('bfj_admin_token') || '';
function showLogin(msg) {
  document.getElementById('loginMask').style.display = 'flex';
  document.getElementById('topbar').style.display = 'none';
  if (msg) document.getElementById('loginErr').textContent = msg;
}
function showMain() {
  document.getElementById('loginMask').style.display = 'none';
  document.getElementById('topbar').style.display = 'block';
}
async function authed(url, opts = {}) {
  opts.headers = Object.assign({}, opts.headers, TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {});
  const r = await fetch(url, opts);
  if (r.status === 401) { showLogin('会话已失效，请重新登录'); throw new Error('未登录'); }
  return r;
}
/** 登录密码可见切换（眼睛按钮） */
function togglePassEye(btn) {
  const inp = btn.parentNode && btn.parentNode.querySelector('input');
  if (!inp) return;
  const show = inp.type === 'password';
  inp.type = show ? 'text' : 'password';
  btn.classList.toggle('on', show);
}

async function doLogin() {
  const username = document.getElementById('loginUser').value.trim();
  const password = document.getElementById('loginPass').value;
  document.getElementById('loginErr').textContent = '';
  try {
    const r = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    const d = await r.json();
    if (d.error) { document.getElementById('loginErr').textContent = d.error; return; }
    TOKEN = d.token;
    sessionStorage.setItem('bfj_admin_token', TOKEN);
    applyIdentity({ uid: d.uid || '', username: d.username || username, role: d.role || 'super', permissions: d.permissions || [] });
    showMain();
    loadOverview();
    // 仍在使用开发默认口令时给出改密提醒（生产环境不会命中：默认口令已被拒绝启动/自动轮换）
    if (d.devDefault) toast('当前仍在使用开发默认口令，请立即修改密码', 'err');
  } catch (e) { document.getElementById('loginErr').textContent = '登录失败：' + e.message; }
}
async function doLogout() {
  try { await authed('/api/admin/logout', { method: 'POST' }); } catch (e) {}
  TOKEN = ''; sessionStorage.removeItem('bfj_admin_token');
  showLogin('');
}

// ==================== Toast ====================
function toast(msg, type = 'ok') {
  const box = document.getElementById('toast');
  const el = document.createElement('div');
  el.className = 'toast-item ' + type;
  el.innerHTML = `<span class="t-ic">${type === 'ok' ? '✓' : '✕'}</span><span>${escHtml(msg)}</span>`;
  box.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, 2600);
}
const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ==================== 右侧详情抽屉（通用） ====================
/** 关闭右侧抽屉；传入 event 时只在点击 mask 背景时生效，点击内容区不关闭 */
function closeDrawer(id, e) {
  const mask = document.getElementById(id);
  if (!mask) return;
  if (e && e.target !== mask) return; // 点击了抽屉内部，不关闭
  mask.classList.remove('on');
}

// ==================== 凭据展示弹窗（替代原生 alert，可复制） ====================
let SECRET_TEXT = '';
/**
 * 展示凭据（初始密码 / token 等）。
 * @param {string} title 弹窗标题
 * @param {Array<{label:string,value:string}>} rows 逐行展示的字段
 * @param {string} [note] 顶部提示（可选）
 */
function showSecret(title, rows, note) {
  SECRET_TEXT = rows.map((r) => `${r.label}：${r.value}`).join('\n');
  document.getElementById('secretTitle').textContent = title;
  document.getElementById('secretBody').innerHTML =
    (note ? `<p class="secret-note">${escHtml(note)}</p>` : '') +
    rows.map((r, i) => `<div class="secret-row"><div class="s-label">${escHtml(r.label)}</div>
      <div class="secret-line"><input type="text" readonly value="${escHtml(r.value)}" id="secretIn${i}">
      <button class="sm plain" onclick="copyOne(${i})">复制</button></div></div>`).join('');
  document.getElementById('secretModal').style.display = 'flex';
}
function closeSecretModal() {
  document.getElementById('secretModal').style.display = 'none';
  // 关闭即清空 DOM 与内存副本，避免凭据残留在页面上
  document.getElementById('secretBody').innerHTML = '';
  SECRET_TEXT = '';
}
function copyOne(i) {
  const el = document.getElementById('secretIn' + i);
  if (!el) return;
  el.select();
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(el.value).then(() => toast('已复制'), () => toast('复制失败，请手动选择文本', 'err'));
  } else {
    try { document.execCommand('copy'); toast('已复制'); }
    catch (e) { toast('复制失败，请手动选择文本', 'err'); }
  }
}
function copySecret() {
  if (!SECRET_TEXT) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(SECRET_TEXT).then(() => toast('已复制全部内容'), () => toast('复制失败，请手动选择文本', 'err'));
  } else {
    const ta = document.createElement('textarea');
    ta.value = SECRET_TEXT;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('已复制全部内容'); }
    catch (e) { toast('复制失败，请手动选择文本', 'err'); }
    ta.remove();
  }
}

// ==================== 常量 ====================
const S = { indirectReferralEnabled: '间接邀请奖励（默认关）', queueDividendEnabled: '排队分红发放', auditDowngrade: '审核期降级（隐藏分红/团队入口）', freeOrderRefundEnabled: '老免单订单退款通道', contributionValuePublishEnabled: '贡献值参考价值公示' };
const yuan = (fen) => '¥' + ((fen || 0) / 100).toFixed(2);
const PAY = { WX_PAY: ['微信支付', 'blue'], FREE: ['免单·历史', 'gold'] };
const OST = { pending_pay: ['待支付', ''], paid: ['已支付', 'green'], shipped: ['已发货', 'green'], done: ['已完成', 'green'], refunded: ['已退款', 'danger'], cancelled: ['已取消', ''] };
const AST = { applying: ['售后中', 'orange'], approved: ['售后已受理', 'accent'], rejected: ['售后已驳回', 'danger'] };
const DLV = { express: '快递', store: '到店' };
const ICON_FALLBACK = [['餐饮', '🍜'], ['甜品|茶|饮|奶茶', '🧋'], ['生鲜|果蔬|菜', '🥬'], ['超市|便利', '🛒'], ['休闲|玩|娱乐', '🎳'], ['丽人|美|理发', '💇'], ['健康|养生|按摩', '💆'], ['酒店|旅行|住宿', '🏨'], ['亲子|儿童|乐园', '🎠'], ['家政|保洁|维修', '🧹'], ['粮油|食品', '🌾'], ['百货|家居', '🛍️']];
const matchIcon = (name) => { for (const [kw, ic] of ICON_FALLBACK) if (kw.split('|').some((k) => (name || '').includes(k))) return ic; return '🎁'; };
const thumbHtml = (url, name) => url ? `<img class="thumb" src="${escHtml(url)}" alt="">` : `<span class="thumb-ph">${matchIcon(name)}</span>`;

// ==================== 操作事件委托（P3-8） ====================
// 列表里的操作按钮不再把 id 直接拼进 onclick 属性字符串，改为 data-act + data-id，
// 由下面这一个监听器统一分发：id 不进入 HTML 属性里的 JS 字面量，天然规避引号注入。
// 额外参数用 data-p1 / data-p2 承载；'true'/'false' 字符串自动转布尔。
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = window[el.dataset.act];
  if (typeof fn !== 'function') return;
  e.preventDefault();
  const cast = (v) => (v === 'true' ? true : v === 'false' ? false : v);
  fn(el.dataset.id, cast(el.dataset.p1), cast(el.dataset.p2));
});

// 侧栏版本号：读 /api/rules/version 的规则版本（不再写死在 HTML 里，避免每次发版忘记改）
(async function showVersion() {
  const el = document.getElementById('appVersion');
  if (!el) return;
  try {
    const r = await fetch('/api/rules/version').then((x) => x.json());
    if (r && r.version) el.textContent = r.version;
  } catch (e) { /* 保留静态文案 */ }
})();

// ==================== 页面导航 ====================
let curPane = 'overview';
const paneData = {}; // 各页数据缓存（供全局搜索过滤）
// 窄屏抽屉开关（P1-6）
function toggleNav(open) {
  const on = open === undefined ? !document.body.classList.contains('nav-open') : open;
  document.body.classList.toggle('nav-open', on);
  const burger = document.getElementById('navBurger');
  if (burger) burger.setAttribute('aria-expanded', on ? 'true' : 'false');
}
document.getElementById('navBurger').onclick = () => toggleNav();
// 低频配置菜单折叠：默认收起，避免 16 个菜单把日常 6 项挤到看不见
function setAdvNav(open) {
  const bar = document.querySelector('.sidebar');
  if (!bar) return;
  bar.classList.toggle('nav-collapsed', !open);
  const g = document.getElementById('advNavGroup');
  if (g) {
    g.setAttribute('aria-expanded', open ? 'true' : 'false');
    g.title = open ? '收起低频配置菜单' : '展开低频配置菜单';
  }
  try { sessionStorage.setItem('bfj_admin_nav_adv', open ? '1' : '0'); } catch (e) {}
}
function toggleAdvNav() { setAdvNav(document.querySelector('.sidebar').classList.contains('nav-collapsed')); }
setAdvNav(sessionStorage.getItem('bfj_admin_nav_adv') === '1');
document.querySelectorAll('.sidebar .tab').forEach((t) => t.onclick = () => {
  toggleNav(false); // 窄屏选完菜单自动收起抽屉
  if (t.dataset.adv) setAdvNav(true); // 从待办跳进低频页时自动展开，避免侧栏里找不到当前页
  if (!canPane(t.dataset.pane)) return toast('当前账号没有该模块的权限', 'err'); // 服务端仍会拦截，这里只是提前拦
  document.querySelectorAll('.sidebar .tab').forEach((x) => x.classList.remove('on'));
  document.querySelectorAll('.pane').forEach((x) => x.classList.remove('on'));
  t.classList.add('on');
  curPane = t.dataset.pane;
  document.getElementById('pane-' + curPane).classList.add('on');
  document.getElementById('pageTitle').textContent = t.dataset.title || t.textContent.trim();
  document.getElementById('pageSub').textContent = t.dataset.sub || '';
  document.getElementById('globalSearch').value = '';
  document.getElementById('refreshHint').textContent = '';
  syncSearchState();
  // 每个面板都必须在这里挂加载函数：漏挂 = 进入面板后数据区永久空白（储备金/功能开关曾因此没有任何数据）
  const L = {
    overview: loadOverview, orders: loadOrders, catalog: loadCatalog, queue: loadSlots,
    withdraw: () => { loadWithdraws(); loadTransfers(); loadRewardWithdrawals(); },
    adCenter: () => { loadAdRewardPane(); loadAds(); },
    merchants: () => { loadMerchants(); loadEntryApps(); loadAlliance(); loadFeeBills(); },
    users: loadAdminUsers, content: loadContent, risk: loadRisk, jobs: loadJobs,
    messages: loadMessages, settings: loadSettings, audit: loadAudit,
    // 兜底式加载：这两个面板之前没有加载入口，切过去只见空白卡片
    switches: () => loadSwitches(),
    reserve: () => loadReserve(),
  }[curPane];
  if (L) L();
});
function gotoPane(pane) { const tab = document.querySelector(`.sidebar .tab[data-pane="${pane}"]`); if (tab) tab.click(); }

// 全局搜索：仅订单 / 商品两页有数据可过滤。
// 其它页面禁用输入框并给出提示，避免「敲了字却毫无反应」被误判为系统卡死。
const SEARCH_PANES = { orders: '订单', catalog: '商品' };
function syncSearchState() {
  const box = document.getElementById('globalSearch');
  if (!box) return;
  const label = SEARCH_PANES[curPane];
  box.disabled = !label;
  box.placeholder = label
    ? `搜索当前页${label}（回车或边输边筛）`
    : '当前页不支持搜索（仅订单 / 商品页可用）';
  box.title = label ? '' : '全局搜索目前只覆盖订单与商品两页';
}
document.getElementById('globalSearch').addEventListener('input', (e) => {
  const kw = e.target.value.trim();
  if (curPane === 'orders' && paneData.orders) {
    const hit = filterOrders(paneData.orders, kw);
    renderOrders(hit);
    if (kw && !hit.length) document.getElementById('refreshHint').textContent = `没有匹配「${kw}」的订单`;
    else document.getElementById('refreshHint').textContent = '';
  }
  if (curPane === 'catalog' && paneData.catalog) {
    const hit = filterProducts(paneData.catalog, kw);
    renderProducts(hit);
    if (kw && !hit.length) document.getElementById('refreshHint').textContent = `没有匹配「${kw}」的商品`;
    else document.getElementById('refreshHint').textContent = '';
  }
});
function filterOrders(list, kw) {
  if (!kw) return list;
  return list.filter((o) => (o.name || '').includes(kw) || (o.productId || '').includes(kw) || String(o.id || '').includes(kw));
}
function filterProducts(list, kw) {
  if (!kw) return list;
  return list.filter((p) => (p.name || '').includes(kw) || String(p.id || '').includes(kw));
}

