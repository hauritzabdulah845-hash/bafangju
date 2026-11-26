'use strict';
/**
 * 备案信息展示（公安联网备案 / ICP）—— 单元测试
 * 覆盖：备案字段纳入文案白名单、留空返回 null、公安备案号自动提取 recordcode 拼查询链接、
 *      后台填了完整链接则优先用之、非法链接回落默认入口、ICP 链接固定为工信部。
 */
const test = require('node:test');
const assert = require('node:assert');
const { createStore } = require('../src/store');
const content = require('../src/domain/content');

test('备案字段纳入文案白名单，且可按备案信息分组列出', () => {
  for (const key of ['filing.icpNo', 'filing.policeNo', 'filing.policeLink']) {
    assert.ok(content.KEYS.includes(key), key + ' 应在可配置清单内');
  }
  const defs = content.CONTENT_DEFS.filter((d) => d.group === '备案信息');
  assert.strictEqual(defs.length, 3, '备案信息分组应有 3 个字段');
});

test('备案号未配置时 filingInfo 两项均为 null（前端据此隐藏，不露占位文字）', () => {
  const db = createStore();
  const info = content.filingInfo(db);
  assert.deepStrictEqual(info, { icp: null, police: null });
});

test('填入 ICP 备案号：返回备案号 + 固定工信部查询链接', () => {
  const db = createStore();
  content.setContent(db, { key: 'filing.icpNo', body: '湘ICP备2026000123号' });
  const info = content.filingInfo(db);
  assert.deepStrictEqual(info.icp, { no: '湘ICP备2026000123号', link: content.ICP_QUERY_LINK });
  assert.strictEqual(info.police, null);
});

test('填入公安备案号：自动提取 recordcode 拼官方查询链接', () => {
  const db = createStore();
  content.setContent(db, { key: 'filing.policeNo', body: '湘公网安备 43090002001234号' });
  const info = content.filingInfo(db);
  assert.strictEqual(info.police.no, '湘公网安备 43090002001234号');
  assert.strictEqual(info.police.link, content.POLICE_QUERY_BASE + '?recordcode=43090002001234');
});

test('后台填了完整查询链接则优先使用；非法链接（非 http）回落默认入口', () => {
  const db = createStore();
  content.setContent(db, { key: 'filing.policeNo', body: '湘公网安备 43090002001234号' });
  content.setContent(db, { key: 'filing.policeLink', body: 'https://beian.mps.gov.cn/custom?q=abc' });
  assert.strictEqual(content.filingInfo(db).police.link, 'https://beian.mps.gov.cn/custom?q=abc');

  content.setContent(db, { key: 'filing.policeLink', body: 'javascript:alert(1)' });
  assert.strictEqual(
    content.filingInfo(db).police.link,
    content.POLICE_QUERY_BASE + '?recordcode=43090002001234',
    '非 http(s) 链接必须回落，防止注入',
  );
});

test('公安备案号无数字时回落默认查询入口（不带 recordcode 参数）', () => {
  const db = createStore();
  content.setContent(db, { key: 'filing.policeNo', body: '公网安备 待分配号' });
  assert.strictEqual(content.filingInfo(db).police.link, content.POLICE_QUERY_BASE);
});

test('清空备案号后回到 null（号可随时撤回，前端自动隐藏）', () => {
  const db = createStore();
  content.setContent(db, { key: 'filing.policeNo', body: '湘公网安备 43090002001234号' });
  assert.ok(content.filingInfo(db).police);
  content.resetContent(db, { key: 'filing.policeNo' });
  assert.strictEqual(content.filingInfo(db).police, null);
});
