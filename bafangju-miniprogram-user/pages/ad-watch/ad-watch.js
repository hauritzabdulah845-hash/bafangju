// 观看广告领奖页（V4.0 · 合规整改）：全屏播放 → 完播校验 → 发放贡献值（不可提现）
// 防刷约定：禁拖动快进（controls 关闭 + 自己画进度条），服务端二次校验观看时长
const api = require('../../utils/api');
const { BASE_URL } = require('../../config');

Page({
  data: {
    video: null,
    src: '',
    poster: '',
    playing: false,
    progress: 0,        // 0~100
    state: 'loading',   // loading | playing | error
    errorMsg: '',
    rewarded: false,    // 完播领取成功
    rewardPoints: 0,
    totalWeight: 0,
    canGoProduct: false,
    claiming: false,
  },

  onLoad(q) {
    this.videoId = q.id;
    this.minWatchS = 0;
    this.startedAt = 0;
    this.loadVideo();
  },

  loadVideo() {
    api.get('/api/ads/videos')
      .then((d) => {
        const v = (d.videos || []).find((x) => x.id === this.videoId);
        if (!v) throw new Error('广告不存在或已结束');
        if (v.claimedByUser) throw new Error('该广告已领取过奖励');
        // 先上报开始观看（服务端记录时间戳 + IP，并返回最短观看时长）
        return api.post('/api/ads/videos/' + v.id + '/start').then((s) => {
          this.minWatchS = s.minWatchS || Math.ceil(v.durationS * 0.95);
          this.startedAt = Date.now();
          this.setData({
            video: v,
            src: BASE_URL + v.videoUrl,
            poster: v.coverUrl ? BASE_URL + v.coverUrl : '',
            state: 'playing',
            canGoProduct: !!v.productId,
          });
          this.autoPlay();
        });
      })
      .catch((e) => {
        this.setData({ state: 'error', errorMsg: e.message || '加载失败' });
      });
  },

  autoPlay() {
    const ctx = wx.createVideoContext('adVideo', this);
    setTimeout(() => ctx.play(), 200);
  },

  onTimeUpdate(e) {
    const { currentTime, duration } = e.detail;
    if (!duration) return;
    this.setData({ progress: Math.min(100, Math.round((currentTime / duration) * 100)) });
  },

  onEnded() {
    this.claim();
  },

  claim() {
    if (this.data.claiming || this.data.rewarded) return;
    this.setData({ claiming: true });
    api.post('/api/ads/videos/' + this.videoId + '/reward')
      .then((r) => {
        this.setData({
          rewarded: true,
          claiming: false,
          rewardPoints: r.points || 0,
          totalWeight: r.weight || 0,
        });
      })
      .catch((e) => {
        this.setData({ claiming: false });
        wx.showModal({
          title: '未能领取',
          content: e.message || '请完整观看后再领取',
          showCancel: false,
          success: () => wx.navigateBack(),
        });
      });
  },

  goProduct() {
    // 记录广告来源：下单时带给服务端，用于「看完广告 → 下单」转化归因（24 小时有效）
    try { wx.setStorageSync('bfj_source_video', { id: this.videoId, ts: Date.now() }); } catch (_) { /* 忽略 */ }
    api.post('/api/ads/videos/' + this.videoId + '/event', { type: 'product_click' }).catch(() => {});
    wx.redirectTo({ url: '/pages/product/product?id=' + this.data.video.productId + '&sourceVideoId=' + this.videoId });
  },

  goBack() {
    wx.navigateBack();
  },
});
