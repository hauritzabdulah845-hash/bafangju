'use strict';
/**
 * 管理后台路由（运营/管理员专用）。
 * 覆盖：登录会话、系统开关与审计、任务配置、商品类目、风控、商家管理与入驻审核、
 *       广告位、提现审批、订单与履约、分佣结算、平台流水、经济预览。
 *
 * 合规要点：
 * - 鉴权中间件在本文件**第一个**注册（Express 按注册顺序匹配，注册在路由之后即被绕过 = P0-1 根因）；
 * - 豁免仅两个：/login（登录）、/logout（登出幂等：会话已失效也要返回 200，前端才能正常退出）；
 * - 所有敏感操作（改价、改 r、开关变更、风控处置、提现审批）必须留审计；
 * - 入驻证照私有文件不挂静态路由，仅本鉴权链路可查看（P0-3）。
 */
const fs = require('node:fs');
const path = require('node:path');

module.exports = function register(app, ctx) {
  const {
    db, audit, svc, adminAuth, loginLimiter, bizdate, wxmp, risk, coupon, ad, ladder, quarter, dividend,
    commission, transfer, merchant, fulfillment, orderIndex, withdraw, levelDomain, catalog, ops, content,
    fenToYuan, ensureWxRefund, PRIVATE_UPLOAD_DIR, UPLOAD_DIR, upload, adReward, adCenter, adminUsers,
    refund, applyRefundResult, syncRefundOrder,
  } = ctx;

  // ---------- 管理后台鉴权（必须先于本文件所有 /api/admin/* 路由注册） ----------
  // 两级账号：总账号（adminAccounts/adminSessions，全场唯一，权限恒为全部）
  //           子管理员（adminUsers，按模块授权，可随时停用且即时生效）
  app.use('/api/admin', function adminAuthGuard(req, res, next) {
    const p = req.path.replace(/\/+$/, '') || '/';
    if (p === '/login') return next();
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : (req.query.token || (req.body && req.body.token));
    req.adminToken = token;
    const s = adminAuth.sessionByToken(db, token);
    if (s) {
      const acc = db.adminAccounts.get(s.username);
      req.admin = {
        uid: (acc && acc.uid) || s.username,
        username: s.username, role: 'super', permissions: 'all',
      };
      return next();
    }
    const u = adminUsers.userByToken(db, token);
    if (u) {
      // 子管理员：按「请求路径 → 模块权限」实时判定（停用/改权限下一次请求即生效）
      const need = adminUsers.permsRequired(req.method, p);
      if (need === 'super') return res.status(403).json({ error: '该功能仅系统总账号可操作' });
      if (need !== 'any') {
        const allowed = Array.isArray(need) ? need : [need];
        const ok = allowed.some((k) => (u.permissions || []).includes(k));
        if (!ok) {
          const hint = allowed.includes('finance')
            ? '该操作需「财务复核」权限（或由总账号操作），请联系总账号开通'
            : '当前账号没有该模块的权限，请联系总账号开通';
          return res.status(403).json({ error: hint });
        }
      }
      req.admin = {
        uid: u.uid || u.id,
        username: u.id, role: 'admin', permissions: u.permissions || [],
      };
      return next();
    }
    if (p === '/logout') return next(); // 登出幂等，不泄露会话状态
    return res.status(401).json({ error: '管理后台未登录或会话已失效' });
  });

  // ---------- 会话 ----------
  app.post('/api/admin/login', (req, res) => {
    const ip = (req.ip || req.socket?.remoteAddress || 'unknown').replace(/^::ffff:/, '');
    const username = String(req.body?.username || '');

    // 1) 限流前置：双维度（IP + 账号）；锁定期间一律 429，不透露是口令错还是被锁
    const block = loginLimiter.checkAllowed({ ip, username });
    if (block) {
      audit(db, 'admin', 'admin.login_locked', {
        username: username || null, ip, reason: block.reason, retryAfterSec: block.retryAfterSec,
      });
      res.set('Retry-After', String(block.retryAfterSec));
      return res.status(429).json({ error: '账号或密码错误（尝试过于频繁）' });
    }

    // 2) 口令校验 + 签发 token（adminAuth.login 内部已写 admin.login_failed / admin.login 审计）
    //    子管理员账号走独立校验链路：先判账号归属，避免两条链路互相写失败审计。
    try {
      const isSub = !!db.adminUsers.get(String(req.body?.username || '').trim());
      const r = isSub
        ? adminUsers.login(db, { username: req.body.username, password: req.body.password, ip })
        : adminAuth.login(db, { username: req.body.username, password: req.body.password });
      loginLimiter.recordSuccess({ ip, username }); // 成功即清零该 IP + 账号的失败计数
      // 统一响应口径：前端据此判断角色（总账号恒为全部权限）
      res.json(isSub ? r : { ...r, role: 'super', permissions: adminUsers.PERM_KEYS });
    } catch (e) {
      const { ipLocked, accountLocked } = loginLimiter.recordFailure({ ip, username });
      // 审计由 adminAuth.login_failed 已覆盖；此处仅记锁定事件（避免重复写 admin.login_failed）
      if (ipLocked || accountLocked) {
        audit(db, 'admin', 'admin.login_lock_triggered', { username: username || null, ip, ipLocked, accountLocked });
      }
      res.status(401).json({ error: e.message });
    }
  });

  app.post('/api/admin/logout', (req, res) => {
    adminUsers.logout(db, req.adminToken || ''); // 子管理员会话（总账号会话由 adminAuth 处理）
    res.json({ ok: adminAuth.logout(db, req.adminToken || '') });
  });

  // 当前身份：前端据此隐藏无权限的菜单（服务端仍逐请求拦截，前端只是展示层）
  app.get('/api/admin/me', (req, res) => {
    const isSuper = req.admin.role === 'super';
    res.json({
      uid: req.admin.uid,
      username: req.admin.username,
      role: isSuper ? 'super' : 'admin',
      permissions: isSuper ? adminUsers.PERM_KEYS : req.admin.permissions,
      permCatalog: adminUsers.PERMS,
    });
  });

  // ---------- 子管理员账号管理（仅总账号；守卫按 /users → super 拦截） ----------
  app.get('/api/admin/users', (req, res) => {
    res.json({ users: adminUsers.list(db), perms: adminUsers.PERMS });
  });
  app.post('/api/admin/users/create', (req, res) => {
    try {
      const b = req.body || {};
      const u = adminUsers.create(db, {
        username: b.username, password: b.password,
        permissions: b.permissions, note: b.note,
        actor: req.admin.username, actorId: req.admin.uid,
      });
      res.json({ ok: true, user: u });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/admin/users/update', (req, res) => {
    try {
      const b = req.body || {};
      const u = adminUsers.update(db, {
        username: b.username, permissions: b.permissions, enabled: b.enabled,
        note: b.note, actor: req.admin.username, actorId: req.admin.uid,
      });
      res.json({ ok: true, user: u });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/admin/users/reset-password', (req, res) => {
    try {
      const b = req.body || {};
      res.json(adminUsers.resetPassword(db, {
        username: b.username, newPassword: b.newPassword,
        actor: req.admin.username, actorId: req.admin.uid,
      }));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/admin/users/delete', (req, res) => {
    try {
      res.json(adminUsers.remove(db, {
        username: (req.body || {}).username,
        actor: req.admin.username, actorId: req.admin.uid,
      }));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/admin/change-password', (req, res) => {
    try {
      const r = adminAuth.changePassword(db, {
        username: req.admin.username, oldPassword: req.body.oldPassword,
        newPassword: req.body.newPassword, revokeOthers: true,
      });
      res.json({ ok: true, ...r, note: '密码已更新，所有会话已失效，请重新登录' });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ---------- 规则版本与等级门槛（后台可配） ----------
  app.get('/api/admin/rules', (req, res) => {
    res.json({ ...svc.currentRules(db), confirmations: db.ruleConfirmations.all().length });
  });

  // 等级门槛配置（V3.3 §4.9，后台可配；须递增）
  app.get('/api/admin/level-config', (req, res) => {
    const th = levelDomain.thresholdsOf(db.switches.get('levelThresholds'));
    res.json({ levels: levelDomain.LEVELS.map((l) => ({ ...l, threshold: th[l.level] })) });
  });
  app.post('/api/admin/level-config', (req, res) => {
    try {
      const input = req.body.thresholds || req.body || {};
      const next = {};
      let prev = 0;
      for (const l of ctx.levelDomain.LEVELS) {
        const v = Number(input[l.level]);
        if (!Number.isInteger(v) || v <= prev) throw new Error(`${l.level} 门槛需为大于上一档的整数`);
        if (v > 1e9) throw new Error('门槛数值过大');
        next[l.level] = v;
        prev = v;
      }
      db.switches.set('levelThresholds', next);
      audit(db, req.admin.username, 'level.config', { thresholds: next });
      res.json({ ok: true, levels: levelDomain.LEVELS.map((l) => ({ ...l, threshold: next[l.level] })) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/admin/rules/version', (req, res) => {
    try {
      const v = String(req.body.version || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error('版本号格式应为 YYYY-MM-DD');
      db.switches.set('rulesVersion', v);
      db.switches.set('rulesUpdatedAt', new Date().toISOString());
      audit(db, req.admin.username, 'rules.version', { version: v });
      res.json({ ok: true, ...svc.currentRules(db) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ---------- 小程序码配置（读写 + 立即自测） ----------
  app.get('/api/admin/settings/wxmp', (req, res) => {
    res.json(wxmp.mask(wxmp.getConfig(db)));
  });
  app.post('/api/admin/settings/wxmp', (req, res) => {
    try {
      const { appid, secret, operator = 'admin' } = req.body || {};
      res.json(wxmp.saveConfig(db, { appid, secret, operator }));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/admin/settings/wxmp/test', async (req, res) => {
    try {
      const r = await wxmp.getQrcode(db, { userId: req.body.userId || 'test', force: true });
      res.json({ ok: !r.devMode, ...r });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  // ---------- 系统公告（站内消息为通知兜底通道） ----------
  app.post('/api/admin/messages/broadcast', (req, res) => {
    try {
      res.json({ ok: true, ...svc.broadcastMessage(db, { ...req.body, operator: req.admin.username }) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.get('/api/admin/messages', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    res.json([...db.messages.all()].sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, limit));
  });

  // ---------- 开关与审计 ----------
  app.post('/api/admin/switches', (req, res) => {
    const { key, value, operator = 'admin' } = req.body || {};
    if (!db.switches.has(key)) return res.status(400).json({ error: 'unknown switch: ' + key });
    const old = db.switches.get(key);
    db.switches.set(key, value);
    audit(db, operator, 'switch.change', { key, from: old, to: value });
    res.json({ ok: true });
  });

  app.get('/api/admin/audit', (req, res) => res.json(db.auditLogs.slice(-200).reverse()));

  // 任务配置（V3.15，§8.2-1）：奖励值、连击奖励、广告任务开关，后台可配并留审计
  app.get('/api/admin/task-config', (req, res) => {
    res.json({
      rewards: db.switches.get('taskRewards'),
      streakBonus: db.switches.get('taskStreakBonus'),
      adTaskEnabled: db.switches.get('adTaskEnabled') === true,
    });
  });
  app.post('/api/admin/task-config', (req, res) => {
    try {
      const body = req.body || {};
      if (body.rewards) {
        const next = { ...(db.switches.get('taskRewards') || {}) };
        for (const k of ['sign_in', 'browse', 'ad', 'share']) {
          if (body.rewards[k] === undefined) continue;
          const v = Number(body.rewards[k]);
          if (!Number.isFinite(v) || v < 0 || v > 10000) throw new Error(`${k} 奖励值需为 0-10000`);
          next[k] = Math.floor(v);
        }
        db.switches.set('taskRewards', next);
      }
      if (body.streakBonus) {
        const days = Number(body.streakBonus.days);
        const reward = Number(body.streakBonus.reward);
        if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('连击天数需为 1-365 的整数');
        if (!Number.isFinite(reward) || reward < 0 || reward > 10000) throw new Error('连击奖励需为 0-10000');
        db.switches.set('taskStreakBonus', { days, reward: Math.floor(reward) });
      }
      if (body.adTaskEnabled !== undefined) db.switches.set('adTaskEnabled', body.adTaskEnabled === true);
      audit(db, req.admin.username, 'task.config', body);
      res.json({
        ok: true,
        config: {
          rewards: db.switches.get('taskRewards'),
          streakBonus: db.switches.get('taskStreakBonus'),
          adTaskEnabled: db.switches.get('adTaskEnabled') === true,
        },
      });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // 写操作统一兜底：域层抛错即 400 + 错误文案（敏感操作已在域内留审计）
  const guard = (fn) => (req, res) => {
    try { fn(req, res); } catch (e) { res.status(400).json({ error: e.message }); }
  };

  // ---------- 文案配置（改文案不用发版；留空 = 用小程序内置文案）----------
  app.get('/api/admin/content', (req, res) => res.json(content.adminListContent(db)));
  app.post('/api/admin/content/update', guard((req, res) => {
    res.json(content.setContent(db, { key: req.body.key, body: req.body.body, operator: req.admin.username }));
  }));
  app.post('/api/admin/content/reset', guard((req, res) => {
    res.json(content.resetContent(db, { key: req.body.key, operator: req.admin.username }));
  }));

  // ---------- 首页运营位：轮播运营帧（后台可配，改活动不用发版）----------
  app.get('/api/admin/ops-slides', (req, res) => {
    res.json({ slides: ops.adminListOpsSlides(db), actions: ops.ACTIONS, tones: ops.TONES });
  });
  const opsGuard = guard; // 兼容运营位块的既有写法
  app.post('/api/admin/ops-slides', opsGuard((req, res) => {
    res.json({ ok: true, slide: ops.createOpsSlide(db, { ...req.body, operator: req.admin.username }) });
  }));
  app.post('/api/admin/ops-slides/update', opsGuard((req, res) => {
    res.json({ ok: true, slide: ops.updateOpsSlide(db, { ...req.body, operator: req.admin.username }) });
  }));
  app.post('/api/admin/ops-slides/delete', opsGuard((req, res) => {
    res.json(ops.deleteOpsSlide(db, { id: req.body.id, operator: req.admin.username }));
  }));
  app.post('/api/admin/ops-slides/move', opsGuard((req, res) => {
    res.json({ ok: true, slides: ops.moveOpsSlide(db, { id: req.body.id, dir: req.body.dir, operator: req.admin.username }) });
  }));

  // ---------- 后台素材上传（运营帧图 / 类目图标；落公开目录，审计留痕）----------
  app.post('/api/admin/upload', (req, res) => {
    try {
      const buf = upload.decodeImagePayload(req.body?.dataBase64);
      const type = upload.detectImageType(buf);
      if (!type) throw new upload.UploadError('仅支持 PNG/JPEG/WEBP 图片（按文件真实内容判定）');
      const ip = upload.clientIp(req);
      upload.assertMinuteRate(`min:admin:${req.admin.username}`, 30);
      upload.assertMinuteRate(`min:ip:${ip}`, 60);
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      const name = upload.randomFileName(type.ext);
      fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
      const url = `/uploads/${name}`;
      audit(db, req.admin.username, 'upload.image', { tier: 'admin', purpose: 'material', url, bytes: buf.length, ext: type.ext });
      res.json({ ok: true, url, ext: type.ext, bytes: buf.length });
    } catch (e) {
      res.status((e && e.status) || 400).json({ error: (e && e.message) || '上传失败' });
    }
  });

  // ---------- 商品/类目管理（运营自助上架；全部操作审计留痕） ----------
  app.get('/api/admin/catalog/products', (req, res) => res.json(catalog.adminListProducts(db)));
  app.get('/api/admin/catalog/categories', (req, res) => res.json(catalog.adminListCategories(db)));

  app.post('/api/admin/catalog/categories', (req, res) => {
    try {
      const c = catalog.createCategory(db, { ...req.body, operator: req.admin.username });
      res.json({ ok: true, category: c });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/admin/catalog/categories/update', (req, res) => {
    try {
      const c = catalog.updateCategory(db, { ...req.body, operator: req.admin.username });
      res.json({ ok: true, category: c });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/admin/catalog/products', (req, res) => {
    try {
      const p = catalog.createProduct(db, { ...req.body, operator: req.admin.username });
      res.json({ ok: true, product: p });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/admin/catalog/products/update', (req, res) => {
    try {
      const p = catalog.updateProduct(db, { ...req.body, operator: req.admin.username });
      res.json({ ok: true, product: p });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // 商家商品审核（V3.23）：待审队列 + 通过/驳回；审核时务必先「算账」看平台留存（防虚高标价再让利）
  app.get('/api/admin/catalog/products/pending', (req, res) => {
    res.json(catalog.listPendingProducts(db)
      .map((p) => ({ ...p, priceYuan: fenToYuan(p.priceFen || 0), costYuan: fenToYuan(p.costFen || 0) })));
  });

  app.post('/api/admin/catalog/products/review', (req, res) => {
    try {
      const p = catalog.reviewProductSubmission(db, {
        productId: req.body.productId,
        approved: req.body.approved === true,
        note: req.body.note,
        operator: req.admin.username,
      });
      res.json({ ok: true, product: p });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ---------- 风控（管理） ----------
  app.post('/api/admin/risk/blacklist', (req, res) => {
    try {
      res.json({ ok: true, ...risk.setBlacklist(db, { ...req.body, operator: req.admin.username }) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.get('/api/admin/risk/blacklist', (req, res) => res.json(db.blacklist.all()));
  app.get('/api/admin/risk/appeals', (req, res) => {
    res.json([...db.appeals.all()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)));
  });
  app.post('/api/admin/risk/appeals/resolve', (req, res) => {
    try {
      res.json({ ok: true, appeal: risk.resolveAppeal(db, { ...req.body, operator: req.admin.username }) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/admin/jobs/risk-scan', (req, res) => {
    const alerts = risk.detectLoopFreeOrders(db, req.body || {});
    res.json({ ok: true, alerts });
  });
  app.get('/api/admin/risk/alerts', (req, res) => {
    res.json([...db.riskAlerts.all()].sort((a, b) => (a.ts < b.ts ? 1 : -1)));
  });

  // ---------- 商家结算单（按自然月汇总，只读） ----------
  app.get('/api/admin/merchants/settlement', (req, res) => {
    const merchantId = String(req.query.merchantId);
    const month = req.query.month || bizdate.monthOf(); // 北京时间 YYYY-MM
    const inMonth = (ts) => bizdate.monthOfIso(ts) === month;
    const flows = db.earningFlows.where((f) => f.userId === merchantId && inMonth(f.ts));
    const ads = db.adBookings.where((b) => b.merchantId === merchantId && inMonth(b.bookedAt || b.ts));
    const ws = db.withdrawRequests.where((r) => r.userId === merchantId && inMonth(r.appliedAt));
    const sum = (arr, key) => arr.reduce((s, x) => s + (x[key] || 0), 0);
    // 联盟服务费（V3.6）：券核销产生的 3%/5% 服务费，按月汇总进结算单
    const fee = coupon.serviceFeeSummary(db, { merchantId, month });
    res.json({
      merchantId, month,
      earnedBalanceYuan: fenToYuan(sum(flows.filter((f) => f.status === 'balance'), 'fen')),
      earnedFrozenYuan: fenToYuan(sum(flows.filter((f) => f.status === 'frozen'), 'fen')),
      adSpendYuan: fenToYuan(sum(ads, 'feeFen')),
      withdrawAppliedYuan: fenToYuan(sum(ws, 'fen')),
      withdrawDoneFen: ws.reduce((s, r) => s + (r.status === 'done' ? r.fen : 0), 0),
      orderFlowCount: flows.length,
      // 券核销：核销单数 / 核销金额 / 券服务费 / 核销服务费（均为元）
      allianceCount: fee.count,
      allianceAmountYuan: fenToYuan(fee.amountFen),
      couponServiceFeeYuan: fenToYuan(fee.couponServiceFeeFen),
      verifyServiceFeeYuan: fenToYuan(fee.verifyServiceFeeFen),
      serviceFeeTotalYuan: fenToYuan(fee.couponServiceFeeFen + fee.verifyServiceFeeFen),
      generatedAt: new Date().toISOString(),
      notice: '本结算单为站内记账汇总（只读），不作为税务凭证；发票事项以双方协议约定为准（待确认 24）。',
    });
  });

  // 联盟服务单（后台）：券核销记录 + 服务费汇总（V3.6）
  app.get('/api/admin/alliance-orders', (req, res) => {
    const merchantId = req.query.merchantId ? String(req.query.merchantId) : null;
    const month = req.query.month || null;
    res.json({
      summary: coupon.serviceFeeSummary(db, { merchantId, month }),
      list: coupon.listAllianceOrders(db, { merchantId, limit: 100 }),
    });
  });

  // 联盟服务费应收台账（V4.4）：核销挂账 → 后台确认收款 → 才划储备专户
  app.get('/api/admin/merchant-fee-bills', (req, res) => {
    const merchantId = req.query.merchantId ? String(req.query.merchantId) : null;
    const month = req.query.month || null;
    const status = req.query.status || null;
    res.json({
      summary: coupon.feeBillSummary(db, { merchantId, month }),
      list: coupon.listFeeBills(db, { merchantId, month: month || undefined, status, limit: 200 })
        .map((b) => ({ ...b, grossFeeYuan: fenToYuan(b.grossFeeFen || 0), receivedYuan: fenToYuan(b.receivedFen || 0) })),
    });
  });

  // 确认单笔服务费已收（线下转账/微信/其他），收款后才写平台留存 + 储备专户
  app.post('/api/admin/merchant-fee-bills/pay', (req, res) => {
    try {
      const r = coupon.markFeeBillPaid(db, {
        billId: req.body.billId,
        receivedFen: req.body.receivedFen,
        method: req.body.method,
        note: req.body.note,
        operator: `admin:${req.admin ? req.admin.username : 'admin'}`,
      });
      res.json({ ok: true, ...r });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // 按月批量确认收款（月度对账：该商家当月所有待收单一次性核销）
  app.post('/api/admin/merchant-fee-bills/pay-month', (req, res) => {
    try {
      const r = coupon.markFeeBillsPaidByMonth(db, {
        merchantId: req.body.merchantId,
        month: req.body.month,
        method: req.body.method,
        note: req.body.note,
        operator: `admin:${req.admin ? req.admin.username : 'admin'}`,
      });
      res.json({ ok: true, ...r });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ---------- 跑批（后台手动触发） ----------
  app.post('/api/admin/jobs/activity-snapshot', (req, res) => {
    const count = svc.snapshotActivity(db, req.body.date);
    audit(db, 'admin', 'job.activity_snapshot', { date: req.body.date, users: count });
    res.json({ ok: true, activeUsers: count });
  });

  app.post('/api/admin/jobs/daily-dividend', (req, res) => {
    const date = req.body.date || bizdate.today();
    const result = dividend.dailyPayout(db, {
      date,
      poolBalanceFen: svc.poolBalanceFen(db),
      dailyRatio: db.switches.get('queueDividendDailyRatio'),
      maxSeats: db.switches.get('queueDividendDailySeats'),
      isUserActive: (userId, d) => svc.isUserActive(db, userId, d),
    });
    audit(db, 'admin', 'job.daily_dividend', { date, ...result, payouts: undefined });
    res.json(result);
  });

  // 团队长辅导分红池：余额/贡献查询
  app.get('/api/admin/leader-pool', (req, res) => {
    const contributions = [...commission.leaderContributions(db).entries()]
      .map(([leaderId, contributionFen]) => ({ leaderId, contributionFen, contributionYuan: fenToYuan(contributionFen) }));
    const balance = commission.leaderPoolBalanceFen(db);
    res.json({ balanceFen: balance, balanceYuan: fenToYuan(balance), coefficient: db.switches.get('leaderPoolCoefficient'), contributions });
  });

  // 团队长辅导分红池分配跑批：按辅导贡献基数×系数分配池余额（幂等：同批次键只发一次）
  app.post('/api/admin/jobs/leader-dividend', (req, res) => {
    try {
      const batchKey = req.body.batchKey || `leader_${bizdate.today()}`;
      const result = commission.distributeLeaderPoolJob(db, {
        batchKey,
        coefficient: db.switches.get('leaderPoolCoefficient'),
        operator: req.body.operator || 'admin',
      });
      res.json({ batchKey, ...result });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/admin/reserve/deposit', (req, res) => {
    try {
      const flow = quarter.reserveDeposit(db, req.body);
      audit(db, req.body.operator || 'admin', 'reserve.deposit', req.body);
      res.json({ ok: true, flow, balanceFen: quarter.reserveBalanceFen(db) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/admin/quarter/assess', (req, res) => {
    try {
      // B2：只按真实数据核算；手工 candidates/thresholds 入参已下线（防止伪造资格快照）
      const quarterLabel = String((req.body && req.body.quarter) || '').trim();
      if (!quarterLabel) return res.status(400).json({ error: '季度必填（如 2026Q4）' });
      res.json(svc.runQuarterAssessment(db, { quarterLabel, operator: req.admin.username || 'admin' }));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // 季度分红发放（自动口径）：资格快照 -> 归一化权重 -> 储备×可分配比例；每季度持久化幂等一次
  app.post('/api/admin/quarter/payout-auto', (req, res) => {
    try {
      res.json(svc.runQuarterPayout(db, { quarterLabel: req.body && req.body.quarter, operator: req.admin.username || 'admin' }));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // B2：手工发放入口已下线（可传任意 poolFen/weights 凭空入账，且无幂等/不扣储备）
  app.post('/api/admin/quarter/payout', (req, res) => {
    res.status(410).json({ error: '季度分红手工发放入口已下线，请使用 /api/admin/quarter/payout-auto（自动口径 + 幂等）' });
  });

  // ---------- 商家管理（建档 / 启停 / 重置 token / 重置口令） ----------
  app.get('/api/admin/merchants', (req, res) => {
    res.json(merchant.adminListMerchants(db));
  });

  app.post('/api/admin/merchants/create', (req, res) => {
    try {
      const { merchant: m, initialPassword } = merchant.adminCreateMerchant(db, req.body || {});
      res.json({
        ok: true,
        merchant: { id: m.id, name: m.name, contact: m.contact, status: m.status, username: m.username },
        token: m.token, // token 仅建档时返回一次
        initialPassword, // 初始密码仅本次返回，请转交商家
      });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // 入驻证照私有文件：仅管理后台可查看（不挂静态路由，避免任何人凭 URL 直接访问，P0-3）
  app.get('/api/admin/uploads/private/:name', (req, res) => {
    const name = String(req.params.name || '');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|jpeg|webp)$/i.test(name)) {
      return res.status(400).json({ error: '文件名非法' });
    }
    const file = path.join(PRIVATE_UPLOAD_DIR, name);
    if (!fs.existsSync(file)) return res.status(404).json({ error: '文件不存在' });
    res.sendFile(file);
  });

  app.get('/api/admin/merchant-applications', (req, res) => {
    res.json(merchant.listEntryApplications(db, req.query.status));
  });
  app.post('/api/admin/merchant-applications/review', (req, res) => {
    try {
      const r = merchant.reviewEntryApplication(db, { ...req.body, operator: req.admin.username });
      res.json({
        ok: true, application: r.application,
        merchant: r.merchant ? { id: r.merchant.id, name: r.merchant.name, username: r.merchant.username } : null,
        token: r.merchant ? r.merchant.token : null, // 初始 token 仅审核通过时返回一次
        initialPassword: r.initialPassword || null, // 初始密码仅本次返回
      });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/admin/merchants/status', (req, res) => {
    try {
      const m = merchant.adminSetMerchantStatus(db, req.body || {});
      res.json({ ok: true, merchant: { id: m.id, name: m.name, status: m.status } });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/admin/merchants/reset-token', (req, res) => {
    try {
      const m = merchant.adminResetMerchantToken(db, req.body || {});
      res.json({ ok: true, merchantId: m.id, token: m.token }); // 新 token 仅本次返回
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // 重置商家密码（V3.8）：旧 token 立即失效；不传 password 则自动生成并返回一次
  app.post('/api/admin/merchants/reset-password', (req, res) => {
    try {
      const { merchant: m, initialPassword } = merchant.adminResetMerchantPassword(db, {
        merchantId: req.body.merchantId, password: req.body.password, operator: req.admin.username,
      });
      res.json({ ok: true, merchantId: m.id, username: m.username, initialPassword });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ---------- 广告位配置 / 投放审核 / 效果（V3.7） ----------
  app.get('/api/admin/adslots', (req, res) => {
    res.json({
      positions: ad.POSITIONS,
      slots: ad.listSlots(db).map((s) => ({ ...s, feePerCycleYuan: fenToYuan(s.feePerCycleFen || 0) })),
      pending: ad.listBookings(db, { reviewStatus: 'pending' }),
      active: ad.listBookings(db, { reviewStatus: 'approved', limit: 50 }),
      summary: ad.adSummary(db, {}),
    });
  });

  app.post('/api/admin/adslots/create', (req, res) => {
    try {
      const feeYuan = Number(req.body.feeYuan);
      const feePerCycleFen = Number.isFinite(feeYuan) && feeYuan > 0 ? Math.round(feeYuan * 100) : req.body.feePerCycleFen;
      const s = ad.createSlot(db, {
        name: req.body.name,
        position: req.body.position,
        minDays: req.body.minDays,
        feePerCycleFen,
        operator: req.admin.username,
      });
      res.json({ ok: true, slot: s });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/admin/adslots/review', (req, res) => {
    try {
      const b = ad.reviewBooking(db, {
        bookingId: req.body.bookingId,
        approved: req.body.approved === true,
        note: req.body.note,
        operator: req.admin.username,
      });
      res.json({ ok: true, booking: b });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // 平台代投轮播广告位（V4.3 额度制）：商家线下打款 → 后台发额度 → 工作人员代上广告并扣额度。
  // 服务端算价（不收前端费用），创建即上线；权限沿用 /adslots 前缀 → adCenter。
  app.post('/api/admin/adslots/book', (req, res) => {
    try {
      const r = adCenter.adminBookAdSlot(db, {
        slotId: req.body.slotId,
        merchantId: req.body.merchantId,
        days: req.body.days,
        title: req.body.title,
        imageUrl: req.body.imageUrl,
        targetType: req.body.targetType,
        targetId: req.body.targetId,
        operator: req.admin.username,
      });
      res.json({ ok: true, ...r });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ---------- 提现收款人 openid 绑定（后台补录） ----------
  app.post('/api/admin/withdraw/bind-receiver', (req, res) => {
    try {
      const r = withdraw.bindReceiver(db, { ...req.body, operator: req.body.operator || 'admin' });
      res.json({ ok: true, ...r });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ---------- 提现管理（后台） ----------
  app.get('/api/admin/withdraw/requests', (req, res) => {
    const receivers = {};
    const list = [...db.withdrawRequests.all()].sort((a, b) => (a.appliedAt < b.appliedAt ? 1 : -1));
    for (const r of list) {
      if (!receivers[r.userId]) receivers[r.userId] = withdraw.receiverOf(db, r.userId);
    }
    res.json({ requests: list, receivers });
  });

  app.get('/api/admin/withdraw/transfers', (req, res) => {
    res.json([...db.withdrawTransfers.all()].sort((a, b) => (a.issuedAt < b.issuedAt ? 1 : -1)).slice(0, 200));
  });

  app.post('/api/admin/withdraw/approve', (req, res) => {
    try {
      const result = withdraw.approveWithdraw(db, { requestId: req.body.requestId, operator: req.body.operator || 'admin' });
      res.json({ ok: true, ...result });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/admin/jobs/issue-queued', (req, res) => {
    // 每日跑批：对所有"发放中"提现单尝试补发（顺延部分）
    const date = req.body.date || bizdate.today();
    const results = db.withdrawRequests.where((r) => ['approved', 'issuing'].includes(r.status))
      .map((r) => ({ requestId: r.id, ...withdraw.issueQueuedWithdrawals(db, { requestId: r.id, date }) }));
    audit(db, 'admin', 'job.issue_queued', { date, count: results.length });
    res.json({ ok: true, date, results });
  });

  app.post('/api/admin/jobs/expire-transfers', (req, res) => {
    res.json(withdraw.expireStaleTransfers(db, { date: req.body.date }));
  });

  // 转账提交失败重试跑批（补齐收款人 openid 后调用）
  app.post('/api/admin/jobs/retry-transfers', (req, res) => {
    res.json({ ok: true, results: transfer.retryFailedTransfers(db) });
  });

  // ---------- 订单 / 队位 / 免单管理 ----------
  app.get('/api/admin/orders', (req, res) => {
    const { status, payType } = req.query;
    res.json(db.orders.all()
      .filter((o) => (!status || o.status === status) && (!payType || o.payType === payType))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 200)
      .map((o) => ({ ...o, name: (db.products.get(o.productId) || {}).name, imageUrl: (db.products.get(o.productId) || {}).imageUrl || '', priceYuan: fenToYuan(o.priceFen), paidYuan: fenToYuan(o.paidFen) })));
  });

  app.get('/api/admin/queue-slots', (req, res) => {
    res.json([...db.queueSlots.all()].sort((a, b) => (a.grantedAt < b.grantedAt ? 1 : -1)).slice(0, 200));
  });

  // 近 7 日经营趋势（图表数据源：每日订单数 / 实付 GMV / 免单数）
  app.get('/api/admin/stats/daily', (req, res) => {
    const days = Math.min(parseInt(req.query.days, 10) || 7, 30);
    const localKey = (t) => new Date(t).toLocaleDateString('sv');
    const byDay = new Map();
    for (let i = days - 1; i >= 0; i--) {
      const key = localKey(Date.now() - i * 86400000);
      byDay.set(key, { date: key, orders: 0, paidOrders: 0, gmvFen: 0, freeOrders: 0 });
    }
    for (const o of db.orders.all()) {
      if (!o.createdAt) continue;
      const row = byDay.get(localKey(o.createdAt));
      if (!row) continue;
      row.orders += 1;
      if (o.payType === 'FREE') { row.freeOrders += 1; continue; }
      if (['paid', 'done', 'shipped'].includes(o.status)) {
        row.paidOrders += 1;
        row.gmvFen += o.paidFen || 0;
      }
    }
    res.json(Array.from(byDay.values()));
  });

  app.post('/api/admin/orders/refund', async (req, res) => {
    try {
      const order = db.orders.get(req.body.orderId);
      if (!order) return res.status(404).json({ error: '订单不存在' });
      // 先真退（live 模式），受理成功后再落本地状态与分佣回滚；失败则整单不动
      const wx = await ensureWxRefund(order, req.admin.username);
      // S4：微信已受理但未到账 → 仅展示"退款中"，不落 refunded、不回滚资金
      if (wx && wx.status === 'PROCESSING') {
        db.orders.update(order.id, { refundPending: true, refundRequestedAt: new Date().toISOString() });
        audit(db, req.admin.username, 'order.refund_pending', { orderId: order.id, refundNo: wx.refundNo || order.refundNo });
        return res.json({ ok: true, pending: true, wxRefund: wx, message: '微信退款已受理，处理中；到账前订单不会显示为已退款' });
      }
      const r = svc.refundOrder(db, { orderId: req.body.orderId, operator: req.admin.username });
      db.orders.update(order.id, { refundPending: false });
      res.json({ ok: true, wxRefund: wx || null, ...r });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ---------- 退款闭环（S4 后续）：主动查单 / 异常队列 / 重试 ----------
  const refundOrderView = (id) => {
    const o = db.orders.get(id) || {};
    return {
      id: o.id, status: o.status, refundStatus: o.refundStatus || '',
      refundPending: !!o.refundPending, refundNo: o.refundNo || '',
      refundError: o.refundError || null, refundStatusText: o.refundStatus || '',
      afterSaleStatus: o.afterSaleStatus || '',
    };
  };

  // 主动查询微信退款单并推进终态（处理中订单不再永久卡住）
  app.post('/api/admin/orders/refund/sync', async (req, res) => {
    try {
      const out = await syncRefundOrder(req.body.orderId, {
        operator: req.admin.username, source: 'admin',
      });
      res.json({ ok: true, ...out, order: refundOrderView(req.body.orderId) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // 退款异常队列（失败/关闭/长期处理中），附阈值判定，后台可见
  app.get('/api/admin/refund-anomalies', (req, res) => {
    res.json({ ok: true, ...refund.listAnomalies(db) });
  });

  // 异常重试：处理中/已成功 → 查单；失败/关闭 → 重新发起微信退款（out_refund_no 幂等）
  app.post('/api/admin/refund-anomalies/retry', async (req, res) => {
    try {
      const order = db.orders.get(req.body.orderId);
      if (!order) return res.status(404).json({ error: '订单不存在' });
      refund.bumpAttempt(db, order.id);
      audit(db, req.admin.username, 'refund.retry', {
        orderId: order.id, refundNo: order.refundNo || '',
        refundStatus: order.refundStatus || '', note: String(req.body.note || '').slice(0, 200),
      });
      let out;
      if (['PROCESSING', 'SUCCESS'].includes(order.refundStatus)) {
        out = await syncRefundOrder(order.id, { operator: req.admin.username, source: 'retry' });
      } else {
        // 失败/关闭：重新走微信退款；凭证缺失或通道拒绝时抛错，状态保持原样
        const wx = await ensureWxRefund(db.orders.get(order.id), req.admin.username);
        if (!wx) throw new Error('当前为模拟支付模式或订单非微信支付，无法重试微信退款');
        out = applyRefundResult(db.orders.get(order.id), {
          status: wx.status, refundId: wx.refundId, refundNo: wx.outRefundNo || wx.refundNo,
        }, { source: 'retry', operator: req.admin.username });
      }
      res.json({ ok: true, ...out, order: refundOrderView(order.id) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ---------- 履约（发货 / 核销 / 强制完成 / 售后处理，V3.5） ----------
  app.post('/api/admin/orders/ship', (req, res) => {
    try {
      const order = fulfillment.shipOrder(db, {
        orderId: req.body.orderId, company: req.body.company,
        trackingNo: req.body.trackingNo, operator: req.admin.username,
      });
      res.json({ ok: true, order: { id: order.id, status: order.status } });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/admin/orders/verify', (req, res) => {
    try {
      const order = fulfillment.verifyStoreOrder(db, {
        orderId: req.body.orderId, verifyCode: req.body.verifyCode, operator: req.admin.username,
      });
      res.json({ ok: true, order: { id: order.id, status: order.status } });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/admin/orders/complete', (req, res) => {
    try {
      const order = fulfillment.forceCompleteOrder(db, {
        orderId: req.body.orderId, operator: req.admin.username, note: req.body.note,
      });
      res.json({ ok: true, order: { id: order.id, status: order.status } });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/admin/orders/after-sale/resolve', async (req, res) => {
    try {
      // 受理前先真退（live 模式）；退款失败则不改变售后与订单状态
      if (req.body.approved === true) {
        const o = db.orders.get(req.body.orderId);
        if (o) {
          const wx = await ensureWxRefund(o, req.admin.username);
          // S4：微信已受理但未到账 → 售后保持"售后中"，不落退款完成态、不回滚资金
          if (wx && wx.status === 'PROCESSING') {
            db.orders.update(o.id, { refundPending: true, refundRequestedAt: new Date().toISOString() });
            audit(db, req.admin.username, 'order.refund_pending', { orderId: o.id, refundNo: wx.refundNo || o.refundNo });
            return res.json({
              ok: true, pending: true, wxRefund: wx,
              message: '微信退款已受理，处理中；到账前售后不会显示为已退款',
            });
          }
        }
      }
      const order = fulfillment.resolveAfterSale(db, {
        orderId: req.body.orderId,
        approved: req.body.approved === true,
        note: req.body.note,
        operator: req.admin.username,
        // 注入退款：复用既有 refundOrder（含分佣回滚、分红池回滚、挂账）
        refund: (id) => svc.refundOrder(db, { orderId: id, operator: req.admin.username }),
      });
      res.json({ ok: true, order: { id: order.id, status: order.status, afterSaleStatus: order.afterSaleStatus } });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // 履约待办统计（后台总览用）—— 走订单聚合索引，避免五次全表扫描
  app.get('/api/admin/orders/fulfillment-summary', (req, res) => {
    res.json({ ...orderIndex.fulfillmentStats(db) });
  });

  // 分佣结算跑批：售后期结束的订单，冻结 -> 余额（生产由定时任务按售后到期日批量调用）
  app.post('/api/admin/commission/settle', (req, res) => {
    const results = (req.body.orderIds || []).map((orderId) => ({ orderId, settled: !!commission.settleOrder(db, orderId) }));
    audit(db, 'admin', 'commission.settle', { count: results.filter((r) => r.settled).length });
    res.json({ ok: true, results });
  });

  // 分佣到期自动结算跑批（V3.4）：支付满 settleAfterHours 小时且未退款的订单，冻结 -> 余额
  app.post('/api/admin/jobs/settle-commission', (req, res) => {
    const settled = commission.settleDue(db, { afterHours: db.switches.get('settleAfterHours') });
    audit(db, req.admin.username, 'job.settle_commission', { count: settled.length });
    res.json({ ok: true, count: settled.length, settled: settled.map((s) => ({ orderId: s.orderId, baseFen: s.baseFen })) });
  });

  // 平台留存流水（未归属分佣份额 + 周期留存），财务对账用
  app.get('/api/admin/platform-flows', (req, res) => {
    const balanceFen = svc.platformBalanceFen(db);
    res.json({
      balanceFen,
      balanceYuan: fenToYuan(balanceFen),
      flows: [...db.platformFlows.all()].sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, 200),
    });
  });

  // 商品周期经济预览：上架/改价前先看账（周期可分配收益 / 分佣基数 / 平台留存）
  app.get('/api/admin/economics/preview', (req, res) => {
    const p = db.products.get(req.query.productId);
    if (!p) return res.status(404).json({ error: '商品不存在' });
    const cat = db.categories.get(p.categoryId);
    const n = ladder.stepCount(cat.r);
    const taxFeeRate = Number.isFinite(p.taxFeeRate) ? p.taxFeeRate : Number(db.switches.get('defaultTaxFeeRate') || 0);
    const opCostFen = Number.isInteger(p.opCostFen) ? p.opCostFen : Number(db.switches.get('defaultOpCostFen') || 0);
    const econ = ladder.cycleEconomics({ priceFen: p.priceFen, n, costFen: p.costFen || 0, taxFeeRate, opCostFen });
    const retainRate = Math.min(0.9, Math.max(0, Number(db.switches.get('commissionPlatformRetainRate') ?? 0) || 0));
    const factor = econ.factor * (1 - retainRate);
    const rows = econ.rows.map((r) => ({ ...r, commissionBaseFen: Math.floor(Math.max(0, r.allocFen) * factor) }));
    const commissionBaseTotalFen = rows.reduce((s, r) => s + r.commissionBaseFen, 0);
    const platformRetainFen = Math.max(0, econ.allocTotalFen - commissionBaseTotalFen);
    res.json({
      productId: p.id, productName: p.name, n, taxFeeRate, opCostFen, retainRate, factor,
      rows, allocTotalFen: econ.allocTotalFen, positiveSumFen: econ.positiveSumFen,
      commissionBaseTotalFen, platformRetainFen,
      allocTotalYuan: fenToYuan(econ.allocTotalFen),
      commissionBaseTotalYuan: fenToYuan(commissionBaseTotalFen),
      platformRetainYuan: fenToYuan(platformRetainFen),
      notice: '平台留存 = 周期可分配收益 − 分佣基数合计，必须 ≥ 0；为负说明成本或 r 配置不可行，应调价或调 r。',
    });
  });

  // ---------- 广告激励（V4.0 · 方案稿 V1.2）：广告计划 + 计费联动 + 提现审核 ----------
  // 计费参数联动预览：录入总预算与单 IP 费用时实时显示派生值
  app.get('/api/admin/advideos/pricing-preview', (req, res) => {
    try {
      const budgetFen = Math.round(Number(req.query.budgetFen));
      const chargePerIpFen = Math.round(Number(req.query.chargePerIpFen));
      res.json(adReward.derivePricing(db, budgetFen, chargePerIpFen));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.get('/api/admin/advideos', (req, res) => {
    res.json({
      videos: adReward.listVideosAdmin(db, { status: req.query.status || undefined }),
      chargePresetsFen: adReward.CHARGE_PRESETS_FEN,
      shareRate: db.switches.get('adRewardShareRate'),
      products: db.products.all().map((p) => ({ id: p.id, title: p.title || p.name, merchantId: p.merchantId })),
    });
  });

  // ---------- 广告中心 V4.2：视频素材上传 / 投放闭环 / 效果看板 / 商家额度 ----------
  // 视频按文件头 ftyp 判定真实类型，落公开素材目录（用户端可匿名播放），全程审计
  app.post('/api/admin/upload/video', (req, res) => {
    try {
      const buf = upload.decodeVideoPayload(req.body?.dataBase64);
      const type = upload.detectVideoType(buf);
      if (!type) throw new upload.UploadError('仅支持 MP4 / MOV 视频（按文件真实内容判定）');
      upload.assertMinuteRate(`min:admin:${req.admin.username}`, 10);
      upload.assertMinuteRate(`min:ip:${upload.clientIp(req)}`, 20);
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      const name = upload.randomFileName(type.ext);
      fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
      const url = `/uploads/${name}`;
      audit(db, req.admin.username, 'upload.video', { tier: 'admin', purpose: 'material', url, bytes: buf.length, ext: type.ext });
      res.json({ ok: true, url, ext: type.ext, bytes: buf.length });
    } catch (e) {
      res.status((e && e.status) || 400).json({ error: (e && e.message) || '上传失败' });
    }
  });

  /** 统一包装：域函数抛业务错 → 400，不把异常泡到全局 */
  const ac = (fn) => (req, res) => {
    try { res.json({ ok: true, ...fn(req) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  };
  app.post('/api/admin/advideos/material', ac((req) => ({
    video: adCenter.updateVideoMaterial(db, { ...req.body, operator: req.admin.username || 'admin' }),
  })));
  app.post('/api/admin/advideos/append-budget', ac((req) => ({
    video: adCenter.appendBudgetWithQuota(db, { ...req.body, operator: req.admin.username || 'admin' }),
  })));
  app.post('/api/admin/advideos/settle', ac((req) => ({
    settlement: adCenter.settleVideo(db, { ...req.body, operator: req.admin.username || 'admin' }),
  })));
  app.get('/api/admin/advideos/settlements', ac(() => ({
    settlements: adCenter.listSettlements(db),
  })));
  app.post('/api/admin/advideos/settlements/refunded', ac((req) => ({
    settlement: adCenter.markSettlementRefunded(db, { ...req.body, operator: req.admin.username || 'admin' }),
  })));
  app.get('/api/admin/advideos/stats', ac(() => adCenter.adminStats(db)));
  app.get('/api/admin/advideos/stats.csv', (req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="ad-stats.csv"');
    res.send(adCenter.statsCsv(db));
  });
  app.get('/api/admin/ad-quotas', ac(() => ({ quotas: adCenter.listQuotas(db) })));
  app.post('/api/admin/ad-quotas/grant', ac((req) => ({
    quota: adCenter.grantQuota(db, { ...req.body, operator: req.admin.username || 'admin' }),
  })));

  app.post('/api/admin/advideos/create', (req, res) => {
    try {
      // 后台代建同样受商家广告额度约束（V4.3：与商家自助同一口径，堵掉"后台可无限冻结"缺口）
      const v = adCenter.createVideoWithQuota(db, { ...req.body, operator: req.admin.username || 'admin' });
      res.json({ ok: true, video: v });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/admin/advideos/review', (req, res) => {
    try {
      const v = adCenter.reviewVideoWithQuota(db, { ...req.body, operator: req.admin.username || 'admin' });
      res.json({ ok: true, video: adReward.adminVideoView(db, v) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/admin/advideos/offline', (req, res) => {
    try {
      const v = adReward.offlineVideo(db, { videoId: req.body?.videoId, operator: req.admin.username || 'admin' });
      res.json({ ok: true, video: adReward.adminVideoView(db, v) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.get('/api/admin/reward-withdrawals', (req, res) => {
    res.json({
      withdrawals: adReward.listRewardWithdrawals(db, { status: req.query.status || undefined }),
      switchOn: db.switches.get('adRewardEnabled') === true,
      withdrawSwitchOn: db.switches.get('withdrawEnabled') === true,
    });
  });

  app.post('/api/admin/reward-withdrawals/offline-mark', (req, res) => {
    try {
      const w = adReward.markOfflinePayout(db, {
        withdrawalId: req.body?.withdrawalId,
        voucherNo: req.body?.voucherNo,
        paidAt: req.body?.paidAt,
        note: req.body?.note,
        operator: req.admin.username || 'admin',
        operatorId: req.admin.uid || '',
      });
      res.json({ ok: true, withdrawal: w });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/admin/reward-withdrawals/offline-confirm', (req, res) => {
    try {
      const w = adReward.confirmOfflinePayout(db, {
        withdrawalId: req.body?.withdrawalId,
        note: req.body?.note,
        operator: req.admin.username || 'admin',
        operatorId: req.admin.uid || '',
      });
      res.json({ ok: true, withdrawal: w });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // H2 第一步：初审通过（不动资金、不调通道）；第二步由 /pay 完成
  app.post('/api/admin/reward-withdrawals/approve', async (req, res) => {
    try {
      const w = await adReward.approveRewardWithdraw(db, {
        withdrawalId: req.body?.withdrawalId,
        operator: req.admin.username || 'admin',
        operatorId: req.admin.uid || '',
      });
      res.json({ ok: true, withdrawal: w });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // H2 第二步：复核打款（仅财务复核角色或总账号；与初审人不同且通过关系校验）
  app.post('/api/admin/reward-withdrawals/pay', async (req, res) => {
    try {
      const w = await adReward.payRewardWithdraw(db, {
        withdrawalId: req.body?.withdrawalId,
        operator: req.admin.username || 'admin',
        operatorId: req.admin.uid || '',
      });
      res.json({ ok: true, withdrawal: w });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/admin/reward-withdrawals/reject', (req, res) => {
    try {
      const w = adReward.rejectRewardWithdraw(db, {
        withdrawalId: req.body?.withdrawalId,
        note: req.body?.note,
        operator: req.admin.username || 'admin',
        operatorId: req.admin.uid || '',
      });
      res.json({ ok: true, withdrawal: w });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
};
