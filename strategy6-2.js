const { baseConfig, defineStrategy, num, int } = require('./strategy6_common');

// ============================================================
//  strategy6-2 — 跌破下軌出場
// ============================================================
//  出場：收盤跌破布林下軌 → 當日收盤平倉
//  最寬鬆的出場，等同只在通道徹底翻空時才認輸
//
//  進場（家族共用）：收盤 > BB(20,2.0) 上軌 → 當日尾盤做多 1 口
//  純做多、最多 1 口；共用引擎見 strategy6_common.js
// ============================================================

defineStrategy(module, cliArgs => ({
  id: '6-2',
  name: '跌破下軌出場',
  rule: '收盤 < 布林下軌 → 收盤平倉',
  config: baseConfig(cliArgs),
  exit: ({ i, bar, ind }) => {
    const lo = ind.bb.lower[i];
    if (lo !== null && bar.close < lo) return { price: bar.close, reason: '跌破下軌' };
    return null;
  },
}));
