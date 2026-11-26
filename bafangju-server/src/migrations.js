'use strict';
/**
 * 存量数据迁移（幂等）：每次启动对历史数据补齐缺失字段，不改动已有运营配置。
 * 合规要点：
 * - 只补"缺失"字段，绝不回填/覆盖运营已配置的值（如类目 r、商品改价后的成交快照）；
 * - 补"成本项"（税费+通道费率、运营成本）属合规必需：漏配会让分佣基数虚高、平台实际亏损（V3.4 修正）；
 * - 商家初始口令只存 scrypt 摘要并标记 mustChangePassword，须管理员尽快重置。
 */
const fs = require('node:fs');
const path = require('node:path');

/** 幂等数据迁移；db 为已建好的存储句柄 */
function runMigrations(db, { adminAuth, audit }) {
  // 历史商品补默认配送方式（快递到家，下单需收货地址）
  for (const p of db.products.all()) { if (!p.deliveryType) p.deliveryType = 'express'; }
  // 历史商品补"税费+通道费率"与"运营成本"，避免漏配导致分佣基数虚高（V3.4）
  for (const p of db.products.all()) {
    if (!Number.isFinite(p.taxFeeRate)) p.taxFeeRate = Number(db.switches.get('defaultTaxFeeRate') || 0.06);
    if (!Number.isInteger(p.opCostFen)) p.opCostFen = Number(db.switches.get('defaultOpCostFen') || 0);
  }
  // 历史广告位补 position；历史投放补审核状态/计数/素材字段（V3.7）
  {
    const posMap = { ad_home_banner: 'home_banner', ad_cat_grain: 'category' };
    for (const s of db.adSlots.all()) {
      if (!s.position) s.position = posMap[s.id] || 'home_banner';
    }
    for (const b of db.adBookings.all()) {
      if (!b.reviewStatus) b.reviewStatus = b.status === 'active' ? 'approved' : 'rejected';
      if (!Number.isInteger(b.impressionCount)) b.impressionCount = 0;
      if (!Number.isInteger(b.clickCount)) b.clickCount = 0;
      if (!b.createdAt) b.createdAt = b.startAt || new Date().toISOString();
      if (!b.title) b.title = (db.adSlots.get(b.slotId) || {}).name || '平台广告';
    }
  }
  // 历史商家补登录账号与初始密码（scrypt 摘要），并标记需改密（V3.8）
  for (const m of db.merchants.all()) {
    if (!m.username) m.username = m.name;
    if (!m.passwordHash) {
      m.passwordHash = adminAuth.hashPassword('demo123456');
      m.mustChangePassword = true;
      audit(db, 'system', 'merchant.password_backfill', {
        merchantId: m.id, username: m.username, note: '初始密码 demo123456，请管理员尽快重置',
      });
    }
  }
  // 联盟服务单补"券前总额/优惠/应付/服务费收款状态"（V4.4）：历史单无优惠快照，按未减免处理
  for (const a of db.allianceOrders.all()) {
    if (!Number.isInteger(a.discountFen)) a.discountFen = 0;
    if (!Number.isInteger(a.payableFen)) a.payableFen = a.amountFen || 0;
    if (!a.feeStatus) a.feeStatus = 'legacy'; // 历史单不生成应收单，分佣按旧口径结算
  }
  // 商品图自动绑定约定路径 public/img/products/{id}.png|jpg（未显式配置 imageUrl 时生效）
  {
    const imgDir = path.join(__dirname, '../public/img/products');
    for (const p of db.products.all()) {
      if (p.imageUrl) continue;
      for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
        if (fs.existsSync(path.join(imgDir, p.id + ext))) { p.imageUrl = '/img/products/' + p.id + ext; break; }
      }
    }
  }
}

module.exports = { runMigrations };
