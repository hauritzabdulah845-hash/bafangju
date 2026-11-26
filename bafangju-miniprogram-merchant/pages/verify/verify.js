// 到店核销（商家端）：券码 → 券面/可用性 → 券前消费总额 → 优惠与顾客应付 → 核销计服务费（V4.4）
const api = require('../../utils/api');

Page({
  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().setData({ selected: 1 });
  },
  data: {
    code: '', amount: '',
    coupon: null,      // 券面信息（查券成功后展示）
    usable: false,
    preview: null,     // { discountYuan, payableYuan, belowMin, minYuan, totalYuan }
    noCoupon: false,
    result: null,
    submitting: false,
    looking: false,
  },

  onCode(e) {
    const code = String(e.detail.value || '').trim();
    this.setData({ code, coupon: null, usable: false, preview: null, noCoupon: false });
    if (code.length === 8) this.lookup();
  },

  /** 查券（无副作用）：确认是本店券且未使用，展示券面 */
  lookup() {
    const code = this.data.code;
    if (!code || this.data.looking) return;
    this.setData({ looking: true });
    api.get('/api/merchant/coupons/lookup', { code })
      .then((r) => {
        const c = r.coupon || {};
        const valueText = c.type === 'discount'
          ? String(Number((Number(c.discountRate) * 10).toFixed(1))) + ' 折'
          : (c.type === 'package'
            ? ((Number(r.totalTimes) || 1) > 1 ? (r.totalTimes + ' 次卡') : '次卡/服务')
            : '¥' + api.fen2yuan(c.amountOffFen || 0));
        // 次卡（V4.6）：展示剩余次数；核销后券不会作废，可继续核销直到次数用完
        const isTimes = c.type === 'package' && (Number(r.totalTimes) || 1) > 1;
        this.setData({
          coupon: {
            ...c,
            valueText,
            minText: c.minSpendFen ? '满 ' + api.fen2yuan(c.minSpendFen) + ' 元可用' : '无门槛',
            timesText: isTimes ? ('已用 ' + (r.usedTimes || 0) + '/' + r.totalTimes + ' 次，剩 ' + r.remainingTimes + ' 次') : '',
            statusText: r.status === 'used'
              ? (isTimes ? '次数已用完' : '该券已核销')
              : (r.status === 'expired' ? '该券已过期' : (isTimes ? '待核销（剩 ' + r.remainingTimes + ' 次）' : '待核销')),
            expireText: r.expiresAt ? String(r.expiresAt).slice(0, 10) : '',
          },
          usable: !!r.usable,
          preview: null,
          noCoupon: false,
        });
        if (!r.usable) {
          wx.showToast({ title: r.status === 'used' ? (isTimes ? '该次卡次数已用完' : '该券已核销') : '该券已过期', icon: 'none' });
        } else {
          this.computePreview();
        }
      })
      .catch((e) => {
        this.setData({ coupon: null, usable: false, preview: null, noCoupon: true });
        wx.showToast({ title: e.message || '查券失败', icon: 'none' });
      })
      .then(() => this.setData({ looking: false }));
  },

  /** 输入消费总额时实时算优惠与顾客应付（口径：券前总额，与后端同公式） */
  onAmount(e) {
    this.setData({ amount: e.detail.value }, () => this.computePreview());
  },

  computePreview() {
    const { coupon, amount } = this.data;
    if (!coupon) { this.setData({ preview: null }); return; }
    const yuan = Number(amount);
    if (!yuan || yuan <= 0) { this.setData({ preview: null }); return; }
    const totalFen = Math.round(yuan * 100);
    let discountFen = 0;
    let payableFen = totalFen;
    if (coupon.type === 'discount') {
      const rate = Number(coupon.discountRate);
      payableFen = Math.round(totalFen * rate);
      discountFen = totalFen - payableFen;
    } else if (coupon.type !== 'package') {
      discountFen = Math.min(totalFen, Number(coupon.amountOffFen) || 0);
      payableFen = totalFen - discountFen;
    }
    const minFen = Number(coupon.minSpendFen) || 0;
    this.setData({
      preview: {
        totalYuan: api.fen2yuan(totalFen),
        discountYuan: api.fen2yuan(discountFen),
        payableYuan: api.fen2yuan(payableFen),
        belowMin: totalFen < minFen,
        minYuan: api.fen2yuan(minFen),
      },
    });
  },

  scan() {
    wx.scanCode({
      success: (res) => {
        const code = String(res.result || '').trim().slice(0, 8);
        this.setData({ code, coupon: null, usable: false, preview: null, noCoupon: false }, () => this.lookup());
      },
    });
  },

  doVerify() {
    const { code, amount, submitting, coupon, usable } = this.data;
    if (submitting) return;
    if (!code) { wx.showToast({ title: '请输入用户出示的核销码', icon: 'none' }); return; }
    const yuan = Number(amount);
    if (!yuan || yuan <= 0) { wx.showToast({ title: '请填写顾客本次消费总额（券前金额）', icon: 'none' }); return; }
    if (!coupon) { this.lookup(); wx.showToast({ title: '正在识别券，请稍后再点', icon: 'none' }); return; }
    if (!usable) { wx.showToast({ title: '该券不可核销', icon: 'none' }); return; }
    if (this.data.preview && this.data.preview.belowMin) {
      wx.showToast({ title: '未达到最低消费 ' + this.data.preview.minYuan + ' 元', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    api.post('/api/merchant/coupons/redeem', { code, amountFen: Math.round(yuan * 100) })
      .then((r) => {
        // 次卡还有剩余次数：保留券码并刷新券面（商家可连续核销）；用完/单次券则清空
        const hasLeft = (Number(r.remainingTimes) || 0) > 0;
        this.setData({
          result: {
            ok: true,
            amountYuan: api.fen2yuan(r.alliance.amountFen),
            discountYuan: api.fen2yuan(r.discountFen || 0),
            payableYuan: api.fen2yuan(r.payableFen || 0),
            couponFee: api.fen2yuan(r.couponFeeFen),
            verifyFee: api.fen2yuan(r.verifyFeeFen),
            totalFee: api.fen2yuan(r.grossFeeFen),
            timesText: (Number(r.totalTimes) || 1) > 1
              ? ('本次是第 ' + (r.claim.usedTimes || 0) + '/' + r.totalTimes + ' 次'
                + (hasLeft ? '，剩余 ' + r.remainingTimes + ' 次，可继续核销' : '，次数已用完'))
              : '',
          },
          amount: '',
          // 还有剩余次数：券码与券面保留，只清金额，方便连续核销
          ...(hasLeft ? {} : { code: '', coupon: null, usable: false, preview: null, noCoupon: false }),
        });
        wx.showToast({ title: hasLeft ? ('核销成功，剩 ' + r.remainingTimes + ' 次') : '核销成功', icon: 'none' });
        if (hasLeft) this.lookup();
      })
      .catch((e) => this.setData({ result: { ok: false, msg: e.message } }))
      .then(() => this.setData({ submitting: false }));
  },
});
