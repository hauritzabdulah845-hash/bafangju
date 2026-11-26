// 定位能力（附近商家 / 首页共用）：
// - 微信内置地图选点 wx.chooseLocation（免第三方 key，选点返回 POI + 坐标）；
// - 区县级展示名解析（用户认知粒度：天河区/浦东新区），黑名单跳过「自治区/城区」误匹配；
// - globalData 内存态 + storage('bfj_loc') 持久化，重启小程序不丢。
// 默认中心：广州天河（与首页默认定位一致；服务端 nearby 也有同值兜底）。

const DEFAULT_LOC = { name: '天河区', lat: 23.1291, lng: 113.3644, address: '' };

/** 当前定位：内存态优先，storage 兜底，再退默认中心 */
function current(app) {
  const mem = app && app.globalData && app.globalData.loc;
  if (mem && Number.isFinite(mem.lat) && Number.isFinite(mem.lng)) return mem;
  let saved = null;
  try { saved = wx.getStorageSync('bfj_loc') || null; } catch (e) { /* ignore */ }
  if (saved && Number.isFinite(saved.lat) && Number.isFinite(saved.lng)) {
    if (app && app.globalData) app.globalData.loc = saved;
    return saved;
  }
  return DEFAULT_LOC;
}

/**
 * 从完整地址解析展示名。策略：区县级优先，
 * 黑名单跳过「自治区/治区/城区」等后缀误匹配；无区县再取市级兜底（柳州市/延吉市）；
 * 兼容直辖市双重前缀、自治州、东莞直辖镇街等结构
 */
function parseLocName(full, poiName) {
  if (!full) return poiName || DEFAULT_LOC.name;
  const counties = full.match(/([^\s省市区族自]{1,12}(?:区|县|旗))/g) || [];
  for (const c of counties) {
    if (c === '治区' || c === '城区' || c.endsWith('自治区') || c.endsWith('自治县') || c.endsWith('自治旗')) continue;
    return c;
  }
  const cityM = full.match(/([^\s省市区族州]{2,12}市)/);
  if (cityM) return cityM[1];
  return poiName || DEFAULT_LOC.name;
}

/** 选点：成功后代持久化并回调（取消/拒绝静默，保留当前定位） */
function pick(app, onPicked) {
  wx.chooseLocation({
    success: (res) => {
      const full = res.address || '';
      const l = { name: parseLocName(full, res.name), address: full, lat: res.latitude, lng: res.longitude };
      if (app && app.globalData) app.globalData.loc = l;
      try { wx.setStorageSync('bfj_loc', l); } catch (e) { /* ignore */ }
      wx.showToast({ title: '已切换至' + l.name, icon: 'none' });
      if (onPicked) onPicked(l);
    },
  });
}

module.exports = { DEFAULT_LOC, current, pick, parseLocName };
