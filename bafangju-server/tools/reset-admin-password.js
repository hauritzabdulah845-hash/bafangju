#!/usr/bin/env node
/**
 * 总账号口令重置工具（服务器本地执行，用于「忘记密码 / 需要离线换密」）
 *
 * 用法（在 /opt/bafangju 目录下）：
 *   node tools/reset-admin-password.js '新口令'
 *   node tools/reset-admin-password.js '新口令' --restart     # 改完自动重启服务
 *   echo '新口令' | node tools/reset-admin-password.js        # 不把口令留在命令历史
 *
 * 口令规则：长度大于 10 位，且同时包含字母与数字。
 * 副作用：更新库内摘要 + 吊销全部后台会话（已登录的浏览器需要重新登录）。
 *
 * 可选参数：
 *   --user=账号     指定账号（默认：库里第一个账号，通常就是总账号）
 *   --db=路径       指定数据库文件（默认取 env 的 BAFANGJU_DB_PATH，再退到 <项目>/data/bafangju.db）
 *   --env=路径      指定环境文件（默认 /etc/bafangju.env）
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');

const APP = path.resolve(__dirname, '..');

function arg(name) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : '';
}
const hasFlag = (name) => process.argv.slice(2).includes(`--${name}`);

function parseEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '').trim();
  }
  return out;
}

function ask(promptText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(promptText, (a) => { rl.close(); resolve(a); });
  });
}

(async () => {
  const envFile = arg('env') || process.env.BAFANGJU_ENV_FILE || '/etc/bafangju.env';
  const env = parseEnvFile(envFile);
  const dbPath = arg('db') || process.env.BAFANGJU_DB_PATH || env.BAFANGJU_DB_PATH || path.join(APP, 'data', 'bafangju.db');

  if (!fs.existsSync(dbPath)) {
    console.error(`找不到数据库：${dbPath}\n可用 --db=路径 指定。`);
    process.exit(1);
  }

  // 口令来源：命令行参数 > stdin 管道 > 交互输入
  let pw = (process.argv[2] && !process.argv[2].startsWith('--')) ? process.argv[2] : '';
  if (!pw && !process.stdin.isTTY) {
    pw = (await new Promise((res) => {
      let buf = '';
      process.stdin.on('data', (c) => { buf += c; });
      process.stdin.on('end', () => res(buf));
    })).trim();
  }
  if (!pw) pw = (await ask('请输入新的总账号口令（不显示）：')).trim();
  if (!pw) { console.error('未提供口令，已取消。'); process.exit(1); }

  const adminAuth = require(path.join(APP, 'src', 'domain', 'adminAuth'));
  const { createStore, audit } = require(path.join(APP, 'src', 'store'));

  const chk = adminAuth.checkPasswordStrength(pw);
  if (!chk.ok) { console.error('口令不满足规则：' + chk.issues.join('、')); process.exit(1); }

  const db = createStore({ sqlitePath: dbPath });
  const all = db.adminAccounts.all();
  if (!all.length) { console.error('库中没有任何管理员账号。'); process.exit(2); }

  const want = arg('user');
  const acc = (want && all.find((a) => a.username === want)) || all[0];
  if (want && acc.username !== want) { console.error(`账号 ${want} 不存在。现有：${all.map((a) => a.username).join(', ')}`); process.exit(2); }

  acc.passwordHash = adminAuth.hashPassword(pw);
  acc.devDefault = false;

  const sessions = db.adminSessions.all();
  for (const s of sessions) db.adminSessions.delete(s.id);

  audit(db, 'cli', 'admin.password_reset_cli', { username: acc.username, revokedSessions: sessions.length });

  console.log(`已重置账号 ${acc.username} 的口令（库：${dbPath}）`);
  console.log(`已吊销后台会话 ${sessions.length} 个。`);

  if (hasFlag('restart')) {
    try {
      execSync('pm2 restart bafangju-server', { stdio: 'inherit' });
      console.log('服务已重启，新口令立即生效。');
    } catch (e) {
      console.error('自动重启失败，请手动执行：pm2 restart bafangju-server');
      process.exitCode = 3;
    }
  } else {
    console.log('请执行：pm2 restart bafangju-server  （或加 --restart 让本工具自动重启）');
  }
})().catch((e) => { console.error('执行失败：' + e.message); process.exit(1); });
