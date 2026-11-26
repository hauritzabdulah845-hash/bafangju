// 商家登录（V3.8）：账号 + 密码；不再"输入名称即登录"，也不自动注册
const api = require('../../utils/api');

Page({
  data: { username: '', password: '', showPwd: false, loading: false },
  onUsername(e) { this.setData({ username: e.detail.value }); },
  onPassword(e) { this.setData({ password: e.detail.value }); },
  togglePwd() { this.setData({ showPwd: !this.data.showPwd }); },
  async doLogin() {
    const { username, password, loading } = this.data;
    if (loading) return;
    if (!username || !password) {
      wx.showToast({ title: '请输入账号与密码', icon: 'none' });
      return;
    }
    this.setData({ loading: true });
    try {
      const r = await api.post('/api/merchant/login', { username, password });
      api.saveToken(r.token); // 签发 token，后续请求自动携带
      wx.setStorageSync('merchantId', r.merchantId);
      wx.setStorageSync('merchantName', r.name);
      getApp().globalData.merchantId = r.merchantId;
      getApp().globalData.merchantName = r.name;
      if (r.mustChangePassword) {
        wx.showModal({
          title: '安全提示',
          content: '当前使用的是初始密码，建议立即修改为个人密码。',
          confirmText: '去修改',
          cancelText: '稍后',
          success: (m) => { if (m.confirm) wx.navigateTo({ url: '/subpkg-merchant/pages/password/password' }); },
        });
      }
      wx.redirectTo({ url: '/subpkg-merchant/pages/index/index' });
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },
  goEntry() { wx.navigateTo({ url: '/subpkg-merchant/pages/entry/entry' }); },
  onShow() {
    // 自动跳回工作台必须同时具备 merchantId 与 token：
    // 只看 merchantId 会与 401 兜底形成互跳死循环（token 已被服务端轮换/重置时）
    const token = wx.getStorageSync('merchant_token');
    if (getApp().globalData.merchantId && token) {
      wx.redirectTo({ url: '/subpkg-merchant/pages/index/index' });
    }
  },
});
