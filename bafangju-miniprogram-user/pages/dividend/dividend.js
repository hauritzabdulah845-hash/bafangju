const api = require('../../utils/api');
const content = require('../../utils/content');
const app = getApp();

Page({
  data: {
    pool: { balanceYuan: '0.00' },
    slots: [],
    payouts: [],
    myBalanceYuan: '0.00',
    activeSlotCount: 0,
    dividendYuan: '0.00',
    unitValue: null,
    unitZero: false,
    ct: {},
    downgrade: false,
    loading: true,
    loadError: '',
  },
  onShow() {
    const dg = !!app.globalData.downgrade;
    this.setData({ downgrade: dg });
    if (dg) return;
    this.load();
    content.ready().then(() => this.applyContent());
  },
  // 后台配置了就用后台文案，未配置保留内置文案
  applyContent() {
    this.setData({ ct: content.pick(['dividend.note']) });
  },
  load() {
    const userId = app.globalData.userId;
    this.setData({ loading: true, loadError: '' });
    Promise.all([
      api.get('/api/dividend/pool'),
      api.get('/api/dividend/my' + (userId ? '?userId=' + userId : '')),
      api.get('/api/contribution/value'),
    ]).then(([pool, my, cv]) => {
      const slots = my.slots || [];
      // 只展示已发放记录（revoked 为周期作废收回，不应显示为已到账）
      const paidPayouts = (my.payouts || []).filter((p) => p.status === 'paid');
      // 季度记录只有 quarter、没有 date，按季度末折算成可比较的日期后再倒序
      const quarterEnd = { 1: '03-31', 2: '06-30', 3: '09-30', 4: '12-31' };
      const sortKey = (p) => {
        if (p.date) return String(p.date);
        const m = String(p.quarter || '').match(/^(\d{4})Q([1-4])$/);
        return m ? m[1] + '-' + quarterEnd[m[2]] : '';
      };
      const sortedPayouts = paidPayouts.slice().sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
      this.setData({
        pool: { ...pool, balanceYuan: api.fen2yuan(pool.balanceFen) },
        slots,
        // 「排队中」= waiting + skipped（skipped 只是本轮顺延，仍在队列里）；已发放/收回不计入
        activeSlotCount: slots.filter((s) => s.status === 'waiting' || s.status === 'skipped').length,
        myBalanceYuan: api.fen2yuan(my.dividendBalanceFen),
        payouts: sortedPayouts.map((p) => ({ ...p, yuan: api.fen2yuan(p.fen) })),
        // 累计分红 = 已发放记录求和（dividendBalanceFen 是当前余额，消费后会减少，不能当累计）
        dividendYuan: api.fen2yuan(paidPayouts.reduce((s, p) => s + (p.fen || 0), 0)),
        unitValue: cv.unitValueFen == null ? null : api.fen2yuan(cv.unitValueFen),
        // 0 值时不展示「¥0.00/分」和计算公式，改为「暂无可分配」说明
        unitZero: cv.unitValueFen === 0,
        loading: false,
      });
    }).catch(() => {
      // 任何一个接口失败都统一提示，避免把「加载失败」显示成「没有分红数据」
      this.setData({ loading: false, loadError: '分红数据加载失败，请检查网络后重试' });
    });
  },
  goRules() { wx.navigateTo({ url: '/pages/rules/rules' }); },
});
