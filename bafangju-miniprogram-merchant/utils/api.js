// 请求封装：BASE_URL 指向平台后端（上线前替换为生产域名并配置合法域名白名单）
const { BASE_URL } = require('../config');

function getToken() {
  try { return wx.getStorageSync('merchant_token') || ''; } catch (e) { return ''; }
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
          // 登录失效：清 token 并回登录页
          try { wx.removeStorageSync('merchant_token'); } catch (e) { /* ignore */ }
          wx.reLaunch({ url: '/pages/login/login' });
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
  fen2yuan: (fen) => ((fen || 0) / 100).toFixed(2),
  BASE_URL,
};
