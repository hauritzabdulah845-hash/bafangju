'use strict';
/**
 * 支付适配层测试：provider 选择降级、v3 下单签名结构、金额校验、回调验签保护。
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const pay = require('../src/domain/pay');

test('未配置微信支付参数时自动降级 mock', () => {
  const p = pay.getPayProvider({});
  assert.strictEqual(p.name, 'mock');
});

test('配置齐全时启用 wxpay provider', async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const env = {
    WX_MCHID: '1900000001', WX_APPID: 'wxapp', WX_MERCHANT_SERIAL: 'SERIAL01',
    WX_PRIVATE_KEY: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
  };
  const cfg = pay.wxPayConfigFromEnv(env);
  assert.ok(cfg && cfg.mchid === '1900000001');
  const p = pay.getPayProvider(env);
  assert.strictEqual(p.name, 'wxpay');
});

test('v3 JSAPI 下单：请求体金额整数分、out_trade_no=订单号、签名头结构正确', async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const cfg = {
    mchid: '1900000001', appid: 'wxapp', serial: 'SERIAL01',
    privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
  };
  let captured = null;
  const provider = pay.wxpayProvider(cfg, async (url, opts) => {
    captured = { url, opts };
    return { json: async () => ({ prepay_id: 'wxPrepay123' }) };
  });
  const r = await provider.createPrepay({ orderId: 'o_9', openid: 'oX', amountFen: 800, description: '测试' });
  assert.strictEqual(r.provider, 'wxpay');
  assert.strictEqual(r.prepayId, 'wxPrepay123');
  const body = JSON.parse(captured.opts.body);
  assert.strictEqual(body.amount.total, 800);
  assert.strictEqual(body.out_trade_no, 'o_9');
  assert.strictEqual(body.payer.openid, 'oX');
  assert.ok(captured.url.startsWith('https://api.mch.weixin.qq.com/v3/pay/transactions/jsapi'));
  const auth = captured.opts.headers.Authorization;
  assert.match(auth, /^WECHATPAY2-SHA256-RSA2048 mchid="1900000001",nonce_str="[0-9a-f]+",signature="[^"]+",timestamp="\d+",serial_no="SERIAL01"$/);
  // 签名可验：message = METHOD\nurlPath\nts\nnonce\nbody\n
  const m = auth.match(/nonce_str="([0-9a-f]+)",signature="([^"]+)",timestamp="(\d+)"/);
  const [, nonce, sig, ts] = m;
  const message = `POST\n/v3/pay/transactions/jsapi\n${ts}\n${nonce}\n${captured.opts.body}\n`;
  const ok = crypto.createVerify('RSA-SHA256').update(message).verify(privateKey, sig, 'base64');
  assert.ok(ok, 'RSA 签名验证应通过');
});

test('金额非法（非整数分/负数）拒绝下单', async () => {
  const mock = pay.mockProvider();
  await assert.rejects(mock.createPrepay({ orderId: 'o', amountFen: 10.5 }), /金额非法/);
  await assert.rejects(mock.createPrepay({ orderId: 'o', amountFen: -1 }), /金额非法/);
});

test('回调验签未接入前明确拒绝（防止伪造回调入账）', async () => {
  const mock = pay.mockProvider();
  await assert.rejects(mock.verifyNotify(), /mock provider 无真实回调/);
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const wx = pay.wxpayProvider({ mchid: 'm', appid: 'a', serial: 's', privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString() }, async () => ({}));
  await assert.rejects(wx.verifyNotify(), /验签尚未接入/);
});

test('v3 下单接口报错时透出微信错误码', async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const provider = pay.wxpayProvider(
    { mchid: 'm', appid: 'a', serial: 's', privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString() },
    async () => ({ json: async () => ({ code: 'INVALID_REQUEST', message: '参数错误' }) }),
  );
  await assert.rejects(provider.createPrepay({ orderId: 'o', openid: 'x', amountFen: 100 }), /INVALID_REQUEST/);
});

test('支付模式：PAY_MODE 显式优先，未设置按配置自动判定；live 缺配置直接报错', () => {
  const cfgEnv = { WX_MCHID: 'm', WX_APPID: 'a', WX_MERCHANT_SERIAL: 's', WX_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----' };
  assert.strictEqual(pay.resolvePayMode({}), 'mock');
  assert.strictEqual(pay.resolvePayMode({ PAY_MODE: 'mock', ...cfgEnv }), 'mock'); // 显式 mock 即使已配置
  assert.strictEqual(pay.resolvePayMode({ PAY_MODE: 'live' }), 'live');
  assert.strictEqual(pay.resolvePayMode(cfgEnv), 'live'); // 未设置 + 配齐 → 自动真实
  assert.throws(() => pay.getPayProvider({ PAY_MODE: 'live' }), /未配置完整/);
});

test('生产环境支付守卫：未配商户号或显式 mock 一律拒绝启动', () => {
  const cfgEnv = { WX_MCHID: 'm', WX_APPID: 'a', WX_MERCHANT_SERIAL: 's', WX_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----' };
  // 非生产环境：保持原有自动降级行为，不阻拦
  assert.strictEqual(pay.assertProductionPayMode({}), 'mock');
  assert.strictEqual(pay.assertProductionPayMode({ NODE_ENV: 'development' }), 'mock');
  // 生产环境 + 未配置商户号 → 拒绝（mock 下 notify 可零元下单）
  assert.throws(() => pay.assertProductionPayMode({ NODE_ENV: 'production' }), /生产环境禁止模拟支付通道/);
  // 生产环境 + 显式 PAY_MODE=mock → 同样拒绝
  assert.throws(() => pay.assertProductionPayMode({ NODE_ENV: 'production', PAY_MODE: 'mock' }), /生产环境禁止模拟支付通道/);
  // 生产环境 + 商户材料齐全 → 放行
  assert.strictEqual(pay.assertProductionPayMode({ NODE_ENV: 'production', ...cfgEnv }), 'live');
  assert.strictEqual(pay.assertProductionPayMode({ NODE_ENV: 'production', PAY_MODE: 'live', ...cfgEnv }), 'live');
});

test('JSAPI 支付签名：参数结构正确且可用商户公钥验签', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const cfg = { appid: 'wxapp', privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString() };
  const p = pay.buildJsapiPayParams(cfg, 'wxPrepay123', 1700000000000);
  assert.strictEqual(p.package, 'prepay_id=wxPrepay123');
  assert.strictEqual(p.signType, 'RSA');
  assert.match(p.nonceStr, /^[0-9a-f]{32}$/);
  assert.strictEqual(p.timeStamp, '1700000000');
  const message = `wxapp\n${p.timeStamp}\n${p.nonceStr}\n${p.package}\n`;
  const ok = crypto.createVerify('RSA-SHA256').update(message).verify(publicKey, p.paySign, 'base64');
  assert.ok(ok, '支付签名应可用商户公钥验证');
});

test('JSAPI 下单返回 wx.requestPayment 所需参数；真实通道缺 openid 拒绝', async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const cfg = { mchid: 'm', appid: 'a', serial: 's', privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString() };
  const provider = pay.wxpayProvider(cfg, async () => ({ json: async () => ({ prepay_id: 'wxPrepay123' }) }));
  const r = await provider.createPrepay({ orderId: 'o', openid: 'oX', amountFen: 100, description: '测试' });
  assert.strictEqual(r.provider, 'wxpay');
  assert.ok(r.payParams && r.payParams.paySign);
  assert.strictEqual(r.payParams.package, 'prepay_id=wxPrepay123');
  await assert.rejects(provider.createPrepay({ orderId: 'o', amountFen: 100 }), /openid/);
});

test('v3 退款：金额/单号/签名正确，SUCCESS 与 PROCESSING 受理，ABNORMAL 拒绝', async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const cfg = {
    mchid: '1900000001', appid: 'wxapp', serial: 'SERIAL01',
    privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    refundNotifyUrl: 'https://example.com/api/payment/refund-notify',
  };
  let captured = null;
  const provider = pay.wxpayProvider(cfg, async (url, opts) => {
    captured = { url, opts };
    return { json: async () => ({ refund_id: 'r1', out_refund_no: 'RF_o1', status: 'SUCCESS' }) };
  });
  const r = await provider.refund({ orderId: 'o1', refundNo: 'RF_o1', amountFen: 800, totalFen: 800, reason: '质量问题' });
  assert.strictEqual(r.status, 'SUCCESS');
  assert.ok(captured.url.startsWith('https://api.mch.weixin.qq.com/v3/refund/domestic/refunds'));
  const body = JSON.parse(captured.opts.body);
  assert.strictEqual(body.out_trade_no, 'o1');
  assert.strictEqual(body.out_refund_no, 'RF_o1');
  assert.strictEqual(body.amount.refund, 800);
  assert.strictEqual(body.amount.total, 800);
  assert.strictEqual(body.amount.currency, 'CNY');
  assert.strictEqual(body.notify_url, 'https://example.com/api/payment/refund-notify');
  // 请求签名可验：message = METHOD\nurlPath\nts\nnonce\nbody\n
  const auth = captured.opts.headers.Authorization;
  const m = auth.match(/nonce_str="([0-9a-f]+)",signature="([^"]+)",timestamp="(\d+)"/);
  const [, nonce, sig, ts] = m;
  const message = `POST\n/v3/refund/domestic/refunds\n${ts}\n${nonce}\n${captured.opts.body}\n`;
  assert.ok(crypto.createVerify('RSA-SHA256').update(message).verify(privateKey, sig, 'base64'));

  const processing = pay.wxpayProvider(cfg, async () => ({ json: async () => ({ status: 'PROCESSING' }) }));
  assert.strictEqual((await processing.refund({ orderId: 'o', refundNo: 'RF_o', amountFen: 100, totalFen: 100 })).status, 'PROCESSING');

  const abnormal = pay.wxpayProvider(cfg, async () => ({ json: async () => ({ status: 'ABNORMAL' }) }));
  await assert.rejects(abnormal.refund({ orderId: 'o', refundNo: 'RF_o', amountFen: 100, totalFen: 100 }), /未受理/);

  // 主动查单：GET 退款单并映射状态/金额
  let queried = null;
  const query = pay.wxpayProvider(cfg, async (url, opts) => {
    queried = { url, opts };
    return { json: async () => ({ refund_id: 'r1', out_refund_no: 'RF_o1', status: 'PROCESSING', amount: { refund: 800 } }) };
  });
  const q = await query.queryRefund('RF_o1');
  assert.strictEqual(q.status, 'PROCESSING');
  assert.strictEqual(q.amountFen, 800);
  assert.ok(queried.url.endsWith('/v3/refund/domestic/refunds/RF_o1'));

  // 缺退款结果通知地址 → 发起退款前安全失败（状态不变，不产生"假的成功"）
  const noNotify = pay.wxpayProvider({ ...cfg, refundNotifyUrl: null }, async () => ({ json: async () => ({ status: 'SUCCESS' }) }));
  await assert.rejects(noNotify.refund({ orderId: 'o', refundNo: 'RF_o', amountFen: 100, totalFen: 100 }), /WX_REFUND_NOTIFY_URL/);

  // 金额校验：退款金额不得大于总额
  await assert.rejects(provider.refund({ orderId: 'o', refundNo: 'RF_o', amountFen: 200, totalFen: 100 }), /退款总额非法/);
});

test('mock 退款：返回成功且不动真钱', async () => {
  const mock = pay.mockProvider();
  const r = await mock.refund({ orderId: 'o1', refundNo: 'RF_o1', amountFen: 500 });
  assert.strictEqual(r.provider, 'mock');
  assert.strictEqual(r.status, 'SUCCESS');
  assert.strictEqual(r.amountFen, 500);
});

// ---------- live 通道就绪自检（缺回调地址会「扣款成功但订单不入账」） ----------

test('live 就绪自检：缺 WX_NOTIFY_URL / APIv3 / 平台证书时逐项报出', () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const base = {
    WX_MCHID: 'm', WX_APPID: 'a', WX_MERCHANT_SERIAL: 's',
    WX_PRIVATE_KEY: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
  };
  // mock 模式不校验
  assert.strictEqual(pay.checkLiveReadiness({}).ok, true);

  const r = pay.checkLiveReadiness(base);
  assert.strictEqual(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes('WX_NOTIFY_URL')));
  assert.ok(r.problems.some((p) => p.includes('WX_APIV3_KEY')));
  assert.ok(r.problems.some((p) => p.includes('WX_PLATFORM_CERT')));

  const full = {
    ...base,
    WX_NOTIFY_URL: 'https://api.example.com/api/payment/notify-wx',
    WX_APIV3_KEY: '0123456789abcdef0123456789abcdef',
    WX_PLATFORM_CERT: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
  };
  const ok = pay.checkLiveReadiness(full);
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(ok.problems, []);

  // 非 HTTPS 回调地址同样拦下
  const http = pay.checkLiveReadiness({ ...full, WX_NOTIFY_URL: 'http://api.example.com/notify' });
  assert.strictEqual(http.ok, false);
  assert.ok(http.problems.some((p) => p.includes('HTTPS')));
});

// ---------- 回调验签加固：防重放 + 序列号匹配 + 解密 ----------

/** 构造一条微信 v3 支付回调：resource 用 APIv3 密钥 AES-256-GCM 加密，报文体用平台私钥签名 */
function buildNotify({ platformPrivateKey, apiV3Key, ts, serial, orderId = 'o_1', amount = 800, eventType = 'TRANSACTION.SUCCESS' }) {
  const nonce = 'abcdefghijkl';
  const aad = 'transaction';
  const plain = JSON.stringify({ out_trade_no: orderId, transaction_id: 'wx_tx_1', amount: { total: amount } });
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(apiV3Key), Buffer.from(nonce));
  cipher.setAAD(Buffer.from(aad));
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const ciphertext = Buffer.concat([enc, cipher.getAuthTag()]).toString('base64');
  const rawBody = JSON.stringify({ event_type: eventType, resource: { ciphertext, nonce, associated_data: aad } });
  const headerNonce = 'hdrnonce123';
  const message = `${ts}\n${headerNonce}\n${rawBody}\n`;
  const signature = crypto.createSign('RSA-SHA256').update(message).sign(platformPrivateKey, 'base64');
  return {
    headers: {
      'wechatpay-timestamp': String(ts), 'wechatpay-nonce': headerNonce,
      'wechatpay-signature': signature, 'wechatpay-serial': serial,
    },
    rawBody,
  };
}

function notifyFixture() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const apiV3Key = '0123456789abcdef0123456789abcdef';
  const cfg = {
    mchid: 'm', appid: 'a', serial: 's',
    privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    platformCert: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    apiV3Key, platformSerial: 'PLAT01',
  };
  return { platformPrivateKey: privateKey, apiV3Key, provider: pay.wxpayProvider(cfg, async () => ({})) };
}

test('回调验签+解密：合法报文返回订单号、微信单号与实付金额', async () => {
  const { platformPrivateKey, apiV3Key, provider } = notifyFixture();
  const ts = Math.floor(Date.now() / 1000);
  const notify = buildNotify({ platformPrivateKey, apiV3Key, ts, serial: 'PLAT01' });
  const r = await provider.verifyNotify({ ...notify, now: ts * 1000 });
  assert.strictEqual(r.orderId, 'o_1');
  assert.strictEqual(r.transactionId, 'wx_tx_1');
  assert.strictEqual(r.paidFen, 800);
});

test('回调防重放：时间戳超出 5 分钟窗口一律拒绝', async () => {
  const { platformPrivateKey, apiV3Key, provider } = notifyFixture();
  const ts = Math.floor(Date.now() / 1000) - 400;
  const notify = buildNotify({ platformPrivateKey, apiV3Key, ts, serial: 'PLAT01' });
  await assert.rejects(provider.verifyNotify({ ...notify, now: ts * 1000 + 401000 }), /超出 5 分钟窗口/);
});

test('回调序列号不匹配拒绝（防止用其他商户/旧证书的回调重放）', async () => {
  const { platformPrivateKey, apiV3Key, provider } = notifyFixture();
  const ts = Math.floor(Date.now() / 1000);
  const notify = buildNotify({ platformPrivateKey, apiV3Key, ts, serial: 'OTHER_SERIAL' });
  await assert.rejects(provider.verifyNotify({ ...notify, now: ts * 1000 }), /序列号不匹配/);
});

/** 构造一条微信 v3 退款结果通知（REFUND.SUCCESS / REFUND.CLOSED） */
function buildRefundNotify({ platformPrivateKey, apiV3Key, ts, eventType, refundStatus, orderId = 'o_1', refundNo = 'RF_o_1', amount = 800 }) {
  const nonce = 'refundnonce1';
  const aad = 'refund';
  const plain = JSON.stringify({
    out_trade_no: orderId, out_refund_no: refundNo, refund_id: 'wx_r_1',
    refund_status: refundStatus, amount: { refund: amount, total: amount },
  });
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(apiV3Key), Buffer.from(nonce));
  cipher.setAAD(Buffer.from(aad));
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const ciphertext = Buffer.concat([enc, cipher.getAuthTag()]).toString('base64');
  const rawBody = JSON.stringify({ event_type: eventType, resource: { ciphertext, nonce, associated_data: aad } });
  const headerNonce = 'hdrRefundNc1';
  const message = `${ts}\n${headerNonce}\n${rawBody}\n`;
  const signature = crypto.createSign('RSA-SHA256').update(message).sign(platformPrivateKey, 'base64');
  return {
    headers: {
      'wechatpay-timestamp': String(ts), 'wechatpay-nonce': headerNonce,
      'wechatpay-signature': signature, 'wechatpay-serial': 'PFX',
    },
    rawBody,
  };
}

test('退款回调：REFUND.SUCCESS / REFUND.CLOSED 验签解密映射，非退款事件忽略，超时拒绝', async () => {
  const { privateKey: platformPrivateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const apiV3Key = '0123456789abcdef0123456789abcdef';
  const provider = pay.wxpayProvider({
    mchid: 'm', appid: 'a', serial: 's', privateKey: 'unused',
    platformCert: publicKey.export({ type: 'spki', format: 'pem' }),
    platformSerial: 'PFX', apiV3Key,
  }, async () => ({ json: async () => ({}) }));

  const ts = Math.floor(Date.now() / 1000);
  const ok = buildRefundNotify({ platformPrivateKey, apiV3Key, ts, eventType: 'REFUND.SUCCESS', refundStatus: 'SUCCESS' });
  const r = await provider.verifyRefundNotify({ ...ok, now: ts * 1000 });
  assert.strictEqual(r.status, 'SUCCESS');
  assert.strictEqual(r.refundNo, 'RF_o_1');
  assert.strictEqual(r.orderId, 'o_1');
  assert.strictEqual(r.amountFen, 800);

  const closed = buildRefundNotify({ platformPrivateKey, apiV3Key, ts, eventType: 'REFUND.CLOSED', refundStatus: 'CLOSED' });
  const rc = await provider.verifyRefundNotify({ ...closed, now: ts * 1000 });
  assert.strictEqual(rc.status, 'CLOSED');

  // 非退款事件：忽略（路由 ack，不触碰订单）
  const payEvent = buildRefundNotify({ platformPrivateKey, apiV3Key, ts, eventType: 'TRANSACTION.SUCCESS', refundStatus: 'SUCCESS' });
  const ignored = await provider.verifyRefundNotify({ ...payEvent, now: ts * 1000 });
  assert.strictEqual(ignored.ignored, true);

  // 时间戳超出 5 分钟：拒绝（防重放）
  await assert.rejects(
    provider.verifyRefundNotify({ ...ok, now: (ts + 301) * 1000 }),
    /5 分钟窗口/
  );
  // 篡改报文：验签失败
  const tampered = { ...ok, rawBody: ok.rawBody.replace('REFUND.SUCCESS', 'REFUND.ABNORMAL') };
  await assert.rejects(provider.verifyRefundNotify({ ...tampered, now: ts * 1000 }), /验签失败/);
});

test('退款处理中（S4）：只落 PROCESSING，不落 refunded、不回滚资金；重复提交幂等', async () => {
  const { createStore } = require('../src/store');
  const { buildContext } = require('../src/app-context');
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const old = {};
  const patch = {
    PAY_MODE: 'live', WX_MCHID: 'm', WX_APPID: 'a', WX_MERCHANT_SERIAL: 's',
    WX_PRIVATE_KEY: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    WX_REFUND_NOTIFY_URL: 'https://example.com/api/payment/refund-notify',
  };
  for (const [k, v] of Object.entries(patch)) { old[k] = process.env[k]; process.env[k] = v; }
  const origFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { json: async () => ({ refund_id: 'r1', status: 'PROCESSING' }) };
  };
  try {
    const db = createStore();
    const ctx = buildContext({ db, UPLOAD_DIR: 'unused', PRIVATE_UPLOAD_DIR: 'unused' });
    const order = db.orders.insert({
      userId: 'u1', payType: 'WX_PAY', status: 'paid', priceFen: 1000, paidFen: 1000,
      createdAt: new Date().toISOString(),
    });
    const r = await ctx.ensureWxRefund(order, 'admin');
    assert.strictEqual(r.status, 'PROCESSING');
    assert.strictEqual(calls, 1);
    const after = db.orders.get(order.id);
    assert.strictEqual(after.status, 'paid'); // 不落退款完成态
    assert.strictEqual(after.refundStatus, 'PROCESSING');
    assert.strictEqual(db.dividendPoolFlows.all().length, 0); // 不产生退款流水
    // 再次提交：按"已受理"返回，不重复请求微信
    const again = await ctx.ensureWxRefund(db.orders.get(order.id), 'admin');
    assert.strictEqual(again.status, 'PROCESSING');
    assert.strictEqual(again.replay, true);
    assert.strictEqual(calls, 1);
    // 处理中禁止本地退款入账（不回滚分佣/分红）
    assert.throws(() => ctx.svc.refundOrder(db, { orderId: order.id, operator: 'admin' }), /处理中/);
    assert.strictEqual(db.orders.get(order.id).status, 'paid');
    assert.strictEqual(db.dividendPoolFlows.all().length, 0);
  } finally {
    globalThis.fetch = origFetch;
    for (const [k] of Object.entries(patch)) {
      if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k];
    }
  }
});
