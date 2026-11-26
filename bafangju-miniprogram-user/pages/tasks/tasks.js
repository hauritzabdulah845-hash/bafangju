// 任务中心 · 完整任务清单（「赚实惠」tab 的「做任务」分段摘要由此页承载详情）
// 数据：/api/tasks/today（签到+浏览）、/api/user/contribution/30d（活跃门槛）、/api/user/promotion/profile（奖励金=推广可提现余额）
// 微信流量主激励视频任务已下线：看视频统一走「赚实惠」tab 的商家视频广告，避免两套视频任务并存
const api = require('../../utils/api');
const bizdate = require('../../utils/bizdate');
const content = require('../../utils/content');
const app = getApp();

Page({
  data: {
    signedToday: false,
    browseTasks: [],   // 进行中/已完成的浏览任务
    browseDone: 0,     // 今日已完成浏览数
    doneCount: 0,      // 今日已完成任务项
    contrib: null,     // 30 天贡献值（活跃门槛 80）
    contribPct: 0,     // 贡献值进度百分比
    rewards: {},       // 后台可配的任务奖励
    streak: null,      // 30 天连击进度
    rewardYuan: '0.00', // 奖励金（推广可提现余额）
    withdrawEnabled: false,
    ct: {},
  },
  onShow() {
    this.load();
    content.ready().then(() => this.applyContent());
  },
  // 后台配置了就用后台文案，未配置保留内置文案
  applyContent() {
    this.setData({ ct: content.pick(['tasks.note']) });
  },
  load() {
    const userId = app.globalData.userId;
    const today = bizdate.today();
    api.get('/api/tasks/today?userId=' + userId + '&date=' + today)
      .then((d) => {
        const browses = d.browses || [];
        const browseDone = browses.filter((b) => b.status === 'done').length;
        this.setData({
          signedToday: !!d.signed,
          browseTasks: browses,
          browseDone,
          doneCount: (d.signed ? 1 : 0) + browseDone,
          rewards: d.rewards || {},
          streak: d.streak || null,
        });
      })
      .catch(() => {});
    api.get('/api/user/contribution/30d?userId=' + userId)
      .then((c) => this.setData({
        contrib: c,
        contribPct: Math.min(100, Math.round((c.weight30d || 0) / (c.target || 80) * 100)),
      }))
      .catch(() => {});
    // 奖励金：推广收益可提现余额（真实数据，售后期后到账）
    api.get('/api/user/promotion/profile?userId=' + userId)
      .then((p) => this.setData({
        rewardYuan: api.fen2yuan(p.balanceFen),
        withdrawEnabled: !!p.withdrawEnabled,
      }))
      .catch(() => {});
  },
  signIn() {
    if (this.data.signedToday) return;
    const today = bizdate.today();
    api.post('/api/tasks/complete', { userId: app.globalData.userId, taskType: 'sign_in', date: today })
      .then(({ reward }) => {
        this.setData({ signedToday: true });
        wx.showToast({ title: `签到成功 +${reward} 贡献值`, icon: 'success' });
        this.load();
      })
      .catch((e) => wx.showToast({ title: e.message, icon: 'none' }));
  },
  // 去浏览一个商品完成 15 秒任务
  goBrowse() {
    wx.switchTab({ url: '/pages/index/index' });
    wx.showToast({ title: '打开商品停留 15 秒即完成', icon: 'none' });
  },
  goHome() { wx.switchTab({ url: '/pages/index/index' }); },
  goPromotion() { wx.navigateTo({ url: '/pages/promotion/promotion' }); },
  goWithdraw() {
    if (!this.data.withdrawEnabled) return wx.showToast({ title: '提现通道暂未开放', icon: 'none' });
    wx.navigateTo({ url: '/pages/withdraw/withdraw' });
  },
  goRules() { wx.navigateTo({ url: '/pages/rules/rules' }); },
  goDividend() { wx.navigateTo({ url: '/pages/dividend/dividend' }); },
});
