# ============================================================
# 八方聚 · 本地微信支付证书放置与校验（Windows PowerShell）
#
# 用法：
#   # 1) 把商户平台下载的 PEM 放到任意目录（如 D:\wxpay）
#   # 2) 放置 + 校验 + 打印序列号
#   powershell -ExecutionPolicy Bypass -File scripts\setup-wxpay-certs.ps1 -Src D:\wxpay
#
#   # 只巡检，不复制
#   powershell -ExecutionPolicy Bypass -File scripts\setup-wxpay-certs.ps1 -Check
#
#   # 顺手把路径与序列号写回 .env.local
#   powershell -ExecutionPolicy Bypass -File scripts\setup-wxpay-certs.ps1 -Src D:\wxpay -WriteEnv
#
# 需要的文件：
#   apiclient_key.pem        必填  商户 API 私钥
#   apiclient_cert.pem       建议  商户 API 证书（校验成对、取序列号）
#   wechatpay_platform.pem   二选一 平台证书
#   wechatpay_pub.pem        二选一 微信支付公钥（新商户常见）
# ============================================================
[CmdletBinding()]
param(
  [string]$Src = "",
  [string]$CertDir = "",
  [string]$EnvFile = "",
  [switch]$Check,
  [switch]$WriteEnv
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
if (-not $CertDir) { $CertDir = Join-Path $root "certs" }
if (-not $EnvFile) { $EnvFile = Join-Path $root ".env.local" }

function Find-Node {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $portable = "C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
  if (Test-Path $portable) { return $portable }
  throw "未找到 Node.js，无法校验证书"
}

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "[注意] $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "[失败] $msg" -ForegroundColor Red; exit 1 }

$key = Join-Path $CertDir "apiclient_key.pem"
$cert = Join-Path $CertDir "apiclient_cert.pem"
$platform = Join-Path $CertDir "wechatpay_platform.pem"
$pubkey = Join-Path $CertDir "wechatpay_pub.pem"

# ---------- 1. 复制 ----------
if ($Src) {
  if (-not (Test-Path $Src)) { Fail "源目录不存在：$Src" }
  Step "复制证书：$Src → $CertDir"
  New-Item -ItemType Directory -Force -Path $CertDir | Out-Null
  foreach ($f in @("apiclient_key.pem", "apiclient_cert.pem", "wechatpay_platform.pem", "wechatpay_pub.pem")) {
    $from = Join-Path $Src $f
    if (Test-Path $from) {
      Copy-Item $from (Join-Path $CertDir $f) -Force
      Write-Host "  已复制 $f"
    }
  }
} else {
  New-Item -ItemType Directory -Force -Path $CertDir | Out-Null
}

# ---------- 2. 校验 ----------
Step "校验证书文件"
if (-not (Test-Path $key)) { Fail "缺少商户私钥 $key" }

$node = Find-Node
$checkJs = @'
const fs = require('fs'), crypto = require('crypto');
const keyPath = process.argv[1], certPath = process.argv[2];
let key;
try { key = crypto.createPrivateKey(fs.readFileSync(keyPath)); }
catch (e) { console.log('ERR|私钥无法解析（需 PEM、不能带口令）：' + e.message); process.exit(0); }
const keyPub = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64');
if (certPath && fs.existsSync(certPath)) {
  let x;
  try { x = new crypto.X509Certificate(fs.readFileSync(certPath)); }
  catch (e) { console.log('ERR|商户证书无法解析：' + e.message); process.exit(0); }
  const certPub = x.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  if (certPub !== keyPub) { console.log('ERR|私钥与商户证书不匹配（不是同一对）'); process.exit(0); }
  console.log('MCH_SERIAL=' + String(x.serialNumber || '').toUpperCase());
} else {
  console.log('MCH_SERIAL=');
}
'@

$mchSerial = ""
$out = & $node -e $checkJs -- $key $cert 2>&1
foreach ($line in $out) {
  if ("$line".StartsWith("ERR|")) { Fail "$line".Substring(4) }
  if ("$line".StartsWith("MCH_SERIAL=")) { $mchSerial = "$line".Substring(11) }
}
if ($mchSerial) {
  Write-Host "  商户证书序列号：$mchSerial"
} else {
  Warn "未提供 apiclient_cert.pem，跳过成对校验与序列号（上线前建议补上）"
}

# 平台证书 / 公钥
$platformPath = ""
$platformSerial = ""
if (Test-Path $platform) {
  $platformPath = $platform
} elseif (Test-Path $pubkey) {
  $platformPath = $pubkey
} else {
  Fail "缺少平台证书 $platform 或微信支付公钥 $pubkey（商户平台 → API 安全 下载）"
}

$platJs = @'
const fs = require('fs'), crypto = require('crypto');
const p = process.argv[1];
const buf = fs.readFileSync(p, 'utf8');
if (buf.includes('BEGIN CERTIFICATE')) {
  const x = new crypto.X509Certificate(buf);
  console.log('SERIAL=' + String(x.serialNumber || '').toUpperCase());
} else {
  try { crypto.createPublicKey(buf); } catch (e) { console.log('ERR|公钥无法解析：' + e.message); process.exit(0); }
  console.log('SERIAL=');
}
'@
$out2 = & $node -e $platJs -- $platformPath 2>&1
foreach ($line in $out2) {
  if ("$line".StartsWith("ERR|")) { Fail "$line".Substring(4) }
  if ("$line".StartsWith("SERIAL=")) { $platformSerial = "$line".Substring(7) }
}
if ($platformSerial) {
  Write-Host "  平台证书序列号：$platformSerial"
} else {
  Write-Host "  已使用「微信支付公钥」模式"
  Warn "公钥模式需到商户平台抄「公钥ID」，填 WX_PLATFORM_SERIAL（脚本不代填）"
}

# ---------- 3. 权限（Windows：移除继承，仅当前用户与 SYSTEM） ----------
if (-not $Check) {
  Step "收紧目录权限（仅当前用户 + SYSTEM）"
  $me = "$env:USERDOMAIN\$env:USERNAME"
  & icacls $CertDir /inheritance:r /grant:r "${me}:(OI)(CI)F" /grant:r "SYSTEM:(OI)(CI)F" *> $null
  if ($LASTEXITCODE -eq 0) {
    Write-Host "  已限制为：$me 与 SYSTEM"
  } else {
    Warn "icacls 执行失败，请手动确认 certs 目录不可被其他用户读取"
  }
} else {
  Warn "-Check 模式：不修改任何文件"
}

# ---------- 4. 写回 .env.local ----------
if ($WriteEnv -and -not $Check) {
  Step "写回环境变量：$EnvFile"
  if (-not (Test-Path $EnvFile)) {
    Copy-Item (Join-Path $root ".env.local.example") $EnvFile
    Warn "未找到 .env.local，已从模板复制，请补填 WX_MCHID / WX_APPID / WX_APIV3_KEY"
  }
  $pairs = [ordered]@{
    "WX_PRIVATE_KEY"     = $key
    "WX_PLATFORM_CERT"   = $platformPath
  }
  if ($mchSerial) { $pairs["WX_MERCHANT_SERIAL"] = $mchSerial }
  if ($platformSerial) { $pairs["WX_PLATFORM_SERIAL"] = $platformSerial }

  $lines = Get-Content $EnvFile -Encoding UTF8
  foreach ($k in $pairs.Keys) {
    $v = $pairs[$k]
    $hit = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
      if ($lines[$i] -match "^\s*#?\s*$k\s*=") {
        if ($lines[$i] -match "^\s*$k\s*=") { $lines[$i] = "$k=$v"; $hit = $true; break }
      }
    }
    if (-not $hit) {
      $lines = @($lines | Where-Object { $_ -notmatch "^\s*#\s*$k\s*=" })
      $lines += "$k=$v"
    }
  }
  [IO.File]::WriteAllLines($EnvFile, $lines, (New-Object Text.UTF8Encoding($false)))
  foreach ($k in $pairs.Keys) { Write-Host "  $k=$($pairs[$k])" }
}

# ---------- 5. 结果 ----------
Step "完成"
Write-Host "  证书目录：$CertDir"
Write-Host "  启动命令：powershell -ExecutionPolicy Bypass -File scripts\start-local.ps1 -Mode live"
Write-Host ""
Write-Host "  还需人工完成：" -ForegroundColor Cyan
Write-Host "  1) .env.local 填 WX_MCHID / WX_APPID / WX_APIV3_KEY（32 位）"
Write-Host "  2) 内网穿透把本地 3000 映射成 HTTPS，填 WX_NOTIFY_URL"
Write-Host "  3) 微信开发者工具 → 详情 → 本地设置：勾选「不校验合法域名」"
Write-Host "  4) 自检：curl.exe http://localhost:3000/api/payment/config"
Write-Host ""
Warn "私钥泄露立即到商户平台作废重发；certs/ 与 .env.local 已在 .gitignore 中"
