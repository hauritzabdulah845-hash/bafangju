'use strict';
/**
 * /api/health 看门狗（PM2 的补充）：
 * PM2 autorestart 只能感知"进程退出"，进程存活但事件循环卡死/DB 挂起时不会重启。
 * 本脚本作为 PM2 第二个应用常驻，定时探测健康端点，连续失败达阈值即 pm2 restart 主应用。
 *
 * 环境变量：
 * - HEALTH_URL             探针地址（默认 http://127.0.0.1:3000/api/health）
 * - HEALTH_INTERVAL_MS     探测间隔（默认 30000）
 * - HEALTH_FAIL_THRESHOLD  连续失败阈值（默认 3）
 * - PM2_APP_NAME           重启目标（默认 bafangju-server）
 */
const http = require('http');
const { exec } = require('child_process');

const TARGET = process.env.HEALTH_URL || 'http://127.0.0.1:3000/api/health';
const INTERVAL_MS = Number(process.env.HEALTH_INTERVAL_MS || 30000);
const FAIL_THRESHOLD = Number(process.env.HEALTH_FAIL_THRESHOLD || 3);
const PM2_APP = process.env.PM2_APP_NAME || 'bafangju-server'; // 仅运维配置，不接受外部输入
const TIMEOUT_MS = 5000;

let failures = 0;
let restarting = false;

function onFailure(reason) {
  failures += 1;
  console.error(`[watchdog] 探活失败 ${failures}/${FAIL_THRESHOLD}: ${reason}`);
  if (failures >= FAIL_THRESHOLD && !restarting) {
    restarting = true;
    failures = 0;
    console.error(`[watchdog] 连续失败达阈值，执行 pm2 restart ${PM2_APP}`);
    exec(`pm2 restart ${PM2_APP}`, { timeout: 30000 }, (e, stdout, stderr) => {
      restarting = false;
      if (e) console.error('[watchdog] pm2 restart 失败:', String(stderr || e.message).trim());
      else console.log('[watchdog] pm2 restart 已下发');
    });
  }
}

function probe() {
  const req = http.get(TARGET, { timeout: TIMEOUT_MS }, (res) => {
    res.resume(); // 只需状态码，丢弃 body
    if (res.statusCode === 200) {
      if (failures > 0) console.log('[watchdog] 恢复健康');
      failures = 0;
    } else {
      onFailure(`HTTP ${res.statusCode}`);
    }
  });
  req.on('timeout', () => req.destroy(new Error(`timeout(${TIMEOUT_MS}ms)`)));
  req.on('error', (e) => onFailure(e.message));
}

console.log(`[watchdog] 已启动：${TARGET}，每 ${INTERVAL_MS / 1000}s 探测，连续 ${FAIL_THRESHOLD} 次失败重启 ${PM2_APP}`);
setInterval(probe, INTERVAL_MS);
probe();
