/**
 * 业务自然日（北京时间 UTC+8）——与服务端 src/domain/bizdate.js 口径一致。
 *
 * 为什么不能用 new Date().toISOString().slice(0, 10)：
 *   toISOString() 永远返回 UTC 日期。北京时间 00:00–07:59 之间，UTC 还是"昨天"，
 *   前端把任务/签到记到昨天，服务端跑批与连击计算按北京时间今天，
 *   会出现"签到后仍显示未签到 / 同日可重复领奖"的账目错误。
 *
 * 用法：凡"按天分组 / 今日任务 / 连击"的日期一律用本模块 today()；
 * 落库时间戳仍用 toISOString()（UTC，可排序）。
 */
const OFFSET_MS = 8 * 3600 * 1000;

/** 北京时间今天 YYYY-MM-DD */
function today(now = Date.now()) {
  const t = now instanceof Date ? now.getTime() : Number(now);
  return new Date(t + OFFSET_MS).toISOString().slice(0, 10);
}

module.exports = { today };
