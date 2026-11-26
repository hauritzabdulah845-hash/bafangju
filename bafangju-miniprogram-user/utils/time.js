/**
 * 时间戳本地化工具
 * 统一把服务端下发的时间戳渲染为用户可读的本地时间，避免直接展示 ISO 串
 */

/**
 * 时间戳 → 本地可读文本（YYYY-MM-DD HH:mm）
 * @param {string|number|Date} ts 时间戳（ISO 串 / 毫秒数 / Date 对象）
 * @returns {string} 格式化结果；空值返回 ''，非法输入原样返回
 */
function formatTime(ts) {
  if (ts === null || ts === undefined || ts === '') return '';
  const d = ts instanceof Date ? ts : new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

module.exports = { formatTime };
