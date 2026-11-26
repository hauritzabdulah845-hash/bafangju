# ============================================================
# 八方聚 · 本地启动脚本（Windows PowerShell）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\start-local.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\start-local.ps1 -Mode mock
#   powershell -ExecutionPolicy Bypass -File scripts\start-local.ps1 -Mode live
#
# 做的事：
#   1) 读取 bafangju-server\.env.local（没有则按纯 mock 启动）
#   2) 相对证书路径转绝对路径，避免依赖当前目录
#   3) 启动前打印支付模式与未就绪项（缺什么一目了然）
#   4) 用 Node 启动 src/server.js
# ============================================================
[CmdletBinding()]
param(
  [string]$EnvFile = "",
  [ValidateSet("auto", "mock", "live")]
  [string]$Mode = "auto",
  [switch]$SkipCheck
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
if (-not $EnvFile) { $EnvFile = Join-Path $root ".env.local" }

function Find-Node {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  if ($env:BAFANGJU_NODE_BIN -and (Test-Path $env:BAFANGJU_NODE_BIN)) { return $env:BAFANGJU_NODE_BIN }
  throw "未找到 Node.js：请安装 Node.js >= 22.5（https://nodejs.org），或设置环境变量 BAFANGJU_NODE_BIN 指向 node.exe"
}

# ---------- 1. 加载 env ----------
if (Test-Path $EnvFile) {
  $count = 0
  Get-Content $EnvFile -Encoding UTF8 | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    $idx = $line.IndexOf("=")
    if ($idx -lt 1) { return }
    $k = $line.Substring(0, $idx).Trim()
    $v = $line.Substring($idx + 1).Trim().Trim('"').Trim("'")
    if ($k) {
      [Environment]::SetEnvironmentVariable($k, $v, "Process")
      $count++
    }
  }
  Write-Host "[环境] 已加载 $count 项：$EnvFile" -ForegroundColor Green
} else {
  Write-Host "[提示] 未找到 .env.local，按纯 mock 模式启动" -ForegroundColor Yellow
  Write-Host "       建议：copy .env.local.example .env.local 后按需填写" -ForegroundColor Yellow
}

if ($Mode -ne "auto") { $env:PAY_MODE = $Mode }

# ---------- 2. 相对路径转绝对 ----------
foreach ($key in @("WX_PRIVATE_KEY", "WX_PLATFORM_CERT")) {
  $val = [Environment]::GetEnvironmentVariable($key, "Process")
  if ($val -and -not [IO.Path]::IsPathRooted($val) -and -not $val.Contains("-----BEGIN")) {
    [Environment]::SetEnvironmentVariable($key, (Join-Path $root $val), "Process")
  }
}
if (-not $env:PORT) { $env:PORT = "3000" }

$node = Find-Node
Write-Host "[Node] $(& $node -v)  $node" -ForegroundColor DarkGray

# ---------- 3. 支付自检 ----------
if (-not $SkipCheck) {
  Push-Location $root
  try {
    & $node -e "const p=require('./src/domain/pay');const m=p.resolvePayMode(process.env);const r=p.checkLiveReadiness(process.env);console.log('[支付] 模式='+m);if(!r.ok){console.log('[支付] 未就绪（预下单会返回 503）：');r.problems.forEach(function(x){console.log('   - '+x)});}else{console.log('[支付] 通道就绪');}"
  } finally { Pop-Location }
}

# ---------- 4. 启动 ----------
Push-Location $root
try {
  Write-Host "[启动] http://localhost:$env:PORT    （Ctrl+C 停止）" -ForegroundColor Cyan
  Write-Host "[后台] http://localhost:$env:PORT/admin.html" -ForegroundColor Cyan
  & $node "src/server.js"
} finally {
  Pop-Location
  Write-Host "[已停止] 服务已退出" -ForegroundColor Yellow
}
