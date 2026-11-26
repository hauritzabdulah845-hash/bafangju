const api = require('../../utils/api');
const app = getApp();

Page({
  data: {
    list: [],
    selectMode: false, // 从商品页跳入：点击地址即选中返回
    showForm: false,
    form: { name: '', phone: '', region: '', address: '', isDefault: false },
    region: ['广东省', '广州市', '天河区'],
    submitting: false,
  },
  onLoad(q) { this.setData({ selectMode: q.mode === 'select' }); },
  onShow() { this.load(); },
  load() {
    api.get('/api/user/addresses')
      .then((list) => this.setData({ list: list || [] }))
      .catch((e) => wx.showToast({ title: e.message, icon: 'none' }));
  },
  openForm() { this.setData({ showForm: true }); },
  closeForm() { this.setData({ showForm: false }); },
  // 空操作：阻止表单卡片上的点击冒泡到遮罩层导致弹层被关闭
  noop() {},
  // 一键导入微信收货地址：自动填充表单，省市区/手机号做清洗兼容
  importWxAddress() {
    wx.chooseAddress({
      success: (res) => {
        // res: { userName, telNumber, provinceName, cityName, countyName, detailInfo, streetInfo }
        const regionArr = [res.provinceName, res.cityName, res.countyName].filter(Boolean);
        const region = regionArr.join(' ');
        // 手机号清洗：去 +86/空格/横线（虚拟号段含 * 的需用户手填，保存时后端会拦）
        const phone = String(res.telNumber || '').replace(/^(\+?86)/, '').replace(/[\s-]/g, '');
        // 详细地址去省市区前缀（部分微信版本 detailInfo 自带完整前缀）
        let detail = res.detailInfo || res.streetInfo || '';
        const prefix = (res.provinceName || '') + (res.cityName || '') + (res.countyName || '');
        if (prefix && detail.indexOf(prefix) === 0) detail = detail.slice(prefix.length);
        this.setData({
          'form.name': res.userName || '',
          'form.phone': phone,
          'form.region': region,
          'form.address': detail.trim(),
          region: regionArr.length ? regionArr : this.data.region,
        });
        wx.showToast({ title: phone.length === 11 ? '已导入，请核对信息' : '已导入；号码为隐私号，请补全 11 位手机号', icon: 'none', duration: 2500 });
      },
      fail: (e) => {
        // 拒绝授权 → 引导去设置开启；用户取消 → 静默
        if (e.errMsg && e.errMsg.indexOf('auth deny') >= 0) {
          wx.showModal({
            title: '需要地址权限',
            content: '导入微信地址需要开启收货地址授权，是否前往设置？',
            success: (r) => { if (r.confirm) wx.openSetting(); },
          });
        }
      },
    });
  },
  onInput(e) { this.setData({ [`form.${e.currentTarget.dataset.k}`]: e.detail.value }); },
  onRegion(e) { this.setData({ region: e.detail.value, 'form.region': e.detail.value.join(' ') }); },
  toggleDefault() { this.setData({ 'form.isDefault': !this.data.form.isDefault }); },
  submit() {
    if (this.data.submitting) return;
    this.setData({ submitting: true });
    const f = this.data.form;
    api.post('/api/user/addresses', { ...f, region: f.region || this.data.region.join(' ') })
      .then(() => {
        wx.showToast({ title: '已保存', icon: 'success' });
        this.setData({ showForm: false, form: { name: '', phone: '', region: '', address: '', isDefault: false } });
        this.load();
      })
      .catch((e) => wx.showToast({ title: e.message, icon: 'none' }))
      .finally(() => this.setData({ submitting: false }));
  },
  pick(e) {
    if (!this.data.selectMode) return;
    const addr = this.data.list[e.currentTarget.dataset.idx];
    const g = getApp().globalData;
    g.selectedAddress = addr;
    wx.navigateBack();
  },
  setDefault(e) {
    api.post('/api/user/addresses/default', { addressId: this.data.list[e.currentTarget.dataset.idx].id })
      .then(() => this.load())
      .catch((err) => wx.showToast({ title: err.message, icon: 'none' }));
  },
  remove(e) {
    const addr = this.data.list[e.currentTarget.dataset.idx];
    wx.showModal({
      title: '删除地址', content: `确定删除「${addr.name} ${addr.region} ${addr.address}」？`, confirmColor: '#E5484D',
      success: (r) => {
        if (!r.confirm) return;
        api.post('/api/user/addresses/delete', { addressId: addr.id })
          .then(() => this.load())
          .catch((err) => wx.showToast({ title: err.message, icon: 'none' }));
      },
    });
  },
});
