'use strict';
/**
 * 审计动作中文映射完整性回归（3.15 修复）：
 * ① src/ 内所有 audit(...) 调用的 action 字面量都必须在 admin.html 的 AUDIT_META 中命中；
 * ② AUDIT_META 不得存在代码从未产生的冗余键（防止映射表与实际动作脱节）；
 * ③ auditMeta() 的前缀兜底必须生效：未登记的 action 也要落到 7 个分组页签之一，不得掉进 'other'。
 *
 * 背景：此前 AUDIT_META 只覆盖 57/94 种动作，38 种动作在后台审计页直接显示英文原文，
 * 且因回退分组为 'other' 而在 7 个分组页签下都查不到、永远进不了「只看异常」。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');
const TOOLS_DIR = path.join(ROOT, 'tools');
const ADMIN_HTML = path.join(ROOT, 'public', 'admin.html');

/** 后台审计页的 7 个分组页签 */
const AUDIT_GROUPS = ['pay', 'order', 'config', 'job', 'account', 'user', 'upload'];

/** 递归列出 src 下所有 .js 文件 */
function listSrcFiles(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) out.push(...listSrcFiles(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * 提取所有 audit(...) 调用的实参列表。
 * 按顶层逗号切分，正确跳过字符串/模板字面量与嵌套括号，
 * 因此既能拿到纯字面量 action，也能拿到三元表达式里的多个候选 action。
 */
function findAuditCalls(text) {
  const out = [];
  const re = /\baudit\s*\(/g;
  let m;
  while ((m = re.exec(text))) {
    let i = m.index + m[0].length;
    let depth = 1;
    let quote = null;
    const args = [];
    let cur = '';
    while (i < text.length && depth > 0) {
      const c = text[i];
      if (quote) {
        cur += c;
        if (c === '\\') { cur += text[i + 1] || ''; i += 2; continue; }
        if (c === quote) quote = null;
        i += 1;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') { quote = c; cur += c; i += 1; continue; }
      if (c === '(' || c === '[' || c === '{') { depth += 1; cur += c; i += 1; continue; }
      if (c === ')' || c === ']' || c === '}') { depth -= 1; if (depth === 0) { i += 1; break; } cur += c; i += 1; continue; }
      if (c === ',' && depth === 1) { args.push(cur.trim()); cur = ''; i += 1; continue; }
      cur += c;
      i += 1;
    }
    args.push(cur.trim());
    out.push(args);
  }
  return out;
}

/** 收集 src/ 内所有 audit 调用的 action 集合 */
function collectActions() {
  const actions = new Set();
  const files = listSrcFiles(SRC_DIR).concat(fs.existsSync(TOOLS_DIR) ? listSrcFiles(TOOLS_DIR) : []);
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const args of findAuditCalls(text)) {
      if (args.length < 3) continue; // audit(db, actor, action, detail)
      const third = args[2];
      const literal = third.match(/^['"]([^'"]+)['"]$/);
      if (literal) { actions.add(literal[1]); continue; }
      // 动态 action（如 `cond ? 'a' : 'b'`）：取该表达式里的全部字符串字面量
      for (const m of third.matchAll(/'([^']+)'|"([^"]+)"/g)) actions.add(m[1] || m[2]);
    }
  }
  return actions;
}

/**
 * 读取 admin.html 引入的外置脚本（public/js/*.js），按引入顺序拼接成一段代码。
 * 3.13/P3-5 之后后台脚本已全部外置，不再有内联 <script>。
 */
function readAdminScripts() {
  const html = fs.readFileSync(ADMIN_HTML, 'utf8');
  const srcs = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(srcs.length > 0, 'admin.html 未找到外置脚本引用');
  return srcs.map((src) => {
    const file = path.join(ROOT, 'public', src.replace(/^\/+/, ''));
    assert.ok(fs.existsSync(file), `admin.html 引用的脚本不存在：${src}`);
    return fs.readFileSync(file, 'utf8');
  }).join('\n');
}

/** 从后台脚本中提取 AUDIT_META / AUDIT_PREFIX / auditMeta 并在沙箱里求值 */
function loadAuditMeta() {
  const code = readAdminScripts();
  const sandbox = { window: {}, document: { getElementById: () => null, querySelectorAll: () => [], querySelector: () => null } };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // 只执行到 AUDIT_META 定义结束，避免触发依赖 DOM 的初始化代码
  const cut = code.indexOf('const AUDIT_META');
  assert.ok(cut > 0, 'admin.html 未找到 AUDIT_META 定义');
  const end = code.indexOf('\n};', cut);
  assert.ok(end > cut, 'AUDIT_META 未正常闭合');
  vm.runInContext(code.slice(cut, end + 3) + '\n;this.__META = AUDIT_META;', sandbox);
  const meta = sandbox.__META;

  const pCut = code.indexOf('const AUDIT_PREFIX');
  assert.ok(pCut > 0, 'admin.html 未找到 AUDIT_PREFIX 前缀兜底表');
  const pEnd = code.indexOf('\n];', pCut);
  assert.ok(pEnd > pCut, 'AUDIT_PREFIX 未正常闭合');
  vm.runInContext(code.slice(pCut, pEnd + 3) + '\n;this.__PREFIX = AUDIT_PREFIX;', sandbox);
  const prefix = sandbox.__PREFIX;

  const mCut = code.indexOf('const auditMeta =');
  assert.ok(mCut > 0, 'admin.html 未找到 auditMeta()');
  const mEnd = code.indexOf('\n};', mCut);
  vm.runInContext(code.slice(mCut, mEnd + 3) + '\n;this.__fn = auditMeta;', sandbox);
  return { meta, prefix, auditMeta: sandbox.__fn };
}

test('AUDIT_META 覆盖 src 内全部审计动作（不得出现未映射的英文原文）', () => {
  const actions = collectActions();
  assert.ok(actions.size >= 90, `提取到的审计动作过少（${actions.size}），扫描逻辑可能失效`);
  const { meta } = loadAuditMeta();
  const missing = [...actions].filter((a) => !meta[a]).sort();
  assert.deepStrictEqual(missing, [], `以下审计动作未在 AUDIT_META 中登记，后台会显示英文原文：\n${missing.join('\n')}`);
});

test('AUDIT_META 无冗余键（每个映射都对应代码中真实存在的动作）', () => {
  const actions = collectActions();
  const { meta } = loadAuditMeta();
  const redundant = Object.keys(meta).filter((k) => !actions.has(k)).sort();
  assert.deepStrictEqual(redundant, [], `AUDIT_META 存在代码从未产生的冗余键：\n${redundant.join('\n')}`);
});

test('AUDIT_META 每一项的级别与分组合法', () => {
  const { meta } = loadAuditMeta();
  const bad = [];
  for (const [action, v] of Object.entries(meta)) {
    if (!Array.isArray(v) || v.length !== 3) { bad.push(`${action}: 结构不是 [级别, 中文名, 分组]`); continue; }
    const [level, label, group] = v;
    if (!['alert', 'warn', 'info'].includes(level)) bad.push(`${action}: 级别非法 "${level}"`);
    if (typeof label !== 'string' || !label.trim()) bad.push(`${action}: 中文名为空`);
    if (!AUDIT_GROUPS.includes(group)) bad.push(`${action}: 分组 "${group}" 不在 7 个分组页签内`);
  }
  assert.deepStrictEqual(bad, [], `AUDIT_META 存在非法项：\n${bad.join('\n')}`);
});

test('auditMeta 前缀兜底：未登记的 action 也能落到分组页签（不落 other）', () => {
  const { auditMeta, prefix } = loadAuditMeta();
  assert.ok(prefix.length > 0, 'AUDIT_PREFIX 前缀兜底表为空');
  for (const action of ['withdraw.something_new', 'order.new_action', 'coupon.new', 'ad.new', 'risk.new', 'merchant.new', 'config.new', 'payment.new']) {
    const [, label, group] = auditMeta(action);
    assert.notStrictEqual(group, 'other', `未登记动作 ${action} 掉进了 other 组，任何分组页签都查不到`);
    assert.ok(AUDIT_GROUPS.includes(group), `未登记动作 ${action} 的兜底分组 "${group}" 非法`);
    assert.ok(typeof label === 'string' && label.trim(), `未登记动作 ${action} 的兜底中文名为空`);
  }
});

test('auditMeta 已登记动作走精确映射（不被前缀兜底覆盖）', () => {
  const { auditMeta } = loadAuditMeta();
  // vm 沙箱里的数组原型与宿主不同，逐项比较而非 deepStrictEqual
  const eq = (action, expected) => assert.deepStrictEqual(Array.from(auditMeta(action)), expected, `auditMeta('${action}') 映射不符`);
  eq('merchant.login_failed', ['alert', '商家登录失败', 'account']);
  eq('admin.password_reset_from_env', ['alert', '管理员口令由环境变量重置', 'account']);
  eq('daily_jobs_error', ['alert', '每日自动任务失败', 'job']);
  eq('risk.loop_free_alert', ['alert', '免费单循环风控告警', 'user']);
  eq('withdraw.issue', ['warn', '提现发起发放', 'pay']);
});
