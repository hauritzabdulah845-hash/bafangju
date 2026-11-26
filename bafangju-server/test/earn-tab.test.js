'use strict';
/**
 * 「赚实惠」激励入口信息架构回归测试。
 * 覆盖这次调整踩过的真实问题：
 * ① 一个 tab 出现「看视频 / 赚实惠」多个名字（app.json 与自定义 tabBar 各写一套）；
 * ② ads 页「去任务中心」用 switchTab 跳非 tabBar 页，点了静默失败；
 * ③ 首页金刚区固定占一格做「做任务」，与底部 tab 导航重复；
 * ④ 任务中心残留未开通的微信流量主激励视频任务，与商家视频广告语义打架。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MP = path.join(__dirname, '../../bafangju-miniprogram-user');
const read = (p) => fs.readFileSync(path.join(MP, p), 'utf8');

test('底部激励 tab 四处命名统一为「赚实惠」', () => {
  const appJson = JSON.parse(read('app.json'));
  const tab = (appJson.tabBar.list || []).find((i) => i.pagePath === 'pages/ads/ads');
  assert.ok(tab, 'app.json 缺少 ads tab');
  assert.strictEqual(tab.text, '赚实惠');
  assert.match(read('custom-tab-bar/index.js'), /pages\/ads\/ads',\s*text:\s*'赚实惠'/);
  assert.strictEqual(JSON.parse(read('pages/ads/ads.json')).navigationBarTitleText, '赚实惠');
});

test('ads 页具备「看视频 / 做任务」两个分段，且合规口径始终可见', () => {
  const wxml = read('pages/ads/ads.wxml');
  const js = read('pages/ads/ads.js');
  assert.match(wxml, /activeTab === 'video'/);
  assert.match(wxml, /activeTab === 'task'/);
  assert.match(js, /switchSeg\s*\(/, '缺少分段切换方法');
  for (const fn of ['signIn', 'goBrowse', 'goPromotion']) {
    assert.match(js, new RegExp('(^|\\n)\\s*' + fn + '\\('), 'ads.js 缺少任务段方法：' + fn);
  }
  // notice 在分段之外，切换分段时合规声明不消失
  assert.match(wxml, /不能换现金、不能提现、不能转让/);
  const noticeAt = wxml.indexOf('<view class="notice">');
  const lastBlock = wxml.lastIndexOf('</block>');
  assert.ok(noticeAt > lastBlock, '合规声明必须放在两个分段之外，切到任一分段都可见');
});

test('跳转任务中心必须用 navigateTo，全端不得用 switchTab 跳非 tabBar 页', () => {
  const js = read('pages/ads/ads.js');
  assert.match(js, /goTasks\(\)\s*\{\s*wx\.navigateTo\(\{\s*url:\s*'\/pages\/tasks\/tasks'\s*\}\)/,
    'tasks 不是 tabBar 页，switchTab 会静默失败');

  const appJson = JSON.parse(read('app.json'));
  const tabPaths = new Set((appJson.tabBar.list || []).map((i) => i.pagePath));
  const pages = new Set(appJson.pages);
  for (const file of ['pages/ads/ads.js', 'pages/tasks/tasks.js', 'pages/index/index.js']) {
    const src = read(file);
    for (const m of src.matchAll(/wx\.(switchTab|navigateTo)\s*\(\s*\{\s*url\s*:\s*'\/([^'?]+)/g)) {
      const target = m[2];
      assert.ok(pages.has(target), file + ' 跳到未注册页面：' + target);
      if (m[1] === 'switchTab') {
        assert.ok(tabPaths.has(target), file + ' 用 switchTab 跳了非 tabBar 页：' + target);
      }
    }
  }
});

test('首页金刚区不再固定占「做任务」格，类目可排满 10 个', () => {
  const js = read('pages/index/index.js');
  assert.ok(!/__tasks/.test(js), '仍保留固定 __tasks 占位');
  assert.match(js, /categories\.slice\(0,\s*10\)/, '第 10 格应还给真实类目');
  const wxss = read('pages/index/index.wxss');
  assert.ok(!/ic-task/.test(wxss), '固定入口图标样式应一并清理');
});

test('任务中心不再展示未开通的微信流量主激励视频任务', () => {
  const wxml = read('pages/tasks/tasks.wxml');
  const js = read('pages/tasks/tasks.js');
  assert.ok(!/观看激励视频|adTask/.test(wxml));
  assert.ok(!/adUtil|adEnabled|adStatus/.test(js), '残留流量主任务逻辑');
  // 看视频统一由 ads 页的商家视频广告承载
  assert.match(read('pages/ads/ads.js'), /\/api\/ads\/videos/);
});
