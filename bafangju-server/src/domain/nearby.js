'use strict';
/**
 * 附近商家（异业联盟 · 本地生活）域逻辑：
 * -  Haversine 距离计算（球面模型，足够本地生活精度）；
 * -  列表按真实距离升序，半径/关键词/类目过滤，聚合"在售券数 + 最优券 + 在售商品数"；
 * -  详情含券（含当前用户领取状态）与在售商品，供"领券 → 到店核销"闭环。
 * 坐标来自商家入驻时的地图选点（wx.chooseLocation），平台不虚构位置。
 */

const DEFAULT_CENTER = { lat: 23.1291, lng: 113.3644, name: '天河区' }; // 广州天河（演示默认中心）
const EARTH_R = 6371000; // 地球半径（米）

/** 两点球面距离（米） */
function distanceM(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * EARTH_R * Math.asin(Math.sqrt(s)));
}

/** 距离文案：<1km 用米（省小数），否则 km 保留 1 位 */
function distanceText(m) {
  if (!Number.isFinite(m)) return '';
  return m < 1000 ? `${m}m` : `${(m / 1000).toFixed(1)}km`;
}

function fen2yuan(fen) { return ((fen || 0) / 100).toFixed(2); }

function validCoord(lat, lng) {
  const a = Number(lat), b = Number(lng);
  return Number.isFinite(a) && Number.isFinite(b)
    && a >= -90 && a <= 90 && b >= -180 && b <= 180 && (a !== 0 || b !== 0);
}

/** 券价值文案（与用户端一致：折扣/次卡/满减） */
function couponValueText(c) {
  if (!c) return '';
  if (c.type === 'discount') {
    const zhe = Number(c.discountRate) * 10;
    return `${Number(zhe.toFixed(1))} 折`;
  }
  if (c.type === 'package') {
    const times = Math.max(1, Number(c.totalTimes) || 1);
    return times > 1 ? `${times} 次卡` : '次卡';
  }
  return `¥${fen2yuan(c.amountOffFen)}`;
}

/** 商家在售有效券（未过期、未领完） */
function validCouponsOf(db, merchantId) {
  const now = Date.now();
  return db.coupons.where((c) => {
    if (String(c.merchantId) !== String(merchantId)) return false;
    if (c.status !== 'valid') return false;
    if (c.validUntil && new Date(c.validUntil).getTime() < now) return false;
    return true;
  });
}

/** 商家在售商品（阶梯价商城归属该商家的货） */
function onSaleProductsOf(db, merchantId) {
  return db.products.where((p) => String(p.merchantId) === String(merchantId) && p.status === 'on_sale');
}

/** 联系商家电话：从 contact 字段提取手机号（contact 形如 "张三 138xxxx"） */
function phoneOf(merchant) {
  // 商家自助维护的联系电话优先；未填时回退到入驻联系人里的手机号
  const explicit = String((merchant && merchant.phone) || '').trim();
  if (explicit) return explicit;
  const m = String((merchant && merchant.contact) || '').match(/1\d{10}/);
  return m ? m[0] : '';
}

/**
 * 附近商家列表。
 * @param db
 * @param {{lat:number, lng:number, radiusM?:number, keyword?:string, category?:string, userId?:string}} q
 * @returns {{center:object, radiusM:number, total:number, merchants:object[]}}
 */
function nearbyMerchants(db, q = {}) {
  const center = validCoord(q.lat, q.lng)
    ? { lat: Number(q.lat), lng: Number(q.lng) }
    : { ...DEFAULT_CENTER };
  const radiusM = Math.min(Math.max(Number(q.radiusM) || 5000, 200), 100000);
  const kw = String(q.keyword || '').trim().toLowerCase();
  const cat = String(q.category || '').trim();

  const list = db.merchants.where((m) => {
    if (m.status !== 'active') return false;
    if (!validCoord(m.lat, m.lng)) return false; // 未选点的商家暂不进附近列表（线上可改运营策略）
    return true;
  }).map((m) => {
    const d = distanceM(center, { lat: Number(m.lat), lng: Number(m.lng) });
    const coupons = validCouponsOf(db, m.id);
    // 最优券：满减取减免金额最大；折扣/次卡取首个
    let best = null;
    for (const c of coupons) {
      if (!best) { best = c; continue; }
      if (c.type !== 'discount' && c.type !== 'package' && Number(c.amountOffFen) > Number(best.amountOffFen || 0)) best = c;
    }
    return {
      id: m.id,
      name: m.name,
      category: m.category || '',
      address: m.address || '',
      lat: Number(m.lat), lng: Number(m.lng),
      distanceM: d,
      distanceText: distanceText(d),
      coverUrl: m.coverUrl || '',
      couponCount: coupons.length,
      bestCoupon: best ? { title: best.title, valueText: couponValueText(best), minText: best.minSpendFen ? `满 ${fen2yuan(best.minSpendFen)} 元可用` : '无门槛' } : null,
      productCount: onSaleProductsOf(db, m.id).length,
      phone: phoneOf(m),
    };
  });

  const filtered = list.filter((x) => {
    if (x.distanceM > radiusM) return false;
    if (cat && x.category !== cat) return false;
    if (kw) {
      const hay = `${x.name} ${x.category} ${x.address}`.toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  });

  filtered.sort((a, b) => a.distanceM - b.distanceM);
  return { center, radiusM, total: filtered.length, merchants: filtered };
}

/**
 * 商家详情：门店信息 + 在售券（含当前用户领取状态）+ 在售商品（阶梯价口径）。
 */
function merchantDetail(db, { merchantId, lat, lng, userId }) {
  const m = db.merchants.get(String(merchantId));
  if (!m || m.status !== 'active') return null;
  const center = validCoord(lat, lng) ? { lat: Number(lat), lng: Number(lng) } : null;
  const d = center && validCoord(m.lat, m.lng) ? distanceM(center, { lat: Number(m.lat), lng: Number(m.lng) }) : null;

  const coupons = validCouponsOf(db, m.id).map((c) => {
    const limit = Number(c.perUserLimit) || 1;
    const claimedByMe = userId
      ? db.couponClaims.where((x) => String(x.couponId) === String(c.id) && String(x.userId) === String(userId)).length
      : 0;
    return {
      id: c.id,
      title: c.title,
      type: c.type || 'cash',
      valueText: couponValueText(c),
      minSpendFen: c.minSpendFen || 0,
      minText: c.minSpendFen ? `满 ${fen2yuan(c.minSpendFen)} 元可用` : '无门槛',
      validUntil: c.validUntil || null,
      claimedByMe,
      claimable: claimedByMe < limit,
    };
  });

  const products = onSaleProductsOf(db, m.id).map((p) => {
    const cat = db.categories.get(p.categoryId) || {};
    return {
      id: p.id,
      name: p.name,
      priceYuan: fen2yuan(p.priceFen),
      imageUrl: p.imageUrl || '',
      categoryName: cat.name || '',
    };
  });

  return {
    merchant: {
      id: m.id,
      name: m.name,
      category: m.category || '',
      address: m.address || '',
      lat: Number(m.lat), lng: Number(m.lng),
      distanceM: d,
      distanceText: d == null ? '' : distanceText(d),
      phone: phoneOf(m),
      coverUrl: m.coverUrl || '',
      intro: m.intro || '',
      businessHours: m.businessHours || '',
      couponCount: coupons.length,
      productCount: products.length,
      profileUpdatedAt: m.profileUpdatedAt || null,
      createdAt: m.createdAt || null,
    },
    coupons,
    products,
  };
}

module.exports = { DEFAULT_CENTER, distanceM, distanceText, nearbyMerchants, merchantDetail };
