// 商家端 · 隐私政策与合作协议
// 合规要点：如实披露商家提交的证照、联系人与收款信息；明确平台审核与违规处置权；不使用"全额返/保本"话术。
Page({
  data: {
    tab: 'privacy', // privacy | terms
    updatedAt: '2026-10-28',
  },
  onLoad(query) {
    const tab = query && query.type === 'terms' ? 'terms' : 'privacy';
    this.setData({ tab });
    wx.setNavigationBarTitle({ title: tab === 'terms' ? '商家合作协议' : '隐私政策' });
  },
  switchTab(e) {
    const tab = e.currentTarget.dataset.tab === 'terms' ? 'terms' : 'privacy';
    this.setData({ tab });
    wx.setNavigationBarTitle({ title: tab === 'terms' ? '商家合作协议' : '隐私政策' });
  },
});
