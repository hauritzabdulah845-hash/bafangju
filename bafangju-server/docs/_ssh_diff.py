#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""只读对比：本地 bafangju-server 的 src/ 与 public/ 各文件 md5 vs 线上 /opt/bafangju。
不做任何写操作。用法: python _ssh_diff.py <服务器密码>
"""
import sys, os, hashlib, paramiko

HOST = "124.221.130.18"
USER = "ubuntu"
PORT = 22
LOCAL_ROOT = r"G:/八方聚共享平台/bafangju-server"
REMOTE_ROOT = "/opt/bafangju"
DIRS = ["src", "public"]

def local_md5(path):
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()

def collect_local():
    result = {}
    for d in DIRS:
        base = os.path.join(LOCAL_ROOT, d)
        for root, _, files in os.walk(base):
            for fn in files:
                p = os.path.join(root, fn)
                rel = os.path.relpath(p, LOCAL_ROOT).replace("\\", "/")
                result[rel] = local_md5(p)
    return result

def main():
    if len(sys.argv) < 2:
        print("用法: python _ssh_diff.py <服务器密码>")
        sys.exit(1)
    password = sys.argv[1]

    local = collect_local()
    print("==> 本地文件数(src+public): %d" % len(local))

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, port=PORT, username=USER, password=password,
                   timeout=20, allow_agent=False, look_for_keys=False)

    # 用 find + md5sum 收集线上 src/public 全部文件
    cmd = ("cd %s && find src public -type f -print0 2>/dev/null | "
           "xargs -0 md5sum 2>/dev/null" % REMOTE_ROOT)
    stdin, stdout, stderr = client.exec_command(cmd, timeout=60)
    remote = {}
    for line in stdout:
        line = line.rstrip("\n")
        if not line or "  " not in line:
            continue
        md5, path = line.split("  ", 1)
        path = path.strip()
        if path.startswith("./"):
            path = path[2:]
        remote[path] = md5.strip()
    client.close()
    print("==> 线上文件数(src+public): %d" % len(remote))

    only_local = sorted(set(local) - set(remote))
    only_remote = sorted(set(remote) - set(local))
    diff = sorted(k for k in set(local) & set(remote) if local[k] != remote[k])
    same = set(local) & set(remote) - set(diff)

    print("\n=== 仅本地有(线上缺, %d) ===" % len(only_local))
    for k in only_local: print("  + %s" % k)
    print("\n=== 仅线上有(本地缺, %d) ===" % len(only_remote))
    for k in only_remote: print("  - %s" % k)
    print("\n=== 两边都有但内容不同(%d) ===" % len(diff))
    for k in diff: print("  * %s   local=%s remote=%s" % (k, local[k][:8], remote[k][:8]))
    print("\n=== 一致(%d) ===" % len(same))

if __name__ == "__main__":
    main()
