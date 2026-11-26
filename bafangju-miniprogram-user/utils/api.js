// 请求封装：BASE_URL 统一在项目根目录 config.js 配置
// V3.8：身份一律由服务端会话（Bearer token）决定；token 失效时自动静默重登一次再重试。
const { BASE_URL } = require('../config');

let reloginPromise = null;

/** 设备标识（本地持久化）：开发态用于"本地幂等"登录，避免同一设备每次登录都新建账号 */
function deviceId() {
  let id = '';
  try { id = wx.getStorageSync('deviceId') || ''; } catch (e) { /* ignore */ }
  if (!id) {
    id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    try { wx.setStorageSync('deviceId', id); } catch (e) { /* ignore */ }
  }
  return id;
}

/** wx.login 包装：返回 code（失败时 reject） */
function wxLogin() {
  return new Promise((resolve, reject) => {
    wx.login({
      success: (res) => resolve(String(res.code || '')),
      fail: (err) => {
        // 原始 errMsg 只进控制台，界面不暴露底层错误细节
        console.error('[api] wx.login 失败 → ' + String((err && err.errMsg) || '未知错误'));
        const e = new Error('微信登录失败，请稍后重试');
        e.code = 'NETWORK';
        reject(e);
      },
    });
  });
}

/** 静默重登：wx.login → /api/user/login（生产走 code2session，开发态按 deviceId 幂等），成功后写回本地会话 */
function relogin() {
  if (reloginPromise) return reloginPromise;
  reloginPromise = new Promise((resolve, reject) => {
    wx.login({
      success: (res) => {
        const code = String(res.code || '');
        wx.request({
          url: BASE_URL + '/api/user/login',
          method: 'POST',
          // 不传 nickname：静默重登不得覆盖用户已有昵称（服务端仅在占位符昵称时才允许更新）
          data: { code, deviceId: deviceId() },
          header: { 'content-type': 'application/json' },
          success: (r) => {
            if (r.statusCode === 200 && r.data && r.data.token) {
              wx.setStorageSync('userToken', r.data.token);
              wx.setStorageSync('userId', r.data.userId);
              try {
                const app = getApp();
                if (app && app.globalData) {
                  app.globalData.token = r.data.token;
                  app.globalData.userId = r.data.userId;
                }
              } catch (e) { /* ignore */ }
              resolve(r.data.token);
            } else reject(new Error('登录失败'));
          },
          fail: () => reject(new Error('登录失败')),
        });
      },
      fail: () => reject(new Error('登录失败')),
    });
  });
  // 无论成败都释放锁，避免卡死
  reloginPromise = reloginPromise.then(
    (t) => { reloginPromise = null; return t; },
    (e) => { reloginPromise = null; throw e; }
  );
  return reloginPromise;
}

function request(method, path, data, retried) {
  return new Promise((resolve, reject) => {
    const header = { 'content-type': 'application/json' };
    // 登录态：购买链路（下单/地址/售后）必须携带会话 token
    const token = wx.getStorageSync('userToken');
    if (token) header.Authorization = 'Bearer ' + token;
    wx.request({
      url: BASE_URL + path,
      method,
      data,
      header,
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) { resolve(res.data); return; }
        if (res.statusCode === 401) {
          if (!retried && path !== '/api/user/login') {
            // 会话失效：清本地登录态，静默重登后重试一次
            wx.removeStorageSync('userToken');
            wx.removeStorageSync('userId');
            relogin()
              .then(() => request(method, path, data, true).then(resolve, reject))
              .catch(() => reject(new Error('登录已失效，请重新登录')));
            return;
          }
          reject(new Error('登录已失效，请重新登录'));
          return;
        }
        reject(new Error((res.data && res.data.error) || ('HTTP ' + res.statusCode)));
      },
      fail: (err) => {
        const raw = String((err && err.errMsg) || '网络错误');
        // 诊断信息（原始 errMsg + 目标地址）只写控制台，绝不进入用户界面：
        // 正式版界面只显示统一文案，避免泄露内网地址与服务拓扑。
        let diag = raw;
        if (raw.indexOf('not in domain list') >= 0) {
          diag += '（域名未配置：开发者工具 → 详情 → 本地设置 → 勾选「不校验合法域名」）';
        } else if (raw.indexOf('timeout') >= 0 || raw.indexOf('time out') >= 0) {
          diag += '（连接超时：确认手机与电脑同一 Wi-Fi、防火墙未拦截后端端口）';
        } else if (raw.indexOf('connection refused') >= 0 || raw.indexOf('ECONNREFUSED') >= 0) {
          diag += '（连接被拒：确认本地后端已启动）';
        }
        console.error('[api] 请求失败 ' + path + ' → ' + diag + ' | 目标：' + BASE_URL + path);
        const e = new Error('网络连接失败，请稍后重试');
        e.code = 'NETWORK'; // 供页面区分「网络不可达」与「业务错误」，决定展示文案
        reject(e);
      },
    });
  });
}

/**
 * 支付（V3.10）：
 * - 真实模式：/api/payment/prepay 返回 payParams → wx.requestPayment 唤起微信支付；
 * - 模拟模式（未接入商户号 / PAY_MODE=mock）：服务端直接入账，仅开发联调用。
 * 支付回调是异步的，调用方随后用 waitPaid 轮询订单状态。
 */
function payOrder(orderId) {
  return request('POST', '/api/payment/prepay', { orderId }).then((r) => {
    if (r && r.provider === 'mock') {
      // 模拟模式：服务端直接入账（仅开发/演示环境）
      return request('POST', '/api/payment/notify', { orderId });
    }
    if (!r || !r.payParams) {
      return Promise.reject(new Error('支付参数缺失，请升级小程序后重试'));
    }
    const p = r.payParams;
    return new Promise((resolve, reject) => {
      wx.requestPayment({
        timeStamp: p.timeStamp,
        nonceStr: p.nonceStr,
        package: p.package,
        signType: p.signType,
        paySign: p.paySign,
        success: () => resolve({ ok: true, provider: 'wxpay' }),
        fail: (err) => {
          const msg = String((err && err.errMsg) || '');
          reject(new Error(msg.indexOf('cancel') >= 0 ? '已取消支付' : '支付失败，请重试'));
        },
      });
    });
  });
}

/** 轮询订单状态（最多 tries 次、每次 1 秒），用于等待微信支付回调入账 */
function waitPaid(orderId, tries = 6) {
  return request('GET', '/api/orders/' + orderId).then((o) => {
    if (!o || o.status !== 'pending_pay' || tries <= 0) return o;
    return new Promise((resolve) => setTimeout(resolve, 1000)).then(() => waitPaid(orderId, tries - 1));
  });
}

module.exports = {
  get: (path, data) => request('GET', path, data),
  post: (path, data) => request('POST', path, data),
  payOrder,
  waitPaid,
  deviceId,
  wxLogin,
  fen2yuan: (fen) => ((fen || 0) / 100).toFixed(2),
  BASE_URL,
};
