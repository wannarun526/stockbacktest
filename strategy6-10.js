const { baseConfig, defineStrategy, num, int } = require('./strategy6_common');

// ============================================================
//  strategy6-10 — RSI 超買出場
// ============================================================
//  出場：RSI(14) > 70 → 當日收盤平倉
//  突破後遇過熱就獲利了結
//  參數：--rsiLevel=70
//
//  進場（家族共用）：收盤 > BB(20,2.0) 上軌 → 當日尾盤做多 1 口
//  純做多、最多 1 口；共用引擎見 strategy6_common.js
// ============================================================

defineStrategy(module, cliArgs => ({
  id: '6-10',
  name: 'RSI 超買出場',
  rule: 'RSI(14) > rsiLevel → 收盤平倉',
  config: { ...baseConfig(cliArgs), rsiLevel: num(cliArgs.rsiLevel, 70) },
  exit: ({ i, bar, ind, cfg }) => {
    const r = ind.rsi14[i];
    if (r !== null && r > cfg.rsiLevel) return { price: bar.close, reason: `RSI>${cfg.rsiLevel}` };
    return null;
  },
}));
