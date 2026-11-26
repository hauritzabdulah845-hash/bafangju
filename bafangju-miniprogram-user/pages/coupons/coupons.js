// 我的券（用户端）：可领取 / 我的券（一券一码，到店出示核销）（V3.6）
const api = require('../../utils/api');
const app = getApp();

Page({
  data: { tab: 'available', available: [], mine: [], loading: true },
  onShow() {
    if (!app.globalData.userId) { setTimeout(() => this.onShow(), 600); return; }
    this.load();
  },
  load() {
    const userId = app.globalData.userId;
    Promise.all([
      api.get('/api/coupons/available?userId=' + userId).catch(() => []),
      api.get('/api/user/coupons').catch(() => []),
    ]).then(([available, mine]) => {
      this.setData({
        available: (available || []).map((c) => ({
          ...c,
          valueText: this.valueText(c),
          minText: c.minSpendFen ? '满 ' + api.fen2yuan(c.minSpendFen) + ' 元可用' : '无门槛',
        })),
        mine: (mine || []).map((c) => ({
          ...c,
          valueText: this.valueText(c.coupon),
          // 次卡（V4.6）：展示剩余次数；用完与单次已用都算"已使用"
          statusText: c.status === 'unused' ? '未使用' : (c.status === 'using' ? '使用中' : (c.status === 'used' ? '已使用' : '已过期')),
          timesText: c.coupon && c.coupon.type === 'package' && (Number(c.totalTimes) || 1) > 1
            ? ('剩 ' + c.remainingTimes + '/' + c.totalTimes + ' 次') : '',
          expireText: c.expiresAt ? String(c.expiresAt).slice(0, 10) : '',
        })),
        loading: false,
      });
    });
  },
  valueText(c) {
    if (!c) return '';
    if (c.type === 'discount') {
      const zhe = Number(c.discountRate) * 10;
      return String(Number(zhe.toFixed(1))) + ' 折';
    }
    // 次卡（V4.6）：展示总次数，如 "10 次卡"；单次仍叫次卡
    if (c.type === 'package') {
      const times = Math.max(1, Number(c.totalTimes) || 1);
      return times > 1 ? times + ' 次卡' : '次卡';
    }
    return '¥' + api.fen2yuan(c.amountOffFen);
  },
  switchTab(e) { this.setData({ tab: e.currentTarget.dataset.key }); },
  /** 到店导航：有坐标直接打开地图，无坐标复制地址 */
  goStore(e) {
    const { lat, lng, name, address } = e.currentTarget.dataset;
    if (lat != null && lng != null && lat !== '' && lng !== '') {
      wx.openLocation({
        latitude: Number(lat), longitude: Number(lng),
        name: name || '商家门店', address: address || '', scale: 16,
      });
      return;
    }
    if (address) wx.setClipboardData({ data: address, success: () => wx.showToast({ title: '门店地址已复制', icon: 'none' }) });
    else wx.showToast({ title: '该门店未填写地址', icon: 'none' });
  },
  claim(e) {
    const id = e.currentTarget.dataset.id;
    api.post('/api/coupons/claim', { couponId: id })
      .then(() => {
        wx.showToast({ title: '领取成功', icon: 'success' });
        this.load();
        this.setData({ tab: 'mine' });
      })
      .catch((err) => wx.showToast({ title: err.message, icon: 'none' }));
  },
  copyCode(e) {
    const code = String(e.currentTarget.dataset.code || '');
    if (!code) return;
    wx.setClipboardData({ data: code, success: () => wx.showToast({ title: '消费码已复制', icon: 'none' }) });
  },
});
