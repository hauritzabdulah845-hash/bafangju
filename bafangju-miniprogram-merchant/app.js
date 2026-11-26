App({
  globalData: {
    merchantId: null,
    merchantName: null,
  },
  onLaunch() {
    const saved = wx.getStorageSync('merchantId');
    if (saved) {
      this.globalData.merchantId = saved;
      this.globalData.merchantName = wx.getStorageSync('merchantName');
    }
  },
});
