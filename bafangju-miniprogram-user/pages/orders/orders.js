// 我的订单 · 支付 + 履约（确认收货 / 到店核销码 / 售后申请，V3.5）
// 数据：GET /api/orders/list（服务端已带 name/imageUrl）；Tab 过滤在客户端
const api = require('../../utils/api');
const app = getApp();

const STATUS_TEXT = {
  pending_pay: '待付款',
  paid: '已支付 · 待发货',
  shipped: '已发货 · 待收货',
  done: '已完成',
  refunded: '已退款',
  cancelled: '已取消',
};

const AFTER_SALE_TEXT = { applying: '售后处理中', approved: '售后已受理', rejected: '售后未通过' };

// 把 ISO 时间格式化为 MM-DD HH:mm
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso).slice(0, 16);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

Page({
  data: {
    tabs: [
      { key: 'all', label: '全部' },
      { key: 'pending', label: '待付款' },
      { key: 'receiving', label: '待收货' },
      { key: 'done', label: '已完成' },
      { key: 'aftersale', label: '售后' },
    ],
    activeTab: 'all',
    orders: [],        // 全量（派生字段后）
    visibleOrders: [], // 当前 Tab
    loading: true,
  },
  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().setData({ selected: 1 });
    // 跨 tab 传参：从「我的」订单宫格带入预选状态
    if (app.globalData.ordersTab) {
      this.setData({ activeTab: app.globalData.ordersTab });
      app.globalData.ordersTab = '';
    }
    this.load();
  },
  switchTab(e) {
    this.setData({ activeTab: e.currentTarget.dataset.key });
    this.applyFilter();
  },
  goRules() { wx.navigateTo({ url: '/pages/rules/rules' }); },
  applyFilter() {
    const tab = this.data.activeTab;
    const match = {
      all: () => true,
      pending: (o) => o.status === 'pending_pay',
      receiving: (o) => o.status === 'paid' || o.status === 'shipped',
      done: (o) => o.status === 'done',
      aftersale: (o) => !!o.afterSaleStatus || o.status === 'refunded',
    }[tab];
    this.setData({ visibleOrders: this.data.orders.filter(match) });
  },
  load() {
    const userId = app.globalData.userId;
    this.setData({ loading: true });
    api.get('/api/orders/list?userId=' + userId)
      .then((list) => {
        const orders = (list || []).map((o) => ({
          ...o,
          img: o.imageUrl ? api.BASE_URL + o.imageUrl : '',
          priceYuan: api.fen2yuan(o.priceFen),
          paidYuan: api.fen2yuan(o.paidFen),
          timeText: fmtTime(o.createdAt),
          paying: false,
          statusText: o.deliveryType === 'store' && o.status === 'paid' ? '待到店使用' : (STATUS_TEXT[o.status] || o.status),
          canConfirm: o.status === 'shipped',
          showCode: o.deliveryType === 'store' && o.status === 'paid' && !!o.verifyCode,
          verifyCode: o.verifyCode || '',
          expressText: o.expressNo ? (o.expressCompany || '快递') + ' ' + o.expressNo : '',
          afterSaleText: AFTER_SALE_TEXT[o.afterSaleStatus] || '',
          canAfterSale: o.payType !== 'FREE' && ['paid', 'shipped', 'done'].includes(o.status) && !o.afterSaleStatus
            && (o.status !== 'done' || o.afterSaleOpen !== false),
        }));
        this.setData({ orders, loading: false });
        this.applyFilter();
      })
      .catch(() => this.setData({ loading: false }));
  },
  // 待付款订单付款：真实模式唤起微信支付，模拟模式服务端直接入账
  payOrder(e) {
    const id = e.currentTarget.dataset.id;
    const item = this.data.orders.find((o) => o.id === id);
    if (!item || item.paying) return;
    this.setData({ orders: this.data.orders.map((o) => (o.id === id ? { ...o, paying: true } : o)) });
    this.applyFilter();
    api.payOrder(id)
      .then(() => api.waitPaid(id))
      .then((o) => {
        const paid = !!(o && o.status && o.status !== 'pending_pay');
        if (paid) {
          // 支付结果页：本单实付/步位 + 下一单实付 + 周期进度（V3.3 §5.1）
          wx.navigateTo({ url: '/pages/pay-result/pay-result?orderId=' + id });
          this.load();
          return;
        }
        wx.showToast({ title: '支付确认中，请稍后刷新', icon: 'none' });
        this.load();
      })
      .catch((err) => {
        wx.showToast({ title: err.message, icon: 'none' });
        this.setData({ orders: this.data.orders.map((o) => (o.id === id ? { ...o, paying: false } : o)) });
        this.applyFilter();
      });
  },
  // 确认收货（售后期从此起算）
  confirmOrder(e) {
    const id = e.currentTarget.dataset.id;
    api.post('/api/orders/confirm', { orderId: id })
      .then(() => {
        wx.showToast({ title: '已确认收货', icon: 'success' });
        this.load();
      })
      .catch((err) => wx.showToast({ title: err.message, icon: 'none' }));
  },
  // 申请售后（wx.showModal 可编辑输入原因）
  applyAfterSale(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '申请售后',
      editable: true,
      placeholderText: '请填写售后原因（不少于 4 个字）',
      success: (res) => {
        if (!res.confirm) return;
        const reason = (res.content || '').trim() || '商品问题，申请售后';
        api.post('/api/orders/after-sale', { orderId: id, reason })
          .then(() => {
            wx.showToast({ title: '已提交，等待处理', icon: 'success' });
            this.load();
          })
          .catch((err) => wx.showToast({ title: err.message, icon: 'none' }));
      },
    });
  },
  copyVerifyCode(e) {
    const code = String(e.currentTarget.dataset.code || '');
    if (!code) return;
    wx.setClipboardData({ data: code, success: () => wx.showToast({ title: '消费码已复制', icon: 'none' }) });
  },
  goProduct(e) {
    wx.navigateTo({ url: '/pages/product/product?id=' + e.currentTarget.dataset.id });
  },
  goHome() { wx.switchTab({ url: '/pages/index/index' }); },
});
