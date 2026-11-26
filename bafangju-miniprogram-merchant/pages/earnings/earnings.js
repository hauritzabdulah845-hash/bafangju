const api = require('../../utils/api');
const { formatTime } = require('../../utils/time');

const FLOW_TEXT = {
  frozen: '收益入账（售后保障期内待结算）',
  settle: '待结算收益转为可提现余额',
  rollback: '退款扣回该单收益',
  withdraw_freeze: '提现申请中（待发放）',
};

Page({
  data: { flows: [], balanceYuan: '0.00', frozenYuan: '0.00', debtYuan: '0.00' },
  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().setData({ selected: 2 });
    const merchantId = getApp().globalData.merchantId;
    if (!merchantId) { wx.reLaunch({ url: '/pages/login/login' }); return; }
    api.get('/api/merchant/earnings', { merchantId }).then((e) => {
      this.setData({
        balanceYuan: api.fen2yuan(e.balanceFen),
        frozenYuan: api.fen2yuan(e.frozenFen),
        debtYuan: api.fen2yuan(e.debtFen),
        flows: e.flows.map((f) => ({ ...f, text: FLOW_TEXT[f.status] || f.status, yuan: api.fen2yuan(f.fen), timeText: formatTime(f.ts) })),
      });
    }).catch((err) => wx.showToast({ title: err.message, icon: 'none' }));
  },
});
