// filing-badge.js —— 备案信息展示（公安联网备案 / ICP）
// 数据源：GET /api/filing（后台文案中心配置，号留空时对应项为 null）
// 用法：在页面放 <div data-filing></div>（默认 both）或 data-filing="icp" / "police"；
//      引入本脚本后自动渲染；未拿到号时容器保持空（CSS :empty 隐藏），不露出占位文字。
(function () {
  'use strict';

  function safeUrl(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url.trim()) ? url.trim() : '';
  }

  function badge(item, label) {
    if (!item || !item.no) return '';
    var no = String(item.no).trim();
    if (!no) return '';
    var link = safeUrl(item.link);
    var text = link
      ? '<a href="' + link + '" target="_blank" rel="noopener noreferrer">' + no + '</a>'
      : no;
    return '<span class="filing-item">' + (label ? label : '') + text + '</span>';
  }

  function render(data) {
    var nodes = document.querySelectorAll('[data-filing]');
    if (!nodes.length) return;
    data = data || {};
    var html = {
      icp: badge(data.icp, 'ICP备案号：'),
      police: badge(data.police, ''), // 公安备案号自带「公网安备」字样，不加前缀
      both: badge(data.icp, 'ICP备案号：') + badge(data.police, ''),
    };
    nodes.forEach(function (el) {
      var mode = el.getAttribute('data-filing') || 'both';
      el.innerHTML = html[mode] != null ? html[mode] : html.both;
    });
  }

  function load() {
    fetch('/api/filing')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { render(d); })
      .catch(function () { /* 接口不可用时保持隐藏，不影响页面 */ });
  }

  // DOM 就绪后执行（脚本统一放在 body 末尾，通常已就绪）
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load);
  } else {
    load();
  }

  window.refreshFilingBadges = load; // 供页面在动态内容渲染后手动刷新（如 H5「我的」面板）
})();
