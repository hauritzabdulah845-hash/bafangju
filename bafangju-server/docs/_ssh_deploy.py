#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从本机用密码 SSH 登录服务器，上传并执行备案部署脚本。
用法: python _ssh_deploy.py <服务器密码>
"""
import sys
import paramiko

HOST = "124.221.130.18"
USER = "ubuntu"
PORT = 22
LOCAL_SCRIPT = r"G:/八方聚共享平台/bafangju-server/docs/_ssh_inner_deploy.sh"
REMOTE_SCRIPT = "/tmp/bfj_inner_deploy.sh"

def main():
    if len(sys.argv) < 2:
        print("用法: python _ssh_deploy.py <服务器密码>")
        sys.exit(1)
    password = sys.argv[1]

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print("==> 连接服务器 %s@%s ..." % (USER, HOST))
    client.connect(HOST, port=PORT, username=USER, password=password,
                   timeout=20, allow_agent=False, look_for_keys=False)

    # 上传部署脚本
    sftp = client.open_sftp()
    sftp.put(LOCAL_SCRIPT, REMOTE_SCRIPT)
    sftp.close()
    print("==> 部署脚本已上传")

    # 用 sudo -S 从 stdin 喂密码，以 root 执行
    cmd = "sudo -S bash %s" % REMOTE_SCRIPT
    stdin, stdout, stderr = client.exec_command(cmd, get_pty=True)
    stdin.write(password + "\n")
    stdin.flush()

    # 实时输出
    for line in iter(lambda: stdout.readline(2048), ""):
        print(line, end="")
    err = stderr.read().decode("utf-8", "replace")
    if err.strip():
        print("=== STDERR ===")
        print(err)
    stdin.close()
    client.close()
    print("\n==> 执行完毕")

if __name__ == "__main__":
    main()
