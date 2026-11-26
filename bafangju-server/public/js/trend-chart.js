// trend-chart.js —— 近 7 日经营趋势图（零依赖内联 SVG）
// 双轴：橙柱 = 实付 GMV（左轴，元）｜ 蓝线 = 有效订单数（右轴，单）
// 设计要点：
//  - 柱宽固定上限（≤30px），不再按槽位等比拉伸，避免"色块过宽"；
//  - 柱顶两角圆角（rect rx 会让底部也变圆，故用 path）；
//  - 左右轴各自 nice 刻度（5 档），订单线全高映射，不再压缩到底部；
//  - 整列 hover 高亮 + 原生 title 明细。
(function (global) {
  'use strict';

  /** 单档步长的 nice 值（1/1.5/2/2.5/3/4/5/6/8/10 × 10^n） */
  function niceStep(raw) {
    if (!(raw > 0)) return 1;
    const exp = Math.floor(Math.log10(raw));
    const base = Math.pow(10, exp);
    const n = raw / base;
    const s = n <= 1 ? 1 : n <= 1.5 ? 1.5 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 3 ? 3 : n <= 4 ? 4 : n <= 5 ? 5 : n <= 6 ? 6 : n <= 8 ? 8 : 10;
    return s * base;
  }

  /** 刻度上限：先求 4 等分的 nice 步长再乘回，保证 5 档刻度整齐且峰值不被压矮 */
  function axisMax(v, integer) {
    let s = niceStep((v > 0 ? v : 1) / 4);
    if (integer) s = Math.max(1, Math.ceil(s)); // 订单轴刻度必须整数
    return s * 4;
  }

  const f1 = (v) => Number(v).toFixed(1);

  function moneyLabel(yuan) {
    if (yuan >= 10000) return '¥' + (Math.round(yuan / 1000) / 10) + '万';
    if (yuan >= 10) return '¥' + Math.round(yuan);
    return '¥' + (Math.round(yuan * 10) / 10);
  }

  /** 顶部两角圆角的柱形路径 */
  function barPath(x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h);
    const b = y + h;
    return `M${f1(x)} ${f1(b)}L${f1(x)} ${f1(y + rr)}Q${f1(x)} ${f1(y)} ${f1(x + rr)} ${f1(y)}`
      + `L${f1(x + w - rr)} ${f1(y)}Q${f1(x + w)} ${f1(y)} ${f1(x + w)} ${f1(y + rr)}L${f1(x + w)} ${f1(b)}Z`;
  }

  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function render(data, opt) {
    const list = (data || []).filter(Boolean);
    if (!list.length) return '<div class="empty">趋势数据暂不可用</div>';
    const o = Object.assign({ W: 780, H: 268, padL: 58, padR: 46, padT: 38, padB: 38 }, opt || {});
    const W = o.W, H = o.H, padL = o.padL, padR = o.padR, padT = o.padT, padB = o.padB;
    const iw = W - padL - padR, ih = H - padT - padB;
    const n = list.length;
    const num = (d, k) => { const v = Number(d[k]); return Number.isFinite(v) ? v : 0; };

    // 金额轴按「元」求刻度，柱子高度更贴合真实峰值（不会顶到过大的上限）
    const maxGmv = axisMax(Math.max(...list.map((d) => num(d, 'gmvFen')), 400) / 100) * 100;
    const maxOrd = Math.max(4, axisMax(Math.max(...list.map((d) => num(d, 'paidOrders')), 1), true));

    const bw = iw / n;
    const barW = Math.min(bw * 0.34, 30); // 柱宽上限：宽屏也不会变成大色块
    const cx = (i) => padL + i * bw + bw / 2;
    const yG = (v) => padT + ih - (v / maxGmv) * ih;
    const yO = (v) => padT + ih - (v / maxOrd) * ih;

    // 网格线 + 左轴（金额）/ 右轴（订单）
    let grid = '';
    for (let i = 0; i <= 4; i++) {
      const f = i / 4, y = padT + ih - f * ih;
      grid += `<line x1="${f1(padL)}" y1="${f1(y)}" x2="${f1(W - padR)}" y2="${f1(y)}" stroke="${i ? '#F1F2F6' : '#E6E8EE'}" stroke-width="1"${i ? ' stroke-dasharray="3 5"' : ''}/>`;
      grid += `<text x="${f1(padL - 10)}" y="${f1(y + 4)}" font-size="11" fill="#9aa0ad" text-anchor="end">${moneyLabel((maxGmv * f) / 100)}</text>`;
      grid += `<text x="${f1(W - padR + 9)}" y="${f1(y + 4)}" font-size="11" fill="#8095D8" text-anchor="start">${Math.round(maxOrd * f)}</text>`;
    }

    const today = todayStr();
    let cols = '', bars = '', xlabels = '', dots = '', pts = [];
    list.forEach((d, i) => {
      const c = cx(i);
      const gmv = num(d, 'gmvFen'), ord = num(d, 'paidOrders'), free = num(d, 'freeOrders');
      const y0 = yG(gmv);
      // 0 值也保留 2.5px 可见高度，且底部严格贴基线（不能向下溢出网格）
      const h = Math.max(padT + ih - y0, 2.5);
      const y = padT + ih - h;
      const yv = yO(ord);
      cols += `<rect class="tc-col" x="${f1(c - bw / 2)}" y="${f1(padT)}" width="${f1(bw)}" height="${f1(ih)}" rx="6"/>`;
      bars += `<path class="tc-bar" d="${barPath(c - barW / 2, y, barW, h, 4)}" fill="url(#gGmv)">`
        + `<title>${d.date}｜GMV ¥${(gmv / 100).toFixed(2)}｜订单 ${ord} 单（免单 ${free}）</title></path>`;
      pts.push(`${f1(c)},${f1(yv)}`);
      dots += `<circle class="tc-dot" cx="${f1(c)}" cy="${f1(yv)}" r="3.4" fill="#2E6BE6" stroke="#fff" stroke-width="1.6">`
        + `<title>${d.date}｜有效订单 ${ord} 单（免单 ${free}）</title></circle>`;
      const isToday = String(d.date) === today;
      const label = isToday ? '今日' : (String(d.date).length > 5 ? String(d.date).slice(5) : String(d.date));
      xlabels += `<text x="${f1(c)}" y="${H - 14}" font-size="11" fill="${isToday ? '#5d636f' : '#9aa0ad'}" font-weight="${isToday ? 600 : 400}" text-anchor="middle">${label}</text>`;
    });

    const legend = `<g transform="translate(${padL},${padT - 20})">`
      + `<rect x="0" y="-9" width="10" height="10" rx="2.5" fill="url(#gGmv)"/>`
      + `<text x="15" y="0" font-size="11.5" fill="#6b7280">实付 GMV（元 · 左轴）</text>`
      + `<line x1="146" y1="-4" x2="164" y2="-4" stroke="#2E6BE6" stroke-width="2.2" stroke-linecap="round"/>`
      + `<circle cx="155" cy="-4" r="3.2" fill="#2E6BE6" stroke="#fff" stroke-width="1.4"/>`
      + `<text x="172" y="0" font-size="11.5" fill="#6b7280">有效订单（单 · 右轴）</text></g>`;

    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="近${n}日经营趋势图">`
      + `<defs><linearGradient id="gGmv" x1="0" y1="0" x2="0" y2="1">`
      + `<stop offset="0" stop-color="#C9525A"/><stop offset="1" stop-color="#B02A30"/></linearGradient></defs>`
      + `${legend}${grid}${cols}${bars}`
      + `<polyline points="${pts.join(' ')}" fill="none" stroke="#2E6BE6" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`
      + `${dots}${xlabels}</svg>`;
  }

  global.TrendChart = { render: render, niceStep: niceStep, axisMax: axisMax, barPath: barPath };
})(typeof window !== 'undefined' ? window : globalThis);
