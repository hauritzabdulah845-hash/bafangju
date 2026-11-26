'use strict';
/**
 * 用户端路由（购买链路强制登录态）。
 * 覆盖：登录会话、收货地址簿、订单与履约、任务体系、消息中心、申诉、推广、提现、等级与复购。
 *
 * 合规要点：
 * - userId 一律以服务端会话解析为准，**不信任** query/body 里传入的 userId（越权收口）；
 * - 下单前必须确认当前规则版本，未确认返回 RULES_CONFIRM_FAILED 供前端引导；
 * - 收货信息为下单时点快照，地址簿后续修改不追溯已支付订单；
 * - 提现收款人 openid 只在服务端持有，登录时自动绑定，用户零操作。
 */
module.exports = function register(app, ctx) {
  const { db, svc, audit, auth, wxmp, risk, promotion, withdraw, userAccount, fulfillment, coupon, fenToYuan, requireUser, pub, bizdate, adReward, adCenter } = ctx;

  // ---------- 登录（V3.9：微信 code2session + 本地幂等；未配置商户参数时降级为开发态） ----------
  app.post('/api/user/login', async (req, res) => {
    try {
      const { code, nickname, deviceId } = req.body || {};
      // 配置统一来源：后台「系统设置」优先，回退环境变量（配置一次，登录/小程序码同时生效）
      const wxCfg = wxmp.getConfig(db);
      const wxConfigured = !!(wxCfg.appid && wxCfg.secret);
      const issue = (userId, extra) => ({
        ...extra,
        userId,
        token: userAccount.createSession(db, userId), // 购买链路凭此 token 鉴权
      });
      const legacyUserId = req.user ? req.user.id : null; // 有效会话可用于认领老账号

      if (code) {
        const r = await auth.loginWithCode(db, {
          code, nickname,
          appid: wxCfg.appid, secret: wxCfg.secret,
          devSeed: deviceId,
          legacyUserId,
        });
        if (risk.isBlacklisted(db, r.userId)) return res.status(403).json({ error: '账号已被限制使用，如有疑问请通过客服申诉' });
        // 登录即绑定收款微信（openid 服务端持有自动换绑，用户零操作；供未来提现通道使用）
        try {
          withdraw.bindReceiver(db, { userId: r.userId, openid: r.openid, operator: 'login_auto' });
        } catch (be) { audit(db, 'system', 'withdraw.bind_receiver_login_failed', { userId: r.userId, error: be.message }); }
        audit(db, 'user', 'login', { userId: r.userId, devMode: r.devMode, created: r.created, claimed: !!r.claimed });
        const u = db.users.get(r.userId) || {};
        return res.json(issue(r.userId, {
          nickname: u.nickname, avatarUrl: u.avatarUrl || '', devMode: r.devMode, created: r.created, claimed: !!r.claimed,
        }));
      }

      // 无 code：仅开发态允许（生产必须微信登录，避免绕过微信身份）
      if (wxConfigured) return res.status(400).json({ error: '请使用微信登录（未收到 code）' });
      const devId = String(deviceId || '').trim();
      if (!devId && !nickname) return res.status(400).json({ error: 'code、deviceId 或 nickname 至少一项' });
      let userId; let created = false;
      if (devId) {
        // 开发态本地幂等：同一设备标识 → 同一 openid → 同一账号（刷新/重登不重复建号）
        const r = auth.loginOrRegister(db, { openid: auth.deriveDevOpenid(devId), nickname });
        userId = r.userId; created = r.created;
      } else {
        const u = db.users.insert({ nickname, createdAt: new Date().toISOString() });
        userId = u.id; created = true;
      }
      if (risk.isBlacklisted(db, userId)) return res.status(403).json({ error: '账号已被限制使用，如有疑问请通过客服申诉' });
      audit(db, 'user', 'login', { userId, devMode: true, created });
      const u = db.users.get(userId) || {};
      res.json(issue(userId, { nickname: u.nickname, avatarUrl: u.avatarUrl || '', devMode: true, created }));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ---------- 个人资料（昵称 / 头像，登录态自改，不接受 userId 入参以免越权） ----------
  app.get('/api/user/profile', requireUser, (req, res) => {
    const u = db.users.get(req.user.id) || {};
    res.json({ userId: req.user.id, nickname: u.nickname || '', avatarUrl: u.avatarUrl || '' });
  });

  app.post('/api/user/profile', requireUser, (req, res) => {
    try {
      const body = req.body || {};
      const patch = {};
      if (body.nickname != null) {
        const nickname = String(body.nickname).trim();
        if (!nickname) return res.status(400).json({ error: '昵称不能为空' });
        if (nickname.length > 20) return res.status(400).json({ error: '昵称不能超过 20 个字符' });
        patch.nickname = nickname;
      }
      if (body.avatarUrl != null) {
        const avatarUrl = String(body.avatarUrl).trim();
        // 头像只接受本站上传目录或 https 资源，避免把任意 URL 写进资料页
        if (avatarUrl && !(avatarUrl.startsWith('/uploads/') || /^https:\/\//i.test(avatarUrl))) {
          return res.status(400).json({ error: '头像地址不合法' });
        }
        patch.avatarUrl = avatarUrl;
      }
      if (!Object.keys(patch).length) return res.status(400).json({ error: '没有需要更新的字段' });
      const u = db.users.update(req.user.id, patch);
      audit(db, 'user', 'user.profile_update', { userId: req.user.id, fields: Object.keys(patch) });
      res.json({ ok: true, userId: u.id, nickname: u.nickname || '', avatarUrl: u.avatarUrl || '' });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ---------- 收货地址簿（登录态） ----------
  app.get('/api/user/addresses', requireUser, (req, res) => {
    res.json(userAccount.listAddresses(db, req.user.id));
  });
  app.post('/api/user/addresses', requireUser, (req, res) => {
    try {
      const a = userAccount.saveAddress(db, { userId: req.user.id, ...req.body });
      res.json({ ok: true, address: a });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/user/addresses/default', requireUser, (req, res) => {
    try { res.json({ ok: true, address: userAccount.setDefaultAddress(db, req.user.id, req.body.addressId) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/user/addresses/delete', requireUser, (req, res) => {
    try { userAccount.deleteAddress(db, req.user.id, req.body.addressId); res.json({ ok: true }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/user/logout', requireUser, (req, res) => {
    userAccount.revokeSession(db, req.userToken);
    res.json({ ok: true });
  });

  // ---------- 规则版本确认留档（V3.3 §5.2-1 / §15-11） ----------
  app.post('/api/user/rules/confirm', requireUser, (req, res) => {
    try {
      res.json({ ok: true, ...svc.confirmRules(db, { userId: req.user.id, version: req.body.version, source: req.body.source || 'order' }) });
    } catch (e) { res.status(400).json({ error: e.message, code: e.code || 'RULES_CONFIRM_FAILED' }); }
  });

  // ---------- 下单 ----------
  app.post('/api/orders', requireUser, (req, res) => {
    try {
      // 首次下单前必须确认当前版本规则（V3.3 §5.2-1），未确认返回 RULES_NOT_CONFIRMED 供前端引导
      svc.assertRulesConfirmed(db, req.user.id);
      const { order, replay } = svc.createOrder(db, { ...req.body, userId: req.user.id });
      // 广告归因：从视频观看页跳商品后下单，带上 sourceVideoId 记一条 order 事件
      const src = String((req.body || {}).sourceVideoId || '');
      if (src) {
        try {
          adCenter.trackEvent(db, {
            videoId: src, userId: req.user.id, type: 'order', orderId: order.id,
            orderFen: order.payFen || order.amountFen || order.totalFen || 0,
          });
        } catch (_) { /* 归因失败不影响下单 */
        }
      }
      res.json({ order: pub(order), replay });
    } catch (e) { res.status(400).json({ error: e.message, code: e.code || 'ORDER_CREATE_FAILED' }); }
  });

  // ---------- 履约：确认收货 / 售后申请（用户，V3.5） ----------
  app.post('/api/orders/confirm', requireUser, (req, res) => {
    try {
      const order = fulfillment.confirmReceipt(db, { orderId: req.body.orderId, userId: req.user.id });
      res.json({ ok: true, order: pub(order) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/orders/after-sale', requireUser, (req, res) => {
    try {
      const order = fulfillment.applyAfterSale(db, {
        orderId: req.body.orderId,
        userId: req.user.id,
        reason: req.body.reason,
        windowDays: db.switches.get('afterSaleWindowDays'),
      });
      res.json({ ok: true, order: pub(order) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ---------- 返还进度 ----------
  app.get('/api/return-plans', requireUser, (req, res) => {
    const { progress, savedFen } = svc.returnPlans(db, req.user.id);
    res.json({ progress, savedFen, savedYuan: fenToYuan(savedFen) });
  });

  // ---------- 分红排队号与到账（本人数据） ----------
  app.get('/api/dividend/my', requireUser, (req, res) => {
    const userId = req.user.id;
    // 全平台活跃队列（waiting/skipped）按入队时间排序，得出每个号的全场排名
    const active = db.queueSlots
      .where((s) => s.status === 'waiting' || s.status === 'skipped')
      .sort((a, b) => (a.grantedAt < b.grantedAt ? -1 : 1));
    const rankMap = {};
    active.forEach((s, i) => { rankMap[s.id] = i + 1; });
    const slots = db.queueSlots.where((s) => s.userId === userId)
      .sort((a, b) => (a.grantedAt < b.grantedAt ? -1 : 1))
      .map((s) => ({ ...s, rank: rankMap[s.id] || null }));
    const payouts = db.dividendPayouts.where((p) => p.userId === userId);
    const acc = db.earnings.get(userId) || { dividendBalanceFen: 0, balanceFen: 0, frozenFen: 0 };
    res.json({ slots, payouts, dividendBalanceFen: acc.dividendBalanceFen || 0, balanceFen: acc.balanceFen || 0, frozenFen: acc.frozenFen || 0 });
  });

  // ---------- 推广模块（身份一律取会话，忽略 query/body 里的 userId） ----------
  app.post('/api/user/bind-referral', requireUser, (req, res) => {
    try {
      res.json({ ok: true, ...promotion.bindReferral(db, { ...req.body, userId: req.user.id }) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.get('/api/user/promotion/profile', requireUser, (req, res) => {
    res.json(promotion.referralProfile(db, req.user.id));
  });
  app.get('/api/user/promotion/team', requireUser, (req, res) => {
    res.json(promotion.teamMembers(db, req.user.id));
  });
  app.get('/api/user/promotion/earnings', requireUser, (req, res) => {
    res.json(promotion.promotionEarnings(db, req.user.id));
  });
  app.get('/api/user/promotion/qrcode', requireUser, async (req, res) => {
    try {
      // 配置来自后台「系统设置」或环境变量；未配置时返回 devMode（前端显示占位码 + 配置指引）
      const r = await wxmp.getQrcode(db, { userId: req.user.id });
      res.json(r);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ---------- 用户提现（复用提现域，受 withdrawEnabled 开关控制；收款人已在登录时自动绑定） ----------
  app.get('/api/user/withdraw/status', requireUser, (req, res) => {
    res.json(withdraw.withdrawStatus(db, req.user.id));
  });
  app.post('/api/user/withdraw/apply', requireUser, (req, res) => {
    try {
      const { request, replay } = withdraw.applyWithdraw(db, { ...req.body, userId: req.user.id });
      audit(db, `user:${req.user.id}`, 'withdraw.apply', { fen: request.fen });
      res.json({ ok: true, replay, request });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/user/withdraw/confirm', requireUser, (req, res) => {
    try {
      const t = withdraw.confirmTransfer(db, { ...req.body, userId: req.user.id });
      res.json({ ok: true, transfer: t });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ---------- 订单列表与单笔查询（仅本人可见） ----------
  // 注意：/api/orders/list 必须先于 /api/orders/:id 注册，否则会被通配路由吃掉
  app.get('/api/orders/list', requireUser, (req, res) => {
    const list = db.orders.where((o) => o.userId === req.user.id)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((o) => ({
        ...o,
        name: (db.products.get(o.productId) || {}).name,
        imageUrl: (db.products.get(o.productId) || {}).imageUrl || '',
        // 售后窗口是否仍开放（仅 done 状态受窗口限制）：前端据此隐藏超期订单的"申请售后"按钮，
        // 避免按钮显示但后端拒绝（前后端状态口径不一致）
        afterSaleOpen: fulfillment.afterSaleWindowOpen(o, Date.now(), db.switches.get('afterSaleWindowDays')),
      }));
    res.json(list);
  });

  // 单笔订单（支付成功后轮询状态用；仅本人可见）
  app.get('/api/orders/:id', requireUser, (req, res) => {
    const o = db.orders.get(req.params.id);
    if (!o || o.userId !== req.user.id) return res.status(404).json({ error: '订单不存在' });
    res.json(pub(o));
  });

  // ---------- 消息 / 任务 ----------
  // 任务类接口的业务日一律由服务端按北京时间裁定（V3.22）：
  // 不信任前端传来的 date，防止 UTC 错日（00:00–07:59 记到前一天）与伪造日期重复刷任务奖励。
  app.use('/api/tasks', (req, res, next) => {
    if (req.body && typeof req.body === 'object') req.body.date = bizdate.today();
    next();
  });
  app.get('/api/tasks/today', requireUser, (req, res) => {
    const date = bizdate.today();
    const userId = req.user.id;
    const signed = db.taskRecords.where((t) => t.userId === userId && t.taskType === 'sign_in' && t.date === date).length > 0;
    // 浏览任务进度：已开始的商品与完成状态
    const browses = db.taskRecords.where((t) => t.userId === userId && t.date === date && t.taskType.startsWith('browse:'))
      .map((t) => ({ productId: t.taskType.slice(7), status: t.status, startedAt: t.startedAt }));
    // 广告任务（V3.15）：流量主开通后启用，服务端校验观看时长
    const adRec = db.taskRecords.where((t) => t.userId === userId && t.taskType === 'ad' && t.date === date)[0] || null;
    const rewards = db.switches.get('taskRewards') || {};
    const streakCfg = db.switches.get('taskStreakBonus') || {};
    const streakTarget = Number(streakCfg.days) > 0 ? Number(streakCfg.days) : 30;
    const startDay = bizdate.dayOffset(-(streakTarget - 1));
    const streakDays = new Set(
      db.taskRecords.where((t) => t.userId === userId && t.status === 'done' && String(t.date) >= startDay).map((t) => t.date)
    ).size;
    res.json({
      signed,
      browses,
      ad: adRec ? { status: adRec.status, startedAt: adRec.startedAt } : null,
      adEnabled: db.switches.get('adTaskEnabled') === true,
      rewards,
      streak: {
        days: streakDays,
        target: streakTarget,
        reward: Number(streakCfg.reward) >= 0 ? Number(streakCfg.reward) : 80,
        awardedAt: (db.users.get(userId) || {}).taskBonusAt || null,
      },
    });
  });

  app.post('/api/tasks/browse-start', requireUser, (req, res) => {
    try {
      res.json({ ok: true, ...svc.startBrowse(db, { ...req.body, userId: req.user.id }) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/tasks/browse-finish', requireUser, (req, res) => {
    try {
      res.json({ ok: true, ...svc.finishBrowse(db, { ...req.body, userId: req.user.id }) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // 广告任务（V3.15，§8.2）：流量主开通后启用；服务端校验观看 ≥15 秒，防止前端伪造
  app.post('/api/tasks/ad-start', requireUser, (req, res) => {
    try {
      res.json({ ok: true, ...svc.startAdTask(db, { userId: req.user.id, date: req.body.date }) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/tasks/ad-finish', requireUser, (req, res) => {
    try {
      res.json({ ok: true, ...svc.finishAdTask(db, { userId: req.user.id, date: req.body.date }) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // 近 30 天贡献值（活跃门槛：30 天累计 ≥80，V3.3 §4.8）
  app.get('/api/user/contribution/30d', requireUser, (req, res) => {
    res.json(svc.contribution30d(db, req.user.id));
  });

  // 等级与有效人数（V3.3 §4.9 / §4.10）：等级只作权益资格、不作计酬依据，人数不进分红公式
  app.get('/api/user/level', requireUser, (req, res) => {
    res.json(svc.levelProfile(db, req.user.id, { date: req.query.date }));
  });

  // 复购中心（V3.3 §5.1）：历史购买商品（含下一单实付）+ 跨类目进度总览
  app.get('/api/user/rebuy', requireUser, (req, res) => {
    res.json(svc.rebuyOverview(db, req.user.id));
  });

  // ---------- 联盟券：领券 / 我的券（一券一码） ----------
  app.post('/api/coupons/claim', requireUser, (req, res) => {
    try {
      res.json({ ok: true, claim: coupon.claimCoupon(db, { couponId: req.body.couponId, userId: req.user.id }) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.get('/api/user/coupons', requireUser, (req, res) => {
    res.json(coupon.listUserCoupons(db, req.user.id));
  });

  // ---------- 消息中心（仅本人） ----------
  app.get('/api/messages', requireUser, (req, res) => {
    const list = db.messages.where((m) => m.userId === req.user.id).sort((a, b) => (a.ts < b.ts ? 1 : -1));
    res.json({ messages: list, unread: list.filter((m) => !m.read).length });
  });
  app.post('/api/messages/read', requireUser, (req, res) => {
    const ids = req.body.ids || [];
    let n = 0;
    for (const m of db.messages.where((m) => m.userId === req.user.id && !m.read)) {
      if (!ids.length || ids.includes(m.id)) { m.read = true; n += 1; }
    }
    res.json({ ok: true, marked: n });
  });

  // ---------- 用户申诉（受限账号的唯一申诉通道） ----------
  app.post('/api/user/appeals', requireUser, (req, res) => {
    try {
      res.json({ ok: true, appeal: risk.submitAppeal(db, { ...req.body, userId: req.user.id }) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.get('/api/user/appeals', requireUser, (req, res) => {
    res.json(db.appeals.where((a) => a.userId === String(req.user.id)).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)));
  });

  app.post('/api/tasks/complete', requireUser, (req, res) => {
    try {
      const { value, replay } = svc.completeTask(db, { ...req.body, userId: req.user.id });
      res.json({ ok: true, replay, ...value });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ---------- 广告激励（V4.0 · 2026-11 合规整改：看广告得贡献值，不可提现） ----------
  app.get('/api/ads/videos', requireUser, (req, res) => {
    try {
      const uid = req.user.id;
      const videos = adReward.listVideosForUser(db, uid);
      // 曝光埋点（域内按 用户×计划×日 去重）；埋点失败绝不阻断广告列表
      const ip = adReward.ipOf(req);
      for (const v of videos) {
        try { adCenter.trackEvent(db, { videoId: v.id, userId: uid, type: 'expose', ip }); } catch (_) { /* 埋点降级 */ }
      }
      // 观看历史 + 今日进度：给用户端「今日已看 / 上限」与最近记录
      const today = bizdate.today();
      const recs = db.adRewardRecords.where((r) => r.userId === uid && r.phase === 'rewarded')
        .sort((a, b) => (a.rewardedAt < b.rewardedAt ? 1 : -1));
      const history = recs.slice(0, 10).map((r) => {
        const vv = db.adVideos.get(r.videoId) || {};
        return { id: r.id, title: vv.title || '视频任务', points: r.amountFen || 0, date: r.date, rewardedAt: r.rewardedAt || '' };
      });
      res.json({
        videos,
        history,
        todayClaimed: recs.filter((r) => r.date === today).length,
        dailyLimit: Number(db.switches.get('adRewardDailyLimit')) || 0,
        enabled: db.switches.get('adRewardEnabled') === true,
        cash: adReward.cashInfo(db, uid),
      });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  /** 用户端显式事件：点卡片 / 跳商品点击（曝光与播放由上、下方接口自动落点） */
  app.post('/api/ads/videos/:id/event', requireUser, (req, res) => {
    try {
      const type = String(req.body?.type || '');
      if (!['click', 'product_click'].includes(type)) throw new Error('不支持的事件类型');
      adCenter.trackEvent(db, {
        videoId: req.params.id, userId: req.user.id, type, ip: adReward.ipOf(req),
      });
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/ads/videos/:id/start', requireUser, (req, res) => {
    try {
      const r = adReward.startWatch(db, { videoId: req.params.id, userId: req.user.id, ip: adReward.ipOf(req) });
      try { adCenter.trackEvent(db, { videoId: req.params.id, userId: req.user.id, type: 'start', ip: adReward.ipOf(req) }); } catch (_) { /* 埋点降级 */ }
      res.json({ ok: true, ...r });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/ads/videos/:id/reward', requireUser, (req, res) => {
    try {
      const r = adReward.reward(db, {
        videoId: req.params.id, userId: req.user.id, ip: adReward.ipOf(req),
        idempotencyKey: req.body && req.body.idempotencyKey,
      });
      try { adCenter.trackEvent(db, { videoId: req.params.id, userId: req.user.id, type: 'completed', ip: adReward.ipOf(req) }); } catch (_) { /* 埋点降级 */ }
      res.json({ ok: true, ...r });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.get('/api/ads/videos/:id/product', requireUser, (req, res) => {
    try {
      const p = adReward.productOfVideo(db, req.params.id);
      try { adCenter.trackEvent(db, { videoId: req.params.id, userId: req.user.id, type: 'product_click', ip: adReward.ipOf(req) }); } catch (_) { /* 埋点降级 */ }
      res.json({ product: pub(p) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.get('/api/user/cash', requireUser, (req, res) => {
    try { res.json(adReward.cashInfo(db, req.user.id)); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/user/realname', requireUser, (req, res) => {
    try {
      res.json({ ok: true, ...adReward.submitRealname(db, { userId: req.user.id, name: req.body?.name, idCard: req.body?.idCard }) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/user/reward-withdraw', requireUser, (req, res) => {
    try {
      const r = adReward.applyRewardWithdraw(db, {
        userId: req.user.id, fen: req.body?.fen, idempotencyKey: req.body?.idempotencyKey,
      });
      res.json({ ok: true, replay: r.replay, withdrawalId: r.withdrawal.id, status: r.withdrawal.status });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.get('/api/user/reward-withdrawals', requireUser, (req, res) => {
    try { res.json({ withdrawals: adReward.myRewardWithdrawals(db, req.user.id) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
};
