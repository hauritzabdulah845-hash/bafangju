# 八方聚共享平台

本仓库收录八方聚共享平台的源码工程与交付文档。

## 目录说明

- `bafangju-server/`：后端服务（Node.js）、后台与商家端静态页面、接口测试、部署脚本。
- `bafangju-miniprogram-user/`：用户端微信小程序。
- `bafangju-miniprogram-merchant/`：商家端微信小程序。
- `bafangju-design-tokens/`：共享设计变量。
- `docs/`：域名绑定、备案、微信支付联调、后台测试用例等运维文档。
- `docs/交付报告/`：验收汇报、UI 全案、合规核对、部署手册等交付文档。

## 安全说明

以下文件按安全规则未纳入仓库：管理员账号密档、`.env.local` 等真实环境变量、证书与私钥、`project.private.config.json`、数据库与测试上传产物、依赖目录及生成压缩包。部署时请使用各目录下的 `*.example` 模板重新填写环境变量。
