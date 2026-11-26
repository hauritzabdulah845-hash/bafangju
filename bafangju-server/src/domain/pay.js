'use strict';
/**
 * 支付适配层（V3.3 §6）—— 可插拔设计：
 * - mockProvider：当前开发/测试行为（预下单返回 mock 参数，支付由 /api/payment/notify 模拟）；
 * - wxpayProvider：微信支付 API v3 JSAPI 真实下单（RSA-SHA256 请求签名）。
 *   配置 WX_MCHID / WX_MERCHANT_SERIAL / WX_PRIVATE_KEY(PEM 或路径) 后启用；
 *   回调验签与解密需微信平台证书（接入商户号后补充 verifyNotify），当前未实现、明确报错防止绕过验签。
 * 合规：金额整数分；out_trade_no = 订单号幂等；不触碰分账。
 */
const crypto = require('crypto');
const fs = require('fs');

/**
 * 读取 PEM：既支持直接给 PEM 内容，也支持给文件路径。
 * 文件不存在时返回 null（按"未配置"处理），避免证书还没放好就启动崩溃。
 */
function readPemMaybe(v) {
  if (!v) return null;
  const s = String(v);
  if (s.includes('-----BEGIN')) return s;
  try { return fs.readFileSync(s, 'utf8'); } catch (e) { return null; }
}

/** 读取配置，未配置完整微信支付参数时返回 null（自动降级 mock） */
function wxPayConfigFromEnv(env = process.env) {
  const mchid = env.WX_MCHID;
  const appid = env.WX_APPID;
  const serial = env.WX_MERCHANT_SERIAL;
  const privateKey = readPemMaybe(env.WX_PRIVATE_KEY);
  if (!mchid || !appid || !serial || !privateKey) return null;
  // 回调验签材料（可选）：平台证书或「微信支付公钥」PEM + APIv3 密钥，二者齐备 verifyNotify 才可用
  const platformCert = readPemMaybe(env.WX_PLATFORM_CERT);
  const apiV3Key = env.WX_APIV3_KEY || null;
  // 回调地址：必须由运维显式配置。缺省时下单仍用占位地址（不阻断单元测试），
  // 但 checkLiveReadiness 会在启动/预下单阶段拦下，避免"用户付了钱、回调打到 example.invalid"。
  const notifyUrl = env.WX_NOTIFY_URL || null;
  const refundNotifyUrl = env.WX_REFUND_NOTIFY_URL || null;
  // 平台证书序列号（可选）：配置后回调头 Wechatpay-Serial 必须与之匹配，防止串号重放
  const platformSerial = env.WX_PLATFORM_SERIAL || null;
  return { mchid, appid, serial, privateKey, platformCert, apiV3Key, notifyUrl, refundNotifyUrl, platformSerial };
}

function signRSA2048(privateKey, message) {
  return crypto.createSign('RSA-SHA256').update(message).sign(privateKey, 'base64');
}

function buildAuthHeader(cfg, method, urlPath, body) {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString('hex');
  const message = `${method}\n${urlPath}\n${timestamp}\n${nonce}\n${body}\n`;
  const signature = signRSA2048(cfg.privateKey, message);
  return `WECHATPAY2-SHA256-RSA2048 mchid="${cfg.mchid}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${cfg.serial}"`;
}

/** 微信支付 v3 provider（fetchImpl 可注入用于测试） */
function wxpayProvider(cfg, fetchImpl) {
  const f = fetchImpl || fetch;
  const BASE = 'https://api.mch.weixin.qq.com';

  /**
   * 回调通用步骤（支付 / 退款共用，避免两套验签漂移）：
   * - 验签：Wechatpay-Signature 对 `${timestamp}\n${nonce}\n${rawBody}\n` RSA-SHA256；
   * - 防重放：时间戳必须落在 5 分钟窗口内；配置了 WX_PLATFORM_SERIAL 时序列号必须一致；
   * - 解密：resource 用 APIv3 密钥 AES-256-GCM；
   * - 缺平台证书 / APIv3 密钥时明确拒绝（不作为入账依据，防止伪造回调）。
   */
  function verifySignedResource({ headers = {}, rawBody, now = Date.now() } = {}) {
    const platformCert = cfg.platformCert;
    const apiV3Key = cfg.apiV3Key;
    if (!platformCert || !apiV3Key) {
      throw new Error('支付回调验签尚未接入（需 WX_PLATFORM_CERT 平台证书与 WX_APIV3_KEY）；在接入前不得将此接口作为入账依据');
    }
    const ts = headers['wechatpay-timestamp'];
    const nonce = headers['wechatpay-nonce'];
    const signature = headers['wechatpay-signature'];
    const serial = headers['wechatpay-serial'];
    if (!ts || !nonce || !signature || !serial) throw new Error('回调缺少验签头');
    const tsNum = Number(ts);
    if (!Number.isFinite(tsNum)) throw new Error('回调时间戳非法');
    if (Math.abs(Math.floor(now / 1000) - tsNum) > 300) {
      throw new Error('回调时间戳超出 5 分钟窗口（疑似重放，已拒绝）');
    }
    if (cfg.platformSerial && serial !== cfg.platformSerial) {
      throw new Error(`回调证书序列号不匹配（收到 ${serial}，期望 ${cfg.platformSerial}），已拒绝`);
    }
    const message = `${ts}\n${nonce}\n${rawBody}\n`;
    const ok = crypto.createVerify('RSA-SHA256').update(message).verify(platformCert, signature, 'base64');
    if (!ok) throw new Error('回调验签失败（疑似伪造，已拒绝）');
    const report = JSON.parse(rawBody);
    const { ciphertext, nonce: rNonce, associated_data: aad } = report.resource || {};
    if (!ciphertext) throw new Error('回调缺少 resource 密文');
    const buf = Buffer.from(ciphertext, 'base64');
    const encData = buf.slice(0, buf.length - 16);
    const authTag = buf.slice(buf.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', apiV3Key, rNonce);
    decipher.setAuthTag(authTag);
    decipher.setAAD(Buffer.from(aad || '', 'utf8'));
    const plain = Buffer.concat([decipher.update(encData), decipher.final()]).toString('utf8');
    return { report, resource: JSON.parse(plain) };
  }

  return {
    name: 'wxpay',
    /** JSAPI 统一下单：out_trade_no = orderId（幂等），金额整数分；返回小程序调起支付所需参数 */
    async createPrepay({ orderId, openid, amountFen, description }) {
      if (!Number.isInteger(amountFen) || amountFen <= 0) throw new Error('金额非法（整数分）');
      if (!openid) throw new Error('缺少 openid（请重新登录后再支付）');
      const urlPath = '/v3/pay/transactions/jsapi';
      const body = JSON.stringify({
        appid: cfg.appid, mchid: cfg.mchid, description,
        out_trade_no: String(orderId),
        notify_url: cfg.notifyUrl || 'https://example.invalid/notify', // 上线前配置为真实回调域名
        amount: { total: amountFen, currency: 'CNY' },
        payer: { openid },
      });
      const res = await f(BASE + urlPath, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: buildAuthHeader(cfg, 'POST', urlPath, body),
          'User-Agent': 'bafangju-server/1.0',
        },
        body,
      });
      const data = await res.json();
      if (data.code) throw new Error(`微信下单失败：${data.code} ${data.message}`);
      // 小程序侧 wx.requestPayment 需要 timeStamp/nonceStr/package/signType/paySign（由商户私钥签名）
      return { provider: 'wxpay', prepayId: data.prepay_id, payParams: buildJsapiPayParams(cfg, data.prepay_id) };
    },
    /** 查询订单（对账用） */
    async queryOrder(orderId) {
      const urlPath = `/v3/pay/transactions/out-trade-no/${orderId}?mchid=${cfg.mchid}`;
      const res = await f(BASE + urlPath, { headers: { Authorization: buildAuthHeader(cfg, 'GET', urlPath, '') } });
      return res.json();
    },
    /**
     * 申请退款（v3 /v3/refund/domestic/refunds）：out_refund_no 幂等。
     * 只有 SUCCESS / PROCESSING 视为受理成功；ABNORMAL / CLOSED 抛错，调用方不得落本地退款状态。
     */
    async refund({ orderId, refundNo, amountFen, totalFen, reason }) {
      if (!Number.isInteger(amountFen) || amountFen <= 0) throw new Error('退款金额非法（整数分）');
      if (!Number.isInteger(totalFen) || totalFen < amountFen) throw new Error('退款总额非法（必须 ≥ 退款金额）');
      if (!refundNo) throw new Error('退款单号必填');
      // 退款结果必须回到本服务专用回调；缺地址时拒绝发起，避免"钱退了、订单永久处理中"
      if (!cfg.refundNotifyUrl) {
        throw new Error('未配置 WX_REFUND_NOTIFY_URL（退款结果通知地址，应指向 /api/payment/refund-notify），已拒绝发起退款');
      }
      const urlPath = '/v3/refund/domestic/refunds';
      const body = JSON.stringify({
        out_trade_no: String(orderId),
        out_refund_no: String(refundNo),
        reason: String(reason || '用户申请退款').slice(0, 80),
        notify_url: cfg.refundNotifyUrl,
        amount: { refund: amountFen, total: totalFen, currency: 'CNY' },
      });
      const res = await f(BASE + urlPath, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: buildAuthHeader(cfg, 'POST', urlPath, body),
          'User-Agent': 'bafangju-server/1.0',
        },
        body,
      });
      const data = await res.json();
      if (data.code) throw new Error(`微信退款失败：${data.code} ${data.message}`);
      if (!['SUCCESS', 'PROCESSING'].includes(data.status)) {
        throw new Error(`微信退款未受理（status=${data.status}），请稍后重试或转人工`);
      }
      return {
        provider: 'wxpay', refundId: data.refund_id, outRefundNo: data.out_refund_no || refundNo,
        status: data.status, amountFen,
      };
    },
    /**
     * 主动查询退款单（v3 GET /v3/refund/domestic/refunds/{out_refund_no}）：
     * 用于 PROCESSING 订单的定时推进与后台人工查单，避免订单永久停在"退款中"。
     */
    async queryRefund(refundNo) {
      if (!refundNo) throw new Error('退款单号必填');
      const urlPath = `/v3/refund/domestic/refunds/${encodeURIComponent(String(refundNo))}`;
      const res = await f(BASE + urlPath, {
        headers: {
          Accept: 'application/json',
          Authorization: buildAuthHeader(cfg, 'GET', urlPath, ''),
          'User-Agent': 'bafangju-server/1.0',
        },
      });
      const data = await res.json();
      if (data.code) throw new Error(`微信退款查询失败：${data.code} ${data.message}`);
      const status = data.status || data.refund_status;
      if (!status) throw new Error('微信退款查询返回缺少状态');
      return {
        provider: 'wxpay', refundNo: data.out_refund_no || refundNo, refundId: data.refund_id,
        status, amountFen: data.amount && data.amount.refund, resource: data,
      };
    },
    /**
     * 支付回调验签 + 解密（微信支付 v3 标准流程，商户号材料到位即可用）。
     * 验签/防重放/解密统一由 verifySignedResource 完成。
     * @returns {{orderId, transactionId, paidFen, resource}|{ignored:true}}
     */
    async verifyNotify(opts = {}) {
      const { report, resource } = verifySignedResource(opts);
      if (report.event_type !== 'TRANSACTION.SUCCESS') return { ignored: true, eventType: report.event_type };
      return { orderId: resource.out_trade_no, transactionId: resource.transaction_id, paidFen: resource.amount.total, resource };
    },
    /**
     * 微信退款结果通知（REFUND.SUCCESS / REFUND.ABNORMAL / REFUND.CLOSED）：
     * 与支付回调共用同一套验签、时间窗防重放与解密；非退款事件返回 ignored。
     * @returns {{refundNo, orderId, refundId, status, amountFen, eventType, resource}|{ignored:true}}
     */
    async verifyRefundNotify(opts = {}) {
      const { report, resource } = verifySignedResource(opts);
      const eventType = String(report.event_type || '');
      if (!eventType.startsWith('REFUND.')) return { ignored: true, eventType };
      const status = String(resource.refund_status || eventType.slice('REFUND.'.length)).toUpperCase();
      if (!['SUCCESS', 'ABNORMAL', 'CLOSED', 'PROCESSING'].includes(status)) {
        throw new Error(`退款回调状态非法（status=${status}），已拒绝`);
      }
      return {
        refundNo: resource.out_refund_no,
        orderId: resource.out_trade_no,
        refundId: resource.refund_id,
        status,
        amountFen: resource.amount && resource.amount.refund,
        eventType,
        resource,
      };
    },
  };
}

/**
 * 生成小程序 wx.requestPayment 参数（JSAPI 支付签名）：
 *   message = appId\n时间戳\n随机串\nprepay_id=xxx\n
 *   paySign = RSA-SHA256(商户私钥, message)，signType 固定 RSA（v3）
 */
function buildJsapiPayParams(cfg, prepayId, now = Date.now()) {
  if (!cfg || !cfg.appid || !cfg.privateKey) throw new Error('支付配置不完整，无法生成支付签名');
  if (!prepayId) throw new Error('prepayId 必填');
  const timeStamp = String(Math.floor(now / 1000));
  const nonceStr = crypto.randomBytes(16).toString('hex');
  const pkg = 'prepay_id=' + prepayId;
  const message = `${cfg.appid}\n${timeStamp}\n${nonceStr}\n${pkg}\n`;
  const paySign = signRSA2048(cfg.privateKey, message);
  return { timeStamp, nonceStr, package: pkg, signType: 'RSA', paySign };
}

/** 开发/测试 provider：不入真实资金 */
function mockProvider() {
  return {
    name: 'mock',
    async createPrepay({ orderId, amountFen, description }) {
      if (!Number.isInteger(amountFen) || amountFen <= 0) throw new Error('金额非法（整数分）');
      return { provider: 'mock', prepayId: `mock_${orderId}_${Date.now()}`, payParams: null, description };
    },
    async queryOrder() { return { provider: 'mock' }; },
    /** 模拟退款：只返回成功，不动真钱；本地状态由 services.refundOrder 落 */
    async refund({ orderId, refundNo, amountFen }) {
      if (!Number.isInteger(amountFen) || amountFen <= 0) throw new Error('退款金额非法（整数分）');
      return {
        provider: 'mock', refundId: `mock_refund_${orderId}_${Date.now()}`,
        outRefundNo: refundNo || `RF_${orderId}`, status: 'SUCCESS', amountFen,
      };
    },
    async verifyNotify() { throw new Error('mock provider 无真实回调'); },
    /** 模拟模式退款立即成功，不存在可查的处理中单据；显式拒绝，避免误以为已接入真实查询 */
    async queryRefund() { throw new Error('模拟支付模式无微信退款查询通道'); },
    async verifyRefundNotify() { throw new Error('mock provider 无真实退款回调'); },
  };
}

/**
 * 支付模式（V3.10）：
 * - PAY_MODE=mock → 强制模拟（本地联调，即使已配置商户号也不出真实资金）
 * - PAY_MODE=live → 强制真实（未配置完整则报错，避免"以为在收钱其实没接"）
 * - 未设置 → 按配置自动判定（配齐即真实，否则模拟）
 */
function resolvePayMode(env = process.env) {
  const forced = String(env.PAY_MODE || '').toLowerCase();
  if (forced === 'mock' || forced === 'live') return forced;
  return wxPayConfigFromEnv(env) ? 'live' : 'mock';
}

/**
 * 生产环境支付通道守卫（资金安全）：
 * mock 模式下 /api/payment/notify 允许任何登录用户把自己的待支付订单刷成已支付，
 * 一旦误把模拟通道带上线，等于"零元购"，订单/分红/分佣账全部错乱。
 * 因此 NODE_ENV=production 时强制要求 live 通道（配齐商户号材料），否则拒绝启动。
 * 显式设置 PAY_MODE=mock 同样拒绝——生产环境不接受模拟支付。
 */
function assertProductionPayMode(env = process.env) {
  const isProd = String(env.NODE_ENV || '').toLowerCase() === 'production';
  if (!isProd) return resolvePayMode(env);
  const mode = resolvePayMode(env);
  if (mode !== 'live') {
    throw new Error(
      '生产环境禁止模拟支付通道：请配置 WX_MCHID / WX_APPID / WX_MERCHANT_SERIAL / WX_PRIVATE_KEY'
      + '（或显式 PAY_MODE=live），否则模拟支付接口可被用于零元下单'
    );
  }
  return mode;
}

/**
 * live 通道就绪自检（不改状态，只报告）：
 * 商户号材料齐全但不配回调地址时，微信会把支付结果回调到占位域名，
 * 表现为「用户已扣款、后台订单仍是待支付」。启动与预下单两处都会用到本函数。
 * @returns {{ok: boolean, mode: string, problems: string[]}}
 */
function checkLiveReadiness(env = process.env) {
  const mode = resolvePayMode(env);
  if (mode !== 'live') return { ok: true, mode, problems: [] };
  const cfg = wxPayConfigFromEnv(env) || {};
  const isHttps = (u) => /^https:\/\/[^/\s]+/i.test(String(u || ''));
  const problems = [];
  if (!cfg.notifyUrl) {
    problems.push('WX_NOTIFY_URL 未配置：微信支付结果无法回调，用户付款后订单不会入账');
  } else if (!isHttps(cfg.notifyUrl)) {
    problems.push(`WX_NOTIFY_URL 必须是公网 HTTPS 地址（当前：${cfg.notifyUrl}）`);
  }
  if (cfg.refundNotifyUrl && !isHttps(cfg.refundNotifyUrl)) {
    problems.push('WX_REFUND_NOTIFY_URL 必须是公网 HTTPS 地址');
  }
  if (!cfg.apiV3Key || String(cfg.apiV3Key).length !== 32) {
    problems.push('WX_APIV3_KEY 必须是 32 位（回调 resource 解密用）');
  }
  if (!cfg.platformCert) {
    problems.push('WX_PLATFORM_CERT 未配置（平台证书或微信支付公钥 PEM）：回调验签会一律失败');
  }
  return { ok: problems.length === 0, mode, problems };
}

/** 选择 provider：mock 模式一律 mock；live 模式缺配置直接报错（不静默降级，防止误上线） */
function getPayProvider(env = process.env, fetchImpl) {
  if (resolvePayMode(env) === 'mock') return mockProvider();
  const cfg = wxPayConfigFromEnv(env);
  if (!cfg) throw new Error('支付通道未配置完整（PAY_MODE=live 需要 WX_MCHID / WX_APPID / WX_MERCHANT_SERIAL / WX_PRIVATE_KEY）');
  return wxpayProvider(cfg, fetchImpl);
}

module.exports = {
  getPayProvider, wxpayProvider, mockProvider, wxPayConfigFromEnv, buildAuthHeader,
  buildJsapiPayParams, resolvePayMode, assertProductionPayMode, checkLiveReadiness,
};
