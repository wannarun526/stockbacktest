const { baseConfig, defineStrategy, num, int } = require('./strategy6_common');

// ============================================================
//  strategy6-1 — 回中軌出場
// ============================================================
//  出場：收盤跌破布林中軌（SMA20）→ 當日收盤平倉
//  最經典的布林突破出場，讓獲利奔跑到趨勢轉弱
//
//  進場（家族共用）：收盤 > BB(20,2.0) 上軌 → 當日尾盤做多 1 口
//  純做多、最多 1 口；共用引擎見 strategy6_common.js
// ============================================================

defineStrategy(module, cliArgs => ({
  id: '6-1',
  name: '回中軌出場',
  rule: '收盤 < 布林中軌 → 收盤平倉',
  config: baseConfig(cliArgs),
  exit: ({ i, bar, ind }) => {
    const mid = ind.bb.mid[i];
    if (mid !== null && bar.close < mid) return { price: bar.close, reason: '跌破中軌' };
    return null;
  },
}));
