// 商家入驻申请：资质材料提交（名称/联系人/电话/类目/地址/营业执照+门头照），提交后等待平台人工审核
const api = require('../../utils/api');

const CATEGORIES = ['餐饮美食', '百货家居', '服饰鞋包', '生鲜果蔬', '美容美发', '休闲娱乐', '其他'];

/** 经纬度展示格式化：保留 4 位小数并去掉多余的 0（仅用于界面展示，提交仍用原始精度） */
function formatCoord(v) {
  const n = Number(v);
  if (!isFinite(n)) return '';
  return String(Number(n.toFixed(4)));
}

/** 服务端 ISO 时间 → 北京时间 YYYY-MM-DD HH:mm（与后台展示口径一致） */
function fmtTime(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  const b = new Date(d.getTime() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${b.getUTCFullYear()}-${p(b.getUTCMonth() + 1)}-${p(b.getUTCDate())} ${p(b.getUTCHours())}:${p(b.getUTCMinutes())}`;
}

Page({
  data: {
    categories: CATEGORIES,
    form: { name: '', contact: '', phone: '', category: '', address: '', remark: '', lat: null, lng: null, locText: '' },
    licenseImg: '',   // 营业执照预览（本地临时图）
    shopImg: '',      // 门头照预览（本地临时图）
    licenseImgUrl: '', // 营业执照服务端地址（提交用，私有目录）
    shopImgUrl: '',    // 门头照服务端地址（提交用，私有目录）
    submitting: false,
    agreed: false,
    isMember: false,  // 已入驻商家：展示只读资料；未登录访客：展示入驻申请表单
    loading: false,
    profile: null,
  },
  // 页面同时被「登录页 → 申请入驻」和「我的 → 入驻资料」复用，按登录态分流
  onLoad() {
    const app = getApp();
    let hasToken = false;
    try { hasToken = !!wx.getStorageSync('merchant_token'); } catch (e) { /* ignore */ }
    if ((app.globalData && app.globalData.merchantId) || hasToken) {
      this.setData({ isMember: true });
      wx.setNavigationBarTitle({ title: '入驻资料' });
      this.loadProfile();
    }
  },
  loadProfile() {
    this.setData({ loading: true });
    api.get('/api/merchant/profile')
      .then((p) => this.setData({ profile: this.decorate(p || {}), loading: false }))
      .catch((e) => {
        this.setData({ loading: false });
        wx.showToast({ title: (e && e.message) || '资料加载失败', icon: 'none' });
      });
  },
  /** 把接口数据整理成页面可直接渲染的展示文本，避免 WXML 里堆复杂表达式 */
  decorate(p) {
    const entry = p.entry || {};
    const located = p.lat !== null && p.lat !== undefined && p.lng !== null && p.lng !== undefined;
    return {
      ...p,
      name: p.name || '—', username: p.username || '—', id: p.id || '—',
      category: p.category || '—', address: p.address || '—',
      entryContact: entry.contact || p.contact || '—',
      entryPhone: entry.phone || '—',
      located,
      locatedText: located ? '已标注，可在附近商家展示' : '未标注（不进入附近商家）',
      statusText: p.status === 'active' ? '正常营业' : '已停用',
      entryStatusText: ({ approved: '已通过', pending_review: '审核中', rejected: '已驳回' })[entry.status] || '—',
      appliedAtText: fmtTime(entry.appliedAt),
      reviewedAtText: fmtTime(entry.reviewedAt),
      reviewReason: entry.reviewReason || '',
      licenseText: entry.licenseSubmitted ? '已提交 ✔' : '未提交',
      shopText: entry.shopSubmitted ? '已提交 ✔' : '未提交',
    };
  },
  refreshProfile() { this.loadProfile(); },
  goBack() {
    if (getCurrentPages().length > 1) wx.navigateBack({ delta: 1 });
    else wx.switchTab({ url: '/pages/profile/profile' });
  },
  input(e) {
    const k = e.currentTarget.dataset.k;
    this.setData({ [`form.${k}`]: e.detail.value });
  },
  pickCat(e) { this.setData({ 'form.category': e.currentTarget.dataset.c }); },
  toggleAgree() { this.setData({ agreed: !this.data.agreed }); },
  // 协议文字内链：catchtap 阻止冒泡（不触发勾选切换），跳转协议页对应 tab
  goAgreement(e) {
    const type = e.currentTarget.dataset.type === 'privacy' ? 'privacy' : 'terms';
    wx.navigateTo({ url: '/pages/agreement/agreement?type=' + type });
  },
  // 门店坐标：微信内置地图选点（免第三方 key）。
  // 选点后回填详细地址与经纬度 —— 这两个值是「附近商家」功能的数据源，
  // 不选点也能提交，但审核通过后将不会出现在用户的附近列表里。
  // 注意：form.lat / form.lng 始终保留选点返回的原始精度（提交给服务端需要真实精度），
  // form.locText 仅是给商家看的格式化展示文本。
  pickLocation() {
    wx.chooseLocation({
      success: (res) => {
        const name = res.name || '';
        const addr = res.address || '';
        this.setData({
          'form.lat': res.latitude,
          'form.lng': res.longitude,
          'form.locText': `${formatCoord(res.latitude)} , ${formatCoord(res.longitude)}`,
          // 地址为空或过于简略时，用 POI 名补全（用户选点常只有名字没有路名）
          'form.address': addr || name,
        });
        wx.showToast({ title: '门店位置已选定', icon: 'none' });
      },
    });
  },
  chooseLicense() { this.chooseAndUpload('licenseImg'); },
  chooseShop() { this.chooseAndUpload('shopImg'); },
  chooseAndUpload(key) {
    wx.chooseMedia({
      count: 1, mediaType: ['image'], sizeType: ['compressed'],
      success: (res) => {
        const path = res.tempFiles[0].tempFilePath;
        wx.getFileSystemManager().readFile({
          filePath: path, encoding: 'base64',
          success: (f) => {
            wx.showLoading({ title: '上传中' });
            // purpose=entry：证照存服务端私有目录，仅平台审核可见（P0-3）
            api.post('/api/upload', { dataBase64: f.data, ext: path.split('.').pop(), purpose: 'entry' })
              .then((r) => {
                wx.hideLoading();
                // 预览用本地临时图（服务端证照不公开），提交用服务端地址
                this.setData({ [key]: path, [key + 'Url']: r.url });
              })
              .catch((e) => { wx.hideLoading(); wx.showToast({ title: e.message, icon: 'none' }); });
          },
          fail: () => wx.showToast({ title: '读取图片失败', icon: 'none' }),
        });
      },
    });
  },
  submit() {
    const f = this.data.form;
    if (this.data.isMember) return; // 已入驻商家看只读资料，不允许再次提交入驻申请
    if (this.data.submitting) return;
    if (!this.data.agreed) return wx.showToast({ title: '请先同意入驻协议与平台规则', icon: 'none' });
    const payload = {
      ...f, licenseImgUrl: this.data.licenseImgUrl || '', shopImgUrl: this.data.shopImgUrl || '',
    };
    delete payload.locText; // 展示用格式化文本，不提交服务端（lat/lng 保持原始精度）
    const doSubmit = () => {
      this.setData({ submitting: true });
      api.post('/api/merchant-entry/apply', payload).then(() => {
        wx.showModal({
          title: '申请已提交', content: '资质审核通过后将获得商家账号，请留意平台通知。', showCancel: false,
          success: () => wx.reLaunch({ url: '/pages/login/login' }),
        });
      }).catch((e) => wx.showToast({ title: e.message, icon: 'none' }))
        .finally(() => this.setData({ submitting: false }));
    };
    // 未选点：仍可提交（部分服务类门店无固定门店），但明确告知后果
    if (f.lat === null || f.lng === null) {
      wx.showModal({
        title: '还未标注门店位置',
        content: '未选点的门店审核通过后不会出现在用户的「附近商家」列表中，建议先在地图上标注门店。是否仍要提交？',
        confirmText: '仍然提交', cancelText: '去选点',
        success: (r) => { if (r.confirm) doSubmit(); else this.pickLocation(); },
      });
      return;
    }
    doSubmit();
  },
});
