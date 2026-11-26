// 用户提现（收益账户）。合规：仅分佣收益可提现；排队/季度分红默认进消费余额不可提现；
// 开关 withdrawEnabled 控制（待确认事项 19）；收款微信已在登录时服务端自动绑定。
const api = require('../../utils/api');
const { formatTime } = require('../../utils/time');
const content = require('../../utils/content');
const app = getApp();

Page({
  data: {
    balanceYuan: '0.00', amount: '', withdrawEnabled: false, downNote: '',
    limits: null, requests: [], transfers: [], receiver: null,
    ct: {},
  },
  onShow() {
    if (!app.globalData.userId) { setTimeout(() => this.onShow(), 600); return; }
    this.refresh();
    content.ready().then(() => this.applyContent());
  },
  // 后台配置了就用后台文案，未配置保留内置文案（downNote）
  applyContent() {
    this.setData({ ct: content.pick(['withdraw.closed']) });
  },
  refresh() {
    const userId = app.globalData.userId;
    api.get('/api/user/withdraw/status?userId=' + userId).then((s) => this.setData({
      withdrawEnabled: s.withdrawEnabled,
      downNote: s.withdrawEnabled ? '' : '提现通道尚未开通（开通后此处可提现分佣收益；分红默认进消费余额不可提现）',
      limits: s.limits ? { perTxn: api.fen2yuan(s.limits.perTxnFen), daily: api.fen2yuan(s.limits.dailyFen), min: api.fen2yuan(s.limits.minFen) } : null,
      requests: s.requests.map((r) => ({ ...r, yuan: api.fen2yuan(r.fen), remain: api.fen2yuan(r.remainingFen), timeText: formatTime(r.appliedAt) })),
      transfers: s.transfers.map((t) => ({ ...t, yuan: api.fen2yuan(t.fen), timeText: formatTime(t.issuedAt) })),
      balanceYuan: api.fen2yuan(s.balanceFen),
    })).catch((e) => wx.showToast({ title: e.message, icon: 'none' }));
  },
  inputAmount(e) { this.setData({ amount: e.detail.value }); },
  apply() {
    const yuan = parseFloat(this.data.amount);
    if (!yuan || yuan <= 0) { wx.showToast({ title: '请输入金额', icon: 'none' }); return; }
    api.post('/api/user/withdraw/apply', {
      userId: app.globalData.userId,
      fen: Math.round(yuan * 100),
      idempotencyKey: 'u' + app.globalData.userId + '-' + Date.now(),
    }).then(() => {
      wx.showToast({ title: '申请已提交', icon: 'success' });
      this.setData({ amount: '' });
      this.refresh();
    }).catch((e) => wx.showToast({ title: e.message, icon: 'none' }));
  },
  confirm(e) {
    api.post('/api/user/withdraw/confirm', { userId: app.globalData.userId, transferId: e.currentTarget.dataset.id })
      .then(() => { wx.showToast({ title: '已确认收款', icon: 'success' }); this.refresh(); })
      .catch((err) => wx.showToast({ title: err.message, icon: 'none' }));
  },
});
