// 商家自助视频广告（V4.2 · 额度制）
// 资金口径：商家线下付款 → 平台在总后台发放额度 → 商家在此把额度分配到计划；不接在线支付。
const api = require('../../utils/api');

const STATUS_TEXT = {
  draft: '待审核', active: '投放中', sold_out: '已抢完',
  rejected: '已驳回', offline: '已下架', settled: '已结算',
};

Page({
  data: {
    quota: { grantedYuan: '0.00', availableYuan: '0.00', frozenYuan: '0.00', usedYuan: '0.00' },
    videos: [],
    settlements: [],
    productNames: ['不跳转'],
    productIds: [''],
    productIndex: 0,
    title: '', videoUrl: '', videoName: '', coverUrl: '', coverFull: '',
    durationS: 30, budgetYuan: '', chargeYuan: '', dailyCap: 500,
    pricingText: '填写预算与单 IP 费用后，自动算出需要多少个 IP 看完',
    submitting: false,
  },

  onLoad() { this.loadProducts(); },
  onShow() { this.load(); },

  loadProducts() {
    api.get('/api/merchant/products')
      .then((d) => {
        const list = Array.isArray(d) ? d : (d.products || d.list || []);
        const ids = list.filter((p) => p.status !== 'off').map((p) => p.id);
        const names = list.filter((p) => p.status !== 'off').map((p) => p.title || p.name || p.id);
        this.setData({ productIds: [''].concat(ids), productNames: ['不跳转'].concat(names) });
      })
      .catch(() => {});
  },

  load() {
    api.get('/api/merchant/ad-center')
      .then((d) => {
        const q = d.quota || {};
        const yuan = (f) => api.fen2yuan(f);
        this.setData({
          quota: {
            grantedYuan: yuan(q.grantedFen), availableYuan: yuan(q.availableFen),
            frozenYuan: yuan(q.frozenFen), usedYuan: yuan(q.usedFen),
          },
          videos: (d.videos || []).map((v) => ({
            ...v,
            statusText: STATUS_TEXT[v.status] || v.status,
            budgetYuan: yuan(v.budgetFen), spentYuan: yuan(v.spentFen),
            leftYuan: yuan(v.budgetLeftFen),
            complete: (v.stats && v.stats.completed) || 0,
            expose: (v.stats && v.stats.expose) || 0,
            orders: (v.stats && v.stats.orders) || 0,
          })),
          settlements: (d.settlements || []).map((s) => ({
            ...s,
            budgetYuan: yuan(s.budgetFen), spentYuan: yuan(s.spentFen), refundYuan: yuan(s.refundFen),
            dateText: String(s.settledAt || '').slice(0, 10),
          })),
        });
      })
      .catch(() => {});
  },

  onTitle(e) { this.setData({ title: e.detail.value }); },
  onBudget(e) { this.setData({ budgetYuan: e.detail.value }); this.calcPricing(); },
  onCharge(e) { this.setData({ chargeYuan: e.detail.value }); this.calcPricing(); },
  onCap(e) { this.setData({ dailyCap: Math.max(1, parseInt(e.detail.value, 10) || 1) }); },
  onProduct(e) { this.setData({ productIndex: Number(e.detail.value) || 0 }); },

  calcPricing() {
    const b = Math.round(parseFloat(this.data.budgetYuan) * 100);
    const c = Math.round(parseFloat(this.data.chargeYuan) * 100);
    if (!(b > 0) || !(c > 0)) {
      this.setData({ pricingText: '填写预算与单 IP 费用后，自动算出需要多少个 IP 看完' });
      return;
    }
    const n = Math.floor(b / c);
    const points = Math.max(1, Math.round(c * 0.4));
    this.setData({ pricingText: `预计需 ${n} 个 IP 看完 ｜ 用户每次得 ${points} 贡献值 ｜ 预算留存约 ¥${((b - points * n) / 100).toFixed(2)}` });
  },

  chooseVideo() {
    wx.chooseMedia({
      count: 1, mediaType: ['video'], sourceType: ['album', 'camera'], maxDuration: 600,
      success: (res) => {
        const f = res.tempFiles[0];
        if (!f) return;
        if (f.size && f.size > 24 * 1024 * 1024) { wx.showToast({ title: '视频请控制在 24MB 内', icon: 'none' }); return; }
        wx.showLoading({ title: '上传视频…', mask: true });
        wx.getFileSystemManager().readFile({
          filePath: f.tempFilePath, encoding: 'base64',
          success: (r) => {
            api.post('/api/merchant/upload/video', { dataBase64: r.data })
              .then((u) => {
                wx.hideLoading();
                this.setData({
                  videoUrl: u.url, videoName: '视频已上传',
                  durationS: Math.max(5, Math.min(600, Math.round(f.duration || 30))),
                });
              })
              .catch((err) => { wx.hideLoading(); wx.showToast({ title: err.message || '上传失败', icon: 'none' }); });
          },
          fail: () => { wx.hideLoading(); wx.showToast({ title: '读取视频失败', icon: 'none' }); },
        });
      },
    });
  },

  chooseCover() {
    wx.chooseMedia({
      count: 1, mediaType: ['image'], sourceType: ['album', 'camera'],
      success: (res) => {
        const f = res.tempFiles[0];
        if (!f) return;
        wx.showLoading({ title: '上传封面…', mask: true });
        wx.getFileSystemManager().readFile({
          filePath: f.tempFilePath, encoding: 'base64',
          success: (r) => {
            api.post('/api/upload', { dataBase64: r.data, purpose: 'material' })
              .then((u) => {
                wx.hideLoading();
                this.setData({ coverUrl: u.url, coverFull: api.BASE_URL + u.url });
              })
              .catch((err) => { wx.hideLoading(); wx.showToast({ title: err.message || '上传失败', icon: 'none' }); });
          },
          fail: () => { wx.hideLoading(); wx.showToast({ title: '读取图片失败', icon: 'none' }); },
        });
      },
    });
  },

  submit() {
    const { title, videoUrl, coverUrl, durationS, budgetYuan, chargeYuan, dailyCap, productIds, productIndex, submitting } = this.data;
    if (submitting) return;
    const budgetFen = Math.round(parseFloat(budgetYuan) * 100);
    const chargePerIpFen = Math.round(parseFloat(chargeYuan) * 100);
    if (!title.trim()) { wx.showToast({ title: '请填写广告标题', icon: 'none' }); return; }
    if (!videoUrl) { wx.showToast({ title: '请先上传视频', icon: 'none' }); return; }
    if (!(budgetFen > 0) || !(chargePerIpFen > 0)) { wx.showToast({ title: '请填写预算与单 IP 费用', icon: 'none' }); return; }
    this.setData({ submitting: true });
    api.post('/api/merchant/ad-videos/create', {
      title: title.trim(), videoUrl, coverUrl, durationS,
      productId: productIds[productIndex] || '',
      budgetFen, chargePerIpFen, dailyCap,
    }).then(() => {
      wx.showToast({ title: '已提交，等待平台审核', icon: 'success' });
      this.setData({ title: '', videoUrl: '', videoName: '', coverUrl: '', coverFull: '', budgetYuan: '', chargeYuan: '' });
      this.calcPricing();
      this.load();
    }).catch((e) => wx.showToast({ title: e.message || '提交失败', icon: 'none' }))
      .then(() => this.setData({ submitting: false }));
  },

  append(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '追加预算', editable: true, placeholderText: '金额（元）',
      success: (r) => {
        if (!r.confirm) return;
        const n = parseFloat(r.content);
        if (!(n > 0)) { wx.showToast({ title: '请输入有效金额', icon: 'none' }); return; }
        api.post('/api/merchant/ad-videos/append-budget', { videoId: id, amountFen: Math.round(n * 100) })
          .then(() => { wx.showToast({ title: '已追加', icon: 'success' }); this.load(); })
          .catch((err) => wx.showToast({ title: err.message || '追加失败', icon: 'none' }));
      },
    });
  },

  editMaterial(e) {
    const id = e.currentTarget.dataset.id;
    // 驳回 / 待审核的计划可改素材；改完驳回态自动回到待审核队列
    wx.showModal({
      title: '修改广告标题', editable: true, placeholderText: '输入新标题',
      success: (r) => {
        if (!r.confirm || !String(r.content || '').trim()) return;
        api.post('/api/merchant/ad-videos/material', { videoId: id, title: String(r.content).trim() })
          .then(() => { wx.showToast({ title: '已更新并重提审', icon: 'success' }); this.load(); })
          .catch((err) => wx.showToast({ title: err.message || '修改失败', icon: 'none' }));
      },
    });
  },
});
