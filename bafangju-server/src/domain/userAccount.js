'use strict';
/**
 * 用户账户域：登录会话（下单强制登录态）+ 收货地址簿。
 * 合规/安全要点：
 * - 下单等购买链路必须携带登录 token，userId 一律以服务端会话解析为准，不信任前端传参；
 * - 收货信息为订单快照字段（下单时点固化），地址簿后续修改不追溯已支付订单；
 * - 快递到家商品（deliveryType=express）下单必须选择地址簿地址；到店商品（store）无需。
 */
const crypto = require('node:crypto');
const { audit } = require('../store');

/** 签发登录会话（token 持久化，重启不失效；单用户多端并存） */
function createSession(db, userId) {
  const token = crypto.randomBytes(24).toString('hex');
  db.userSessions.insert({ token, userId: String(userId), createdAt: new Date().toISOString() });
  return token;
}

/** token → 用户行（无效/已登出返回 null） */
function userByToken(db, token) {
  if (!token) return null;
  const s = db.userSessions.where((x) => x.token === token)[0];
  if (!s) return null;
  return db.users.get(s.userId) || null;
}

/** 登出：吊销当前会话 */
function revokeSession(db, token) {
  const s = db.userSessions.where((x) => x.token === token)[0];
  if (!s) return false;
  db.userSessions.delete(s.id);
  audit(db, s.userId, 'user.logout', {});
  return true;
}

const PHONE_RE = /^1[3-9]\d{9}$/;

/** 新增收货地址（姓名/手机号/地址强校验） */
function saveAddress(db, { userId, name, phone, region, address, isDefault }) {
  if (!db.users.get(userId)) throw new Error('用户不存在');
  const nm = String(name || '').trim();
  const tel = String(phone || '').trim();
  const addr = String(address || '').trim();
  const reg = String(region || '').trim();
  if (!nm) throw new Error('收货人姓名必填');
  if (nm.length > 20) throw new Error('收货人姓名过长');
  if (!PHONE_RE.test(tel)) throw new Error('手机号格式不正确');
  if (!reg) throw new Error('所在地区必填');
  if (!addr || addr.length < 5) throw new Error('详细地址必填（不少于 5 个字）');
  if (addr.length > 120) throw new Error('详细地址过长');
  // 首个地址自动设为默认
  const hasAny = db.addressBook.where((a) => a.userId === String(userId)).length > 0;
  const def = isDefault === true || !hasAny;
  if (def) for (const a of db.addressBook.where((x) => x.userId === String(userId))) a.isDefault = false;
  const row = db.addressBook.insert({
    userId: String(userId), name: nm, phone: tel, region: reg, address: addr,
    isDefault: def, createdAt: new Date().toISOString(),
  });
  audit(db, String(userId), 'address.save', { addressId: row.id });
  return row;
}

function listAddresses(db, userId) {
  return db.addressBook
    .where((a) => a.userId === String(userId))
    .sort((a, b) => (b.isDefault === true) - (a.isDefault === true) || (a.createdAt < b.createdAt ? -1 : 1));
}

function getAddress(db, userId, addressId) {
  const a = db.addressBook.get(addressId);
  if (!a || a.userId !== String(userId)) throw new Error('收货地址不存在');
  return a;
}

/** 设默认地址 */
function setDefaultAddress(db, userId, addressId) {
  const a = getAddress(db, userId, addressId);
  for (const x of db.addressBook.where((y) => y.userId === String(userId))) x.isDefault = false;
  a.isDefault = true;
  return a;
}

function deleteAddress(db, userId, addressId) {
  const a = getAddress(db, userId, addressId);
  db.addressBook.delete(a.id);
  audit(db, String(userId), 'address.delete', { addressId: String(addressId) });
  return true;
}

/** 下单时解析收货人：addressId 必须属于当前用户；返回订单快照字段 */
function resolveReceiver(db, userId, addressId) {
  const a = getAddress(db, userId, addressId);
  return { receiverName: a.name, receiverPhone: a.phone, receiverRegion: a.region, receiverAddress: a.address, addressId: a.id };
}

module.exports = {
  createSession, userByToken, revokeSession,
  saveAddress, listAddresses, getAddress, setDefaultAddress, deleteAddress, resolveReceiver, PHONE_RE,
};
