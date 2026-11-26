'use strict';
/**
 * 商家转账适配层（提现发放通道，V3.3 §6 / 待确认 19）—— 可插拔设计：
 * - mockTransferProvider：当前开发行为（记账即视为发放成功，进入"待确认收款"，等待确认或超时退回）；
 * - wechatTransferProvider：微信商家转账 API v3 骨架（配置 WX_TRANSFER_APPID / WX_MCHID /
 *   WX_MERCHANT_SERIAL / WX_PRIVATE_KEY / WX_APIV3_KEY 后启用；商户号材料到位即可接入）。
 *
 * 接入商户号后的启用步骤：
 *  1) 配置上述环境变量（服务器启动时 attachIfConfigured 自动挂接，无需改代码）；
 *  2) 提现收款人需 openid：withdrawTransfers 行补充 receiverOpenid（商家绑定时收集），
 *     缺失时转账进入 submit_failed，由 /api/admin/jobs/retry-transfers 补齐后重试；
 *  3) 真实"确认收款/超时退回"以微信回执驱动：回调查询批次单后调用 withdraw.confirmTransfer /
 *     withdraw.expireStaleTransfers 对应记账（本层只提交与记录回执，不改记账口径）。
 * 合规：单笔/单日限额与拆笔仍在 withdraw.js 记账层执行；本模块不做任何资金拆分。
 */
const crypto = require('crypto');
const fs = require('fs');
const pay = require('./pay');

/** 读取转账通道配置，未配置完整参数返回 null（自动降级 mock） */
function wxTransferConfigFromEnv(env = process.env) {
  const appid = env.WX_TRANSFER_APPID || env.WX_APPID;
  const mchid = env.WX_MCHID;
  const serial = env.WX_MERCHANT_SERIAL;
  // 路径不存在时按未配置处理（证书未放好不应导致服务启动崩溃，自动降级 mock）
  const privateKey = env.WX_PRIVATE_KEY
    ? (env.WX_PRIVATE_KEY.includes('PRIVATE KEY')
        ? env.WX_PRIVATE_KEY
        : (fs.existsSync(env.WX_PRIVATE_KEY) ? fs.readFileSync(env.WX_PRIVATE_KEY, 'utf8') : null))
    : null;
  const apiV3Key = env.WX_APIV3_KEY;
  if (!appid || !mchid || !serial || !privateKey || !apiV3Key) return null;
  return { appid, mchid, serial, privateKey, apiV3Key };
}

/** 微信商家转账 v3 provider（fetchImpl 可注入用于测试） */
function wechatTransferProvider(cfg, fetchImpl) {
  const f = fetchImpl || fetch;
  const BASE = 'https://api.mch.weixin.qq.com';
  return {
    name: 'wechat',
    /**
     * 提交一笔转账（商家转账到零钱，单笔 ≤500 元限额由记账层保证）。
     * @returns {Promise<{provider:'wechat', batchId, detailId, state}>}
     */
    async submitTransfer({ transferNo, openid, amountFen, remark }) {
      if (!openid) throw new Error('缺少收款人 openid（商家需先绑定收款微信）');
      if (!Number.isInteger(amountFen) || amountFen <= 0) throw new Error('金额非法（整数分）');
      const urlPath = '/v3/transfer/batches';
      const body = JSON.stringify({
        appid: cfg.appid,
        out_batch_no: String(transferNo), // 商家单号幂等
        batch_name: '八方聚收益提现',
        batch_remark: (remark || '收益提现').slice(0, 32),
        transfer_detail_list: [{
          out_detail_no: String(transferNo),
          transfer_amount: amountFen,
          transfer_remark: (remark || '收益提现').slice(0, 32),
          openid,
        }],
      });
      const res = await f(BASE + urlPath, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: pay.buildAuthHeader(cfg, 'POST', urlPath, body),
          'User-Agent': 'bafangju-server/1.0',
        },
        body,
      });
      const data = await res.json();
      if (data.code) throw new Error(`微信转账提交失败：${data.code} ${data.message}`);
      return { provider: 'wechat', batchId: data.batch_id, detailId: data.detail_id, state: data.state || 'ACCEPTED' };
    },
    /** 查询批次单（回执驱动：确认收款/失败退回以此为准） */
    async queryBatch({ batchId }) {
      const urlPath = `/v3/transfer/batches/batch-id/${batchId}`;
      const res = await f(BASE + urlPath, { headers: { Authorization: pay.buildAuthHeader(cfg, 'GET', urlPath, '') } });
      return res.json();
    },
  };
}

/** 开发/测试 provider：不提交真实资金 */
function mockTransferProvider() {
  return {
    name: 'mock',
    async submitTransfer({ transferNo }) {
      return { provider: 'mock', batchId: `mock_${transferNo}`, detailId: null, state: 'ACCEPTED' };
    },
    async queryBatch() { return { provider: 'mock' }; },
  };
}

function getTransferProvider(env = process.env, fetchImpl) {
  const cfg = wxTransferConfigFromEnv(env);
  return cfg ? wechatTransferProvider(cfg, fetchImpl) : mockTransferProvider();
}

/**
 * 将 provider 挂接到存储层：发放记账后自动提交转账。
 * 提交失败 → 转账标记 submit_failed（不阻塞记账），由 retry-transfers 跑批重试。
 */
function attachIfConfigured(db, env = process.env) {
  const provider = getTransferProvider(env);
  if (provider.name !== 'wechat') return provider; // 开发态不挂接，保持现行为
  db._transferHook = (transferRow) => {
    provider.submitTransfer({
      transferNo: transferRow.transferNo,
      openid: transferRow.receiverOpenid,
      amountFen: transferRow.fen,
      remark: '收益提现',
    }).then((r) => {
      transferRow.remoteBatchId = r.batchId;
      transferRow.remoteState = r.state;
    }).catch((e) => {
      transferRow.status = 'submit_failed';
      transferRow.submitError = String(e.message || e);
      if (db && db.auditLogs) {
        db.auditLogs.push({ ts: new Date().toISOString(), actor: 'system', action: 'transfer.submit_failed', detail: JSON.stringify({ transferId: transferRow.id, error: String(e.message || e) }) });
      }
    });
  };
  return provider;
}

/** 重试提交失败的转账跑批（补录 receiverOpenid 后调用；重试前刷新最新收款绑定） */
function retryFailedTransfers(db) {
  const failed = db.withdrawTransfers.where((t) => t.status === 'submit_failed');
  const results = [];
  for (const t of failed) {
    if (!db._transferHook) { results.push({ transferId: t.id, retried: false, reason: '未挂接真实转账通道' }); continue; }
    // 刷新收款绑定（补录后重试的关键步骤）
    const acc = db.earnings.get(t.userId);
    t.receiverOpenid = (acc && acc.receiverOpenid) || null;
    t.receiverName = (acc && acc.receiverName) || null;
    if (!t.receiverOpenid) { results.push({ transferId: t.id, retried: false, reason: '缺收款人 openid' }); continue; }
    t.status = 'transferred_pending_confirm';
    t.submitError = null;
    db._transferHook(t);
    results.push({ transferId: t.id, retried: true });
  }
  return results;
}

module.exports = { getTransferProvider, wechatTransferProvider, mockTransferProvider, wxTransferConfigFromEnv, attachIfConfigured, retryFailedTransfers };
