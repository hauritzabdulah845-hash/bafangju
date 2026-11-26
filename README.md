# 八方聚共享平台

本仓库收录八方聚共享平台（当前代码基线 **V4.6**）的全栈源码工程与交付文档。

## 目录说明

- `bafangju-server/`：后端服务（Node.js >= 22.5 + Express + 内置 `node:sqlite`）、管理后台（`/admin.html`）、移动端商家 H5 工作台（`/merchant.html`）、品牌官网（`/site/index.html`）、56 个自动化回归测试文件及运维对账工具。详见 [`bafangju-server/README.md`](./bafangju-server/README.md)。
- `bafangju-miniprogram-user/`：**主力微信小程序**（主包 22 个用户端页面 + 分包 `subpkg-merchant` 16 个商家端页面，支持顾客与商家双角色并存）。
- `bafangju-miniprogram-merchant/`：独立商家端微信小程序（16 个页面）。**维护约定**：以 `bafangju-miniprogram-user/subpkg-merchant/` 为唯一开发真源，修改商家端后执行 `cd bafangju-server && npm run sync:merchant` 自动转换同步，`npm test` 内置防漂移校验。
- `bafangju-design-tokens/`：跨端共享设计令牌唯一真源（`design-tokens.wxss`，V3.0 枣红体系）。
- `docs/`：域名绑定、ICP 备案、微信支付联调、后台测试用例等运维文档。
- `docs/交付报告/`：验收汇报、UI 全案、合规核对、全面审查报告、生产部署手册等交付文档。

## 快速自检与启动

```bash
cd bafangju-server
npm ci
npm test              # 全量合规与回归测试
npm run drill         # 月度对账演练（加 --paid-alliance 可演练联盟收费收款闭环）
npm run sync:merchant # 同步商家分包真源至独立商家端小程序
npm start             # 启动服务（默认 :3000）
```

## 安全说明

以下文件按安全规则未纳入仓库：管理员账号密档、`.env.local` 等真实环境变量、证书与私钥、`project.private.config.json`、数据库与测试上传产物、依赖目录、Python 编译缓存及生成压缩包。部署与运维脚本请使用各目录下的 `*.example` 模板或环境变量（如 `BFJ_SSH_HOST`、`ADMIN_PASSWORD`）注入配置。
