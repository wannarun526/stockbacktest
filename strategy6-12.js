const { baseConfig, defineStrategy, num, int } = require('./strategy6_common');

// ============================================================
//  strategy6-12 — 均線死叉出場
// ============================================================
//  出場：SMA5 向下穿越 SMA20 → 當日收盤平倉
//
//  進場（家族共用）：收盤 > BB(20,2.0) 上軌 → 當日尾盤做多 1 口
//  純做多、最多 1 口；共用引擎見 strategy6_common.js
// ============================================================

defineStrategy(module, cliArgs => ({
  id: '6-12',
  name: '均線死叉出場',
  rule: 'SMA5 下穿 SMA20 → 收盤平倉',
  config: baseConfig(cliArgs),
  exit: ({ i, bar, ind }) => {
    const f = ind.sma5[i], s = ind.sma20[i], pf = ind.sma5[i - 1], ps = ind.sma20[i - 1];
    if ([f, s, pf, ps].every(v => v !== null) && pf >= ps && f < s) {
      return { price: bar.close, reason: 'SMA5死叉SMA20' };
    }
    return null;
  },
}));
