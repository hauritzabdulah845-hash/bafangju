// 运行环境判定（仅用于「调试能力开关」，不承载业务逻辑）
// - develop：开发者工具/开发版
// - trial：体验版
// - release：正式版
//
// 取不到版本时一律按 release 处理（保守：调试能力默认关闭）
function envVersion() {
  try {
    const info = wx.getAccountInfoSync();
    if (info && info.miniProgram && info.miniProgram.envVersion) return info.miniProgram.envVersion;
  } catch (e) { /* 基础库过旧或环境不支持，走兜底 */ }
  try {
    if (typeof __wxConfig !== 'undefined' && __wxConfig.envVersion) return __wxConfig.envVersion;
  } catch (e) { /* ignore */ }
  return 'release';
}

/** 是否开发环境（调试入口仅在开发环境可见） */
function isDev() {
  return envVersion() === 'develop';
}

module.exports = { envVersion, isDev };
