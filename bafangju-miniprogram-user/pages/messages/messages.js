// 消息中心 · 拼多多配色（规范板推断）
// 数据：GET /api/messages {messages, unread}；进入页面即全部已读
const api = require('../../utils/api');
const app = getApp();

// ISO 时间格式化为 MM-DD HH:mm
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso).slice(0, 16);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

Page({
  data: { msgs: [], unread: 0, loading: true },
  onShow() { this.load(); },
  load() {
    api.get('/api/messages?userId=' + app.globalData.userId)
      .then((d) => {
        this.setData({
          msgs: (d.messages || []).map((m) => ({ ...m, timeText: fmtTime(m.ts) })),
          unread: d.unread || 0,
          loading: false,
        });
        if (d.unread > 0) this.markRead();
      }).catch(() => this.setData({ loading: false }));
  },
  // 进入页面即全部已读（红点清零）
  markRead() {
    api.post('/api/messages/read', { userId: app.globalData.userId })
      .then(() => {
        this.setData({ unread: 0, msgs: this.data.msgs.map((m) => ({ ...m, read: true })) });
      }).catch(() => {});
  },
});
