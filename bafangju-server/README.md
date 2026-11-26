# 八方聚共享平台 · 开发版说明（V3.3 合规引擎）

## 目录结构

```
bafangju-server/            后端（Node.js + Express，SQLite 持久化开发版）
  src/domain/               合规核心域逻辑（纯函数，资金全部整数分）
    money.js                金额工具（元/分转换、均分/权重分摊，合计守恒）
    ladder.js               阶梯定价引擎（n=⌈1/r⌉+1、步位动态计价、快照）
    commission.js           分佣记账结算（收益账户，不走微信分账）+ 团队长辅导池（持久化流水/分配跑批）
    dividend.js             排队分红（队位/每日跑批/活跃快照/降级开关）
    quarter.js              储备专户与季度分红（三门槛、60/25/15、参考价值只读公示、储备出账白名单）
    withdraw.js             提现与商家转账记账（单笔≤500/日≤2000 拆笔、待确认收款、超时退回重发）
    transfer.js             商家转账适配层：mock + wechat v3 骨架（商户号配置后自动挂接）
    merchant.js             商家域（登录+token 签发/券核销幂等/广告位投放→储备专户）
    auth.js                 登录适配：code2session（WX_APPID/WX_SECRET 配置后走真实接口）+ openid 幂等建档
    pay.js                  支付适配层：mock + wxpay v3（真实下单 + 回调验签 AES-GCM 解密，材料齐备即可用）
    config.js               合规开关默认值（间推默认关闭、提现默认关闭、季度三门槛等）
  src/services.js           业务编排（订单/免单/进度/退款/任务/活跃快照/季度自动核算与发放）
  src/domain/fulfillment.js 履约闭环（发货/到店核销/确认收货/自动收货/售后，V3.5）
  src/server.js             API 服务 + 种子数据 + 每日跑批调度（开发版内置）
  src/store.js              双驱动存储：内存（测试）/ SQLite 持久化（默认，重启不丢），幂等 + append-only 审计
  public/admin.html         管理后台（11 个页签：总览/订单/商品/商家/提现/队位/储备专户/跑批/开关/风控/审计）
  test/                     合规测试（domain + 分期回归 + economics + fulfillment + coupon + ad + authz）
bafangju-miniprogram-user/     用户端小程序（原生，13 页面）
bafangju-miniprogram-merchant/ 商家端小程序（原生，10 页面，登录签发 token 自动携带）
```

## 运行

```bash
cd bafangju-server
npm install
npm test          # 63 项合规测试
npm start         # API :3000，管理后台 http://127.0.0.1:3000/admin.html
```

**存储配置**：默认 SQLite 持久化（`data/bafangju.db`，重启数据不丢）；`BAFANGJU_DB_DRIVER=memory` 切回内存（测试）；`BAFANGJU_DB_PATH` 自定义库文件路径。

小程序：微信开发者工具分别导入 `bafangju-miniprogram-user` / `bafangju-miniprogram-merchant`，**后端地址在各自的 `config.dev.js` 里配**（本地内网地址不会打进包体），`config.js` 的 `BASE_URL` 是生产域名占位，上线前必须替换；开发期在开发者工具关闭域名校验。商家端演示账号：**账号 `张记粮油店` / 密码 `demo123456`**（内置 2 张券、2 个广告位；首次登录会提示修改初始密码）。

### 小程序后端地址配置（P0-4）

| 文件 | 是否进包体 | 内容 |
| ---- | ---- | ---- |
| `config.js` | ✅ 进包 | 生产域名占位 `https://api.yourdomain.com`（**上线前必须替换**） |
| `config.dev.js` | ❌ 不进包（`packOptions.ignore`） | 本机局域网地址，如 `http://192.168.x.x:3000` |

- `config.js` 通过 `try/catch` 加载 `config.dev.js`：本地存在则覆盖 `BASE_URL`，正式包内不存在该文件时静默回落生产配置。
- 换网络后改 `config.dev.js`（`ipconfig` 查本机 IPv4），**不要**改 `config.js`。
- 真机预览（`config.dev.js` 不进包）时，可在开发者工具调试器控制台临时覆盖：`wx.setStorageSync('bfj_base_url', 'http://<本机局域网IP>:3000')`（仅开发环境生效）。
- 网络诊断入口（首页错误态的「点此诊断网络」）**仅开发环境可见**（`utils/env.js` 判定 `envVersion === 'develop'`），正式版不暴露后端地址。

## 微信支付商户号接入指引（材料到位后按此配置，无需改代码）

所有适配已设计就绪，服务器启动时自动检测环境变量并切换真实通道：

| 环境变量 | 作用 | 配置后生效 |
| ---- | ---- | ---- |
| `WX_APPID` / `WX_SECRET` | 小程序登录 | code2session 真实登录（未配置为开发态） |
| `WX_MCHID` / `WX_MERCHANT_SERIAL` / `WX_PRIVATE_KEY` | 支付下单 | `/api/payment/prepay` 走微信 v3 JSAPI 真实下单 |
| `WX_PLATFORM_CERT` + `WX_APIV3_KEY` | 回调验签 | `/api/payment/notify-wx` 验签+解密入账（未配置时该路由明确拒绝伪造回调） |
| 上述支付参数 + `WX_APIV3_KEY` | 商家转账 | 提现发放自动提交微信商家转账 v3（收款人需 openid，缺 openid 进 submit_failed，由 retry-transfers 跑批补发） |

接入步骤：① 商户号开通 JSAPI 支付与商家转账 → ② 配置上表环境变量 → ③ 微信商户平台下载平台证书、配置回调域名指向 `/api/payment/notify-wx` → ④ 重启服务即切真实通道（mock 行为自动停用）。注意：真实提现还要求收款商家绑定 openid（`withdrawTransfers.receiverOpenid`）。

**已验证**：v3 下单请求签名（RSA-SHA256 测试中验答回证）、回调验签（正确签名通过/篡改拒绝）、AES-256-GCM 资源解密、转账请求体结构——均有单元测试覆盖。

## 合规护栏落地清单（对应 V3.3 确认稿）

| 条款 | 实现 |
| ---- | ---- |
| 微信支付无 0 元支付 | 免单订单 pay_type=FREE，服务端校验步位后直接生成，自建 freeFlowNo 流水，无支付调用 |
| 分账 30% 上限 | 全部记账结算（冻结→结算→余额），代码中无任何分账调用 |
| 分佣基数 | 下单时快照成本（costFen/tax/opCost），基数=实付-成本快照，防成本变动追溯 |
| 团队长辅导池（§4.8-11） | leaderPoolFlows 持久化流水（按订单归属团队长）；分配跑批按"贡献基数×系数"权重，幂等；退款按单回滚退池 |
| 季度分红三门槛（§4.8-5） | 自动核算跑批：团队消费（本人+直推真实订单）、活跃占比（活跃快照）、广告贡献（广告投放费）→ 资格快照 |
| 季度分红发放 | 资格用户归一化权重（业绩60/活跃25/广告15×规模系数），池=储备×0.6；发放扣减储备（守恒）；每季度幂等一次 |
| 间推默认关闭 | config 默认 false，关闭时份额实时入分红池 |
| 免单默认不退款 | freeOrderRefundEnabled 默认 false；开启后周期作废+进度清零+队位收回 |
| 退款只影响其后步位 | refundOrder 仅 done-1，不追已过售后期的低价单差价 |
| 分佣按单独立回滚 | rollbackOrder 挂账（debtFen）并限制提现，周期不重算 |
| 同日单队位 | dailyPayout seenUsers 去重 |
| 跑批单事务 | 名单→金额→记账同步执行（单事务语义） |
| 提现限额与确认收款 | 单笔≤500 元自动拆笔、单日≤2000 元顺延补发、72h 未确认退回提现冻结并重发（防资金双计） |
| 提现默认关闭 | withdrawEnabled 默认 false（商户入驻满 90 天后开放，待确认 19） |
| 挂账禁提现 | debtFen>0 或 withdrawBlocked 拒绝提现申请 |
| 贡献分不兑付 | 无任何兑付接口；contributionUnitValueFen 只读公示，开关可关 |
| 储备专户白名单 | 划入 RESERVE_SOURCES 白名单；出账仅限 quarter_payout 且余额校验；广告投放费用自动划入并计入商家广告贡献 |
| 商家券核销幂等 | 一券一核销，回调重试安全（重复请求返回首次记录） |
| 商家端鉴权 | 登录签发 token（持久化），除登录外全部接口 401 拦截，越权访问其他商家数据 403；停用商家登录拒绝、token 403 |
| 管理后台鉴权 | 账号口令登录（scrypt 摘要存储、timingSafeEqual 比较、统一报错防时序泄露），签发持久化会话 token，全部 /api/admin/* 接口（除登录）401 拦截；改密后全部会话失效；env ADMIN_USER/ADMIN_PASSWORD 初始化，**生产环境（NODE_ENV=production）必须配置 ADMIN_PASSWORD（长度大于 10 位且含字母与数字），缺失或强度不足直接拒绝启动**，残留开发默认口令账号会被轮换为环境变量口令；仅非生产环境回落 admin/admin123 并审计告警 |
| 商品/类目管理 | 运营自助上架/改价/上下架；r 值修改为敏感定价操作强制审计留痕；改价遵循"成交快照不追溯" |
| 推广模块 | 邀请关系链一次性绑定（禁自邀/成环）、我的团队（直推汇总，隐私保护）、推广收益明细、小程序码（未配置 appid 时降级分享路径）、用户提现（受 withdrawEnabled 开关） |
| 任务系统 | 签到 +10、浏览商品 15 秒（服务端校验真实停留防刷）+5、30 天 80 贡献值活跃门槛查询 |
| 风控 | 黑名单（登录/下单 403 拦截）、用户申诉（防重复、管理员受理/驳回）、循环免单识别（近 30 天 ≥3 单预警，仅标记不自动处置） |
| 消息/结算 | 消息未读数与已读标记；商家结算单（按自然月汇总收益/广告/提现，只读不作为税务凭证） |
| 商家入驻 | 资质表单（名称/联系人/电话/类目/地址/营业执照必传）→ 人工审核 → 通过自动建档发初始 token；驳回必须留原因；同名拦截；证照经 /api/upload 上限 4MB 存**私有目录**（仅管理后台可查看） |
| 上传安全 | /api/upload 四道防线：真实类型判定（magic bytes，不信任 ext）、文件名 crypto.randomUUID、身份分级（素材必须登录；未登录只可传入驻证照）、频率限制 + 每日配额（主体/IP/全站三重计数，落库跨重启有效）；上传审计 `upload.image`/`upload.rejected` |
| 提现收款人绑定 | 商家端 wx.login code 自动换 openid 绑定（openid 不经前端手填）；用户微信登录即自动绑定收款微信；管理后台可补录/换绑；发放时随转账单携带，缺 openid 提交失败 → 补录后 retry-transfers 重试（重试前刷新最新绑定） |
| 回调防伪造 | 未配置平台证书时 notify-wx 明确拒绝；验签失败拒绝并审计留痕 |
| 审核降级开关 | auditDowngrade 生效时前端隐藏分红/团队入口，资金侧照常记账 |
| 幂等 | 全部资金操作幂等键唯一（支付回调/免单领取/任务/提现/核销/季度发放/团队长池批次） |
| 审计 | append-only auditLogs，开关变更/退款/跑批/提现/转账提交失败全留痕 |
| 每日跑批 | 服务端内置调度：跨日自动执行活跃快照→排队分红→转账超时退回→提现顺延补发 |

## V3.4 财务修正（2026-10-25）：让平台不再"卖得越多、亏得越多"

**问题**：原分佣口径"按单 max(0, 可分配收益)"把第 n 单免单的负收益记成 0，导致分佣基数合计大于周期真实可分配收益。
文档 §4.4 自己的算例即可证明：10 元商品 / r=20% / 成本 3 元，周期可分配 **7.20 元**，分佣基数却是 **12.32 元**，按 100% 分佣每周期**超发 5.12 元**；若该用户有直推，平台现金流为负。

**修法（三层）**：

1. **成本项落地**：商品新增 `taxFeeRate`（税费+支付通道费，按实付比例，默认 0.06）与 `opCostFen`（平台运营成本，分/单，默认 50），下单时快照固化；后台商品表单可直接录入，历史商品启动时自动补默认值。
2. **周期系数 + 硬封顶**：`ladder.cycleEconomics()` 推演整周期，得到
   `factor = 周期可分配收益 ÷ 各正单可分配收益合计`；每单分佣基数 =
   `floor(max(0, 本单可分配) × factor × (1 − 平台留存率))`，并受"本周期累计可分配收益 − 已计提基数"硬封顶。
   免单成本在周期收口（领取免单）时冲减，余额结转为**平台留存**并落流水。
3. **无主份额归平台留存**：无推广人的直推 70%、无团队长的辅导 8%，不再"凭空消失"或永久沉淀，统一记入 `platformFlows`，可对账、可回滚。

**效果（同一算例）**：分佣基数 12.32 → **6.46 元**；平台由 **−5.12 元** 转为 **+0.74 元/周期**（平台留存率 10%，未计无归属份额；若有推广人但无团队长，8% 辅导份额亦归平台，合计约 +1.26 元）。
把 `commissionPlatformRetainRate` 设为 0 即回到文档口径（商品线打平，利润全部来自广告与服务费）；建议 0~0.15 之间由甲方拍板。

**同批修掉**：

| 问题 | 修法 |
| ---- | ---- |
| 推广收益永远"冻结中" | 新增 `commission.settleDue`，支付满 `settleAfterHours`（默认 168h）自动解冻，纳入每日跑批 + 手动接口 |
| 活跃校验"曾经活跃过就永久活跃" | `svc.isUserActive`：T-1 快照（2 天补跑窗口）+ 当月签到天数，月初按月进度等比放宽 |
| 规模系数算了却没用 | `quarterPayout` 真正乘系数；按"有效消费用户数"取档（`scaleCoefficientLadder`），封顶 3 倍 |
| 季度权重硬编码 | 改读 `quarterWeights` 开关，并自动归一 |
| 广告费由前端传、广告位永久占用 | 服务端按 `feePerCycleFen × 档期` 计价；新增 `releaseExpiredAdSlots` 到期释放并纳入跑批 |
| 收款人 openid 写进"孤儿账户行" | `bindReceiver` 补 `id: userId`，提现不再必然 `submit_failed` |
| 推广收益分佣明细为空 | `promotionEarnings` 改按 `directUserId/indirectUserId` 查询并映射本人份额 |
| "累计少付"含待支付/已取消订单 | 只统计 `paid/shipped/done` |
| 模拟支付通道可把任意订单刷成已支付 | 配置 `WX_MCHID` 后 `/api/payment/notify` 自动 403 |

**新增配置**：`commissionPlatformRetainRate`、`defaultTaxFeeRate`、`defaultOpCostFen`、`settleAfterHours`、`activityRequireMonthSignDays`、`activitySignDaysRamp`、`scaleCoefficientLadder`。

**新增接口**：`GET /api/admin/economics/preview?productId=`（上架前算账）、`POST /api/admin/jobs/settle-commission`（到期结算）、`GET /api/admin/platform-flows`（平台留存流水）。

**自检方式**：

```bash
node tools/economics-check.js      # 打印一个周期的实付/可分配/分佣基数/平台留存（含旧口径对比）
node tools/economics-check.js 1000 300 0.2
npm test                           # 含新增 economics 回归用例（分佣不得超发、留存不得为负）
```

后台「商品管理 → 算账」按钮可直接看单个商品的周期账，**平台留存为负会标红并提示调价/调 r/降成本**。

---

## V3.5 履约闭环（2026-10-25）：订单终于能"走完"

**问题**：订单永远停在 `paid`——不能发货、不能确认收货、没有核销凭证。售后期因此没有起点，分佣永远冻结，售后也无处承接。

**新增能力**（`src/domain/fulfillment.js`）：

| 动作 | 接口 | 状态流转 |
| --- | --- | --- |
| 快递发货（商家 / 后台） | `POST /api/merchant/orders/ship`、`POST /api/admin/orders/ship` | `paid → shipped`（写快递公司+运单号） |
| 到店核销（商家 / 后台） | `POST /api/merchant/orders/verify`、`POST /api/admin/orders/verify` | `paid → done`（校验 6 位核销码） |
| 确认收货（用户） | `POST /api/orders/confirm` | `shipped → done`（写 `receivedAt`） |
| 自动收货（跑批） | 每日跑批自动执行 | `shipped` 超 `autoReceiveDays`(7) → `done` |
| 售后申请（用户） | `POST /api/orders/after-sale` | `afterSaleStatus=applying`（不影响订单状态） |
| 售后处理（后台） | `POST /api/admin/orders/after-sale/resolve` | 受理 → 退款 + 分佣/池回滚；驳回 → 允许再申请 |
| 强制完成（后台） | `POST /api/admin/orders/complete` | `paid/shipped → done`（异常兜底，留审计） |

**分佣解冻口径同步修正（重要）**：售后期起点 = 收货 > 到店核销 > 发货 > 支付；**售后处理中的订单不解冻**，避免"先解冻后退款、追不回来"。

**商家归属（新增 `products.merchantId`，可空 = 平台自营）**：订单下单时快照归属商家；商家端只能看/操作自己商品的订单；商家端新增「订单履约」页（待履约 / 已完成 / 全部，支持发货与到店核销）。后台商品表单可指定商家归属。

**新增配置**：`autoReceiveDays`（默认 7）、`afterSaleWindowDays`（默认 7）、`storeVerifyExpireDays`（默认 30，界面提醒用）。

**新增后台接口**：`GET /api/admin/orders/fulfillment-summary`（待发货/待核销/已发货/售后中计数）。

**自检**：`npm test` 含 `test/fulfillment.test.js`（发货越权、核销错码、确认收货后解冻、自动收货、售后受理退款、强制完成）。

---

## V3.6 联盟券闭环（2026-10-25）：券能领、能核、能计费

**问题**：商家有券但没有 C 端入口，用户根本看不到券；核销只写一条记录，**不计 3%/5% 服务费、不走方案 B**——平台三大收入项里两项实际为 0，"异业联盟"只有故事没有收入。

**新增链路**（`src/domain/coupon.js`）：

| 环节 | 接口 | 说明 |
| --- | --- | --- |
| 商家发券 | `POST /api/merchant/coupons/create` | 满减 / 折扣 / 次卡；库存、每人限领、有效期 |
| 用户领券 | `GET /api/coupons/available`、`POST /api/coupons/claim` | 领券即生成 8 位核销码，校验库存与限领 |
| 我的券 | `GET /api/user/coupons` | 未使用 / 已核销 / 已过期，到店出示核销码 |
| 到店核销 | `POST /api/merchant/coupons/redeem` | 核销码 + 实际消费金额 → 计服务费 → 方案 B 分佣 |
| 明细 | `GET /api/merchant/alliance-orders`、`GET /api/admin/alliance-orders` | 联盟服务单与服务费汇总 |

**计费口径**：券服务费 **3%**（满减/折扣券）、核销服务费 **5%**（次卡/服务），按核销金额计提；费率 `couponServiceFeeRate` / `verificationServiceFeeRate` 可配，运营成本 `allianceOpCostFen` 从服务费中扣除后再分佣。

**方案 B**：平台 10% / 团队 10% / 直推 70% / 间推 10%；基数 = 服务费 − 联盟运营成本。

**边界（重要）**：联盟服务单**不进商品线阶梯进度、不产生排队队位、不产生分享贡献值**；联盟线的平台份额（平台比例 + 间推关闭份额 + 无推广人/无团队长的未归属份额）**不进商品线分红池**，改记平台留存并按"交易服务费"划入储备专户——两套钱不混。

**口径说明**：储备专户是"平台留存"里划出、专用于季度分红的**子账**（储备 ⊆ 平台留存），对账时不要把两者相加；广告收益同理，既计入平台留存，也全额划入储备。

**页面**：用户端新增「我的券」（可领取 / 我的券）；商家端「我的券」升级为发券 + 领取/核销统计；核销页改为「核销码 + 消费金额」，核销后直接显示服务费。
**后台**：商家管理新增「联盟服务单」明细；商家结算单新增券服务费 / 核销服务费字段。

**新增配置**：`commissionPlanB`、`couponServiceFeeRate`、`verificationServiceFeeRate`、`allianceOpCostFen`、`couponDefaultValidDays`、`couponPerUserLimit`。

**风控提示**：核销金额由商家录入（服务费基数），已做最低消费校验与全量审计；上线后建议叠加"用户端确认消费金额"或小票拍照留存，防止商家少报金额逃费。

**自检**：`npm test` 含 `test/coupon.test.js`（发券限领、3%/5% 计费、核销校验、方案 B 比例、联盟单不产生队位、服务费汇总）。

---

## V3.7 广告位展示与曝光/点击（2026-10-25）：商家买到的广告位真的会出现

**问题**：`/api/home` 的 `banner` 硬编码 `[]`，用户端没有任何广告渲染。广告位卖出去了却"哪里都不出现"，商家第二个月必然不续费——这也让 §6.1 的"曝光/点击/核销数据"无从谈起。

**链路**（`src/domain/ad.js`）：

| 环节 | 接口 | 说明 |
| --- | --- | --- |
| 广告位配置 | `POST /api/admin/adslots/create` | 位置（首页/分类/详情/支付结果/个人中心）、最短档期、档期价 |
| 商家投素材 | `POST /api/merchant/adslots/book` | 标题 + 图片（可选，站内上传）+ 跳转商品（可选），提交后待审核 |
| 平台审核 | `POST /api/admin/adslots/review` | 通过后才**开始计算档期**（审核耗时不吃商家档期）；驳回立即释放广告位 |
| 前台展示 | `GET /api/ads?position=`、`/api/home` 的 `banner` | 仅"已审核 + 在档期内"的广告可见 |
| 曝光/点击 | `POST /api/ads/impression`、`POST /api/ads/click` | 按"投放 × 用户 × 天"去重后计数；点击返回跳转目标 |
| 效果 | `GET /api/merchant/adslots/mine`、`GET /api/admin/adslots` | 曝光 / 点击 / CTR、档期与剩余天数 |

**防刷口径**：同一用户同一天对同一广告只计 1 次曝光、1 次点击（明细落 `adEvents`，可审计）；未审核、已过期或已结束的投放不计数。

**页面**：用户端首页 Banner（无图则渐变文字）、商品详情页广告条；商家端「广告位」页重写为选位 → 素材上传 → 提交 → 看效果；后台新增「广告位」页签（配置 / 审核 / 效果）。

**自检**：`npm test` 含 `test/ad.test.js`（位置与价格校验、仅审核后展示、曝光/点击去重、驳回与超时释放、CTR 汇总）。

---

## V3.8 鉴权收口与商家账号密码（2026-10-25）：先把"谁能看什么"钉死

**问题**：大量个人接口直接信任 `?userId=`——`/api/orders/list?userId=X` 能拿到他人的**姓名、手机号、详细地址**；商家端"报个名字就能登录"，甚至名字不存在会**自动建一个在营商家**，等于绕过入驻审核。

**① 越权收口**：新增 `attachUser` 可选登录中间件（解析 Bearer token → `req.user`），所有个人数据接口改为 **只认会话身份**，忽略 query/body 里的 `userId`：

`/api/orders/list`、`/api/return-plans`、`/api/dividend/my`、`/api/messages`、`/api/tasks/*`、`/api/user/contribution/30d`、`/api/user/promotion/*`、`/api/user/withdraw/*`、`/api/user/appeals`、`/api/user/bind-referral`、`/api/user/coupons` 全部 `requireUser`；公开接口（首页/商品/阶梯/领券列表）用 `req.user` 做可选个性化。

**② 客户端会话兜底**：用户端 `utils/api.js` 遇到 401 自动 `wx.login` 静默重登一次并重试原请求，避免"token 过期 → 整页空白"。

**③ 商家登录改为账号 + 密码**（scrypt 摘要，复用后台口令哈希）：
- 登录接口改为 `{ username, password }`，**不再自动注册**；账号或密码错误统一提示，不暴露账号是否存在；
- 建档/入驻审核通过时同时创建登录账号（默认=商家名称）与初始密码，**仅返回一次**；
- 新增 `POST /api/admin/merchants/reset-password`：重置密码并让旧 token 立即失效；
- 商家端登录页改为账号密码输入，初始密码登录会弹安全提示。

**④ 测试环境可用**：`server.js` 的每日跑批 `setInterval` 改为仅在直接启动时注册，测试可 `require('../src/server')` 起临时端口做接口级鉴权测试（`test/authz.test.js`）。

**自检**：`npm test` 含 `test/authz.test.js`（A 用户读不到 B 的订单/队位/消息、无 token 401、商家错密码 400、不存在账号不自动注册、公开接口仍可用）。

---

## V3.9 用户登录接入 code2session + 本地幂等（2026-10-25）

**问题**：客户端从来没有把 `wx.login` 的 code 传给服务端，服务端只能按昵称建档——**每次静默重登都会新建一个用户**，订单与进度"凭空消失"；生产环境也没真正走微信身份。

| 项 | 说明 |
| --- | --- |
| 客户端 | `app.js` 先 `wx.login` 取 code 再登录；新增本地持久化 `deviceId`（开发态幂等种子）；401 重登同样带 code + deviceId |
| 服务端 | `auth.code2session` 支持 `devSeed`：未配 `WX_APPID/WX_SECRET` 时按 deviceId 派生稳定 openid；配置后走真实 code2session |
| 本地幂等 | 同一 openid（生产）/ 同一 deviceId（开发）永远返回同一 userId，并刷新 `lastLoginAt` |
| 老账号认领 | 昵称时代创建、无 openid 的账号，在**持有效会话**时首次微信登录会绑定到该账号（无会话不可冒领） |
| 生产护栏 | 配置 `WX_APPID + WX_SECRET` 后，**不允许无 code 的昵称登录**（400），避免绕过微信身份 |
| 并发收敛 | 多个页面同时 401 触发重登时，因幂等最终落到同一账号 |

`/api/user/login` 返回新增 `devMode` / `created` / `claimed` 字段，便于排查登录来源。

**迁移说明**：历史账号若仍持有有效 token 会继续用原账号；token 失效后再登录会创建新账号（生产按 openid 去重，不存在该问题）。

---

## V3.10 支付前端（2026-10-25）：真实参数就绪即生效，未就绪走 mock

**改前**：前端从不调用 `wx.requestPayment`，下单后直接打 `/api/payment/notify` 把订单改成已支付；后端 `prepay` 只返回 `prepay_id`，**没有生成小程序支付签名**——即使配了商户号也调不起微信支付。

| 项 | 说明 |
| --- | --- |
| 支付签名 | 新增 `buildJsapiPayParams`：`appId\ntimeStamp\nnonceStr\nprepay_id=xxx\n` 用商户私钥 RSA-SHA256 签名，返回 `timeStamp / nonceStr / package / signType / paySign` |
| 预下单 | `/api/payment/prepay` 改为登录态，**只能给自己的待支付订单**；`openid` 取自会话（不再信任前端传参）；同通道幂等返回，切换模式或超过 90 分钟（微信 prepay_id 约 2 小时过期）自动重下 |
| 支付模式 | `PAY_MODE=mock` / `live`；未设置按配置自动判定。**live 缺配置直接报错**，不静默降级 |
| 模拟支付 | `/api/payment/notify` 仅 mock 模式可用，且只能操作自己的订单 |
| 客户端 | `api.payOrder()`：真实模式唤起 `wx.requestPayment`；mock 模式服务端直接入账；支付后 `waitPaid()` 轮询订单状态（回调是异步的） |
| 订单查询 | 新增 `GET /api/orders/:id`（仅本人），用于支付后轮询 |
| 环境探测 | `GET /api/payment/config` 返回当前模式（不含任何密钥） |

**配置即生效**：

| 部署状态 | 行为 |
| --- | --- |
| 未配置 `WX_MCHID / WX_APPID / WX_MERCHANT_SERIAL / WX_PRIVATE_KEY` | 自动 mock：下单即入账，便于演示与联调 |
| 配齐上述参数（+ `WX_PLATFORM_CERT`、`WX_APIV3_KEY` 用于回调验签） | 自动 live：前端唤起微信支付，回调 `notify-wx` 验签后入账 |
| `PAY_MODE=mock` | 强制模拟（即使已配商户号也不动真钱，便于财务演示） |
| `PAY_MODE=live` | 强制真实；缺配置直接报错，避免"以为在收钱其实没接" |

**自检**：`npm test` 含 `pay.test.js` 新增 3 例（模式判定与 live 缺配置报错、JSAPI 签名可用公钥验签、下单返回 `payParams` 且真实通道缺 openid 拒绝）；`authz.test.js` 新增"只能为自己的订单预下单/模拟支付"。

**顺带修掉的两个隐藏问题**（都会在真实支付/上传时爆）：
1. `express.json()` 在 `/api/payment/notify-wx` 之前解析了报文，`notify-wx` 拿不到原始字节 → 验签必失败。改为 `express.json({ verify })` 捕获 `req.rawBody`，验签用原始字节。
2. `express.json()` 默认 100kb 上限，而 `/api/upload` 要收 4MB 图片的 base64（≈5.4MB）→ 商家上传广告图必然 413。上限提到 8MB。

---

## 月度对账演练（V3.11）

一个可复跑的确定性场景（内存库、不联网、不动真钱）：3 家商家 / 3 个类目（n=6/5/3）/ 12 个用户，跑完一个月后对账。

```bash
cd bafangju-server
npm run drill       # 等价于 node tools/reconcile-drill.js
```

输出「商品线 / 分佣 / 排队分红池 / 储备专户 / 平台留存 / 联盟券与广告 / 用户收益账户」七段账，并做 13 项硬检查：

| # | 检查 | 意义 |
| --- | --- | --- |
| 1 | 实付 = 成本 + 税费 + 运营 + 可分配 | 订单口径自洽 |
| 2 | 分佣基数合计 ≤ 可分配收益 | **V3.4 核心修复**：不再超发 |
| 3 | 各角色分佣合计 = 基数 | 分佣拆分守恒 |
| 4 | 退款按单回滚、不计入生效分佣 | 退款不污染其他周期 |
| 5 | 分红池流出 ≤ 流入 | 池不透支 |
| 6 | 当日发放 ≤ 池余额 5% | 发放节奏 |
| 7 | 储备专户流出 ≤ 流入 | 储备不透支 |
| 8 | 储备 ⊆ 平台留存 | 子账关系 |
| 9 | 平台留存 ≥ 0 | 平台不亏损 |
| 10 | 收益账户账面 = 流水推算 | 账实相符 |
| 11 | 每个返还周期可分配收益 ≥ 0 | 免单成本被真实冲减 |
| 12 | 联盟券服务费已计提且进入方案 B 基数 | 联盟线收入成立 |
| 13 | 广告投放费与曝光已入账 | 广告线收入成立 |

任一项失败会打印 `FAIL` 并以退出码 1 结束，可直接接 CI。

---

## 合规核对（对照 V3.3 内容确认稿）

逐条款核对表见仓库根目录 `八方聚_V3.3合规核对表_20261025.md`：114 条 → ✅83 / ⚠️17 / ❌14。
结论：资金规则层（阶梯/分佣/分红/储备）已对齐；缺口集中在体验与运营（等级体系、消息类型、支付结果页、LBS、流量主）。
**唯一需要甲方拍板的是"分佣基数口径"**（文档 §4.3 每单口径 12.32 元 vs 同页可分配 7.20 元，按文档会超发）。

---

## V3.12 退款通道 + 回调金额校验（2026-10-25）

| 项 | 说明 |
| --- | --- |
| 微信退款 | `wxpayProvider.refund` → v3 `/v3/refund/domestic/refunds`，`out_refund_no = RF_<orderId>` 幂等；仅 `SUCCESS / PROCESSING` 视为受理，`ABNORMAL / CLOSED` 抛错 |
| 编排顺序 | 后台「退款」与「售后受理」都改为**先调微信退款、成功后再落本地状态与分佣回滚**；退款失败则订单与售后状态不变 |
| mock 行为 | `mockProvider.refund` 直接返回成功，只由 `services.refundOrder` 改本地状态（演示不受影响） |
| 回调金额校验 | `notify-wx` 校验 `resource.amount.total === order.paidFen`，不一致拒绝入账并记 `payment.amount_mismatch` |
| 迟到回调 | 已退款/已取消订单的回调直接忽略（不再被改回已支付） |
| 未知订单 | 回调里的订单号不存在 → 404 + 审计 |

**自检**：`pay.test.js` 新增两例（v3 退款请求体/签名/SUCCESS·PROCESSING·ABNORMAL、mock 退款）。

---

## V3.13 等级体系与有效人数（2026-10-25）

**口径**（V3.3 §4.9 / §4.10）：等级只作权益资格、不作计酬依据；人数不进分红公式。

| 等级 | 有效人数门槛 |
| --- | --- |
| V1 | 10 |
| V2 | 100 |
| V3 | 1,000 |
| V4 | 10,000 |
| V5 | 100,000 |
| V6 | 1,000,000 |

**有效人数** = 团队（直推 + 间推两层）中同时满足：
① 有真实支付订单（`WX_PAY`，免单不计）；
② 该单已过售后期（默认 7 天）且无退款、不在售后中；
③ 未被风控拉黑；
④ 近 30 天有活跃（下单 / 任务 / 活跃快照 / 登录任一）。

**接口**：`GET /api/user/level` → `{ validUsers, teamSize, level, levelName, rights, nextLevel, nextLevelAt, remaining }`
**前端**：个人中心显示等级与有效人数；「我的团队」显示等级卡与下一档差额。
**测试**：`test/level.test.js`（门槛映射、有效人数过滤、黑名单/退款/售后中/未过售后期/30 天不活跃排除、等级档案）。

**未做**：商家商品上传资格（§4.9-1）——需要先明确"商家归属哪个推广团队"，当前数据模型没有这个字段，属待甲方确认项。

---

## V3.14 支付结果页 + 免单领取页（2026-10-25，用户端小程序）

| 页面 | 内容 |
| --- | --- |
| `pages/pay-result` | 支付状态、本单实付与步位、**再买 1 单实付 Y 元**（按当前步位动态计算）、免单进度、继续支付/领取免单/查看订单 |
| `pages/free-claim` | 步位校验 → 领取免单 → **全屏庆祝动画** → 一次性订阅授权（`SUBSCRIBE_TEMPLATE_ID` 未配置时跳过，站内消息兜底） |

- 入口：商品页支付成功、订单页付款成功后跳转支付结果页；商品页「领取免单」进入免单领取页。
- 免单页会先取默认收货地址（快递商品需要），没有地址时由服务端返回明确错误。
- 订阅消息模板 ID 配在用户端 `config.js` 的 `SUBSCRIBE_TEMPLATE_ID`，留空不阻塞领取。

---

## V3.15 任务体系：奖励可配 + 广告任务 + 30 天奖励（2026-10-25）

| 项 | 说明 |
| --- | --- |
| 奖励可配 | `taskRewards` 开关：`{ sign_in, browse, ad, share }`，默认 10/5/15/10；后台「广告位 → 任务奖励配置」可改，`POST /api/admin/task-config` 留审计 |
| 广告任务 | `adTaskEnabled` 开关（默认**关**，流量主开通后再打开）；`POST /api/tasks/ad-start` → ≥15 秒 → `POST /api/tasks/ad-finish`，服务端校验时长与每日一次 |
| 30 天奖励 | 近 N 天有 N 个不同日期完成任务 → 奖励 R 贡献值（默认 30 天/80 分），`runTaskStreakBonus` 每日跑批，每窗口只发一次，写站内消息 |
| 分享奖励 | 绑定成功给邀请人 +N 贡献值，N 取 `taskRewards.share` |
| 任务类型校验 | 未知任务类型直接拒绝；贡献值只记权重、不兑付 |

**接口**：`GET /api/tasks/today` 增加 `rewards / adEnabled / ad / streak`；新增 `/api/tasks/ad-start`、`/api/tasks/ad-finish`、`GET|POST /api/admin/task-config`。

**注意**：微信流量主组件尚未接入，广告任务目前是"站内任务外壳"（服务端校验观看时长）；等流量主开通，把 `ad-finish` 的触发从定时器换成激励视频 `onClose(isEnded)` 回调即可。

---

## V3.16 消息中心六类（2026-10-25）

| 类型 | 触发点 | 说明 |
| --- | --- | --- |
| `free_claimed` 免单达成 | 领取免单 | 原有 |
| `queue_granted` 队位获得 | 领取免单 | 新增，含当前队列位次 |
| `dividend_paid` 分红发放 | 每日分红跑批每席 | 新增，含当日金额 |
| `dividend_deferred` 分红顺延 | 活跃校验未通过被跳过 | 新增，同类 7 天内只提醒一次 |
| `withdraw_issued` / `withdraw_done` / `withdraw_expired` 提现结果 | 转账发起 / 确认收款 / 超时退回 | 新增 |
| `system_notice` 系统公告 | 后台群发 | 新增 `POST /api/admin/messages/broadcast` |

**后台**：`POST /api/admin/messages/broadcast { title, body, userIds? }`（不传 userIds 即全量），标题 ≤60 字、内容 ≤500 字，留审计；`GET /api/admin/messages?limit=` 查看最近消息。

**测试**：`test/messages.test.js`（免单+队位、分红发放、顺延去重、提现三类、公告全量/定向/校验）。

---

## V3.17 规则版本与确认留档（2026-10-25）

| 项 | 说明 |
| --- | --- |
| 版本开关 | `rulesVersion` / `rulesUpdatedAt`（默认 2026-10-24），后台 `POST /api/admin/rules/version` 改版，留审计 |
| 确认留档 | `ruleConfirmations` 表记录 `userId / version / source / ts`，同时写用户字段 `rulesVersion`、`rulesConfirmedAt` |
| 下单强制 | `/api/orders`、`/api/orders/free-claim` 先校验当前版本，未确认返回 `400 { code: 'RULES_NOT_CONFIRMED', rulesVersion }` |
| 改版重认 | 版本变更后旧确认自动失效，用户需重新确认；用旧版本号提交返回 `RULES_VERSION_CHANGED` |
| 接口 | `GET /api/rules/version`（公开）、`POST /api/user/rules/confirm`、`GET /api/admin/rules`、`POST /api/admin/rules/version` |

**前端**：首页 `/api/home` 下发 `rulesVersion`；商品下单与免单领取前自动写确认，失败提示“请先阅读并确认规则”。

**测试**：`test/rules.test.js`（未确认拒绝、确认留档/幂等、改版后需重新确认、历史留档保留）。

---

## V3.18 复购中心（2026-10-25）

| 项 | 说明 |
| --- | --- |
| 接口 | `GET /api/user/rebuy` → `{ products, categories }` |
| 常买商品 | 按历史已支付订单聚合（退款单不计），返回购买次数、最近购买时间、**下一单实付**（当前步位 × 该商品标价） |
| 跨类目进度 | 每个类目的 `done / n / remaining`，用于"还差几单免单" |
| 页面 | `pages/rebuy`：常买商品一键复购（跳商品详情）+ 跨类目进度条；个人中心新增入口 |

**测试**：`test/rebuy.test.js`（聚合与下一单实付、退款单不计入）。

---

## V3.19 后台消息管理界面（2026-10-25）

- 新增侧边栏「消息管理」页签：系统公告（标题 + 正文 + 可选指定用户 ID，留空全量发送）+ 最近 100 条站内消息列表（时间/用户/类型/标题/已读状态）。
- 发送后立即刷新列表；发送结果与错误就地提示；内容做 HTML 转义，避免公告标题注入。
- 对应接口：`POST /api/admin/messages/broadcast`、`GET /api/admin/messages?limit=`。

---

## V3.20 后台系统设置：等级门槛 + 规则版本（2026-10-25）

- 新增侧边栏「系统设置」页签，两个卡片：
  - **等级门槛配置**：V1–V6 有效人数门槛可改（须逐级递增），保存即生效，`POST /api/admin/level-config` 留审计；
  - **规则版本管理**：显示当前版本/更新时间/已确认用户数，可切换版本（`YYYY-MM-DD`），切换后用户下次下单需重新确认。
- 对应接口：`GET|POST /api/admin/level-config`、`GET /api/admin/rules`、`POST /api/admin/rules/version`。
- 等级门槛存于 `levelThresholds` 开关，`level.thresholdsOf` 合并默认值并回落非法值。

---

## 生产化待办（上线前）

1. ~~内存存储~~ ✅ SQLite 持久化（默认启用）；规模增大后平滑替换 MySQL（域逻辑不动，表结构对照 store.js）。
2. ~~登录鉴权~~ ✅ code2session 已就绪；~~支付适配~~ ✅ 真实下单+回调验签+转账骨架全部就绪，**等商户号材料配置环境变量即可**。
3. ~~团队长池进程内变量~~ ✅ 已迁移 leaderPoolFlows 持久化表。
4. 定时任务迁移 crontab/任务框架（当前为开发版内置分钟级检查）。
5. ~~商家收款人 openid 收集~~ ✅ 五期已闭环：商家端 wx.login 自动绑定、用户登录自动绑定、管理后台补录三通道；缺 openid 转账 submit_failed，补录后 retry-transfers 自动重发。
6. 小程序合法域名配置、隐私协议、内容安全接口。
7. 微信审核预案：分批提审 + 降级开关（已内置）。
