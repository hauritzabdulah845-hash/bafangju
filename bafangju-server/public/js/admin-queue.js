// admin-queue.js —— 队位 / 储备专户 / 跑批任务
// ==================== 队位 / 储备 / 跑批 ====================
async function loadSlots() {
  const list = await authed('/api/admin/queue-slots').then((r) => r.json());
  document.querySelector('#slots tbody').innerHTML = list.map((s) =>
    `<tr><td class="muted">${s.id}</td><td>${escHtml(s.userId)}</td><td><span class="tag ${s.status === 'waiting' ? 'blue' : 'green'}">${s.status}</span></td><td class="muted">${escHtml(s.grantedAt || '')}</td><td>${escHtml(s.lastPaidDate || s.lastSkipDate || '-')}</td></tr>`).join('')
    || '<tr><td colspan="5"><div class="empty"><div class="e-icon">🎯</div>暂无排队号</div></td></tr>';
}
async function deposit() {
  const fen = Math.round(Number(document.getElementById('resFen').value || 0) * 100);
  const body = { source: document.getElementById('resSource').value, fen, ref: 'admin_manual' };
  const r = await post('/api/admin/reserve/deposit', body);
  r.error ? toast('失败：' + r.error, 'err') : (document.getElementById('resBalance').innerHTML = `储备金账户余额：<b class="money">${yuan(r.balanceFen)}</b>`, toast('划入成功'));
}
/** 储备金账户面板加载：之前缺这个入口，点进「储备金账户」只看得到一张空卡片 */
async function loadReserve() {
  const el = document.getElementById('resBalance');
  if (!el) return;
  try {
    const r = await authed('/api/admin/reserve').then((x) => x.json());
    if (r.error) { el.textContent = r.error; return; }
    el.innerHTML = `储备金账户余额：<b class="money">${yuan(r.balanceFen)}</b>`
      + `<span class="muted" style="margin-left:10px">近 ${(r.recent || []).length} 笔流水</span>`;
  } catch (e) {
    el.textContent = '余额加载失败，请点「刷新」重试';
  }
  loadReserveFlows();
}
/** 储备金流水（只读，供财务核对；无数据时留空不占位） */
async function loadReserveFlows() {
  const tb = document.querySelector('#reserveFlows tbody');
  if (!tb) return;
  try {
    const r = await authed('/api/admin/reserve').then((x) => x.json());
    const rows = r.recent || [];
    tb.innerHTML = rows.map((f) => `<tr>
      <td class="muted">${escHtml(String(f.ts || '').slice(0, 16).replace('T', ' '))}</td>
      <td>${f.direction === 'in' ? '<span class="tag green">划入</span>' : '<span class="tag danger">划出</span>'}</td>
      <td>${escHtml(f.source || '')}</td>
      <td class="money">${f.direction === 'in' ? '+' : '-'}${yuan(f.fen)}</td>
      <td class="muted">${escHtml(f.ref || '-')}</td></tr>`).join('')
      || '<tr><td colspan="5"><div class="empty"><div class="e-icon">—</div>暂无流水</div></td></tr>';
  } catch (e) { /* 静默：面板主体已提示失败 */ }
}
// 业务自然日为北京时间（UTC+8）：不能用 toISOString()，否则北京时间 00:00–07:59 会错日，
// 手动跑批（活跃快照/分红/超时退回）会记到前一天。与服务端 src/domain/bizdate.js 口径一致。
function bjToday() { return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10); }
function jobDate() { return document.getElementById('jobDate').value || bjToday(); }
async function post(path, body) {
  const r = await authed(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return r.json();
}
async function runActivity() {
  const r = await post('/api/admin/jobs/activity-snapshot', { date: jobDate() });
  document.getElementById('jobResult').textContent = `① 昨日活跃统计完成：${r.activeUsers} 人`;
  toast(`昨日活跃统计完成：${r.activeUsers} 人`);
}
async function runDividend() {
  const r = await post('/api/admin/jobs/daily-dividend', { date: jobDate() });
  document.getElementById('jobResult').textContent = r.paused ? '② 已暂停发放（降级开关）' : `② 发放 ${r.paidCount} 个号，共 ${yuan(r.paidFen)}，跳过 ${r.skippedCount} 个`;
}
async function runExpire() {
  const r = await post('/api/admin/jobs/expire-transfers', { date: jobDate() });
  document.getElementById('jobResult').textContent = `③ 超时退回 ${r.expiredCount} 笔（${yuan(r.expiredFen)}），重发 ${r.reissued.length} 单`;
}
async function runIssueQueued() {
  const r = await post('/api/admin/jobs/issue-queued', { date: jobDate() });
  document.getElementById('jobResult').textContent = `④ 补发推迟的提现 ${r.results.length} 单`;
}
async function runSettle() {
  const r = await post('/api/admin/jobs/settle-commission', {});
  document.getElementById('jobResult').textContent = `⑤ 到期佣金解冻 ${r.count} 单（冻结 → 余额）`;
}

// ==================== 季度分红 / 团队长辅导分红池（此前只有接口、后台无入口） ====================
function currentQuarter() {
  const d = new Date();
  return `${d.getFullYear()}Q${Math.floor(d.getMonth() / 3) + 1}`;
}
function fillCurrentQuarter() {
  document.getElementById('quarterLabel').value = currentQuarter();
}
function quarterLabel() {
  return (document.getElementById('quarterLabel').value || '').trim();
}
/** 提交前格式校验：后端只接受 YYYYQn（如 2026Q4），非法格式给出明确提示 */
function validQuarterInput() {
  const q = quarterLabel();
  const el = document.getElementById('quarterResult');
  if (!q) {
    if (el) el.textContent = '请填写季度标识，如 2026Q4';
    toast('请填写季度标识，如 2026Q4', 'err');
    return '';
  }
  if (!/^\d{4}Q[1-4]$/.test(q)) {
    if (el) el.textContent = `季度格式不正确：「${q}」应为 YYYYQn（如 2026Q4）`;
    toast('季度格式应为 YYYYQn（如 2026Q4）', 'err');
    return '';
  }
  return q;
}
async function runQuarterAssess() {
  const q = validQuarterInput();
  if (!q) return;
  const r = await post('/api/admin/quarter/assess', { quarter: q });
  const el = document.getElementById('quarterResult');
  if (r.error) { el.textContent = '核算失败：' + r.error; toast('核算失败', 'err'); return; }
  // 接口直接返回资格明细数组（旧结构可能包在 results 中），按实际结构统计合格人数
  const rows = Array.isArray(r) ? r : (r.results || []);
  const eligible = rows.filter((x) => x && x.eligible).length;
  el.textContent = `① ${q} 资格核算完成`;
  document.getElementById('quarterDetail').textContent =
    `合格 ${eligible} 人 · 候选 ${rows.length} 人（明细见操作日志）`;
  toast('资格核算完成');
}
async function runQuarterPayoutAuto() {
  const q = validQuarterInput();
  if (!q) return;
  if (!confirm(`确认按自动口径发放「${q}」季度分红？\n同一季度重复执行不会重复发放；操作全程留痕。`)) return;
  const r = await post('/api/admin/quarter/payout-auto', { quarter: q });
  const el = document.getElementById('quarterResult');
  if (r.error) { el.textContent = '发放失败：' + r.error; toast('发放失败', 'err'); return; }
  el.textContent = `② ${q} 发放完成`;
  document.getElementById('quarterDetail').textContent =
    `发放 ${r.paidCount ?? r.count ?? '-'} 人 · 合计 ${yuan(r.paidFen ?? r.totalFen ?? 0)}${r.idempotent ? ' · 已跳过（本季已发过）' : ''}`;
  toast('季度分红发放完成');
}
async function loadLeaderPool() {
  const d = await authed('/api/admin/leader-pool').then((r) => r.json()).catch(() => null);
  if (!d) { document.getElementById('leaderPoolSummary').textContent = '辅导分红池加载失败'; return; }
  document.getElementById('leaderPoolSummary').innerHTML =
    `池余额 <b class="money">${yuan(d.balanceFen)}</b> · 分配系数 ${d.coefficient ?? '-'} · 有贡献的团队长 ${(d.contributions || []).length} 人`;
  document.querySelector('#leaderPoolTable tbody').innerHTML = (d.contributions || []).map((c) =>
    `<tr><td>${escHtml(c.leaderId)}</td><td class="money">${yuan(c.contributionFen)}</td></tr>`).join('')
    || '<tr><td colspan="2"><div class="empty"><div class="e-icon">🪙</div>本期暂无辅导贡献</div></td></tr>';
}
async function runLeaderDividend() {
  const batchKey = (document.getElementById('leaderBatchKey').value || '').trim();
  if (!confirm(`确认分配团队长辅导分红池？\n批次标识：${batchKey || '默认（今日）'}\n同一批次重复执行不会重复分配。`)) return;
  const r = await post('/api/admin/jobs/leader-dividend', { batchKey: batchKey || undefined });
  const el = document.getElementById('leaderResult');
  if (r.error) { el.textContent = '失败：' + r.error; toast('分配失败', 'err'); return; }
  el.textContent = `批次 ${r.batchKey} 分配完成：${r.paidCount ?? r.count ?? '-'} 人 / ${yuan(r.paidFen ?? r.totalFen ?? 0)}`;
  toast('辅导分红分配完成');
  loadLeaderPool();
}
function loadJobs() {
  loadLeaderPool(); // 进入跑批面板时带出辅导分红池（无需手工刷新）
}
