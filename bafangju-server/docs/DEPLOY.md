# 八方聚共享平台 · 部署上线指南

> 适用版本：V3.3 确认稿对应实现（测试 74/74 通过）。
> 架构：Node.js 22 + Express + SQLite（node:sqlite 内置，零外部依赖），域逻辑与传输层分离，可平滑迁移 MySQL。

## 一、服务器要求

| 项目 | 要求 |
| ---- | ---- |
| 操作系统 | Linux（Ubuntu 22.04 / Debian 12 均可） |
| Node.js | **v22+**（依赖内置 `node:sqlite`，低版本无法运行） |
| 内存/磁盘 | 1C2G 起步；磁盘预留 10G（含 SQLite 数据与备份） |
| 网络 | 备案域名 + HTTPS 证书（微信小程序强制要求） |

## 二、部署步骤

> 推荐：代码上传后执行 `sudo bash scripts/deploy.sh`，自动完成装环境、建数据目录、PM2 启动、nginx 反向代理与定时备份；首次执行会生成 `/etc/bafangju.env` 供填写口令与 AppSecret。证书就位后再执行一次即自动切 HTTPS。以下为手动步骤，便于逐项排查。

```bash
# 1. 上传代码（或 git clone）
cd /opt/bafangju && npm ci --omit=dev   # 生产只装运行依赖（当前无外部依赖，此步秒过）

# 2. 配置环境变量（二选一：.env 文件或 systemd/PM2 env）
#    完整清单见下节

# 3. PM2 守护启动
npm i -g pm2
pm2 start ecosystem.config.js
pm2 save && pm2 startup   # 开机自启

# 4. 验证
curl http://127.0.0.1:3000/api/home
curl -I http://127.0.0.1:3000/admin.html   # 应返回 200，并弹出登录框
```

## 三、环境变量清单（生产必配）

### 3.1 安全（生产必配，缺失或强度不足将拒绝启动）

| 变量 | 说明 |
| ---- | ---- |
| `ADMIN_USER` | 管理后台账号（**生产环境不配置则默认 admin**） |
| `ADMIN_PASSWORD` | 管理后台初始密码。**生产环境（`NODE_ENV=production`）必配**：未配置或强度不足时服务**直接拒绝启动**并打印明确错误；口令须 **长度大于 10 位且同时包含字母与数字**（禁止沿用 `admin/admin123`）。仅非生产环境（本地开发/测试）才回落为 `admin/admin123` |

> 生产启动时若数据库中仍残留开发默认口令账号，会被自动轮换为 `ADMIN_PASSWORD`（默认口令即刻失效），并在审计中留痕 `admin.password_reset_from_env`；运维已自行改过密码的账号不会被覆盖。

### 3.2 微信小程序登录（必配）

| 变量 | 说明 |
| ---- | ---- |
| `WX_APPID` | 小程序 AppID |
| `WX_SECRET` | 小程序 AppSecret |

### 3.3 微信支付商户号（材料到位后配置，自动切换真实通道）

| 变量 | 作用 | 配置后生效 |
| ---- | ---- | ---- |
| `WX_MCHID` | 商户号 | 真实下单 |
| `WX_MERCHANT_SERIAL` | 商户 API 证书序列号 | 请求签名 |
| `WX_PRIVATE_KEY` | 商户私钥（PEM 内容或文件路径） | 请求签名 |
| `WX_APIV3_KEY` | APIv3 密钥（32 字节） | 回调解密 + 商家转账 |
| `WX_PLATFORM_CERT` | 微信支付平台证书（PEM 内容或路径） | 回调验签（未配置时 notify-wx 明确拒绝） |

### 3.4 存储（可选）

| 变量 | 默认 | 说明 |
| ---- | ---- | ---- |
| `BAFANGJU_DB_PATH` | `<项目>/data/bafangju.db` | SQLite 文件路径（放数据盘，纳入备份） |
| `PORT` | 3000 | 服务端口 |

### 3.5 上传与限流（P0-3）

| 变量 | 默认 | 说明 |
| ---- | ---- | ---- |
| `BAFANGJU_UPLOAD_DIR` | `<项目>/data/uploads` | **公开**素材目录（商品/广告图）。经 `/uploads/*` 静态路由匿名可读（用户端小程序需匿名浏览） |
| `BAFANGJU_UPLOAD_PRIVATE_DIR` | `<项目>/data/uploads-private` | **私有**证照目录（商家入驻营业执照/门头照）。**不挂静态路由**，只能经 `/api/admin/uploads/private/:name` 由管理后台鉴权后查看 |
| `TRUST_PROXY` | 关闭 | 置 `1` 时信任 1 层反向代理转发的 `X-Forwarded-For`（nginx 后必配，否则上传限流会把同一出口 IP 的所有用户算成一个人） |

上传安全策略（代码内置，见 `src/domain/upload.js`）：

- **真实类型判定**：读文件头 magic bytes（PNG/JPEG/WEBP），不信任客户端传入的 `ext`；伪装成图片的文本/PDF 一律拒收；
- **不可预测文件名**：`crypto.randomUUID()`，不使用 `Date.now()+随机数`；
- **身份分级**：素材上传（`purpose=material`）必须登录商家/用户身份；未登录只允许传入驻证照（`purpose=entry`），且证照落私有目录；
- **频率限制**：分钟级（商家 20 次 / 用户 10 次 / 游客 5 次，同源 IP 30 次）；
- **每日配额**：主体（商家 200 / 用户 50 / 游客 20 次）、同源 IP（100 次 / 200MB）、全站（2000 次 / 1GB）三重计数，计数落库（`uploadQuota` 表）**跨重启不重置**，每日跑批自动清理历史行；
- **审计留痕**：每次上传记 `upload.image`，被拒（超限/未登录）记 `upload.rejected`，管理后台「审计日志 → 上传安全」页签可查。

### 3.6 小程序包体（P0-4）

小程序后端地址分两个文件，避免内网地址随包发布泄露：

| 文件 | 是否进包体 | 内容 |
| ---- | ---- | ---- |
| `config.js` | ✅ 进包 | 生产域名 `https://bfjzs.com` |
| `config.dev.js` | ❌ 不进包（`project.config.json → packOptions.ignore`） | 本机局域网地址（仅开发机存在） |

- `config.js` 以 `try/catch` 加载 `config.dev.js`：本地存在则覆盖 `BASE_URL`，正式包内不存在该文件时静默回落生产配置（不会因缺文件报错）。
- 调试入口（用户端首页「网络诊断」按钮）由 `utils/env.js` 判定 `envVersion === 'develop'` 才可见，正式版/体验版一律隐藏；网络异常时界面只显示「网络连接失败，请稍后重试」，原始 `errMsg` 与目标地址只写 console。
- 防回归：`test/miniprogram-leak.test.js` 静态扫描两端小程序源码（内网地址仅允许出现在 `config.dev.js`、诊断入口必须门控、`api.js` fail 分支不得抛 `errMsg`/地址）。

## 四、HTTPS 反向代理（nginx 示例）

```nginx
server {
    listen 443 ssl;
    server_name bfjzs.com;
    ssl_certificate     /etc/nginx/ssl/bfjzs.com.pem;
    ssl_certificate_key /etc/nginx/ssl/bfjzs.com.key;

    client_max_body_size 8m;   # 上传接口单文件上限 4MB，base64 报文约 5.4MB（<1m 会被 nginx 直接 413 拦掉）

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;   # 上传限流按真实客户端 IP 计量，需配合 TRUST_PROXY=1
        # 微信支付回调需要原始 body：不要在任何 location 上开启 body 改写/压缩
    }
}
```

微信商户平台回调地址配置为：`https://bfjzs.com/api/payment/notify-wx`
小程序 request 合法域名配置为：`https://bfjzs.com`

## 五、定时任务（两种模式二选一）

### 模式 A：服务端内置调度（默认，推荐起步）

服务内置分钟级检查，跨日自动顺序执行：
① 活跃快照（T-1）→ ② 排队分红（单事务）→ ③ 转账超时退回 → ④ 提现顺延补发。
无需额外配置。

### 模式 B：外部 crontab（规模增大后，便于监控与告警）

```bash
# /etc/cron.d/bafangju  （TOKEN 为管理员登录后签发的会话 token，或后续为跑批专设系统账号）
0 1 * * *  curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://bfjzs.com/api/admin/jobs/activity-snapshot -H 'Content-Type: application/json' -d '{"date":"TODAY"}'
10 1 * * * curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://bfjzs.com/api/admin/jobs/daily-dividend -H 'Content-Type: application/json' -d '{}'
20 1 * * * curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://bfjzs.com/api/admin/jobs/expire-transfers -H 'Content-Type: application/json' -d '{}'
30 1 * * * curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://bfjzs.com/api/admin/jobs/issue-queued -H 'Content-Type: application/json' -d '{}'
0 6 * * *  curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://bfjzs.com/api/admin/jobs/retry-transfers -H 'Content-Type: application/json' -d '{}'
```

> 使用 crontab 模式时建议内置调度保持开启也无妨（各跑批均幂等，重复触发无副作用）。

## 六、备份策略（SQLite 单文件，最简可靠）

```bash
# /etc/cron.d/bafangju-backup：每 6 小时热备（WAL 模式下用 .backup 命令保证一致性）
0 */6 * * * sqlite3 /opt/bafangju/data/bafangju.db ".backup '/opt/bafangju/backups/bfj-$(date +\%Y\%m\%d-\%H).db'"
```

- 建议同时异地备份（rsync 到第二台机器/对象存储），保留 ≥30 天；
- 审计日志（audit 表）为 append-only，随主库一并备份；
- 恢复：停服务 → 替换 db 文件 → 启动（幂等键/自增序列随库恢复，无额外步骤）。

## 七、上线 Checklist

- [ ] `ADMIN_USER`/`ADMIN_PASSWORD` 已配置，且 `ADMIN_PASSWORD` 满足 **长度大于 10 位且含字母与数字**（否则服务拒绝启动）；审计中无 `devDefault` 告警、无 `admin.password_reset_from_env` 轮换记录
- [ ] `WX_APPID`/`WX_SECRET` 已配置，小程序端真机登录验证通过
- [ ] 商户号环境变量已配置，`/api/payment/prepay` 真实下单小额验证通过
- [ ] `WX_PLATFORM_CERT` 已配置，回调验签通过（可观察 audit 中 `payment.notify_wx`）
- [ ] nginx HTTPS + 合法域名 + 商户平台回调地址已配置
- [ ] nginx `client_max_body_size` ≥ 8m 且透传 `X-Forwarded-For`，服务端 `TRUST_PROXY=1`（否则大图上传被 413 拦掉、上传限流失效）
- [ ] `data/uploads-private`（入驻证照私有目录）权限最小化（非 web 进程用户可读即可），磁盘容量已纳入监控
- [ ] SQLite 数据文件路径已纳入备份计划
- [ ] 管理后台确认：合规开关全部为默认关闭态（间推/免单退款/提现/降级）
- [ ] 甲方确认事项 12（利润率口径）、13（十元区 r 目标）已定，生产参数已录入（类目 r 值、商品标价/成本）
- [ ] 提现通道（`withdrawEnabled`）保持关闭，待商户入驻满 90 天评估后开启（待确认 19）
- [ ] 微信审核预案：分批提审，先用户端基础购物链路；降级开关 `auditDowngrade` 可一键隐藏分红/团队入口

## 八、常见运维操作

| 操作 | 方式 |
| ---- | ---- |
| 查看审计日志 | 管理后台「审计日志」页签（append-only，最近 200 条） |
| 手动补跑跑批 | 管理后台「跑批任务」页签 |
| 上架/改价商品 | 管理后台「商品管理」页签（审计留痕，成交快照不追溯） |
| 商家建档/停用 | 管理后台「商家管理」页签 |
| 提现审核 | 管理后台「提现审核」页签（含收款人补录与失败重试） |
| 服务日志 | `logs/pm2-out.log` / `pm2 logs bafangju-server` |
