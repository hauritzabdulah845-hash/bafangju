// 复购中心（V3.3 §5.1）：按历史购买商品一键复购 + 跨类目进度总览
const api = require('../../utils/api');

Page({
  data: { products: [], categories: [], loading: true },
  onShow() { this.load(); },
  load() {
    api.get('/api/user/rebuy').then((d) => {
      this.setData({
        products: (d.products || []).map((p) => ({
          ...p,
          img: p.imageUrl ? api.BASE_URL + p.imageUrl : '',
          nextPayYuan: ((p.nextPayFen || 0) / 100).toFixed(2),
        })),
        categories: d.categories || [],
        loading: false,
      });
    }).catch(() => this.setData({ loading: false }));
  },
  goProduct(e) {
    wx.navigateTo({ url: '/pages/product/product?id=' + e.currentTarget.dataset.id });
  },
  goProgress() { wx.switchTab({ url: '/pages/returns/returns' }); },
});
