Component({
  data: {
    selected: 0,
    list: [
      { pagePath: "pages/index/index", text: "工作台", icon: "workbench" },
      { pagePath: "pages/verify/verify", text: "核销", icon: "verify" },
      { pagePath: "pages/earnings/earnings", text: "收益", icon: "earnings" },
      { pagePath: "pages/profile/profile", text: "我的", icon: "me" }
    ],
  },
  methods: {
    switchTab(e) {
      const { path, index } = e.currentTarget.dataset;
      if (index === this.data.selected) return;
      wx.switchTab({ url: '/' + path });
      this.setData({ selected: index });
    },
  },
});
