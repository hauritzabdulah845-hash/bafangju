#!/usr/bin/env bash
# ============================================================
# 八方聚 · 微信支付证书放置与权限配置脚本
#
# 作用：
#   1) 建证书目录并收紧权限（私钥 600、目录 700、属主 root）
#   2) 校验私钥/证书文件格式、成对关系，打印证书序列号
#   3) 把证书路径与回调地址写进 /etc/bafangju.env（自动备份）
#   4) 巡检系统时间同步（微信 v3 签名对时间敏感，偏差 >5 分钟会全量失败）
#
# 用法：
#   # 第一步：把商户平台下载的材料上传到服务器（任选一个目录）
#   scp apiclient_key.pem apiclient_cert.pem wechatpay_platform.pem root@<IP>:/root/wxpay/
#
#   # 第二步：root 执行本脚本
#   sudo bash /opt/bafangju/scripts/setup-wxpay-certs.sh --src /root/wxpay
#
#   # 只检查、不改任何文件：
#   sudo bash /opt/bafangju/scripts/setup-wxpay-certs.sh --check
#
# 需要的文件：
#   apiclient_key.pem        必填  商户 API 私钥（申请 API 证书时下载，只此一次）
#   apiclient_cert.pem       建议  商户 API 证书（用于校验私钥成对、打印序列号）
#   wechatpay_platform.pem   必填  平台证书；新商户也可能是「微信支付公钥」wechatpay_pub.pem
# ============================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/bafangju}"
ENV_FILE="${ENV_FILE:-/etc/bafangju.env}"
CERT_DIR="${CERT_DIR:-$APP_DIR/certs}"
SRC_DIR=""
CHECK_ONLY=0

log()  { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[注意] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[失败] %s\033[0m\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --src)   SRC_DIR="${2:-}"; shift 2 ;;
    --cert-dir) CERT_DIR="${2:-}"; shift 2 ;;
    --env)   ENV_FILE="${2:-}"; shift 2 ;;
    --check) CHECK_ONLY=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) die "未知参数：$1（可用 --src / --cert-dir / --env / --check）" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "请用 root 执行：sudo bash $0"
command -v openssl >/dev/null 2>&1 || die "缺少 openssl，请先 apt-get install -y openssl"

KEY="$CERT_DIR/apiclient_key.pem"
CERT="$CERT_DIR/apiclient_cert.pem"
PLATFORM="$CERT_DIR/wechatpay_platform.pem"
PUBKEY="$CERT_DIR/wechatpay_pub.pem"

# ---------- 1. 放置文件 ----------
if [ -n "$SRC_DIR" ]; then
  [ -d "$SRC_DIR" ] || die "源目录不存在：$SRC_DIR"
  log "放置证书：$SRC_DIR → $CERT_DIR"
  mkdir -p "$CERT_DIR"
  for f in apiclient_key.pem apiclient_cert.pem wechatpay_platform.pem wechatpay_pub.pem; do
    if [ -f "$SRC_DIR/$f" ]; then
      install -m 600 -o root -g root "$SRC_DIR/$f" "$CERT_DIR/$f"
      echo "  已放置 $f"
    fi
  done
else
  mkdir -p "$CERT_DIR"
fi

# ---------- 2. 校验文件 ----------
log "校验证书文件"
[ -f "$KEY" ] || die "缺少商户私钥 $KEY（从腾讯云/商户平台下载 apiclient_key.pem 后重试）"

# 私钥必须是 PEM 且不带口令（Node 读取时不提供 passphrase）
if ! openssl rsa -in "$KEY" -noout -check >/dev/null 2>&1; then
  die "私钥无法解析：$KEY（确认是 PEM 格式、未加密；若带口令需先 openssl rsa -in ... -out ... 去口令）"
fi

KEY_MOD="$(openssl rsa -in "$KEY" -noout -modulus 2>/dev/null | openssl sha256)"
if [ -f "$CERT" ]; then
  CERT_MOD="$(openssl x509 -in "$CERT" -noout -modulus 2>/dev/null | openssl sha256)"
  [ "$KEY_MOD" = "$CERT_MOD" ] || die "私钥与商户证书不匹配（apiclient_key.pem 与 apiclient_cert.pem 不是同一对）"
  MCH_SERIAL="$(openssl x509 -in "$CERT" -noout -serial | cut -d= -f2 | tr '[:lower:]' '[:upper:]')"
  echo "  商户证书序列号：$MCH_SERIAL"
else
  warn "未提供 apiclient_cert.pem，跳过私钥成对校验（上线前建议补上）"
  MCH_SERIAL=""
fi

# 平台证书 或 微信支付公钥，二选一
PLATFORM_SERIAL=""
if [ -f "$PLATFORM" ]; then
  openssl x509 -in "$PLATFORM" -noout -subject >/dev/null 2>&1 || die "平台证书无法解析：$PLATFORM"
  PLATFORM_SERIAL="$(openssl x509 -in "$PLATFORM" -noout -serial | cut -d= -f2 | tr '[:lower:]' '[:upper:]')"
  echo "  平台证书序列号：$PLATFORM_SERIAL"
  PLATFORM_PATH="$PLATFORM"
elif [ -f "$PUBKEY" ]; then
  openssl pkey -pubin -in "$PUBKEY" -noout >/dev/null 2>&1 || die "微信支付公钥无法解析：$PUBKEY"
  echo "  已使用「微信支付公钥」模式（无平台证书序列号）"
  warn "公钥模式需要在商户平台 API 安全页抄下「公钥ID」，填到 $ENV_FILE 的 WX_PLATFORM_SERIAL"
  PLATFORM_PATH="$PUBKEY"
else
  die "缺少平台证书 $PLATFORM 或微信支付公钥 $PUBKEY（商户平台 → API 安全 下载）"
fi

# ---------- 3. 权限 ----------
if [ "$CHECK_ONLY" -eq 0 ]; then
  log "收紧权限（目录 700 / 私钥 600 / 其余 640 / 属主 root）"
  chown root:root "$CERT_DIR"
  chmod 700 "$CERT_DIR"
  chown root:root "$KEY"; chmod 600 "$KEY"
  for f in "$CERT" "$PLATFORM" "$PUBKEY"; do
    if [ -f "$f" ]; then chown root:root "$f"; chmod 640 "$f"; fi
  done
  echo "  完成：$(ls -l "$CERT_DIR" | tail -n +2 | awk '{print $1, $3":"$4, $NF}' | tr '\n' ' ')"
else
  warn "--check 模式：不修改任何文件权限"
fi

# ---------- 4. 写入环境变量 ----------
upsert_env() {
  local k="$1" v_esc
  # 转义 sed 分隔符与 &，避免 URL 里的字符被当成替换指令
  v_esc="$(printf '%s' "$2" | sed 's/[&|]/\\&/g')"
  if grep -qE "^${k}=" "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^${k}=.*|${k}=${v_esc}|" "$ENV_FILE"
  else
    sed -i -E "/^#\s*${k}=/d" "$ENV_FILE" 2>/dev/null || true
    printf '%s=%s\n' "$k" "$2" >> "$ENV_FILE"
  fi
}

if [ "$CHECK_ONLY" -eq 0 ]; then
  if [ ! -f "$ENV_FILE" ]; then
    warn "$ENV_FILE 不存在，先生成空文件；其余业务变量请参照 deploy.env.example 补齐"
    touch "$ENV_FILE"
  fi
  cp "$ENV_FILE" "$ENV_FILE.bak.$(date +%Y%m%d%H%M%S)"
  chmod 600 "$ENV_FILE"

  log "写入 $ENV_FILE（已自动备份）"
  upsert_env WX_PRIVATE_KEY "$KEY"
  upsert_env WX_PLATFORM_CERT "$PLATFORM_PATH"
  if [ -n "$MCH_SERIAL" ]; then upsert_env WX_MERCHANT_SERIAL "$MCH_SERIAL"; fi
  # 公钥模式：序列号需人工填公钥ID，这里只在平台证书模式下自动写
  if [ -n "$PLATFORM_SERIAL" ]; then
    upsert_env WX_PLATFORM_SERIAL "$PLATFORM_SERIAL"
  fi

  # 回调地址：已配置则保留，未配置按 DOMAIN 推导
  # shellcheck disable=SC1090
  DOMAIN_NOW="$(grep -E '^DOMAIN=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
  [ -n "${DOMAIN_NOW:-}" ] || DOMAIN_NOW="bfjzs.com"
  if ! grep -qE '^WX_NOTIFY_URL=https://' "$ENV_FILE" 2>/dev/null; then
    upsert_env WX_NOTIFY_URL "https://${DOMAIN_NOW}/api/payment/notify-wx"
    upsert_env WX_REFUND_NOTIFY_URL "https://${DOMAIN_NOW}/api/payment/refund-notify"
  fi

  echo "  WX_PRIVATE_KEY=$KEY"
  echo "  WX_PLATFORM_CERT=$PLATFORM_PATH"
  if [ -n "$MCH_SERIAL" ]; then echo "  WX_MERCHANT_SERIAL=$MCH_SERIAL"; fi
  if [ -n "$PLATFORM_SERIAL" ]; then echo "  WX_PLATFORM_SERIAL=$PLATFORM_SERIAL"; fi
  grep -E '^WX_NOTIFY_URL=|^WX_REFUND_NOTIFY_URL=' "$ENV_FILE" | sed 's/^/  /' || true
fi

# ---------- 5. 时间同步巡检 ----------
log "检查系统时间（微信签名要求偏差 ≤5 分钟）"
if command -v timedatectl >/dev/null 2>&1; then
  timedatectl 2>/dev/null | grep -iE 'System clock synchronized|NTP service' | sed 's/^/  /' || true
  if timedatectl 2>/dev/null | grep -qi 'System clock synchronized: no'; then
    warn "系统时间未同步。请执行：timedatectl set-ntp true（否则下单与回调验签都会失败）"
  fi
else
  warn "未安装 timedatectl，请确认已启用 NTP（chrony / systemd-timesyncd）"
fi

# ---------- 6. 结果 ----------
log "完成"
cat <<EOF
  证书目录 : $CERT_DIR
  环境文件 : $ENV_FILE（600，仅 root 可读）

  还需人工完成：
  1) 确认 $ENV_FILE 中已配置 WX_MCHID / WX_APPID / WX_APIV3_KEY（APIv3 密钥必须 32 位）
  2) 小程序后台 → 开发设置 → 服务器域名：request 合法域名填 https://\${DOMAIN}
  3) 商户平台 → 产品中心 → 开发配置 → 支付回调域名：填 \${DOMAIN}
  4) 重启服务：pm2 delete all && pm2 start ecosystem.config.js && pm2 save
  5) 自检：curl -s https://\${DOMAIN}/api/payment/config | head -c 300
     期望 "mode":"live" 且 "liveReady":true

  安全提醒：
  - 私钥一旦泄露立即到商户平台「API 安全」作废并重新申请
  - 不要把 certs/ 目录提交到 git，也不要放到 Web 可访问目录
EOF
