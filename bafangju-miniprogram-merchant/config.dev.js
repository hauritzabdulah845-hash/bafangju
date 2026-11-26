// 八方聚商家端 · 本地开发配置（仅开发机使用）
//
// ⚠️ 本文件含内网地址，已被 project.config.json → packOptions.ignore 排除，
//    不会打进小程序包体（上传/发布时不进包）。正式包内不存在此文件，config.js 的
//    require 会失败并被静默忽略，自动回落到生产配置。
//
// 使用方式：
// 1. ipconfig 查看本机局域网 IPv4，填入 BASE_URL；
// 2. 真机预览时手机须与电脑处于同一 Wi-Fi；
// 3. 开发者工具「详情 → 本地设置」勾选「不校验合法域名」；
// 4. 上线前无需清理本文件（不入包），但 config.js 的 BASE_URL 必须已替换为生产域名。
module.exports = {
  // 服务器公网 IP（备案未通过阶段直连；走 nginx 80 端口）
  BASE_URL: 'http://124.221.130.18',
};
