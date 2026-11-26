// mtab —— 商家工作台伪底栏（分包内组件）
// 背景：合并单小程序后，商家端 4 个主页面位于分包 subpkg-merchant，
// 分包页不能声明为 tabBar 页（tabBar 页必须在主包且 switchTab 只认 tabBar list），
// 因此底栏改为普通组件，页面切换用 wx.redirectTo（保持页面栈深度为 1）。
// 视觉与交互与原 custom-tab-bar 完全一致（图标为内联 SVG，无 PNG 依赖）。
const TAB_ROOT = '/subpkg-merchant/pages/';

Component({
  properties: {
    // 当前选中项 0 工作台 / 1 核销 / 2 收益 / 3 我的
    selected: { type: Number, value: 0 },
  },
  data: {
    list: [
      { pagePath: 'index/index', text: '工作台', icon: 'workbench' },
      { pagePath: 'verify/verify', text: '核销', icon: 'verify' },
      { pagePath: 'earnings/earnings', text: '收益', icon: 'earnings' },
      { pagePath: 'profile/profile', text: '我的', icon: 'me' },
    ],
  },
  methods: {
    // redirectTo 而非 navigateTo：底栏语义是"平级切换"，不应堆叠页面栈
    onTap(e) {
      const { path, index } = e.currentTarget.dataset;
      if (index === this.data.selected) return;
      wx.redirectTo({ url: TAB_ROOT + path });
    },
  },
});
