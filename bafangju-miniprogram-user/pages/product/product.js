const api = require('../../utils/api');
const bizdate = require('../../utils/bizdate');
const app = getApp();

Page({
  data: { p: null, ladder: [], agreed: false, submitting: false, selectedAddress: null, ads: [] },
  onLoad(q) {
    this.productId = q.id;
    this.browseStarted = false;
    this.browseTimer = null;
    // 广告归因：从视频观看页跳转时带来源；否则读 24 小时内最近一次观看（超时不归因）
    this.sourceVideoId = String(q.sourceVideoId || '');
    if (!this.sourceVideoId) {
      try {
        const last = wx.getStorageSync('bfj_source_video');
        if (last && last.id && Date.now() - (last.ts || 0) < 24 * 3600 * 1000) this.sourceVideoId = last.id;
      } catch (_) { /* 存储不可用不阻断下单 */ }
    }
  },
  onShow() {
    this.load();
    this.startBrowseTask();
    // 从地址页选择返回
    if (app.globalData.selectedAddress) {
      this.setData({ selectedAddress: app.globalData.selectedAddress });
      app.globalData.selectedAddress = null;
    }
  },
  onHide() { clearTimeout(this.browseTimer); },
  onUnload() { clearTimeout(this.browseTimer); },
  // 浏览商品任务：进入商品页自动开始，真实停留 15 秒后由服务端校验完成
  startBrowseTask() {
    const userId = app.globalData.userId;
    if (!userId || this.browseStarted) return;
    this.browseStarted = true;
    const today = bizdate.today();
    api.post('/api/tasks/browse-start', { userId, productId: this.productId, date: today })
      .then(() => {
        this.browseTimer = setTimeout(() => {
          api.post('/api/tasks/browse-finish', { userId, productId: this.productId, date: today })
            .then((r) => wx.showToast({ title: `浏览任务完成 +${r.reward} 贡献值`, icon: 'success' }))
            .catch(() => {}); // 未满 15 秒（如锁屏）静默，次日可再试
        }, 15100);
      }).catch(() => { this.browseStarted = false; });
  },
  load() {
    const userId = app.globalData.userId;
    api.get(`/api/products/${this.productId}?userId=${userId}`).then((raw) => {
      const p = { ...raw, nextPayYuan: api.fen2yuan(raw.nextPayFen), priceYuan: api.fen2yuan(raw.priceFen), img: raw.imageUrl ? api.BASE_URL + raw.imageUrl : '' };
      const cur = p.myStep;
      const steps = (p.ladderExampleFen || []).map((fen, i) => {
        const step = i + 1;
        // 状态互斥：已走过 > 下一单 > 未开始；让利段（第 n+1..n+4 单）额外标注折扣
        const cls = step <= cur ? 'past' : (step === cur + 1 ? 'next' : '');
        // 节省额：以标价（全价段）为基准
        const baseFen = (p.ladderExampleFen || [])[0] || fen;
        const save = (baseFen - fen) / 100;
        const discount = step > p.n ? ('省' + Math.round((1 - fen / baseFen) * 100) + '%') : '';
        const label = cls === 'next' ? '下一单'
          : (cls === 'past' ? '✓ 第' + step + '单' : '第' + step + '单');
        return { step, price: '¥' + api.fen2yuan(fen), saveYuan: save > 0 ? save : 0, cls, label, discount };
      });
      // 排版：格数 ≤5 一行排完；≥6 折成两行（每行 ceil(n/2) 格），避免格子被压成细条
      const total = steps.length;
      const cols = total <= 5 ? total : Math.ceil(total / 2);
      const GAP = 12; // 与 .ladder 的 gap 一致
      const cellWidth = `calc((100% - ${(cols - 1) * GAP}rpx) / ${cols})`;
      this.setData({
        p,
        ladder: steps,
        ladderWrap: total > cols,
        ladderCellWidth: cellWidth,
      });
      this.loadAds();
    });
  },
  // 详情页广告位（商家投放，曝光上报一次）
  loadAds() {
    const userId = app.globalData.userId;
    api.get('/api/ads?position=detail&userId=' + userId).then((list) => {
      const ads = (list || []).map((a) => ({ ...a, fullImage: a.imageUrl ? api.BASE_URL + a.imageUrl : '' }));
      this.setData({ ads });
      ads.forEach((a) => api.post('/api/ads/impression', { bookingId: a.bookingId, userId }).catch(() => {}));
    }).catch(() => {});
  },
  onAdTap(e) {
    const bookingId = e.currentTarget.dataset.id;
    api.post('/api/ads/click', { bookingId, userId: app.globalData.userId })
      .then((r) => {
        if (r && r.targetType === 'product' && r.targetId && String(r.targetId) !== String(this.productId)) {
          wx.navigateTo({ url: '/pages/product/product?id=' + r.targetId });
        }
      })
      .catch(() => {});
  },
  toggleAgree() { this.setData({ agreed: !this.data.agreed }); },
  goRules() { wx.navigateTo({ url: '/pages/rules/rules?from=order' }); },
  goAddress() { wx.navigateTo({ url: '/pages/address/address?mode=select' }); },
  // 下单前统一校验：已登录 + 规则确认 + 快递商品已选地址
  precheck() {
    if (!this.data.agreed) { wx.showToast({ title: '请先阅读并确认规则', icon: 'none' }); return false; }
    const p = this.data.p;
    if (p && (p.deliveryType || 'express') === 'express' && !this.data.selectedAddress) {
      wx.showToast({ title: '请先选择收货地址', icon: 'none' });
      this.goAddress();
      return false;
    }
    return true;
  },
  submit() {
    if (this.data.submitting) return;
    if (!this.precheck()) return;
    // 下单强制登录：未登录/会话失效先静默重登再提交
    app.ensureLogin((ok) => {
      if (!ok) return;
      this.doSubmit();
    });
  },
  doSubmit() {
    this.setData({ submitting: true });
    const userId = app.globalData.userId;
    const addressId = (this.data.selectedAddress || {}).id;
    // 记录规则版本确认（V3.3 §5.2-1：首次下单强制，留档版本号）；服务端未确认会拒绝下单
    api.post('/api/user/rules/confirm', { version: app.globalData.rulesVersion || '', source: 'order' })
      .then(() => api.post('/api/orders', {
        userId, productId: this.productId, addressId,
        idempotencyKey: 'mp' + Date.now(),
        sourceVideoId: this.sourceVideoId || '',
      }))
      .then(({ order }) => {
        if (this.sourceVideoId) { try { wx.removeStorageSync('bfj_source_video'); } catch (_) { /* 忽略 */ } }
        return this.pay(order.id);
      })
      .catch((e) => {
        wx.showToast({ title: e.message, icon: 'none' });
        if (e.message && e.message.includes('规则')) app.loadConfig();
        if (e.message && e.message.includes('登录')) app.globalData.token = '';
      })
      .finally(() => this.setData({ submitting: false }));
  },
  /** 支付：真实模式唤起微信支付，模拟模式直接入账；随后轮询订单状态，成功后进支付结果页 */
  pay(orderId) {
    return api.payOrder(orderId)
      .then(() => api.waitPaid(orderId))
      .then((o) => {
        const paid = !!(o && o.status && o.status !== 'pending_pay');
        if (paid) {
          // 支付结果页：展示本单实付/步位、下一单实付、周期进度
          wx.redirectTo({ url: '/pages/pay-result/pay-result?orderId=' + orderId });
          return;
        }
        wx.showToast({ title: '支付确认中，请稍后查看订单', icon: 'none' });
        this.load();
      });
  },
});
