'use strict';
/**
 * 文案配置（content）：把写死在小程序包里的展示文案搬到后台，改文案不用发版。
 *
 * 设计要点：
 * - key 白名单：只能改清单内的文案，避免后台被当成任意内容注入口；
 * - 留空即用小程序内置文案（前端本地兜底），后台填写后才覆盖 —— 不强制一次性搬完；
 * - 长文本按长度上限校验（协议类可到 8000 字），防止把接口当存储用；
 * - 全部写操作留审计（content.update / content.reset）。
 */
const { audit } = require('../store');

/** 文案清单：key / 分组 / 后台显示名 / 填写提示 / 最大长度 / 是否多行 */
const CONTENT_DEFS = [
  // 备案信息（公安联网备案 / ICP 备案）—— 号下来后在后台填一次，官网/后台/H5/小程序自动生效
  // 留空即隐藏对应备案项；下面每个字段前端都有「有值才显示」的保护，未拿到号前不会露出占位文字。
  { key: 'filing.icpNo', group: '备案信息', title: 'ICP 备案号', hint: '如：湘ICP备2026000123号；留空则官网页脚不显示 ICP 备案号', maxLen: 40 },
  { key: 'filing.policeNo', group: '备案信息', title: '公安备案号', hint: '如：湘公网安备 43090002001234号；留空则各端不显示公安备案号', maxLen: 60 },
  { key: 'filing.policeLink', group: '备案信息', title: '公安备案查询链接', hint: '填公安机关下发的完整查询 URL（https:// 开头）；留空则用官网默认查询入口', maxLen: 300 },
  // 规则说明
  { key: 'rules.header', group: '规则说明', title: '规则说明 · 头部版本行', hint: '如：版本 V3.3 · 阶梯优惠与分红机制', maxLen: 60 },
  { key: 'rules.items', group: '规则说明', title: '规则条款（每行一条）', hint: '一行一条，前端自动编号；留空则用小程序内置条款', maxLen: 3000, multiline: true },
  { key: 'rules.footer', group: '规则说明', title: '规则说明 · 底部声明', hint: '规则生效与解释权声明', maxLen: 300, multiline: true },
  // 协议
  { key: 'agreement.updatedAt', group: '协议', title: '协议更新日期', hint: '如：2026-10-28', maxLen: 20 },
  { key: 'agreement.privacy', group: '协议', title: '隐私政策全文', hint: '分段请用空行分隔；留空则用小程序内置全文', maxLen: 8000, multiline: true },
  { key: 'agreement.terms', group: '协议', title: '用户协议全文', hint: '分段请用空行分隔；留空则用小程序内置全文', maxLen: 8000, multiline: true },
  // 首页
  { key: 'home.notice', group: '首页', title: '首页 · 阶梯说明', hint: '首页底部关于阶梯优惠的说明', maxLen: 200, multiline: true },
  { key: 'home.dividend', group: '首页', title: '首页 · 分红说明', hint: '首页「我的分红」卡说明', maxLen: 200, multiline: true },
  // 各处合规声明
  { key: 'promotion.note', group: '合规声明', title: '推广返利 · 说明', hint: '推广收益与间推说明', maxLen: 300, multiline: true },
  { key: 'tasks.note', group: '合规声明', title: '任务中心 · 贡献值声明', hint: '贡献值不兑现/不提现等口径', maxLen: 300, multiline: true },
  { key: 'dividend.note', group: '合规声明', title: '我的分红 · 声明', hint: '不承诺金额与到账时间等口径', maxLen: 300, multiline: true },
  { key: 'team.note', group: '合规声明', title: '我的团队 · 声明', hint: '等级只作权益资格等口径', maxLen: 300, multiline: true },
  { key: 'profile.compliance', group: '合规声明', title: '我的 · 合规声明', hint: '不承诺全额返/保本等口径', maxLen: 300, multiline: true },
  { key: 'withdraw.closed', group: '合规声明', title: '提现 · 未开通说明', hint: '提现通道关闭时展示的说明', maxLen: 300, multiline: true },
  { key: 'merchants.note', group: '合规声明', title: '附近商家 · 距离说明', hint: '距离计算口径与免责', maxLen: 300, multiline: true },
  { key: 'tabbar.items', group: '界面文案', title: '底部导航文案与顺序', hint: 'JSON 数组，如 [{"pagePath":"pages/index/index","text":"首页"}]，pagePath 必须是现有页面路径', maxLen: 1000, multiline: true },
  { key: 'profile.menu', group: '界面文案', title: '我的 · 菜单显示名', hint: 'JSON 对象，如 {"returns":"阶梯优惠"}，只改显示名，未填的用内置名称', maxLen: 1000, multiline: true },
];

const DEF_MAP = new Map(CONTENT_DEFS.map((d) => [d.key, d]));
const KEYS = CONTENT_DEFS.map((d) => d.key);

function nowISO() { return new Date().toISOString(); }

function assertKey(key) {
  if (!DEF_MAP.has(String(key || ''))) throw new Error('文案 key 不在可配置清单内');
  return DEF_MAP.get(String(key));
}

/** 前台：只返回已配置且非空的文案（留空的由小程序内置兜底） */
function listContent(db) {
  const items = {};
  let latest = '';
  for (const row of db.content.all()) {
    if (!row.body) continue; // 清空 = 回落内置
    items[row.key] = row.body;
    if (!latest || String(row.updatedAt || '') > latest) latest = String(row.updatedAt || '');
  }
  return { version: latest || '0', items };
}

/** 后台：清单 + 当前值（含是否已被后台覆盖） */
function adminListContent(db) {
  const rows = new Map(db.content.all().map((r) => [r.key, r]));
  return {
    defs: CONTENT_DEFS.map((d) => {
      const r = rows.get(d.key);
      return { ...d, body: r ? r.body : '', custom: !!(r && r.body), updatedAt: r ? r.updatedAt : '', updatedBy: r ? r.updatedBy : '' };
    }),
  };
}

function setContent(db, { key, body, operator = 'admin' } = {}) {
  const def = assertKey(key);
  const text = String(body == null ? '' : body);
  if (text.length > def.maxLen) throw new Error(`「${def.title}」不超过 ${def.maxLen} 字（当前 ${text.length}）`);
  const row = db.content.where((r) => r.key === key)[0];
  if (row) {
    db.content.update(row.id, { body: text, updatedAt: nowISO(), updatedBy: operator });
  } else {
    db.content.insert({ key, body: text, createdAt: nowISO(), updatedAt: nowISO(), updatedBy: operator });
  }
  audit(db, operator, 'content.update', { key, len: text.length, reset: text === '' });
  return { ok: true, key, len: text.length };
}

/** 恢复内置：删除后台覆盖 */
function resetContent(db, { key, operator = 'admin' } = {}) {
  assertKey(key);
  const row = db.content.where((r) => r.key === key)[0];
  if (!row) return { ok: true, key, reset: true };
  db.content.delete(row.id);
  audit(db, operator, 'content.reset', { key });
  return { ok: true, key, reset: true };
}

/**
 * 备案信息（公开只读）：把后台填写的备案号整理成前端可直接渲染的结构。
 * - 字段留空 → 对应项为 null，前端据此隐藏，未拿到号前不露出占位文字；
 * - 公安备案查询链接：后台填了就用填的；没填则从备案号里提取 recordcode 拼官方查询入口；
 * - ICP 查询链接固定为工信部备案系统（不随后台配置变化）。
 */
const POLICE_QUERY_BASE = 'https://beian.mps.gov.cn/#/query/webSearch';
const ICP_QUERY_LINK = 'https://beian.miit.gov.cn/';

function filingInfo(db) {
  const items = listContent(db).items;
  const clean = (v) => (typeof v === 'string' ? v.trim() : '');
  const icpNo = clean(items['filing.icpNo']);
  const policeNo = clean(items['filing.policeNo']);
  const policeLinkCfg = clean(items['filing.policeLink']);

  let policeLink = '';
  if (policeNo) {
    if (policeLinkCfg && /^https?:\/\//i.test(policeLinkCfg)) {
      policeLink = policeLinkCfg;
    } else {
      // 从「X公网安备 XXXXXXXXXXXX号」中提取连续数字作为 recordcode
      const m = policeNo.match(/(\d{8,})/);
      policeLink = m ? `${POLICE_QUERY_BASE}?recordcode=${m[1]}` : POLICE_QUERY_BASE;
    }
  }

  return {
    icp: icpNo ? { no: icpNo, link: ICP_QUERY_LINK } : null,
    police: policeNo ? { no: policeNo, link: policeLink } : null,
  };
}

module.exports = { CONTENT_DEFS, KEYS, listContent, adminListContent, setContent, resetContent, assertKey, filingInfo, POLICE_QUERY_BASE, ICP_QUERY_LINK };
