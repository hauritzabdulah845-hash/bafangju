const content = require('../utils/content');

const DEFAULT_LIST = [
  { pagePath: 'pages/index/index', text: '首页', icon: 'home' },
  { pagePath: 'pages/orders/orders', text: '订单', icon: 'order' },
  { pagePath: 'pages/ads/ads', text: '赚实惠', icon: 'ad' },
  { pagePath: 'pages/returns/returns', text: '阶梯优惠', icon: 'ladder' },
  { pagePath: 'pages/profile/profile', text: '我的', icon: 'me' },
];

function cloneDefaultList() {
  return DEFAULT_LIST.map((item) => Object.assign({}, item));
}

function parseConfiguredList(raw) {
  let items;
  try {
    items = JSON.parse(raw);
  } catch (e) {
    return null;
  }
  if (!Array.isArray(items) || items.length < 2 || items.length > 5) return null;

  const usedPaths = new Set();
  const list = [];
  for (const item of items) {
    const base = item && DEFAULT_LIST.find((candidate) => candidate.pagePath === item.pagePath);
    if (!base
      || usedPaths.has(item.pagePath)
      || typeof item.text !== 'string'
      || !item.text.trim()
      || Array.from(item.text).length > 5) return null;
    usedPaths.add(item.pagePath);
    list.push(Object.assign({}, base, { text: item.text }));
  }
  return list;
}

Component({
  data: {
    selected: 0,
    list: cloneDefaultList(),
  },
  lifetimes: {
    attached() {
      content.ready().then(() => this.applyContent()).catch(() => this.applyContent());
    },
  },
  pageLifetimes: {
    show() {
      this.syncSelected();
    },
  },
  methods: {
    applyContent() {
      const list = parseConfiguredList(content.text('tabbar.items')) || cloneDefaultList();
      this.setData({ list }, () => this.syncSelected());
    },
    syncSelected() {
      const pages = getCurrentPages();
      const current = pages[pages.length - 1];
      const route = current && (current.route || current.__route__);
      const selected = this.data.list.findIndex((item) => item.pagePath === route);
      if (selected !== this.data.selected) this.setData({ selected });
    },
    switchTab(e) {
      const { path, index } = e.currentTarget.dataset;
      if (index === this.data.selected) return;
      wx.switchTab({ url: '/' + path });
      this.setData({ selected: index });
    },
  },
});
