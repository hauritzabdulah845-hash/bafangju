// 八方聚共享平台 - 用户端小程序（V3.9）
// 合规要点：
// 1. 阶梯价内嵌于售价，页面表述为"阶梯优惠/尾段让利"，禁用"返利/保本/全额返/排队返利"话术；
// 2. 审核降级开关（auditDowngrade）生效时隐藏"我的分红/我的团队"入口，规则页降级；
// 3. 贡献分单位参考价值仅作公示展示，无任何兑付/兑换入口。
// 4. 单小程序双角色（V4.0）：商家端以分包 subpkg-merchant 并入本小程序，
//    商家身份为独立账号体系（merchant_token），与用户微信身份互不干扰、可并存。
const api = require('./utils/api');

App({
  globalData: {
    userId: '',
    nickname: '',
    avatarUrl: '',
    switches: {},
    downgrade: false,
    rulesVersion: '', // 规则版本（下单前确认用，V3.3 §5.2-1）
    // 商家工作台（分包 subpkg-merchant）：登录态存 storage，App 层只做启动恢复
    merchantId: null,
    merchantName: null,
  },
  onLaunch() {
    this.login();
    // 商家身份恢复：老板既是顾客也是商家，两套登录态并存互不覆盖
    const savedMerchantId = wx.getStorageSync('merchantId');
    if (savedMerchantId) {
      this.globalData.merchantId = savedMerchantId;
      this.globalData.merchantName = wx.getStorageSync('merchantName');
    }
  },
  login() {
    const cached = wx.getStorageSync('userId');
    const cachedToken = wx.getStorageSync('userToken');
    if (cached && cachedToken) {
      this.globalData.userId = cached;
      this.globalData.token = cachedToken;
      this.globalData.avatarUrl = wx.getStorageSync('avatarUrl') || '';
      this.loadConfig();
      this.loadProfile();
      return;
    }
    this.doLogin();
  },
  /**
   * 登录（V3.9）：
   * - 生产：wx.login code → 服务端 code2session，按 openid 幂等建档；
   * - 开发态（未配 WX_APPID）：服务端按 deviceId 派生稳定 openid，同一设备重复登录不重复建号；
   * - wx.login 失败时降级为 deviceId 登录（生产会被服务端拒绝并提示失败）。
   */
  doLogin(cb) {
    const finish = (data) => {
      this.globalData.userId = data.userId;
      this.globalData.nickname = data.nickname;
      // 头像服务端存相对路径，展示需拼 BASE_URL；无头像时留空走默认圆形占位
      this.globalData.avatarUrl = data.avatarUrl ? api.BASE_URL + data.avatarUrl : (wx.getStorageSync('avatarUrl') || '');
      this.globalData.token = data.token;
      wx.setStorageSync('userId', data.userId);
      wx.setStorageSync('userToken', data.token);
      this.loadConfig();
      cb && cb(true);
    };
    const fail = () => {
      wx.showToast({ title: '登录失败，请稍后重试', icon: 'none' });
      cb && cb(false);
    };
    api.wxLogin()
      .then((code) => api.post('/api/user/login', {
        code,
        // 不传 nickname：昵称由服务端按 openid 派生，避免登录时覆盖用户已有昵称（P1-4）
        deviceId: api.deviceId(),
      }))
      .catch(() => api.post('/api/user/login', { deviceId: api.deviceId() }))
      .then(finish)
      .catch(fail);
  },
  /** 未登录/会话失效时静默重新登录（下单前调用，成功后执行回调） */
  ensureLogin(cb) {
    if (this.globalData.userId && this.globalData.token) { cb && cb(true); return; }
    this.doLogin(cb);
  },
  loadConfig() {
    api.get('/api/home').then((data) => {
      this.globalData.switches = data.switches || {};
      this.globalData.downgrade = !!data.downgrade;
      this.globalData.rulesVersion = data.rulesVersion || '';
    }).catch(() => {});
  },
  /** 拉取个人资料（昵称/头像）：有缓存会话时补齐 globalData，保证"我的"页重启后资料不丢 */
  loadProfile() {
    api.get('/api/user/profile').then((p) => {
      if (!p) return;
      if (p.nickname) this.globalData.nickname = p.nickname;
      this.globalData.avatarUrl = p.avatarUrl ? api.BASE_URL + p.avatarUrl : '';
    }).catch(() => {});
  },
});
