// 广告工具：激励视频广告统一封装
// - 配置了 AD_UNIT_ID_VIDEO 时使用微信真实激励视频（wx.createRewardedVideoAd）；
// - 未配置（流量主未开通）时降级为「模拟观看 15 秒」，仅用于联调，不产生真实收益，也不会让页面崩溃。
// - 真实广告 onClose 时只有 isEnded 才算完成（防止中途关闭骗取奖励）。
const config = require('../config');

/**
 * 创建激励视频广告实例。
 * @param {Function} onEnded 观看完成回调（真实广告 isEnded 或模拟 15 秒到期）
 * @param {Function} [onError] 出错回调（未看完、加载失败等）
 * @returns {{ show: Function, isReal: boolean } | null} null 表示环境不支持激励视频
 */
function createRewardedVideo(onEnded, onError) {
  const unitId = config.AD_UNIT_ID_VIDEO;
  const realSupported = typeof wx === 'object'
    && typeof wx.createRewardedVideoAd === 'function'
    && typeof unitId === 'string' && unitId.length > 0;

  if (realSupported) {
    const ad = wx.createRewardedVideoAd({ adUnitId: unitId });
    ad.onClose((res) => {
      if (res && res.isEnded) onEnded();
      else onError && onError(new Error('未看完广告，不计奖励'));
    });
    ad.onError((err) => {
      onError && onError(err && err.errMsg ? new Error(err.errMsg) : new Error('广告加载失败'));
    });
    return {
      isReal: true,
      show() {
        return ad.show().catch(() => ad.load().then(() => ad.show()));
      },
    };
  }

  // 降级：模拟观看 15 秒（联调用）
  let timer = null;
  let cancelled = false;
  return {
    isReal: false,
    show() {
      return new Promise((resolve, reject) => {
        if (typeof wx.showLoading === 'function') {
          wx.showLoading({ title: '模拟广告播放中…', mask: true });
        }
        timer = setTimeout(() => {
          if (cancelled) return;
          if (typeof wx.hideLoading === 'function') wx.hideLoading();
          onEnded();
          resolve();
        }, 15100);
      });
    },
    cancel() {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (typeof wx.hideLoading === 'function') wx.hideLoading();
    },
  };
}

module.exports = { createRewardedVideo };
