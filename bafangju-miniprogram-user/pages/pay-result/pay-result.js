// 支付结果页：展示本单实付与步位、下一单实付、周期进度（尾段 4 单让利，周期完成自动收口）
const api = require('../../utils/api');

const STATUS_TEXT = {
  pending_pay: '待支付',
  paid: '支付成功',
  shipped: '已发货',
  done: '已完成',
  refunded: '已退款',
  cancelled: '已取消',
};

Page({
  data: {
    order: null,
    product: null,
    statusText: '',
    paidYuan: '0.00',
    nextPayYuan: '0.00',
    nextStep: 1,
    progressText: '',
    cycleCompleted: false,
    loading: true,
    err: '',
  },
  onLoad(q) {
    this.orderId = q.orderId;
    this.load();
  },
  onShow() {
    if (this.orderId && !this.data.loading) this.load();
  },
  load() {
    if (!this.orderId) { this.setData({ loading: false, err: '缺少订单号' }); return; }
    api.get('/api/orders/' + this.orderId).then((order) => {
      const p = {
        order,
        statusText: STATUS_TEXT[order.status] || order.status,
        paidYuan: ((order.paidFen || 0) / 100).toFixed(2),
      };
      this.setData(p);
      // 下一单实付按"当前步位 + 该商品标价"实时计算（服务端保证口径一致）
      return api.get('/api/products/' + order.productId).then((product) => {
        const total = product.total || ((product.n || 1) + 4);
        this.setData({
          product,
          nextPayYuan: ((product.nextPayFen || 0) / 100).toFixed(2),
          nextStep: product.myStep || 1,
          progressText: Math.min(order.step || 1, total) + ' / ' + total,
          // 本单为周期最后一单（第 total 单）→ 已收口，获 1 个分红队位
          cycleCompleted: (order.step || 0) >= total && order.status !== 'pending_pay' && order.status !== 'refunded',
          loading: false,
        });
      });
    }).catch((e) => this.setData({ loading: false, err: e.message }));
  },
  payNow() {
    if (this.data.paying) return;
    this.setData({ paying: true });
    api.payOrder(this.orderId)
      .then(() => api.waitPaid(this.orderId))
      .then(() => this.load())
      .catch((e) => wx.showToast({ title: e.message, icon: 'none' }))
      .finally(() => this.setData({ paying: false }));
  },
  buyAgain() {
    wx.navigateTo({ url: '/pages/product/product?id=' + this.data.order.productId });
  },
  goOrders() { wx.switchTab({ url: '/pages/orders/orders' }); },
  goHome() { wx.switchTab({ url: '/pages/index/index' }); },
});
