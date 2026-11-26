// 订单履约（商家端）：快递发货 / 到店核销（V3.5）
// 数据：GET /api/merchant/orders（仅返回本店商品的订单）
const api = require('../../utils/api');

const STATUS_TEXT = { paid: '待处理', shipped: '已发货', done: '已完成', refunded: '已退款', cancelled: '已取消' };
const TABS = [
  { key: 'pending', label: '待处理' },
  { key: 'done', label: '已完成' },
  { key: 'all', label: '全部' },
];
const COMPANIES = ['顺丰速运', '京东物流', '中通快递', '圆通速递', '韵达快递', '申通快递', '极兔速递', '邮政EMS', '其他'];

function fmt(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso).slice(0, 16);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

Page({
  data: {
    tabs: TABS,
    tab: 'pending',
    list: [],
    visible: [],
    loading: true,
    companies: COMPANIES,
    shipId: '',
    shipCompany: COMPANIES[0],
    shipNo: '',
    verifyId: '',
    verifyCode: '',
  },
  onShow() {
    const merchantId = getApp().globalData.merchantId;
    if (!merchantId) { wx.reLaunch({ url: '/pages/login/login' }); return; }
    this.load();
  },
  load() {
    const merchantId = getApp().globalData.merchantId;
    this.setData({ loading: true });
    api.get('/api/merchant/orders', { merchantId }).then((list) => {
      const orders = (list || []).map((o) => ({
        ...o,
        timeText: fmt(o.createdAt),
        // 待处理订单按履约方式给出更具体的状态：快递待发货 / 到店待核销
        statusText: o.status === 'paid'
          ? (o.deliveryType === 'store' ? '待到店核销' : '待发货')
          : (STATUS_TEXT[o.status] || o.status),
        typeText: o.deliveryType === 'store' ? '到店核销' : '快递发货',
      }));
      this.setData({ list: orders, loading: false });
      this.applyTab();
    }).catch(() => this.setData({ loading: false }));
  },
  switchTab(e) {
    this.setData({ tab: e.currentTarget.dataset.key, shipId: '', verifyId: '' });
    this.applyTab();
  },
  applyTab() {
    const tab = this.data.tab;
    const match = {
      pending: (o) => o.status === 'paid',
      done: (o) => o.status === 'done',
      all: () => true,
    }[tab];
    this.setData({ visible: this.data.list.filter(match) });
  },
  startShip(e) {
    this.setData({ shipId: e.currentTarget.dataset.id, shipNo: '', verifyId: '' });
  },
  startVerify(e) {
    this.setData({ verifyId: e.currentTarget.dataset.id, verifyCode: '', shipId: '' });
  },
  cancelForm() {
    this.setData({ shipId: '', verifyId: '' });
  },
  onCompany(e) {
    this.setData({ shipCompany: COMPANIES[Number(e.detail.value)] || COMPANIES[0] });
  },
  onNo(e) { this.setData({ shipNo: e.detail.value }); },
  onCode(e) { this.setData({ verifyCode: e.detail.value }); },
  doShip() {
    const { shipId, shipCompany, shipNo } = this.data;
    if (!shipNo) { wx.showToast({ title: '请填写快递单号', icon: 'none' }); return; }
    api.post('/api/merchant/orders/ship', {
      merchantId: getApp().globalData.merchantId,
      orderId: shipId,
      company: shipCompany,
      trackingNo: shipNo,
    }).then(() => {
      wx.showToast({ title: '已发货', icon: 'success' });
      this.setData({ shipId: '' });
      this.load();
    }).catch((e) => wx.showToast({ title: e.message, icon: 'none' }));
  },
  doVerify() {
    const { verifyId, verifyCode } = this.data;
    if (!verifyCode) { wx.showToast({ title: '请输入核销码', icon: 'none' }); return; }
    api.post('/api/merchant/orders/verify', {
      merchantId: getApp().globalData.merchantId,
      orderId: verifyId,
      verifyCode,
    }).then(() => {
      wx.showToast({ title: '核销成功', icon: 'success' });
      this.setData({ verifyId: '' });
      this.load();
    }).catch((e) => wx.showToast({ title: e.message, icon: 'none' }));
  },
});
