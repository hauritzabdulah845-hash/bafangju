// 我的商品（商家端）：上传商品 → 平台审核 → 上架售卖（V3.23）
// 要点：类目只能选平台已有类目（让利比例由平台定）；提交/修改后平台审核通过才上架；
// 驳回会写明原因，修改后可重新提交审核。
const api = require('../../utils/api');

Page({
  data: {
    list: [],
    categories: [],
    catIndex: 0,
    loading: true,
    // 表单
    editingId: '', // 空 = 新增；有值 = 修改该商品
    name: '',
    priceYuan: '',
    costYuan: '',
    deliveryTypes: [
      { key: 'express', label: '快递到家' },
      { key: 'store', label: '到店自提/核销' },
    ],
    deliveryIndex: 0,
    imageUrl: '',
    imageFull: '',
    uploading: false,
    submitting: false,
  },
  onShow() {
    const merchantId = getApp().globalData.merchantId;
    if (!merchantId) { wx.reLaunch({ url: '/pages/login/login' }); return; }
    this.load();
  },
  load() {
    Promise.all([
      api.get('/api/merchant/categories'),
      api.get('/api/merchant/products'),
    ]).then(([cats, list]) => {
      this.setData({
        categories: cats || [],
        list: (list || []).map((p) => ({
          ...p,
          // 商品图是站内相对路径（/uploads/xxx），小程序 image 必须用完整地址才能显示
          imageFull: p.imageUrl ? api.BASE_URL + p.imageUrl : '',
          statusClass: p.status === 'on_sale' ? 'green'
            : p.status === 'pending_review' ? 'accent'
            : p.status === 'rejected' ? 'danger' : 'gray',
          deliveryText: p.deliveryType === 'store' ? '到店自提/核销' : '快递到家',
        })),
        loading: false,
      });
    }).catch(() => this.setData({ loading: false }));
  },
  onCat(e) { this.setData({ catIndex: Number(e.detail.value) }); },
  onDelivery(e) { this.setData({ deliveryIndex: Number(e.detail.value) }); },
  onInput(e) { this.setData({ [e.currentTarget.dataset.k]: e.detail.value }); },
  chooseImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      success: (res) => {
        const filePath = res.tempFiles[0].tempFilePath;
        const ext = (String(filePath).split('.').pop() || 'jpg').toLowerCase();
        wx.getFileSystemManager().readFile({
          filePath,
          encoding: 'base64',
          success: (r) => {
            this.setData({ uploading: true });
            api.post('/api/upload', { dataBase64: r.data, ext, purpose: 'material' })
              .then((u) => this.setData({ imageUrl: u.url, imageFull: api.BASE_URL + u.url }))
              .catch((err) => wx.showToast({ title: err.message, icon: 'none' }))
              .then(() => this.setData({ uploading: false }));
          },
          fail: () => wx.showToast({ title: '读取图片失败', icon: 'none' }),
        });
      },
    });
  },
  clearImage() { this.setData({ imageUrl: '', imageFull: '' }); },
  // 点列表里的「修改」：把商品数据回填到表单
  edit(e) {
    const p = this.data.list.find((x) => x.id === e.currentTarget.dataset.id);
    if (!p) return;
    const catIndex = Math.max(0, this.data.categories.findIndex((c) => c.id === p.categoryId));
    this.setData({
      editingId: p.id,
      name: p.name,
      priceYuan: api.fen2yuan(p.priceFen),
      costYuan: api.fen2yuan(p.costFen),
      catIndex,
      deliveryIndex: p.deliveryType === 'store' ? 1 : 0,
      imageUrl: p.imageUrl || '',
      imageFull: p.imageUrl ? api.BASE_URL + p.imageUrl : '',
    });
    wx.pageScrollTo({ scrollTop: 0 });
  },
  cancelEdit() {
    this.setData({ editingId: '', name: '', priceYuan: '', costYuan: '', imageUrl: '', imageFull: '', deliveryIndex: 0 });
  },
  submit() {
    const d = this.data;
    if (d.submitting) return;
    if (!d.categories.length) { wx.showToast({ title: '平台还没有可选类目，请联系平台客服', icon: 'none' }); return; }
    if (!d.name.trim()) { wx.showToast({ title: '请填写商品名称', icon: 'none' }); return; }
    const priceYuan = Number(d.priceYuan);
    const costYuan = Number(d.costYuan);
    if (!(priceYuan > 0)) { wx.showToast({ title: '请填写正确的售价', icon: 'none' }); return; }
    if (!(costYuan >= 0) || costYuan >= priceYuan) { wx.showToast({ title: '成本价需低于售价', icon: 'none' }); return; }
    const body = {
      categoryId: d.categories[d.catIndex].id,
      name: d.name.trim(),
      priceFen: Math.round(priceYuan * 100),
      costFen: Math.round(costYuan * 100),
      deliveryType: d.deliveryTypes[d.deliveryIndex].key,
      imageUrl: d.imageUrl,
    };
    this.setData({ submitting: true });
    const req = d.editingId
      ? api.post('/api/merchant/products/update', { ...body, productId: d.editingId })
      : api.post('/api/merchant/products/create', body);
    req.then(() => {
      wx.showToast({ title: '已提交，等平台审核', icon: 'success' });
      this.cancelEdit();
      this.load();
    }).catch((e) => wx.showToast({ title: e.message, icon: 'none' }))
      .then(() => this.setData({ submitting: false }));
  },
});
