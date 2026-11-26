#!/usr/bin/env bash
# ============================================================
# 八方聚 · 从 GitHub 拉取并热更新（方式二：手动确认式部署）
#
# 特点：只更新「代码」，不碰线上数据与反向代理配置
#   - 数据库 / 上传文件：/opt/bafangju/data        （整目录不动）
#   - 定时备份          ：/opt/bafangju/backups     （整目录不动）
#   - 支付证书          ：/opt/bafangju/certs        （整目录不动）
#   - nginx / SSL 证书  ：完全不写（改系统级配置请用 deploy.sh）
#
# 用法（在服务器上，一行）：
#   cd /opt/bafangju-repo && sudo bash bafangju-server/scripts/pull-deploy.sh
#
# 首次使用前需要：
#   1) git clone https://github.com/hauritzabdulah845-hash/bafangju.git /opt/bafangju-repo
#   2) 已用 bafangju-server/scripts/deploy.sh 完成过一次部署
#      （即 /etc/bafangju.env、PM2、nginx 都已就位）
#
# 可用参数：
#   --branch <名称>   指定分支（默认 main）
#   --no-restart      只同步代码与依赖，不重启 PM2
#   --force           即使代码已是最新，也强制重新同步 + 重启（修环境用）
# ============================================================
set -euo pipefail

# 本脚本自己也在 git 仓库里，git pull 会覆盖脚本自身；
# 先把自身复制到 /tmp 再执行，避免「边读边被改写」导致中途出错。
if [ "${BJF_PULL_SELF:-0}" != "1" ]; then
  BJF_REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  SELF_COPY="$(mktemp "/tmp/bfj-pull-deploy.XXXXXX.sh")"
  cp "${BASH_SOURCE[0]}" "$SELF_COPY"
  BJF_PULL_SELF=1 REPO_DIR="${REPO_DIR:-$BJF_REPO_DIR}" exec bash "$SELF_COPY" "$@"
fi

APP_DIR="${APP_DIR:-/opt/bafangju}"
ENV_FILE="${ENV_FILE:-/etc/bafangju.env}"
PM2_APP="${PM2_APP:-bafangju-server}"
BRANCH="main"
DO_RESTART=1
FORCE=0

log()  { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[注意] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[失败] %s\033[0m\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --branch)     BRANCH="${2:-}"; shift 2 ;;
    --no-restart) DO_RESTART=0; shift ;;
    --force)      FORCE=1; shift ;;
    -h|--help)    sed -n '2,30p' "$0"; exit 0 ;;
    *) die "未知参数：$1（可用 --branch / --no-restart / --force / --help）" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "请用 root 执行：sudo bash $0"

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
SRC_DIR="$REPO_DIR/bafangju-server"
[ -f "$SRC_DIR/package.json" ] || die "找不到源码目录：$SRC_DIR"

[ -d "$REPO_DIR/.git" ] || die "当前目录不是 git 仓库：$REPO_DIR 请先 git clone"
[ -f "$ENV_FILE" ] || die "缺少 $ENV_FILE，说明尚未部署过。请先执行 bafangju-server/scripts/deploy.sh"

command -v rsync  >/dev/null 2>&1 || die "缺少 rsync：apt-get install -y rsync"
command -v node   >/dev/null 2>&1 || die "缺少 node，请先执行 deploy.sh 安装环境"
command -v pm2    >/dev/null 2>&1 || die "缺少 pm2：npm i -g pm2"

# ---------- 1. 备份数据库（一次性，失败即中止，绝不带病上线） ----------
log "备份当前数据库到 $APP_DIR/backups"
mkdir -p "$APP_DIR/backups"
if [ -f "$APP_DIR/data/bafangju.db" ]; then
  STAMP="$(date +%Y%m%d-%H%M%S)"
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$APP_DIR/data/bafangju.db" ".backup '$APP_DIR/backups/pull-$STAMP.db'" \
      || die "数据库备份失败，已中止（未改动任何文件）"
  else
    cp -a "$APP_DIR/data/bafangju.db" "$APP_DIR/backups/pull-$STAMP.db"
  fi
  log "已备份：backups/pull-$STAMP.db"
else
  warn "数据库尚不存在（$APP_DIR/data/bafangju.db），跳过备份"
fi

# ---------- 2. 拉取代码 ----------
log "拉取 GitHub 最新代码（分支：$BRANCH）"
cd "$REPO_DIR"
OLD="$(git rev-parse --short HEAD)"
# 服务器上不会有本地改动；若有（手工改过代码）直接报错保护，不静默覆盖
git diff --quiet && git diff --cached --quiet || die "仓库有未提交的本地改动，请先 git stash 或 git checkout -- . 再重试"
git fetch --prune origin "$BRANCH"
git checkout -q "$BRANCH" 2>/dev/null || git checkout -q -b "$BRANCH" --track "origin/$BRANCH"
git merge --ff-only "origin/$BRANCH"
NEW="$(git rev-parse --short HEAD)"
if [ "$OLD" = "$NEW" ] && [ -f "$APP_DIR/src/server.js" ] && [ "$FORCE" -eq 0 ]; then
  log "已是最新（$NEW），无需更新"
  [ "$DO_RESTART" -eq 1 ] || { log "按 --no-restart 要求，不重启服务"; exit 0; }
  log "如需强制重启：pm2 restart $PM2_APP"
  exit 0
fi
if [ "$OLD" = "$NEW" ]; then
  log "代码已是最新（$NEW），但运行目录缺失或需强制同步，继续执行同步"
else
  log "代码：$OLD → $NEW"
fi

# ---------- 3. 同步到运行目录（保留 data / backups / logs / certs / node_modules） ----------
log "同步代码：$SRC_DIR → $APP_DIR"
mkdir -p "$APP_DIR"
rsync -a --delete \
  --exclude 'data' --exclude 'backups' --exclude 'logs' --exclude 'certs' \
  --exclude 'node_modules' --exclude '.git' --exclude '.env' --exclude '.env.local' \
  "$SRC_DIR"/ "$APP_DIR"/

log "安装运行依赖（npm ci --omit=dev）"
cd "$APP_DIR"
npm ci --omit=dev

mkdir -p "$APP_DIR/backups" "$APP_DIR/logs"

# ---------- 4. 重启服务（必须带上 /etc/bafangju.env 里的变量） ----------
if [ "$DO_RESTART" -eq 0 ]; then
  log "已按 --no-restart 跳过重启；代码与依赖已更新，重启后生效"
  exit 0
fi

log "重启 PM2 服务（注入 $ENV_FILE）"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
# 与 deploy.sh 保持一致：先 delete 再 start，确保改过的 env 一定进到新进程
pm2 delete all >/dev/null 2>&1 || true
pm2 start ecosystem.config.js
pm2 save >/dev/null

# ---------- 5. 健康检查 ----------
log "健康检查 http://127.0.0.1:3000/api/health"
OK=0
for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:3000/api/health" >/dev/null 2>&1; then OK=1; break; fi
  sleep 1
done
if [ "$OK" -ne 1 ]; then
  printf '\n'
  warn "健康检查失败，最近日志："
  pm2 logs "$PM2_APP" --lines 40 --nostream || true
  die "更新后服务未起来。回滚代码：cd $REPO_DIR && git reset --hard $OLD && sudo bash bafangju-server/scripts/pull-deploy.sh"
fi

cat <<EOF

============================================================
 热更新完成（未改动 nginx / SSL / 数据库文件）
------------------------------------------------------------
 代码版本   : $NEW（$BRANCH）
 本机自检   : http://127.0.0.1:3000/api/health   OK
 数据库     : $APP_DIR/data/bafangju.db（本次已先备份到 backups/）
 服务日志   : pm2 logs $PM2_APP --lines 50
 回滚方式   : cd $REPO_DIR && git reset --hard $OLD && sudo bash bafangju-server/scripts/pull-deploy.sh
============================================================
EOF
