'use strict';
/**
 * 广告激励（V4.0 · 2026-11 合规整改）：商家视频广告 × 用户完播奖励（贡献值，不可提现）。
 *
 * 计费模型（按 IP 点击计费，金额随广告费联动）：
 * - 商家录入「总预算 budgetFen + 单 IP 费用 chargePerIpFen」→ 系统联动：
 *     所需 IP 数 targetIpCount = floor(budget / chargePerIp)
 *     单次奖励分值 rewardPerIpFen = round(chargePerIp × adRewardShareRate)（分值沿用分数值）
 * - 每次有效完播（同一广告：每用户 1 次 + 每 IP 每日 1 次）扣减预算、发放贡献值；
 * - IP 数点满（claimedIpCount ≥ targetIpCount）→ 自动置 sold_out，停止发放。平台零垫资。
 *
 * 合规要点：
 * - 用户奖励一律发贡献值（只记权重、不可提现、无现金价值），微信禁止「看广告得现金」网赚模式；
 * - 文案规范由前端负责（禁「赚钱/躺赚/日结/提现」）；
 * - 现金账本（cashLedger / rewardWithdrawals / 实名）仅保留用于历史余额的兑付，不再新增发放；
 * - 个税：劳务报酬预扣预缴简化口径（按月累计），仅作用于历史余额提现；
 * - 转账：必须挂接真实转账通道（db._rewardTransferHook）；未挂接时审核直接拒绝，不得记已打款（B1）；
 */
const crypto = require('crypto');
const { audit } = require('../store');
const bizdate = require('./bizdate');

function nowISO() { return new Date().toISOString(); }
function switchVal(db, key) { return db.switches.get(key); }

/** 站内消息 */
function pushMsg(db, userId, type, title, body) {
  db.messages.insert({ userId: String(userId), type, title, body, ts: nowISO(), read: false });
}

/* ---------------- 计费参数联动 ---------------- */

/** 由「总预算 + 单 IP 费用」联动计算派生参数（后台编辑实时预览也用它） */
function derivePricing(db, budgetFen, chargePerIpFen) {
  if (!Number.isInteger(budgetFen) || budgetFen < 100) throw new Error('总预算须为整数分且不低于 ¥1');
  if (!Number.isInteger(chargePerIpFen) || chargePerIpFen < 10) throw new Error('单 IP 费用须为整数分且不低于 ¥0.10');
  const shareRate = Number(switchVal(db, 'adRewardShareRate') ?? 0.4);
  const rewardPerIpFen = Math.round(chargePerIpFen * shareRate);
  const targetIpCount = Math.floor(budgetFen / chargePerIpFen);
  if (rewardPerIpFen <= 0) throw new Error('用户奖励计算结果为 0，请调高单 IP 费用');
  if (targetIpCount <= 0) throw new Error('预算不足以覆盖单次点击费用');
  return { rewardPerIpFen, targetIpCount, shareRate };
}

/* ---------------- 广告计划（管理端） ---------------- */

const CHARGE_PRESETS_FEN = [40, 60, 100]; // 单 IP 费用档位（¥0.40/¥0.60/¥1.00）

/** 新建广告计划（draft 待审）。视频为站内 /uploads/ 路径（上传接口复用现有 upload 模块）。 */
function createVideo(db, { merchantId, title, videoUrl, coverUrl, durationS, productId, budgetFen, chargePerIpFen, dailyCap, operator = 'admin' }) {
  if (!db.merchants.get(merchantId)) throw new Error('商家不存在');
  if (!title || String(title).trim().length < 2) throw new Error('广告标题必填（至少 2 字）');
  const v = String(videoUrl || '').trim();
  if (!/^\/(img|uploads)\/[\w\-./]+$/i.test(v)) throw new Error('视频必须为站内 /img/ 或 /uploads/ 路径');
  const cover = String(coverUrl || '').trim();
  if (cover && !/^\/(img|uploads)\/[\w\-./]+$/i.test(cover)) throw new Error('封面必须为站内 /img/ 或 /uploads/ 路径');
  const dur = Number(durationS);
  if (!Number.isInteger(dur) || dur < 5 || dur > 600) throw new Error('视频时长须为 5~600 秒');
  const p = productId != null ? String(productId) : '';
  if (p && !db.products.get(p)) throw new Error('跳转商品不存在');
  const derived = derivePricing(db, budgetFen, chargePerIpFen);
  const cap = Number(dailyCap);
  if (!Number.isInteger(cap) || cap <= 0) throw new Error('每日发放上限须为正整数');
  const row = db.adVideos.insert({
    merchantId: String(merchantId),
    title: String(title).trim().slice(0, 40),
    videoUrl: v,
    coverUrl: cover,
    durationS: dur,
    productId: p,
    budgetFen, chargePerIpFen,
    rewardPerIpFen: derived.rewardPerIpFen,
    targetIpCount: derived.targetIpCount,
    claimedIpCount: 0,
    spentFen: 0,
    dailyCap: cap,
    status: 'draft', // draft 待审 / active 在投 / sold_out 已抢完 / rejected 驳回 / offline 下架
    reviewNote: '',
    createdAt: nowISO(),
  });
  audit(db, operator, 'adReward.video_create', { videoId: row.id, merchantId, budgetFen, chargePerIpFen, ...derived });
  return row;
}

/** 审核广告计划：通过 → active 并起投；驳回 → rejected（留因） */
function reviewVideo(db, { videoId, approved, note, operator = 'admin' }) {
  const v = db.adVideos.get(String(videoId));
  if (!v) throw new Error('广告计划不存在');
  if (v.status !== 'draft') throw new Error('该计划已审核，无需重复处理');
  if (approved) {
    db.adVideos.update(v.id, { status: 'active', reviewedAt: nowISO(), reviewNote: String(note || '').slice(0, 200) });
  } else {
    if (!note) throw new Error('驳回必须填写原因');
    db.adVideos.update(v.id, { status: 'rejected', reviewedAt: nowISO(), reviewNote: String(note).slice(0, 200) });
  }
  audit(db, operator, 'adReward.video_review', { videoId: v.id, approved, note: note || '' });
  return db.adVideos.get(v.id);
}

/** 下架（在投中可手动下架） */
function offlineVideo(db, { videoId, operator = 'admin' }) {
  const v = db.adVideos.get(String(videoId));
  if (!v) throw new Error('广告计划不存在');
  if (!['active', 'draft'].includes(v.status)) throw new Error('当前状态不可下架');
  db.adVideos.update(v.id, { status: 'offline', offlineAt: nowISO() });
  audit(db, operator, 'adReward.video_offline', { videoId: v.id });
  return db.adVideos.get(v.id);
}

/** 管理端列表（含实时进度） */
function listVideosAdmin(db, { status } = {}) {
  return db.adVideos.all()
    .filter((v) => !status || v.status === status)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map((v) => adminVideoView(db, v));
}

function adminVideoView(db, v) {
  const m = db.merchants.get(v.merchantId) || {};
  const p = v.productId ? db.products.get(v.productId) : null;
  return {
    ...v,
    merchantName: m.name || v.merchantId,
    productTitle: p ? p.title : '',
    budgetLeftFen: v.budgetFen - v.spentFen,
    ipProgressPercent: v.targetIpCount ? Math.min(100, Math.round((v.claimedIpCount / v.targetIpCount) * 100)) : 0,
    estDays: v.dailyCap ? Math.ceil(v.targetIpCount / v.dailyCap) : 0,
  };
}

/* ---------------- 用户端：列表 / 观看 / 发放 ---------------- */

/** 用户端广告列表（在投 + 今日剩余 + 是否已领） */
function listVideosForUser(db, userId, now = Date.now()) {
  const uid = String(userId);
  const today = bizdate.today();
  return db.adVideos.all()
    .filter((v) => v.status === 'active')
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map((v) => {
      const m = db.merchants.get(v.merchantId) || {};
      const p = v.productId ? db.products.get(v.productId) : null;
      const claimedByUser = !!db.adRewardRecords.where((r) => r.videoId === v.id && r.userId === uid).length;
      const issuedToday = db.adRewardRecords.where((r) => r.videoId === v.id && r.date === today).length;
      return {
        id: v.id,
        title: v.title,
        merchantName: m.name || '',
        durationS: v.durationS,
        videoUrl: v.videoUrl,       // 观看页必须拿到播放源（V4.2 修复：此前缺失导致无法播放）
        coverUrl: v.coverUrl || '', // 列表封面
        rewardFen: v.rewardPerIpFen,
        points: Math.max(1, Math.round(v.rewardPerIpFen)), // 完播可得贡献值（分值沿用分数值）
        productId: v.productId || '',
        productTitle: p ? p.title : '',
        claimedByUser,
        todayLeft: Math.max(0, Math.min(v.dailyCap - issuedToday, v.targetIpCount - v.claimedIpCount)),
      };
    });
}

/** 广告跳转商品（带在投校验） */
function productOfVideo(db, videoId) {
  const v = db.adVideos.get(String(videoId));
  if (!v || v.status !== 'active') throw new Error('广告不在投');
  if (!v.productId) throw new Error('该广告未绑定跳转商品');
  const p = db.products.get(v.productId);
  if (!p) throw new Error('跳转商品不存在或已下架');
  return p;
}

/** 提取客户端 IP（nginx 反代场景取 X-Forwarded-For 首段） */
function ipOf(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.socket?.remoteAddress || '';
}

/**
 * 上报开始观看：记录服务端时间戳 + IP，供完播时长校验与 IP 去重。
 * 校验：在投、未领过（用户维度）、该 IP 今日未领过该广告、预算未耗尽、频次未超。
 */
function startWatch(db, { videoId, userId, ip, now = Date.now() }) {
  const uid = String(userId);
  const v = db.adVideos.get(String(videoId));
  if (!v || v.status !== 'active') throw new Error('广告不在投或已结束');
  if (v.claimedIpCount >= v.targetIpCount) throw new Error('今日名额已抢完');
  const today = bizdate.today();
  if (db.adRewardRecords.where((r) => r.videoId === v.id && r.userId === uid).length > 0) {
    throw new Error('该广告已领取过奖励');
  }
  if (db.adRewardRecords.where((r) => r.videoId === v.id && r.ip === ip && r.date === today).length > 0) {
    throw new Error('该网络地址今日已领取过本广告奖励');
  }
  if (db.adRewardRecords.where((r) => r.userId === uid && r.date === today).length >= switchVal(db, 'adRewardDailyLimit')) {
    throw new Error('今日领取次数已达上限');
  }
  if (db.adRewardRecords.where((r) => r.ip === ip && r.date === today).length >= switchVal(db, 'adRewardIpDailyTotal')) {
    throw new Error('当前网络今日领取次数已达上限');
  }
  const u = db.users.get(uid);
  if (u && u.createdAt && now - new Date(u.createdAt).getTime() < switchVal(db, 'adRewardNewUserCooldownHours') * 3600 * 1000) {
    throw new Error('新用户需注册满 24 小时后才能参与');
  }
  db.adRewardRecords.insert({
    videoId: v.id, userId: uid, ip, date: today,
    phase: 'started', // started -> rewarded
    watchStartAt: nowISO(),
    amountFen: 0,
  });
  return { ok: true, minWatchS: Math.ceil(v.durationS * 0.95) };
}

/**
 * 完播领取：时长二次校验 + 双幂等（用户/Ip+日）→ 预算扣减 → 发放贡献值（不可提现）。
 * 返回 { points, weight, replay }。
 */
function reward(db, { videoId, userId, ip, idempotencyKey, now = Date.now() }) {
  const uid = String(userId);
  const v = db.adVideos.get(String(videoId));
  if (!v) throw new Error('广告不存在');
  const today = bizdate.today();
  const idemKey = idempotencyKey || `adreward:${v.id}:${uid}:${today}`;
  const { value: result, replay } = db.idempotency.run(idemKey, () => {
    if (!v || v.status !== 'active') throw new Error('广告不在投或已结束');
    // 本用户本广告的 started 记录（startWatch 落下的行）
    const rec = db.adRewardRecords.where((r) => r.videoId === v.id && r.userId === uid && r.phase === 'started')
      .sort((a, b) => (a.watchStartAt < b.watchStartAt ? 1 : -1))[0];
    if (!rec) throw new Error('请先开始观看再领取');
    // 时长二次校验（服务端时钟差 ≥ 时长 × 0.95）
    const elapsedS = (now - new Date(rec.watchStartAt).getTime()) / 1000;
    if (elapsedS < v.durationS * 0.95) throw new Error('观看时长不足，请完整观看');
    // IP 维度（start 时已校验一次；reward 再校验防并发窗口）
    if (db.adRewardRecords.where((r) => r.videoId === v.id && r.ip === ip && r.date === today && r.phase === 'rewarded').length > 0) {
      throw new Error('该网络地址今日已领取过本广告奖励');
    }
    // 预算封顶
    if (v.claimedIpCount >= v.targetIpCount || v.spentFen + v.rewardPerIpFen > v.budgetFen) {
      db.adVideos.update(v.id, { status: 'sold_out' });
      throw new Error('今日名额已抢完');
    }
    // 发放：扣预算 → 记流水 → 入贡献值账户（只记权重，无现金价值，2026-11 合规整改）
    db.adVideos.update(v.id, {
      claimedIpCount: v.claimedIpCount + 1,
      spentFen: v.spentFen + v.rewardPerIpFen,
      ...(v.claimedIpCount + 1 >= v.targetIpCount ? { status: 'sold_out' } : {}),
    });
    db.adRewardRecords.update(rec.id, { phase: 'rewarded', amountFen: v.rewardPerIpFen, rewardedAt: nowISO() });
    const points = Math.max(1, Math.round(v.rewardPerIpFen)); // 分值沿用分数值（如 24 分 → 24 贡献值）
    let acc = db.contributions.get(uid);
    if (!acc) acc = db.contributions.insert({ id: uid, weight: 0 });
    acc.weight += points;
    db.contributionFlows.insert({ userId: uid, taskType: `adVideo:${v.id}`, reward: points, date: today, ts: nowISO() });
    return { points, weight: acc.weight };
  });
  return { ...result, replay };
}

/* ---------------- 现金余额账本 ---------------- */

/** 发放入账（grant）并回写余额冗余 */
function grantCash(db, userId, fen, refId) {
  const uid = String(userId);
  db.cashLedger.insert({ userId: uid, delta: fen, bizType: 'grant', refId, ts: nowISO() });
  const u = db.users.get(uid);
  u.cashBalanceFen = (u.cashBalanceFen || 0) + fen;
  return u.cashBalanceFen;
}

/** 提现冻结 / 回退等余额变动 */
function moveCash(db, userId, delta, bizType, refId) {
  const uid = String(userId);
  const u = db.users.get(uid);
  const next = (u.cashBalanceFen || 0) + delta;
  if (next < 0) throw new Error('余额不足');
  u.cashBalanceFen = next;
  db.cashLedger.insert({ userId: uid, delta, bizType, refId, ts: nowISO() });
  return next;
}

/** 余额视图：余额 / 可提现（T+1）/ 距门槛差额 / 提现中冻结 */
function cashInfo(db, userId, now = Date.now()) {
  const uid = String(userId);
  const u = db.users.get(uid) || {};
  const balanceFen = u.cashBalanceFen || 0;
  const frozenFen = db.rewardWithdrawals.where((w) => w.userId === uid && ['pending_review', 'pending_offline', 'approved', 'issuing'].includes(w.status))
    .reduce((s, w) => s + w.fen, 0);
  const t1Ms = switchVal(db, 'adRewardTPlus1Hours') * 3600 * 1000;
  const recentGrantFen = db.cashLedger.where((l) => l.userId === uid && l.bizType === 'grant'
    && (now - new Date(l.ts).getTime()) < t1Ms).reduce((s, l) => s + l.delta, 0);
  const minFen = switchVal(db, 'adRewardWithdrawMinFen');
  const withdrawableFen = Math.max(0, balanceFen - frozenFen - recentGrantFen);
  const month = bizdate.monthOf(now);
  const monthUsed = db.rewardWithdrawals.where((w) => w.userId === uid
    && bizdate.monthOfIso(w.appliedAt) === month && w.status !== 'rejected').length;
  return {
    balanceFen,
    frozenFen,
    recentGrantFen,
    withdrawableFen,
    thresholdFen: minFen,
    canWithdraw: withdrawableFen >= minFen,
    gapToFen: Math.max(0, minFen - withdrawableFen),
    monthlyLimit: switchVal(db, 'adRewardWithdrawMonthlyLimit'),
    monthlyUsed: monthUsed,
    monthlyLeft: Math.max(0, switchVal(db, 'adRewardWithdrawMonthlyLimit') - monthUsed),
    perWithdrawMaxFen: switchVal(db, 'adRewardWithdrawMaxFen'),
    realnamed: !!u.realnameHash,
    realnameName: u.realnameName || '',
    ledger: db.cashLedger.where((l) => l.userId === uid)
      .sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, 50)
      .map((l) => ({ ...l, refId: l.refId || '' })),
  };
}

/* ---------------- 实名认证 ---------------- */

/** 18 位身份证校验码验证 */
function validIdCard(id) {
  if (!/^\d{17}[\dX]$/.test(id)) return false;
  const w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const codes = '10X98765432';
  const sum = id.slice(0, 17).split('').reduce((s, c, i) => s + Number(c) * w[i], 0);
  return codes[sum % 11] === id[17].toUpperCase();
}

/** 提交实名：一人一证一账号；身份证只存加盐摘要 + 脱敏展示 */
function submitRealname(db, { userId, name, idCard }) {
  const uid = String(userId);
  const n = String(name || '').trim();
  const id = String(idCard || '').trim().toUpperCase();
  if (n.length < 2 || n.length > 20) throw new Error('姓名格式不正确');
  if (!validIdCard(id)) throw new Error('身份证号校验失败，请核对');
  const salt = process.env.REALNAME_SALT || 'bfj-realname-static-salt';
  const hash = crypto.createHash('sha256').update(salt + id).digest('hex');
  const dup = db.users.where((u) => u.realnameHash === hash && u.id !== uid);
  if (dup.length > 0) throw new Error('该身份证已绑定其他账号（一人一证一账号）');
  const u = db.users.get(uid);
  if (u.realnameHash) throw new Error('已实名，无需重复提交');
  u.realnameHash = hash;
  u.realnameName = n;
  u.realnameMasked = `${id.slice(0, 4)}**********${id.slice(-4)}`;
  u.realnameAt = nowISO();
  audit(db, uid, 'adReward.realname', { name: n, masked: u.realnameMasked });
  return { realnamed: true, name: n, masked: u.realnameMasked };
}

/* ---------------- 提现 ---------------- */

/** 劳务报酬预扣预缴（简化口径，按月累计；生产以税务申报为准）
 *  f(x): x≤800 → 0；800<x≤4000 → (x-800)×20%；x>4000 → x×80%×20% */
function cumTaxFen(x) {
  if (x <= 80000) return 0;
  if (x <= 400000) return Math.round((x - 80000) * 0.2);
  return Math.round(x * 0.16);
}
function taxFenFor(db, userId, grossFen) {
  const month = bizdate.monthOfIso(nowISO());
  const prev = db.rewardWithdrawals.where((w) => w.userId === String(userId)
    && bizdate.monthOfIso(w.appliedAt) === month && w.status !== 'rejected')
    .reduce((s, w) => s + w.fen, 0);
  return Math.max(0, cumTaxFen(prev + grossFen) - cumTaxFen(prev));
}

/** 申请提现（默认全额可提余额，可指定金额）；校验：门槛/实名/月次数/单次上限/T+1 */
function applyRewardWithdraw(db, { userId, fen, idempotencyKey }) {
  const uid = String(userId);
  if (switchVal(db, 'adRewardEnabled') !== true) throw new Error('功能维护中，请稍后再试');
  const info = cashInfo(db, uid);
  const amount = fen != null ? Number(fen) : info.withdrawableFen;
  if (!Number.isInteger(amount)) throw new Error('提现金额须为整数分');
  if (!info.realnamed) throw new Error('请先完成实名认证');
  if (amount < info.thresholdFen) throw new Error(`提现金额须满 ¥${(info.thresholdFen / 100).toFixed(0)}`);
  if (amount > info.perWithdrawMaxFen) throw new Error(`单次提现不超过 ¥${(info.perWithdrawMaxFen / 100).toFixed(0)}`);
  if (amount > info.withdrawableFen) throw new Error('可提现余额不足（含 T+1 未到账部分）');
  if (info.monthlyLeft <= 0) throw new Error('本月提现次数已达上限');
  // 幂等：客户端提供 idempotencyKey 时按键去重；未提供时每次调用都是新请求（键必须唯一）
  const autoKey = idempotencyKey
    ? `rewardwd:${idempotencyKey}`
    : `rewardwd:auto:${uid}:${nowISO()}:${crypto.randomUUID()}`;
  const { value: req, replay } = db.idempotency.run(autoKey, () => {
    // 先落提现单再冻结：流水 ref 精确指向本单（rewardWithdraw:<id>），便于按单对账
    const w = db.rewardWithdrawals.insert({
      userId: uid, fen: amount, taxFen: taxFenFor(db, uid, amount),
      status: 'pending_review', // pending_review -> approved -> paid | rejected | failed
      appliedAt: nowISO(),
      realnameName: db.users.get(uid).realnameName,
      transferNo: '',
    });
    moveCash(db, uid, -amount, 'withdraw_freeze', `rewardWithdraw:${w.id}`);
    audit(db, uid, 'adReward.withdraw_apply', { withdrawalId: w.id, fen: amount });
    return w;
  });
  return { withdrawal: req, replay };
}

/**
 * 发放前公共校验：收款用户 / 实名 / 金额与个税口径。
 * 线上转账与线下复核共用，避免两条通道口径漂移。
 */
function payableOf(db, w) {
  const u = db.users.get(w.userId);
  if (!u) throw new Error('收款用户不存在');
  if (!u.realnameHash) throw new Error('收款用户未实名，禁止打款');
  if (!Number.isInteger(w.fen) || w.fen <= 0) throw new Error('提现金额非法');
  const taxFen = w.taxFen == null ? 0 : w.taxFen;
  if (!Number.isInteger(taxFen) || taxFen < 0 || taxFen > w.fen) throw new Error('个税金额非法');
  const paidFen = w.fen - taxFen;
  if (!Number.isInteger(paidFen) || paidFen <= 0) throw new Error('实付金额非法（须为正整数分）');
  return { u, taxFen, paidFen };
}

/** 复核关联校验窗口：复核账号近期被登记人重置过密码，视为不独立 */
const REVIEW_RESET_WINDOW_MS = 7 * 24 * 3600 * 1000;

/** 审计操作者：同时落不可变账号 ID 与用户名（H1） */
function actorRef(id, name) {
  return { id: id != null ? String(id) : '', name: String(name || '') };
}

/** 按不可变账号 ID / 用户名查子管理员账号（总账号不在 adminUsers，返回 null） */
function adminRecordOf(db, id, name) {
  const uid = String(id || '').trim();
  if (uid) {
    const byId = db.adminUsers.where((u) => u.uid === uid)[0];
    if (byId) return byId;
  }
  const uname = String(name || '').trim();
  return uname ? (db.adminUsers.get(uname) || null) : null;
}

/**
 * 复核独立性校验（H1）：
 * ① 同一账号不得自审（优先不可变 ID，历史数据缺 ID 时退化为用户名比较）；
 * ② 复核账号若由登记/初审人创建 → 不具备独立性，须第三人；
 * ③ 复核账号近期（7 天）被登记/初审人重置过密码 → 不具备独立性，须第三人。
 */
function assertIndependentReviewer(db, {
  reviewerId, reviewerName, initiatorId, initiatorName, initiatorLabel = '登记人',
}) {
  const rid = String(reviewerId || '').trim();
  const rname = String(reviewerName || '').trim();
  const iid = String(initiatorId || '').trim();
  const iname = String(initiatorName || '').trim();
  if (!rid && !rname) throw new Error('复核人必填');
  // ① 自审：双方都有 ID 时只认 ID（删除重建同名账号属不同人）；任一方缺 ID 时退化为用户名
  const sameById = rid && iid && rid === iid;
  const sameByName = (!rid || !iid) && rname && iname && rname === iname;
  if (sameById || sameByName) {
    throw new Error(`复核须由第二个管理员完成，${initiatorLabel}不能自审`);
  }
  // ②③ 关系校验：仅对子管理员账号生效（总账号无 createdBy / lastReset 记录）
  const rv = adminRecordOf(db, rid, rname);
  if (!rv) return;
  const creatorId = String(rv.createdById || '');
  const creatorName = String(rv.createdBy || '');
  const createdByIdMatch = iid && creatorId && creatorId === iid;
  const createdByNameMatch = (!iid || !creatorId) && iname && creatorName && creatorName === iname;
  if (createdByIdMatch || createdByNameMatch) {
    throw new Error(`复核账号由${initiatorLabel}创建，不具备独立性，须由第三人复核`);
  }
  if (rv.lastResetById && iid && String(rv.lastResetById) === iid && rv.lastResetAt
    && Date.now() - new Date(rv.lastResetAt).getTime() < REVIEW_RESET_WINDOW_MS) {
    throw new Error(`复核账号近期被${initiatorLabel}重置过密码，不具备独立性，须由第三人复核`);
  }
}

/**
 * 初审通过（第一人）：pending_review → approved。
 * H2：本步**不动资金、不调转账通道**，只确认提现材料并留痕；
 * 真正打款必须由第二个具备财务复核权限的管理员调用 payRewardWithdraw 完成。
 * 开关关闭期间线上流程不可用（存量走线下打款复核通道）。
 */
async function approveRewardWithdraw(db, { withdrawalId, operator = 'admin', operatorId = '' }) {
  if (switchVal(db, 'adRewardEnabled') !== true) {
    throw new Error('广告奖励提现功能已关闭，存量提现请走「登记线下打款 → 第二人复核」通道');
  }
  const w = db.rewardWithdrawals.get(String(withdrawalId));
  if (!w || w.status !== 'pending_review') throw new Error('提现单状态不可初审');
  payableOf(db, w); // 初审即校验收款人/实名/金额口径，避免把不合规单推进到打款环节
  w.status = 'approved';
  w.reviewStage = 'first'; // 标记为「新两步流程的初审通过」；历史 approved 单无此标记，禁止直接复核打款
  w.firstReviewedAt = nowISO();
  w.reviewedBy = operator;
  w.reviewedById = String(operatorId || '');
  w.reviewedAt = nowISO();
  w.reviewNote = w.reviewNote || '';
  audit(db, actorRef(operatorId, operator), 'adReward.withdraw_approve', {
    withdrawalId: w.id, userId: w.userId, fen: w.fen, status: 'approved', stage: 'first_review',
  });
  return db.rewardWithdrawals.get(w.id);
}

/**
 * 复核打款（第二人）：approved → paid。
 * - 必须由与初审人不同的管理员操作，且通过关系校验（创建/重置密码关系不得复核）；
 * - 必须挂接真实转账通道；未挂接直接拒绝，状态保持不变；
 * - 通道抛错：置 failed 并退回余额（可重新申请）；
 * - 通道未返回有效流水号：保持 approved 并记录 lastPayError，可重试（不退款、不误记已打款，M8）；
 * - 成功：置 paid + 写 delta=0 终态流水 + 站内通知，两步均有审计。
 */
async function payRewardWithdraw(db, { withdrawalId, operator = 'admin', operatorId = '' }) {
  if (switchVal(db, 'adRewardEnabled') !== true) {
    throw new Error('广告奖励提现功能已关闭，线上打款两步均不可用；存量请走线下打款复核通道');
  }
  const w = db.rewardWithdrawals.get(String(withdrawalId));
  if (!w || w.status !== 'approved') throw new Error('仅「初审通过」的提现单可复核打款');
  // 历史数据保护：旧流程的 approved 可能已调用过通道但未落流水，禁止新流程直接再打一次
  if (w.reviewStage !== 'first') {
    throw new Error('该单为历史「已通过」数据，可能已出款且流水未知，禁止直接复核打款；请人工核对后处理');
  }
  assertIndependentReviewer(db, {
    reviewerId: operatorId, reviewerName: operator,
    initiatorId: w.reviewedById, initiatorName: w.reviewedBy,
    initiatorLabel: '初审人',
  });
  if (typeof db._rewardTransferHook !== 'function') {
    throw new Error('未配置真实转账通道，禁止标记为已打款（请先接入商家转账或走线下打款流程）');
  }
  const { paidFen } = payableOf(db, w);
  w.lastPayBy = operator;
  w.lastPayById = String(operatorId || '');
  w.lastPayAttemptAt = nowISO();
  w.lastPayAttempts = (w.lastPayAttempts || 0) + 1;

  const t = {
    withdrawalId: w.id, userId: w.userId, fen: paidFen,
    receiverName: w.realnameName,
  };
  let r;
  try {
    r = await db._rewardTransferHook(t); // 支持同步/异步通道
  } catch (e) {
    w.status = 'failed'; w.failReason = String(e.message || e).slice(0, 200);
    moveCash(db, w.userId, w.fen, 'withdraw_fail_refund', `rewardWithdraw:${w.id}`);
    pushMsg(db, w.userId, 'reward_withdraw_result', '提现打款失败',
      `打款失败：${w.failReason}，资金已退回余额，请稍后重试。`);
    audit(db, actorRef(operatorId, operator), 'adReward.withdraw_pay_failed', {
      withdrawalId: w.id, status: w.status, failReason: w.failReason, refunded: true,
    });
    return db.rewardWithdrawals.get(w.id);
  }
  const transferNo = r && r.transferNo ? String(r.transferNo).trim() : '';
  if (!transferNo || /^RTMOCK/i.test(transferNo)) {
    // 通道未给出可核对流水号：保持 approved（可重试），绝不记已打款，也不退款（避免重复出款）
    w.lastPayError = '转账通道未返回有效流水号，未标记为已打款';
    w.lastPayFailedAt = nowISO();
    audit(db, actorRef(operatorId, operator), 'adReward.withdraw_pay_failed', {
      withdrawalId: w.id, status: 'approved', reason: 'invalid_transfer_no',
      transferNo: transferNo || null, retryable: true,
    });
    throw new Error('转账通道未返回有效流水号，已中止打款；可稍后重试或退回初审处理（未标记为已打款）');
  }
  w.transferNo = transferNo;
  w.status = 'paid'; w.reviewStage = 'paid'; w.paidAt = nowISO(); w.paidFen = paidFen;
  w.paidBy = operator;
  w.paidById = String(operatorId || '');
  w.lastPayError = '';
  // 终态流水（delta=0 仅作标记）：与申请时的冻结流水共同构成本单完整资金轨迹
  db.cashLedger.insert({ userId: w.userId, delta: 0, bizType: 'withdraw_paid', refId: `rewardWithdraw:${w.id}`, ts: nowISO() });
  pushMsg(db, w.userId, 'reward_withdraw_result', '提现已打款',
    `¥${(paidFen / 100).toFixed(2)} 已通过商家转账到账（单号 ${transferNo}），请注意查收。`);
  audit(db, actorRef(operatorId, operator), 'adReward.withdraw_pay', {
    withdrawalId: w.id, status: w.status, transferNo, paidFen, initiator: w.reviewedBy,
  });
  return db.rewardWithdrawals.get(w.id);
}

/** 审核驳回：冻结金额退回余额（仅开关开启期间可用） */
function rejectRewardWithdraw(db, { withdrawalId, note, operator = 'admin', operatorId = '' }) {
  if (switchVal(db, 'adRewardEnabled') !== true) {
    throw new Error('广告奖励提现功能已关闭，存量提现只能走线下打款复核，不支持驳回退余额');
  }
  const w = db.rewardWithdrawals.get(String(withdrawalId));
  if (!w || w.status !== 'pending_review') throw new Error('提现单状态不可审核');
  if (!note) throw new Error('驳回必须填写原因');
  w.status = 'rejected';
  w.reviewedBy = operator;
  w.reviewedById = String(operatorId || '');
  w.reviewedAt = nowISO();
  w.reviewNote = String(note).slice(0, 200);
  moveCash(db, w.userId, w.fen, 'withdraw_reject_refund', `rewardWithdraw:${w.id}`);
  pushMsg(db, w.userId, 'reward_withdraw_rejected', '提现申请未通过', `原因：${w.reviewNote}。资金已退回余额。`);
  audit(db, actorRef(operatorId, operator), 'adReward.withdraw_reject', { withdrawalId: w.id, note: w.reviewNote });
  return db.rewardWithdrawals.get(w.id);
}

/** 线下打款时间：接受 ISO 或「YYYY-MM-DD HH:mm」，返回 ISO；必填且不得晚于当前时间 */
function normalizeOfflinePaidAt(paidAt) {
  const raw = String(paidAt || '').trim();
  if (!raw) throw new Error('打款时间必填');
  const isoLike = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(raw) ? raw.replace(' ', 'T') : raw;
  const d = new Date(isoLike);
  if (Number.isNaN(d.getTime())) throw new Error('打款时间格式不正确（YYYY-MM-DD HH:mm）');
  if (d.getTime() > Date.now() + 5 * 60 * 1000) throw new Error('打款时间不得晚于当前时间');
  return d.toISOString();
}

/**
 * 线下打款登记（第一人）：待审 → 待线下打款。
 * 只登记凭证号/打款时间/操作人，不改资金、不写终态流水；
 * 必须由另一个管理员 confirmOfflinePayout 复核后才置已发放（单人或本人复核不得通过）。
 */
function markOfflinePayout(db, { withdrawalId, voucherNo, paidAt, operator, operatorId = '', note = '' }) {
  const op = String(operator || '').trim();
  if (!op) throw new Error('操作人必填');
  const w = db.rewardWithdrawals.get(String(withdrawalId));
  if (!w) throw new Error('提现单不存在');
  if (w.status !== 'pending_review') throw new Error('仅待审核的提现单可登记线下打款');
  const voucher = String(voucherNo || '').trim();
  if (!voucher) throw new Error('线下打款凭证号必填');
  if (voucher.length > 64) throw new Error('凭证号最多 64 字');
  const paidIso = normalizeOfflinePaidAt(paidAt);
  payableOf(db, w); // 复核收款人/实名/金额口径，不合规的单一律不得进入打款流程
  w.status = 'pending_offline';
  w.offlineVoucherNo = voucher;
  w.offlinePaidAt = paidIso;
  w.offlineMarkedBy = op;
  w.offlineMarkedById = String(operatorId || '');
  w.offlineMarkedAt = nowISO();
  w.offlineNote = String(note || '').slice(0, 200);
  audit(db, actorRef(operatorId, op), 'adReward.withdraw_offline_mark', {
    withdrawalId: w.id, voucherNo: voucher, paidAt: paidIso,
    initiator: op, initiatorId: String(operatorId || ''),
  });
  return db.rewardWithdrawals.get(w.id);
}

/**
 * 线下打款复核（第二人）：待线下打款 → 已发放，并写终态资金流水。
 * 复核人必须与登记人不同（按不可变账号 ID 判定），且不得由登记人创建、
 * 或近期被登记人重置过密码；只接受 pending_offline，重复复核会报错且不会重复写流水。
 */
function confirmOfflinePayout(db, { withdrawalId, operator, operatorId = '', note = '' }) {
  const op = String(operator || '').trim();
  if (!op) throw new Error('复核人必填');
  const w = db.rewardWithdrawals.get(String(withdrawalId));
  if (!w) throw new Error('提现单不存在');
  if (w.status !== 'pending_offline') throw new Error('仅「待线下打款」的提现单可复核发放');
  if (!w.offlineMarkedBy && !w.offlineMarkedById) throw new Error('缺少线下打款登记人，不能复核');
  assertIndependentReviewer(db, {
    reviewerId: operatorId, reviewerName: op,
    initiatorId: w.offlineMarkedById, initiatorName: w.offlineMarkedBy,
    initiatorLabel: '登记人',
  });
  const { paidFen } = payableOf(db, w);
  w.status = 'paid';
  w.paidFen = paidFen;
  w.paidAt = w.offlinePaidAt;
  w.offlineConfirmedBy = op;
  w.offlineConfirmedById = String(operatorId || '');
  w.offlineConfirmedAt = nowISO();
  if (note) w.offlineReviewNote = String(note).slice(0, 200);
  // 终态流水（delta=0 仅作标记）：与申请时的冻结流水共同构成本单完整资金轨迹
  db.cashLedger.insert({ userId: w.userId, delta: 0, bizType: 'withdraw_paid', refId: `rewardWithdraw:${w.id}`, ts: nowISO() });
  pushMsg(db, w.userId, 'reward_withdraw_result', '提现已打款',
    `¥${(paidFen / 100).toFixed(2)} 已通过线下打款发放（凭证号 ${w.offlineVoucherNo}），请注意查收。`);
  audit(db, actorRef(operatorId, op), 'adReward.withdraw_offline_confirm', {
    withdrawalId: w.id, voucherNo: w.offlineVoucherNo,
    initiator: w.offlineMarkedBy, initiatorId: w.offlineMarkedById || '', paidFen,
  });
  return db.rewardWithdrawals.get(w.id);
}

/** 管理端提现队列 */
function listRewardWithdrawals(db, { status } = {}) {
  return db.rewardWithdrawals.all()
    .filter((w) => !status || w.status === status)
    .sort((a, b) => (a.appliedAt < b.appliedAt ? 1 : -1))
    .map((w) => {
      const u = db.users.get(w.userId) || {};
      return { ...w, userNickname: u.nickname || '', realnameMasked: u.realnameMasked || '' };
    });
}

/** 用户端提现记录 */
function myRewardWithdrawals(db, userId) {
  return db.rewardWithdrawals.where((w) => w.userId === String(userId))
    .sort((a, b) => (a.appliedAt < b.appliedAt ? 1 : -1))
    .map((w) => ({
      id: w.id, fen: w.fen, taxFen: w.taxFen, paidFen: w.paidFen || 0,
      status: w.status, appliedAt: w.appliedAt, paidAt: w.paidAt || '',
      transferNo: w.transferNo || '', voucherNo: w.offlineVoucherNo || '',
      reviewNote: w.reviewNote || '',
    }));
}

module.exports = {
  CHARGE_PRESETS_FEN,
  derivePricing, createVideo, reviewVideo, offlineVideo, listVideosAdmin, adminVideoView,
  listVideosForUser, productOfVideo, startWatch, reward, ipOf,
  cashInfo, grantCash, moveCash, submitRealname, validIdCard,
  applyRewardWithdraw, approveRewardWithdraw, payRewardWithdraw, rejectRewardWithdraw,
  markOfflinePayout, confirmOfflinePayout,
  listRewardWithdrawals, myRewardWithdrawals, taxFenFor, cumTaxFen,
};
