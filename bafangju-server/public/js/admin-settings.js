// admin-settings.js —— 系统设置（等级门槛 / 规则版本 / 小程序码配置）
// ==================== 系统设置 ====================
async function loadSettings() {
  const [lv, rules] = await Promise.all([
    authed('/api/admin/level-config').then((r) => r.json()).catch(() => ({ levels: [] })),
    authed('/api/admin/rules').then((r) => r.json()).catch(() => ({})),
  ]);
  document.querySelector('#levelTable tbody').innerHTML = (lv.levels || []).map((l) =>
    `<tr><td>${l.level}</td><td>${escHtml(l.name)}</td>
      <td><input id="lv_${l.level}" type="number" min="1" value="${l.threshold}" style="width:120px"></td>
      <td class="muted">${escHtml((l.rights || []).join('、'))}</td></tr>`).join('')
    || '<tr><td colspan="4"><div class="empty"><div class="e-icon">📈</div>等级配置暂未加载，稍后重试</div></td></tr>';
  document.getElementById('rulesVersionNow').textContent = rules.version || '-';
  document.getElementById('rulesUpdatedAt').textContent = (rules.updatedAt || '').replace('T', ' ').slice(0, 19) || '-';
  document.getElementById('rulesConfirmations').textContent = rules.confirmations == null ? 0 : rules.confirmations;
  document.getElementById('rulesNewVersion').value = rules.version || '';
  loadWxmpConfig();
}
async function saveLevelConfig() {
  const thresholds = {};
  document.querySelectorAll('#levelTable input').forEach((i) => { thresholds[i.id.replace('lv_', '')] = Number(i.value); });
  const r = await post('/api/admin/level-config', { thresholds });
  r.error ? toast('失败：' + r.error, 'err') : (document.getElementById('levelResult').textContent = '已保存并生效', toast('等级门槛已保存'));
  if (!r.error) loadSettings();
}
async function saveRulesVersion() {
  const version = document.getElementById('rulesNewVersion').value.trim();
  const r = await post('/api/admin/rules/version', { version });
  r.error ? (document.getElementById('rulesResult').textContent = '失败：' + r.error) : (document.getElementById('rulesResult').textContent = `已切换到 ${r.version}，用户下次下单需重新确认`, toast('规则版本已切换'));
  if (!r.error) loadSettings();
}

// ==================== 小程序码配置 ====================
async function loadWxmpConfig() {
  const r = await authed('/api/admin/settings/wxmp');
  const c = await r.json();
  if (!c || c.error) return;
  document.getElementById('wxmpAppid').value = c.appid || '';
  document.getElementById('wxmpSecret').value = '';
  document.getElementById('wxmpSecret').placeholder = c.secretMasked ? `已保存（${c.secretMasked}），留空表示不修改` : 'AppSecret';
  document.getElementById('wxmpStatus').textContent = c.configured ? '✅ 已配置，可生成小程序码' : '⚠️ 未配置，推广页显示占位码';
  document.getElementById('wxmpSource').textContent = { db: '后台配置', env: '环境变量', none: '无' }[c.source] || c.source;
}
async function saveWxmpConfig() {
  const appid = document.getElementById('wxmpAppid').value.trim();
  const secret = document.getElementById('wxmpSecret').value.trim();
  const r = await post('/api/admin/settings/wxmp', { appid, secret });
  if (r.error) return toast('保存失败：' + r.error, 'err');
  toast('小程序码配置已保存');
  loadWxmpConfig();
}
async function testWxmpConfig() {
  const box = document.getElementById('wxmpPreview');
  box.innerHTML = '<span class="muted">正在生成测试码…</span>';
  const r = await post('/api/admin/settings/wxmp/test', { userId: 'test' });
  if (r.ok && r.base64) {
    box.innerHTML = `<img src="data:image/png;base64,${r.base64}" style="width:160px;height:160px;border:1px solid #eee;border-radius:8px">
      <span class="muted"> 生成成功（scene=test），用户端推广页将显示真实小程序码</span>`;
    toast('小程序码生成成功');
  } else {
    box.innerHTML = `<span class="muted" style="color:#C0392B">生成失败：${escHtml(r.reason || r.error || '未知错误')}</span>`;
    toast('生成失败，请检查 AppID/Secret', 'err');
  }
}

