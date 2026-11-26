// 商家端 · 修改登录密码（初始密码自助更换；改密后服务端轮换 token，需重新登录）
const api = require('../../utils/api');

Page({
  data: { oldPassword: '', newPassword: '', confirmPassword: '', submitting: false },
  onInput(e) { this.setData({ [e.currentTarget.dataset.k]: e.detail.value }); },
  submit() {
    const { oldPassword, newPassword, confirmPassword, submitting } = this.data;
    if (submitting) return;
    if (!oldPassword) return wx.showToast({ title: '请输入原密码', icon: 'none' });
    if (!newPassword || newPassword.length < 8) return wx.showToast({ title: '新密码至少 8 位', icon: 'none' });
    if (newPassword !== confirmPassword) return wx.showToast({ title: '两次输入的新密码不一致', icon: 'none' });
    this.setData({ submitting: true });
    api.post('/api/merchant/change-password', { oldPassword, newPassword })
      .then(() => {
        wx.showModal({
          title: '修改成功',
          content: '登录状态已失效，请使用新密码重新登录。',
          showCancel: false,
          success: () => {
            try {
              wx.removeStorageSync('merchant_token');
              wx.removeStorageSync('merchantId');
              wx.removeStorageSync('merchantName');
            } catch (e) { /* ignore */ }
            const app = getApp();
            app.globalData.merchantId = null;
            app.globalData.merchantName = null;
            wx.reLaunch({ url: '/pages/login/login' });
          },
        });
      })
      .catch((e) => wx.showToast({ title: e.message, icon: 'none' }))
      .finally(() => this.setData({ submitting: false }));
  },
});
