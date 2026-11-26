const api = require('../../utils/api');
const loc = require('../../utils/loc');
const env = require('../../utils/env');
const content = require('../../utils/content');
const L = require('../../utils/ladder');
const app = getApp();

Page({
  data: { categories: [], kingkong: [], products: [], allProducts: [], activeCat: '', keyword: '', downgrade: false, loadError: false, progressCard: null, ads: [], slides: [], slideIndex: 0, locName: '天河区', nearby: [], devMode: false, ct: {}, unreadMsg: 0, searchPh: '搜你想要的好物' },
  // 平台运营帧：无任何商家投放时由它们兜底，保证首屏轮播永不空窗
  // 三帧均为成品 banner（5:2，1120×448，文字已做进图）→ 不再给 title/sub/btn，避免与图上文字重叠
  OPS_SLIDES: [
    { key: 'ops-ladder', type: 'ops', tone: 1, action: 'returns',
      image: api.BASE_URL + '/img/products/banner_ladder.jpg' },
    { key: 'ops-invite', type: 'ops', tone: 2, action: 'promotion',
      image: api.BASE_URL + '/img/products/banner_invite.jpg' },
    { key: 'ops-nearby', type: 'ops', tone: 3, action: 'merchants',
      image: api.BASE_URL + '/img/products/banner_nearby.jpg' },
  ],
  // 金刚区定制图标（assets/icons 内置，AI 定制红金风格，本地优先于后端 iconImage 与线性 SVG）
  ICON_IMG: {
    grain: 1, veg: 1, drink: 1, food: 1, shop: 1, fun: 1,
    beauty: 1, health: 1, hotel: 1, baby: 1, clean: 1, home: 1, all: 1,
  },
  // emoji 兜底（附近商家头像等场景仍在用；金刚区已用定制图标）
  ICON_FALLBACK: [
    ['餐饮', '🍜'], ['甜品|茶|饮|奶茶', '🧋'], ['生鲜|果蔬|菜', '🥬'], ['超市|便利', '🛒'],
    ['休闲|玩|娱乐|KTV', '🎳'], ['丽人|美|理发', '💇'], ['健康|养生|按摩', '💆'],
    ['酒店|旅行|住宿', '🏨'], ['亲子|儿童|乐园', '🎠'], ['家政|保洁|维修', '🧹'],
    ['粮油|食品', '🌾'], ['百货|家居', '🛍️'],
  ],
  onLoad(options) {
    // 调试入口仅开发环境可见（正式版不暴露诊断按钮与后端地址）
    this.setData({ devMode: env.isDev() });
    // 推广链路：好友分享/扫码进入携带 inviter → 登录完成后绑定直推关系（一次性，不可更改）
    if (options && options.inviter) {
      this.pendingInviter = options.inviter;
      this.tryBind();
    }
  },
  tryBind() {
    const userId = app.globalData.userId;
    if (!userId || !this.pendingInviter) {
      // 只允许存在一条重试定时链（onLoad/onShow 都会调进来），避免并发双请求
      if (this.pendingInviter && !this._bindTimer) {
        this._bindTimer = setTimeout(() => { this._bindTimer = null; this.tryBind(); }, 800);
      }
      return;
    }
    api.post('/api/user/bind-referral', { userId, inviterUserId: this.pendingInviter })
      .then(() => wx.showToast({ title: '已接受好友邀请', icon: 'success' }))
      .catch(() => {}); // 已绑定/自邀等场景静默
    this.pendingInviter = '';
  },
  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().setData({ selected: 0 });
    this.setData({ downgrade: app.globalData.downgrade });
    this.load();
    this.loadUnread();
    if (this.pendingInviter) this.tryBind();
    // 恢复上次选点的位置（globalData → storage 兜底，重启小程序不丢）
    const savedLoc = loc.current(app);
    app.globalData.loc = savedLoc;
    this.cur = savedLoc;
    this.setData({ locName: savedLoc.name });
    content.ready().then(() => this.applyContent());
  },
  // 后台配置了就用后台文案，未配置保留内置文案
  applyContent() {
    this.setData({ ct: content.pick(['home.notice', 'home.dividend']) });
  },
  // 点击首页定位：调起微信内置地图选点（免 key），返回后解析区县显示
  pickLocation() {
    loc.pick(app, (l) => {
      this.cur = l;
      this.setData({ locName: l.name });
      this.loadNearby(); // 附近商家按新位置刷新
    });
  },
  // 转发好友时携带邀请码，建立直推关系
  onShareAppMessage() {
    if (app.globalData.downgrade || !app.globalData.userId) {
      return { title: '八方聚共享平台 · 阶梯优惠商城', path: '/pages/index/index' };
    }
    return {
      title: '八方聚共享平台 · 阶梯优惠商城',
      path: '/pages/index/index?inviter=' + app.globalData.userId,
    };
  },
  load() {
    api.get('/api/home').then((d) => {
      const categories = (d.categories || []).map((c) => {
        const k = this.matchIconKey(c.name); // 金刚区图标 key（也用于选内置定制图）
        return {
          ...c,
          icon: c.icon || this.matchIcon(c.name),
          ic: k, // 线性 SVG class（定制图加载失败时的兜底仍在 wxml 下层）
          iconImg: this.ICON_IMG[k]
            ? '/assets/icons/cat-' + k + '.png' // 内置定制图标：本地包内，最高优先
            : (c.iconImage ? api.BASE_URL + c.iconImage : ''), // 后端配置图仅对无定制图的类目兜底
        };
      });
      // 金刚区：类目最多 10 个（5 列 2 行）。
      // 「做任务」已归入底部「赚实惠」tab 的分段，首屏这一格还给真实类目，避免导航重复。
      const kingkong = categories.slice(0, 10).map((c, i) => ({ ...c, bg: (i % 3) + 1 }));
      // 轮播帧：付费商家广告优先展示，平台运营帧兜底（广告在前，不空窗）
      const ads = (d.banner || []).map((a) => ({ ...a, fullImage: a.imageUrl ? api.BASE_URL + a.imageUrl : '' }));
      const opsSlides = d.opsSlides || [];
      const slides = this.buildSlides(ads, opsSlides);
      this.setData({ categories, kingkong, downgrade: !!d.downgrade, ads, opsSlides, slides, slideIndex: 0 });
      app.globalData.downgrade = !!d.downgrade;
      this.reportSlide(0);
    }).catch((e) => {
      // 原始错误只进控制台，界面显示统一文案（不暴露后端地址与内部细节）
      console.error('[index] 首页数据加载失败 → ' + String((e && e.message) || '未知错误'));
      wx.showToast({ title: '首页数据加载失败，请稍后重试', icon: 'none', duration: 3500 });
    });
    this.loadProducts('');
    this.loadNearby();
  },
  // 附近商家（首页横向预览）：失败静默，不影响主页其它内容
  loadNearby() {
    const cur = loc.current(app);
    api.get('/api/merchants/nearby?lat=' + cur.lat + '&lng=' + cur.lng + '&radius=5000')
      .then((r) => {
        const list = (r.merchants || []).slice(0, 8).map((m) => ({ ...m, icon: this.merchantIcon(m.category) }));
        this.setData({ nearby: list });
      })
      .catch(() => {});
  },
  // 类目名 → 金刚区线性图标 key（与 index.wxss 的 .ic-* 一一对应）
  matchIconKey(name) {
    const n = name || '';
    const rules = [
      ['粮油|食品|米|面|食用油', 'grain'],
      ['生鲜|果蔬|蔬菜|水果', 'veg'],
      ['甜点|饮品|奶茶|咖啡|茶饮', 'drink'],
      ['餐饮|美食|快餐|小吃', 'food'],
      ['超市|便利|商店|便利蜂', 'shop'],
      ['休闲|玩乐|娱乐|棋牌|KTV', 'fun'],
      ['丽人|美发|美容|理发', 'beauty'],
      ['健康|养生|药|理疗', 'health'],
      ['酒店|旅行|住宿|民宿', 'hotel'],
      ['亲子|儿童|乐园|母婴', 'baby'],
      ['家政|保洁|维修|洗衣', 'clean'],
      ['百货|家居|家装|日用', 'home'],
    ];
    for (let i = 0; i < rules.length; i++) {
      if (rules[i][0].split('|').some((k) => n.indexOf(k) > -1)) return rules[i][1];
    }
    return 'all';
  },
  // 经营类目 → 门店头像图标（复用金刚区定制红金图标，与附近商家页一致）
  merchantIcon(category) {
    const map = {
      餐饮美食: '/assets/icons/cat-food.png', 甜点饮品: '/assets/icons/cat-drink.png', 生鲜果蔬: '/assets/icons/cat-veg.png',
      超市便利: '/assets/icons/cat-shop.png', 休闲玩乐: '/assets/icons/cat-fun.png', 丽人美发: '/assets/icons/cat-beauty.png',
      健康养生: '/assets/icons/cat-health.png', 酒店旅行: '/assets/icons/cat-hotel.png', 亲子乐园: '/assets/icons/cat-baby.png',
      家政服务: '/assets/icons/cat-clean.png', 粮油食品: '/assets/icons/cat-grain.png', 百货家居: '/assets/icons/cat-home.png',
    };
    return map[category] || '/assets/icons/cat-shop.png';
  },
  // 轮播帧组装：付费商家广告在前（曝光优先），平台运营帧兜底
  // 运营帧优先取后台配置（/api/home 下发），后台未配置时用内置 3 条兜底，保证首屏永不空窗
  buildSlides(ads, opsSlides) {
    const adSlides = (ads || []).map((a) => ({
      key: 'ad-' + a.bookingId, type: 'ad', bookingId: a.bookingId,
      image: a.fullImage || '', merchantName: a.merchantName || '',
      // 有素材图时不叠文字，避免与商家设计稿上的字重复；无图时才用渐变底 + 标题
      title: a.fullImage ? '' : (a.title || ''),
      btn: a.fullImage ? '' : '立即查看',
      tone: 4,
    }));
    // 后台运营帧：有标题（渐变底叠字）或有图（成品 banner）都算有效帧；两者都空视为未配置
    const cfg = (opsSlides || []).filter((s) => s && (s.title || s.imageUrl));
    const ops = (cfg.length ? cfg : this.OPS_SLIDES).map((s) => ({
      ...s,
      type: 'ops',
      key: s.key || ('ops-' + (s.id || s.title)),
      image: s.imageUrl ? api.BASE_URL + s.imageUrl : (s.image || ''),
    }));
    return adSlides.concat(ops);
  },
  onSlideChange(e) {
    const i = (e.detail && e.detail.current) || 0;
    this.setData({ slideIndex: i });
    this.reportSlide(i); // 切到哪一帧，哪一帧才计曝光
  },
  // 曝光上报：仅广告帧；服务端按「投放 × 用户 × 天」去重，重复上报不会重复计费
  reportSlide(index) {
    const s = (this.data.slides || [])[index];
    if (!s || s.type !== 'ad') return;
    api.post('/api/ads/impression', { bookingId: s.bookingId, userId: app.globalData.userId }).catch(() => {});
  },
  // 点击：广告帧先上报再由服务端返回跳转目标；运营帧走内置动作
  onSlideTap(e) {
    const s = (this.data.slides || [])[Number(e.currentTarget.dataset.index) || 0];
    if (!s) return;
    if (s.type === 'ad') {
      api.post('/api/ads/click', { bookingId: s.bookingId, userId: app.globalData.userId })
        .then((r) => {
          if (r && r.targetType === 'product' && r.targetId) {
            wx.navigateTo({ url: '/pages/product/product?id=' + r.targetId });
          } else if (r && r.targetType === 'merchant' && r.targetId) {
            wx.navigateTo({ url: '/pages/merchant-detail/merchant-detail?id=' + r.targetId });
          }
        })
        .catch(() => {});
      return;
    }
    this.runOpsAction(s.action);
  },
  runOpsAction(action) {
    if (action === 'returns') wx.switchTab({ url: '/pages/returns/returns' });
    else if (action === 'promotion') wx.navigateTo({ url: '/pages/promotion/promotion' });
    else if (action === 'merchants') wx.navigateTo({ url: '/pages/merchants/merchants' });
    else if (action === 'rules') wx.navigateTo({ url: '/pages/rules/rules' });
  },
  matchIcon(name) {
    for (const [kw, icon] of this.ICON_FALLBACK) {
      if (kw.split('|').some((k) => name.includes(k))) return icon;
    }
    return '🎁';
  },
  loadProducts(catId) {
    const userId = app.globalData.userId;
    // 参数统一收集后 join，避免 catId 为空时拼出 "/api/products&userId=x"（无 ? 导致 404）
    const params = [];
    if (catId) params.push('categoryId=' + encodeURIComponent(catId));
    if (userId) params.push('userId=' + encodeURIComponent(userId));
    const query = params.length ? '?' + params.join('&') : '';
    api.get('/api/products' + query)
      .then((list) => {
        this.setData({ allProducts: list || [], loadError: false });
        this.applyFilter(list || []); // 直接传数据，避免 setData 异步导致的读取竞态
        this.deriveProgress(list || []);
        // 搜索占位词：取当前在售「下一单实付最低」的商品做引流词，保证搜它一定有结果；
        // 仅在未选类目（全量列表）时刷新，避免切换类目后占位词指向别的类目的商品
        if (!catId && list && list.length) {
          const cheapest = list.slice().sort((a, b) => (a.nextPayFen || a.priceFen) - (b.nextPayFen || b.priceFen))[0];
          this.setData({ searchPh: '搜 ' + cheapest.name + ' ' + api.fen2yuan(cheapest.nextPayFen) + ' 元' });
        }
      })
      .catch((e) => {
        // 后端未启动/地址不通时明确提示，而不是误显示"暂无商品"。
        // loadError 只存「是否失败」标记，界面文案固定为用户可读提示，不透出原始错误与地址。
        this.setData({ products: [], allProducts: [], loadError: true });
        console.error('[index] 商品列表加载失败 → ' + String((e && e.message) || '未知错误'));
        wx.showToast({ title: '加载失败，请稍后重试', icon: 'none', duration: 3000 });
      });
  },
  // 网络诊断：绕过封装直发一次请求，把目标 URL 与真实结果（状态码/原始错误）原样弹出。
  // 仅开发环境可用：正式版隐藏入口且方法内部直接返回，避免向终端用户暴露后端地址。
  diagnose() {
    if (!env.isDev()) return;
    const url = api.BASE_URL + '/api/home';
    wx.showLoading({ title: '诊断中…', mask: true });
    wx.request({
      url,
      method: 'GET',
      timeout: 8000,
      success: (res) => {
        wx.hideLoading();
        const preview = typeof res.data === 'string'
          ? res.data.slice(0, 120)
          : JSON.stringify(res.data).slice(0, 120);
        wx.showModal({
          title: '诊断结果',
          content: '目标：' + url + '\n状态码：HTTP ' + res.statusCode + '\n返回：' + preview,
          confirmText: '复制',
          success: (r) => { if (r.confirm) wx.setClipboardData({ data: url + ' → HTTP ' + res.statusCode }); },
        });
      },
      fail: (err) => {
        wx.hideLoading();
        wx.showModal({
          title: '诊断结果',
          content: '目标：' + url + '\n结果：请求失败\n原始错误：' + (err.errMsg || '未知'),
          confirmText: '复制',
          success: (r) => { if (r.confirm) wx.setClipboardData({ data: url + ' → ' + (err.errMsg || '未知') }); },
        });
      },
    });
  },
  // 商品装饰：价格换算 + 整数/小数拆分（价格层级排版）+ 色块轮换 + 已购件数兜底 + 商品图 URL 拼接
  decorate(list) {
    return list.map((p, i) => {
      const yuan = api.fen2yuan(p.nextPayFen);
      const dot = String(yuan).indexOf('.');
      return {
        ...p, nextPayYuan: yuan, priceYuan: api.fen2yuan(p.priceFen),
        priceInt: dot > -1 ? String(yuan).slice(0, dot) : String(yuan),
        priceDec: dot > -1 ? String(yuan).slice(dot + 1) : '',
        tone: (i % 6) + 1, soldCount: p.soldCount || 0,
        soldText: (p.soldCount || 0) >= 10000
          ? ((p.soldCount / 10000).toFixed(1) + ' 万件')
          : ((p.soldCount || 0) + ' 件'),
        img: p.imageUrl ? api.BASE_URL + p.imageUrl : '',
      };
    });
  },
  // 拼多多式顶部搜索：按商品名本地过滤（与类目筛选叠加）
  onSearch(e) { this.setData({ keyword: e.detail.value }); this.applyFilter(); },
  clearSearch() { this.setData({ keyword: '' }); this.applyFilter(); },
  applyFilter(src) {
    const kw = (this.data.keyword || '').trim().toLowerCase();
    const base = src || this.data.allProducts || [];
    const list = kw ? base.filter((p) => (p.name || '').toLowerCase().includes(kw)) : base;
    this.setData({ products: this.decorate(list) });
  },
  onCat(e) {
    const id = e.currentTarget.dataset.id;
    const cat = (this.data.categories || []).find((c) => c.id === id);
    this.setData({ activeCat: id, activeCatName: id ? (cat ? cat.name : '') : '' });
    this.loadProducts(id);
  },
  clearCat() {
    this.setData({ activeCat: '', activeCatName: '' });
    this.loadProducts('');
  },
  goKingkong(e) {
    const id = e.currentTarget.dataset.id;
    // 点金刚区 = 选中该类目并滚动查看商品（与推荐区联动）
    const cat = (this.data.categories || []).find((c) => c.id === id);
    this.setData({ activeCat: id, activeCatName: cat ? cat.name : '' });
    this.loadProducts(id);
    wx.pageScrollTo({ selector: '#goods-sec', duration: 300 });
  },
  // 头部铃铛 → 消息中心
  goMessages() { wx.navigateTo({ url: '/pages/messages/messages' }); },
  // 消息未读角标：onShow 时静默刷新；未登录/请求失败都按 0 处理，不影响主页
  loadUnread() {
    if (!app.globalData.userId) { this.setData({ unreadMsg: 0 }); return; }
    api.get('/api/messages')
      .then((r) => this.setData({ unreadMsg: Number(r && r.unread) || 0 }))
      .catch(() => {});
  },
  // 复购进度卡：取当前列表进度最深的商品，展示真实步位/下一单实付 + 阶梯 chip（窗口最多 5 格，超出资历用省略格）
  // 仅对「已经买过」（myStep>1）的用户展示；第一单都没买的用户没有进度可言，
  // 由头部下方的营销条负责讲机制，避免首屏同一机制重复三遍。
  deriveProgress(list) {
    const cats = this.data.categories || [];
    const top = (list || []).slice().sort((a, b) => (b.myStep || 1) - (a.myStep || 1))[0];
    if (!top || (top.myStep || 1) <= 1) { this.setData({ progressCard: null }); return; }
    const cat = cats.find((c) => c.id === top.categoryId);
    const step = top.myStep || 1;
    const n = top.n || 6;
    const total = top.total || (n + 4);
    const priceFen = top.priceFen;
    // chip 的窗口切片与四态统一由 utils/ladder.js 生成（返还页共用同一套，避免两页口径漂移）
    const steps = L.chipWindow(L.buildLadder(priceFen, n), step, n, total);
    const savedFen = priceFen - top.nextPayFen;
    this.setData({
      progressCard: {
        catName: cat ? cat.name : '我的优惠',
        myStep: step,
        n,
        total,
        left: Math.max(0, total - step),
        hint: L.stageHint(step, n),
        nextPayYuan: api.fen2yuan(top.nextPayFen),
        priceYuan: api.fen2yuan(top.priceFen),
        savedYuan: savedFen > 0 ? api.fen2yuan(savedFen) : '',
        steps,
      },
    });
  },
  // Banner「查看我的阶梯」→ 阶梯优惠 tab 页
  goReturns() { wx.switchTab({ url: '/pages/returns/returns' }); },
  // 进度卡「去复购」→ 滚动到推荐商品区
  goGrid() { wx.pageScrollTo({ selector: '#goods-sec', duration: 300 }); },
  goProduct(e) {
    wx.navigateTo({ url: '/pages/product/product?id=' + e.currentTarget.dataset.id });
  },
  // 附近商家：区块「查看全部」→ 列表页；点头像 → 店铺详情
  goMerchants() { wx.navigateTo({ url: '/pages/merchants/merchants' }); },
  goMerchantDetail(e) { wx.navigateTo({ url: '/pages/merchant-detail/merchant-detail?id=' + e.currentTarget.dataset.id }); },
});
