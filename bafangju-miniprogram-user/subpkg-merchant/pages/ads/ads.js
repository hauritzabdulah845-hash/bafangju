// 广告位（商家端）：选位 → 投素材 → 提交审核 → 看展示/点击（V3.7）
const api = require('../../utils/api');

Page({
  data: {
    slots: [],
    my: [],
    summary: null,
    loading: true,
    selectedId: '',
    days: 7,
    title: '',
    imageUrl: '',
    imageFull: '',
    targetId: '',
    targetTypes: [
      { key: 'none', label: '不跳转' },
      { key: 'product', label: '商品详情' },
      { key: 'merchant', label: '本店主页' },
    ],
    targetTypeIndex: 0,
    targetType: 'none',
    targetTypeLabel: '不跳转',
    uploading: false,
    submitting: false,
  },
  onShow() {
    const merchantId = getApp().globalData.merchantId;
    if (!merchantId) { wx.reLaunch({ url: '/subpkg-merchant/pages/login/login' }); return; }
    this.load();
  },
  load() {
    const merchantId = getApp().globalData.merchantId;
    Promise.all([
      api.get('/api/merchant/adslots'),
      api.get('/api/merchant/adslots/mine', { merchantId }),
    ]).then(([slots, mine]) => {
      this.setData({
        slots: (slots || []).map((s) => ({
          ...s,
          priceText: api.fen2yuan(s.feePerCycleFen),
          statusText: s.status === 'available' ? '可投放' : '占用中',
        })),
        my: ((mine && mine.list) || []).map((b) => ({
          ...b,
          feeYuan: api.fen2yuan(b.feeFen),
          startAtText: b.startAt ? String(b.startAt).slice(0, 10) : '',
          endAtText: b.endAt ? String(b.endAt).slice(0, 10) : '',
        })),
        summary: (mine && mine.summary) || null,
        loading: false,
      });
    }).catch(() => this.setData({ loading: false }));
  },
  pick(e) {
    const id = e.currentTarget.dataset.id;
    const slot = this.data.slots.find((s) => s.id === id);
    if (!slot) return;
    if (slot.status !== 'available') { wx.showToast({ title: '该广告位占用中', icon: 'none' }); return; }
    this.setData({ selectedId: id, days: slot.minDays || 7 });
  },
  onDays(e) { this.setData({ days: Math.max(1, parseInt(e.detail.value, 10) || 1) }); },
  onTitle(e) { this.setData({ title: e.detail.value }); },
  onTarget(e) { this.setData({ targetId: e.detail.value.trim() }); },
  onTargetType(e) {
    const i = Number(e.detail.value);
    const t = this.data.targetTypes[i] || this.data.targetTypes[0];
    this.setData({ targetTypeIndex: i, targetType: t.key, targetTypeLabel: t.label });
  },
  chooseImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      success: (res) => {
        const filePath = res.tempFiles[0].tempFilePath;
        const ext = (String(filePath).split('.').pop() || 'jpg').toLowerCase();
        wx.getFileSystemManager().readFile({
          filePath,
          encoding: 'base64',
          success: (r) => {
            this.setData({ uploading: true });
            // purpose=material：广告素材存公开目录（用户端需匿名浏览），且必须登录商家身份
            api.post('/api/upload', { dataBase64: r.data, ext, purpose: 'material' })
              .then((u) => this.setData({ imageUrl: u.url, imageFull: api.BASE_URL + u.url }))
              .catch((err) => wx.showToast({ title: err.message, icon: 'none' }))
              .then(() => this.setData({ uploading: false }));
          },
          fail: () => wx.showToast({ title: '读取图片失败', icon: 'none' }),
        });
      },
    });
  },
  goAdVideos() { wx.navigateTo({ url: '/subpkg-merchant/pages/ad-videos/ad-videos' }); },
  clearImage() { this.setData({ imageUrl: '', imageFull: '' }); },
  book() {
    const { selectedId, days, title, imageUrl, targetType, targetId, submitting } = this.data;
    if (submitting) return;
    if (!selectedId) { wx.showToast({ title: '请先选择广告位', icon: 'none' }); return; }
    if (!title) { wx.showToast({ title: '请填写广告标题', icon: 'none' }); return; }
    if (targetType === 'product' && !targetId.trim()) { wx.showToast({ title: '请填写跳转商品 ID', icon: 'none' }); return; }
    this.setData({ submitting: true });
    api.post('/api/merchant/adslots/book', {
      merchantId: getApp().globalData.merchantId,
      slotId: selectedId,
      days,
      title,
      imageUrl,
      targetType,
      targetId: targetType === 'merchant' ? getApp().globalData.merchantId
        : (targetType === 'product' ? targetId.trim() : ''),
    }).then(() => {
      wx.showToast({ title: '已提交，等待平台审核', icon: 'success' });
      this.setData({ selectedId: '', title: '', imageUrl: '', imageFull: '', targetId: '' });
      this.load();
    }).catch((e) => wx.showToast({ title: e.message, icon: 'none' }))
      .then(() => this.setData({ submitting: false }));
  },
});
