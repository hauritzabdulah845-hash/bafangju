#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""只读复核线上开关/安全/健康状态。用法: python _ssh_check.py <密码>"""
import sys, paramiko
HOST="124.221.130.18"; USER="ubuntu"; PORT=22
def main():
    if len(sys.argv)<2:
        print("用法: python _ssh_check.py <密码>"); sys.exit(1)
    pw=sys.argv[1]
    c=paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST,port=PORT,username=USER,password=pw,timeout=20,allow_agent=False,look_for_keys=False)
    cmd=r'''
echo "===== 1. 提现/广告开关 ====="
cd /opt/bafangju && sudo node -e "
const s=require('./src/store.js');
try{ const db=s.getDB?s.getDB():null; }catch(e){}
" 2>/dev/null
sudo sqlite3 "$(sudo grep -rho '/[^\"]*bafangju.db' /etc/bafangju.env 2>/dev/null | head -1)" \
  "SELECT key,value FROM switches WHERE key IN ('adRewardEnabled','couponServiceFeeRate','verificationServiceFeeRate');" 2>/dev/null \
  || echo "(sqlite3直读失败,尝试env)"
echo "---- env DB路径 ----"
sudo cat /etc/bafangju.env 2>/dev/null | grep -i 'db\|database' | sed 's/=.*/=<hidden>/'
echo
echo "===== 2. fail2ban ====="
sudo systemctl is-active fail2ban 2>/dev/null
sudo fail2ban-client status sshd 2>/dev/null | grep -E 'Status|Currently banned|Banned IP'
echo
echo "===== 3. 异常属主(UID 197108) ====="
sudo find /opt/bafangju -xdev -user 197108 2>/dev/null | wc -l
echo "---- root属主文件数 ----"
sudo find /opt/bafangju -xdev -user root 2>/dev/null | wc -l
echo
echo "===== 4. 备份cron ====="
sudo cat /etc/cron.d/bafangju-backup 2>/dev/null | grep -v '^#' | grep -v '^$'
echo "---- 最近备份文件 ----"
sudo ls -lt /opt/bafangju/backups/ 2>/dev/null | head -4
echo
echo "===== 5. 线上接口 ====="
echo -n "health: "; curl -s -o /dev/null -w '%{http_code}\n' https://bfjzs.com/api/health
echo -n "filing: "; curl -s https://bfjzs.com/api/filing; echo
echo "===== 6. pm2 ====="
sudo pm2 list 2>/dev/null | grep -E 'bafangju'
echo "===== 7. 错误日志尾 ====="
sudo pm2 logs bafangju-server --err --lines 5 --nostream 2>/dev/null | tail -8
'''
    i,o,e=c.exec_command(cmd,timeout=90)
    print(o.read().decode('utf-8','replace'))
    err=e.read().decode('utf-8','replace')
    if err.strip(): print("===STDERR===\n"+err[:2000])
    c.close()
if __name__=="__main__": main()
