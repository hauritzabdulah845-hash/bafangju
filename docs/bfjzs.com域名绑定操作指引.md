# bfjzs.com 域名绑定操作指引（备案通过后）

> 适用：腾讯云轻量服务器 `124.221.130.18`，Ubuntu，nginx 反代 `127.0.0.1:3000`。
> ICP 备案号 `湘ICP备2026055116号` 已通过并已填入系统配置。
> 目标：让用户能通过 `https://bfjzs.com` 访问，并把小程序切到域名。
> 分工：**DNS + 证书在腾讯云控制台由你操作**（AI 无云账号/SSH 权限）；域名 HTTPS 实测通后，由 AI 切换小程序 BASE_URL。

## 现状（2026-11-17 实测）

| 项 | 状态 |
| --- | --- |
| 服务器 80 端口 | ✅ 通（`http://124.221.130.18` 返回 200） |
| 服务器 443 端口 | ❌ 未开 |
| `bfjzs.com` DNS | ❌ 无 A 记录（未解析） |
| SSL 证书 | ❌ 未申请 |
| nginx / 部署脚本 | ✅ 已就绪（检测到证书自动切 HTTPS） |

---

## 第 1 步 · DNS 解析（腾讯云控制台）

1. 登录腾讯云控制台 → **域名** → 找到 `bfjzs.com`（或 **DNSPod 控制台**）
2. 进入 **DNS 解析** → **解析记录** → **添加记录**
3. 添加两条：

| 主机记录 | 记录类型 | 记录值 | 说明 |
| --- | --- | --- | --- |
| `@` | A | `124.221.130.18` | 主域名 `bfjzs.com` |
| `www` | A | `124.221.130.18` | `www.bfjzs.com`（可选但建议加） |

4. TTL 默认（600 秒）即可，保存。

**生效校验**（解析生效可能需几分钟到几小时）：
```bash
nslookup bfjzs.com
# 或
dig bfjzs.com +short     # 期望输出 124.221.130.18
```

---

## 第 2 步 · 申请 SSL 证书（腾讯云控制台）

1. 腾讯云控制台 → **SSL 证书** → **申请免费证书**（TrustAsia DV，免费额度）
2. 域名填 `bfjzs.com`；如需覆盖 www，填 `bfjzs.com` 和 `www.bfjzs.com`
3. **验证方式选「DNS 验证自动验证」**（前提：第 1 步 A 记录已生效；DNS 验证不要求站点可访问）
4. 等待签发（通常几分钟到几小时）
5. 签发后 → **下载** → 选 **Nginx** 格式 → 得到压缩包，内含：
   - `bfjzs.com.pem`（证书链）
   - `bfjzs.com.key`（私钥）

> 备选：若不想用腾讯云免费证书，可用 Let's Encrypt + certbot（DNS 验证插件），但腾讯云证书控制台集成更省事。

---

## 第 3 步 · 上传证书到服务器

> 这一步需要 SSH 登录服务器（你应有 root 密码或密钥）。

1. 把第 2 步下载的两个文件上传到服务器：
```bash
# 本地执行（把路径换成你实际下载的位置）
scp bfjzs.com.pem root@124.221.130.18:/etc/nginx/ssl/bfjzs.com.pem
scp bfjzs.com.key root@124.221.130.18:/etc/nginx/ssl/bfjzs.com.key
```
若 `/etc/nginx/ssl/` 不存在，先建：
```bash
ssh root@124.221.130.18 "mkdir -p /etc/nginx/ssl"
```

2. **切换前先备份现网配置**（回滚用）：
```bash
ssh root@124.221.130.18 "sudo cp /etc/nginx/conf.d/bafangju.conf /root/nginx-bafangju.conf.http.bak; sudo cp /etc/bafangju.env /root/bafangju.env.http.bak"
```

3. **确认腾讯云防火墙放行 443**：
   控制台 → 轻量应用服务器 → 实例 → **防火墙** → 添加规则：TCP `443`，来源 `0.0.0.0/0`。
   （80 已放行；443 必须手动加，否则证书就位也连不上）

---

## 第 4 步 · 切换 HTTPS

在服务器上执行部署脚本（它检测到 `/etc/nginx/ssl/bfjzs.com.pem` 和 `.key` 后，自动生成 443 配置并把 80 跳转到 HTTPS）：
```bash
ssh root@124.221.130.18 "sudo bash /opt/bafangju/scripts/deploy.sh"
```

**校验**（在任意能联网的机器）：
```bash
curl -I https://bfjzs.com/admin.html      # 期望 200
curl -I http://bfjzs.com/api/health       # 期望 301 跳 https
curl -I https://bfjzs.com/api/health      # 期望 200
```
浏览器打开 `https://bfjzs.com/admin.html`，地址栏应为锁形、无证书告警。

---

## 第 5 步 · 小程序切到域名（AI 执行）

> 前提：第 4 步校验全部通过，`https://bfjzs.com` 稳定可访问。

1. **微信公众平台** → 开发 → 开发管理 → 开发设置 → **服务器域名**：
   - `request` 合法域名：`https://bfjzs.com`
   - `uploadFile` 合法域名：`https://bfjzs.com`
   （保存后生效；小程序端会校验，域名与证书必须匹配）
2. 通知 AI 把两个小程序的 `config.js` 中 `BASE_URL` 从 `http://124.221.130.18` 改为 `https://bfjzs.com`，重新编译上传体验版/提交审核。
   - 涉及文件：`bafangju-miniprogram-user/config.js`（用户端）、`bafangju-miniprogram-user/subpkg-merchant/config.js`（商家分包）
   - `config.dev.js` 不进包，无需改

---

## 回滚（HTTPS 出问题退回 IP 模式）

触发条件：`https://bfjzs.com` 打不开、证书链告警、小程序 `request:fail ssl hand shake error`，且 30 分钟内定位不到根因。

```bash
ssh root@124.221.130.18 "
sudo mkdir -p /root/ssl-rollback
sudo mv /etc/nginx/ssl/bfjzs.com.pem /root/ssl-rollback/
sudo mv /etc/nginx/ssl/bfjzs.com.key /root/ssl-rollback/
sudo bash /opt/bafangju/scripts/deploy.sh
curl -s -o /dev/null -w 'health=%{http_code}\n' http://124.221.130.18/api/health
"
```
脚本检测不到证书 → 自动回到 80 端口 `default_server` 模式，IP 访问恢复。域名解析可保留（不影响 IP 访问）。

---

## 检查清单（按顺序打勾）

- [ ] DNS A 记录 `@` 和 `www` 都指向 `124.221.130.18`，`dig bfjzs.com +short` 有结果
- [ ] SSL 证书已签发，下载 Nginx 格式（`.pem` + `.key`）
- [ ] 证书已上传到 `/etc/nginx/ssl/`
- [ ] 腾讯云防火墙放行 TCP 443
- [ ] 已备份现网 nginx 配置
- [ ] 重跑 deploy.sh，`curl -I https://bfjzs.com/admin.html` 返回 200
- [ ] 浏览器访问无证书告警
- [ ] 微信公众平台 request/uploadFile 域名填 `https://bfjzs.com`
- [ ] 通知 AI 切小程序 BASE_URL 并重新上传
