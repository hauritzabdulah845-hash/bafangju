// 赚实惠 · 用户激励统一入口（看视频 / 做任务 分段）
// 看视频 = 商家视频广告 V4.2（完播得贡献值）；做任务 = 每日任务摘要，完整清单在 pages/tasks/tasks
// 两个分段共用同一份贡献值，页内合规口径统一：不可兑现、不可提现
const api = require('../../utils/api');
const bizdate = require('../../utils/bizdate');
const { BASE_URL } = require('../../config');
const app = getApp();

Page({
  data: {
    activeTab: 'video',
    rewardVideos: [],
    history: [],
    todayClaimed: 0,
    dailyLimit: 0,
    todayPercent: 0,
    loaded: false,
    coverBase: BASE_URL,
    // 任务分段摘要
    taskSigned: false,
    taskBrowseDone: 0,
    taskDoneCount: 0,
    taskRewards: {},
    taskContrib: null,
    taskContribPct: 0,
  },

  onShow() {
    this.loadRewardVideos();
    this.loadTaskSummary();
  },

  onPullDownRefresh() {
    this.loadRewardVideos();
    this.loadTaskSummary();
    wx.stopPullDownRefresh();
  },

  switchSeg(e) {
    const tab = e.currentTarget.dataset.tab;
    if (!tab || tab === this.data.activeTab) return;
    this.setData({ activeTab: tab });
    if (tab === 'task') this.loadTaskSummary();
  },

  loadRewardVideos() {
    api.get('/api/ads/videos')
      .then((d) => {
        const limit = Number(d.dailyLimit) || 0;
        const claimed = Number(d.todayClaimed) || 0;
        this.setData({
          rewardVideos: d.enabled ? (d.videos || []) : [],
          history: d.history || [],
          todayClaimed: claimed,
          dailyLimit: limit,
          todayPercent: limit > 0 ? Math.min(100, Math.round((claimed / limit) * 100)) : 0,
          loaded: true,
        });
      })
      .catch(() => this.setData({ loaded: true }));
  },

  // 任务摘要：只展示签到/浏览状态与活跃进度，完整任务与奖励金明细仍由任务中心承载
  loadTaskSummary() {
    const userId = app.globalData.userId;
    const today = bizdate.today();
    api.get('/api/tasks/today?userId=' + userId + '&date=' + today)
      .then((d) => {
        const browseDone = (d.browses || []).filter((b) => b.status === 'done').length;
        this.setData({
          taskSigned: !!d.signed,
          taskBrowseDone: browseDone,
          taskDoneCount: (d.signed ? 1 : 0) + browseDone,
          taskRewards: d.rewards || {},
        });
      })
      .catch(() => {});
    api.get('/api/user/contribution/30d?userId=' + userId)
      .then((c) => this.setData({
        taskContrib: c,
        taskContribPct: Math.min(100, Math.round((c.weight30d || 0) / (c.target || 80) * 100)),
      }))
      .catch(() => {});
  },

  // 段内直接签到，成功后刷新摘要（任务中心同款口径）
  signIn() {
    if (this.data.taskSigned) return;
    api.post('/api/tasks/complete', {
      userId: app.globalData.userId,
      taskType: 'sign_in',
      date: bizdate.today(),
    })
      .then(({ reward }) => {
        this.setData({ taskSigned: true });
        wx.showToast({ title: `签到成功 +${reward} 贡献值`, icon: 'success' });
        this.loadTaskSummary();
      })
      .catch((e) => wx.showToast({ title: e.message, icon: 'none' }));
  },

  goWatch(e) {
    const id = e.currentTarget.dataset.id;
    // 点击埋点：失败不阻断跳转
    api.post('/api/ads/videos/' + id + '/event', { type: 'click' }).catch(() => {});
    wx.navigateTo({ url: '/pages/ad-watch/ad-watch?id=' + id });
  },

  // 任务中心是非 tab 页，必须用 navigateTo（旧版 switchTab 会静默失败）
  goTasks() { wx.navigateTo({ url: '/pages/tasks/tasks' }); },
  goBrowse() {
    wx.switchTab({ url: '/pages/index/index' });
    wx.showToast({ title: '打开商品停留 15 秒即完成', icon: 'none' });
  },
  goPromotion() { wx.navigateTo({ url: '/pages/promotion/promotion' }); },
  goHome() { wx.switchTab({ url: '/pages/index/index' }); },
});
