const api = require('../../utils/api');
const L = require('../../utils/ladder');
const app = getApp();

Page({
  data: { progress: [], others: [], current: null, savedYuan: '0.00' },
  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().setData({ selected: 2 });
    this.load();
  },
  load() {
    const userId = app.globalData.userId;
    api.get('/api/return-plans?userId=' + userId).then((d) => {
      const list = (d.progress || []).map((p) => {
        const voided = p.status === 'voided';
        // 阶梯价表由后端按「该类目最近成交商品标价 + 当前步位」算出，前端只做格式化
        const nextPayYuan = p.nextPayFen != null ? api.fen2yuan(p.nextPayFen) : '';
        const refYuan = p.refPriceFen != null ? api.fen2yuan(p.refPriceFen) : '';
        const diffFen = (p.refPriceFen != null && p.nextPayFen != null) ? p.refPriceFen - p.nextPayFen : 0;
        // 进度条按「当前步 / 总步」，与文字「第 N 步 / 共 M 步」同口径
        const pct = p.total ? Math.round((p.step / p.total) * 100) : 0;
        return {
          ...p,
          voided,
          nextPayYuan,
          refYuan,
          savedYuan: diffFen > 0 ? api.fen2yuan(diffFen) : '',
          stepText: voided ? '已作废' : '第 ' + p.step + ' 步 / 共 ' + p.total + ' 步',
          pct: Math.min(100, Math.max(0, pct)),
          chips: voided ? [] : L.chipWindow(p.ladder, p.step, p.n, p.total),
          hint: voided ? '退款后该周期进度已重置' : L.stageHint(p.step, p.n),
        };
      });

      // 当前周期 = 有阶梯数据且进度最深的类目（同一步位时取已下单更多的）
      const ranked = list
        .filter((p) => !p.voided && p.chips.length)
        .sort((a, b) => (b.step - a.step) || (b.done - a.done));
      const current = ranked[0] || null;
      const others = list.filter((p) => !current || p.categoryId !== current.categoryId);

      this.setData({ savedYuan: api.fen2yuan(d.savedFen), progress: list, current, others });
    }).catch(() => {});
  },
  goDividend() {
    if (getApp().globalData.downgrade) return;
    wx.navigateTo({ url: '/pages/dividend/dividend' });
  },
  goRebuy() { wx.navigateTo({ url: '/pages/rebuy/rebuy' }); },
  // 未开始的类目 → 去首页挑商品
  goShop() { wx.switchTab({ url: '/pages/index/index' }); },
});
