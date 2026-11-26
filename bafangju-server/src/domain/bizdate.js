'use strict';
/**
 * 业务自然日：统一以北京时间（UTC+8）为"自然日"边界。
 *
 * 为什么需要：`Date.toISOString()` 永远返回 UTC，与服务器 TZ 无关。
 * 如果直接用 `new Date().toISOString().slice(0, 10)` 当业务日，
 * 在北京时间 00:00–07:59 之间发生的订单/任务/分红都会被记到"前一天"，
 * 跑批也会拖到早上 8 点才切日——这是直接影响账目的 bug。
 *
 * 用法：
 *  - 落库时间戳（createdAt/ts）仍用 toISOString()（UTC，可排序、可跨时区）；
 *  - 凡"按天分组 / 默认今天 / 自然月"全部用本模块方法。
 */

const OFFSET_MS = 8 * 3600 * 1000; // 北京时间相对 UTC 的偏移

function _bjMs(now) {
  const t = now instanceof Date ? now.getTime() : Number(now);
  return t + OFFSET_MS;
}

/** 北京时间今天 YYYY-MM-DD */
function today(now = new Date()) {
  return new Date(_bjMs(now)).toISOString().slice(0, 10);
}

/** 北京时间昨天 YYYY-MM-DD */
function yesterday(now = new Date()) {
  return new Date(_bjMs(now) - 86400 * 1000).toISOString().slice(0, 10);
}

/** 从 Date / 时间戳推北京时间 YYYY-MM-DD */
function dayOf(d) {
  return new Date(_bjMs(d)).toISOString().slice(0, 10);
}

/** 从 ISO 字符串推北京时间 YYYY-MM-DD（createdAt/ts 等落库时间戳） */
function dayOfIso(isoStr) {
  if (!isoStr) return '';
  return dayOf(new Date(isoStr));
}

/** 从 Date / 时间戳推北京时间 YYYY-MM（不传参默认当前时间，避免调用方漏参直接抛错） */
function monthOf(d = new Date()) {
  return new Date(_bjMs(d)).toISOString().slice(0, 7);
}

/** 从 ISO 字符串推北京时间 YYYY-MM */
function monthOfIso(isoStr) {
  if (!isoStr) return '';
  return monthOf(new Date(isoStr));
}

/** 从今天起偏移 days 天的北京时间 YYYY-MM-DD（days 可为负） */
function dayOffset(days, now = new Date()) {
  return new Date(_bjMs(now) + days * 86400 * 1000).toISOString().slice(0, 10);
}

/** 某北京时间日期的当日结束时间戳（23:59:59.999 +08:00） */
function endOfDayTs(dayStr) {
  return Date.parse(`${dayStr}T23:59:59.999+08:00`);
}

/** 某北京时间日期的当日起始时间戳（00:00:00.000 +08:00） */
function startOfDayTs(dayStr) {
  return Date.parse(`${dayStr}T00:00:00.000+08:00`);
}

module.exports = {
  today, yesterday, dayOf, dayOfIso, monthOf, monthOfIso, dayOffset,
  endOfDayTs, startOfDayTs,
};
