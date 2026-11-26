// 文案配置读取（后台可编辑，改文案不用发版）
// 用法：页面 onLoad/onShow 里 content.ready().then(() => this.applyContent())
//      wxml 写成 {{ct.xxx || '小程序内置文案'}} —— 后台没配就自动回落内置文案
const api = require('./api');

const CACHE_KEY = 'bfj_content_v1';
const TTL = 60000; // 60 秒内不重复拉

let mem = null;
let lastAt = 0;
let inflight = null;

function readCache() {
  if (mem) return mem;
  try {
    const s = wx.getStorageSync(CACHE_KEY);
    if (s && s.items) { mem = s.items; lastAt = s.ts || 0; }
  } catch (e) { /* 存储不可用时仅用内存 */ }
  if (!mem) mem = {};
  return mem;
}

function fetchRemote() {
  if (inflight) return inflight;
  inflight = api.get('/api/content').then((d) => {
    const items = (d && d.items) || {};
    mem = items;
    lastAt = Date.now();
    try { wx.setStorageSync(CACHE_KEY, { items, ts: lastAt, v: (d && d.version) || '' }); } catch (e) { /* ignore */ }
    return items;
  }, () => readCache()).then((r) => { inflight = null; return r; });
  return inflight;
}

/** 页面入口：先用缓存/内存立即渲染，需要时静默刷新（刷新结果下次进入或 60s 后生效） */
function ready() {
  const items = readCache();
  if (!lastAt || Date.now() - lastAt > TTL) fetchRemote();
  return Promise.resolve(items);
}

/** 取单条文案（未配置返回空串，由 wxml 的 || 兜底） */
function text(key) {
  const v = readCache()[key];
  return typeof v === 'string' ? v.trim() : '';
}

/** 多行文案 → 行数组（去空行） */
function lines(key) {
  return text(key).split('\n').map((s) => s.trim()).filter(Boolean);
}

/** 批量取多个 key（缺失的不出现在结果里，wxml 侧用 || 兜底） */
function pick(keys) {
  const out = {};
  (keys || []).forEach((k) => { const v = text(k); if (v) out[k] = v; });
  return out;
}

module.exports = { ready, text, lines, pick };
