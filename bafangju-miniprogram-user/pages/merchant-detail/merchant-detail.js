// 商家详情（附近商家 → 进店）：门店信息 + 导航/致电 + 领券 + 在售商品
const api = require('../../utils/api');
const loc = require('../../utils/loc');
const app = getApp();

const CAT_ICON = {
  餐饮美食: '/assets/icons/cat-food.png', 甜点饮品: '/assets/icons/cat-drink.png', 生鲜果蔬: '/assets/icons/cat-veg.png',
  超市便利: '/assets/icons/cat-shop.png', 休闲玩乐: '/assets/icons/cat-fun.png', 丽人美发: '/assets/icons/cat-beauty.png',
  健康养生: '/assets/icons/cat-health.png', 酒店旅行: '/assets/icons/cat-hotel.png', 亲子乐园: '/assets/icons/cat-baby.png',
  家政服务: '/assets/icons/cat-clean.png', 粮油食品: '/assets/icons/cat-grain.png', 百货家居: '/assets/icons/cat-home.png',
};

Page({
  data: {
    merchant: null,
    coverImg: '',
    icon: '/assets/icons/cat-shop.png',
    coupons: [],
    products: [],
    loading: true,
    loadError: false,
  },

  onLoad(options) { this.id = options.id || ''; },
  onShow() {
    this.cur = loc.current(app);
    this.load();
  },

  load() {
    this.setData({ loading: true });
    return api.get('/api/merchants/' + this.id + '?lat=' + this.cur.lat + '&lng=' + this.cur.lng)
      .then((r) => {
        // 标题用真实店名，用户从列表进店后能确认没点错
        if (r.merchant && r.merchant.name) wx.setNavigationBarTitle({ title: r.merchant.name });
        this.setData({
          merchant: r.merchant,
          // 商家自己上传的门头照优先展示（用户判断"这是不是那家店"的第一依据）
          coverImg: r.merchant.coverUrl ? api.BASE_URL + r.merchant.coverUrl : '',
          icon: CAT_ICON[r.merchant.category] || '/assets/icons/cat-shop.png',
          coupons: r.coupons || [],
          products: (r.products || []).map((p, i) => ({
            ...p,
            img: p.imageUrl ? api.BASE_URL + p.imageUrl : '',
            tone: (i % 6) + 1,
          })),
          loadError: false,
        });
      })
      .catch((e) => {
        // 原始错误只进控制台，界面文案固定为用户可读提示（不暴露后端地址）
        console.error('[merchant-detail] 商家详情加载失败 → ' + String((e && e.message) || '未知错误'));
        this.setData({ loadError: true });
      })
      .finally(() => this.setData({ loading: false }));
  },

  // 门头照看大图（用户到店前核对门面）
  previewCover() {
    if (!this.data.coverImg) return;
    wx.previewImage({ urls: [this.data.coverImg], current: this.data.coverImg });
  },

  // 导航：微信内置地图打开门店坐标（免 key）
  navigate() {
    const m = this.data.merchant;
    if (!m || !Number.isFinite(m.lat)) return;
    wx.openLocation({
      latitude: m.lat, longitude: m.lng,
      name: m.name, address: m.address, scale: 18,
    });
  },
  // 联系商家：拨号（商家入驻电话）
  call() {
    const m = this.data.merchant;
    if (!m || !m.phone) return;
    wx.makePhoneCall({ phoneNumber: m.phone });
  },

  // 领券：未登录时请求层会自动静默登录后重试
  claim(e) {
    const id = e.currentTarget.dataset.id;
    api.post('/api/coupons/claim', { couponId: id })
      .then(() => {
        wx.showToast({ title: '领取成功，到店出示消费码', icon: 'none', duration: 2500 });
        this.load();
      })
      .catch((err) => wx.showToast({ title: err.message, icon: 'none' }));
  },

  goProduct(e) {
    wx.navigateTo({ url: '/pages/product/product?id=' + e.currentTarget.dataset.id });
  },
  goMyCoupons() { wx.navigateTo({ url: '/pages/coupons/coupons' }); },
});
