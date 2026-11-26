// 商家端 · 门店主页装修（V4.5）
// 平台做本地商家「线上展示 + 到店导流」，门店信息由商家自己维护：
// 门头照、营业时间、联系电话、门店地址（地图选点）、一句话简介。
const api = require('../../utils/api');
const app = getApp();

function formatCoord(v) {
  return Number(v).toFixed(4);
}

Page({
  data: {
    coverUrl: '',        // 服务端地址（提交用）
    coverPreview: '',    // 本地临时图（预览用，上传成功前也能看到）
    intro: '',
    businessHours: '',
    startTime: '09:00',
    endTime: '21:00',
    phone: '',
    address: '',
    lat: null,
    lng: null,
    locText: '',
    loading: true,
    saving: false,
    uploading: false,
    error: '',
  },

  onShow() {
    const merchantId = app.globalData.merchantId;
    if (!merchantId) { wx.reLaunch({ url: '/subpkg-merchant/pages/login/login' }); return; }
    this.load();
  },

  load() {
    this.setData({ loading: true, error: '' });
    api.get('/api/merchant/profile')
      .then((m) => {
        // 营业时间拆成两个 picker 值；格式异常时回退默认
        let start = '09:00';
        let end = '21:00';
        const bh = String(m.businessHours || '');
        const mm = bh.match(/^([01]\d|2[0-3]):([0-5]\d)\s*-\s*([01]\d|2[0-3]):([0-5]\d)$/);
        if (mm) { start = `${mm[1]}:${mm[2]}`; end = `${mm[3]}:${mm[4]}`; }
        this.setData({
          coverUrl: m.coverUrl || '',
          coverPreview: m.coverUrl ? api.BASE_URL + m.coverUrl : '',
          intro: m.intro || '',
          businessHours: m.businessHours || '',
          startTime: start,
          endTime: end,
          phone: m.phone || '',
          address: m.address || '',
          lat: m.lat == null ? null : m.lat,
          lng: m.lng == null ? null : m.lng,
          locText: (m.lat == null || m.lng == null) ? '' : `${formatCoord(m.lat)} , ${formatCoord(m.lng)}`,
          loading: false,
        });
      })
      .catch((e) => {
        // 原始错误只进控制台，界面给固定可读文案（不暴露后端地址/内部细节）
        console.error('[shop] 门店信息加载失败 → ' + String((e && e.message) || '未知错误'));
        this.setData({ loading: false, error: '门店信息加载失败，请稍后重试' });
      });
  },

  // 门头照：purpose=material 存公开目录，用户端可直接展示
  chooseCover() {
    if (this.data.uploading) return;
    wx.chooseMedia({
      count: 1, mediaType: ['image'], sizeType: ['compressed'],
      success: (res) => {
        const path = res.tempFiles[0].tempFilePath;
        // 先本地预览，用户能立刻看到选了哪张
        this.setData({ coverPreview: path });
        wx.getFileSystemManager().readFile({
          filePath: path, encoding: 'base64',
          success: (f) => {
            this.setData({ uploading: true });
            wx.showLoading({ title: '上传中', mask: true });
            api.post('/api/upload', { dataBase64: f.data, ext: path.split('.').pop(), purpose: 'material' })
              .then((r) => {
                wx.hideLoading();
                this.setData({ uploading: false, coverUrl: r.url, coverPreview: path });
                wx.showToast({ title: '门头照已上传', icon: 'none' });
              })
              .catch((e) => {
                wx.hideLoading();
                this.setData({ uploading: false, coverPreview: this.data.coverUrl ? api.BASE_URL + this.data.coverUrl : '' });
                wx.showToast({ title: e.message, icon: 'none' });
              });
          },
          fail: () => {
            this.setData({ coverPreview: this.data.coverUrl ? api.BASE_URL + this.data.coverUrl : '' });
            wx.showToast({ title: '读取图片失败', icon: 'none' });
          },
        });
      },
    });
  },

  clearCover() { this.setData({ coverUrl: '', coverPreview: '' }); },

  pickTime(e) {
    const key = e.currentTarget.dataset.key; // startTime | endTime
    this.setData({ [key]: e.detail.value });
  },

  // 地图选点：坐标与地址一起更新，保证"距离/导航"不失真
  chooseLocation() {
    wx.chooseLocation({
      success: (res) => {
        this.setData({
          lat: res.latitude,
          lng: res.longitude,
          locText: `${formatCoord(res.latitude)} , ${formatCoord(res.longitude)}`,
          address: res.address || res.name || this.data.address,
        });
        wx.showToast({ title: '门店位置已更新', icon: 'none' });
      },
      fail: (err) => {
        if (err && String(err.errMsg || '').indexOf('cancel') >= 0) return;
        wx.showToast({ title: '请授权位置权限后重试', icon: 'none' });
      },
    });
  },

  onInput(e) {
    this.setData({ [e.currentTarget.dataset.key]: e.detail.value });
  },

  save() {
    if (this.data.saving || this.data.uploading) return;
    const { startTime, endTime, address, lat, lng, intro, phone, coverUrl } = this.data;
    if (startTime === endTime) return wx.showToast({ title: '营业开始与结束时间不能相同', icon: 'none' });
    if (!address) return wx.showToast({ title: '请填写门店地址', icon: 'none' });
    if (lat == null || lng == null) return wx.showToast({ title: '请在地图上选择门店位置', icon: 'none' });

    this.setData({ saving: true });
    api.post('/api/merchant/shop', {
      coverUrl, intro: String(intro || '').trim(),
      businessHours: `${startTime}-${endTime}`,
      phone: String(phone || '').trim(),
      address: String(address).trim(), lat, lng,
    })
      .then(() => {
        wx.showToast({ title: '门店主页已保存', icon: 'success' });
        setTimeout(() => wx.navigateBack(), 700);
      })
      .catch((e) => wx.showToast({ title: e.message, icon: 'none' }))
      .finally(() => this.setData({ saving: false }));
  },
});
