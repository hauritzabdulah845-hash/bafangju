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
    // 申请进度自助查询（申请人无登录态，名称+手机号双因子）
    showQuery: false,
    queryForm: { name: '', phone: '' },
    queryResult: null,
    querying: false,
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
    // 本地预校验：与后端规则一致，避免把明显错误打到服务端才报错（体验更快）
    if (!f.name || String(f.name).trim().length < 2) return wx.showToast({ title: '商家名称必填（至少 2 字）', icon: 'none' });
    if (!f.contact) return wx.showToast({ title: '联系人必填', icon: 'none' });
    if (!/^1\d{10}$/.test(String(f.phone || ''))) return wx.showToast({ title: '手机号格式不正确', icon: 'none' });
    if (!f.category) return wx.showToast({ title: '请选择经营类目', icon: 'none' });
    if (!f.address) return wx.showToast({ title: '门店地址必填', icon: 'none' });
    if (!this.data.licenseImgUrl) return wx.showToast({ title: '请上传营业执照照片', icon: 'none' });
    const payload = {
      ...f, licenseImgUrl: this.data.licenseImgUrl || '', shopImgUrl: this.data.shopImgUrl || '',
    };
    delete payload.locText; // 展示用格式化文本，不提交服务端（lat/lng 保持原始精度）
    const doSubmit = () => {
      this.setData({ submitting: true });
      api.post('/api/merchant-entry/apply', payload).then(() => {
        // 记住本次提交（名称+手机号），「查询进度」可一键预填
        try { wx.setStorageSync('entry_last', { name: f.name, phone: f.phone }); } catch (e) { /* ignore */ }
        wx.showModal({
          title: '申请已提交',
          content: '资质审核通过后平台将联系你开通商家账号。你可随时回到本页底部「查询申请进度」查看审核状态。',
          showCancel: false,
          success: () => {
            // navigateBack 返回来源页（我的/登录页），不清顾客端页面栈（reLaunch 会把用户端 tab 栈清掉）
            if (getCurrentPages().length > 1) wx.navigateBack({ delta: 1 });
            else wx.redirectTo({ url: '/pages/login/login' });
          },
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

  // ---------- 申请进度自助查询（申请人无登录态，按名称+手机号双因子查） ----------
  toggleQuery() {
    const show = !this.data.showQuery;
    const patch = { showQuery: show, queryResult: null };
    if (show) {
      // 预填上次提交的名称/手机号（提交成功时已记住）
      const last = wx.getStorageSync('entry_last');
      if (last) {
        this.setData({ 'queryForm.name': last.name || '', 'queryForm.phone': last.phone || '' });
      }
    }
    this.setData(patch);
  },
  queryInput(e) {
    const k = e.currentTarget.dataset.qk;
    this.setData({ ['queryForm.' + k]: e.detail.value });
  },
  queryProgress() {
    const { name, phone } = this.data.queryForm;
    if (!String(name || '').trim() || !String(phone || '').trim()) {
      return wx.showToast({ title: '请填写商家名称与联系电话', icon: 'none' });
    }
    if (this.data.querying) return;
    this.setData({ querying: true, queryResult: null });
    api.get('/api/merchant-entry/status', { name: String(name).trim(), phone: String(phone).trim() })
      .then((r) => {
        const map = {
          pending_review: { text: '审核中', cls: 'q-wait', tip: '平台正在审核你的资质，请耐心等待。' },
          approved: { text: '已通过', cls: 'q-ok', tip: '审核已通过，商家账号已开通。平台会联系你交付账号与初始密码（首次登录后请修改）。' },
          rejected: { text: '已驳回', cls: 'q-bad', tip: (r.reviewReason ? '驳回原因：' + r.reviewReason + '。' : '') + '可修改资料后重新提交申请。' },
        };
        const s = map[r.status];
        this.setData({ queryResult: r.found
          ? { found: true, text: s.text, cls: s.cls, tip: s.tip, appliedAtText: fmtTime(r.appliedAt), reviewedAtText: fmtTime(r.reviewedAt) }
          : { found: false, text: '未找到申请', cls: 'q-bad', tip: '未查询到该名称+手机号的申请记录，请核对填写信息。' } });
      })
      .catch((e) => wx.showToast({ title: e.message, icon: 'none' }))
      .finally(() => this.setData({ querying: false }));
  },
});
