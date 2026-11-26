// 附近商家（异业联盟 · 本地生活）：
// 定位（内置地图选点）→ 半径/排序/关键词筛选 → 商家列表 → 进店领券 / 导航到店
const api = require('../../utils/api');
const loc = require('../../utils/loc');
const content = require('../../utils/content');
const app = getApp();

const RADIUS_OPTS = [
  { label: '1km', value: 1000 },
  { label: '3km', value: 3000 },
  { label: '5km', value: 5000 },
  { label: '10km', value: 10000 },
];

// 经营类目 → 门店头像图标（复用首页金刚区 AI 定制红金图标，未知类目兜底 cat-shop）
const CAT_ICON = {
  餐饮美食: '/assets/icons/cat-food.png', 甜点饮品: '/assets/icons/cat-drink.png', 生鲜果蔬: '/assets/icons/cat-veg.png',
  超市便利: '/assets/icons/cat-shop.png', 休闲玩乐: '/assets/icons/cat-fun.png', 丽人美发: '/assets/icons/cat-beauty.png',
  健康养生: '/assets/icons/cat-health.png', 酒店旅行: '/assets/icons/cat-hotel.png', 亲子乐园: '/assets/icons/cat-baby.png',
  家政服务: '/assets/icons/cat-clean.png', 粮油食品: '/assets/icons/cat-grain.png', 百货家居: '/assets/icons/cat-home.png',
};

Page({
  data: {
    locName: '天河区',
    radiusOpts: RADIUS_OPTS,
    radius: 5000,
    sort: 'distance', // distance 距离最近 | coupon 优惠最多
    keyword: '',
    merchants: [],
    total: 0,
    loading: true,
    loadError: false,
    ct: {},
  },

  onLoad() {
    this.cur = loc.current(app);
    this.setData({ locName: this.cur.name });
  },
  onShow() {
    this.cur = loc.current(app);
    this.setData({ locName: this.cur.name });
    this.load();
    content.ready().then(() => this.applyContent());
  },
  // 后台配置了就用后台文案，未配置保留内置文案
  applyContent() {
    this.setData({ ct: content.pick(['merchants.note']) });
  },
  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  // 顶部定位：选点后按新位置重查
  pickLocation() {
    loc.pick(app, (l) => {
      this.cur = l;
      this.setData({ locName: l.name });
      this.load();
    });
  },

  // 搜索：本地防抖 300ms，避免逐字狂发请求
  onSearch(e) {
    this.setData({ keyword: e.detail.value });
    clearTimeout(this._st);
    this._st = setTimeout(() => this.load(), 300);
  },
  clearSearch() { this.setData({ keyword: '' }); this.load(); },

  onRadius(e) {
    const v = Number(e.currentTarget.dataset.v);
    this.setData({ radius: v });
    this.load();
  },
  onSort(e) {
    this.setData({ sort: e.currentTarget.dataset.v });
    this.applySort();
  },

  load() {
    this.setData({ loading: true });
    const params = [];
    params.push('lat=' + this.cur.lat);
    params.push('lng=' + this.cur.lng);
    params.push('radius=' + this.data.radius);
    if (this.data.keyword.trim()) params.push('keyword=' + encodeURIComponent(this.data.keyword.trim()));
    return api.get('/api/merchants/nearby?' + params.join('&'))
      .then((r) => {
        this.raw = r.merchants || [];
        this.setData({ total: r.total || 0, loadError: false });
        this.applySort();
      })
      .catch((e) => {
        // 原始错误只进控制台，界面文案固定为用户可读提示（不暴露后端地址）
        console.error('[merchants] 附近商家加载失败 → ' + String((e && e.message) || '未知错误'));
        this.setData({ merchants: [], total: 0, loadError: true });
      })
      .finally(() => this.setData({ loading: false }));
  },

  // 排序在前端做（列表量小）：优惠最多 = 券数降序 → 距离升序
  applySort() {
    const list = (this.raw || []).slice();
    if (this.data.sort === 'coupon') {
      list.sort((a, b) => (b.couponCount - a.couponCount) || (a.distanceM - b.distanceM));
    }
    this.setData({
      merchants: list.map((m) => ({
        ...m,
        icon: CAT_ICON[m.category] || '🏪',
        // 商家自传门头照优先（真实门面比分类图标更能促成到店）
        coverImg: m.coverUrl ? api.BASE_URL + m.coverUrl : '',
        // 底部摘要：有券显示可领数，无券明确说"暂无"；有在售商品则追加
        metaText: [
          m.couponCount ? `${m.couponCount} 张券可领` : '暂无可领券',
          m.productCount ? `${m.productCount} 件在售商品` : '',
        ].filter(Boolean).join(' · '),
      })),
    });
  },

  // 空态一键扩大半径到 10km（常见诉求：附近刚好没有店）
  expandRadius() {
    this.setData({ radius: 10000 });
    this.load();
  },

  goDetail(e) {
    wx.navigateTo({ url: '/pages/merchant-detail/merchant-detail?id=' + e.currentTarget.dataset.id });
  },
});
