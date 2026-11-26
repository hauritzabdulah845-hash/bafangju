// 商家工作台 · 拼多多配色重设计（对应 Ardot 屏幕-商家端工作台 5:307）
// 数据：GET /api/merchant/overview（券/核销/广告预订/收益/近7日趋势，全部真实聚合）
const api = require('../../utils/api');
const app = getApp();

const EMPTY_OV = {
  couponCount: 0, couponValid: 0, redeemedCount: 0, adBookingCount: 0,
  balanceFen: 0, frozenFen: 0,
  trend: [0, 1, 2, 3, 4, 5, 6].map((i) => ({ date: '', count: 0 })),
};

Page({
  data: {
    merchantName: '',
    ov: EMPTY_OV,
    trendMax: 1,
    balanceYuan: '0.00',
    frozenYuan: '0.00',
  },
  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().setData({ selected: 0 });
    const merchantId = app.globalData.merchantId;
    if (!merchantId) { wx.reLaunch({ url: '/subpkg-merchant/pages/login/login' }); return; }
    this.setData({ merchantName: app.globalData.merchantName || '' });
    this.refresh(merchantId);
  },
  refresh(merchantId) {
    api.get('/api/merchant/overview', { merchantId })
      .then((ov) => {
        const trend = ov.trend && ov.trend.length ? ov.trend : EMPTY_OV.trend;
        const trendMax = Math.max(1, ...trend.map((t) => t.count || 0));
        this.setData({
          ov: { ...ov, trend },
          trendMax,
          balanceYuan: api.fen2yuan(ov.balanceFen),
          frozenYuan: api.fen2yuan(ov.frozenFen),
        });
      })
      .catch(() => {});
  },
  go(e) { wx.navigateTo({ url: e.currentTarget.dataset.url }); },
  // 分包页非 tabBar 页：底栏级切换用 redirectTo，保持页面栈深度
  switchTab(e) { wx.redirectTo({ url: e.currentTarget.dataset.url }); },
});
