// admin-audit.js —— 审计日志 + 修改密码
// ==================== 审计 ====================
// 动作元数据：[级别, 中文动作名, 分组]  级别：alert=异常 / warn=敏感 / info=常规
const AUDIT_META = {
  // 支付资金
  'payment.prepay': ['info', '发起预下单', 'pay'],
  'payment.notify_wx': ['info', '微信支付回调', 'pay'],
  'payment.notify_wx_unknown_order': ['alert', '未知订单支付回调', 'pay'],
  'payment.amount_mismatch': ['alert', '支付金额不匹配', 'pay'],
  'payment.notify_wx_late': ['alert', '支付回调迟到', 'pay'],
  'payment.notify_wx_rejected': ['alert', '回调验签被拒', 'pay'],
  'payment.mock_paid': ['info', '模拟支付回调', 'pay'],
  'payment.refund_requested': ['warn', '发起退款', 'pay'],
  'order.paid': ['info', '订单支付完成', 'pay'],
  'order.refund': ['warn', '订单退款', 'pay'],
  'order.refund_pending': ['warn', '退款处理中（微信已受理）', 'pay'],
  'refund.notify_received': ['info', '微信退款结果通知', 'pay'],
  'refund.notify_ignored': ['info', '退款回调非退款事件（忽略）', 'pay'],
  'refund.notify_rejected': ['alert', '退款回调验签/校验被拒', 'pay'],
  'refund.notify_unknown_order': ['alert', '退款回调未知订单', 'pay'],
  'refund.notify_mismatch': ['alert', '退款回调单号/金额不一致', 'pay'],
  'refund.finalize_success': ['warn', '退款到账并入账完成', 'pay'],
  'refund.finalize_error': ['alert', '退款到账但本地入账失败', 'pay'],
  'refund.failed': ['alert', '微信退款失败/关闭', 'pay'],
  'refund.query': ['info', '主动查询退款', 'pay'],
  'refund.query_error': ['warn', '主动查询退款失败', 'pay'],
  'refund.retry': ['warn', '退款异常重试', 'pay'],
  'refund.anomaly_open': ['alert', '退款异常入队', 'pay'],
  'refund.anomaly_closed': ['info', '退款异常关闭', 'pay'],
  'refund.anomaly_alert': ['alert', '退款异常阈值告警', 'pay'],
  'refund.sweep_error': ['warn', '退款定时查单异常', 'pay'],
  'withdraw.apply': ['warn', '提现申请', 'pay'],
  'withdraw.approve': ['warn', '提现审核通过', 'pay'],
  'withdraw.issue': ['warn', '提现发起发放', 'pay'],
  'withdraw.confirm': ['warn', '转账确认收款', 'pay'],
  'withdraw.done': ['warn', '提现发放完成', 'pay'],
  'withdraw.expire_refund': ['warn', '转账超时退回', 'pay'],
  'withdraw.bind_receiver': ['warn', '绑定收款人', 'pay'],
  'withdraw.bind_receiver_via': ['warn', '绑定收款人', 'pay'],
  'withdraw.bind_receiver_login_failed': ['alert', '收款人绑定失败', 'pay'],
  'reserve.deposit': ['warn', '储备金存入', 'pay'],
  'quarter.assess': ['info', '季度资格核算', 'pay'],
  'quarter.payout_auto': ['warn', '季度分红自动发放', 'pay'],
  'commission.settle': ['warn', '分佣结算', 'pay'],
  'dividend.clawback': ['warn', '分红回拨', 'pay'],
  'leader_dividend.paid': ['warn', '领导分红发放', 'pay'],
  'coupon.create': ['info', '创建优惠券', 'pay'],
  'coupon.pause': ['warn', '暂停发券（商家止损）', 'pay'],
  'coupon.resume': ['info', '恢复发券', 'pay'],
  'coupon.claim': ['info', '领取优惠券', 'pay'],
  'coupon.redeem': ['warn', '优惠券核销', 'pay'],
  'coupon.verify': ['warn', '优惠券核验', 'pay'],
  'merchant_fee.paid': ['warn', '联盟服务费确认收款', 'pay'],
  'ad.slot_create': ['info', '创建广告位', 'pay'],
  'ad.book': ['info', '广告预约', 'pay'],
  'ad.review': ['info', '广告审核处理', 'pay'],
  'ad.release_expired': ['info', '过期广告位释放', 'pay'],
  'adReward.video_create': ['info', '创建视频广告计划', 'pay'],
  'adReward.video_review': ['warn', '视频广告审核', 'pay'],
  'adReward.video_offline': ['warn', '视频广告下架', 'pay'],
  'adCenter.video_material_update': ['warn', '广告素材修改/重提审', 'pay'],
  'adCenter.video_append_budget': ['warn', '广告计划追加预算', 'pay'],
  'adCenter.video_settle': ['warn', '广告计划结算', 'pay'],
  'adCenter.settlement_refunded': ['warn', '结算单标记已退款', 'pay'],
  'adCenter.quota_grant': ['warn', '发放商家广告额度', 'pay'],
  'adCenter.video_create': ['info', '创建广告计划（商家自助/后台代建）', 'pay'],
  'adCenter.slot_book': ['warn', '平台代投轮播广告位', 'pay'],
  'adReward.realname': ['warn', '用户实名认证', 'account'],
  'adReward.withdraw_apply': ['warn', '奖励提现申请', 'pay'],
  'adReward.withdraw_approve': ['warn', '奖励提现初审通过', 'pay'],
  'adReward.withdraw_pay': ['warn', '奖励提现复核打款', 'pay'],
  'adReward.withdraw_pay_failed': ['alert', '奖励提现复核打款失败', 'pay'],
  'adReward.withdraw_reject': ['warn', '奖励提现驳回', 'pay'],
  'adReward.withdraw_offline_mark': ['warn', '奖励提现登记线下打款', 'pay'],
  'adReward.withdraw_offline_confirm': ['warn', '奖励提现线下复核发放', 'pay'],
  // 订单履约
  'order.ship': ['info', '订单发货', 'order'],
  'order.receive': ['info', '订单确认收货', 'order'],
  'order.auto_receive': ['info', '订单自动收货', 'order'],
  'order.cycle_completed': ['info', '一轮购买完成', 'order'],
  'order.release': ['info', '订单释放', 'order'],
  'order.store_verify': ['info', '到店核销', 'order'],
  'order.refund_free': ['warn', '免单订单退款', 'order'],
  'order.after_sale_apply': ['warn', '发起售后申请', 'order'],
  'order.after_sale_resolve': ['warn', '售后处理完成', 'order'],
  'order.force_complete': ['warn', '订单强制完成', 'order'],
  // 开关配置
  'switch.change': ['warn', '系统开关变更', 'config'],
  'level.config': ['info', '等级阈值调整', 'config'],
  'rules.version': ['info', '规则版本切换', 'config'],
  'task.config': ['info', '任务奖励配置', 'config'],
  'catalog.category_r_change': ['warn', '类目R值调整', 'config'],
  'wxmp.config_save': ['warn', '小程序配置保存', 'config'],
  'seed.nearby_merchants': ['info', '附近商家种子数据', 'config'],
  'merchant.password_backfill': ['alert', '商家密码回填', 'config'],
  'merchant.reset_token': ['warn', '商家令牌重置', 'config'],
  'admin.account_init': ['alert', '管理员账号初始化', 'config'],
  'catalog.product_create': ['info', '创建商品', 'config'],
  'catalog.product_update': ['info', '更新商品', 'config'],
  'catalog.product_submit': ['info', '商家提交商品', 'config'],
  'catalog.product_resubmit': ['info', '商家修改并重提商品', 'config'],
  'catalog.product_review': ['warn', '商品审核', 'config'],
  'catalog.category_create': ['info', '创建类目', 'config'],
  'catalog.category_seed': ['info', '类目种子数据', 'config'],
  'catalog.category_icon_legacy_cleanup': ['info', '清理废弃类目图标引用', 'config'],
  'catalog.category_display_change': ['info', '类目图标/名称调整', 'config'],
  'ops.slide_create': ['info', '首页运营帧新增', 'config'],
  'ops.slide_update': ['info', '首页运营帧修改', 'config'],
  'ops.slide_delete': ['warn', '首页运营帧删除', 'config'],
  'ops.slide_move': ['info', '首页运营帧排序', 'config'],
  'content.update': ['warn', '文案内容修改', 'config'],
  'content.reset': ['warn', '文案恢复内置', 'config'],
  seed: ['info', '系统种子初始化', 'config'],
  // 跑批任务
  'job.activity_snapshot': ['info', '统计昨日活跃', 'job'],
  'job.daily_dividend': ['info', '每日分红跑批', 'job'],
  'job.issue_queued': ['info', '补发推迟的提现', 'job'],
  'job.settle_commission': ['info', '到期佣金解冻', 'job'],
  daily_jobs: ['info', '每日自动任务汇总', 'job'],
  'daily_jobs_error': ['alert', '每日自动任务失败', 'job'],
  // 账号管理
  'admin.login': ['info', '管理员登录', 'account'],
  'admin.login_failed': ['alert', '管理员登录失败', 'account'],
  'admin.login_locked': ['alert', '管理员登录被限流（锁定期内）', 'account'],
  'admin.login_lock_triggered': ['alert', '管理员登录触发锁定', 'account'],
  'admin.logout': ['info', '管理员登出', 'account'],
  'admin.password_changed': ['warn', '管理员修改密码', 'account'],
  'admin.password_reset_from_env': ['alert', '管理员口令由环境变量重置', 'account'],
  'admin.password_reset_cli': ['alert', '管理员口令由服务器命令行重置', 'account'],
  // 子管理员账号（V4.1 · 总账号管理）
  'adminuser.create': ['warn', '创建子管理员账号', 'account'],
  'adminuser.update': ['warn', '调整子管理员权限', 'account'],
  'adminuser.enable': ['warn', '启用子管理员', 'account'],
  'adminuser.disable': ['alert', '停用子管理员', 'account'],
  'adminuser.reset_password': ['warn', '重置子管理员密码', 'account'],
  'adminuser.delete': ['alert', '删除子管理员', 'account'],
  'adminuser.login': ['info', '子管理员登录', 'account'],
  'adminuser.login_failed': ['alert', '子管理员登录失败', 'account'],
  'merchant.login': ['info', '商家登录', 'account'],
  'merchant.login_failed': ['alert', '商家登录失败', 'account'],
  'merchant.reset_password': ['warn', '重置商家密码', 'account'],
  'merchant.change_password': ['warn', '商家自助修改密码', 'account'],
  'merchant.shop_update': ['info', '商家更新门店主页', 'account'],
  'merchant.create': ['warn', '创建商家', 'account'],
  'merchant.status': ['warn', '商家状态变更', 'account'],
  'merchant.entry_apply': ['info', '商家入驻申请', 'account'],
  'merchant.entry_approved': ['warn', '商家入驻审核通过', 'account'],
  'merchant.entry_rejected': ['warn', '商家入驻审核驳回', 'account'],
  // 上传安全（P0-3）
  'upload.image': ['info', '图片上传', 'upload'],
  'upload.video': ['info', '广告视频上传（后台）', 'upload'],
  'merchant.upload_video': ['info', '广告视频上传（商家）', 'upload'],
  'upload.rejected': ['warn', '上传被拒（超限/未登录）', 'upload'],
  // 用户行为
  login: ['info', '用户登录', 'user'],
  'user.logout': ['info', '用户登出', 'user'],
  'user.profile_update': ['info', '修改个人资料', 'user'],
  'address.save': ['info', '保存收货地址', 'user'],
  'address.delete': ['info', '删除收货地址', 'user'],
  'promotion.bind_referral': ['info', '绑定推荐关系', 'user'],
  'rules.confirm': ['info', '规则确认', 'user'],
  'message.broadcast': ['info', '群发公告消息', 'user'],
  'task.streak_bonus': ['info', '连续签到奖励', 'user'],
  'risk.blacklist_add': ['warn', '拉黑用户', 'user'],
  'risk.blacklist_remove': ['info', '移出黑名单', 'user'],
  'risk.appeal_submit': ['info', '申诉提交', 'user'],
  'risk.appeal_accepted': ['warn', '申诉受理通过', 'user'],
  'risk.appeal_rejected': ['warn', '申诉驳回', 'user'],
  'risk.loop_free_alert': ['alert', '免费单循环风控告警', 'user'],
};
const AUDIT_KEY = { orderId: '订单', userId: '用户', merchantId: '商家', refundNo: '退款单号', fen: '金额', amountFen: '金额', notifyFen: '回调金额', orderFen: '订单金额', paidFen: '实付金额', poolFen: '分红池', perSeatFen: '每席金额', poolBalanceFen: '池余额', dailyRatio: '日分配比例', maxSeats: '最大席位', paidCount: '发放席位', payouts: '发放笔数', date: '日期', periodId: '期次', count: '数量', users: '用户数', version: '版本', thresholds: '阈值', key: '开关', from: '原值', to: '新值', status: '状态', verified: '验签通过', replay: '重放回调', devMode: '开发模式', created: '新建账号', claimed: '领取奖励', provider: '渠道', error: '错误', quarter: '季度', company: '物流公司', trackingNo: '运单号', note: '备注', devDefaultWarn: '默认口令告警', productId: '商品', name: '名称', categoryId: '类目' };
// 前缀兜底：新增 action 未写入 AUDIT_META 时，按前缀推断分组与中文名，
// 避免再次静默掉进 'other' 组（后台审计页只有 7 个分组页签，'other' 查不到）
const AUDIT_PREFIX = [
  ['withdraw.', 'pay', '提现'], ['payment.', 'pay', '支付'], ['reserve.', 'pay', '储备金'],
  ['quarter.', 'pay', '季度分红'], ['commission.', 'pay', '分佣'], ['dividend.', 'pay', '分红'],
  ['leader_dividend.', 'pay', '领导分红'], ['coupon.', 'pay', '优惠券'], ['ad.', 'pay', '广告'],
  ['order.', 'order', '订单'],
  ['job.', 'job', '每日任务'], ['daily_jobs', 'job', '每日任务'],
  ['switch.', 'config', '开关配置'], ['config.', 'config', '系统配置'], ['level.', 'config', '等级配置'], ['rules.', 'config', '规则配置'],
  ['task.', 'config', '任务配置'], ['catalog.', 'config', '商品配置'], ['seed.', 'config', '种子数据'],
  ['wxmp.', 'config', '小程序配置'], ['merchant.password', 'config', '商家凭证'],
  ['admin.account', 'config', '管理员账号'],
  ['admin.', 'account', '管理员'], ['merchant.', 'account', '商家'],
  ['user.', 'user', '用户'], ['address.', 'user', '地址'], ['promotion.', 'user', '推广'],
  ['risk.', 'user', '风控'], ['message.', 'user', '消息'], ['login', 'user', '用户'],
  ['upload.', 'upload', '上传'],
];
const auditMeta = (action) => {
  if (AUDIT_META[action]) return AUDIT_META[action];
  for (const [prefix, group, cn] of AUDIT_PREFIX) {
    if (String(action).startsWith(prefix)) return ['info', cn + '操作', group];
  }
  return ['info', action, 'other'];
};
const timeAgo = (ts) => { const d = Date.now() - new Date(ts).getTime(); return d < 6e4 ? '刚刚' : d < 36e5 ? Math.floor(d / 6e4) + ' 分钟前' : d < 864e5 ? Math.floor(d / 36e5) + ' 小时前' : Math.floor(d / 864e5) + ' 天前'; };
function jumpToOrder(orderId) {
  gotoPane('orders');
  setTimeout(() => {
    const kw = document.getElementById('orderKeyword');
    if (kw) kw.value = orderId;
    const tab = document.querySelector('#pane-orders .tr-item[data-f="all"]');
    if (tab) tab.click();
  }, 100);
}
function auditDetailHtml(a) {
  let d;
  try { d = JSON.parse(a.detail); } catch (e) { return '<span class="muted">' + escHtml(a.detail) + '</span>'; }
  if (d == null || typeof d !== 'object') return '<span class="muted">' + escHtml(String(d)) + '</span>';
  const parts = [];
  for (const [k, v] of Object.entries(d)) {
    if (v == null || v === '' || (v === false && k === 'replay')) continue;
    if (k === 'orderId' && typeof v === 'string') { parts.push(`订单 <a class="audit-link" data-act="jumpToOrder" data-id="${escHtml(v.replace(/[^\w-]/g, ''))}" href="javascript:void(0)">${escHtml(v)}</a>`); continue; }
    if (k === 'userId') { parts.push(`用户 <b>${escHtml(v)}</b>`); continue; }
    if (/Fen$/.test(k) && typeof v === 'number') { parts.push(`${AUDIT_KEY[k] || k} ¥${(v / 100).toFixed(2)}`); continue; }
    if (k === 'key' && typeof v === 'string' && S[v]) { parts.push(`开关「${S[v]}」`); continue; }
    const label = AUDIT_KEY[k] || k;
    parts.push(`${label} ${escHtml(typeof v === 'object' ? JSON.stringify(v) : v)}`);
  }
  return parts.join(' · ') || '<span class="muted">—</span>';
}
let auditCache = [];
let auditTab = 'all';
document.querySelectorAll('#auditTabs .tr-item').forEach((el) => el.onclick = () => {
  document.querySelectorAll('#auditTabs .tr-item').forEach((x) => x.classList.remove('on'));
  el.classList.add('on');
  auditTab = el.dataset.f;
  renderAudit();
});
function renderAudit() {
  const range = document.getElementById('auditRange').value;
  const actor = document.getElementById('auditActor').value.trim().toLowerCase();
  const kw = document.getElementById('auditKeyword').value.trim().toLowerCase();
  const now = Date.now();
  const rows = auditCache.filter((a) => {
    const [lv, , group] = auditMeta(a.action);
    if (auditTab === 'alert' && lv !== 'alert') return false;
    if (['pay', 'order', 'config', 'job', 'account', 'user', 'upload'].includes(auditTab) && group !== auditTab) return false;
    if (range && (now - new Date(a.ts).getTime()) / 864e5 > Number(range)) return false;
    if (actor && !String(a.actor).toLowerCase().includes(actor)) return false;
    if (kw && !(a.action + ' ' + a.detail).toLowerCase().includes(kw)) return false;
    return true;
  });
  document.querySelector('#audit tbody').innerHTML = rows.slice(0, 200).map((a) => {
    const [lv, label] = auditMeta(a.action);
    const lvTag = lv === 'alert' ? '<span class="tag danger">异常</span>' : lv === 'warn' ? '<span class="tag orange">敏感</span>' : '<span class="tag">常规</span>';
    return `<tr class="${lv === 'alert' ? 'audit-alert-row' : ''}"><td class="muted" title="${escHtml(a.ts)}">${timeAgo(a.ts)}</td><td>${escHtml(a.actor)}</td><td>${lvTag}</td><td title="${escHtml(a.action)}">${escHtml(label)}</td><td class="muted">${auditDetailHtml(a)}</td></tr>`;
  }).join('') || '<tr><td colspan="5"><div class="empty"><div class="e-icon">🔍</div>没有匹配的日志<br><span class="muted">换个筛选条件试试</span></div></td></tr>';
}
async function loadAudit() {
  auditCache = await authed('/api/admin/audit').then((r) => r.json());
  const setCnt = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = n ? ' ' + n : ''; };
  setCnt('ac-all', auditCache.length);
  setCnt('ac-alert', auditCache.filter((a) => auditMeta(a.action)[0] === 'alert').length);
  for (const g of ['pay', 'order', 'config', 'job', 'account', 'user', 'upload']) setCnt('ac-' + g, auditCache.filter((a) => auditMeta(a.action)[2] === g).length);
  renderAudit();
}

// ==================== 修改密码 ====================
function openChangePwd() { document.getElementById('pwdModal').style.display = 'flex'; document.getElementById('pwdErr').textContent = ''; }
function closeChangePwd() { document.getElementById('pwdModal').style.display = 'none'; }
async function doChangePwd() {
  const oldP = document.getElementById('pwdOld').value;
  const n1 = document.getElementById('pwdNew').value;
  const n2 = document.getElementById('pwdNew2').value;
  const err = document.getElementById('pwdErr');
  if (!oldP || !n1) { err.textContent = '请填写当前密码与新密码'; return; }
  if (n1.length <= 10) { err.textContent = '新密码长度需大于 10 位'; return; }
  if (!/[A-Za-z]/.test(n1) || !/[0-9]/.test(n1)) { err.textContent = '新密码需同时包含字母和数字'; return; }
  if (n1 !== n2) { err.textContent = '两次输入的新密码不一致'; return; }
  try {
    const r = await authed('/api/admin/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ oldPassword: oldP, newPassword: n1 }) });
    const d = await r.json();
    if (d.error) { err.textContent = d.error; return; }
    closeChangePwd();
    TOKEN = ''; sessionStorage.removeItem('bfj_admin_token');
    showLogin('密码已修改，所有会话已失效，请用新密码重新登录');
  } catch (e) { err.textContent = '修改失败：' + e.message; }
}

