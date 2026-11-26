// admin-content.js —— 内容与运营（首页轮播运营帧 / 文案配置）
// 目标：把此前写死在小程序包里的展示内容搬到后台，改内容不用发版。
// ==================== 首页运营帧 ====================
let OPS_ACTIONS = [];
let OPS_EDIT_ID = '';

async function loadContent() {
  const d = await authed('/api/admin/ops-slides').then((r) => r.json()).catch(() => ({ slides: [], actions: [] }));
  OPS_ACTIONS = d.actions || [];
  const sel = document.getElementById('opsAction');
  if (sel && sel.options.length === 0) {
    sel.innerHTML = OPS_ACTIONS.map((a) => `<option value="${escHtml(a.key)}">${escHtml(a.label)}</option>`).join('');
  }
  const list = d.slides || [];
  document.querySelector('#opsTable tbody').innerHTML = list.map((s, i) => {
    const act = (OPS_ACTIONS.find((a) => a.key === s.action) || {}).label || s.action || '-';
    // 视觉列：有图直接出 5:2 缩略图（等比于 750×300rpx 通栏位），点开看原图；无图回退 emoji / 纯文字帧说明
    const thumb = s.imageUrl
      ? `<a href="${escHtml(s.imageUrl)}" target="_blank" title="查看大图"><img src="${escHtml(s.imageUrl)}" alt="轮播配图" style="width:125px;height:50px;object-fit:cover;border-radius:4px;display:block;border:1px solid #eee"></a>`
      : (s.emoji ? `emoji ${escHtml(s.emoji)}` : '<span class="muted">纯文字</span>');
    const visual = thumb + `<div class="muted" style="font-size:11px">tone ${s.tone}</div>`;
    const sub = s.sub ? `<div class="muted" style="font-size:11px">${escHtml(s.sub)}</div>` : '';
    const btn = s.btn ? `<div class="muted" style="font-size:11px">按钮文字：<b>${escHtml(s.btn)}</b></div>` : '<div class="muted" style="font-size:11px">无按钮</div>';
    const titleCell = s.title ? `<b>${escHtml(s.title)}</b>${sub}` : `<span class="muted">（纯图帧）</span>${sub}`;
    const actRow = `<div class="muted" style="font-size:11px">跳转动作：${escHtml(act)}</div>`;
    const mv = `<button class="sm plain" data-act="opsMove" data-id="${escHtml(s.id)}" data-p1="up" title="上移">↑</button>
                <button class="sm plain" data-act="opsMove" data-id="${escHtml(s.id)}" data-p1="down" title="下移">↓</button>`;
    return `<tr>
      <td><span class="muted">${i + 1}</span></td>
      <td>${titleCell}</td>
      <td>${btn}${actRow}</td>
      <td>${visual}<div class="muted" style="font-size:11px">tone ${s.tone}</div></td>
      <td><span class="tag ${s.enabled ? 'green' : 'gray'}">${s.enabled ? '启用' : '停用'}</span></td>
      <td>${mv}
        <button class="sm" data-act="opsEdit" data-id="${escHtml(s.id)}">编辑</button>
        <button class="sm ghost" data-act="opsToggle" data-id="${escHtml(s.id)}" data-p1="${s.enabled ? 'false' : 'true'}">${s.enabled ? '停用' : '启用'}</button>
        <button class="sm plain" data-act="opsDelete" data-id="${escHtml(s.id)}">删除</button></td></tr>`;
  }).join('') || '<tr><td colspan="6"><div class="empty"><div class="e-icon">🖼️</div>暂无运营帧（小程序端将使用内置兜底帧）</div></td></tr>';
  const hint = document.getElementById('opsHint');
  if (hint) hint.textContent = `共 ${list.length} 帧 · 启用 ${list.filter((s) => s.enabled).length} 帧`;
  await loadContentTexts();
}

// ==================== 文案配置 ====================
let CT_DEFS = [];
let CT_KEY = '';

async function loadContentTexts() {
  const d = await authed('/api/admin/content').then((r) => r.json()).catch(() => ({ defs: [] }));
  CT_DEFS = d.defs || [];
  const groups = {};
  CT_DEFS.forEach((x) => { (groups[x.group] = groups[x.group] || []).push(x); });
  document.getElementById('ctList').innerHTML = Object.keys(groups).map((g) => `
    <div class="ct-group">
      <div class="ct-group-title">${escHtml(g)}</div>
      ${groups[g].map((d) => `
        <div class="ct-item">
          <div class="ct-head"><b>${escHtml(d.title)}</b>
            <span class="tag ${d.custom ? 'green' : 'gray'}">${d.custom ? '已覆盖' : '内置'}</span>
            <span class="muted">${escHtml(d.key)}</span>
            <button class="sm plain" data-act="ctEdit" data-id="${escHtml(d.key)}">${d.custom ? '修改' : '编辑'}</button>
            ${d.custom ? `<button class="sm ghost" data-act="ctReset" data-id="${escHtml(d.key)}">恢复内置</button>` : ''}
          </div>
          <div class="muted ct-note">${escHtml(d.hint || '')} · 上限 ${d.maxLen} 字${d.updatedAt ? ` · 更新于 ${escHtml(String(d.updatedAt).slice(0, 10))}（${escHtml(d.updatedBy || '-')}）` : ''}</div>
        </div>`).join('')}
    </div>`).join('') || '<div class="empty">文案清单加载失败</div>';
  const h = document.getElementById('ctHint');
  if (h) h.textContent = `共 ${CT_DEFS.length} 条 · 已覆盖 ${CT_DEFS.filter((x) => x.custom).length} 条`;
}

function defOf(key) { return CT_DEFS.find((d) => d.key === key) || null; }

async function ctEdit(key) {
  const d = defOf(key);
  if (!d) return;
  CT_KEY = key;
  document.getElementById('ctEditorCard').style.display = '';
  document.getElementById('ctEditorTitle').textContent = '编辑文案 · ' + d.title;
  document.getElementById('ctKeyHint').textContent = `${d.key}｜${d.hint || ''}｜上限 ${d.maxLen} 字${d.multiline ? '（支持换行，分段请用空行）' : ''}`;
  document.getElementById('ctBody').value = d.body || '';
  document.getElementById('ctResult').textContent = '';
  updateCtCount();
  document.getElementById('ctBody').focus();
}
function closeCtEditor() {
  CT_KEY = '';
  document.getElementById('ctEditorCard').style.display = 'none';
}
function updateCtCount() {
  const d = defOf(CT_KEY);
  const n = (document.getElementById('ctBody').value || '').length;
  const el = document.getElementById('ctCount');
  if (!d || !el) return;
  el.innerHTML = n > d.maxLen
    ? `<span class="tag red">已超出 ${n - d.maxLen} 字（上限 ${d.maxLen}）</span>`
    : `已输入 ${n} / ${d.maxLen} 字${n === 0 ? '　（清空并保存 = 恢复小程序内置文案）' : ''}`;
}
async function saveContentText() {
  const d = defOf(CT_KEY);
  if (!d) return;
  const body = document.getElementById('ctBody').value || '';
  const r = await post('/api/admin/content/update', { key: CT_KEY, body });
  const el = document.getElementById('ctResult');
  if (r && r.error) { el.textContent = '失败：' + r.error; toast('保存失败：' + r.error, 'err'); return; }
  el.textContent = body ? '已保存，用户端下次进入生效' : '已清空，回落小程序内置文案';
  toast('文案已保存');
  closeCtEditor();
  loadContentTexts();
}
async function ctReset(key) {
  const d = defOf(key);
  if (!confirm(`确认把「${d ? d.title : key}」恢复为小程序内置文案？后台填写的内容将被清除。`)) return;
  const r = await post('/api/admin/content/reset', { key });
  r && r.error ? toast('恢复失败：' + r.error, 'err') : toast('已恢复内置');
  closeCtEditor();
  loadContentTexts();
}

function openOpsEditor(id) {
  OPS_EDIT_ID = id || '';
  document.getElementById('opsEditorCard').style.display = '';
  document.getElementById('opsEditorTitle').textContent = id ? '编辑运营帧' : '新增运营帧';
  document.getElementById('opsResult').textContent = '';
  if (!id) {
    ['opsTitle', 'opsSub', 'opsBtn', 'opsEmoji', 'opsImage'].forEach((k) => { document.getElementById(k).value = ''; });
    document.getElementById('opsEnabled').value = 'true';
    document.getElementById('opsTone').value = '1';
    renderOpsPreview();
    return;
  }
  authed('/api/admin/ops-slides').then((r) => r.json()).then((d) => {
    const s = (d.slides || []).find((x) => x.id === id);
    if (!s) return;
    document.getElementById('opsTitle').value = s.title || '';
    document.getElementById('opsSub').value = s.sub || '';
    document.getElementById('opsBtn').value = s.btn || '';
    document.getElementById('opsEmoji').value = s.emoji || '';
    document.getElementById('opsImage').value = s.imageUrl || '';
    document.getElementById('opsAction').value = s.action || '';
    document.getElementById('opsTone').value = String(s.tone || 1);
    document.getElementById('opsEnabled').value = s.enabled ? 'true' : 'false';
    renderOpsPreview();
  });
}
function closeOpsEditor() {
  OPS_EDIT_ID = '';
  document.getElementById('opsEditorCard').style.display = 'none';
}

// 首页运营帧合规词（与后端 ops.js 的 BANNED_WORDS 保持一致）：
// 首页是微信审核第一眼看到的位置，返利/提现类表述必须先在前端拦下来，不用等提交后报错。
const OPS_BANNED = ['返利', '返现', '提现', '躺赚', '日结', '稳赚', '包赚', '赚钱'];
function opsBannedHit(text) {
  const s = String(text || '');
  return OPS_BANNED.find((w) => s.includes(w)) || '';
}

async function saveOpsSlide() {
  const body = {
    title: document.getElementById('opsTitle').value.trim(),
    sub: document.getElementById('opsSub').value.trim(),
    btn: document.getElementById('opsBtn').value.trim(),
    emoji: document.getElementById('opsEmoji').value.trim(),
    imageUrl: document.getElementById('opsImage').value.trim(),
    action: document.getElementById('opsAction').value,
    tone: Number(document.getElementById('opsTone').value),
    enabled: document.getElementById('opsEnabled').value === 'true',
  };
  // 保存前先做合规自查，任一字段命中直接拦下
  const hit = opsBannedHit(body.title) || opsBannedHit(body.sub) || opsBannedHit(body.btn);
  if (hit) {
    const el = document.getElementById('opsResult');
    el.textContent = `文案含违规词「${hit}」，首页不允许出现返利/提现类表述，请修改后再保存`;
    toast(`含违规词「${hit}」，请修改`, 'err');
    return;
  }
  if (OPS_EDIT_ID) body.id = OPS_EDIT_ID;
  const url = OPS_EDIT_ID ? '/api/admin/ops-slides/update' : '/api/admin/ops-slides';
  const r = await post(url, body);
  const el = document.getElementById('opsResult');
  if (r && r.error) { el.textContent = '失败：' + r.error; toast('保存失败：' + r.error, 'err'); return; }
  el.textContent = '已保存，小程序首页刷新即生效';
  toast('运营帧已保存');
  closeOpsEditor();
  loadContent();
}

async function opsEdit(id) { openOpsEditor(id); }

async function opsToggle(id, enabled) {
  const r = await post('/api/admin/ops-slides/update', { id, enabled: enabled === 'true' || enabled === true });
  if (r && r.error) toast('操作失败：' + r.error, 'err'); else toast(enabled === 'true' ? '已启用' : '已停用');
  loadContent();
}

async function opsMove(id, dir) {
  const r = await post('/api/admin/ops-slides/move', { id, dir });
  if (r && r.error) toast('排序失败：' + r.error, 'err');
  loadContent();
}

async function opsDelete(id) {
  if (!confirm('确认删除这一运营帧？删除后小程序端将回落到内置兜底帧。')) return;
  const r = await post('/api/admin/ops-slides/delete', { id });
  if (r && r.error) toast('删除失败：' + r.error, 'err'); else toast('已删除');
  closeOpsEditor();
  loadContent();
}

/** 上传配图：走 /api/admin/upload（后台身份，落公开目录） */
function openOpsFile() {
  const el = document.getElementById('opsFile');
  if (el) el.click();
}
async function uploadOpsImage(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  if (file.size > 4 * 1024 * 1024) { toast('图片不能超过 4MB', 'err'); input.value = ''; return; }
  const dataBase64 = await new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = () => rej(new Error('读取失败'));
    fr.readAsDataURL(file);
  }).catch(() => null);
  if (!dataBase64) { toast('图片读取失败', 'err'); input.value = ''; return; }
  const r = await post('/api/admin/upload', { dataBase64 });
  if (r && r.url) {
    document.getElementById('opsImage').value = r.url;
    toast('图片已上传');
    renderOpsPreview();
  } else {
    toast('上传失败：' + ((r && r.error) || '未知错误'), 'err');
  }
  input.value = '';
}

// ==================== 运营帧实时预览 ====================
// 1px = 2rpx（375pt 屏真机等比），样式逐条对应小程序 pages/index/index.wxss 的 slide 规则：
// tone 渐变 / aspectFill(=cover) / 左侧压暗 / 底部压暗 / 白字标题 / 半透明胶囊副标 / 白底红字按钮。
const OPS_TONE_BG = {
  1: 'linear-gradient(120deg,#B02A30,#8F1F26)',
  2: 'linear-gradient(120deg,#C9525A,#B02A30)',
  3: 'linear-gradient(120deg,#8F1F26,#621418)',
};
function escAttr(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

function renderOpsPreview() {
  const box = document.getElementById('opsPreview');
  if (!box) return;
  const v = (id) => (document.getElementById(id) || {}).value || '';
  const o = {
    title: v('opsTitle').trim(), sub: v('opsSub').trim(), btn: v('opsBtn').trim(),
    emoji: v('opsEmoji').trim(), image: v('opsImage').trim(),
    tone: Number(v('opsTone')) || 1, enabled: v('opsEnabled') !== 'false',
  };
  const bg = OPS_TONE_BG[o.tone] || OPS_TONE_BG[1];
  // 压暗层与小程序 wxml 同条件：有 sub/btn 用左侧渐变压暗；纯「图+标题」用底部压暗；纯图帧不压
  let shade = '';
  if (o.sub || o.btn) shade = 'position:absolute;inset:0;background:linear-gradient(90deg,rgba(0,0,0,.42) 0%,rgba(0,0,0,.24) 40%,rgba(0,0,0,.06) 72%,rgba(0,0,0,0) 100%)';
  else if (o.image && o.title) shade = 'position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,0) 58%,rgba(0,0,0,.3) 100%)';
  const emoji = o.emoji ? `<div style="position:absolute;right:7px;bottom:-7px;font-size:70px;line-height:1;opacity:.26">${escHtml(o.emoji)}</div>` : '';
  const subPill = o.sub ? `<span style="background:rgba(255,255,255,.16);color:#fff;border:1px solid rgba(255,255,255,.44);font-size:11px;border-radius:999px;padding:4px 10px">${escHtml(o.sub)}</span>` : '';
  const btnPill = o.btn ? `<span style="margin-left:6px;background:rgba(255,255,255,.94);color:#8F1F26;font-size:12px;font-weight:600;border-radius:999px;padding:4px 11px;box-shadow:0 1px 4px rgba(0,0,0,.10)">${escHtml(o.btn)} ›</span>` : '';
  const body = o.title
    ? `<div style="position:relative;padding-left:14px"><div style="font-size:17px;font-weight:800;color:#fff;letter-spacing:.5px;line-height:1.26">${escHtml(o.title)}</div>`
      + (subPill || btnPill ? `<div style="display:flex;flex-wrap:wrap;align-items:center;margin-top:8px;padding-right:12px">${subPill}${btnPill}</div>` : '')
      + '</div>'
    : '';
  const img = o.image
    ? `<img src="${escAttr(o.image)}" alt="配图" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover" onerror="this.style.display='none';this.parentNode.dataset.broken='1'" onload="opsPreviewImgLoaded(this)">`
    : '';
  box.innerHTML = `<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
    <div style="position:relative;width:375px;height:150px;overflow:hidden;border-radius:6px;background:${bg};display:flex;flex-direction:column;justify-content:center;${o.enabled ? '' : 'filter:grayscale(1) opacity(.55)'}">${img}${shade ? `<div style="${shade}"></div>` : ''}${emoji}${body}</div>
    <div class="muted" style="font-size:11px;max-width:220px">
      用户端首页通栏 750×300rpx（5:2）真机等比预览<br>
      ${o.image ? (o.title ? '图 + 代码叠字（注意成品图勿再叠字）' : '纯图帧：不叠字、不压暗') : '无图：tone 渐变底'}<br>
      <span id="opsPreviewImgInfo"></span>
      ${o.enabled ? '' : '<span style="color:#C2410C">已停用（仅预览置灰示意）</span>'}
    </div>
  </div>`;
}

/** 配图比例自检：首帧通栏 5:2，方图会被 aspectFill 裁掉大半（历史踩过 p_oil.png 1024×1024 的坑） */
function opsPreviewImgLoaded(img) {
  const el = document.getElementById('opsPreviewImgInfo');
  if (!el || !img) return;
  const w = img.naturalWidth || 0; const h = img.naturalHeight || 0;
  if (!w || !h) return;
  const ratio = w / h;
  const ok = Math.abs(ratio - 2.5) < 0.06;
  el.textContent = `配图 ${w}×${h}（${ratio.toFixed(2)}:1）· ` + (ok ? '比例合规' : '建议 1125×450（5:2），当前比例会被裁切');
  el.style.color = ok ? '' : '#C2410C';
}

// 输入即刷新预览（脚本在 body 末尾加载，DOM 已就绪；只绑一次）
(function () {
  ['opsTitle', 'opsSub', 'opsBtn', 'opsEmoji', 'opsImage', 'opsTone', 'opsEnabled'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) { el.addEventListener('input', renderOpsPreview); el.addEventListener('change', renderOpsPreview); }
  });
  renderOpsPreview();
})();
