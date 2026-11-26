// 我的奖励（V4.0）：余额 / 实名认证 / 提现申请 / 明细流水
// 合规文案口径：只说「奖励 / 提现申请」，不出现「赚钱 / 收益 / 日结」
const api = require('../../utils/api');

Page({
  data: {
    cash: null,
    withdrawals: [],
    // 实名表单
    showRealname: false,
    rnName: '',
    rnId: '',
    rnSubmitting: false,
    withdrawing: false,
  },

  onShow() {
    this.load();
  },

  load() {
    Promise.all([
      api.get('/api/user/cash'),
      api.get('/api/user/reward-withdrawals'),
    ])
      .then(([cash, wd]) => {
        this.setData({
          cash,
          withdrawals: wd.withdrawals || [],
          showRealname: !cash.realnamed,
        });
      })
      .catch((e) => wx.showToast({ title: e.message || '加载失败', icon: 'none' }));
  },

  onNameInput(e) { this.setData({ rnName: e.detail.value }); },
  onIdInput(e) { this.setData({ rnId: e.detail.value }); },

  submitRealname() {
    if (this.data.rnSubmitting) return;
    const name = this.data.rnName.trim();
    const idCard = this.data.rnId.trim().toUpperCase();
    if (name.length < 2) return wx.showToast({ title: '请输入真实姓名', icon: 'none' });
    if (!/^\d{17}[\dX]$/.test(idCard)) return wx.showToast({ title: '身份证号格式不正确', icon: 'none' });
    this.setData({ rnSubmitting: true });
    api.post('/api/user/realname', { name, idCard })
      .then(() => {
        wx.showToast({ title: '实名成功', icon: 'success' });
        this.setData({ rnSubmitting: false, showRealname: false });
        this.load();
      })
      .catch((e) => {
        this.setData({ rnSubmitting: false });
        wx.showToast({ title: e.message || '实名失败', icon: 'none' });
      });
  },

  applyWithdraw() {
    if (this.data.withdrawing || !this.data.cash) return;
    const c = this.data.cash;
    if (!c.realnamed) { this.setData({ showRealname: true }); return; }
    if (!c.canWithdraw) {
      return wx.showToast({ title: `还差 ¥${(c.gapToFen / 100).toFixed(2)} 可提现`, icon: 'none' });
    }
    if (c.monthlyLeft <= 0) return wx.showToast({ title: '本月提现次数已用完', icon: 'none' });
    wx.showModal({
      title: '申请提现',
      content: `可提 ¥${(c.withdrawableFen / 100).toFixed(2)}（税前），1~3 个工作日审核到账，确认申请？`,
      success: (r) => {
        if (!r.confirm) return;
        this.setData({ withdrawing: true });
        api.post('/api/user/reward-withdraw', {})
          .then(() => {
            wx.showToast({ title: '已提交审核', icon: 'success' });
            this.setData({ withdrawing: false });
            this.load();
          })
          .catch((e) => {
            this.setData({ withdrawing: false });
            wx.showToast({ title: e.message || '申请失败', icon: 'none' });
          });
      },
    });
  },
});
