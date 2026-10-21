const { baseConfig, defineStrategy, num, int } = require('./strategy6_common');

// ============================================================
//  strategy6-13 — 跌破進場日最低出場
// ============================================================
//  出場：收盤 < 進場當日的最低價 → 當日收盤平倉
//  把突破日的低點當成這筆交易的防線
//
//  進場（家族共用）：收盤 > BB(20,2.0) 上軌 → 當日尾盤做多 1 口
//  純做多、最多 1 口；共用引擎見 strategy6_common.js
// ============================================================

defineStrategy(module, cliArgs => ({
  id: '6-13',
  name: '跌破進場日最低出場',
  rule: '收盤 < 進場日最低價 → 收盤平倉',
  config: baseConfig(cliArgs),
  exit: ({ bar, pos }) =>
    (bar.close < pos.entryLow ? { price: bar.close, reason: '跌破進場日低點' } : null),
}));
