'use strict';
/**
 * 联盟券闭环回归用例（V3.6）：发券 → 领券 → 核销计费 → 方案 B 分佣。
 * 重点：费率正确、方案 B 比例正确、平台份额不丢失、联盟单不污染商品线进度/队位。
 */
const test = require('node:test');
const assert = require('node:assert');
const { createStore } = require('../src/store');
const coupon = require('../src/domain/coupon');
const quarter = require('../src/domain/quarter');
const commission = require('../src/domain/commission');
const svc = require('../src/services');
const bizdate = require('../src/domain/bizdate');

function setup() {
  const db = createStore();
  // 本文件针对「收费模式」的计费/账单/分佣逻辑做回归，故显式打开费率。
  // 生产默认（V4.5）两个费率均为 0 = 纯导流免费模式，见文件末尾「默认免费」用例。
  db.switches.set('couponServiceFeeRate', 0.03);
  db.switches.set('verificationServiceFeeRate', 0.05);
  db.merchants.insert({ id: 'm1', name: '张记粮油店', status: 'active' });
  db.users.insert({ id: 'u1', nickname: '买家', createdAt: new Date().toISOString() });
  return db;
}

test('发券与领券：库存/限领校验，核销码为 8 位', () => {
  const db = setup();
  const c = coupon.createCoupon(db, {
    merchantId: 'm1', title: '满30减5', type: 'cash', amountOffFen: 500, minSpendFen: 3000, totalQty: 2,
  });
  assert.strictEqual(c.totalQty, 2);
  const a1 = coupon.claimCoupon(db, { couponId: c.id, userId: 'u1' });
  assert.match(String(a1.code), /^\d{8}$/);
  assert.throws(() => coupon.claimCoupon(db, { couponId: c.id, userId: 'u1' }), /限领/);
  db.users.insert({ id: 'u2', nickname: '乙' });
  coupon.claimCoupon(db, { couponId: c.id, userId: 'u2' });
  db.users.insert({ id: 'u3', nickname: '丙' });
  assert.throws(() => coupon.claimCoupon(db, { couponId: c.id, userId: 'u3' }), /领完/);
});

test('核销计费：券类 3%、次卡类 5%，按核销金额计提', () => {
  const db = setup();
  const cash = coupon.createCoupon(db, {
    merchantId: 'm1', title: '满100减10', type: 'cash', amountOffFen: 1000, minSpendFen: 10000,
  });
  const claim = coupon.claimCoupon(db, { couponId: cash.id, userId: 'u1' });
  const r = coupon.redeemCoupon(db, { code: claim.code, merchantId: 'm1', amountFen: 10000 });
  assert.strictEqual(r.couponFeeFen, 300); // 10000 × 3%
  assert.strictEqual(r.verifyFeeFen, 0);
  assert.strictEqual(r.baseFen, 300);
  assert.strictEqual(r.alliance.amountFen, 10000);

  const pkg = coupon.createCoupon(db, { merchantId: 'm1', title: '洗剪吹次卡', type: 'package', minSpendFen: 0 });
  const claim2 = coupon.claimCoupon(db, { couponId: pkg.id, userId: 'u1' });
  const r2 = coupon.redeemCoupon(db, { code: claim2.code, merchantId: 'm1', amountFen: 20000 });
  assert.strictEqual(r2.couponFeeFen, 0);
  assert.strictEqual(r2.verifyFeeFen, 1000); // 20000 × 5%
  assert.strictEqual(r2.baseFen, 1000);
});

test('核销校验：错码 / 他店 / 未达最低消费 / 重复核销', () => {
  const db = setup();
  db.merchants.insert({ id: 'm2', name: '别家店', status: 'active' });
  const c = coupon.createCoupon(db, {
    merchantId: 'm1', title: '满50减10', type: 'cash', amountOffFen: 1000, minSpendFen: 5000,
  });
  const claim = coupon.claimCoupon(db, { couponId: c.id, userId: 'u1' });
  assert.throws(() => coupon.redeemCoupon(db, { code: '00000000', merchantId: 'm1', amountFen: 5000 }), /核销码不存在/);
  assert.throws(() => coupon.redeemCoupon(db, { code: claim.code, merchantId: 'm2', amountFen: 5000 }), /不属于本店/);
  assert.throws(() => coupon.redeemCoupon(db, { code: claim.code, merchantId: 'm1', amountFen: 4999 }), /最低消费/);
  coupon.redeemCoupon(db, { code: claim.code, merchantId: 'm1', amountFen: 5000 });
  assert.throws(() => coupon.redeemCoupon(db, { code: claim.code, merchantId: 'm1', amountFen: 5000 }), /已核销/);
});

test('方案 B 分佣：直推 70%，平台与无主份额收款后归平台并划入储备专户；不产生队位/进度', () => {
  const db = setup();
  db.users.insert({ id: 'u2', nickname: '推广人' });
  db.users.update('u1', { directUserId: 'u2' });
  const c = coupon.createCoupon(db, {
    merchantId: 'm1', title: '满100减10', type: 'cash', amountOffFen: 1000, minSpendFen: 10000,
  });
  const claim = coupon.claimCoupon(db, { couponId: c.id, userId: 'u1' });
  const beforeReserve = quarter.reserveBalanceFen(db);
  const r = coupon.redeemCoupon(db, { code: claim.code, merchantId: 'm1', amountFen: 10000 });
  // base 300：直推 210；平台 30 + 间推关闭 30 + 团队长未归属 30 = 90 归平台
  assert.strictEqual(r.baseFen, 300);
  assert.strictEqual(db.earnings.get('u2').frozenFen, 210);
  assert.strictEqual(r.platformShareFen, 90);
  // V4.4：核销只挂应收单，服务费未收到前不进储备专户（账实一致）
  assert.strictEqual(quarter.reserveBalanceFen(db) - beforeReserve, 0);
  const bill = db.merchantFeeBills.get(r.feeBillId);
  assert.strictEqual(bill.status, 'due');
  assert.strictEqual(bill.grossFeeFen, 300);
  assert.strictEqual(bill.platformShareFen, 90);
  // 联盟线不参与商品线：不产生队位、不写进度
  assert.strictEqual(db.queueSlots.all().length, 0);
  assert.strictEqual(db.progress.all().length, 0);
  // 服务费未收：即使过了售后期，分佣也不解冻（平台不能拿没到账的钱发佣金）
  db.allianceOrders.update(r.alliance.id, { createdAt: new Date(Date.now() - 8 * 86400000).toISOString() });
  assert.strictEqual(commission.settleDue(db, { afterHours: 168 }).length, 0);
  assert.strictEqual(db.earnings.get('u2').frozenFen, 210);
  // 后台确认收款：储备专户入账 90，此刻才允许解冻联盟分佣
  coupon.markFeeBillPaid(db, { billId: bill.id, method: 'offline', operator: 'admin:root' });
  assert.strictEqual(quarter.reserveBalanceFen(db) - beforeReserve, 90);
  assert.strictEqual(db.merchantFeeBills.get(bill.id).status, 'paid');
  assert.strictEqual(commission.settleDue(db, { afterHours: 168 }).length, 1);
  assert.strictEqual(db.earnings.get('u2').frozenFen, 0);
  assert.ok(db.earnings.get('u2').balanceFen >= 210);
});

test('无推广人：联盟服务费全额归平台，收款后才计入平台留存', () => {
  const db = setup();
  const c = coupon.createCoupon(db, {
    merchantId: 'm1', title: '满100减10', type: 'cash', amountOffFen: 1000, minSpendFen: 10000,
  });
  const claim = coupon.claimCoupon(db, { couponId: c.id, userId: 'u1' });
  const r = coupon.redeemCoupon(db, { code: claim.code, merchantId: 'm1', amountFen: 10000 });
  assert.strictEqual(r.platformShareFen, 300);
  assert.strictEqual(svc.platformBalanceFen(db), 0); // 核销只挂账，不算平台实收
  coupon.markFeeBillPaid(db, { billId: r.feeBillId, operator: 'admin:root' });
  assert.strictEqual(svc.platformBalanceFen(db), 300); // 实收 300 全额入账，不"消失"
});

test('券面优惠：满减/折扣按券前总额计算，消费者线下应付正确', () => {
  const db = setup();
  // 满减：满30减5，消费总额 32 元 -> 优惠 5 元、应付 27 元（不会因"减后 27<30"误判未达门槛）
  const cash = coupon.createCoupon(db, {
    merchantId: 'm1', title: '满30减5', type: 'cash', amountOffFen: 500, minSpendFen: 3000, perUserLimit: 5,
  });
  const c1 = coupon.claimCoupon(db, { couponId: cash.id, userId: 'u1' });
  const r1 = coupon.redeemCoupon(db, { code: c1.code, merchantId: 'm1', amountFen: 3200 });
  assert.strictEqual(r1.discountFen, 500);
  assert.strictEqual(r1.payableFen, 2700);
  assert.strictEqual(r1.alliance.amountFen, 3200);
  // 服务费按券前总额计提（3%）
  assert.strictEqual(r1.grossFeeFen, 96);

  // 折扣：8 折，消费 100 元 -> 优惠 20 元、应付 80 元
  const disc = coupon.createCoupon(db, { merchantId: 'm1', title: '全场8折', type: 'discount', discountRate: 0.8 });
  const c2 = coupon.claimCoupon(db, { couponId: disc.id, userId: 'u1' });
  const r2 = coupon.redeemCoupon(db, { code: c2.code, merchantId: 'm1', amountFen: 10000 });
  assert.strictEqual(r2.discountFen, 2000);
  assert.strictEqual(r2.payableFen, 8000);

  // 次卡：无固定减免，按商家套餐价线下收
  const pkg = coupon.createCoupon(db, { merchantId: 'm1', title: '洗剪吹次卡', type: 'package', minSpendFen: 0 });
  const c3 = coupon.claimCoupon(db, { couponId: pkg.id, userId: 'u1' });
  const r3 = coupon.redeemCoupon(db, { code: c3.code, merchantId: 'm1', amountFen: 20000 });
  assert.strictEqual(r3.discountFen, 0);
  assert.strictEqual(r3.payableFen, 20000);

  // 未达门槛仍拒绝，且提示券前总额
  const c4 = coupon.claimCoupon(db, { couponId: cash.id, userId: 'u1' });
  assert.throws(() => coupon.redeemCoupon(db, { code: c4.code, merchantId: 'm1', amountFen: 2999 }), /最低消费/);
});

test('账单收款：单笔/按月批量，金额校验与幂等', () => {
  const db = setup();
  const c = coupon.createCoupon(db, { merchantId: 'm1', title: '满100减10', type: 'cash', amountOffFen: 1000, minSpendFen: 10000, perUserLimit: 5 });
  const bills = [];
  for (let i = 0; i < 2; i++) {
    const claim = coupon.claimCoupon(db, { couponId: c.id, userId: 'u1' });
    bills.push(coupon.redeemCoupon(db, { code: claim.code, merchantId: 'm1', amountFen: 10000 }).feeBillId);
  }
  const sum = coupon.feeBillSummary(db, { merchantId: 'm1' });
  assert.strictEqual(sum.dueCount, 2);
  assert.strictEqual(sum.dueFen, 600);
  assert.strictEqual(sum.paidFen, 0);
  // 超收拒绝
  assert.throws(() => coupon.markFeeBillPaid(db, { billId: bills[0], receivedFen: 301 }), /不能超过应缴/);
  // 部分收款：按实收确认，平台份额不超过实收
  const r1 = coupon.markFeeBillPaid(db, { billId: bills[0], receivedFen: 200 });
  assert.strictEqual(r1.bill.receivedFen, 200);
  assert.strictEqual(r1.bill.shortageFen, 100);
  // 幂等：重复确认不重复入账
  const reserveAfter = quarter.reserveBalanceFen(db);
  const r1b = coupon.markFeeBillPaid(db, { billId: bills[0], receivedFen: 200 });
  assert.strictEqual(r1b.replay, true);
  assert.strictEqual(quarter.reserveBalanceFen(db), reserveAfter);
  // 按月批量：剩余 1 笔一次收清
  const batch = coupon.markFeeBillsPaidByMonth(db, { merchantId: 'm1', month: bizdate.monthOf(), operator: 'admin:root' });
  assert.strictEqual(batch.paidCount, 1);
  assert.strictEqual(coupon.feeBillSummary(db, { merchantId: 'm1' }).dueCount, 0);
});

test('核销前查券：可正常返回券面，已核销/已过期给出状态', () => {
  const db = setup();
  const c = coupon.createCoupon(db, { merchantId: 'm1', title: '满50减10', type: 'cash', amountOffFen: 1000, minSpendFen: 5000 });
  const claim = coupon.claimCoupon(db, { couponId: c.id, userId: 'u1' });
  const info = coupon.lookupCoupon(db, { code: claim.code, merchantId: 'm1' });
  assert.strictEqual(info.usable, true);
  assert.strictEqual(info.coupon.title, '满50减10');
  assert.strictEqual(info.coupon.minSpendFen, 5000);
  coupon.redeemCoupon(db, { code: claim.code, merchantId: 'm1', amountFen: 5000 });
  const after = coupon.lookupCoupon(db, { code: claim.code, merchantId: 'm1' });
  assert.strictEqual(after.usable, false);
  assert.strictEqual(after.status, 'used');
});

test('服务费汇总：按商家/月份统计核销单数与费用', () => {
  const db = setup();
  const c = coupon.createCoupon(db, {
    merchantId: 'm1', title: '满100减10', type: 'cash', amountOffFen: 1000, minSpendFen: 10000,
  });
  const claim = coupon.claimCoupon(db, { couponId: c.id, userId: 'u1' });
  coupon.redeemCoupon(db, { code: claim.code, merchantId: 'm1', amountFen: 10000 });
  const s = coupon.serviceFeeSummary(db, { merchantId: 'm1' });
  assert.strictEqual(s.count, 1);
  assert.strictEqual(s.couponServiceFeeFen, 300);
  assert.strictEqual(s.baseFen, 300);
});

// ---------- V4.5：默认免费导流模式（平台线上不收任何费用） ----------
test('默认配置=免费模式：核销不产生服务费、不挂应收单、不产生分佣', () => {
  const db = createStore(); // 不覆盖任何开关，取生产默认值
  db.merchants.insert({ id: 'm1', name: '张记粮油店', status: 'active' });
  db.users.insert({ id: 'u1', nickname: '买家', createdAt: new Date().toISOString() });
  const c = coupon.createCoupon(db, {
    merchantId: 'm1', title: '满30减5', type: 'cash', amountOffFen: 500, minSpendFen: 3000,
  });
  const claim = coupon.claimCoupon(db, { couponId: c.id, userId: 'u1' });
  const r = coupon.redeemCoupon(db, { code: claim.code, merchantId: 'm1', amountFen: 3200 });

  // 只记录交易事实：消费总额 / 券优惠 / 消费者线下应付
  assert.strictEqual(r.alliance.amountFen, 3200);
  assert.strictEqual(r.discountFen, 500);
  assert.strictEqual(r.payableFen, 2700);
  // 平台不收费
  assert.strictEqual(r.grossFeeFen, 0);
  assert.strictEqual(r.feeCharged, false);
  assert.strictEqual(r.feeBillId, null);
  assert.strictEqual(db.merchantFeeBills.all().length, 0, '免费模式不得给商家挂应收单');
  assert.strictEqual(r.alliance.feeStatus, 'free');
  // 没有服务费就没有分佣基数
  assert.strictEqual(r.baseFen, 0);
  assert.strictEqual(db.commissionRecords.all().length, 0);
  assert.strictEqual(db.earnings.all().length, 0);
  // 储备专户不因联盟核销入账
  assert.strictEqual(quarter.reserveBalanceFen(db), 0);
  // 券状态正常流转
  assert.strictEqual(db.couponClaims.get(claim.id).status, 'used');
});

// ---------- V4.6：次卡次数管理（多次核销） ----------
test('次卡次数管理：10 次卡可核销 10 次，用完作废，统计按次数累计', () => {
  const db = setup();
  const c = coupon.createCoupon(db, {
    merchantId: 'm1', title: '10 次体验卡', type: 'package', minSpendFen: 0, totalTimes: 10,
  });
  assert.strictEqual(c.totalTimes, 10);
  const claim = coupon.claimCoupon(db, { couponId: c.id, userId: 'u1' });
  assert.strictEqual(claim.totalTimes, 10);

  // 前 9 次：每次核销后仍可用（using），剩余次数递减
  for (let i = 1; i <= 9; i++) {
    const r = coupon.redeemCoupon(db, { code: claim.code, merchantId: 'm1', amountFen: 2000 });
    assert.strictEqual(r.remainingTimes, 10 - i, `第 ${i} 次核销后剩余次数`);
    assert.strictEqual(r.claim.status, 'using');
  }
  // 查券：剩 1 次，仍可用
  const look = coupon.lookupCoupon(db, { code: claim.code, merchantId: 'm1' });
  assert.strictEqual(look.usable, true);
  assert.strictEqual(look.remainingTimes, 1);
  assert.strictEqual(look.usedTimes, 9);

  // 第 10 次：用完 → used 终态
  const last = coupon.redeemCoupon(db, { code: claim.code, merchantId: 'm1', amountFen: 2000 });
  assert.strictEqual(last.remainingTimes, 0);
  assert.strictEqual(last.claim.status, 'used');
  // 再核销：拒绝
  assert.throws(() => coupon.redeemCoupon(db, { code: claim.code, merchantId: 'm1', amountFen: 2000 }), /次数已用完/);
  // 查券：不可用
  const after = coupon.lookupCoupon(db, { code: claim.code, merchantId: 'm1' });
  assert.strictEqual(after.usable, false);
  assert.strictEqual(after.status, 'used');
  // 模板统计：已核销次数按次数累计（10 次卡用完 = 10，而非 1 张）
  assert.strictEqual(coupon.couponStats(db, c.id).used, 10);
});

test('次卡边界：次数校验（1~99）、默认 1 次、部分核销后过期', () => {
  const db = setup();
  assert.throws(() => coupon.createCoupon(db, {
    merchantId: 'm1', title: '超限卡', type: 'package', totalTimes: 100,
  }), /1~99/);
  // 不传 totalTimes：默认 1 次，行为与旧"单次券"完全一致
  const single = coupon.createCoupon(db, { merchantId: 'm1', title: '单次服务', type: 'package' });
  const c1 = coupon.claimCoupon(db, { couponId: single.id, userId: 'u1' });
  const r1 = coupon.redeemCoupon(db, { code: c1.code, merchantId: 'm1', amountFen: 5000 });
  assert.strictEqual(r1.remainingTimes, 0);
  assert.strictEqual(r1.claim.status, 'used');
  assert.throws(() => coupon.redeemCoupon(db, { code: c1.code, merchantId: 'm1', amountFen: 5000 }), /已核销/);

  // 部分核销后到期：using 状态也会过期
  const c = coupon.createCoupon(db, {
    merchantId: 'm1', title: '5 次卡', type: 'package', totalTimes: 5, validDays: 1,
  });
  const c2 = coupon.claimCoupon(db, { couponId: c.id, userId: 'u1' });
  coupon.redeemCoupon(db, { code: c2.code, merchantId: 'm1', amountFen: 1000 });
  assert.strictEqual(coupon.lookupCoupon(db, { code: c2.code, merchantId: 'm1' }).status, 'using');
  db.couponClaims.update(c2.id, { expiresAt: new Date(Date.now() - 86400000).toISOString() });
  assert.throws(() => coupon.redeemCoupon(db, { code: c2.code, merchantId: 'm1', amountFen: 1000 }), /过期/);
  const my = coupon.listUserCoupons(db, 'u1').find((x) => x.id === c2.id);
  assert.strictEqual(my.status, 'expired');
});

test('暂停/恢复发券：停发后不可领但已领券仍可核销，恢复后可再领，防越权', () => {
  const db = setup();
  db.merchants.insert({ id: 'm2', name: '李家杂货', status: 'active' });
  const c = coupon.createCoupon(db, {
    merchantId: 'm1', title: '满30减5', type: 'cash', amountOffFen: 500, minSpendFen: 3000,
  });
  // 停发前：用户端可领
  assert.ok(coupon.listAvailableCoupons(db, { userId: 'u1' }).some((x) => x.id === c.id));
  // 停发
  const paused = coupon.setCouponStatus(db, { merchantId: 'm1', couponId: c.id, status: 'paused', operator: 'merchant:m1' });
  assert.strictEqual(paused.status, 'paused');
  assert.ok(paused.statusUpdatedAt, '停发须记录时间');
  // 停发后：用户端不可领、不可见
  assert.ok(!coupon.listAvailableCoupons(db, { userId: 'u1' }).some((x) => x.id === c.id), '停发券不得出现在可领列表');
  assert.throws(() => coupon.claimCoupon(db, { couponId: c.id, userId: 'u1' }), /停止发放/);
  // 已领取的券不受影响：仍可正常核销
  coupon.setCouponStatus(db, { merchantId: 'm1', couponId: c.id, status: 'valid' });
  const claim = coupon.claimCoupon(db, { couponId: c.id, userId: 'u1' });
  coupon.setCouponStatus(db, { merchantId: 'm1', couponId: c.id, status: 'paused' });
  const r = coupon.redeemCoupon(db, { code: claim.code, merchantId: 'm1', amountFen: 3000 });
  assert.strictEqual(r.payableFen, 2500, '停发不影响已领券核销（3000-500）');
  // 恢复后可再领
  coupon.setCouponStatus(db, { merchantId: 'm1', couponId: c.id, status: 'valid' });
  assert.ok(coupon.listAvailableCoupons(db, { userId: 'u2' }).some((x) => x.id === c.id));
  // 越权：其他商家不得操作
  assert.throws(() => coupon.setCouponStatus(db, { merchantId: 'm2', couponId: c.id, status: 'paused' }), /无权/);
  // 非法状态
  assert.throws(() => coupon.setCouponStatus(db, { merchantId: 'm1', couponId: c.id, status: 'deleted' }), /只能为/);
});
