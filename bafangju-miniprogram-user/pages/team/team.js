// 我的团队：直推成员汇总 + 等级/有效人数（等级只作权益资格，不作计酬依据）
const api = require('../../utils/api');
const content = require('../../utils/content');
const app = getApp();

Page({
  data: { members: [], level: null, loading: true, ct: {} },
  onShow() {
    if (!app.globalData.userId) { setTimeout(() => this.onShow(), 600); return; }
    content.ready().then(() => this.applyContent());
    Promise.all([
      api.get('/api/user/promotion/team?userId=' + app.globalData.userId),
      api.get('/api/user/level').catch(() => null),
    ]).then(([list, level]) => {
      this.setData({
        members: (list || []).map((m, i) => ({ ...m, idx: i + 1 })),
        level: level || null,
        loading: false,
      });
    }).catch(() => this.setData({ loading: false }));
  },
  // 后台配置了就用后台文案，未配置保留内置文案
  applyContent() {
    this.setData({ ct: content.pick(['team.note']) });
  },
});
