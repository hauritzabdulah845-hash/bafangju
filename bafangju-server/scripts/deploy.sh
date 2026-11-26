#!/usr/bin/env bash
# 八方聚共享平台 · 一键部署脚本（腾讯云轻量 / Ubuntu 22.04+）
#
# 用法：
#   1) 本地上传代码：scp -r bafangju-server/* root@<服务器IP>:/opt/bafangju/
#   2) 服务器执行：sudo bash /opt/bafangju/scripts/deploy.sh
#
# 首次执行会生成 /etc/bafangju.env 并退出，编辑其中的 ADMIN_PASSWORD、WX_SECRET 后重跑即可。
# 之后每次更新代码，重新上传并执行本脚本 = 自动同步 + 重装依赖 + 平滑重载。
#
# 证书就位后（/etc/nginx/ssl/<域名>.pem 与 .key），再执行一次本脚本会自动切换为 HTTPS。

set -euo pipefail

APP_DIR=/opt/bafangju
ENV_FILE=/etc/bafangju.env
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log()  { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[注意] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[失败] %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请用 root 执行：sudo bash scripts/deploy.sh"

# ---------- 1. 环境变量 ----------
if [ ! -f "$ENV_FILE" ]; then
  cp "$SRC_DIR/scripts/deploy.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  die "已生成 $ENV_FILE，请编辑其中的 ADMIN_PASSWORD、WX_SECRET 后重跑本脚本"
fi

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

DOMAIN="${DOMAIN:-bfjzs.com}"
DB_PATH="${BAFANGJU_DB_PATH:-$APP_DIR/data/bafangju.db}"
DB_DIR="$(dirname "$DB_PATH")"
UPLOAD_DIR="${BAFANGJU_UPLOAD_DIR:-$APP_DIR/data/uploads}"
UPLOAD_PRIVATE_DIR="${BAFANGJU_UPLOAD_PRIVATE_DIR:-$APP_DIR/data/uploads-private}"

PW="${ADMIN_PASSWORD:-}"
if [ "${#PW}" -le 10 ] || [[ ! "$PW" =~ [A-Za-z] ]] || [[ ! "$PW" =~ [0-9] ]]; then
  die "ADMIN_PASSWORD 不满足策略（长度大于 10 位且同时含字母、数字），服务会拒绝启动。请修改 $ENV_FILE"
fi
[ -n "${WX_SECRET:-}" ] || warn "WX_SECRET 为空，小程序登录将失败（可稍后补填并重跑）"

# ---------- 2. 系统依赖 ----------
log "安装系统依赖（nginx / sqlite3 / rsync / curl）"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates rsync sqlite3 nginx >/dev/null

log "检查 Node.js 版本（要求 ≥22）"
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$MAJOR" -ge 22 ]; then NEED_NODE=0; fi
fi
if [ "$NEED_NODE" -eq 1 ]; then
  # 优先用发行版自带包（Ubuntu 24.04+ 提供 Node 22），避免 NodeSource 对过新发行版不支持
  if apt-cache show nodejs 2>/dev/null | grep -qE '^Version: (2[2-9]|[3-9][0-9])\.'; then
    log "使用发行版 Node 包"
    apt-get install -y nodejs npm || apt-get install -y nodejs
  else
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  fi
fi
node -v
node -e "require('node:sqlite')" >/dev/null 2>&1 || die "当前 Node 不支持 node:sqlite（需 22.13+），请升级"

command -v pm2 >/dev/null 2>&1 || npm i -g pm2

# ---------- 3. 同步代码（保留数据目录） ----------
if [ "$SRC_DIR" != "$APP_DIR" ]; then
  log "同步代码：$SRC_DIR → $APP_DIR"
  mkdir -p "$APP_DIR"
  rsync -a --delete \
    --exclude 'data' --exclude 'backups' --exclude 'logs' \
    --exclude 'node_modules' --exclude '.git' \
    "$SRC_DIR"/ "$APP_DIR"/
else
  log "代码已在 $APP_DIR，跳过同步"
fi

log "安装运行依赖"
cd "$APP_DIR"
npm ci --omit=dev

mkdir -p "$DB_DIR" "$UPLOAD_DIR" "$UPLOAD_PRIVATE_DIR" "$APP_DIR/backups" "$APP_DIR/logs"
chmod 700 "$UPLOAD_PRIVATE_DIR"

# ---------- 4. 启动服务 ----------
log "启动 PM2 服务"
# 先 delete 再 start：pm2 的 --update-env 不会覆盖进程已存在的旧键，
# 会导致改了 $ENV_FILE 后进程里仍是旧值（如 ADMIN_PASSWORD / WX_SECRET 为空）
pm2 delete all >/dev/null 2>&1 || true
pm2 start ecosystem.config.js
pm2 save >/dev/null
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || warn "开机自启配置失败，可手动执行 pm2 startup"

# ---------- 5. nginx 反向代理 ----------
log "配置 nginx（域名 $DOMAIN）"
SSL_CERT="/etc/nginx/ssl/${DOMAIN}.pem"
SSL_KEY="/etc/nginx/ssl/${DOMAIN}.key"
mkdir -p /etc/nginx/ssl

# 移除发行版默认站点：否则用 IP 访问时会命中默认 server（返回欢迎页而非后端）
rm -f /etc/nginx/sites-enabled/default

if [ -f "$SSL_CERT" ] && [ -f "$SSL_KEY" ]; then
  cat > /etc/nginx/conf.d/bafangju.conf <<'NGINX'
server {
    listen 80;
    server_name __DOMAIN__;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name __DOMAIN__;
    ssl_certificate     /etc/nginx/ssl/__DOMAIN__.pem;
    ssl_certificate_key /etc/nginx/ssl/__DOMAIN__.key;
    ssl_protocols TLSv1.2 TLSv1.3;

    client_max_body_size 40m;

    # 压缩：后台首屏 60KB HTML + 20 个 JS/CSS，不压缩在建站/移动网络下明显拖慢
    gzip on;
    gzip_comp_level 5;
    gzip_min_length 1024;
    gzip_vary on;
    gzip_proxied any;
    gzip_types text/plain text/css application/javascript application/json image/svg+xml application/xml;

    # __PAY_NOTIFY_BLOCK__
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
NGINX
  MODE="HTTPS"
else
  cat > /etc/nginx/conf.d/bafangju.conf <<'NGINX'
server {
    listen 80 default_server;
    server_name __DOMAIN__;

    client_max_body_size 40m;

    # 压缩：后台首屏 60KB HTML + 20 个 JS/CSS，不压缩在建站/移动网络下明显拖慢
    gzip on;
    gzip_comp_level 5;
    gzip_min_length 1024;
    gzip_vary on;
    gzip_proxied any;
    gzip_types text/plain text/css application/javascript application/json image/svg+xml application/xml;

    # __PAY_NOTIFY_BLOCK__
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
NGINX
  MODE="HTTP（未找到证书，IP 可直接访问）"
fi
sed -i "s/__DOMAIN__/${DOMAIN}/g" /etc/nginx/conf.d/bafangju.conf

# 非生产环境（联调）时屏蔽支付回调：mock 通道下该接口可把订单刷成已支付，公网不应可达
if [ "${NODE_ENV:-production}" != "production" ]; then
  sed -i 's|# __PAY_NOTIFY_BLOCK__|location = /api/payment/notify { return 403; }|' /etc/nginx/conf.d/bafangju.conf
else
  sed -i '/# __PAY_NOTIFY_BLOCK__/d' /etc/nginx/conf.d/bafangju.conf
fi

nginx -t >/dev/null
systemctl enable nginx >/dev/null 2>&1 || true
systemctl reload nginx 2>/dev/null || systemctl restart nginx

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then
  ufw allow 80/tcp >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
fi

# ---------- 6. 每 6 小时热备 ----------
log "写入 SQLite 定时备份"
cat > /etc/cron.d/bafangju-backup <<'CRON'
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin
0 */6 * * * root sqlite3 __DB__ ".backup '__DIR__/backups/bfj-$(date +\%Y\%m\%d-\%H).db'"
CRON
sed -i "s#__DB__#${DB_PATH}#g; s#__DIR__#${APP_DIR}#g" /etc/cron.d/bafangju-backup
chmod 644 /etc/cron.d/bafangju-backup

# ---------- 6.5 日志轮转（PM2 日志不轮转会撑爆磁盘） ----------
log "配置日志轮转（每日，保留 14 份，压缩）"
cat > /etc/logrotate.d/bafangju <<'LOGROTATE'
__APP_DIR__/logs/*.log {
  daily
  rotate 14
  missingok
  notifempty
  compress
  delaycompress
  copytruncate
}
LOGROTATE
sed -i "s#__APP_DIR__#${APP_DIR}#g" /etc/logrotate.d/bafangju
chmod 644 /etc/logrotate.d/bafangju

# ---------- 7. 健康检查 ----------
log "健康检查"
OK=0
for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:3000/api/health" >/dev/null 2>&1; then OK=1; break; fi
  sleep 1
done
[ "$OK" -eq 1 ] || die "健康检查失败。排查：pm2 logs bafangju-server --lines 50"

# 公网 IP：优先环境变量 PUBLIC_IP（可在 /etc/bafangju.env 中显式写死），否则自动探测
IP="${PUBLIC_IP:-}"
if [ -z "$IP" ]; then IP="$(curl -s --max-time 5 https://api.ipify.org 2>/dev/null || true)"; fi
if [ -z "$IP" ]; then IP="$(hostname -I 2>/dev/null | awk '{print $1}')"; fi
cat <<EOF

============================================================
 部署完成（nginx 模式：$MODE）
------------------------------------------------------------
 本机自检   : http://127.0.0.1:3000/api/health   OK
 服务器 IP  : http://${IP}/admin.html（备案前先用这个访问，走 nginx 80 端口）
 域名访问   : $([ "$MODE" = "HTTPS" ] && echo "https://${DOMAIN}/admin.html" || echo "备案 + 证书就位后访问 https://${DOMAIN}/admin.html")
 备份目录   : ${APP_DIR}/backups（每 6 小时自动）
 服务日志   : pm2 logs bafangju-server --lines 50

 还需人工完成：
 1) 腾讯云轻量控制台「防火墙」：备案前只需放行 22 / 80；443 等备案通过后再加；3000 不要开放
 2) 备案通过后：DNS 解析 ${DOMAIN} → 本机公网 IP
 3) SSL 证书放到 /etc/nginx/ssl/${DOMAIN}.pem 与 .key，再执行一次本脚本即自动切 HTTPS
 4) 微信公众平台 → 服务器域名：request 与 uploadFile 均填 https://${DOMAIN}
 5) 管理后台首登后确认类目 / 商品 / 商家 / 小程序码配置
============================================================
EOF
