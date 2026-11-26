'use strict';
/**
 * 商品/类目管理域逻辑（运营后台自助上架）—— 合规要点：
 * - r 值（每周期让利比例）决定阶梯步数 n=⌈1/r⌉+1 与步长，属平台核心定价参数：创建/修改强制审计留痕；
 * - 商品改价遵循"成交快照不追溯"原则（V3.3 §3.6）：已支付订单按下单快照结算，改价只影响后续支付步位；
 * - 下架（off_sale）不影响既有进行中周期（进度/快照保留），仅禁止新下单；
 * - 价格一律整数分，杜绝浮点。
 */
const { audit } = require('../store');
const ladder = require('./ladder');

/** 新增类目：r ∈ (0,1)，n 自动由阶梯引擎推导；icon 为首页金刚区图标（emoji） */
function createCategory(db, { name, r, icon, operator = 'admin' }) {
  if (!name) throw new Error('类目名称必填');
  const rv = Number(r);
  if (!Number.isFinite(rv) || rv <= 0 || rv >= 1) throw new Error('r 必须为 0 到 1 之间的小数（每周期让利比例）');
  if (db.categories.where((c) => c.name === name).length > 0) throw new Error('类目名称已存在');
  const c = db.categories.insert({ name, r: rv, icon: icon || '' });
  audit(db, operator, 'catalog.category_create', { categoryId: c.id, name, r: rv, n: ladder.stepCount(rv) });
  return { ...c, n: ladder.stepCount(rv) };
}

/** 本地生活标准类目（r 为开发默认值，生产以甲方确认事项 13 拍板后后台调整）。
 *  图标走前端线性图标体系（小程序本地定制图 + 官网内联 SVG），不再种子 iconImage；
 *  旧版种子的类目 PNG（public/img/icons 目录）已废弃下线，启动时统一清除残留引用。 */
const DEFAULT_CATEGORIES = [
  { name: '餐饮美食', r: 0.20, icon: '🍜' },
  { name: '甜点饮品', r: 0.25, icon: '🧋' },
  { name: '生鲜果蔬', r: 0.20, icon: '🥬' },
  { name: '超市便利', r: 0.20, icon: '🛒' },
  { name: '休闲玩乐', r: 0.15, icon: '🎳' },
  { name: '丽人美发', r: 0.15, icon: '💇' },
  { name: '健康养生', r: 0.12, icon: '💆' },
  { name: '酒店旅行', r: 0.10, icon: '🏨' },
  { name: '亲子乐园', r: 0.15, icon: '🎠' },
  { name: '家政服务', r: 0.15, icon: '🧹' },
  // 历史遗留类目（已存在则仅补图标）
  { name: '粮油食品', r: 0.20, icon: '🌾' },
  { name: '百货家居', r: 0.25, icon: '🛍️' },
];

/** 启动播种：幂等补齐标准类目（按名称去重）；已存在但缺图标的类目补默认图标。r 修改不自动覆盖，遵循"运营参数不回填"。
 *  同时幂等清除历史种子写入的 /img/icons/* 图标引用（PNG 已下线，留着会造成官网/后台断图）。 */
function seedDefaultCategories(db) {
  const added = [];
  for (const def of DEFAULT_CATEGORIES) {
    const exist = db.categories.where((c) => c.name === def.name)[0];
    if (!exist) {
      const c = db.categories.insert({ name: def.name, r: def.r, icon: def.icon, iconImage: '' });
      audit(db, 'system', 'catalog.category_seed', { categoryId: c.id, name: def.name, r: def.r, n: ladder.stepCount(def.r) });
      added.push(def.name);
    } else {
      if (!exist.icon) exist.icon = def.icon; // 仅补展示图标，不动运营已配置的 r
    }
  }
  // 清除废弃 PNG 图标的残留引用（运营自己上传的 /uploads/* 不受影响）
  let cleared = 0;
  for (const c of db.categories.all()) {
    if (typeof c.iconImage === 'string' && c.iconImage.startsWith('/img/icons/')) {
      c.iconImage = '';
      cleared++;
    }
  }
  if (cleared > 0) audit(db, 'system', 'catalog.category_icon_legacy_cleanup', { cleared });
  return added;
}

/** 类目图标图片：仅允许站内路径（与广告/运营帧素材同一口径，防外链） */
function sanitizeIconImage(url) {
  if (url == null) return '';
  const u = String(url).trim();
  if (!u) return '';
  if (!/^\/(img|uploads)\/[\w\-./]+$/i.test(u)) throw new Error('类目图标必须为站内 /img/ 或 /uploads/ 路径');
  return u;
}

/** 修改类目：r（敏感定价参数，审计留痕）+ 图标/图标图片（展示层，后台可换） */
function updateCategory(db, { categoryId, r, icon, iconImage, name, operator = 'admin' }) {
  const c = db.categories.get(categoryId);
  if (!c) throw new Error('类目不存在');
  const changed = [];
  // r 可选：只换图标时不强制传定价参数
  if (r != null && r !== '') {
    const rv = Number(r);
    if (!Number.isFinite(rv) || rv <= 0 || rv >= 1) throw new Error('r 必须为 0 到 1 之间的小数');
    const old = { r: c.r, n: ladder.stepCount(c.r) };
    c.r = rv;
    changed.push('r');
    audit(db, operator, 'catalog.category_r_change', {
      categoryId, name: c.name, from: old.r, to: rv, oldN: old.n, newN: ladder.stepCount(rv),
    });
  }
  if (name !== undefined && String(name).trim() && String(name).trim() !== c.name) {
    if (db.categories.where((x) => x.name === String(name).trim()).length > 0) throw new Error('类目名称已存在');
    c.name = String(name).trim().slice(0, 20);
    changed.push('name');
  }
  if (icon !== undefined) { c.icon = String(icon || '').slice(0, 8); changed.push('icon'); }
  if (iconImage !== undefined) { c.iconImage = sanitizeIconImage(iconImage); changed.push('iconImage'); }
  if (!changed.length) throw new Error('没有需要更新的字段');
  if (changed.some((k) => k !== 'r')) {
    audit(db, operator, 'catalog.category_display_change', { categoryId, name: c.name, fields: changed.filter((k) => k !== 'r').join(',') });
  }
  return { ...c, n: ladder.stepCount(c.r) };
}

/** 上架新商品（整数分）。deliveryType: express=快递到家（下单须收货地址）| store=到店自提/核销；imageUrl 可选（站内静态路径，如 /img/products/xx.png）；status 默认 on_sale，商家提交走 pending_review */
function createProduct(db, { categoryId, name, priceFen, costFen, deliveryType, imageUrl, taxFeeRate, opCostFen, merchantId, status, operator = 'admin' }) {
  const cat = db.categories.get(categoryId);
  if (!cat) throw new Error('类目不存在');
  if (!name) throw new Error('商品名称必填');
  if (!Number.isInteger(priceFen) || priceFen <= 0) throw new Error('标价必须为正整数分');
  if (!Number.isInteger(costFen) || costFen < 0 || costFen >= priceFen) throw new Error('成本必须为非负整数分且低于标价（分佣基数=实付-成本）');
  if (status != null && !['on_sale', 'pending_review'].includes(status)) throw new Error('status 只能为 on_sale/pending_review');
  // 履约归属：商品可归属某个商家（商家端只能看/发自己商品的订单）；留空即平台自营
  let mid = null;
  if (merchantId != null && merchantId !== '') {
    if (!db.merchants.get(String(merchantId))) throw new Error('商家不存在');
    mid = String(merchantId);
  }
  // 成本项：税费+通道费（按实付比例）、平台基础运营成本（分/单）
  // 这两项直接决定"可分配收益"，漏配会让分佣基数虚高、平台实际亏损（V3.4 修正）
  const rate = taxFeeRate == null || taxFeeRate === '' ? db.switches.get('defaultTaxFeeRate') : Number(taxFeeRate);
  if (!Number.isFinite(rate) || rate < 0 || rate >= 1) throw new Error('税费+通道费率须为 0~1 之间的小数（如 0.06）');
  const op = opCostFen == null || opCostFen === '' ? db.switches.get('defaultOpCostFen') : Number(opCostFen);
  if (!Number.isInteger(op) || op < 0) throw new Error('运营成本必须为非负整数分');
  const dt = deliveryType === 'store' ? 'store' : 'express';
  const url = sanitizeImageUrl(imageUrl);
  const st = status === 'pending_review' ? 'pending_review' : 'on_sale';
  const p = db.products.insert({
    categoryId, name, priceFen, costFen, taxFeeRate: rate, opCostFen: op, deliveryType: dt, imageUrl: url, merchantId: mid,
    status: st, submittedAt: new Date().toISOString(),
  });
  audit(db, operator, 'catalog.product_create', { productId: p.id, name, categoryId, priceFen, costFen, taxFeeRate: rate, opCostFen: op, deliveryType: dt, imageUrl: url, merchantId: mid, status: st });
  return p;
}

// 商品图 URL 白名单：仅允许站内静态路径，防外链与脚本注入
function sanitizeImageUrl(url) {
  if (!url) return '';
  const u = String(url).trim();
  if (!u) return '';
  if (!/^\/(img|uploads)\/[\w\-./]+$/i.test(u)) throw new Error('imageUrl 必须为站内 /img/ 或 /uploads/ 路径');
  return u;
}

/** 商品更新：改价/改成本/改成本项/上下架（全部审计留痕；改价不追溯已成交订单快照） */
function updateProduct(db, { id, name, priceFen, costFen, taxFeeRate, opCostFen, merchantId, status, deliveryType, imageUrl, operator = 'admin' }) {
  const p = db.products.get(id);
  if (!p) throw new Error('商品不存在');
  const changes = {};
  if (name != null && name !== p.name) { changes.name = { from: p.name, to: name }; p.name = name; }
  if (priceFen != null) {
    if (!Number.isInteger(priceFen) || priceFen <= 0) throw new Error('标价必须为正整数分');
    if (priceFen !== p.priceFen) { changes.priceFen = { from: p.priceFen, to: priceFen }; p.priceFen = priceFen; }
  }
  if (costFen != null) {
    if (!Number.isInteger(costFen) || costFen < 0 || costFen >= p.priceFen) throw new Error('成本必须为非负整数分且低于标价');
    if (costFen !== p.costFen) { changes.costFen = { from: p.costFen, to: costFen }; p.costFen = costFen; }
  }
  if (status != null) {
    if (!['on_sale', 'off_sale'].includes(status)) throw new Error('status 只能为 on_sale/off_sale');
    if (status !== p.status) { changes.status = { from: p.status, to: status }; p.status = status; }
  }
  if (deliveryType != null) {
    if (!['express', 'store'].includes(deliveryType)) throw new Error('deliveryType 只能为 express/store');
    if (deliveryType !== p.deliveryType) { changes.deliveryType = { from: p.deliveryType, to: deliveryType }; p.deliveryType = deliveryType; }
  }
  if (imageUrl != null) {
    const url = sanitizeImageUrl(imageUrl);
    if (url !== (p.imageUrl || '')) { changes.imageUrl = { from: p.imageUrl || '', to: url }; p.imageUrl = url; }
  }
  if (taxFeeRate != null && taxFeeRate !== '') {
    const rate = Number(taxFeeRate);
    if (!Number.isFinite(rate) || rate < 0 || rate >= 1) throw new Error('税费+通道费率须为 0~1 之间的小数（如 0.06）');
    if (rate !== p.taxFeeRate) { changes.taxFeeRate = { from: p.taxFeeRate, to: rate }; p.taxFeeRate = rate; }
  }
  if (opCostFen != null && opCostFen !== '') {
    const op = Number(opCostFen);
    if (!Number.isInteger(op) || op < 0) throw new Error('运营成本必须为非负整数分');
    if (op !== p.opCostFen) { changes.opCostFen = { from: p.opCostFen, to: op }; p.opCostFen = op; }
  }
  if (merchantId !== undefined) {
    let mid = null;
    if (merchantId !== null && merchantId !== '') {
      if (!db.merchants.get(String(merchantId))) throw new Error('商家不存在');
      mid = String(merchantId);
    }
    if (mid !== (p.merchantId || null)) { changes.merchantId = { from: p.merchantId || null, to: mid }; p.merchantId = mid; }
  }
  audit(db, operator, 'catalog.product_update', { productId: id, name: p.name, changes });
  return { ...p, changes };
}

/** 管理视角商品全量列表（含下架，带类目信息与阶梯参数） */
function adminListProducts(db) {
  return db.products.all().map((p) => {
    const cat = db.categories.get(p.categoryId) || {};
    const n = cat.r != null ? ladder.stepCount(cat.r) : null;
    return { ...p, categoryName: cat.name || p.categoryId, r: cat.r, n };
  });
}

/* ---------------- 商家自主上传 + 平台审核（V3.23） ----------------
 * 两条硬约束：
 * ① 商家只能选平台已有类目（r 跟随类目，不能自报 r，防虚报利润率破坏「平台不亏」的阶梯保证）；
 * ② 平台审核须看价格合理性（审核界面带「算账」预览，防虚高标价再让利）。
 * 状态机：pending_review →（通过）on_sale /（驳回）rejected；商家再编辑即回 pending_review 停售待审。
 */

const PRODUCT_STATUS_TEXT = { on_sale: '已上架', off_sale: '已下架', pending_review: '待审核', rejected: '已驳回' };

/** 商家提交新商品：强制归属当前商家、类目必须已存在、税费/运营成本按平台默认值计，状态 pending_review */
function submitProductByMerchant(db, { merchantId, categoryId, name, priceFen, costFen, deliveryType, imageUrl }) {
  const mid = String(merchantId);
  if (!db.merchants.get(mid)) throw new Error('商家不存在');
  if (!db.categories.get(categoryId)) throw new Error('请选择平台已有类目');
  const p = createProduct(db, {
    categoryId, name, priceFen, costFen, deliveryType, imageUrl,
    merchantId: mid, status: 'pending_review', operator: `merchant:${mid}`,
  });
  audit(db, `merchant:${mid}`, 'catalog.product_submit', { productId: p.id, name: p.name, categoryId, priceFen, costFen });
  return p;
}

/** 商家编辑自己的商品：保存后即回 pending_review（停售待审，审核通过恢复上架）；越权改他人商品直接报错 */
function merchantUpdateProduct(db, { merchantId, productId, name, priceFen, costFen, deliveryType, imageUrl }) {
  const mid = String(merchantId);
  const p = db.products.get(String(productId));
  if (!p) throw new Error('商品不存在');
  if (String(p.merchantId || '') !== mid) throw new Error('无权修改其他商家的商品');
  if (name != null && String(name).trim()) p.name = String(name).trim().slice(0, 30);
  if (priceFen != null) {
    if (!Number.isInteger(priceFen) || priceFen <= 0) throw new Error('标价必须为正整数分');
    p.priceFen = priceFen;
  }
  if (costFen != null) {
    if (!Number.isInteger(costFen) || costFen < 0 || costFen >= p.priceFen) throw new Error('成本必须为非负整数分且低于标价');
    p.costFen = costFen;
  }
  if (deliveryType != null) {
    if (!['express', 'store'].includes(deliveryType)) throw new Error('deliveryType 只能为 express/store');
    p.deliveryType = deliveryType;
  }
  if (imageUrl != null) p.imageUrl = sanitizeImageUrl(imageUrl);
  p.status = 'pending_review';
  p.reviewNote = '';
  p.submittedAt = new Date().toISOString();
  audit(db, `merchant:${mid}`, 'catalog.product_resubmit', { productId: p.id, name: p.name, priceFen: p.priceFen, costFen: p.costFen });
  return p;
}

/** 平台审核商家商品：通过 → on_sale；驳回 → rejected + 驳回原因（必填，商家可见，可修改后重新提交） */
function reviewProductSubmission(db, { productId, approved, note, operator = 'admin' }) {
  const p = db.products.get(String(productId));
  if (!p) throw new Error('商品不存在');
  if (p.status !== 'pending_review') throw new Error('该商品不在待审核状态');
  if (approved) {
    p.status = 'on_sale';
    p.reviewNote = '';
  } else {
    if (!note || !String(note).trim()) throw new Error('驳回时必须填写驳回原因');
    p.status = 'rejected';
    p.reviewNote = String(note).trim().slice(0, 200);
  }
  p.reviewedAt = new Date().toISOString();
  audit(db, operator, 'catalog.product_review', { productId: p.id, name: p.name, merchantId: p.merchantId, approved: !!approved, note: note || '' });
  return p;
}

/** 商家视角：自己的商品列表（含审核状态与驳回原因） */
function listMerchantProducts(db, merchantId) {
  const mid = String(merchantId);
  return db.products.where((p) => String(p.merchantId || '') === mid)
    .sort((a, b) => ((a.submittedAt || '') < (b.submittedAt || '') ? 1 : -1))
    .map((p) => {
      const cat = db.categories.get(p.categoryId) || {};
      return {
        ...p,
        categoryName: cat.name || p.categoryId,
        statusText: PRODUCT_STATUS_TEXT[p.status] || p.status,
      };
    });
}

/** 平台视角：待审核商品队列（含商家名与类目阶梯参数，审核时结合「算账」预览判断价格合理性） */
function listPendingProducts(db) {
  return db.products.where((p) => p.status === 'pending_review')
    .sort((a, b) => ((a.submittedAt || '') < (b.submittedAt || '') ? -1 : 1)) // 先提交先审
    .map((p) => {
      const cat = db.categories.get(p.categoryId) || {};
      const m = db.merchants.get(p.merchantId) || {};
      return {
        ...p,
        categoryName: cat.name || p.categoryId,
        r: cat.r,
        n: cat.r != null ? ladder.stepCount(cat.r) : null,
        merchantName: m.name || p.merchantId || '平台自营',
      };
    });
}

/** 类目列表（带阶梯参数） */
function adminListCategories(db) {
  return db.categories.all().map((c) => ({ ...c, n: ladder.stepCount(c.r) }));
}

module.exports = {
  createCategory, updateCategory, sanitizeIconImage, createProduct, updateProduct,
  adminListProducts, adminListCategories, seedDefaultCategories, DEFAULT_CATEGORIES,
  submitProductByMerchant, merchantUpdateProduct, reviewProductSubmission,
  listMerchantProducts, listPendingProducts, PRODUCT_STATUS_TEXT,
};
