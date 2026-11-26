module.exports = {
  "apps": [
    {
      "name": "bafangju-server",
      "script": "src/server.js",
      "cwd": ".",
      "instances": 1,
      "exec_mode": "fork",
      "autorestart": true,
      "max_memory_restart": "512M",
      "env": {
        // 默认 production；联调阶段可用环境变量 NODE_ENV=staging 覆盖（生产支付守卫只在 production 生效）
        "NODE_ENV": process.env.NODE_ENV || "production",
        "PORT": 3000
        // 注意：生产环境必须额外提供 ADMIN_PASSWORD（长度大于 10 位且含字母与数字），
        // 否则服务会打印「启动被拒绝」并以退出码 1 退出（刻意设计，防止默认口令上线）。
        // 推荐用 pm2 的 .env 文件或系统环境变量注入，不要把明文口令写进本文件。
      },
      "error_file": "./logs/pm2-error.log",
      "out_file": "./logs/pm2-out.log",
      "merge_logs": true,
      "time": true,
      // 优雅关闭宽限：须大于 server.js 内部 9s 硬杀兜底，保证进行中请求先排干
      "kill_timeout": 10000
    },
    {
      // 健康检查看门狗：主应用进程存活但卡死时（/api/health 连续失败）自动 pm2 restart
      "name": "bafangju-health-watchdog",
      "script": "scripts/health-watchdog.js",
      "cwd": ".",
      "instances": 1,
      "exec_mode": "fork",
      "autorestart": true,
      "env": {
        "HEALTH_URL": "http://127.0.0.1:3000/api/health"
      },
      "error_file": "./logs/pm2-watchdog-error.log",
      "out_file": "./logs/pm2-watchdog-out.log",
      "merge_logs": true,
      "time": true
    }
  ]
};
