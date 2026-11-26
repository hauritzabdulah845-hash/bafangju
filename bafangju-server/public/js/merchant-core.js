// merchant-core.js —— H5 商家端核心：鉴权 / API / Toast / 导航 / 工具
// token 存 localStorage（商家手机端，关浏览器保持登录）；退出登录清除。
'use strict';

let TOKEN = localStorage.getItem('bfj_merchant_token') || '';
let MERCHANT = { id: localStorage.getItem('bfj_merchant_id') || '', name: localStorage.getItem('bfj_merchant_name') || '' };

const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// 商品/封面图兜底：素材被删或上传中断时显示占位块，而不是浏览器默认的破图图标。
// 用法：<img class="thumb" src="..." alt="" onerror="imgFallback(this,'🛍️','thumb-ph')">
function imgFallback(img, emoji, phClass) {
  const ph = document.createElement('span');
  ph.className = phClass || 'thumb-ph';
  ph.textContent = emoji || '🛍️';
  if (img.parentNode) img.parentNode.replaceChild(ph, img);
}
const fen2yuan = (fen) => ((fen || 0) / 100).toFixed(2);
const yuan = (fen) => '¥' + fen2yuan(fen);

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso).slice(0, 16);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

// ---------- 密码可见切换（眼睛）：登录页 / 改密子页共用 ----------
function togglePassEye(btn) {
  const inp = btn.parentNode && btn.parentNode.querySelector('input');
  if (!inp) return;
  const show = inp.type === 'password';
  inp.type = show ? 'text' : 'password';
  btn.classList.toggle('on', show);
}

// ---------- Toast ----------
function toast(msg, type = 'ok') {
  const box = document.getElementById('toast');
  const el = document.createElement('div');
  el.className = 'toast-item';
  el.textContent = msg;
  if (type === 'err') el.style.background = 'rgba(197,34,31,.92)';
  box.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, 2400);
}

// ---------- API ----------
async function api(url, opts = {}) {
  opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers,
    TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {});
  if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
  const r = await fetch(url, opts);
  let d = null;
  try { d = await r.json(); } catch (e) { /* ignore */ }
  if (r.status === 401) { logout('登录已失效，请重新登录'); throw new Error('未登录'); }
  if (d && d.error) throw new Error(d.error);
  if (!r.ok) throw new Error('请求失败（' + r.status + '）');
  return d;
}
const apiGet = (url) => api(url);
const apiPost = (url, body) => api(url, { method: 'POST', body: body || {} });

// ---------- 登录 / 退出 ----------
function showLogin(msg) {
  document.getElementById('loginView').style.display = 'block';
  document.getElementById('mainView').style.display = 'none';
  if (msg) document.getElementById('loginErr').textContent = msg;
}
function showMain() {
  document.getElementById('loginView').style.display = 'none';
  document.getElementById('mainView').style.display = 'flex';
  document.getElementById('headMerchant').textContent = MERCHANT.name;
}

async function doLogin() {
  const username = document.getElementById('loginUser').value.trim();
  const password = document.getElementById('loginPass').value;
  const errEl = document.getElementById('loginErr');
  errEl.textContent = '';
  if (!username || !password) { errEl.textContent = '请输入账号与密码'; return; }
  const btn = document.getElementById('loginBtn');
  btn.disabled = true;
  try {
    const r = await fetch('/api/merchant/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const d = await r.json();
    if (d.error) { errEl.textContent = d.error; return; }
    TOKEN = d.token;
    MERCHANT = { id: d.merchantId, name: d.name };
    localStorage.setItem('bfj_merchant_token', TOKEN);
    localStorage.setItem('bfj_merchant_id', d.merchantId);
    localStorage.setItem('bfj_merchant_name', d.name);
    showMain();
    switchTab('home');
    if (d.mustChangePassword) {
      setTimeout(() => { toast('当前使用初始密码，请到「我的 → 修改密码」更换', 'err'); openSub('password'); }, 600);
    }
  } catch (e) {
    errEl.textContent = '登录失败：' + e.message;
  } finally {
    btn.disabled = false;
  }
}

function logout(msg) {
  TOKEN = '';
  MERCHANT = { id: '', name: '' };
  localStorage.removeItem('bfj_merchant_token');
  localStorage.removeItem('bfj_merchant_id');
  localStorage.removeItem('bfj_merchant_name');
  showLogin(msg || '');
}

// ---------- 导航 ----------
const TABS = { home: '工作台', verify: '核销', products: '商品', orders: '订单', me: '我的' };
let curTab = 'home';
const SUB_TITLES = { earnings: '收益明细', withdraw: '提现', coupons: '优惠券', ads: '轮播广告', adVideos: '视频广告', password: '修改密码' };
let curSub = '';

function switchTab(tab) {
  curTab = tab; curSub = '';
  document.querySelectorAll('.tabbar .tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === tab));
  document.querySelectorAll('.pane').forEach((p) => p.classList.remove('on'));
  document.getElementById('pane-' + tab).classList.add('on');
  document.getElementById('pageTitle').textContent = TABS[tab];
  document.getElementById('pageBody').scrollTop = 0;
  const L = { home: loadHome, verify: renderVerify, products: loadProducts, orders: loadOrders, me: loadMe }[tab];
  if (L) L();
}

// 打开子页（收益/提现/券/广告/改密码）
function openSub(sub) {
  curSub = sub;
  document.querySelectorAll('.pane').forEach((p) => p.classList.remove('on'));
  const pane = document.getElementById('pane-sub');
  pane.classList.add('on');
  document.getElementById('pageTitle').textContent = SUB_TITLES[sub] || '';
  document.getElementById('pageBody').scrollTop = 0;
  const L = { earnings: loadEarnings, withdraw: loadWithdraw, coupons: loadCoupons, ads: loadAds, adVideos: loadAdVideos, password: renderPassword }[sub];
  if (L) L(pane);
}
function closeSub() { switchTab(curTab); }

function subHeadHtml(title) {
  return `<div class="sub-head"><div class="sub-back" onclick="closeSub()">‹ 返回</div><div class="sub-title">${escHtml(title)}</div></div>`;
}

// ---------- 图片上传（商品图 / 广告素材） ----------
function pickImage(cb) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/*';
  inp.onchange = () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) { toast('图片不能超过 5MB', 'err'); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = String(reader.result).split(',')[1] || '';
      const ext = (f.name.split('.').pop() || 'jpg').toLowerCase();
      try {
        const u = await apiPost('/api/upload', { dataBase64: base64, ext, purpose: 'material' });
        cb(null, u.url);
      } catch (e) { cb(e); }
    };
    reader.onerror = () => cb(new Error('读取图片失败'));
    reader.readAsDataURL(f);
  };
  inp.click();
}

// ---------- 视频上传（广告视频，商家端限 10 次/分钟） ----------
function pickVideo(cb) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'video/mp4,video/quicktime';
  inp.onchange = () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    if (f.size > 24 * 1024 * 1024) { toast('视频不能超过 24MB', 'err'); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = String(reader.result).split(',')[1] || '';
      try {
        const u = await apiPost('/api/merchant/upload/video', { dataBase64: base64 });
        cb(null, u.url, f.name);
      } catch (e) { cb(e); }
    };
    reader.onerror = () => cb(new Error('读取视频失败'));
    reader.readAsDataURL(f);
  };
  inp.click();
}

// ---------- 启动 ----------
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('loginPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  if (TOKEN && MERCHANT.id) {
    // 有缓存会话：先直接进主界面，再静默校验 token 有效性
    showMain();
    switchTab('home');
    apiGet('/api/merchant/overview').catch(() => {});
  } else {
    showLogin('');
  }
});
