// 八方聚用户端 · 环境配置
//
// 生产域名：https://bfjzs.com（腾讯云轻量 + nginx HTTPS 反向代理）
// 并在微信公众平台「开发 → 开发管理 → 开发设置 → 服务器域名」配置 request / uploadFile 合法域名。
//
// 【本地联调】不要直接改本文件的 BASE_URL，改为编辑同目录的 config.dev.js：
//   - config.dev.js 仅存在于开发机，已被 project.config.json → packOptions.ignore 排除，
//     不会打进小程序包体（含 sourcemap），避免内网地址随包发布泄露；
//   - 存在时自动覆盖下方配置，不存在时（正式包）静默回落为生产配置。
//
// 【真机调试】config.dev.js 不进包体，真机预览时可在开发者工具调试器控制台临时覆盖：
//   wx.setStorageSync('bfj_base_url', 'http://<本机局域网IP>:3000')
// 仅开发环境生效，正式版忽略。
//
// 注意：project.config.json 当前为 wxa8811b4cc88f9857；
// 原 appid 为 wxb950838f23680438（当前登录微信无权限，需在公众平台把该微信加为开发者/管理员后才能换回并上传）
const env = require('./utils/env');

const config = {
  // 【生产】已备案 + HTTPS 打通，切到正式域名。
  // 微信公众平台 → 开发 → 开发管理 → 开发设置 → 服务器域名：
  // request / uploadFile 合法域名均须填 https://bfjzs.com，否则真机/预览请求被拦截。
  BASE_URL: 'https://bfjzs.com',
  // 一次性订阅消息模板 ID（公众平台 → 订阅消息 → 选用模板后复制）。
  // 留空则跳过订阅授权，由站内消息兜底，不影响周期完成与队位获取。
  SUBSCRIBE_TEMPLATE_ID: '',
  // 微信流量主广告位 ID（公众平台 → 流量主 → 广告位管理，开通流量主后才有）。
  // 前端激励视频 / Banner 任务与展示位均已下线：看视频统一走商家视频广告（赚实惠 tab），
  // 这两个配置仅保留作后续流量主接入的占位，当前不读取、不产生收益。
  AD_UNIT_ID_VIDEO: '',   // 激励视频广告位（保留占位，前端未启用）
  AD_UNIT_ID_BANNER: '',  // Banner 广告位（保留占位，前端未启用）
};

// 本地开发覆盖：仅在开发环境尝试加载 config.dev.js，避免发布版意外应用内网地址。
// config.dev.js 被 packOptions.ignore 排除，真机预览/调试包内不存在该文件，
// require 会静默失败；真机调试请用 wx.setStorageSync('bfj_base_url', 'http://<本机IP>:3000') 覆盖。
if (env.isDev()) {
  try {
    Object.assign(config, require('./config.dev'));
  } catch (e) { /* ignore：预览包不含 config.dev.js */ }

  // 开发态运行时覆盖（真机调试临时切地址用），优先级最高
  try {
    const override = wx.getStorageSync('bfj_base_url');
    if (override) config.BASE_URL = String(override).replace(/\/+$/, '');
  } catch (e) { /* ignore */ }
}

module.exports = config;
