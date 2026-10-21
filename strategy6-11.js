const { baseConfig, defineStrategy, num, int } = require('./strategy6_common');

// ============================================================
//  strategy6-11 — MACD 柱狀體轉負出場
// ============================================================
//  出場：MACD(12,26,9) 柱狀體由正轉負 → 當日收盤平倉
//
//  進場（家族共用）：收盤 > BB(20,2.0) 上軌 → 當日尾盤做多 1 口
//  純做多、最多 1 口；共用引擎見 strategy6_common.js
// ============================================================

defineStrategy(module, cliArgs => ({
  id: '6-11',
  name: 'MACD 柱轉負出場',
  rule: 'MACD 柱由正轉負 → 收盤平倉',
  config: baseConfig(cliArgs),
  warmup: 40,
  exit: ({ i, bar, ind }) => {
    const h = ind.macd.hist[i], ph = ind.macd.hist[i - 1];
    if (h !== null && ph !== null && ph >= 0 && h < 0) return { price: bar.close, reason: 'MACD柱轉負' };
    return null;
  },
}));
