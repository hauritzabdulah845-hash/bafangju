'use strict';
/**
 * 幂等种子数据（首次启动播种演示数据）。
 * 合规要点：
 * - 全部播种逻辑幂等：持久化库已有数据时跳过，重启不重复建数据；
 * - 演示商家口令一律 scrypt 摘要 + mustChangePassword 标记，登录后须改密；
 * - 演示数据仅用于闭环演示（附近商家 → 领券 → 到店核销），不进入真实经营口径。
 */
const crypto = require('node:crypto');
const { audit } = require('./store');
const adminAuth = require('./domain/adminAuth');

/** 幂等种子：持久化库已有数据时跳过（重启不重复建数据） */
function seed(db) {
  if (db.products.all().length > 0) return;
  const cat = db.categories.insert({ id: 'cat_grain', name: '粮油食品', r: 0.2 });
  db.products.insert({ id: 'p_rice', categoryId: cat.id, name: '东北大米 5kg', priceFen: 1000, costFen: 300, status: 'on_sale' });
  db.products.insert({ id: 'p_oil', categoryId: cat.id, name: '花生油 1.8L', priceFen: 800, costFen: 240, status: 'on_sale' });
  // 商家演示数据（异业联盟）
  const m = db.merchants.insert({
    id: 'm_demo', name: '张记粮油店', contact: '13800000000', status: 'active',
    username: '张记粮油店', passwordHash: adminAuth.hashPassword('demo123456'), mustChangePassword: true,
    businessHours: '08:30-20:00', intro: '本地粮油老店，米面油齐全，可到店自提',
    createdAt: new Date().toISOString(),
  });
  // 演示商品归属该商家，便于商家端"订单-发货/核销"闭环演示
  db.products.update('p_rice', { merchantId: m.id });
  db.products.update('p_oil', { merchantId: m.id });
  db.coupons.insert({ id: 'c_demo1', merchantId: m.id, title: '满30减5', amountOffFen: 500, minSpendFen: 3000, code: 'BFJ0001', status: 'valid', createdAt: new Date().toISOString() });
  db.coupons.insert({ id: 'c_demo2', merchantId: m.id, title: '满50减10', amountOffFen: 1000, minSpendFen: 5000, code: 'BFJ0002', status: 'valid', createdAt: new Date().toISOString() });
  db.adSlots.insert({ id: 'ad_home_banner', merchantId: null, name: '首页横幅位', status: 'available', minDays: 7, feePerCycleFen: 20000 });
  db.adSlots.insert({ id: 'ad_cat_grain', merchantId: null, name: '粮油类目顶部', status: 'available', minDays: 7, feePerCycleFen: 10000 });
  audit(db, 'system', 'seed', { categories: 1, products: 2, merchants: 1, coupons: 2, adSlots: 2 });
}

/**
 * 附近商家演示数据（幂等）：围绕广州天河播种 6 家异业联盟门店（坐标 + 券 + 部分在售商品），
 * 供"附近商家 → 领券 → 到店核销"闭环演示。已播种（seedTag=nearby_demo）则跳过。
 */
function seedNearbyMerchants(db) {
  if (db.merchants.where((m) => m.seedTag === 'nearby_demo').length > 0) return;
  const catId = (name) => (db.categories.where((c) => c.name === name)[0] || {}).id;
  const now = new Date().toISOString();
  const defs = [
    {
      id: 'm_nb_tea', name: '老广记茶餐厅', category: '餐饮美食', address: '天河区体育东路28号',
      lat: 23.131, lng: 113.366, contact: '陈广泰 13802010001', businessHours: '07:30-21:30', intro: '老广早茶与烧腊，现做现卖，可先领券再到店',
      coupons: [
        { title: '满30减5', amountOffFen: 500, minSpendFen: 3000, code: 'NB1001' },
        { title: '满50减10', amountOffFen: 1000, minSpendFen: 5000, code: 'NB1002' },
      ],
      products: [{ id: 'p_nb_tea_set', name: '双人烧腊套餐', priceFen: 6600, costFen: 3800 }],
    },
    {
      id: 'm_nb_fruit', name: '鲜果时光', category: '生鲜果蔬', address: '天河区天河南一路18号',
      lat: 23.1205, lng: 113.3728, contact: '李果 13802010002', businessHours: '08:00-20:00', intro: '当日到货应季水果，到店可自选果箱',
      coupons: [{ title: '满20减3', amountOffFen: 300, minSpendFen: 2000, code: 'NB2001' }],
      products: [
        { id: 'p_nb_fruit_box', name: '应季水果礼盒 3kg', priceFen: 4900, costFen: 2600 },
        { id: 'p_nb_veg_box', name: '有机时蔬套餐', priceFen: 3200, costFen: 1800 },
      ],
    },
    {
      id: 'm_nb_hair', name: '悦剪美发沙龙', category: '丽人美发', address: '天河区珠江新城华夏路10号',
      lat: 23.1355, lng: 113.3502, contact: '阿杰 13802010003', businessHours: '10:00-22:00', intro: '资深发型师，剪发前可先沟通设计',
      coupons: [{ title: '满100减20', amountOffFen: 2000, minSpendFen: 10000, code: 'NB3001' }],
      products: [],
    },
    {
      id: 'm_nb_game', name: '欢乐谷桌游吧', category: '休闲玩乐', address: '天河区体育西路103号',
      lat: 23.142, lng: 113.341, contact: '周乐 13802010004', businessHours: '13:00-24:00', intro: '桌游剧本杀，人多建议提前电话预约',
      coupons: [{ title: '满80减15', amountOffFen: 1500, minSpendFen: 8000, code: 'NB4001' }],
      products: [],
    },
    {
      id: 'm_nb_mart', name: '宜家百货超市', category: '超市便利', address: '天河区中山大道西88号',
      lat: 23.115, lng: 113.358, contact: '王芳 13802010005', businessHours: '08:30-22:00', intro: '社区日用百货，粮油米面齐全',
      coupons: [
        { title: '满60减8', amountOffFen: 800, minSpendFen: 6000, code: 'NB5001' },
        { title: '满100减18', amountOffFen: 1800, minSpendFen: 10000, code: 'NB5002' },
      ],
      products: [{ id: 'p_nb_mart_daily', name: '家庭日用补给包', priceFen: 5900, costFen: 3600 }],
    },
    {
      id: 'm_nb_foot', name: '康足阁足浴', category: '健康养生', address: '天河区黄埔大道西120号',
      lat: 23.126, lng: 113.33, contact: '康叔 13802010006', businessHours: '11:00-23:00', intro: '足浴按摩，晚间高峰建议提前到店',
      coupons: [{ title: '满128减30', amountOffFen: 3000, minSpendFen: 12800, code: 'NB6001' }],
      products: [],
    },
  ];
  for (const d of defs) {
    const m = db.merchants.insert({
      id: d.id, name: d.name, category: d.category, address: d.address,
      lat: d.lat, lng: d.lng, contact: d.contact, status: 'active',
      // 门店主页展示信息（真实运营由商家在商家端「门店主页」自助维护）
      businessHours: d.businessHours || '', intro: d.intro || '',
      username: d.name, passwordHash: adminAuth.hashPassword('demo123456'), mustChangePassword: true,
      token: crypto.randomBytes(24).toString('hex'),
      seedTag: 'nearby_demo', createdAt: now, createdBy: 'seed',
    });
    for (const c of d.coupons) {
      db.coupons.insert({
        merchantId: m.id, title: c.title, amountOffFen: c.amountOffFen, minSpendFen: c.minSpendFen,
        code: c.code, status: 'valid', createdAt: now,
      });
    }
    for (const p of d.products) {
      db.products.insert({
        id: p.id, merchantId: m.id, categoryId: catId(d.category), name: p.name,
        priceFen: p.priceFen, costFen: p.costFen, status: 'on_sale',
        deliveryType: 'express', taxFeeRate: 0.06, opCostFen: 0, createdAt: now,
      });
    }
  }
  audit(db, 'system', 'seed.nearby_merchants', { count: defs.length });
}

module.exports = { seed, seedNearbyMerchants };
