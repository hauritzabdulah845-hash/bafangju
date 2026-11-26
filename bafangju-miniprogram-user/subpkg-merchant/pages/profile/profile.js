// 商家端 · 我的（tabBar 页）
// 数据：GET /api/merchant/earnings（真实余额）、/api/merchant/withdraw/status（提现开关）
const api = require('../../utils/api');
const app = getApp();

Page({
  data: {
    merchantName: '',
    merchantId: '',
    balanceYuan: '0.00',
    frozenYuan: '0.00',
    withdrawEnabled: false,
  },
  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().setData({ selected: 3 });
    const merchantId = app.globalData.merchantId;
    if (!merchantId) { wx.reLaunch({ url: '/subpkg-merchant/pages/login/login' }); return; }
    this.setData({
      merchantName: app.globalData.merchantName || '',
      merchantId,
    });
    api.get('/api/merchant/earnings', { merchantId })
      .then((e) => this.setData({
        balanceYuan: api.fen2yuan(e.balanceFen),
        frozenYuan: api.fen2yuan(e.frozenFen),
      }))
      .catch(() => {});
    api.get('/api/merchant/withdraw/status', { merchantId })
      .then((w) => this.setData({ withdrawEnabled: !!w.withdrawEnabled }))
      .catch(() => {});
  },
  go(e) { wx.navigateTo({ url: e.currentTarget.dataset.url }); },
  goAgreement(e) {
    const type = (e.currentTarget.dataset.type === 'terms') ? 'terms' : 'privacy';
    wx.navigateTo({ url: '/subpkg-merchant/pages/agreement/agreement?type=' + type });
  },
  goWithdraw() { wx.navigateTo({ url: '/subpkg-merchant/pages/withdraw/withdraw' }); },
  logout() {
    wx.removeStorageSync('merchantId');
    wx.removeStorageSync('merchantName');
    wx.removeStorageSync('merchant_token'); // 登录凭据必须一并清除，避免退出后 token 残留
    app.globalData.merchantId = null;
    app.globalData.merchantName = null;
    wx.reLaunch({ url: '/subpkg-merchant/pages/login/login' });
  },
});
