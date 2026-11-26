# ============================================================
# 八方聚 · 本地微信支付回调自测脚本
#
# 作用：不依赖真实付款、不依赖微信服务器，在本地伪造一条「签名合法」的
#       微信支付 v3 回调，打到 /api/payment/notify-wx，验证整条链路：
#       验签 → 解密 → 金额校验 → 幂等入账
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\test-notify.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\test-notify.ps1 -Replay -Tamper -Mismatch
#   powershell -ExecutionPolicy Bypass -File scripts\test-notify.ps1 -Port 3200 -KeepServer
#
# 隔离设计（不污染开发库、不连接微信、不产生真实资金）：
#   - 独立库 data/notify-test.db（首次自动建库 + 播种）
#   - 独立端口（默认 3100）
#   - 自签的本地测试密钥对，公钥临时充当「微信平台证书」用于验签
#   - 假商户号 local_selftest，不会发起任何真实下单
#
# 断言：
#   1) 合法回调 → HTTP 200，订单 status=paid，写入 wxTransactionId
#   2) -Mismatch 金额不一致 → HTTP 400，订单仍为 pending_pay（不入账）
#   3) -Tamper   签名被篡改 → HTTP 400
#   4) -Replay   重放同一回调 → HTTP 200，且进度 done 不重复累加
#
# 退出码：0 = 全部断言通过；1 = 有断言失败
# ============================================================
[CmdletBinding()]
param(
  [int]$Port = 3100,
  [string]$OrderId = "",
  [switch]$Replay,
  [switch]$Tamper,
  [switch]$Mismatch,
  [switch]$KeepServer
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$env:NODE_NO_WARNINGS = "1"
$failures = @()

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Green }
function Ok($m)   { Write-Host "  [通过] $m" -ForegroundColor Green }
function Bad($m)  { Write-Host "  [失败] $m" -ForegroundColor Red; $script:failures += $m }
function Info($m) { Write-Host "  $m" -ForegroundColor DarkGray }

function Find-Node {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $portable = "C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
  if (Test-Path $portable) { return $portable }
  throw "未找到 Node.js（请装 Node 22+ 或修改脚本里的 portable 路径）"
}

function Test-Port([int]$p) {
  $c = New-Object Net.Sockets.TcpClient
  try { $c.Connect("127.0.0.1", $p); return $true } catch { return $false } finally { $c.Dispose() }
}

$node = Find-Node
$certDir = Join-Path $root "certs"
New-Item -ItemType Directory -Force -Path $certDir | Out-Null
$testKey = Join-Path $certDir "_selftest-private.pem"
$testPub = Join-Path $certDir "_selftest-public.pem"
$apiV3Key = "0123456789abcdef0123456789abcdef"   # 固定 32 位，仅本地自测
$testDb = Join-Path $root "data\notify-test.db"
$baseUrl = "http://127.0.0.1:$Port"   # 用 127.0.0.1 而非 localhost：避免 Windows 上 localhost 先解析到 IPv6 ::1 导致连不上 0.0.0.0
$proc = $null

Write-Host "八方聚 · 微信支付回调本地自测" -ForegroundColor Cyan
Write-Host "  测试库：$testDb"

try {
  # ---------- 1. 本地测试密钥对 ----------
  Step "准备本地测试密钥对"
  if (-not (Test-Path $testKey) -or -not (Test-Path $testPub)) {
    $genJs = Join-Path $env:TEMP "bfj-genkey.js"
    @'
const fs = require('fs'), crypto = require('crypto');
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
fs.writeFileSync(process.argv[2], privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(), { mode: 0o600 });
fs.writeFileSync(process.argv[3], publicKey.export({ type: 'spki', format: 'pem' }).toString());
'@ | Set-Content -Path $genJs -Encoding UTF8
    & $node $genJs $testKey $testPub
    if ($LASTEXITCODE -ne 0) { throw "生成测试密钥失败" }
    Ok "已生成测试密钥：$testKey"
  } else {
    Info "复用已有测试密钥：$testKey"
  }

  if (Test-Port $Port) { throw "端口 $Port 已被占用，请用 -Port 换一个端口" }

  # ---------- 2. 建一条待支付订单（必须在服务启动前写入，服务启动时一次性载入内存） ----------
  Step "准备待支付订单"
  $mkOrderJs = Join-Path $env:TEMP "bfj-mkorder.js"
  @'
const path = require('path');
const root = process.argv[2], dbPath = process.argv[3], wantId = process.argv[4];
const { createStore } = require(path.join(root, 'src', 'store.js'));
const { seed } = require(path.join(root, 'src', 'seed.js'));
const svc = require(path.join(root, 'src', 'services.js'));

const db = createStore({ sqlitePath: dbPath });
seed(db); // 幂等：首次建库时播种类目与商品

function fail(msg) { console.log(JSON.stringify({ error: msg })); process.exit(0); }

if (wantId && wantId !== '-') {
  const o = db.orders.get(wantId);
  if (!o) fail('订单不存在：' + wantId);
  if (o.status !== 'pending_pay') fail('订单 ' + o.id + ' 当前状态为 ' + o.status + '，不是待支付');
  console.log(JSON.stringify({
    id: o.id, userId: o.userId, categoryId: o.categoryId,
    paidFen: o.paidFen, created: false, reused: true,
  }));
  process.exit(0);
}

// 自测用户（复用同名账号，避免重复插入）
let user = db.users.get('u_selftest');
if (!user) {
  user = db.users.insert({
    id: 'u_selftest', openid: 'selftest_openid', nickname: '回调自测用户',
    createdAt: new Date().toISOString(),
  });
}

// 自测商品：到店核销类型，免去"必须先选收货地址"的前置条件
let product = db.products.get('p_selftest');
if (!product) {
  const cat = db.categories.all()[0];
  if (!cat) fail('库中没有类目，seed 失败');
  product = db.products.insert({
    id: 'p_selftest', categoryId: cat.id, name: '回调自测商品（不下真实单）',
    priceFen: 100, costFen: 30, opCostFen: 0, taxFeeRate: 0,
    status: 'on_sale', deliveryType: 'store',
  });
}

const { order } = svc.createOrder(db, {
  userId: user.id,
  productId: product.id,
  idempotencyKey: 'selftest_' + Date.now(),
});
console.log(JSON.stringify({
  id: order.id, userId: order.userId, categoryId: order.categoryId,
  paidFen: order.paidFen, created: true, reused: false,
}));
'@ | Set-Content -Path $mkOrderJs -Encoding UTF8

  $orderArg = if ([string]::IsNullOrWhiteSpace($OrderId)) { "-" } else { $OrderId }
  $orderJson = & $node $mkOrderJs $root $testDb $orderArg
  if ($LASTEXITCODE -ne 0) { throw "造单脚本执行失败（exit $LASTEXITCODE）" }
  $order = $orderJson | ConvertFrom-Json
  if ($order.error) { throw "造单失败：$($order.error)" }
  $oid = $order.id
  $paidFen = [int]$order.paidFen
  Ok "订单 $oid（用户 $($order.userId)，类目 $($order.categoryId)）应付 $paidFen 分"
  Info $(if ($order.created) { "本次新建（回调前状态 pending_pay）" } else { "复用已有待支付订单" })

  # ---------- 3. 启动自测服务 ----------
  Step "启动自测服务（端口 $Port，live 模式，独立库）"
  $logOut = Join-Path $env:TEMP "bfj-notify-server.out.log"
  $logErr = Join-Path $env:TEMP "bfj-notify-server.err.log"
  Remove-Item $logOut, $logErr -ErrorAction SilentlyContinue

  $env:PAY_MODE = "live"
  $env:WX_MCHID = "local_selftest"
  $env:WX_APPID = "local_selftest"
  $env:WX_MERCHANT_SERIAL = "LOCAL_SELFTEST"
  $env:WX_PRIVATE_KEY = $testKey
  $env:WX_PLATFORM_CERT = $testPub
  $env:WX_APIV3_KEY = $apiV3Key
  $env:WX_NOTIFY_URL = "https://local.invalid/api/payment/notify-wx"
  $env:PORT = "$Port"
  $env:BAFANGJU_DB_PATH = $testDb
  $env:BAFANGJU_DB_DRIVER = "sqlite"
  $env:NODE_ENV = "development"
  Remove-Item Env:WX_PLATFORM_SERIAL -ErrorAction SilentlyContinue

  $proc = Start-Process -FilePath $node -ArgumentList "src/server.js" -WorkingDirectory $root `
    -PassThru -WindowStyle Hidden -RedirectStandardOutput $logOut -RedirectStandardError $logErr

  $ready = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 400
    if ($proc.HasExited) { break }
    try {
      $c = Invoke-RestMethod -Uri "$baseUrl/api/payment/config" -TimeoutSec 2
      if ($c.mode -eq "live") { $ready = $true; break }
    } catch { }
  }
  if (-not $ready) {
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
    Write-Host "  —— 服务启动失败，最后 30 行日志 ——" -ForegroundColor Red
    if (Test-Path $logErr) { Get-Content $logErr -Tail 30 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkRed } }
    if (Test-Path $logOut) { Get-Content $logOut -Tail 30 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray } }
    throw "自测服务启动失败（端口 $Port）"
  }
  Ok "服务已就绪：$baseUrl（mode=live，liveReady=$($c.liveReady)）"
  if (-not $c.liveReady) { Info "注意：liveReady=false，问题：$($c.problems -join '；')" }

  # ---------- 4. 构造回调报文 ----------
  Step "构造回调报文（AES-256-GCM 加密 + RSA-SHA256 签名）"
  $buildJs = Join-Path $env:TEMP "bfj-buildnotify.js"
  @'
const fs = require('fs'), crypto = require('crypto');
// argv: [2]=商户私钥 [3]=APIv3密钥 [4]=订单号 [5]=金额(分) [6]=输出body [7]=输出head
const privateKey = fs.readFileSync(process.argv[2], 'utf8');
const apiV3Key = process.argv[3];
const orderId = process.argv[4];
const amountFen = Number(process.argv[5]);
const ts = Math.floor(Date.now() / 1000).toString();
const headerNonce = crypto.randomBytes(8).toString('hex');
const resNonce = crypto.randomBytes(6).toString('hex');
const aad = 'transaction';
const transactionId = 'WX_LOCAL_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
const plain = JSON.stringify({
  mchid: 'local_selftest', appid: 'local_selftest',
  out_trade_no: orderId,
  transaction_id: transactionId,
  trade_state: 'SUCCESS', trade_state_desc: '支付成功',
  amount: { total: amountFen, payer_total: amountFen, currency: 'CNY', payer_currency: 'CNY' },
});
const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(apiV3Key), Buffer.from(resNonce));
c.setAAD(Buffer.from(aad));
const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
const ciphertext = Buffer.concat([enc, c.getAuthTag()]).toString('base64');
const body = JSON.stringify({
  id: crypto.randomUUID(), create_time: new Date().toISOString(),
  event_type: 'TRANSACTION.SUCCESS', resource_type: 'encrypt-resource',
  resource: { algorithm: 'AEAD_AES_256_GCM', ciphertext, associated_data: aad, nonce: resNonce, original_type: 'transaction' },
});
const signature = crypto.createSign('RSA-SHA256').update(`${ts}\n${headerNonce}\n${body}\n`).sign(privateKey, 'base64');
fs.writeFileSync(process.argv[6], body, 'utf8');
fs.writeFileSync(process.argv[7], JSON.stringify({ ts, nonce: headerNonce, signature, transactionId }), 'utf8');
'@ | Set-Content -Path $buildJs -Encoding UTF8

  function New-Notify([int]$amount, [string]$tag) {
    $bodyFile = Join-Path $env:TEMP "bfj-notify-$tag.body.json"
    $headFile = Join-Path $env:TEMP "bfj-notify-$tag.head.json"
    & $node $buildJs $testKey $apiV3Key $oid $amount $bodyFile $headFile
    if ($LASTEXITCODE -ne 0) { throw "构造回调报文失败（$tag）" }
    $h = Get-Content $headFile -Raw -Encoding UTF8 | ConvertFrom-Json
    return [pscustomobject]@{ bodyFile = $bodyFile; ts = $h.ts; nonce = $h.nonce; signature = $h.signature; transactionId = $h.transactionId }
  }

  function Send-Notify($n, [string]$sig) {
    $bytes = [IO.File]::ReadAllBytes($n.bodyFile)
    $headers = @{
      "Wechatpay-Timestamp" = $n.ts
      "Wechatpay-Nonce"     = $n.nonce
      "Wechatpay-Signature" = $sig
      "Wechatpay-Serial"    = "LOCAL_SELFTEST"
    }
    try {
      $r = Invoke-WebRequest -Uri "$baseUrl/api/payment/notify-wx" -Method Post -Headers $headers `
        -ContentType "application/json" -Body $bytes -UseBasicParsing -TimeoutSec 10
      return [pscustomobject]@{ status = [int]$r.StatusCode; body = $r.Content }
    } catch {
      $resp = $_.Exception.Response
      $msg = $null
      if ($_.ErrorDetails) { $msg = $_.ErrorDetails.Message }
      if (-not $msg -and $resp) {
        try {
          $sr = New-Object IO.StreamReader($resp.GetResponseStream(), [Text.Encoding]::UTF8)
          $msg = $sr.ReadToEnd()
        } catch { }
      }
      if ($resp) { return [pscustomobject]@{ status = [int]$resp.StatusCode; body = $msg } }
      return [pscustomobject]@{ status = 0; body = $_.Exception.Message }
    }
  }

  $qJs = Join-Path $env:TEMP "bfj-qorder.js"
  @'
const path = require('path');
const root = process.argv[2], dbPath = process.argv[3], id = process.argv[4];
const { createStore } = require(path.join(root, 'src', 'store.js'));
const db = createStore({ sqlitePath: dbPath });
const o = db.orders.get(id);
if (!o) { console.log(JSON.stringify({ error: 'not found' })); process.exit(0); }
const p = db.progress.get(`${o.userId}:${o.categoryId}`);
console.log(JSON.stringify({
  status: o.status,
  wxTransactionId: o.wxTransactionId || null,
  paidAt: o.paidAt || null,
  done: p ? p.done : null,
}));
'@ | Set-Content -Path $qJs -Encoding UTF8

  function Get-OrderState {
    $s = & $node $qJs $root $testDb $oid | ConvertFrom-Json
    return $s
  }

  # ---------- 5. 篡改签名（可选，先跑，此时订单未入账） ----------
  if ($Tamper) {
    Step "篡改签名：验证验签失败被拒绝"
    $n = New-Notify $paidFen "tamper"
    $forged = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("forged-signature"))
    $r = Send-Notify $n $forged
    Info "响应：HTTP $($r.status)  $($r.body)"
    if ($r.status -eq 400) { Ok "篡改签名被拒绝（HTTP 400）" } else { Bad "篡改签名未被拒绝（HTTP $($r.status)）" }
    $s = Get-OrderState
    if ($s.status -eq "pending_pay") { Ok "订单未被改动（仍为 pending_pay）" } else { Bad "订单状态异常（$($s.status)）" }
  }

  # ---------- 6. 金额不一致（可选） ----------
  if ($Mismatch) {
    Step "金额不一致：验证金额校验拦截"
    $n = New-Notify ($paidFen + 1) "mismatch"
    $r = Send-Notify $n $n.signature
    Info "响应：HTTP $($r.status)  $($r.body)"
    if ($r.status -eq 400) { Ok "金额不一致被拒绝（HTTP 400）" } else { Bad "金额不一致未被拒绝（HTTP $($r.status)）" }
    $s = Get-OrderState
    if ($s.status -eq "pending_pay") { Ok "订单未入账（仍为 pending_pay）" } else { Bad "订单状态异常（$($s.status)）" }
  }

  # ---------- 7. 合法回调 ----------
  Step "发送合法回调：验证验签 → 解密 → 入账"
  $n = New-Notify $paidFen "normal"
  Info "订单号 $oid  金额 $paidFen 分  时间戳 $($n.ts)  微信交易号 $($n.transactionId)"
  $before = Get-OrderState
  Info "入账前：status=$($before.status)  done=$($before.done)"
  $r = Send-Notify $n $n.signature
  Info "响应：HTTP $($r.status)  $($r.body)"
  if ($r.status -eq 200) { Ok "回调被接受（HTTP 200）" } else { Bad "回调被拒绝（HTTP $($r.status)）" }

  $after = Get-OrderState
  Info "入账后：status=$($after.status)  wxTransactionId=$($after.wxTransactionId)  done=$($after.done)"
  if ($after.status -eq "paid") { Ok "订单状态已变为 paid" } else { Bad "订单状态未变更（$($after.status)）" }
  if ($after.wxTransactionId) { Ok "已写入微信交易号 $($after.wxTransactionId)" } else { Bad "未写入微信交易号" }
  if ($after.paidAt) { Ok "已写入支付时间 $($after.paidAt)" } else { Bad "未写入支付时间" }
  if ($null -ne $after.done) { Ok "复购进度已累加（done=$($after.done)）" } else { Bad "未生成复购进度记录" }

  # ---------- 8. 重放（可选） ----------
  if ($Replay) {
    Step "重放同一条回调：验证幂等，不重复入账"
    $r2 = Send-Notify $n $n.signature
    Info "响应：HTTP $($r2.status)  $($r2.body)"
    if ($r2.status -eq 200) { Ok "重放返回 200（回调已受理）" } else { Bad "重放返回 $($r2.status)" }
    $again = Get-OrderState
    if ($again.status -eq "paid") { Ok "订单仍为 paid" } else { Bad "订单状态异常（$($again.status)）" }
    if ("$($again.wxTransactionId)" -eq "$($after.wxTransactionId)") { Ok "交易号未被改写（$($again.wxTransactionId)）" } else { Bad "交易号被改写（$($after.wxTransactionId) → $($again.wxTransactionId)）" }
    if ("$($again.done)" -eq "$($after.done)") { Ok "进度 done 未重复累加（$($after.done)）" } else { Bad "进度被重复累加（$($after.done) → $($again.done)）" }
  }
}
finally {
  if ($proc -and -not $proc.HasExited) {
    if ($KeepServer) {
      Write-Host "`n[*] -KeepServer：服务保留在 $baseUrl（PID $($proc.Id)），停止：Stop-Process -Id $($proc.Id)" -ForegroundColor Yellow
    } else {
      Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
      Write-Host "`n[*] 自测服务已停止" -ForegroundColor DarkGray
    }
  }
}

Write-Host ""
if ($failures.Count -eq 0) {
  Write-Host "结果：全部断言通过" -ForegroundColor Green
  exit 0
} else {
  Write-Host "结果：$($failures.Count) 项失败" -ForegroundColor Red
  $failures | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
  exit 1
}
