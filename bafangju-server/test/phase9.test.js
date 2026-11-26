'use strict';
/**
 * 第九期测试：下单强制登录态 + 收货地址簿 + 快递商品收货信息快照。
 */
const test = require('node:test');
const assert = require('node:assert');
const ua = require('../src/domain/userAccount');
const catalog = require('../src/domain/catalog');
const svc = require('../src/services');
const { createStore } = require('../src/store');

function freshDb() {
  return createStore({});
}

test('用户会话：登录签发 token、解析、登出吊销', () => {
  const db = freshDb();
  const u = db.users.insert({ nickname: '会话用户', createdAt: new Date().toISOString() });
  const token = ua.createSession(db, u.id);
  assert.ok(/^[0-9a-f]{48}$/.test(token));
  assert.strictEqual(ua.userByToken(db, token).id, u.id);
  assert.strictEqual(ua.userByToken(db, 'badtoken'), null);
  assert.ok(ua.revokeSession(db, token));
  assert.strictEqual(ua.userByToken(db, token), null); // 登出后失效
});

test('地址簿：校验/默认地址/归属校验/删除', () => {
  const db = freshDb();
  const u = db.users.insert({ nickname: '地址用户', createdAt: new Date().toISOString() });
  assert.throws(() => ua.saveAddress(db, { userId: u.id, name: '', phone: '13800001111', region: '广东 广州', address: '幸福路 12 号' }), /姓名必填/);
  assert.throws(() => ua.saveAddress(db, { userId: u.id, name: '李四', phone: '12345', region: '广东 广州', address: '幸福路 12 号' }), /手机号格式/);
  assert.throws(() => ua.saveAddress(db, { userId: u.id, name: '李四', phone: '13800001111', region: '', address: '幸福路 12 号' }), /所在地区必填/);
  assert.throws(() => ua.saveAddress(db, { userId: u.id, name: '李四', phone: '13800001111', region: '广东 广州', address: '短' }), /详细地址必填/);

  const a1 = ua.saveAddress(db, { userId: u.id, name: '李四', phone: '13800001111', region: '广东省广州市天河区', address: '幸福路 12 号 3 栋 501' });
  assert.strictEqual(a1.isDefault, true, '首个地址自动设默认');
  const a2 = ua.saveAddress(db, { userId: u.id, name: '王五', phone: '13900002222', region: '广东省深圳市南山区', address: '科技园南路 8 号' });
  assert.strictEqual(a2.isDefault, false);
  ua.setDefaultAddress(db, u.id, a2.id);
  assert.strictEqual(ua.listAddresses(db, u.id)[0].id, a2.id);
  // 归属校验：别人的地址不可用
  const other = db.users.insert({ nickname: '别人', createdAt: new Date().toISOString() });
  assert.throws(() => ua.getAddress(db, other.id, a1.id), /收货地址不存在/);
  assert.throws(() => ua.resolveReceiver(db, other.id, a1.id), /收货地址不存在/);
  ua.deleteAddress(db, u.id, a2.id);
  assert.strictEqual(ua.listAddresses(db, u.id).length, 1);
});

test('下单：快递商品缺地址报错，带地址快照收货人；到店商品免地址', () => {
  const db = freshDb();
  const u = db.users.insert({ nickname: '购买用户', createdAt: new Date().toISOString() });
  const cat = catalog.createCategory(db, { name: '测试类目', r: 0.5 });
  const expressP = catalog.createProduct(db, { categoryId: cat.id, name: '快递商品', priceFen: 1000, costFen: 300, deliveryType: 'express' });
  const storeP = catalog.createProduct(db, { categoryId: cat.id, name: '到店商品', priceFen: 800, costFen: 200, deliveryType: 'store' });
  const addr = ua.saveAddress(db, { userId: u.id, name: '赵六', phone: '13700003333', region: '广东省珠海市香洲区', address: '情侣南路 99 号' });

  assert.throws(() => svc.createOrder(db, { userId: u.id, productId: expressP.id, idempotencyKey: 't1' }), /请先选择收货地址/);
  // 他人地址不可用
  const other = db.users.insert({ nickname: '盗用者', createdAt: new Date().toISOString() });
  assert.throws(() => svc.createOrder(db, { userId: other.id, productId: expressP.id, addressId: addr.id, idempotencyKey: 't2' }), /收货地址不存在/);

  const { order } = svc.createOrder(db, { userId: u.id, productId: expressP.id, addressId: addr.id, idempotencyKey: 't3' });
  assert.strictEqual(order.receiverName, '赵六');
  assert.strictEqual(order.receiverPhone, '13700003333');
  assert.strictEqual(order.receiverAddress, '情侣南路 99 号');
  assert.strictEqual(order.deliveryType, 'express');

  const { order: so } = svc.createOrder(db, { userId: u.id, productId: storeP.id, idempotencyKey: 't4' });
  assert.strictEqual(so.deliveryType, 'store');
  assert.strictEqual(so.receiverName, undefined);
});
