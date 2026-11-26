'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const bizdate = require('../src/domain/bizdate');

/**
 * 北京时间（UTC+8）业务自然日回归测试。
 *
 * 核心断言：UTC 23:30 / 次日 07:30 之前，业务日必须是"次日"（北京时间），
 * 而不是 UTC 当日——这是本次修复要解决的 bug。
 */

// 用一个固定 UTC 日期 2026-10-28 来构造跨零点场景
test('UTC 23:30 对应北京次日，today() 返回北京时间次日', () => {
  // UTC 2026-10-28 23:30:00Z → 北京 2026-10-29 07:30:00
  const now = new Date('2026-10-28T23:30:00Z');
  assert.equal(bizdate.today(now), '2026-10-29');
});

test('UTC 07:30 对应北京同日下午，today() 返回北京时间当日', () => {
  // UTC 2026-10-28 07:30:00Z → 北京 2026-10-28 15:30:00
  const now = new Date('2026-10-28T07:30:00Z');
  assert.equal(bizdate.today(now), '2026-10-28');
});

test('UTC 16:00 是北京零点边界，today() 返回次日', () => {
  // UTC 2026-10-28 16:00:00Z → 北京 2026-10-29 00:00:00（整点）
  const now = new Date('2026-10-28T16:00:00Z');
  assert.equal(bizdate.today(now), '2026-10-29');
});

test('UTC 15:59:59 仍是北京前一日 23:59:59，today() 返回当日', () => {
  const now = new Date('2026-10-28T15:59:59Z');
  assert.equal(bizdate.today(now), '2026-10-28');
});

test('yesterday() 相对北京时间', () => {
  const now = new Date('2026-10-28T23:30:00Z'); // 北京 10-29
  assert.equal(bizdate.yesterday(now), '2026-10-28');
});

test('dayOfIso 从落库 UTC 时间戳推北京时间日期', () => {
  // 落库 createdAt 用 toISOString()（UTC），推业务日必须得北京日期
  const createdAt = '2026-10-28T23:30:00.000Z'; // 北京 10-29 07:30
  assert.equal(bizdate.dayOfIso(createdAt), '2026-10-29');
});

test('dayOffset 按北京时间自然日偏移', () => {
  const now = new Date('2026-10-28T23:30:00Z'); // 北京 10-29
  assert.equal(bizdate.dayOffset(0, now), '2026-10-29');
  assert.equal(bizdate.dayOffset(-1, now), '2026-10-28');
  assert.equal(bizdate.dayOffset(1, now), '2026-10-30');
});

test('monthOf / monthOfIso 推北京时间所在月', () => {
  // UTC 2026-10-31 20:00 → 北京 2026-11-01 04:00（跨月）
  const now = new Date('2026-10-31T20:00:00Z');
  assert.equal(bizdate.monthOf(now), '2026-11');
  assert.equal(bizdate.monthOfIso('2026-10-31T20:00:00.000Z'), '2026-11');
});

test('endOfDayTs 等于北京时间当日 23:59:59.999 的时间戳', () => {
  const day = '2026-10-28';
  const expected = Date.parse('2026-10-28T23:59:59.999+08:00');
  assert.equal(bizdate.endOfDayTs(day), expected);
});

test('startOfDayTs 等于北京时间当日 00:00:00.000 的时间戳', () => {
  const day = '2026-10-28';
  const expected = Date.parse('2026-10-28T00:00:00.000+08:00');
  assert.equal(bizdate.startOfDayTs(day), expected);
});

test('startOfDayTs 与 endOfDayTs 相差恰好 86399999 毫秒', () => {
  const day = '2026-10-28';
  assert.equal(bizdate.endOfDayTs(day) - bizdate.startOfDayTs(day), 86399999);
});

test('today() 无参时返回当前北京时间日期（格式合法）', () => {
  const d = bizdate.today();
  assert.match(d, /^\d{4}-\d{2}-\d{2}$/);
});
