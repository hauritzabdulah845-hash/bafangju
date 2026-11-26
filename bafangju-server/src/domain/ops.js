'use strict';
/**
 * 首页运营位（轮播运营帧）后台可配。
 *
 * 背景：此前首页轮播的"平台运营帧"写死在小程序包里（OPS_SLIDES），换一次活动就要发版。
 * 本模块把它们落到 opsSlides 表，后台可增删改、排序、上下线，小程序随 /api/home 一起拿到。
 *
 * 设计要点：
 * - 与商家付费广告（ad.js）分开：运营帧是平台自有的，不走审核/档期/计费；
 * - 图片只允许站内 /img/ 或 /uploads/ 路径（防外链，与广告素材同一口径）；
 * - 跳转动作白名单（内置页面），不允许任意 URL —— 小程序内不允许随意跳外链；
 * - 全部写操作留审计。
 */
const { audit } = require('../store');

const ACTIONS = [
  { key: 'returns', label: '阶梯优惠页' },
  { key: 'promotion', label: '推广返利页' },
  { key: 'merchants', label: '附近商家页' },
  { key: 'rules', label: '规则说明页' },
];
const ACTION_KEYS = ACTIONS.map((a) => a.key);
const TONES = [1, 2, 3]; // 运营帧渐变底配色档位（4 留给无图广告帧）

function nowISO() { return new Date().toISOString(); }

/**
 * 合规词拦截：首页轮播是微信审核第一眼看到的位置，不允许出现诱导返利/提现类表述。
 * 之前整改过「好友下单你得返利 · 随时可提」这类文案，这里做硬拦截，防止运营再从后台推回去。
 * 注意只作用于运营帧（本模块），文案配置（content.js）含规则说明等合法场景，不加拦截。
 */
const BANNED_WORDS = ['返利', '返现', '提现', '躺赚', '日结', '稳赚', '包赚', '赚钱'];

function assertCompliant(s, name) {
  const hit = BANNED_WORDS.find((w) => s.includes(w));
  if (hit) throw new Error(`${name}含违规词「${hit}」，首页不允许出现返利/提现类表述`);
}

/** 素材图片：仅允许站内路径，防外链 */
function sanitizeImage(url) {
  if (!url) return '';
  const u = String(url).trim();
  if (!u) return '';
  if (!/^\/(img|uploads)\/[\w\-./]+$/i.test(u)) throw new Error('图片必须为站内 /img/ 或 /uploads/ 路径');
  return u;
}

function text(v, max, name, required) {
  const s = String(v == null ? '' : v).trim();
  if (required && !s) throw new Error(`${name}必填`);
  if (s.length > max) throw new Error(`${name}不超过 ${max} 字`);
  assertCompliant(s, name);
  return s;
}

function view(s) {
  return {
    id: s.id, title: s.title || '', sub: s.sub || '', btn: s.btn || '',
    action: s.action || '', tone: s.tone || 1, emoji: s.emoji || '',
    imageUrl: s.imageUrl || '', sort: s.sort || 0, enabled: s.enabled !== false,
    updatedAt: s.updatedAt || '', updatedBy: s.updatedBy || '',
  };
}

/** 前台：只看启用帧，按 sort 升序 */
function listOpsSlides(db) {
  return db.opsSlides.all()
    .filter((s) => s.enabled !== false)
    .sort((a, b) => (a.sort || 0) - (b.sort || 0))
    .map(view);
}

/** 后台：全部（含停用），按 sort 升序 */
function adminListOpsSlides(db) {
  return [...db.opsSlides.all()].sort((a, b) => (a.sort || 0) - (b.sort || 0)).map(view);
}

function nextSort(db) {
  const max = db.opsSlides.all().reduce((m, s) => Math.max(m, s.sort || 0), 0);
  return max + 1;
}

function createOpsSlide(db, p = {}) {
  const action = String(p.action || '').trim();
  if (!ACTION_KEYS.includes(action)) throw new Error('跳转目标不在可选范围内');
  const tone = Number(p.tone) || 1;
  if (!TONES.includes(tone)) throw new Error('配色档位非法');
  const imageUrl = sanitizeImage(p.imageUrl);
  const row = db.opsSlides.insert({
    // 有素材图时标题可空（成品 banner 文字做在图里，再叠一层会重复）
    title: text(p.title, 24, '标题', !imageUrl),
    sub: text(p.sub, 40, '副标题'),
    btn: text(p.btn, 12, '按钮文案'),
    action,
    tone,
    emoji: text(p.emoji, 4, '图标'),
    imageUrl,
    sort: Number.isFinite(Number(p.sort)) && Number(p.sort) > 0 ? Number(p.sort) : nextSort(db),
    enabled: p.enabled === false ? false : true,
    createdAt: nowISO(), updatedAt: nowISO(), updatedBy: p.operator || 'admin',
  });
  audit(db, p.operator || 'admin', 'ops.slide_create', { id: row.id, title: row.title, action });
  return view(row);
}

function updateOpsSlide(db, p = {}) {
  const s = db.opsSlides.get(String(p.id));
  if (!s) throw new Error('运营帧不存在');
  const patch = { updatedAt: nowISO(), updatedBy: p.operator || 'admin' };
  // 同理：已有素材图（或本次一并设置图）时标题可空
  const effectiveImage = p.imageUrl !== undefined ? String(p.imageUrl || '').trim() : String(s.imageUrl || '');
  if (p.title !== undefined) patch.title = text(p.title, 24, '标题', !effectiveImage);
  if (p.sub !== undefined) patch.sub = text(p.sub, 40, '副标题');
  if (p.btn !== undefined) patch.btn = text(p.btn, 12, '按钮文案');
  if (p.emoji !== undefined) patch.emoji = text(p.emoji, 4, '图标');
  if (p.imageUrl !== undefined) patch.imageUrl = sanitizeImage(p.imageUrl);
  if (p.action !== undefined) {
    const a = String(p.action || '').trim();
    if (!ACTION_KEYS.includes(a)) throw new Error('跳转目标不在可选范围内');
    patch.action = a;
  }
  if (p.tone !== undefined) {
    const t = Number(p.tone);
    if (!TONES.includes(t)) throw new Error('配色档位非法');
    patch.tone = t;
  }
  if (p.sort !== undefined && Number.isFinite(Number(p.sort))) patch.sort = Number(p.sort);
  if (p.enabled !== undefined) patch.enabled = p.enabled === true || p.enabled === 'true';
  db.opsSlides.update(s.id, patch);
  audit(db, p.operator || 'admin', 'ops.slide_update', { id: s.id, patch: Object.keys(patch).join(',') });
  return view(db.opsSlides.get(s.id));
}

function deleteOpsSlide(db, { id, operator = 'admin' } = {}) {
  const s = db.opsSlides.get(String(id));
  if (!s) throw new Error('运营帧不存在');
  db.opsSlides.delete(s.id);
  audit(db, operator, 'ops.slide_delete', { id: s.id, title: s.title });
  return { ok: true };
}

/** 上移/下移：与相邻帧交换 sort，避免手工填序号出错 */
function moveOpsSlide(db, { id, dir, operator = 'admin' } = {}) {
  const s = db.opsSlides.get(String(id));
  if (!s) throw new Error('运营帧不存在');
  const all = [...db.opsSlides.all()].sort((a, b) => (a.sort || 0) - (b.sort || 0));
  const i = all.findIndex((x) => x.id === s.id);
  const j = dir === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= all.length) return view(s); // 已在边界，静默返回
  const a = all[i], b = all[j];
  const as = a.sort || 0, bs = b.sort || 0;
  db.opsSlides.update(a.id, { sort: bs, updatedAt: nowISO(), updatedBy: operator });
  db.opsSlides.update(b.id, { sort: as, updatedAt: nowISO(), updatedBy: operator });
  audit(db, operator, 'ops.slide_move', { id: s.id, dir, from: as, to: bs });
  return adminListOpsSlides(db);
}

/** 旧版首帧的历史图片路径（均已失效或比例不对）：
 *  - /img/products/p_oil.png：1024×1024 方图，在 750×300rpx 通栏位被裁掉约 60%
 *  - /img/banner/ops-ladder.jpg：早期手工配置路径，文件从未落地（线上实测 404，首页断图） */
const LEGACY_FIRST_SLIDE_IMAGES = ['/img/products/p_oil.png', '/img/banner/ops-ladder.jpg'];

/** 默认三帧的成品图（1120×448，5:2，文字已做进图）：
 *  - ladder：阶梯优惠（首帧）
 *  - invite：邀请好友
 *  - nearby：附近好店 */
const DEFAULT_SLIDE_IMAGES = {
  returns: '/img/products/banner_ladder.jpg',
  promotion: '/img/products/banner_invite.jpg',
  merchants: '/img/products/banner_nearby.jpg',
};

/** 旧版默认帧升级：统一换成 5:2 成品 banner（文字已做进图），并清空 title/sub/btn 避免双行文字。
 *  仅命中「标题仍是默认文案 + 动作位匹配」的帧，幂等；运营改过标题的自定义帧不动。 */
function upgradeLegacyDefaultSlide(db) {
  const upgraded = [];
  // 第 2/3 帧：早期只有渐变底 + 代码叠字，现在换成成品图
  const TEXT_DEFAULTS = [
    { title: '邀请好友 一起省钱', action: 'promotion' },
    { title: '附近好店 到店领券', action: 'merchants' },
  ];
  for (const s of db.opsSlides.all()) {
    const isLegacyFirst = LEGACY_FIRST_SLIDE_IMAGES.includes(s.imageUrl)
      && s.action === 'returns'
      && s.title === '买得越多 付得越少';
    const textDefault = TEXT_DEFAULTS.find((d) => d.title === s.title && d.action === s.action);
    const target = textDefault && DEFAULT_SLIDE_IMAGES[s.action];
    if (!isLegacyFirst && !(target && s.imageUrl !== target)) continue;
    const nextImage = isLegacyFirst ? DEFAULT_SLIDE_IMAGES.returns : target;
    s.imageUrl = nextImage;
    s.title = ''; s.sub = ''; s.btn = ''; s.emoji = '';
    s.updatedAt = nowISO(); s.updatedBy = 'system';
    audit(db, 'system', 'ops.slide_update', {
      id: s.id, patch: 'imageUrl,title,sub,btn,emoji',
      reason: isLegacyFirst ? 'legacy_banner_upgrade' : 'default_slide_image_upgrade',
    });
    upgraded.push(s.id);
  }
  return upgraded;
}

/** 首次启用时把前端内置的三条默认帧落库（幂等，仅在表为空时写入） */
function seedDefaultOpsSlides(db) {
  upgradeLegacyDefaultSlide(db); // 老库默认帧升级为成品 banner（不因表非空而跳过）
  if (db.opsSlides.all().length > 0) return [];
  const defs = [
    // 三帧均为成品 banner 图（文字已做进图），故不再下发 title/sub/btn，避免与图上文字重叠
    { title: '', sub: '', btn: '', action: 'returns', tone: 1, imageUrl: DEFAULT_SLIDE_IMAGES.returns },
    { title: '', sub: '', btn: '', action: 'promotion', tone: 2, imageUrl: DEFAULT_SLIDE_IMAGES.promotion },
    { title: '', sub: '', btn: '', action: 'merchants', tone: 3, imageUrl: DEFAULT_SLIDE_IMAGES.merchants },
  ];
  return defs.map((d, i) => db.opsSlides.insert({
    ...d, sort: i + 1, enabled: true, createdAt: nowISO(), updatedAt: nowISO(), updatedBy: 'seed',
  })).map(view);
}

module.exports = {
  ACTIONS, ACTION_KEYS, TONES,
  sanitizeImage,
  listOpsSlides, adminListOpsSlides, createOpsSlide, updateOpsSlide, deleteOpsSlide, moveOpsSlide,
  seedDefaultOpsSlides, view,
};
