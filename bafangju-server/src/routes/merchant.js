'use strict';
/**
 * 商家端路由（异业联盟：券核销 / 广告位 / 收益提现 / 订单履约）。
 * 覆盖：商家登录、券与核销、广告位投放、收益与工作台、订单发货与核销、提现与收款人绑定。
 *
 * 合规要点：
 * - 鉴权中间件在本文件**第一个**注册（Express 按注册顺序匹配，注册在路由之后即被绕过 = P0-1 根因）；
 * - 豁免仅 /login；
 * - 水平越权防护：请求体/查询里的 merchantId、userId 必须与当前会话商家一致，否则 403；
 * - 初始 token / 初始口令仅在签发时返回一次，平台侧不长期明文留存。
 */
const fs = require('node:fs');
const path = require('node:path');

module.exports = function register(app, ctx) {
  const { db, audit, auth, wxmp, coupon, ad, quarter, merchant, fulfillment, orderIndex, withdraw, catalog, fenToYuan,
    adCenter, adReward, upload, UPLOAD_DIR } = ctx;

  // ---------- 商家端鉴权：除登录外全部接口需 Bearer token；越权访问他人数据 403 ----------
  app.use('/api/merchant', function merchantAuthGuard(req, res, next) {
    if (req.path === '/login') return next();
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : (req.query.token || (req.body && req.body.token));
    const m = merchant.merchantByToken(db, token);
    if (!m) return res.status(401).json({ error: '商家未登录或登录已失效' });
    if (m.status === 'disabled') return res.status(403).json({ error: '商家已被停用，请联系平台管理员' });
    req.merchant = m;
    const params = req.method === 'GET' ? req.query : (req.body || {});
    if (params.merchantId && String(params.merchantId) !== m.id) return res.status(403).json({ error: '无权操作其他商家数据' });
    if (params.userId && String(params.userId) !== m.id) return res.status(403).json({ error: '无权操作其他商家数据' });
    next();
  });

  // ---------- 登录 ----------
  app.post('/api/merchant/login', (req, res) => {
    try {
      const { merchant: m, replay } = merchant.merchantLogin(db, req.body || {});
      res.json({
        merchantId: m.id, name: m.name, username: m.username || m.name,
        token: m.token, mustChangePassword: !!m.mustChangePassword, replay,
      });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ---------- 我的入驻资料（只读）：已入驻商家在「我的 → 入驻资料」查看 ----------
  // 证照原图存私有目录、仅管理后台可查看，这里只回传「是否已提交」，不下发证照 URL。
  // 仅返回 req.merchant 的白名单字段，不 spread 整行（含 passwordHash / token）。
  app.get('/api/merchant/profile', (req, res) => {
    const m = req.merchant;
    const apps = db.merchantApplications.all()
      .filter((a) => a.merchantId === m.id || (a.status === 'approved' && a.name === m.name))
      .sort((x, y) => String(x.appliedAt || '').localeCompare(String(y.appliedAt || '')));
    const a = apps[apps.length - 1] || null;
    res.json({
      id: m.id, name: m.name, username: m.username || m.name,
      contact: m.contact || '', category: m.category || '', address: m.address || '',
      lat: m.lat == null ? null : m.lat, lng: m.lng == null ? null : m.lng,
      // 门店主页展示信息（V4.5 商家自助维护）
      coverUrl: m.coverUrl || '', intro: m.intro || '', businessHours: m.businessHours || '',
      phone: m.phone || '', profileUpdatedAt: m.profileUpdatedAt || null,
      status: m.status, createdAt: m.createdAt || null,
      mustChangePassword: !!m.mustChangePassword,
      entry: a ? {
        status: a.status, appliedAt: a.appliedAt || null, reviewedAt: a.reviewedAt || null,
        reviewReason: a.reviewReason || '', contact: a.contact || '', phone: a.phone || '',
        licenseSubmitted: !!a.licenseImgUrl, shopSubmitted: !!a.shopImgUrl,
      } : null,
    });
  });

  // ---------- 商家自助维护「门店主页」（V4.5）：门头照 / 营业时间 / 电话 / 地址 / 简介 ----------
  // 平台做本地展示与到店导流，门店信息由商家自己维护；名称与资质仍走后台/入驻审核。
  app.post('/api/merchant/shop', (req, res) => {
    try {
      const b = req.body || {};
      const m = merchant.updateShopProfile(db, {
        merchantId: req.merchant.id,
        coverUrl: b.coverUrl,
        intro: b.intro,
        businessHours: b.businessHours,
        phone: b.phone,
        address: b.address,
        lat: b.lat,
        lng: b.lng,
        operator: `merchant:${req.merchant.id}`,
      });
      res.json({
        ok: true,
        shop: {
          id: m.id, name: m.name, coverUrl: m.coverUrl || '', intro: m.intro || '',
          businessHours: m.businessHours || '', phone: m.phone || '',
          address: m.address || '', lat: m.lat == null ? null : m.lat, lng: m.lng == null ? null : m.lng,
          profileUpdatedAt: m.profileUpdatedAt || null,
        },
      });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ---------- 商家自助改密（V3.22）：改密成功后旧 token 立即失效，需重新登录 ----------
  app.post('/api/merchant/change-password', (req, res) => {
    try {
      merchant.merchantChangePassword(db, {
        merchantId: req.merchant.id,
        oldPassword: req.body.oldPassword,
        newPassword: req.body.newPassword,
      });
      res.json({ ok: true, mustRelogin: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ---------- 券：列表 / 发券 / 核销 / 联盟服务单 ----------
  app.get('/api/merchant/coupons', (req, res) => {
    res.json(coupon.listMerchantCoupons(db, req.merchant.id)
      .map((c) => ({ ...c, amountOffYuan: fenToYuan(c.amountOffFen || 0), minSpendYuan: fenToYuan(c.minSpendFen || 0) })));
  });

  // 发券（满减 / 折扣 / 次卡，V3.6）
  app.post('/api/merchant/coupons/create', (req, res) => {
    try {
      const c = coupon.createCoupon(db, { ...req.body, merchantId: req.merchant.id });
      res.json({ ok: true, coupon: c });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // 暂停/恢复发券（商家自助止损）：停发后用户端立即不可领，已领的券仍可正常核销
  app.post('/api/merchant/coupons/status', (req, res) => {
    try {
      const c = coupon.setCouponStatus(db, {
        merchantId: req.merchant.id,
        couponId: req.body.couponId,
        status: req.body.status,
        operator: `merchant:${req.merchant.id}`,
      });
      res.json({ ok: true, coupon: { id: c.id, status: c.status, statusUpdatedAt: c.statusUpdatedAt || null } });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // 核销前查券（无副作用）：展示券面 + 可用性，供核销页在填金额前确认
  app.get('/api/merchant/coupons/lookup', (req, res) => {
    try {
      res.json({ ok: true, ...coupon.lookupCoupon(db, { code: req.query.code, merchantId: req.merchant.id }) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // 到店核销（核销码 + 券前消费总额）→ 计优惠/应付 + 服务费应收单 + 方案 B 分佣
  app.post('/api/merchant/coupons/redeem', (req, res) => {
    try {
      const r = coupon.redeemCoupon(db, {
        code: req.body.code,
        amountFen: req.body.amountFen,
        merchantId: req.merchant.id,
        operator: `merchant:${req.merchant.id}`,
      });
      res.json({ ok: true, ...r });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // 服务费账单（只读）：应缴 / 已缴 / 明细，供商家对账缴款
  app.get('/api/merchant/fee-bills', (req, res) => {
    const month = req.query.month || undefined;
    // feeEnabled=false 时前端展示「平台不收取服务费」的说明，而不是让商家以为有欠费
    const couponRate = Number(db.switches.get('couponServiceFeeRate')) || 0;
    const verifyRate = Number(db.switches.get('verificationServiceFeeRate')) || 0;
    res.json({
      feeEnabled: couponRate > 0 || verifyRate > 0,
      rates: { couponRate, verifyRate },
      summary: coupon.feeBillSummary(db, { merchantId: req.merchant.id, month }),
      list: coupon.listFeeBills(db, { merchantId: req.merchant.id, month, limit: 100 })
        .map((b) => ({ ...b, grossFeeYuan: fenToYuan(b.grossFeeFen || 0), receivedYuan: fenToYuan(b.receivedFen || 0) })),
    });
  });

  // 联盟服务单（本店核销记录 + 服务费汇总）
  app.get('/api/merchant/alliance-orders', (req, res) => {
    const summary = coupon.serviceFeeSummary(db, { merchantId: req.merchant.id, month: req.query.month });
    res.json({
      summary,
      list: coupon.listAllianceOrders(db, { merchantId: req.merchant.id, month: req.query.month, limit: 100 }),
    });
  });

  app.post('/api/merchant/coupons/verify', (req, res) => {
    try {
      // merchantId 以会话为准（放在展开之后，忽略前端传值），域层会校验券归属，
      // 此前漏传导致该接口对任何券都报"券不属于当前商家"（死接口）。
      const { redemption, replay } = merchant.verifyCoupon(db, { ...req.body, merchantId: req.merchant.id });
      res.json({ ok: true, replay, redemption });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ---------- 广告位 ----------
  app.get('/api/merchant/adslots', (req, res) => {
    res.json(ad.listSlots(db).map((s) => ({ ...s, feePerCycleYuan: fenToYuan(s.feePerCycleFen || 0) })));
  });

  // 我的投放（含曝光/点击/CTR，V3.7）
  app.get('/api/merchant/adslots/mine', (req, res) => {
    res.json({
      summary: ad.adSummary(db, { merchantId: req.merchant.id }),
      list: ad.listMerchantBookings(db, req.merchant.id),
    });
  });

  // 轮播广告位自助预订已停用（V4.3 额度制）：改为「商家线下打款 → 平台发额度 → 平台代投」。
  // 路由保留并返回 410 + 白话提示，商家小程序旧版本提交时能看懂原因，而非 404。
  app.post('/api/merchant/adslots/book', (req, res) => {
    res.status(410).json({ error: '轮播广告已改为平台协助投放，请联系平台运营；您可以在「轮播广告」页面查看投放进度和效果。' });
  });

  // ---------- 我的商品（商家上传 → 平台审核 → 上架，V3.23） ----------
  // 可选类目（r 由平台定，商家只能选不能改，防虚报利润率）
  app.get('/api/merchant/categories', (req, res) => {
    res.json(catalog.adminListCategories(db).map((c) => ({ id: c.id, name: c.name, r: c.r, n: c.n })));
  });

  // 我的商品列表（含审核状态与驳回原因）
  app.get('/api/merchant/products', (req, res) => {
    res.json(catalog.listMerchantProducts(db, req.merchant.id)
      .map((p) => ({ ...p, priceYuan: fenToYuan(p.priceFen || 0), costYuan: fenToYuan(p.costFen || 0) })));
  });

  // 提交新商品（merchantId 以会话为准；提交后待平台审核，通过才上架）
  app.post('/api/merchant/products/create', (req, res) => {
    try {
      const p = catalog.submitProductByMerchant(db, { ...req.body, merchantId: req.merchant.id });
      res.json({ ok: true, product: p });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // 修改我的商品（保存后回到待审核，审核通过才恢复上架）
  app.post('/api/merchant/products/update', (req, res) => {
    try {
      const p = catalog.merchantUpdateProduct(db, { ...req.body, merchantId: req.merchant.id });
      res.json({ ok: true, product: p });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ---------- 收益与工作台 ----------
  app.get('/api/merchant/earnings', (req, res) => {
    const id = req.merchant.id;
    const acc = db.earnings.get(id) || { balanceFen: 0, frozenFen: 0, withdrawFrozenFen: 0 };
    res.json({
      balanceFen: acc.balanceFen, frozenFen: acc.frozenFen, withdrawFrozenFen: acc.withdrawFrozenFen || 0,
      debtFen: acc.debtFen || 0, withdrawBlocked: !!acc.withdrawBlocked,
      flows: db.earningFlows.where((f) => f.userId === id).sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, 50),
    });
  });

  // 商家工作台总览（真实聚合：券 / 核销 / 广告预订 / 收益 + 近 7 日核销趋势）
  app.get('/api/merchant/overview', (req, res) => {
    const id = req.merchant.id;
    const coupons = db.coupons.where((c) => c.merchantId === id);
    const redemptions = db.couponRedemptions.where((r) => r.merchantId === id);
    const bookings = db.adBookings.where((b) => b.merchantId === id);
    const acc = db.earnings.get(id) || {};
    const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const trend = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const key = dayKey(d);
      trend.push({
        date: key.slice(5).replace('-', '/'),
        count: redemptions.filter((r) => dayKey(new Date(r.ts)) === key).length,
      });
    }
    res.json({
      couponCount: coupons.length,
      couponValid: coupons.filter((c) => c.status === 'valid').length,
      redeemedCount: redemptions.length,
      adBookingCount: bookings.length,
      balanceFen: acc.balanceFen || 0,
      frozenFen: acc.frozenFen || 0,
      // 履约待办（V3.5）：待发货 / 待核销 —— 走聚合索引，避免两遍全表扫描
      ...orderIndex.merchantPending(db, id),
      trend,
    });
  });

  // ---------- 订单履约（发货 / 到店核销，V3.5） ----------
  app.get('/api/merchant/orders', (req, res) => {
    const mid = req.merchant.id;
    const status = req.query.status;
    const list = db.orders
      .where((o) => o.merchantId === mid && (!status || o.status === status))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, 100)
      .map((o) => {
        const p = db.products.get(o.productId) || {};
        return { ...o, productName: p.name || '', priceYuan: fenToYuan(o.priceFen), paidYuan: fenToYuan(o.paidFen) };
      });
    res.json(list);
  });

  app.post('/api/merchant/orders/ship', (req, res) => {
    try {
      const order = fulfillment.shipOrder(db, {
        orderId: req.body.orderId,
        company: req.body.company,
        trackingNo: req.body.trackingNo,
        operator: `merchant:${req.merchant.id}`,
        merchantId: req.merchant.id,
      });
      res.json({ ok: true, order: { id: order.id, status: order.status } });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/merchant/orders/verify', (req, res) => {
    try {
      const order = fulfillment.verifyStoreOrder(db, {
        orderId: req.body.orderId,
        verifyCode: req.body.verifyCode,
        operator: `merchant:${req.merchant.id}`,
        merchantId: req.merchant.id,
      });
      res.json({ ok: true, order: { id: order.id, status: order.status } });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ---------- 提现 ----------
  app.post('/api/merchant/withdraw/apply', (req, res) => {
    try {
      const { request, replay } = withdraw.applyWithdraw(db, { ...req.body, userId: req.merchant.id });
      res.json({ ok: true, replay, request });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.get('/api/merchant/withdraw/status', (req, res) => {
    res.json(withdraw.withdrawStatus(db, req.merchant.id));
  });

  app.post('/api/merchant/withdraw/confirm', (req, res) => {
    try {
      const t = withdraw.confirmTransfer(db, { ...req.body, userId: req.merchant.id });
      res.json({ ok: true, transfer: t });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ---------- 提现收款人 openid 绑定（商家工作台，单小程序双角色） ----------
  app.post('/api/merchant/withdraw/bind-receiver', async (req, res) => {
    try {
      let openid = req.body.openid;
      let devMode = false;
      if (req.body.code) {
        // 生产主通道：wx.login code → code2session（openid 仅服务端持有）。
        // V4.0 合并：商家工作台并入用户端小程序（同一 AppID），直接用用户端配置换取 openid；
        // 历史上两端 appid 分离的 WX_MERCHANT_* 通道已废弃。
        const wx = wxmp.getConfig(db);
        if (!wx.appid && String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
          return res.status(400).json({ error: '小程序 AppID/AppSecret 未配置（管理后台「系统设置-小程序码配置」或 WX_APPID / WX_SECRET），无法换取 openid' });
        }
        const session = await auth.code2session({ code: req.body.code, appid: wx.appid, secret: wx.secret });
        openid = session.openid;
        devMode = session.devMode;
      }
      const r = withdraw.bindReceiver(db, {
        userId: req.merchant.id, openid, name: req.body.name, operator: `merchant:${req.merchant.id}`,
      });
      audit(db, `merchant:${req.merchant.id}`, 'withdraw.bind_receiver_via', devMode ? 'dev_code' : (req.body.code ? 'wx_code' : 'manual'));
      res.json({ ok: true, devMode, ...r });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.get('/api/merchant/withdraw/receiver', (req, res) => {
    res.json(withdraw.receiverOf(db, req.merchant.id));
  });

  // ---------- 广告中心 V4.2：商家自助投放（额度制，不接在线支付）----------
  app.post('/api/merchant/upload/video', (req, res) => {
    try {
      const buf = upload.decodeVideoPayload(req.body?.dataBase64);
      const type = upload.detectVideoType(buf);
      if (!type) throw new upload.UploadError('仅支持 MP4 / MOV 视频（按文件真实内容判定）');
      upload.assertMinuteRate(`min:merchant:${req.merchant.id}`, 10);
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      const name = upload.randomFileName(type.ext);
      fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
      const url = `/uploads/${name}`;
      audit(db, `merchant:${req.merchant.id}`, 'merchant.upload_video', { tier: 'merchant', url, bytes: buf.length });
      res.json({ ok: true, url, bytes: buf.length });
    } catch (e) {
      res.status((e && e.status) || 400).json({ error: (e && e.message) || '上传失败' });
    }
  });

  /** 商家工作台：额度 + 自己的计划（含效果） + 结算单 + 计费预览所需配置 */
  app.get('/api/merchant/ad-center', (req, res) => {
    const mid = req.merchant.id;
    res.json({
      quota: adCenter.quotaOf(db, mid),
      videos: adCenter.listVideosForMerchant(db, mid),
      settlements: adCenter.listSettlements(db, { merchantId: mid }),
      shareRate: db.switches.get('adRewardShareRate'),
      chargePresetsFen: adReward.CHARGE_PRESETS_FEN,
    });
  });

  const mac = (fn) => (req, res) => {
    try { res.json({ ok: true, ...fn(req) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  };
  /** 越权护栏：任何计划操作都必须属于当前会话商家 */
  const ownVideo = (req) => {
    const v = db.adVideos.get(String(req.body?.videoId || ''));
    if (!v || v.merchantId !== req.merchant.id) throw new Error('无权操作该计划');
    return v;
  };

  app.post('/api/merchant/ad-videos/create', mac((req) => ({
    video: adCenter.merchantCreateVideo(db, { ...req.body, merchantId: req.merchant.id }),
  })));
  app.post('/api/merchant/ad-videos/material', mac((req) => {
    ownVideo(req);
    return { video: adCenter.updateVideoMaterial(db, { ...req.body, operator: `merchant:${req.merchant.id}` }) };
  }));
  app.post('/api/merchant/ad-videos/append-budget', mac((req) => ({
    video: adCenter.merchantAppendBudget(db, { ...req.body, merchantId: req.merchant.id }),
  })));
  app.get('/api/merchant/quota-flows', (req, res) => {
    const mid = req.merchant.id;
    res.json({
      flows: db.adQuotaFlows.where((f) => f.merchantId === mid)
        .sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, 100),
    });
  });
};
