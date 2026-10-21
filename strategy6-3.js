const { baseConfig, defineStrategy, num, int } = require('./strategy6_common');

// ============================================================
//  strategy6-3 — 跌回軌內出場
// ============================================================
//  出場：收盤跌回布林上軌之下 → 當日收盤平倉
//  最緊的出場，突破動能一消失就走
//
//  進場（家族共用）：收盤 > BB(20,2.0) 上軌 → 當日尾盤做多 1 口
//  純做多、最多 1 口；共用引擎見 strategy6_common.js
// ============================================================

defineStrategy(module, cliArgs => ({
  id: '6-3',
  name: '跌回軌內出場',
  rule: '收盤 < 布林上軌 → 收盤平倉',
  config: baseConfig(cliArgs),
  exit: ({ i, bar, ind }) => {
    const up = ind.bb.upper[i];
    if (up !== null && bar.close < up) return { price: bar.close, reason: '跌回軌內' };
    return null;
  },
}));
