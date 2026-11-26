// 我的券（商家端）：发券 + 领取/核销统计（V3.6）
const api = require('../../utils/api');

const TYPES = [
  { key: 'cash', label: '满减券' },
  { key: 'discount', label: '折扣券' },
  { key: 'package', label: '次卡/服务' },
];

Page({
  data: {
    list: [],
    loading: true,
    types: TYPES,
    typeIndex: 0,
    title: '',
    amountYuan: '',
    discount: '',
    minYuan: '',
    totalQty: '',
    totalTimes: '',
    perUserLimit: 1,
    validDays: 30,
    creating: false,
  },
  onShow() {
    const merchantId = getApp().globalData.merchantId;
    if (!merchantId) { wx.reLaunch({ url: '/pages/login/login' }); return; }
    this.load();
  },
  load() {
    const merchantId = getApp().globalData.merchantId;
    api.get('/api/merchant/coupons', { merchantId }).then((list) => {
      this.setData({
        list: (list || []).map((c) => ({
          ...c,
          typeText: c.type === 'discount'
            ? (Number(c.discountRate) * 10).toFixed(1) + ' 折'
            : (c.type === 'package'
              ? ((Number(c.totalTimes) || 1) > 1 ? (c.totalTimes + ' 次卡/服务') : '次卡/服务（单次）')
              : '满 ' + api.fen2yuan(c.minSpendFen) + ' 减 ' + api.fen2yuan(c.amountOffFen)),
          statusText: c.status === 'valid' ? '发放中' : '已停发',
          statusClass: c.status === 'valid' ? 'green' : 'gray',
        })),
        loading: false,
      });
    }).catch(() => this.setData({ loading: false }));
  },
  onType(e) { this.setData({ typeIndex: Number(e.detail.value) }); },
  onInput(e) { this.setData({ [e.currentTarget.dataset.k]: e.detail.value }); },
  create() {
    const d = this.data;
    if (!d.title) { wx.showToast({ title: '请填写券名称', icon: 'none' }); return; }
    const body = {
      title: d.title,
      type: TYPES[d.typeIndex].key,
      amountOffFen: Math.round(Number(d.amountYuan || 0) * 100),
      discountRate: Number(d.discount || 0),
      minSpendFen: Math.round(Number(d.minYuan || 0) * 100),
      totalQty: d.totalQty === '' ? null : parseInt(d.totalQty, 10),
      // 次卡可核销次数：不填 = 单次（与旧口径一致）
      totalTimes: d.totalTimes === '' ? undefined : parseInt(d.totalTimes, 10),
      perUserLimit: parseInt(d.perUserLimit, 10) || 1,
      validDays: parseInt(d.validDays, 10) || 30,
    };
    this.setData({ creating: true });
    api.post('/api/merchant/coupons/create', body)
      .then(() => {
        wx.showToast({ title: '已创建', icon: 'success' });
        this.setData({ title: '', amountYuan: '', discount: '', minYuan: '', totalQty: '', totalTimes: '' });
        this.load();
      })
      .catch((e) => wx.showToast({ title: e.message, icon: 'none' }))
      .then(() => this.setData({ creating: false }));
  },
});
