'use strict';
/**
 * 首页轮播首帧：成品 banner（5:2）+ 纯图帧（文字做进图，不再代码叠字）回归。
 * 背景：原首帧用 1024×1024 方图 p_oil.png，在 750×300rpx 通栏位被 aspectFill 裁掉约 60%，
 * 且图与代码叠字同时存在；改为 1120×448（2.5:1）成品图后须清空 title/sub/btn。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createStore } = require('../src/store');
const ops = require('../src/domain/ops');

const ROOT = path.join(__dirname, '../..');
const PUB = path.join(ROOT, 'bafangju-server/public');
const USER = path.join(ROOT, 'bafangju-miniprogram-user');

/** 读 JPEG 尺寸（SOF0/SOF2 段），避免为测试引入图像库 */
function jpegSize(buf) {
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker)) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

test('三帧 banner 资产均为 5:2（匹配 750×300rpx 通栏，无裁切）', () => {
  for (const name of ['banner_ladder.jpg', 'banner_invite.jpg', 'banner_nearby.jpg']) {
    const p = path.join(PUB, 'img/products', name);
    assert.ok(fs.existsSync(p), name + ' 资源缺失');
    const size = jpegSize(fs.readFileSync(p));
    assert.ok(size, name + ' 无法解析尺寸');
    assert.ok(size.w >= 750 && size.h >= 300, `${name} 分辨率不足：${size.w}×${size.h}`);
    const ratio = size.w / size.h;
    assert.ok(Math.abs(ratio - 2.5) < 0.01, `${name} 比例必须 2.5:1（750×300rpx），实际 ${ratio.toFixed(3)}`);
    assert.ok(fs.statSync(p).size < 400 * 1024, name + ' 体积过大（>400KB），首屏会拖慢');
  }
});

test('播种三帧均为纯图帧：有图无文字，避免双行文字', () => {
  const db = createStore();
  const seeded = ops.seedDefaultOpsSlides(db);
  assert.strictEqual(seeded.length, 3);
  const list = ops.listOpsSlides(db);
  const expect = [
    { img: /banner_ladder\.jpg$/, action: 'returns' },
    { img: /banner_invite\.jpg$/, action: 'promotion' },
    { img: /banner_nearby\.jpg$/, action: 'merchants' },
  ];
  expect.forEach((e, i) => {
    assert.match(list[i].imageUrl, e.img, `第 ${i + 1} 帧图片不对`);
    assert.strictEqual(list[i].title + list[i].sub + list[i].btn, '', `第 ${i + 1} 帧为成品图，不得再叠代码文字`);
    assert.ok(!list[i].emoji, `第 ${i + 1} 帧不得再挂 emoji（会压在图上）`);
    assert.strictEqual(list[i].action, e.action, `第 ${i + 1} 帧点击动作不对`);
  });
});

test('老库首帧自动升级：仅命中默认种子帧，运营改过的不动', () => {
  const db = createStore();
  // 还原旧版种子帧
  db.opsSlides.insert({
    title: '买得越多 付得越少', sub: '全品类阶梯好物 · 尾段 4 单让利 10%~40%', btn: '查看我的阶梯',
    action: 'returns', tone: 1, imageUrl: '/img/products/p_oil.png', sort: 1, enabled: true,
  });
  // 线上实际存在的历史路径（/img/banner/ops-ladder.jpg 文件从未落地 → 首页断图），同样要升级
  db.opsSlides.insert({
    title: '买得越多 付得越少', action: 'returns', tone: 1, imageUrl: '/img/banner/ops-ladder.jpg', sort: 2, enabled: true,
  });
  // 运营自己配的一帧（同样用 p_oil，但改过标题）不应被升级
  db.opsSlides.insert({
    title: '双十一专场', action: 'returns', tone: 2, imageUrl: '/img/products/p_oil.png', sort: 3, enabled: true,
  });
  // 第 2/3 帧仍是「渐变底 + 代码叠字」的老形态
  db.opsSlides.insert({
    title: '邀请好友 一起省钱', sub: '把好物分享给朋友 · 一起买更划算', btn: '去邀请好友',
    action: 'promotion', tone: 2, emoji: '🎁', imageUrl: '', sort: 4, enabled: true,
  });
  db.opsSlides.insert({
    title: '附近好店 到店领券', sub: '异业联盟门店 · 走路就能到', btn: '逛逛附近',
    action: 'merchants', tone: 3, emoji: '🏪', imageUrl: '/img/products/p_oil.png', sort: 5, enabled: true,
  });
  ops.seedDefaultOpsSlides(db);
  const list = ops.listOpsSlides(db);
  assert.match(list[0].imageUrl, /banner_ladder\.jpg$/, '默认帧应升级为新 banner');
  assert.strictEqual(list[0].title, '', '升级后清空代码叠字');
  assert.match(list[1].imageUrl, /banner_ladder\.jpg$/, '历史断图路径同样应升级');
  assert.strictEqual(list[1].title + list[1].sub + list[1].btn, '', '断图帧升级后同样清空叠字');
  assert.match(list[2].imageUrl, /p_oil\.png$/, '运营自定义帧不得被改写');
  assert.strictEqual(list[2].title, '双十一专场');
  // 第 2/3 帧：换成成品图并清空叠字与 emoji
  assert.match(list[3].imageUrl, /banner_invite\.jpg$/, '邀请帧应换成成品图');
  assert.strictEqual(list[3].title + list[3].sub + list[3].btn + (list[3].emoji || ''), '', '邀请帧升级后清空叠字');
  assert.match(list[4].imageUrl, /banner_nearby\.jpg$/, '附近帧应换成成品图');
  assert.strictEqual(list[4].title + list[4].sub + list[4].btn + (list[4].emoji || ''), '', '附近帧升级后清空叠字');
  // 幂等：再次播种不重复变更
  const before = JSON.stringify(ops.listOpsSlides(db));
  ops.seedDefaultOpsSlides(db);
  assert.strictEqual(JSON.stringify(ops.listOpsSlides(db)), before, '重复播种不得再次改写（幂等）');
  assert.match(ops.listOpsSlides(db)[0].imageUrl, /banner_ladder\.jpg$/);
});

test('纯图帧在后台可编辑（有图时标题允许为空）', () => {
  const db = createStore();
  ops.seedDefaultOpsSlides(db);
  const first = ops.listOpsSlides(db)[0];
  const r = ops.updateOpsSlide(db, { id: first.id, title: '', sub: '', btn: '', operator: 'admin' });
  assert.strictEqual(r.title, '', '纯图帧保存空标题不应报错');
  // 无图帧仍强制标题，防止空帧
  assert.throws(() => ops.createOpsSlide(db, { action: 'returns', tone: 1, title: '' }), /标题/);
});

test('小程序端：兜底帧与 shade 逻辑同步（三帧纯图、不压暗、不被过滤）', () => {
  const idx = fs.readFileSync(path.join(USER, 'pages/index/index.js'), 'utf8');
  for (const name of ['banner_ladder', 'banner_invite', 'banner_nearby']) {
    assert.match(idx, new RegExp(name + '\\.jpg'), `前端兜底帧应包含 ${name}.jpg`);
  }
  assert.ok(!/title: '买得越多 付得越少'.{0,120}image: api\.BASE_URL \+ '\/img\/products\/p_oil\.png'/.test(idx),
    '前端不得再以 p_oil 方图 + 叠字渲染首帧');
  assert.ok(!/邀请好友 一起省钱/.test(idx), '兜底帧已换成成品图，不应再保留文字叠层');
  assert.match(idx, /filter\(\(s\) => s && \(s\.title \|\| s\.imageUrl\)\)/, '纯图运营帧不能被 title 过滤掉');
  const wxml = fs.readFileSync(path.join(USER, 'pages/index/index.wxml'), 'utf8');
  assert.match(wxml, /wx:elif="\{\{item\.image && item\.title\}\}"/, '无文字帧不应叠压暗层');
});

test('后台「运营帧」图片管理：列表缩略图 + 真机等比实时预览（opsPreview 不得再是死占位）', () => {
  const js = fs.readFileSync(path.join(PUB, 'js/admin-content.js'), 'utf8');
  // 列表视觉列出 5:2 缩略图（125×50），运营在列表里直接看到 banner 效果
  assert.match(js, /width:125px;height:50px;object-fit:cover/, '列表应有 5:2 缩略图');
  assert.match(js, /（纯图帧）/, '无标题纯图帧应有可读的占位说明，标题列不得空白');
  // 实时预览：1px=2rpx 真机等比（375×150），必须实现渲染并随输入联动
  assert.match(js, /function renderOpsPreview\(\)/, '必须实现 opsPreview 渲染函数');
  assert.match(js, /width:375px;height:150px/, '预览画布应为 375×150（=750×300rpx 真机等比）');
  assert.match(js, /object-fit:cover/, '预览图必须 aspectFill(cover) 同小程序');
  ['opsTitle', 'opsSub', 'opsBtn', 'opsEmoji', 'opsImage', 'opsTone', 'opsEnabled'].forEach((id) => {
    assert.ok(js.includes(`'${id}'`), `预览应联动字段 ${id}`);
  });
  assert.match(js, /addEventListener\('input', renderOpsPreview\)/, '输入即刷新预览');
  assert.match(js, /toast\('图片已上传'\);\s*\n\s*renderOpsPreview\(\)/, '上传配图成功后必须刷新预览');
  // 压暗层条件与小程序 wxml 保持一致：sub/btn 左压暗、图+标题底压暗、纯图不压
  assert.match(js, /if \(o\.sub \|\| o\.btn\)/, '预览压暗条件须与 wxml 一致');
  assert.match(js, /else if \(o\.image && o\.title\)/, '预览底部压暗条件须与 wxml 一致');
  // 上传即自检比例：防止方图（如历史 p_oil.png 1024×1024）被裁 60% 却看不出来
  assert.match(js, /function opsPreviewImgLoaded/, '配图须做尺寸/比例自检');
  assert.match(js, /Math\.abs\(ratio - 2\.5\) < 0\.06/, '比例判定为 5:2（±6%）');
  const ads = fs.readFileSync(path.join(PUB, 'js/admin-ads.js'), 'utf8');
  assert.match(ads, /function slotBookImgLoaded/, '商家代投素材同样须做比例自检');
  assert.match(ads, /width:240px;height:96px;object-fit:cover/, '代投素材预览须按 5:2 裁切口径展示');
  assert.match(ads, /width:125px;height:50px;object-fit:cover/, '待审核投放列表须直接出缩略图，不能只给文字链接');
});
