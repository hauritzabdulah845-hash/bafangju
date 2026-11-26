// 运行环境判定（仅用于「调试能力开关」，不承载业务逻辑）
// - develop：开发者工具/开发版，允许暴露调试入口（网络诊断等）
// - trial：体验版
// - release：正式版，一律关闭调试入口
//
// 判定顺序：
// 1) wx.getAccountInfoSync().miniProgram.envVersion —— 官方推荐，基础库 ≥2.2.4
// 2) __wxConfig.envVersion —— 非官方兜底，开发者工具里始终存在
// 3) 取不到时一律按 release 处理（保守：宁可关掉调试入口，也不误开）
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
