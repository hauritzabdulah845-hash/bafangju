# 八方聚共享平台 · 生产部署实施手册

> 适用：腾讯云轻量应用服务器（Ubuntu 22.04/24.04 LTS）
> 生产域名：`https://bfjzs.com`　|　服务端口：`3000`（仅本机，经 nginx 反代）
> 小程序 AppID：`wxa8811b4cc88f9857`
> 本手册自包含，可在任意一台电脑上照此重新实施。

---

## 0. 方案总览

| 项目 | 选择 | 说明 |
| ---- | ---- | ---- |
| 服务器系统 | Ubuntu 22.04 LTS 纯净系统镜像 | 不用宝塔/应用镜像，避免与 nginx 抢 80/443 |
| 服务器管理方式 | SSH 直连（VS Code Remote-SSH 或 MobaXterm） | 零额外资源占用，无需开放管理面板端口 |
| 进程守护 | PM2（开机自启） | `pm2 save` + `pm2 startup` |
| Web 反代 | nginx（443 → 127.0.0.1:3000） | 由 `scripts/deploy.sh` 自动生成配置 |
| 数据库 | SQLite 单文件（每 6 小时热备） | 位于 `/opt/bafangju/data/` |
| 部署方式 | `scripts/deploy.sh` 一键脚本 | 首次生成 env → 填写 → 重跑完成 |

**目录约定**

```
/opt/bafangju/                 代码目录
/opt/bafangju/data/            SQLite 数据库 + 上传文件（备份时必带）
/opt/bafangju/backups/         自动备份（每 6 小时）
/etc/bafangju.env              环境变量（chmod 600，含明文口令）
/etc/nginx/conf.d/bafangju.conf  nginx 站点配置
/etc/nginx/ssl/bfjzs.com.pem|key  SSL 证书
```

---

## 1. 服务器准备

### 1.1 判断是否需要重装

| 当前镜像 | 处理 |
| ---- | ---- |
| 应用镜像（宝塔 / LNMP / WordPress / Docker 一键包） | **重装** |
| CentOS 7/8、Windows Server | **重装** |
| Ubuntu 22.04 / 24.04 / Debian 12 纯净系统 | 直接用，跳过 1.2 |

### 1.2 重装系统

1. 腾讯云控制台 → 轻量应用服务器 → 选中实例
2. 右上角「更多」→「重装系统」
3. 镜像类型选 **系统镜像** → **Ubuntu 22.04 LTS 64 位**
4. 设置登录密码并记录
5. 确认，等待 2~3 分钟自动重启

> 重装保留：公网 IP、防火墙规则、实例规格；仅清空系统盘。
> 若实例为 ARM 架构，选 "Ubuntu 22.04 LTS ARM64"，部署脚本同样适用。

### 1.3 防火墙（腾讯云控制台 → 防火墙）

| 端口 | 用途 | 建议 |
| ---- | ---- | ---- |
| 22 | SSH | 必开 |
| 80 | HTTP / 证书验证 / 跳转 | 必开 |
| 443 | HTTPS | 备案通过后必开 |
| 3000 | 后端直连 | **仅临时调试时开，用完立即关闭** |
| 8888 | 宝塔面板 | **不要开**（本方案不装面板） |

---

## 2. 连接服务器

### 方式 A：VS Code / Trae Remote-SSH（推荐）

1. 安装扩展 **Remote - SSH**
2. `Ctrl+Shift+P` → `Remote-SSH: Connect to Host` → 输入 `root@<124.221.130.18>`
3. 连接后「打开文件夹」选 `/opt/bafangju`

> 部分 Ubuntu 镜像默认用户为 `ubuntu`，此时用 `ssh ubuntu@IP`，后续命令全部加 `sudo`。

### 方式 B：MobaXterm（图形化文件管理）

新建 SSH 会话 → 填 IP / 用户名 → 登录后左侧自动出现 SFTP 文件树，可拖拽上传。

---

## 3. 上传代码

在**本地项目电脑**执行（PowerShell）：

```powershell
# 方式一：直接同步代码目录（推荐，不含本地测试数据）
scp -r bafangju-server/* root@<公网IP>:/opt/bafangju/

# 方式二：使用打包好的部署包（见 README 附带的 zip）
scp 八方聚-生产部署包.zip root@<公网IP>:/tmp/
# 服务器上解压：
ssh root@<公网IP> "mkdir -p /opt/bafangju && cd /opt/bafangju && unzip -o /tmp/八方聚-生产部署包.zip"
```

> 部署包**不含** `data/`（本地测试库不要带到生产）、`node_modules/`、`backups/`、`logs/`。

---

## 4. 执行部署脚本（两阶段）

### 4.1 第一阶段：生成环境变量文件

```bash
sudo bash /opt/bafangju/scripts/deploy.sh
```

首次执行会把 `scripts/deploy.env.example` 复制到 `/etc/bafangju.env` 并**主动退出**（这是刻意设计，防止用默认口令上线）。

### 4.2 填写环境变量

```bash
sudo nano /etc/bafangju.env
```

必填项：

```bash
DOMAIN=bfjzs.com
ADMIN_USER=bafangju
ADMIN_PASSWORD=<≥12位，同时含大写字母、小写字母、数字>   # 不达标服务会拒绝启动
WX_APPID=wxa8811b4cc88f9857
WX_SECRET=<微信公众平台 → 开发管理 → 开发设置 中的 AppSecret>
WX_MERCHANT_APPID=wxa8811b4cc88f9857                     # 两端共用同一个小程序时填同一个 AppID
WX_MERCHANT_SECRET=<与 WX_SECRET 相同；若商家端独立小程序，填它自己的 Secret>
HOST=127.0.0.1                                            # 只监听本机，由 nginx 反代
TRUST_PROXY=1
PUBLIC_IP=124.221.130.18          # 可选：脚本末尾打印的访问地址用这个公网 IP
```

保存后确认权限：`sudo chmod 600 /etc/bafangju.env`

> 密码含空格、`$`、`!` 等特殊字符时用单引号包裹。
> `WX_SECRET` 留空则小程序登录与小程序码生成会失败。
> **两端 AppID 必须与实际小程序一致**：本项目当前用户端与商家端共用同一个小程序（`wxa8811b4cc88f9857`），所以 `WX_MERCHANT_*` 与 `WX_*` 填相同值；将来若拆成两个小程序，必须分别改成各自的 AppID/Secret。用错 appid 换 `wx.login` 的 code 会返回 `40029`，并会被静默降级成开发态 openid，上线后提现必然失败。生产环境缺 `WX_MERCHANT_*` 时该接口直接报错拒绝，不会静默降级。

### 4.3 第二阶段：完成部署

```bash
sudo bash /opt/bafangju/scripts/deploy.sh
```

脚本自动完成：

1. 安装 nginx / sqlite3 / rsync / curl，Node 22（不足自动升级）、PM2
2. 同步代码到 `/opt/bafangju`（保留 `data`、`backups`、`logs`）
3. `npm ci --omit=dev`
4. 校验 `ADMIN_PASSWORD` 强度
5. `pm2 delete all` + `pm2 start` + 开机自启（不能只做 reload：PM2 的 `--update-env` 不覆盖进程已存在的键，改了 `bafangju.env` 后进程里仍是旧值）
6. 生成 nginx 配置（无证书走 80；有证书走 443 + 80 跳转）
7. 写入每 6 小时 SQLite 热备
8. 健康检查 `/api/health`
9. 打印待办清单

成功标志：输出 `本机自检 : http://127.0.0.1:3000/api/health OK`。

**日常更新代码**：重新上传 → 再执行一次本脚本即可（会重建 PM2 进程，约 1~2 秒不可访问；`data`/`backups` 不受影响）。

### 4.4 部署验收清单（实测记录 · 2026-11-01）

实际环境：腾讯云轻量 `124.221.130.18`，Ubuntu 26.04 LTS，Node `v22.22.1`，PM2 `7.1.1`，nginx 80 端口反代 `127.0.0.1:3000`。

| 验收项 | 验证命令 | 通过标准 |
| ---- | ---- | ---- |
| 进程存活 | `sudo pm2 list` | 两个进程 `online`，`↺` 重启计数为 0 |
| 健康检查 | `curl -s http://127.0.0.1:3000/api/health` | HTTP 200 且 `{"ok":true,...}` |
| nginx 反代 | `curl -I http://<公网IP>/admin.html` | HTTP 200 |
| 后台登录 | `curl -X POST http://<公网IP>/api/admin/login -H 'Content-Type: application/json' -d '{"username":"bafangju","password":"<ADMIN_PASSWORD>"}'` | 返回 `{"token":...}` |
| 微信 access_token | `curl "https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=$WX_APPID&secret=$WX_SECRET"` | 返回 `{"access_token":...,"expires_in":7200}` |
| 微信登录链路 | `curl "https://api.weixin.qq.com/sns/jscode2session?appid=$WX_APPID&secret=$WX_SECRET&js_code=FAKE_CODE&grant_type=authorization_code"` | `{"errcode":40029,"errmsg":"invalid code"}` |

> **用假 code 验密钥是最省事的办法**：`40029 invalid code` = AppID/Secret 有效、接口可达；`40125 invalid appsecret` = Secret 填错；`41002 appid missing` = 变量没加载（多半是 shell 里没 `source /etc/bafangju.env`）。
> 以上命令中的 `$WX_APPID` / `$WX_SECRET` 需先 `set -a; . /etc/bafangju.env; set +a` 或直接用 `sudo bash` 读取（env 文件权限 600）。

部署完成后即可：
1. 登录 http://<公网IP>/admin.html（`bafangju` / `ADMIN_PASSWORD`）
2. 小程序在微信开发者工具中勾选「不校验合法域名」并用**真机调试**（详见 5.2 表格）
3. 后台「系统设置 → 小程序码配置」点「测试生成」，此时 AppSecret 已生效可直接出码

### 4.5 部署踩坑记录（已修复，异地重施不必重踩）

| 现象 | 根因 | 处理方式 |
| ---- | ---- | ---- |
| 健康检查恒失败、PM2 重启计数持续飙升 | `/api/health` 调用了存储层不存在的 `db.users.list()`，异常被 `catch` 吞掉，SQLite 驱动下必然返回 503，看门狗每 90s 重启一次 | 改为 `Array.isArray(db.users.all())`（`src/routes/public.js`） |
| 改了 `/etc/bafangju.env`，进程里仍是旧值（`ADMIN_PASSWORD` 还是模板口令、`WX_SECRET` 为空） | PM2 的 `--update-env` **不会覆盖进程已存在的键** | 部署脚本改为 `pm2 delete all` + `pm2 start`（见 4.3 第 5 步） |
| 只改 env 里的管理员口令，后台登录仍是旧口令 | 管理员账号只在首次启动时按 env 创建，之后不跟随 env | 清掉账号再重跑：`sqlite3 /opt/bafangju/data/bafangju.db "DELETE FROM adminAccounts; DELETE FROM adminSessions;"` |
| 脚本末尾提示的地址是 `http://10.0.0.2/admin.html`，打不开 | `hostname -I` 取到的是内网地址 | 脚本支持 `PUBLIC_IP`，未设置时自动探测公网 IP |
| 浏览器访问提示「连接超时 / 无法访问此网站」 | 腾讯云轻量控制台「防火墙」未放行 80；服务器内 `ufw` 是关闭的，不是本机防火墙问题 | 控制台 → 防火墙 → 加规则 TCP 80，来源 `0.0.0.0/0`；放行后先用 `/api/health` 自检 |
| 访问偶尔成功、偶尔超时 | 防火墙规则刚生效或浏览器缓存了失败状态 | 用无痕窗口访问 `/api/health` 定界：能返回 JSON = 链路通，问题在浏览器 |

---

## 5. 备案中 / 备案通过后的切换

### 5.1 备案未通过（当前状态：用公网 IP）

未备案域名会被腾讯云阻断，因此这一阶段**全程用公网 IP，不开 443、不开 3000**：

| 项目 | 做法 |
| ---- | ---- |
| 防火墙 | 只放行 **22 / 80**（不加 443，不开 3000） |
| 部署脚本 | 照常执行；无证书时自动生成 80 端口配置并反代 `127.0.0.1:3000`，同时移除发行版默认站点，保证 IP 请求命中后端 |
| 管理后台 | `http://<公网IP>/admin.html` |
| 接口自检 | `http://<公网IP>/api/health` |
| SSL 证书 | 可提前申请（选 **DNS 验证**，不要求站点可访问，备案中也能签发） |

**小程序侧（仅限开发调试，此阶段不能发布）**

| 项目 | 设置 |
| ---- | ---- |
| `config.js`（两个端） | `BASE_URL: 'http://<公网IP>'` —— **备案期必须改这里**。`config.dev.js` 被 `packOptions.ignore` 排除，预览/真机调试的包里同样不存在该文件，只改它会静默回落到域名，报 `request:fail` |
| `config.dev.js`（两个端） | 同样填 `http://<公网IP>`（保持一致；该文件不进包，仅本地开发用） |
| 开发者工具 | 详情 → 本地设置 → 勾选「不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书」 |
| 真机 | 必须用「**真机调试**」；「预览」不行（预览会强制校验合法域名，IP 必然报 `not in domain list`） |
| 不能做 | 体验版、提审、发布——微信要求「已备案域名 + HTTPS」，IP 一律拒绝 |

> 备案通过后：把两个端 `config.js` 的 `BASE_URL` 改回 `https://bfjzs.com` 重新上传（`config.dev.js` 不用管，它不进包）；否则正式包会带着 IP 提交，微信直接拒绝。

### 5.2 备案通过后

1. **DNS 解析**：域名 → DNS 解析 → 添加 `bfjzs.com` → A 记录 → 服务器公网 IP
2. **证书就位**：下载 Nginx 格式证书，放到
   - `/etc/nginx/ssl/bfjzs.com.pem`
   - `/etc/nginx/ssl/bfjzs.com.key`
3. **重跑脚本**：

```bash
sudo bash /opt/bafangju/scripts/deploy.sh     # 检测到证书后自动切 HTTPS
curl -I https://bfjzs.com/admin.html           # 期望 200
```

> **切换前先留一份现网配置**，回滚时可直接换回：

```bash
sudo cp /etc/nginx/conf.d/bafangju.conf /root/nginx-bafangju.conf.http.bak
sudo cp /etc/bafangju.env               /root/bafangju.env.http.bak
```

### 5.3 回滚：切 HTTPS 出问题时退回 IP 模式

**触发条件**（出现任一且 30 分钟内定位不到根因，就回滚，别硬扛）：

| 现象 | 判断依据 |
| ---- | ---- |
| 域名打不开但 IP 正常 | `curl -I http://<公网IP>/api/health` 返回 200，`https://bfjzs.com` 报 502/超时 |
| 证书链错误 | `curl -I https://bfjzs.com` 报 `unable to get local issuer certificate` / 浏览器提示证书无效 |
| 小程序全部请求失败 | `request:fail ssl hand shake error` 或 `url not in domain list` |
| DNS 未生效或解析错 | `dig bfjzs.com` 拿到的不是本机公网 IP |

**回滚目标**：退回备案期的「HTTP + 公网 IP」模式，服务不中断、数据不丢。

#### 步骤 1 · 服务器侧（约 1 分钟）

```bash
# ① 移走证书：脚本检测不到证书，就会自动生成 80 端口配置（default_server，任何 Host 都命中后端）
sudo mkdir -p /root/ssl-rollback
sudo mv /etc/nginx/ssl/bfjzs.com.pem /root/ssl-rollback/
sudo mv /etc/nginx/ssl/bfjzs.com.key /root/ssl-rollback/

# ② 重跑部署脚本（重写 nginx 配置 + 重建 PM2 进程）
cd /opt/bafangju && sudo bash scripts/deploy.sh

# ③ 验证
curl -s -o /dev/null -w 'health=%{http_code}\n' http://<公网IP>/api/health    # 期望 200
curl -s -o /dev/null -w 'admin=%{http_code}\n'  http://<公网IP>/admin.html    # 期望 200
```

**只临时切回、不想动证书**：直接换回备份配置即可，秒级生效：

```bash
sudo cp /root/nginx-bafangju.conf.http.bak /etc/nginx/conf.d/bafangju.conf
sudo nginx -t && sudo systemctl reload nginx
```

#### 步骤 2 · DNS

**一般不用动**。80 端口用的是 `default_server`，域名解析仍指向本机时，`http://bfjzs.com` 同样能访问后端。只有在解析指向了错误机器时才需要修正。

#### 步骤 3 · 微信公众平台

把「服务器域名」里的 `https://bfjzs.com` 删掉。

> IP 本来就不能作为合法域名，留着域名但服务不通只会让报错更迷惑；回到「不校验合法域名 + 真机调试」状态更干净。

#### 步骤 4 · 小程序端（要恢复真机调试时）

| 文件 | 回滚值 |
| ---- | ---- |
| `config.js`（用户端 / 商家端） | `BASE_URL: 'http://<公网IP>'` |
| `config.dev.js`（用户端 / 商家端） | 同值 |

改完必须重新「编译 / 上传」；**已经发出去的体验版不会自动回滚**，需重新上传体验版覆盖。开发者工具仍要勾选「不校验合法域名」，手机端用「真机调试」。

#### 回滚验收清单

| 项目 | 命令 | 期望 |
| ---- | ---- | ---- |
| 本机自检 | `curl -s http://127.0.0.1:3000/api/health` | `{"ok":true,...}` |
| nginx 反代 | `curl -I http://<公网IP>/api/home` | 200 |
| 后台页面 | `curl -I http://<公网IP>/admin.html` | 200 |
| 后台登录 | `curl -X POST http://<公网IP>/api/admin/login -H 'Content-Type: application/json' -d '{"username":"bafangju","password":"<口令>"}'` | 返回 token |
| 进程状态 | `sudo pm2 list` | 两进程 online、`↺` 为 0 |
| 数据完好 | `sudo ls -l /opt/bafangju/data/` | `bafangju.db` 与 uploads 均在 |

#### 恢复（问题修好后切回 HTTPS）

把证书放回 `/etc/nginx/ssl/bfjzs.com.pem`、`.key` → 重跑 `deploy.sh` → `curl -I https://bfjzs.com/admin.html` 期望 200 → 公众平台重新填服务器域名 → 小程序 `config.js` 改回域名并重新上传。

> **回滚不影响数据**：`/opt/bafangju/data`（SQLite + 上传文件）与 `/opt/bafangju/backups` 全程不动；PM2 重建只带来 1~2 秒不可访问。回滚也不会改 `/etc/bafangju.env` 里的业务配置。

### 5.4 发布回滚：新版本上线出问题时

`deploy.sh` 用 `rsync -a --delete` 覆盖代码，**不会保留旧版本**；数据库也不会随代码回退。所以回滚有两类，选错方向会把问题放大。

**原则**：先止损（10 分钟内回到上一版），再离线定位原因。回滚前先把现场留一份，否则问题无法复现。

#### 第 0 步 · 先保现场（必做）

```bash
cd /opt/bafangju
sudo mkdir -p backups/rel-$(date +%Y%m%d-%H%M)
sudo cp -a src public test package.json package-lock.json ecosystem.config.js \
     backups/rel-$(date +%Y%m%d-%H%M)/          # 当前（坏）版本
sudo cp data/bafangju.db backups/before-rollback-$(date +%Y%m%d-%H%M).db
sudo cp /etc/bafangju.env /root/bafangju.env.$(date +%Y%m%d-%H%M).bak
```

#### A 类 · 只回滚代码（页面报错、接口 500、功能异常，数据是好的）

**方式 1（推荐）：重发上一个部署包**

```bash
# 本机：把上一版 zip 传上来（文件名改成上一版，别覆盖）
scp 八方聚-生产部署包-v<上一版>.zip ubuntu@<IP>:/tmp/prev.zip

# 服务器
rm -rf /tmp/prev && mkdir -p /tmp/prev && cd /tmp/prev
unzip -oq /tmp/prev.zip
sudo bash scripts/deploy.sh          # 脚本会用旧代码覆盖 /opt/bafangju，data/backups 不动
```

**方式 2：只换回个别文件（热修，最快）**

```bash
sudo cp /opt/bafangju/backups/rel-<旧版时间>/src/routes/<文件>.js /opt/bafangju/src/routes/
sudo pm2 restart bafangju-server --update-env
```

**方式 3：全量换回快照目录**

```bash
sudo rsync -a --delete --exclude data --exclude backups --exclude logs \
     /opt/bafangju/backups/rel-<旧版时间>/ /opt/bafangju/
cd /opt/bafangju && sudo bash scripts/deploy.sh
```

> 代码回滚**不会**撤销数据库变更。如果新版本执行过建表/改字段/批量写数据，必须配合 B 类一起评估；只回滚代码而库已变形，常见表现是「旧代码读不到新字段，接口继续 500」。

#### B 类 · 回滚数据（脏数据、误删、批量改坏）

```bash
# ① 停写入，避免恢复过程中被覆盖
sudo pm2 stop bafangju-server

# ② 选一个回滚点（每 6 小时自动备份，文件名 bfj-YYYYMMDD-HH.db）
sudo ls -lht /opt/bafangju/backups | head -10

# ③ 覆盖数据库，并**必须**删掉 WAL/SHM，否则旧库与新 WAL 混合会数据错乱
sudo cp /opt/bafangju/backups/bfj-<回滚点>.db /opt/bafangju/data/bafangju.db
sudo rm -f /opt/bafangju/data/bafangju.db-wal /opt/bafangju/data/bafangju.db-shm

# ④ 校验完整性后再启动
sudo sqlite3 /opt/bafangju/data/bafangju.db "PRAGMA integrity_check;"   # 期望 ok
sudo pm2 start bafangju-server
```

- 回滚会丢失「备份点之后」的所有业务数据，回滚前必须让业务方确认时间窗。
- 上传的图片/证件在 `/opt/bafangju/data/uploads*`，不在数据库里；若同时误删，从云盘备份或本地副本恢复。
- 恢复后登录后台抽查：订单数、商品数、商家数、最近一条订单时间，确认不是「回滚过头」。

#### 回滚验收清单

| 项目 | 命令 | 期望 |
| ---- | ---- | ---- |
| 进程 | `sudo pm2 list` | 两进程 online、`↺` 为 0 |
| 健康 | `curl -s http://127.0.0.1:3000/api/health` | `{"ok":true,...}` |
| 公网 | `curl -I http://<公网IP>/admin.html` | 200 |
| 登录 | 后台登录 | 能进，非 500 |
| 数据 | 后台看订单/商品/商家数量 | 与回滚点一致 |
| 错误日志 | `sudo tail -50 /opt/bafangju/logs/pm2-error.log` | 无新崩溃堆栈 |

#### 回滚失败就升级处置

同一问题回滚两次仍不恢复，停止继续尝试，先把下面三份材料抓下来再动手：

```bash
sudo pm2 logs bafangju-server --lines 200 --nostream > /tmp/bfj-pm2.log
sudo cp /opt/bafangju/data/bafangju.db /tmp/bfj.db
sudo cat /etc/nginx/conf.d/bafangju.conf > /tmp/bfj-nginx.conf
```

> 禁止在没有备份的前提下删除或覆盖 `/opt/bafangju/data/` 下的任何文件；回滚本身也要先备份当前库（第 0 步）。

---

## 6. 微信公众平台配置

登录 mp.weixin.qq.com（小程序 `wxa8811b4cc88f9857`）→ 开发管理 → 开发设置：

| 配置项 | 值 |
| ---- | ---- |
| request 合法域名 | `https://bfjzs.com` |
| uploadFile 合法域名 | `https://bfjzs.com` |

> **硬性要求**：域名必须已完成 ICP 备案，且备案主体与该小程序账号主体一致。主体不一致需在小程序后台做域名授权，否则会被驳回。

**检查前置**：`https://bfjzs.com/api/health` 必须能从外网正常返回，否则微信校验不通过。

---

## 7. 生产数据初始化

服务器是全新数据库，本地数据不会自动迁移。登录 `https://bfjzs.com/admin.html`（备案前用 `http://<公网IP>/admin.html`，走 nginx 80 端口，不要直连 3000）后按顺序配置：

1. 修改管理员口令（首次登录强制）
2. 核对类目与 `r` 值（`n` 由阶梯引擎自动推导，改 r 会审计留痕）
3. 上架平台自营商品（标价 / 成本 / 税费费率 / 运营成本 / 配送方式）
4. 审核商家入驻、签发商家账号（初始口令仅显示一次）
5. 系统设置 → 小程序码配置：填 AppID / AppSecret 并点「测试生成」验证出码
6. 广告位配置（如启用）

> 若要带本地演示数据：把本地 `bafangju-server/data/bafangju.db` 上传到 `/opt/bafangju/data/`，**但上线前必须清理测试商品、测试商家与测试订单**。

### 7.1 清理种子演示数据（上线前必做）

当前服务器已自带种子数据：**12 个类目、7 个商家、6 个商品**（其中 6 个商家带 `seedTag=nearby_demo`/`createdBy=seed`，另有 `m_demo`「张记粮油店」及其 2 个商品）。这些只用于联调跑通流程，上线前按下述顺序清理：

```bash
# ① 备份（任何删除前先做，且已验证可恢复）
sudo sqlite3 /opt/bafangju/data/bafangju.db ".backup '/opt/bafangju/backups/before-purge-demo.db'"

# ② 先看清要删谁（把 name 打出来人工确认一遍）
sudo sqlite3 /opt/bafangju/data/bafangju.db \
  "select id, json_extract(data,'\$.name') from merchants \
   where json_extract(data,'\$.seedTag')='nearby_demo' \
      or json_extract(data,'\$.createdBy')='seed' \
      or id='m_demo';"

# ③ 先删商品、再删商家（顺序不能反，否则商品变孤儿）
sudo sqlite3 /opt/bafangju/data/bafangju.db \
  "delete from products where merchantId in (
     select id from merchants where json_extract(data,'\$.seedTag')='nearby_demo'
        or json_extract(data,'\$.createdBy')='seed' or id='m_demo');"
sudo sqlite3 /opt/bafangju/data/bafangju.db \
  "delete from merchants where json_extract(data,'\$.seedTag')='nearby_demo'
      or json_extract(data,'\$.createdBy')='seed' or id='m_demo';"

# ④ 复核
sudo sqlite3 /opt/bafangju/data/bafangju.db "select count(*) from merchants; select count(*) from products;"
```

- 类目（12 个）**建议保留**，按实际业务改 `r` 值即可；要彻底重来就 `delete from categories` 后重新录入。
- `sqlite3` 交互式里 `$.name` 直接写；写在 shell 双引号里要转义成 `\$.name`。
- 清理后重启服务让内存态刷新：`sudo pm2 restart bafangju-server --update-env`。
- 已有订单/分账数据不要直接删表，按 §5.4 B 类回滚到干净备份更安全。


---

## 8. 小程序端发布

两个端都要改回生产域名（仓库当前是备案期的 IP，**发布前必须手动改回**，否则带 IP 提审会被微信拒绝）：

| 项目 | 文件 | 值 |
| ---- | ---- | ---- |
| 用户端 | `bafangju-miniprogram-user/config.js` | `BASE_URL: 'https://bfjzs.com'` |
| 商家端 | `bafangju-miniprogram-merchant/config.js` | `BASE_URL: 'https://bfjzs.com'` |

> `config.dev.js`（内网地址）在 `project.config.json → packOptions.ignore` 中被排除，不会进正式包；本地开发时它优先覆盖 `BASE_URL`，不影响调试。

发布流程：

1. 微信开发者工具打开项目 → 上传代码（版本号如 `1.0.0`）
2. 公众平台 → 版本管理 → 设为体验版，真机验证：
   - 登录 / 首页轮播 / 商品详情 / 下单支付
   - 商家端：登录 / 我的商品 / 上传商品 / 券核销 / 提现
   - 推广中心：我的邀请码（真实小程序码）
3. 验证通过 → 提交审核 → 审核通过后发布

### 8.1 两端 AppID 现状与拆分清单（提审前必读）

**现状**：用户端与商家端**共用同一个小程序** `wxa8811b4cc88f9857`（商家端 `project.config.json` 已改为该 AppID，服务器 `WX_MERCHANT_*` 也填了同一套值）。这样联调最省事：一个 AppID、一个 AppSecret、一套服务器配置。

**但同一个小程序 AppID 只能承载一个代码包**，共用只适合开发联调：

| 场景 | 共用同一 AppID | 后果 |
| ---- | ---- | ---- |
| 开发者工具打开两个项目 | 可以 | 无影响 |
| 真机调试 / 预览 | 可以 | 无影响 |
| **上传代码** | 不可以 | 两个包传到同一个小程序，**互相覆盖** |
| 设体验版 / 提审 / 发布 | 不可以 | 只能存在一个版本的体验版与正式版 |
| 类目、隐私指引、服务器域名 | 不可以 | 只有一份，无法同时覆盖用户端与商家端 |

也就是说：**商家端提审前必须先注册第二个小程序，否则商家端没有独立可发布的包。**

**拆分清单**（按顺序，改完只需重跑 `deploy.sh` + 重新上传商家端）：

1. 注册商家端小程序，拿到它的 AppID 与 AppSecret
2. 改 `bafangju-miniprogram-merchant/project.config.json` 的 `appid` 为新 AppID
3. 改服务器 `/etc/bafangju.env`：
   ```bash
   WX_MERCHANT_APPID=<商家端新 AppID>
   WX_MERCHANT_SECRET=<商家端新 AppSecret>
   ```
   然后 `sudo bash /opt/bafangju/scripts/deploy.sh`（脚本会重建进程，确保 env 生效）
4. 商家端 mp 后台单独配：服务器域名（`request`/`uploadFile`/`downloadFile` 均填 `https://bfjzs.com`）、服务类目与资质、用户隐私保护指引
5. 两个包分别上传 → 分别设体验版 → 分别提审 → 分别发布
6. 数据库无需改动：商家、商品、订单都以服务端记录为准，小程序端只是壳

> 拆分时**不需要改后端代码**：`wxmp.getMerchantConfig()` 已按 `WX_MERCHANT_*` 独立取值，用户端仍用 `WX_APPID/WX_SECRET`。
> 共用期红线：**不要把商家端项目上传到正式小程序**（会覆盖用户端正式版），联调只用「真机调试 / 预览」。

---

## 9. 日常运维命令

| 需求 | 命令 |
| ---- | ---- |
| 服务状态 | `pm2 status` |
| 实时日志 | `pm2 logs bafangju-server --lines 100` |
| 重启服务 | `pm2 restart bafangju-server` |
| 资源监控 | `pm2 monit` / `htop` |
| 健康检查 | `curl -s http://127.0.0.1:3000/api/health` |
| nginx 配置校验 | `sudo nginx -t` |
| nginx 重载 | `sudo systemctl reload nginx` |
| 查看备份 | `ls -lh /opt/bafangju/backups` |
| 查看数据占用 | `du -sh /opt/bafangju/data/*` |

**查看数据库**：把 `/opt/bafangju/data/bafangju.db` 下载到本地，用 **DB Browser for SQLite**（免费）打开；服务器上也可用 `sqlite3 /opt/bafangju/data/bafangju.db`。

---

## 10. 备份与恢复

**自动备份**：`/etc/cron.d/bafangju-backup`，每 6 小时执行 `sqlite3 .backup`，输出到 `/opt/bafangju/backups/bfj-YYYYMMDD-HH.db`。

**手动备份**（含上传文件）：

```bash
sudo sqlite3 /opt/bafangju/data/bafangju.db ".backup '/opt/bafangju/backups/manual-$(date +%F).db'"
sudo tar czf /opt/bafangju/backups/uploads-$(date +%F).tar.gz -C /opt/bafangju/data uploads uploads-private
```

**恢复**：

```bash
sudo pm2 stop bafangju-server
sudo cp /opt/bafangju/backups/bfj-20261101-06.db /opt/bafangju/data/bafangju.db
sudo pm2 start bafangju-server
```

**异地备份建议**：定期把 `/opt/bafangju/backups` 同步到本地或其他云存储（`scp -r root@IP:/opt/bafangju/backups ./`）。

---

## 11. 故障排查

| 现象 | 排查 |
| ---- | ---- |
| 部署脚本报 `ADMIN_PASSWORD` 不达标 | 改 `/etc/bafangju.env`，≥12 位含大小写+数字 |
| 服务起不来 | `pm2 logs bafangju-server --lines 50`，看是否 Node 版本 <22 |
| 502 Bad Gateway | `pm2 status` 看进程是否 online；`curl 127.0.0.1:3000/api/health` |
| 上传图片报 413 | nginx `client_max_body_size` 需 ≥8m（脚本已配置） |
| HTTPS 打不开 | 证书路径是否 `/etc/nginx/ssl/bfjzs.com.pem|.key`；`sudo nginx -t` |
| 小程序请求超时 | 微信后台合法域名是否配好；`config.js` 里 BASE_URL 是否 `https://bfjzs.com` |
| 小程序登录失败 | `WX_SECRET` 是否正确；公众平台 IP 白名单是否开启 |
| 小程序码不生成 | 后台「系统设置 → 小程序码配置」点「测试生成」，看返回错误 |
| 商家上传商品后用户端看不到 | 正常：需平台审核通过后才上架 |

---

## 12. 安全清单

- [ ] `ADMIN_PASSWORD` 强口令，且未写入任何文档 / 聊天记录
- [ ] `/etc/bafangju.env` 权限 `600`
- [ ] 防火墙未放行 3000；未安装宝塔等面板
- [ ] SSH 使用密钥登录，禁用密码登录（可选加固）
- [ ] `TRUST_PROXY=1` 已配置（否则上传限流按 127.0.0.1 累计）
- [ ] 定期下载备份到异地
- [ ] 微信 AppSecret 仅保存在服务器 env 或后台配置，不外传

---

## 13. 在另一台电脑重新实施（速查）

1. 从项目仓库取 `bafangju-server`（或使用 `八方聚-生产部署包.zip`）
2. `scp -r bafangju-server/* root@<IP>:/opt/bafangju/`
3. `sudo bash /opt/bafangju/scripts/deploy.sh`（第一次生成 env 后退出）
4. `sudo nano /etc/bafangju.env` 填 `DOMAIN / ADMIN_PASSWORD / WX_APPID / WX_SECRET`
5. `sudo bash /opt/bafangju/scripts/deploy.sh`（第二次完成部署）
6. 备案通过后：DNS 解析 + 证书 + 再跑一次脚本切 HTTPS
7. 微信公众平台配置 request / uploadFile 合法域名
8. 登录后台初始化类目、商品、商家、小程序码配置
9. 两个小程序改 `config.js` → 上传 → 体验版验证 → 提审发布

---

*文档生成时间：2026-11-01　|　对应代码：`bafangju-server`（测试 284/284 通过）*
