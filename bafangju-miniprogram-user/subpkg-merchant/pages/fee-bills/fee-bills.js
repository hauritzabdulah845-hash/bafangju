// 核销对账 / 服务费账单（商家端）
// - 默认（V4.5）：平台不向商家收取任何费用，本页只展示当月券核销明细，供商家自己核对到店消费；
// - 若平台在后台开启了联盟费率，本页自动切回「服务费账单」形态（应缴/已缴/欠费）。
const api = require('../../utils/api');
const { formatTime } = require('../../utils/time');

function curMonth() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

Page({
  data: { month: curMonth(), summary: {}, list: [], loading: true, feeEnabled: false },
  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().setData({ selected: 2 });
    const merchantId = getApp().globalData.merchantId;
    if (!merchantId) { wx.reLaunch({ url: '/subpkg-merchant/pages/login/login' }); return; }
    this.load();
  },
  onMonth(e) {
    this.setData({ month: e.detail.value }, () => this.load());
  },
  load() {
    const month = this.data.month;
    this.setData({ loading: true });
    api.get('/api/merchant/fee-bills', { month })
      .then((r) => {
        if (r.feeEnabled) return this.renderFeeBills(r);
        // 免费模式下没有应收单，改为取真实核销单（否则本页永远是空的）
        return api.get('/api/merchant/alliance-orders', { month }).then((a) => this.renderRedeems(a));
      })
      .catch((e) => {
        this.setData({ loading: false });
        wx.showToast({ title: e.message || '加载失败', icon: 'none' });
      });
  },

  // 收费模式：应缴 / 已缴 / 欠费
  renderFeeBills(r) {
    const raw = r.list || [];
    const list = raw.map((b) => ({
      ...b,
      amountYuan: api.fen2yuan(b.amountFen || 0),
      shortageYuan: api.fen2yuan(b.shortageFen || 0),
      timeText: formatTime(b.createdAt),
      statusText: b.status === 'paid' ? '已缴' : '待缴',
      feeText: '¥' + (b.grossFeeYuan || api.fen2yuan(b.grossFeeFen || 0)),
    }));
    const sumFen = raw.reduce((s, b) => s + (Number(b.amountFen) || 0), 0);
    this.setData({
      feeEnabled: true,
      summary: {
        dueYuan: api.fen2yuan((r.summary || {}).dueFen || 0),
        paidYuan: api.fen2yuan((r.summary || {}).paidFen || 0),
        dueCount: (r.summary || {}).dueCount || 0,
        paidCount: (r.summary || {}).paidCount || 0,
        totalCount: raw.length,
      },
      monthAmountText: '¥' + api.fen2yuan(sumFen),
      list,
      loading: false,
    });
  },

  // 免费模式：核销明细（消费额 / 券优惠 / 顾客实付）
  renderRedeems(a) {
    const raw = (a && a.list) || [];
    const list = raw.map((x) => ({
      id: x.id,
      couponTitle: x.couponTitle || '联盟券',
      timeText: formatTime(x.createdAt),
      amountYuan: api.fen2yuan(x.amountFen || 0),
      discountYuan: api.fen2yuan(x.discountFen || 0),
      payableYuan: api.fen2yuan(x.payableFen || 0),
      feeText: '消费 ¥' + api.fen2yuan(x.amountFen || 0),
    }));
    const sumFen = raw.reduce((s, x) => s + (Number(x.amountFen) || 0), 0);
    this.setData({
      feeEnabled: false,
      summary: {
        dueYuan: '0.00', paidYuan: '0.00', dueCount: 0, paidCount: 0,
        totalCount: raw.length,
      },
      monthAmountText: '¥' + api.fen2yuan(sumFen),
      list,
      loading: false,
    });
  },
});
