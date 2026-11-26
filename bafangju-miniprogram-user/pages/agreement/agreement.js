// 隐私政策与用户协议
// 合规要点：如实披露收集的信息范围与用途；分红/阶梯优惠表述不使用"返利/保本/全额返"话术。
// 文案改为「后台可配 + 内置兜底」：后台配了整篇文本就按段渲染，未配置继续用内置结构化条款。
const content = require('../../utils/content');

Page({
  data: {
    tab: 'privacy', // privacy | terms
    updatedAt: '2026-10-28',
    ct: {},
    privacySections: [], // 后台配置的隐私政策（按行分段）
    termsSections: [],   // 后台配置的用户协议（按行分段）
  },
  onLoad(query) {
    const tab = query && query.type === 'terms' ? 'terms' : 'privacy';
    this.setData({ tab });
    wx.setNavigationBarTitle({ title: tab === 'terms' ? '用户协议' : '隐私政策' });
    content.ready().then(() => this.applyContent());
  },
  // 后台配置了就用后台的整篇文本（按行分段渲染），没配置保留内置条款
  applyContent() {
    const ct = content.pick(['agreement.privacy', 'agreement.terms', 'agreement.updatedAt']);
    const patch = { ct };
    const privacy = content.lines('agreement.privacy');
    const terms = content.lines('agreement.terms');
    if (privacy.length) patch.privacySections = privacy;
    if (terms.length) patch.termsSections = terms;
    this.setData(patch);
  },
  switchTab(e) {
    const tab = e.currentTarget.dataset.tab === 'terms' ? 'terms' : 'privacy';
    this.setData({ tab });
    wx.setNavigationBarTitle({ title: tab === 'terms' ? '用户协议' : '隐私政策' });
  },
});
