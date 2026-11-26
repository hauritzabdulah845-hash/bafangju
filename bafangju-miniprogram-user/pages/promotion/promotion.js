// 推广中心：邀请码 / 分享 / 推广收益（合规：仅展示方案A记账结算收益，无"躺赚/返利"话术）
const api = require('../../utils/api');
const time = require('../../utils/time');
const content = require('../../utils/content');
const app = getApp();

Page({
  data: {
    profile: null,
    earnings: [],
    withdrawYuan: '0.00',
    withdrawEnabled: false,
    qrcode: null,
    qrLoading: true,
    ct: {},
  },
  onShow() {
    if (!app.globalData.userId) { setTimeout(() => this.onShow(), 600); return; }
    this.load();
    content.ready().then(() => this.applyContent());
  },
  // 后台配置了就用后台文案，未配置保留内置文案
  applyContent() {
    this.setData({ ct: content.pick(['promotion.note']) });
  },
  load() {
    const userId = app.globalData.userId;
    api.get('/api/user/promotion/profile?userId=' + userId).then((p) => this.setData({
      profile: p,
      withdrawYuan: api.fen2yuan(p.balanceFen),
      withdrawEnabled: p.withdrawEnabled,
    }));
    api.get('/api/user/promotion/earnings?userId=' + userId).then((d) => this.setData({
      // timeText 为本地可读时间；原始 ts 字段保持服务端原值不动
      earnings: (d.flows || []).map((f) => ({ ...f, yuan: f.yuan, text: f.status === 'balance' ? '已到账' : '待到账（过退货期）', timeText: time.formatTime(f.ts) })),
    }));
    // 小程序码：服务端已配置 AppID/Secret 时返回真实码（url + base64），否则 devMode 占位
    this.setData({ qrLoading: true });
    api.get('/api/user/promotion/qrcode?userId=' + userId)
      .then((q) => this.setData({
        qrcode: { ...q, fullUrl: q.url ? api.BASE_URL + q.url : '' },
        qrLoading: false,
      }))
      .catch(() => this.setData({ qrLoading: false }));
  },
  // 预览小程序码（可长按保存/转发）
  previewQr() {
    const q = this.data.qrcode;
    if (!q || q.devMode) return;
    wx.previewImage({ urls: [q.fullUrl || ('data:image/png;base64,' + q.base64)] });
  },
  // 保存小程序码到相册：base64 写本地文件 → saveImageToPhotosAlbum（首次需授权）
  saveQr() {
    const q = this.data.qrcode;
    if (!q || q.devMode) {
      return wx.showToast({ title: '当前为占位码，请先在后台配置小程序 AppID', icon: 'none', duration: 2500 });
    }
    const write = () => {
      const filePath = `${wx.env.USER_DATA_PATH}/invite_qr_${Date.now()}.png`;
      wx.getFileSystemManager().writeFile({
        filePath, data: q.base64, encoding: 'base64',
        success: () => wx.saveImageToPhotosAlbum({
          filePath,
          success: () => wx.showToast({ title: '已保存到相册', icon: 'success' }),
          fail: (e) => wx.showToast({ title: '保存失败：' + (e.errMsg || ''), icon: 'none' }),
        }),
        fail: (e) => wx.showToast({ title: '图片生成失败：' + (e.errMsg || ''), icon: 'none' }),
      });
    };
    wx.getSetting({
      success: (s) => {
        if (s.authSetting['scope.writePhotosAlbum'] === false) {
          // 曾拒绝过：引导到设置页开启，而不是反复弹授权
          wx.showModal({
            title: '需要相册权限', content: '保存小程序码需允许保存到相册，是否去设置开启？',
            success: (r) => { if (r.confirm) wx.openSetting(); },
          });
          return;
        }
        write();
      },
      fail: write,
    });
  },
  // 降级模式分享不带推广参数（auditDowngrade 生效时不推广）
  onShareAppMessage() {
    if (app.globalData.downgrade) return { title: '八方聚共享平台', path: '/pages/index/index' };
    return {
      title: '八方聚共享平台 · 阶梯优惠商城',
      path: '/pages/index/index?inviter=' + app.globalData.userId,
    };
  },
  copyCode() {
    const code = (this.data.profile && this.data.profile.inviteCode) || String(app.globalData.userId);
    wx.setClipboardData({ data: code });
  },
  goTeam() { wx.navigateTo({ url: '/pages/team/team' }); },
  goWithdraw() {
    if (!this.data.withdrawEnabled) return wx.showToast({ title: '提现通道暂未开放', icon: 'none' });
    wx.navigateTo({ url: '/pages/withdraw/withdraw' });
  },
});
