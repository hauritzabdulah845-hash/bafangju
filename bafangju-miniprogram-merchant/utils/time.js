// 商家端时间展示格式化：把服务端 ISO 时间戳转成商家看得懂的本地时间
/**
 * 时间戳 → 本地可读文本（YYYY-MM-DD HH:mm）；非法输入原样返回
 * @param {string|number|Date} ts ISO 字符串 / 毫秒时间戳 / Date
 * @returns {string} 格式化后的本地时间；空值返回 ''，无法解析时原样返回
 */
function formatTime(ts) {
  if (ts === null || ts === undefined || ts === '') return '';
  const d = ts instanceof Date ? ts : new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

module.exports = { formatTime };
