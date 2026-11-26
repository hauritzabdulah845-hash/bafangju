'use strict';
/**
 * 等级体系（V3.3 §4.9）—— 等级只作权益资格，不作计酬依据。
 *
 * 有效人数口径见 §4.10：通过推广关系绑定 + 至少 1 笔真实支付（默认不含免单）
 * + 已过售后期且无退款 + 无风控标记 + 近 30 天有活跃。人数不进分红公式。
 *
 * 门槛默认值见下，后台可通过 `levelThresholds` 开关覆盖（须递增）。
 */
const LEVELS = [
  { level: 'V1', name: '基础推广', rights: ['推广二维码', '基础推广权益'] },
  { level: 'V2', name: '团队推广', rights: ['团队视图', '基础辅导权益'] },
  { level: 'V3', name: '进阶辅导', rights: ['进阶辅导权益'] },
  { level: 'V4', name: '商家辅导', rights: ['商家辅导权益'] },
  { level: 'V5', name: '区域联盟', rights: ['区域联盟权益'] },
  { level: 'V6', name: '战略合作', rights: ['平台战略合作权益'] },
];

const DEFAULT_THRESHOLDS = { V1: 10, V2: 100, V3: 1000, V4: 10000, V5: 100000, V6: 1000000 };

/** 合并后台覆盖后的门槛表（非法值回落默认） */
function thresholdsOf(overrides) {
  const out = {};
  for (const l of LEVELS) {
    const v = overrides && overrides[l.level];
    out[l.level] = (Number.isFinite(Number(v)) && Number(v) > 0)
      ? Math.floor(Number(v))
      : DEFAULT_THRESHOLDS[l.level];
  }
  return out;
}

/** 当前等级（未达 V1 返回 null） */
function levelOf(validUsers, overrides) {
  const n = Number(validUsers) || 0;
  const th = thresholdsOf(overrides);
  let cur = null;
  for (const l of LEVELS) if (n >= th[l.level]) cur = l;
  return cur;
}

/** 等级档案：当前等级、权益、下一档与还差多少人 */
function levelProfileOf(validUsers, overrides) {
  const n = Number(validUsers) || 0;
  const th = thresholdsOf(overrides);
  const cur = levelOf(n, overrides);
  const next = LEVELS.find((l) => th[l.level] > n) || null;
  return {
    validUsers: n,
    thresholds: th,
    level: cur ? cur.level : 'V0',
    levelName: cur ? cur.name : '普通用户',
    rights: cur ? cur.rights.slice() : [],
    nextLevel: next ? next.level : null,
    nextLevelAt: next ? th[next.level] : null,
    remaining: next ? th[next.level] - n : 0,
  };
}

/** 某等级的人数门槛（用于商家上传资格等） */
function thresholdOf(levelCode, overrides) {
  const th = thresholdsOf(overrides);
  return th[levelCode] || Infinity;
}

module.exports = { LEVELS, DEFAULT_THRESHOLDS, thresholdsOf, levelOf, levelProfileOf, thresholdOf };
