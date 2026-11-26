# 八方聚 · GitHub → 腾讯云 手动部署操作手册（方式二）

> 仓库：`https://github.com/hauritzabdulah845-hash/bafangju`（公开，发布分支 `main`）
> 一句话原理：**本地改代码 → 合并进 GitHub `main` → 服务器上敲一行命令拉取并热更新**。每步人工确认，不使用 CI 直连生产。

---

## 一、第一次绑定（只做一次，约 5 分钟）

在 **腾讯云 OrcaTerm**（网页版终端）里，以 root 身份登录后逐条粘贴执行。

### 第 0 步：先备份现有线上环境（如果服务器上已经有能访问的站点）

```bash
mkdir -p /root/bafangju-preinstall-backup && \
sudo sqlite3 /opt/bafangju/data/bafangju.db ".backup '/root/bafangju-preinstall-backup/bafangju.db'" 2>/dev/null; \
sudo cp -a /etc/bafangju.env /root/bafangju-preinstall-backup/ 2>/dev/null; \
sudo cp -a /etc/nginx/conf.d/bafangju.conf /root/bafangju-preinstall-backup/ 2>/dev/null; \
sudo tar czf /root/bafangju-preinstall-backup/$(date +%F-%H%M).tar.gz -C /root/bafangju-preinstall-backup . 2>/dev/null; \
ls -lh /root/bafangju-preinstall-backup
```

> 全新服务器（还没部署过）可跳过；命令里的 `2>/dev/null` 会让不存在的文件静默跳过，不会报错中断。

### 第 1 步：把代码仓库克隆到服务器

```bash
git clone https://github.com/hauritzabdulah845-hash/bafangju.git /opt/bafangju-repo
```

- 仓库是**公开**的，不需要账号、不需要 Token。
- 目录名必须是 `/opt/bafangju-repo`（和运行目录 `/opt/bafangju` 分开，更新时不会互相踩踏）。

### 第 2 步：确认脚本可执行

```bash
chmod +x /opt/bafangju-repo/bafangju-server/scripts/*.sh && ls /opt/bafangju-repo/bafangju-server/scripts/
```

应能看到 `deploy.sh`、`pull-deploy.sh`、`setup-wxpay-certs.sh`、`health-watchdog.js` 等文件。

### 第 3 步：首次完整部署（第一次会生成 env 文件后退出，属正常）

```bash
sudo bash /opt/bafangju-repo/bafangju-server/scripts/deploy.sh
```

屏幕会提示 `已生成 /etc/bafangju.env，请编辑其中的 ADMIN_PASSWORD、WX_SECRET 后重跑本脚本`。

### 第 4 步：填写环境变量

```bash
sudo nano /etc/bafangju.env
```

**必须填的 4 项**：

| 变量 | 填什么 | 注意 |
| ---- | ---- | ---- |
| `DOMAIN` | `bfjzs.com` | 与 nginx / 小程序合法域名保持一致 |
| `ADMIN_PASSWORD` | 你自己的强口令 | **长度 > 10 位，且同时含字母和数字**，否则服务拒绝启动 |
| `WX_APPID` | 小程序 AppID | 默认已填 `wxa8811b4cc88f9857` |
| `WX_SECRET` | 小程序 AppSecret | 只在服务器保存，切勿外泄 |

保存退出：`Ctrl + O` → 回车 → `Ctrl + X`。

> 口令含空格或 `$` `!` 时，整行用单引号包起来，例如：`ADMIN_PASSWORD='Abc 123$Xy'`。

### 第 5 步：再跑一次部署脚本，完成安装

```bash
sudo bash /opt/bafangju-repo/bafangju-server/scripts/deploy.sh
```

脚本会自动完成：装 Node 22 / nginx / PM2 → 建数据目录 → 启动服务 → 配反向代理 → 每 6 小时数据库备份 → 日志轮转 → 健康检查。
最后会打印一段「部署完成」，里面有服务器 IP 和 `http://<IP>/admin.html` 访问地址。

### 第 6 步：验证

```bash
curl -s http://127.0.0.1:3000/api/health && echo && sudo pm2 list
```

看到 `{"ok":true,...}` 且 `bafangju-server`、`bafangju-health-watchdog` 都是 `online` 即成功。

然后在浏览器打开 `http://<你的公网IP>/admin.html`，用第 4 步填的账号密码登录后台。

> 腾讯云轻量控制台「防火墙」此时只需放行 **22 / 80**；**443 等备案通过再加；3000 绝对不要开放**。

---

## 二、日常更新（以后每次只需 1 行）

### 2.1 你在本地（或我这边）做的事

1. 改代码、跑测试；
2. 合并进 GitHub 的 `main` 分支。

### 2.2 服务器上做的事

```bash
cd /opt/bafangju-repo && sudo bash bafangju-server/scripts/pull-deploy.sh
```

就这一行。脚本会自动：

1. 备份数据库 → `/opt/bafangju/backups/pull-<时间>.db`（备份失败直接停，不改任何文件）
2. `git pull` 拉取 `origin/main`
3. 同步代码到 `/opt/bafangju`（**不动** `data`/`backups`/`logs`/`certs`/`node_modules`）
4. `npm ci --omit=dev` 装依赖
5. 重建 PM2 进程（主服务 + 健康看门狗）
6. 健康检查，失败会打印日志并给回滚命令

结束时类似这样：

```
 热更新完成（未改动 nginx / SSL / 数据库文件）
 代码版本   : 4e4ab76（main）
 本机自检   : http://127.0.0.1:3000/api/health   OK
```

### 2.3 只更新代码、先不重启（想观察一下）

```bash
cd /opt/bafangju-repo && sudo bash bafangju-server/scripts/pull-deploy.sh --no-restart
```

### 2.4 已经是最新时会怎样？

脚本会提示「已是最新（<提交号>），无需更新」然后退出 —— 重复执行完全安全（幂等）。

---

## 三、回滚

```bash
cd /opt/bafangju-repo && git log --oneline -5
```

选一个要回到的提交，然后：

```bash
cd /opt/bafangju-repo && sudo git reset --hard <提交号> && sudo bash bafangju-server/scripts/pull-deploy.sh
```

数据层（数据库）回滚：

```bash
sudo sqlite3 /opt/bafangju/data/bafangju.db ".restore '/opt/bafangju/backups/pull-<时间>.db'" && sudo pm2 restart bafangju-server
```

---

## 四、什么时候用 `pull-deploy.sh`，什么时候用 `deploy.sh`

| 你改了什么 | 用哪个脚本 |
| ---- | ---- |
| 业务代码、前端页面、测试、文档 | ✅ `pull-deploy.sh`（日常 99%） |
| `ecosystem.config.js`（PM2 进程 / 看门狗参数） | ✅ `pull-deploy.sh`（已含 PM2 重建） |
| nginx 模板、要切 HTTPS、换域名 | ⚠️ `deploy.sh`（会重写 `/etc/nginx/conf.d/bafangju.conf`） |
| 新机器首次安装、要装 Node/nginx/PM2 | ⚠️ `deploy.sh` |

> **`deploy.sh` 会重写 nginx 配置**，且要求 HTTPS 证书位于 `/etc/nginx/ssl/bfjzs.com.pem` 与 `.key`。若你手工改过 nginx，跑之前务必先备份：
> ```bash
> sudo cp -a /etc/nginx/conf.d/bafangju.conf /root/bafangju.conf.$(date +%F).bak
> ```

切 HTTPS 的完整顺序：

```bash
# 1) 证书放到约定位置（必须同名）
sudo mkdir -p /etc/nginx/ssl
#   bfjzs.com.pem  → /etc/nginx/ssl/bfjzs.com.pem
#   bfjzs.com.key  → /etc/nginx/ssl/bfjzs.com.key
sudo chmod 600 /etc/nginx/ssl/bfjzs.com.key

# 2) 重跑完整部署脚本，自动切换为「80 跳 443」
sudo bash /opt/bafangju-repo/bafangju-server/scripts/deploy.sh

# 3) 验证
curl -I https://bfjzs.com/admin.html
```

---

## 五、常用排查命令

| 目的 | 命令 |
| ---- | ---- |
| 服务状态 | `sudo pm2 list` |
| 实时日志 | `sudo pm2 logs bafangju-server` |
| 最近 50 行日志 | `sudo pm2 logs bafangju-server --lines 50 --nostream` |
| 本机健康检查 | `curl -s http://127.0.0.1:3000/api/health` |
| nginx 配置检查 | `sudo nginx -t` |
| nginx 错误日志 | `sudo tail -50 /var/log/nginx/error.log` |
| 数据库备份列表 | `ls -lh /opt/bafangju/backups` |
| 当前代码版本 | `cd /opt/bafangju-repo && git log --oneline -1` |
| GitHub 最新版本 | `cd /opt/bafangju-repo && git fetch && git log --oneline -1 origin/main` |

---

## 六、安全提示（务必遵守）

- `/etc/bafangju.env` 权限必须是 `600`（脚本已设置），里面是明文口令与 AppSecret；
- 微信 `AppSecret`、支付商户私钥**永远不要**贴进聊天、Issue 或提交到仓库；
- 防火墙只开 22 / 80（备案后再开 443），**3000 不开放**；
- 定期把 `/opt/bafangju/backups` 下载到本地或其他云存储做异地备份。

---

## 七、脚本清单（服务器上会用到）

| 脚本 | 用途 |
| ---- | ---- |
| `/opt/bafangju-repo/bafangju-server/scripts/deploy.sh` | 完整部署 / 改系统配置 |
| `/opt/bafangju-repo/bafangju-server/scripts/pull-deploy.sh` | **日常一行更新（推荐）** |
| `/opt/bafangju-repo/bafangju-server/scripts/setup-wxpay-certs.sh` | 微信支付证书放置与权限 |
| `/opt/bafangju/scripts/health-watchdog.js` | PM2 健康看门狗（随 PM2 常驻） |
