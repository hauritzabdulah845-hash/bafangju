const api = require('../../utils/api');
const { formatTime } = require('../../utils/time');

const STATUS_TEXT = {
  pending_review: '待平台审核',
  approved: '发放中',
  issuing: '发放中（分几笔到账）',
  done: '发放完成',
  rejected: '已驳回',
};
const TX_TEXT = {
  transferred_pending_confirm: '已转账 · 待确认收款',
  confirmed: '已到账',
  expired_refunded: '超时未确认 · 已退回重发',
};

Page({
  data: {
    amount: '', withdrawEnabled: false, downNote: '',
    limits: null, requests: [], transfers: [],
    balanceYuan: '0.00',
    receiver: null, // 收款人绑定状态 {bound, name, openidMasked}
  },
  onShow() { this.refresh(); },
  async refresh() {
    const merchantId = getApp().globalData.merchantId;
    if (!merchantId) { wx.reLaunch({ url: '/pages/login/login' }); return; }
    try {
      const [s, rec] = await Promise.all([
        api.get('/api/merchant/withdraw/status', { merchantId }),
        api.get('/api/merchant/withdraw/receiver', {}).catch(() => null),
      ]);
      this.setData({
        withdrawEnabled: s.withdrawEnabled,
        downNote: s.withdrawEnabled ? '' : '提现功能尚未开通（入驻满 90 天后开放，具体可咨询平台运营）',
        limits: s.limits ? {
          perTxnYuan: api.fen2yuan(s.limits.perTxnFen),
          dailyYuan: api.fen2yuan(s.limits.dailyFen),
          minYuan: api.fen2yuan(s.limits.minFen),
        } : null,
        requests: s.requests.map((r) => ({ ...r, text: STATUS_TEXT[r.status], yuan: api.fen2yuan(r.fen), remainYuan: api.fen2yuan(r.remainingFen), timeText: formatTime(r.appliedAt) })),
        transfers: s.transfers.map((t) => ({ ...t, text: TX_TEXT[t.status] || t.status, yuan: api.fen2yuan(t.fen), timeText: formatTime(t.issuedAt), openidMasked: t.receiverOpenid ? t.receiverOpenid.slice(0, 6) + '…' : '' })),
        balanceYuan: api.fen2yuan(s.balanceFen),
        receiver: rec ? {
          bound: !!rec.bound,
          name: rec.name || '微信收款',
          openidMasked: rec.openid ? rec.openid.slice(0, 6) + '…' + rec.openid.slice(-4) : '',
        } : null,
      });
    } catch (e) { wx.showToast({ title: e.message, icon: 'none' }); }
  },
  /** 绑定收款微信：生产用 wx.login code（openid 不经前端）；开发态后端自动降级 */
  async bindReceiver() {
    try {
      const code = await new Promise((resolve, reject) => {
        wx.login({ success: (r) => resolve(r.code), fail: reject });
      });
      const r = await api.post('/api/merchant/withdraw/bind-receiver', { code });
      wx.showToast({ title: r.changed ? '绑定成功' : '已是当前绑定', icon: 'success' });
      this.refresh();
    } catch (e) { wx.showModal({ title: '绑定失败', content: e.message, showCancel: false }); }
  },
  onAmount(e) { this.setData({ amount: e.detail.value }); },
  async apply() {
    const merchantId = getApp().globalData.merchantId;
    const fen = Math.round(parseFloat(this.data.amount || '0') * 100);
    if (!fen) { wx.showToast({ title: '请输入金额', icon: 'none' }); return; }
    try {
      await api.post('/api/merchant/withdraw/apply', { userId: merchantId, fen, idempotencyKey: 'w' + Date.now() });
      wx.showToast({ title: '申请已提交', icon: 'success' });
      this.setData({ amount: '' });
      this.refresh();
    } catch (e) { wx.showModal({ title: '申请失败', content: e.message, showCancel: false }); }
  },
  async confirm(e) {
    const { id } = e.currentTarget.dataset;
    try {
      await api.post('/api/merchant/withdraw/confirm', { transferId: id });
      wx.showToast({ title: '已确认收款', icon: 'success' });
      this.refresh();
    } catch (err) { wx.showToast({ title: err.message, icon: 'none' }); }
  },
});
