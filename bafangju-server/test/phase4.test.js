'use strict';
/**
 * 第四期测试：支付回调验签/解密、商家转账 provider、团队长池持久化分配跑批、季度分红自动核算。
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const pay = require('../src/domain/pay');
const transfer = require('../src/domain/transfer');
const commission = require('../src/domain/commission');
const quarter = require('../src/domain/quarter');
const svc = require('../src/services');
const { createStore } = require('../src/store');

const PLAN = { platform: 0.02, leader: 0.08, direct: 0.70, indirect: 0.20 };

// ---------- 支付回调验签 + 解密 ----------

test('回调验签：正确签名通过并解密 resource；篡改报文拒绝', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const apiV3Key = Buffer.from('0123456789abcdef0123456789abcdef'); // 32 字节
  const cfg = {
    mchid: 'm', appid: 'a', serial: 's',
    privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    platformCert: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    apiV3Key,
  };
  const provider = pay.wxpayProvider(cfg, async () => ({}));

  // 构造 resource（AES-256-GCM 加密）
  const resource = { out_trade_no: 'o_1', transaction_id: 'wxT1', amount: { total: 800 } };
  const nonce = 'nonce123';
  const aad = 'transaction';
  const cipher = crypto.createCipheriv('aes-256-gcm', apiV3Key, nonce);
  cipher.setAAD(Buffer.from(aad));
  const enc = Buffer.concat([cipher.update(JSON.stringify(resource), 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
  const rawBody = JSON.stringify({ event_type: 'TRANSACTION.SUCCESS', resource: { ciphertext: enc, nonce, associated_data: aad } });
  const ts = '1750000000';
  const rNonce = 'reqnonce';
  const signature = crypto.createSign('RSA-SHA256').update(`${ts}\n${rNonce}\n${rawBody}\n`).sign(privateKey, 'base64');
  const headers = { 'wechatpay-timestamp': ts, 'wechatpay-nonce': rNonce, 'wechatpay-signature': signature, 'wechatpay-serial': 'PUB1' };

  // now 与固定时间戳对齐（验签增加了 5 分钟防重放窗口，固定 ts 必须配对 now 才不会误判为过期）
  const now = Number(ts) * 1000;
  const r = await provider.verifyNotify({ headers, rawBody, now });
  assert.strictEqual(r.orderId, 'o_1');
  assert.strictEqual(r.transactionId, 'wxT1');
  assert.strictEqual(r.paidFen, 800);

  // 篡改签名（报文被改动后签名不符）→ 验签失败
  const badHeaders = { ...headers, 'wechatpay-signature': Buffer.from('forged').toString('base64') };
  await assert.rejects(provider.verifyNotify({ headers: badHeaders, rawBody, now }), /验签失败/);
  // 缺验签头 → 拒绝
  await assert.rejects(provider.verifyNotify({ headers: {}, rawBody, now }), /缺少验签头/);
});

test('未配置平台证书/APIv3 密钥时 verifyNotify 明确拒绝', async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const provider = pay.wxpayProvider({
    mchid: 'm', appid: 'a', serial: 's',
    privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
  }, async () => ({}));
  await assert.rejects(provider.verifyNotify({ headers: {}, rawBody: '{}' }), /验签尚未接入/);
});

// ---------- 商家转账 provider ----------

test('转账通道：未配置自动 mock；wechat provider 缺 openid 拒绝、请求体结构正确', async () => {
  assert.strictEqual(transfer.getTransferProvider({}).name, 'mock');
  assert.strictEqual(transfer.wxTransferConfigFromEnv({ WX_MCHID: 'm' }), null);

  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const env = {
    WX_MCHID: '1900000001', WX_APPID: 'wxapp', WX_MERCHANT_SERIAL: 'SERIAL01',
    WX_PRIVATE_KEY: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    WX_APIV3_KEY: '0123456789abcdef0123456789abcdef',
  };
  assert.strictEqual(transfer.getTransferProvider(env).name, 'wechat');

  let captured = null;
  const p = transfer.wechatTransferProvider(transfer.wxTransferConfigFromEnv(env), async (url, opts) => {
    captured = { url, opts };
    return { json: async () => ({ batch_id: 'batch1', detail_id: 'd1' }) };
  });
  await assert.rejects(p.submitTransfer({ transferNo: 'TX1', amountFen: 100 }), /openid/);
  const r = await p.submitTransfer({ transferNo: 'TX1', openid: 'oABC', amountFen: 100, remark: '收益提现' });
  assert.strictEqual(r.provider, 'wechat');
  assert.strictEqual(r.batchId, 'batch1');
  const body = JSON.parse(captured.opts.body);
  assert.strictEqual(body.out_batch_no, 'TX1');
  assert.strictEqual(body.transfer_detail_list[0].transfer_amount, 100);
  assert.ok(captured.url.endsWith('/v3/transfer/batches'));
});

test('转账通道挂接：提交失败标记 submit_failed 且不阻塞记账', async () => {
  const db = createStore();
  db.switches.set('withdrawEnabled', true);
  db.earnings.insert({ id: 'm1', balanceFen: 1000, frozenFen: 0 });
  db._transferHook = (t) => { throw new Error('缺收款人 openid（商家需先绑定收款微信）'); };
  const { request } = require('../src/domain/withdraw').applyWithdraw(db, { userId: 'm1', fen: 1000, idempotencyKey: 'w1' });
  const r = require('../src/domain/withdraw').approveWithdraw(db, { requestId: request.id, date: '2026-10-24' });
  assert.strictEqual(r.issuedFen, 1000); // 记账完成
  const t = db.withdrawTransfers.all()[0];
  assert.strictEqual(t.status, 'submit_failed');
  assert.match(t.submitError, /openid/);
});

// ---------- 团队长池持久化 + 分配跑批 ----------

test('团队长池分配跑批：按贡献权重发放至收益余额，池守恒、幂等', () => {
  const db = createStore();
  commission.bookCommission(db, { orderId: 'o1', baseFen: 10000, plan: PLAN, indirectEnabled: false, directUserId: 'u1', leaderUserId: 'L1' });
  commission.bookCommission(db, { orderId: 'o2', baseFen: 10000, plan: PLAN, indirectEnabled: false, directUserId: 'u2', leaderUserId: 'L2' });
  const noLeader = commission.bookCommission(db, { orderId: 'o3', baseFen: 5000, plan: PLAN, indirectEnabled: false, directUserId: 'u3', leaderUserId: null });
  assert.strictEqual(noLeader.unattributedFen, 400); // V3.4：无归属团队长份额归平台留存，不再沉淀在池中
  const pool = commission.leaderPoolBalanceFen(db); // (10000+10000)×8% = 1600
  assert.strictEqual(pool, 1600);

  const r = commission.distributeLeaderPoolJob(db, { batchKey: 'b1', coefficient: 1.0 });
  assert.strictEqual(r.paidFen, 1600);
  assert.strictEqual(r.paidCount, 2);
  assert.strictEqual(commission.leaderPoolBalanceFen(db), 0);
  // L1 贡献 800 : L2 贡献 800 → 各 800
  assert.strictEqual(db.earnings.get('L1').balanceFen, 800);
  assert.strictEqual(db.earnings.get('L2').balanceFen, 800);
  // 幂等：同批次键重放
  const r2 = commission.distributeLeaderPoolJob(db, { batchKey: 'b1', coefficient: 1.0 });
  assert.strictEqual(r2.replay, true);
  assert.strictEqual(db.earnings.get('L1').balanceFen, 800);
  // 系数生效：L1 贡献 800×2 : L2 800×1
  commission.bookCommission(db, { orderId: 'o4', baseFen: 10000, plan: PLAN, indirectEnabled: false, directUserId: 'u1', leaderUserId: 'L1' });
  const r3 = commission.distributeLeaderPoolJob(db, { batchKey: 'b2', coefficient: 2.0 });
  assert.strictEqual(r3.paidFen, 800);
  assert.ok(db.earnings.get('L1').balanceFen > db.earnings.get('L2').balanceFen);
});

// ---------- 季度分红自动核算与发放 ----------

test('季度自动核算：真实订单/广告数据 -> 三门槛 -> 发放（储备扣减守恒、每季度幂等）', () => {
  const db = createStore();
  // 2026Q3：u1 消费 6000 元（达标 5000）、团队 2 人全活跃、广告 200 元 → 三门槛全过
  // u2 消费 1000 元（不达标）
  for (const [uid, price] of [['u1', 600000], ['u2', 100000]]) {
    const order = db.orders.insert({ userId: uid, payType: 'WX_PAY', status: 'done', priceFen: price, paidFen: price, directUserId: null, createdAt: '2026-08-01T00:00:00.000Z' });
  }
  // u1 直推 u3，u3 也消费 100 元（计入 u1 团队业绩）
  db.orders.insert({ userId: 'u3', payType: 'WX_PAY', status: 'done', priceFen: 10000, paidFen: 10000, directUserId: 'u1', createdAt: '2026-08-02T00:00:00.000Z' });
  db.activitySnapshots.insert({ date: '2026-08-15', userId: 'u1', active: true });
  db.activitySnapshots.insert({ date: '2026-08-15', userId: 'u3', active: true });
  db.adBookings.insert({ slotId: 's', merchantId: 'u1', feeFen: 20000, days: 7, status: 'active', startAt: '2026-08-03T00:00:00.000Z' });
  quarter.reserveDeposit(db, { source: 'ad_revenue', fen: 1000000, ref: 'seed' }); // 储备 1 万元

  const results = svc.runQuarterAssessment(db, { quarterLabel: '2026Q3' });
  assert.strictEqual(results.length, 3);
  const u1 = results.find((r) => r.userId === 'u1');
  assert.strictEqual(u1.quarterConsumptionFen, 610000); // 6000 元本人 + 100 元（直推 u3）
  assert.strictEqual(u1.activeUserRatio, 1); // 2/2
  assert.strictEqual(u1.adSpendFen, 20000);
  assert.strictEqual(u1.eligible, true);
  assert.strictEqual(results.find((r) => r.userId === 'u2').eligible, false);

  const before = quarter.reserveBalanceFen(db); // 1 万元
  const payout = svc.runQuarterPayout(db, { quarterLabel: '2026Q3' });
  assert.strictEqual(payout.paidFen, 600000); // 10000×0.6，全给 u1（唯一达标）
  assert.strictEqual(db.earnings.get('u1').dividendBalanceFen, 600000);
  assert.strictEqual(quarter.reserveBalanceFen(db), before - 600000); // 储备扣减守恒
  // 幂等：同季度重放不重复发放
  const payout2 = svc.runQuarterPayout(db, { quarterLabel: '2026Q3' });
  assert.strictEqual(payout2.replay, true);
  assert.strictEqual(db.earnings.get('u1').dividendBalanceFen, 600000);
});

test('G11：季度归属按支付/完成时间；广告投放仅统计有效状态', () => {
  const db = createStore();
  // 下单在 Q2、支付在 Q3 → 计入 Q3
  db.orders.insert({
    userId: 'p1', payType: 'WX_PAY', status: 'done', priceFen: 600000, paidFen: 600000,
    directUserId: null, createdAt: '2026-05-01T00:00:00.000Z', paidAt: '2026-08-10T00:00:00.000Z',
  });
  db.activitySnapshots.insert({ date: '2026-08-15', userId: 'p1', active: true });
  // 有效投放计入；未生效 / 被驳回 / 已取消一律排除
  db.adBookings.insert({ slotId: 's', merchantId: 'p1', feeFen: 20000, days: 7, status: 'active', reviewStatus: 'approved', startAt: '2026-08-03T00:00:00.000Z' });
  db.adBookings.insert({ slotId: 's', merchantId: 'p1', feeFen: 90000, days: 7, status: 'pending', reviewStatus: 'pending', startAt: '2026-08-03T00:00:00.000Z' });
  db.adBookings.insert({ slotId: 's', merchantId: 'p1', feeFen: 90000, days: 7, status: 'rejected', reviewStatus: 'rejected', startAt: '2026-08-03T00:00:00.000Z' });
  db.adBookings.insert({ slotId: 's', merchantId: 'p1', feeFen: 90000, days: 7, status: 'cancelled', reviewStatus: 'approved', startAt: '2026-08-03T00:00:00.000Z' });
  // 只有未生效广告的商家不应进入候选人
  db.adBookings.insert({ slotId: 's', merchantId: 'm_pending', feeFen: 1000, days: 7, status: 'pending', reviewStatus: 'pending', startAt: '2026-08-03T00:00:00.000Z' });

  const rows = svc.runQuarterAssessment(db, { quarterLabel: '2026Q3' });
  const p1 = rows.find((r) => r.userId === 'p1');
  assert.ok(p1, '支付在 Q3 的订单应进入 Q3 候选');
  assert.strictEqual(p1.quarterConsumptionFen, 600000);
  assert.strictEqual(p1.adSpendFen, 20000, '仅有效投放计入广告贡献');
  assert.ok(!rows.some((r) => r.userId === 'm_pending'), '未生效广告商家不应成为候选人');

  // 下单在 Q3 末、支付在 Q4 → 归入 Q4，不计入 Q3
  db.orders.insert({
    userId: 'p2', payType: 'WX_PAY', status: 'paid', priceFen: 600000, paidFen: 600000,
    directUserId: null, createdAt: '2026-09-30T00:00:00.000Z', paidAt: '2026-10-01T00:00:00.000Z',
  });
  const q3 = svc.runQuarterAssessment(db, { quarterLabel: '2026Q3' });
  assert.ok(!q3.some((r) => r.userId === 'p2'), '支付跨季订单不得计入 Q3');
  const q4 = svc.runQuarterAssessment(db, { quarterLabel: '2026Q4' });
  assert.ok(q4.some((r) => r.userId === 'p2'), '支付在 Q4 的订单归入 Q4');
});

test('季度范围解析与非法入参', () => {
  const { startISO, endISO } = svc.quarterRange('2026Q4');
  assert.strictEqual(startISO, '2026-10-01T00:00:00.000Z');
  assert.strictEqual(endISO, '2027-01-01T00:00:00.000Z');
  assert.throws(() => svc.quarterRange('bad'), /季度格式非法/);
});

test('季度发放幂等（B2）：0 元跑批不锁季；已发放后重跑不重复加钱、不重复扣储备', () => {
  const db = createStore();
  // 无资格快照先跑发放：返回 0，且不落批次（后续核算达标后仍可正常发放）
  const empty = svc.runQuarterPayout(db, { quarterLabel: '2026Q3' });
  assert.strictEqual(empty.paidFen, 0);
  assert.strictEqual(db.quarterPayouts.all().length, 0, '0 元跑批不得锁定季度');

  db.orders.insert({ userId: 'q1', payType: 'WX_PAY', status: 'done', priceFen: 600000, paidFen: 600000, createdAt: '2026-08-01T00:00:00.000Z' });
  db.activitySnapshots.insert({ date: '2026-08-15', userId: 'q1', active: true });
  db.adBookings.insert({ slotId: 's', merchantId: 'q1', feeFen: 20000, days: 7, status: 'active', startAt: '2026-08-03T00:00:00.000Z' });
  quarter.reserveDeposit(db, { source: 'ad_revenue', fen: 1000000, ref: 'seed' });
  svc.runQuarterAssessment(db, { quarterLabel: '2026Q3' });

  const first = svc.runQuarterPayout(db, { quarterLabel: '2026Q3' });
  assert.strictEqual(first.replay, false);
  assert.strictEqual(first.paidFen, 600000);
  const batch = db.quarterPayouts.all()[0];
  assert.strictEqual(batch.status, 'paid');
  assert.strictEqual(batch.paidFen, 600000);

  // 模拟重启/重复点击：多次重跑只回放批次，不再增加用户余额与储备出账
  const reserveAfter = quarter.reserveBalanceFen(db);
  for (let i = 0; i < 3; i += 1) {
    const again = svc.runQuarterPayout(db, { quarterLabel: '2026Q3' });
    assert.strictEqual(again.replay, true);
    assert.strictEqual(again.paidFen, 600000);
  }
  assert.strictEqual(db.earnings.get('q1').dividendBalanceFen, 600000);
  assert.strictEqual(quarter.reserveBalanceFen(db), reserveAfter);
  assert.strictEqual(db.dividendPayouts.all().length, 1);

  // 存在未完成批次（paying）时拒绝再次发放，要求人工核对
  db.quarterPayouts.insert({ quarter: '2026Q4', poolFen: 1000, paidFen: 0, paidCount: 0, status: 'paying', ts: new Date().toISOString() });
  assert.throws(() => svc.runQuarterPayout(db, { quarterLabel: '2026Q4' }), /禁止重复发放/);

  // 非法季度格式
  assert.throws(() => svc.runQuarterPayout(db, { quarterLabel: '2026-Q3' }), /季度格式非法/);
});
