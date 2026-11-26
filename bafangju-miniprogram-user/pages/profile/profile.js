// 我的 · 拼多多配色（规范板推断）
// 数据：/api/orders/list（订单角标真实计数）、/api/messages（未读数）
// 导航修正：tabBar 页（首页/订单/阶梯优惠/我的）必须 switchTab；跨 tab 传参走 globalData
const api = require('../../utils/api');
const content = require('../../utils/content');
const app = getApp();

const MENU_DEFAULTS = {
  returns: '阶梯优惠与进度',
  rebuy: '常买商品（一键再买）',
  coupons: '我的券（联盟优惠）',
  address: '收货地址',
  dividend: '我的分红',
  promotion: '推广中心（邀请好友）',
  withdraw: '提现',
  messages: '消息中心',
  tasks: '签到与任务',
  rules: '规则说明',
  privacy: '隐私政策',
  terms: '用户协议',
};

function parseMenu(raw) {
  let configured;
  try {
    configured = JSON.parse(raw);
  } catch (e) {
    return {};
  }
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) return {};

  const menu = {};
  Object.keys(configured).forEach((key) => {
    const value = configured[key];
    if (Object.prototype.hasOwnProperty.call(MENU_DEFAULTS, key)
      && typeof value === 'string'
      && value.trim()
      && Array.from(value).length <= 12) menu[key] = value;
  });
  return menu;
}

Page({
  data: {
    downgrade: false,
    userId: '',
    nickname: '',
    avatarUrl: '',
    unread: 0,
    level: null,
    counts: { pending: 0, receiving: 0, done: 0 },
    ct: {},
    menu: {},
    isMerchant: false, // 商家工作台登录态（分包 subpkg-merchant，独立账号体系）
    filing: { icp: null, police: null }, // 备案信息（公安联网备案 / ICP），未配置则隐藏
  },
  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().setData({ selected: 3 });
    this.setData({
      downgrade: app.globalData.downgrade,
      userId: app.globalData.userId,
      nickname: app.globalData.nickname || '未登录',
      avatarUrl: app.globalData.avatarUrl || wx.getStorageSync('avatarUrl') || '',
      isMerchant: !!(wx.getStorageSync('merchantId') && wx.getStorageSync('merchant_token')),
    });
    this.loadCounts();
    this.loadUnread();
    this.loadLevel();
    this.loadFiling();
    content.ready().then(() => this.applyContent());
  },
  // 备案信息：号未下来时接口返回 null，界面整块隐藏
  loadFiling() {
    api.get('/api/filing').then((d) => {
      if (d && (d.icp || d.police)) this.setData({ filing: { icp: d.icp || null, police: d.police || null } });
    }).catch(() => {});
  },
  // 点击备案号：复制到剪贴板（小程序无法直接打开外部 http 链接，合规展示以备案号文字为准）
  copyFiling(e) {
    const no = e.currentTarget.dataset.no;
    if (!no) return;
    wx.setClipboardData({ data: String(no) });
  },
  // 后台配置了就用后台文案，未配置保留内置文案
  applyContent() {
    this.setData({
      ct: content.pick(['profile.compliance']),
      menu: parseMenu(content.text('profile.menu')),
    });
  },
  loadLevel() {
    api.get('/api/user/level').then((level) => this.setData({ level })).catch(() => {});
  },
  loadCounts() {
    api.get('/api/orders/list?userId=' + app.globalData.userId)
      .then((list) => {
        const all = list || [];
        this.setData({
          counts: {
            pending: all.filter((o) => o.status === 'pending_pay').length,
            receiving: all.filter((o) => o.status === 'paid' || o.status === 'shipped').length,
            done: all.filter((o) => o.status === 'done').length,
          },
        });
      })
      .catch(() => {});
  },
  loadUnread() {
    api.get('/api/messages?userId=' + app.globalData.userId)
      .then((d) => this.setData({ unread: d.unread || 0 }))
      .catch(() => {});
  },
  // tabBar 页跳转（跨 tab 传参走 globalData.ordersTab）
  goTab(e) {
    const url = e.currentTarget.dataset.url;
    wx.switchTab({ url });
  },
  // 订单宫格：跳订单 tab 并预选状态
  goOrders(e) {
    app.globalData.ordersTab = e.currentTarget.dataset.tab || 'all';
    wx.switchTab({ url: '/pages/orders/orders' });
  },
  goPage(e) { wx.navigateTo({ url: e.currentTarget.dataset.url }); },
  // 商家工作台：已登录商家直达工作台，未登录去商家登录页（分包）
  goMerchant() {
    const url = this.data.isMerchant
      ? '/subpkg-merchant/pages/index/index'
      : '/subpkg-merchant/pages/login/login';
    wx.navigateTo({ url });
  },
  goAddress() { wx.navigateTo({ url: '/pages/address/address' }); },
  goMessages() { wx.navigateTo({ url: '/pages/messages/messages' }); },
  goDividend() {
    if (this.data.downgrade) return wx.showToast({ title: '功能维护中', icon: 'none' });
    wx.navigateTo({ url: '/pages/dividend/dividend' });
  },
  goCoupons() { wx.navigateTo({ url: '/pages/coupons/coupons' }); },
  goAgreement(e) {
    const type = (e.currentTarget.dataset.type === 'terms') ? 'terms' : 'privacy';
    wx.navigateTo({ url: '/pages/agreement/agreement?type=' + type });
  },
  // 微信头像选择（open-type=chooseAvatar）：本地临时文件 → 上传公开素材目录 → 写回个人资料
  onChooseAvatar(e) {
    const filePath = (e.detail && e.detail.avatarUrl) || '';
    if (!filePath) return;
    wx.getFileSystemManager().readFile({
      filePath,
      encoding: 'base64',
      success: (r) => {
        wx.showLoading({ title: '上传中', mask: true });
        api.post('/api/upload', { dataBase64: r.data, ext: 'png', purpose: 'material' })
          .then((u) => api.post('/api/user/profile', { avatarUrl: u.url }))
          .then((p) => {
            const full = p.avatarUrl ? api.BASE_URL + p.avatarUrl : '';
            app.globalData.avatarUrl = full;
            try { wx.setStorageSync('avatarUrl', full); } catch (err) { /* ignore */ }
            this.setData({ avatarUrl: full });
          })
          .catch((err) => wx.showToast({ title: (err && err.message) || '头像上传失败', icon: 'none' }))
          .then(() => wx.hideLoading());
      },
      fail: () => wx.showToast({ title: '读取头像失败', icon: 'none' }),
    });
  },
  copyId() {
    if (!this.data.userId) return;
    wx.setClipboardData({ data: String(this.data.userId) });
  },
});
