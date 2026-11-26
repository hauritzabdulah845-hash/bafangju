#!/bin/bash
# 此脚本在服务器上以 root 执行（由本地 paramiko 通过 sudo -S 调起）
set -e
APP=/opt/bafangju
PKG=/home/ubuntu/bfj-deploy.tar.gz
STAMP=$(date +%Y%m%d_%H%M%S)
BK=/root/bfj-backup-$STAMP

echo "==> 1. 备份将被覆盖的13个文件到 $BK"
cd "$APP"
for f in public/admin.html public/css/admin-base.css public/css/merchant.css public/js/admin-adreward.js public/js/admin-audit.js public/js/admin-core.js public/js/admin-queue.js public/js/filing-badge.js public/js/merchant-pages.js public/merchant.html public/site/index.html src/domain/content.js src/routes/public.js; do
  if [ -f "$f" ]; then
    mkdir -p "$BK/$(dirname "$f")"
    cp -a "$f" "$BK/$f"
  else
    echo "    (跳过备份: $f 原本不存在)"
  fi
done
echo "    备份完成"

echo "==> 2. 解压更新13个文件"
tar -xzf "$PKG" -C "$APP"
echo "    已更新"

echo "==> 3. 写入ICP备案号"
DBPATH=$(bash -c '. /etc/bafangju.env 2>/dev/null; echo ${BAFANGJU_DB_PATH:-/opt/bafangju/data/bafangju.db}')
echo "    数据库: $DBPATH"
node -e "const {createStore}=require('./src/store');const c=require('./src/domain/content');const db=createStore({sqlitePath:'$DBPATH'});c.setContent(db,{key:'filing.icpNo',body:'湘ICP备2026055116号',operator:'deploy'});console.log('    结果:',JSON.stringify(c.filingInfo(db)));"

echo "==> 4. 重启服务"
pm2 restart bafangju-server >/dev/null 2>&1 || (pm2 delete bafangju-server >/dev/null 2>&1; cd "$APP" && pm2 start ecosystem.config.js)
sleep 3

echo "==> 5. 验证"
curl -s -m 10 https://bfjzs.com/api/filing
echo ""
echo "============================================================"
echo "部署完成。回滚命令: cd $APP && cp -a $BK/. $APP/ && pm2 restart bafangju-server"
echo "============================================================"
