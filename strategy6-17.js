const { baseConfig, defineStrategy, num, int } = require('./strategy6_common');

// ============================================================
//  strategy6-17 — 海龜式通道出場
// ============================================================
//  出場：收盤 < 過去 10 個交易日（不含當根）的最低價 → 當日收盤平倉
//  Donchian 下軌出場，經典順勢跟蹤
//
//  進場（家族共用）：收盤 > BB(20,2.0) 上軌 → 當日尾盤做多 1 口
//  純做多、最多 1 口；共用引擎見 strategy6_common.js
// ============================================================

defineStrategy(module, cliArgs => ({
  id: '6-17',
  name: '海龜式通道出場',
  rule: '收盤 < 過去10日最低 → 收盤平倉',
  config: baseConfig(cliArgs),
  exit: ({ i, bar, ind }) => {
    const dl = ind.donch[i];
    if (dl !== null && bar.close < dl) return { price: bar.close, reason: '跌破10日低' };
    return null;
  },
}));
