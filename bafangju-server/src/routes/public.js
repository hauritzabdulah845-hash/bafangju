'use strict';
/**
 * 公开接口路由（无需登录即可访问）。
 * 覆盖：首页、商品与阶梯、附近商家、广告位、公开统计、贡献分公示、可领券列表、商家入驻申请。
 *
 * 合规要点：
 * - 身份一律取会话（attachUser 已挂 req.user），公开接口**不接受**前端传入的 userId 作为身份依据；
 * - 贡献分参考价值只作透明公示，接口内不得出现兑付/保本承诺；
 * - 入驻申请为公开提交入口：只落"申请单"，建档与初始口令必须由管理员审核通过后签发；
 * - 已拼件数等销量类数据取自真实订单聚合索引，不允许出现虚构销量。
 */
module.exports = function register(app, ctx) {
  const { db, svc, ad, ladder, coupon, nearby, quarter, orderIndex, catalog, merchant, fenToYuan, ops, content } = ctx;

  // ---------- 健康检查探针（负载均衡/Nginx/PM2 探活；无需鉴权，不泄露敏感信息） ----------
  app.get('/api/health', (req, res) => {
    let dbOk = false;
    try { dbOk = Array.isArray(db.users.all()); } catch (e) { /* ignore */ }
    res.status(dbOk ? 200 : 503).json({
      ok: dbOk,
      ts: Date.now(),
      uptime: Math.floor(process.uptime()),
      version: require('../../package.json').version,
      // 不返回存储驱动等实现细节（防信息泄露）
    });
  });

  // ---------- 首页 / 商品 ----------
  app.get('/api/home', (req, res) => {
    const switches = Object.fromEntries(db.switches);
    const stdOrder = catalog.DEFAULT_CATEGORIES.map((d) => d.name);
    const cats = [...db.categories.all()];
    // 排序：标准本地生活类目按预置顺序在前（供首页金刚区 5×2 宫格），其余类目排后（仅胶囊条展示）
    cats.sort((a, b) => {
      const ia = stdOrder.indexOf(a.name), ib = stdOrder.indexOf(b.name);
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    });
    res.json({
      banner: ad.listAdsForPosition(db, 'home_banner'),
      categories: cats.map((c) => ({ id: c.id, name: c.name, r: c.r, n: ladder.stepCount(c.r), icon: c.icon || '', iconImage: c.iconImage || '' })),
      switches, // 前端按开关渲染（auditDowngrade 时隐藏分红/团队入口）
      downgrade: switches.auditDowngrade === true,
      opsSlides: ops.listOpsSlides(db), // 首页轮播运营帧（后台可配；为空时前端用内置兜底）
      rulesVersion: svc.currentRules(db).version, // 规则版本（下单前确认用，V3.3 §5.2-1）
    });
  });

  // ---------- 规则版本（公开只读；确认留档需登录，见 routes/user.js） ----------
  app.get('/api/rules/version', (req, res) => res.json(svc.currentRules(db)));

  // ---------- 备案信息（公安联网备案 / ICP）：公开只读，号留空时对应项为 null ----------
  app.get('/api/filing', (req, res) => res.json(content.filingInfo(db)));

  // ---------- 文案配置（后台可编辑；留空的 key 由小程序内置文案兜底）----------
  app.get('/api/content', (req, res) => res.json(content.listContent(db)));

  // ---------- 广告位展示与曝光/点击（V3.7，公开接口） ----------
  app.get('/api/ads', (req, res) => {
    res.json(ad.listAdsForPosition(db, String(req.query.position || 'home_banner')));
  });
  app.post('/api/ads/impression', (req, res) => {
    // 已登录用户以会话为准（防伪造 userId 干扰去重）；未登录可传匿名 userId 仅用于去重
    res.json(ad.recordImpression(db, { bookingId: req.body.bookingId, userId: req.user ? req.user.id : (req.body.userId || null) }));
  });
  app.post('/api/ads/click', (req, res) => {
    res.json(ad.recordClick(db, { bookingId: req.body.bookingId, userId: req.user ? req.user.id : (req.body.userId || null) }));
  });

  app.get('/api/products', (req, res) => {
    const { categoryId } = req.query;
    // 身份来自会话（attachUser 已解析），不再信任 query 里的 userId
    const userId = req.user ? req.user.id : null;
    const list = db.products.where((p) => p.status === 'on_sale' && (!categoryId || p.categoryId === categoryId));
    res.json(list.map((p) => {
      // 成本项（costFen/税费率/单均运营成本）与审核内部字段属商家/平台机密，不得下发到用户端
      const { costFen, taxFeeRate, opCostFen, submittedAt, reviewedAt, reviewNote, ...pubP } = p;
      const cat = db.categories.get(p.categoryId);
      const n = ladder.stepCount(cat.r);
      const step = userId ? svc.currentStep(db, userId, cat.id).step : 1;
      // 已拼件数：该商品有效支付订单数（真实数据，非虚构销量）—— 走聚合索引，避免逐商品全表扫描
      const sold = orderIndex.soldCount(db, p.id);
      return { ...pubP, priceYuan: fenToYuan(p.priceFen), n, total: n + ladder.REBATE_RATES.length, nextPayFen: ladder.priceAtStep(p.priceFen, n, step), myStep: step, soldCount: sold };
    }));
  });

  app.get('/api/products/:id', (req, res) => {
    const p = db.products.get(req.params.id);
    // 待审核 / 已驳回的商品尚未上架，对用户端一律视为不存在（防按 ID 直接探测未过审商品）
    if (!p || ['pending_review', 'rejected'].includes(p.status)) return res.status(404).json({ error: 'not found' });
    const { costFen, taxFeeRate, opCostFen, submittedAt, reviewedAt, reviewNote, ...pubP } = p;
    const cat = db.categories.get(p.categoryId);
    const n = ladder.stepCount(cat.r);
    const userId = req.user ? req.user.id : null;
    const step = userId ? svc.currentStep(db, userId, cat.id).step : 1;
    res.json({
      ...pubP, priceYuan: fenToYuan(p.priceFen), n, total: n + ladder.REBATE_RATES.length, myStep: step,
      nextPayFen: ladder.priceAtStep(p.priceFen, n, step),
      ladderExampleFen: ladder.ladderTable(p.priceFen, n), // 示例阶梯（前 n 单全价，后 4 单让利 10/20/30/40%）
    });
  });

  // ---------- 附近商家（异业联盟 · 本地生活，公开接口；登录态仅用于券领取状态） ----------
  // 注意：/api/merchants/nearby 必须先于 /api/merchants/:id 注册，否则会被通配路由吃掉
  app.get('/api/merchants/nearby', (req, res) => {
    const r = nearby.nearbyMerchants(db, {
      lat: req.query.lat, lng: req.query.lng,
      radiusM: req.query.radius, keyword: req.query.keyword, category: req.query.category,
      userId: req.user ? req.user.id : null,
    });
    res.json(r);
  });

  app.get('/api/merchants/:id', (req, res) => {
    const r = nearby.merchantDetail(db, {
      merchantId: req.params.id, lat: req.query.lat, lng: req.query.lng,
      userId: req.user ? req.user.id : null,
    });
    if (!r) return res.status(404).json({ error: '商家不存在或已停用' });
    res.json(r);
  });

  // ---------- 阶梯进度公示（公开只读，登录后返回本人步位） ----------
  app.get('/api/ladder', (req, res) => {
    const { categoryId } = req.query;
    const cat = db.categories.get(categoryId);
    if (!cat) return res.status(404).json({ error: 'category not found' });
    const n = ladder.stepCount(cat.r);
    const userId = req.user ? req.user.id : null;
    const cur = userId ? svc.currentStep(db, userId, cat.id) : { step: 1, done: 0 };
    res.json({ categoryId, r: cat.r, n, total: n + ladder.REBATE_RATES.length, myStep: cur.step, done: cur.done });
  });

  // ---------- 分红池余额公示（只读，不构成兑付承诺） ----------
  app.get('/api/dividend/pool', (req, res) => {
    res.json({ balanceFen: svc.poolBalanceFen(db), balanceYuan: fenToYuan(svc.poolBalanceFen(db)) });
  });

  // ---------- 官网公开统计（真实聚合：在营商家 / 注册用户 / 累计为居民节省） ----------
  app.get('/api/stats/public', (req, res) => {
    const merchants = db.merchants.where((m) => m.status === 'active').length;
    const users = db.users.all().length;
    let savedFen = 0;
    for (const o of db.orders.all()) {
      if (o.status !== 'refunded' && o.status !== 'cancelled' && o.status !== 'pending_pay') {
        savedFen += Math.max(0, (o.priceFen || 0) - (o.paidFen || 0));
      }
    }
    res.json({ merchants, users, savedFen, savedYuan: fenToYuan(savedFen) });
  });

  // ---------- 贡献分参考价值（只读公示，无兑付入口） ----------
  app.get('/api/contribution/value', (req, res) => {
    const fen = quarter.contributionUnitValueFen(db);
    const totalWeight = db.contributions.all().reduce((s, c) => s + c.weight, 0);
    res.json({
      unitValueFen: fen,
      unitValueYuan: fen == null ? null : fenToYuan(fen),
      totalWeight,
      notice: '贡献分单位参考价值仅作透明公示，不构成任何兑换或兑付承诺；兑现唯一通道为季度分红；不承诺只涨不跌。',
    });
  });

  // ---------- 联盟券（用户端可领券列表，公开浏览；领券动作需登录，见 routes/user.js） ----------
  app.get('/api/coupons/available', (req, res) => {
    res.json(coupon.listAvailableCoupons(db, { userId: req.user ? req.user.id : null, merchantId: req.query.merchantId }));
  });

  // ---------- 商家入驻资质（公开提交 → 管理员审核 → 通过建档） ----------
  app.post('/api/merchant-entry/apply', (req, res) => {
    try {
      res.json({ ok: true, application: merchant.submitEntryApplication(db, req.body || {}) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ---------- 入驻进度查询：名称 + 手机号双因子匹配，只回状态/时间/驳回原因 ----------
  // 申请人未注册、无登录态，提交后只能"干等平台通知"是断点；此接口让商家可自助查进度。
  // 信息暴露面刻意收窄：不返回证照、联系人、地址等任何申请内容，仅状态三态。
  app.get('/api/merchant-entry/status', (req, res) => {
    const name = String(req.query.name || '').trim();
    const phone = String(req.query.phone || '').trim();
    if (!name || !phone) return res.status(400).json({ error: '请填写商家名称与申请时联系电话' });
    const list = db.merchantApplications.all()
      .filter((a) => a.name === name && a.phone === phone)
      .sort((x, y) => String(x.appliedAt || '').localeCompare(String(y.appliedAt || '')));
    const a = list[list.length - 1];
    if (!a) return res.json({ found: false });
    res.json({
      found: true,
      status: a.status, // pending_review | approved | rejected
      appliedAt: a.appliedAt,
      reviewedAt: a.reviewedAt || null,
      reviewReason: a.status === 'rejected' ? (a.reviewReason || '') : '',
    });
  });
};
