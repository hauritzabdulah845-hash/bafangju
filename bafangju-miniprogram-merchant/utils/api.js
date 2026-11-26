// 请求封装：BASE_URL 指向平台后端（上线前替换为生产域名并配置合法域名白名单）
const { BASE_URL } = require('../config');

function getToken() {
  try { return wx.getStorageSync('merchant_token') || ''; } catch (e) { return ''; }
}

/**
 * 彻底清除商家登录态（token + merchantId/merchantName + globalData）。
 * 401 时必须整组清除：若只清 token，login 页 onShow 仍会因 globalData.merchantId
 * 自动跳回工作台 → 工作台守卫也只查 merchantId → 放行 → 请求又 401 → 无限互跳。
 * 触发场景：后台重置 token / 商家在另一设备改密码（token 轮换）。
 */
function clearMerchantSession() {
  try {
    wx.removeStorageSync('merchant_token');
    wx.removeStorageSync('merchantId');
    wx.removeStorageSync('merchantName');
  } catch (e) { /* ignore */ }
  try {
    const g = getApp().globalData;
    if (g) { g.merchantId = null; g.merchantName = null; }
  } catch (e) { /* ignore */ }
}

function request(method, path, data) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: BASE_URL + path,
      method,
      data,
      header: { Authorization: 'Bearer ' + getToken() }, // 商家端鉴权（登录后签发）
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(res.data);
        else if (res.statusCode === 401) {
          // 登录失效：整组清除商家会话并回登录页（分包路径；redirectTo 保留顾客端页面栈，不 reLaunch）
          clearMerchantSession();
          wx.redirectTo({ url: '/pages/login/login' });
          reject(new Error('登录已失效，请重新登录'));
        } else reject(new Error((res.data && res.data.error) || ('HTTP ' + res.statusCode)));
      },
      fail: (err) => {
        // 原始 errMsg 与目标地址只写控制台，界面只显示统一文案（不泄露内网地址）
        console.error('[api] 请求失败 ' + path + ' → ' + String((err && err.errMsg) || '网络错误') + ' | 目标：' + BASE_URL + path);
        const e = new Error('网络连接失败，请稍后重试');
        e.code = 'NETWORK'; // 供页面区分「网络不可达」与「业务错误」，决定展示文案
        reject(e);
      },
    });
  });
}

module.exports = {
  get: (path, data) => request('GET', path, data),
  post: (path, data) => request('POST', path, data),
  saveToken: (token) => { try { wx.setStorageSync('merchant_token', token); } catch (e) { /* ignore */ } },
  clearMerchantSession,
  fen2yuan: (fen) => ((fen || 0) / 100).toFixed(2),
  BASE_URL,
};
