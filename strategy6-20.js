const { baseConfig, defineStrategy, num, int } = require('./strategy6_common');

// ============================================================
//  strategy6-20 — Parabolic SAR 翻空出場
// ============================================================
//  出場：SAR(0.02, 0.2) 由多翻空 → 當日收盤平倉
//
//  進場（家族共用）：收盤 > BB(20,2.0) 上軌 → 當日尾盤做多 1 口
//  純做多、最多 1 口；共用引擎見 strategy6_common.js
// ============================================================

defineStrategy(module, cliArgs => ({
  id: '6-20',
  name: 'Parabolic SAR 翻空出場',
  rule: 'SAR 由多翻空 → 收盤平倉',
  config: baseConfig(cliArgs),
  exit: ({ i, bar, ind }) => {
    const now = ind.psar.isLong[i], prev = ind.psar.isLong[i - 1];
    if (now === false && prev === true) return { price: bar.close, reason: 'SAR翻空' };
    return null;
  },
}));
