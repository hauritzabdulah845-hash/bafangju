'use strict';
/**
 * 合规配置中心 —— 所有合规开关集中管理，默认值即合规默认（V3.3 §12.5/§15）。
 * 变更必须经 audit.log 留痕（services 层调用 setSwitch 时自动记录）。
 */
const DEFAULTS = {
  // 间推奖励：默认关闭（待确认事项 6），关闭期间份额转入排队分红池
  indirectReferralEnabled: false,
  // 排队分红发放开关（审核风险预案：可暂停发放，池内资金留存、队位保留）
  queueDividendEnabled: true,
  // 审核降级开关：开启时前端隐藏"我的分红/我的团队"入口、规则页降级（资金侧照常记账）
  auditDowngrade: false,
  // 免单订单特殊退款通道（默认关闭；开启后退款则周期作废、进度清零、队位收回）
  freeOrderRefundEnabled: false,
  // 季度分红：贡献分单位参考价值公示开关（只读公示，无任何兑付入口）
  contributionValuePublishEnabled: true,
  // 储备专户季度可分配比例（安全系数 0.6）
  reserveDistributableRatio: 0.6,
  // 排队分红参数（默认值，后台可配置）
  queueDividendDailyRatio: 0.05,
  queueDividendDailySeats: 100,
  // 分佣比例（方案 A，V3.3 §4.5）
  commissionPlanA: { platform: 0.02, leader: 0.08, direct: 0.70, indirect: 0.20 },
  // 方案 B：异业联盟商家服务分佣（V3.6，券核销/次卡服务）
  commissionPlanB: { platform: 0.10, leader: 0.10, direct: 0.70, indirect: 0.10 },
  // 联盟券计费（V4.5 改为默认免费）：
  // 平台定位为「本地商家展示 + 自助发券 + 到店导流」，消费者货款与商家费用全部线下结算，
  // 平台线上不收取任何费用。以下费率默认 0 = 纯导流模式（核销不产生服务费、不挂应收单、不产生分佣）。
  // 将来若需收费，由后台把费率改为 0.03 / 0.05 即恢复原计费链路（代码路径完整保留）。
  couponServiceFeeRate: 0,
  verificationServiceFeeRate: 0,
  allianceOpCostFen: 0,             // 联盟服务单运营成本（分/单），从服务费中扣除后再分佣
  couponDefaultValidDays: 30,       // 领券后默认有效天数
  couponPerUserLimit: 1,            // 默认每人限领张数
  // ===== 财务修正（2026-10-25）：把"按单负单记 0"导致的分佣超发堵住 =====
  // 原口径：分佣基数 = 每单 max(0, 可分配收益) 之和 → 10 元/r=20% 时 12.32 元，
  // 而周期真实可分配只有 7.20 元，分佣 100% 即每周期超发 5.12 元（文档 §4.4 自证）。
  // 新口径：每单基数 = 该单可分配收益 × 周期系数 factor，且不超过周期累计可分配收益余额。
  // factor = 周期可分配收益合计 ÷ 各正单可分配收益合计（按商品与 r 动态推演，见 ladder.cycleEconomics）
  commissionPlatformRetainRate: 0.10, // 平台留存率；0 = 商品线打平（利润全部来自广告/服务费），建议 0~0.15
  // 商品成本项默认值（商品未单独配置时生效）
  defaultTaxFeeRate: 0.06, // 税费 + 支付通道费，按实付比例计
  defaultOpCostFen: 50,    // 平台基础运营成本（分/单）
  // 售后期：支付成功满 N 小时后分佣解冻入余额（生产应对接真实售后到期日）
  settleAfterHours: 168,
  // 履约（V3.5）：确认收货 / 售后窗口
  autoReceiveDays: 7,        // 发货后 N 天未确认收货 → 自动收货
  afterSaleWindowDays: 7,    // 确认收货/核销后 N 天内可申请售后
  storeVerifyExpireDays: 30, // 到店核销有效期（界面提醒用，不自动作废）
  // 活跃门槛：当月签到天数（月初按当月进度等比放宽，避免月初全员不达标）
  activityRequireMonthSignDays: 22,
  activitySignDaysRamp: true,
  // 分成权重（季度分红，V3.3 §4.8-7）
  quarterWeights: { performance: 0.60, activity: 0.25, adContribution: 0.15 },
  // 平台规模系数阶梯（V3.3 §4.8-10）：按有效消费用户数取档，封顶 3 倍
  scaleCoefficientLadder: [
    { users: 1000, coefficient: 1 },
    { users: 10000, coefficient: 1.5 },
    { users: 100000, coefficient: 2 },
    { users: 1000000, coefficient: 3 },
  ],
  scaleCoefficients: {}, // 可选：按 userId 覆盖规模系数（人工调整，留审计）
  // 提现（商家转账）总开关：上线初期关闭（商户入驻满 90 天方可开通，V3.3 §6/待确认 19）
  withdrawEnabled: false,
  // 商家转账限额（分销返佣场景）：单笔 500 元、单日单用户 2000 元
  withdrawMinFen: 100,
  withdrawPerTxnLimitFen: 50000,
  withdrawDailyLimitFen: 200000,
  // 转账"待用户确认收款"超时时长（小时），超时退回余额并自动重发
  transferConfirmTimeoutHours: 72,
  // 团队长辅导分红池：辅导贡献系数（V3.3 §4.8-11，默认 1.0，后台可配置）
  leaderPoolCoefficient: 1.0,
  // 任务体系（V3.3 §8.2 / §4.8-3）：奖励值后台可配（贡献值，只记权重、不兑付）
  taskRewards: { sign_in: 10, browse: 5, ad: 15, share: 10 },
  // 连续完成奖励：30 天完成奖励 80 贡献值（后台可配）
  taskStreakBonus: { days: 30, reward: 80 },
  // 广告任务开关：微信流量主开通后再打开；未开通时仅站内任务
  adTaskEnabled: false,
  // ===== 广告激励（V4.0 §方案稿 V1.2：视频广告 + 完播奖励 + 余额提现）=====
  adRewardEnabled: false,           // 总开关：首期关闭，不开放新增现金提现；存量待审走线下打款复核
  adRewardShareRate: 0.4,           // 用户奖励 = 单 IP 费用 × 分成比例
  adRewardWithdrawMinFen: 10000,    // 提现门槛：满 ¥100 才可申请
  adRewardWithdrawMaxFen: 200000,   // 单次提现上限 ¥2000
  adRewardWithdrawMonthlyLimit: 2,  // 每自然月提现次数上限
  adRewardDailyLimit: 10,           // 每用户每日领取次数上限（全站合计）
  adRewardIpDailyTotal: 5,          // 同 IP 全站每日领取总数上限（防 IP 池轮换）
  adRewardNewUserCooldownHours: 24, // 新注册用户冷却期（24h 后才可领奖）
  adRewardTPlus1Hours: 24,          // 奖励入账 T+N 后才计入可提现额度（风控追回窗口）
  // 退款闭环（S4 后续）：处理中订单主动查单间隔 / 滞留判定 / 异常队列告警阈值
  refundQueryIntervalMinutes: 5,
  refundProcessingTimeoutHours: 24,
  refundAnomalyAlertCount: 3,
  // 规则版本（V3.3 §5.2-1 / §15-11）：用户首次下单前确认，留档确认版本；改版后需重新确认
  rulesVersion: '2026-10-24',
  rulesUpdatedAt: '2026-10-24',
  // 等级门槛（V3.3 §4.9，后台可配）：有效人数达到即解锁对应等级（只作权益资格，不计酬）
  levelThresholds: { V1: 10, V2: 100, V3: 1000, V4: 10000, V5: 100000, V6: 1000000 },
  // 季度分红资格三门槛（V3.3 §4.8-5；V4-V6 数值待确认 21/22，先给 V1-V3 建议值）
  quarterThresholds: {
    consumptionFenByLevel: { V1: 500000, V2: 3000000, V3: 15000000 },
    activeRatio: 0.15,
    adSpendFenByLevel: { V1: 0, V2: 0, V3: 0 },
  },
};

module.exports = { DEFAULTS };
