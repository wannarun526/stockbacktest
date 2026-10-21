const { baseConfig, defineStrategy, num, int } = require('./strategy6_common');

// ============================================================
//  strategy6-14 — 連續黑K出場
// ============================================================
//  出場：連續 N 根收黑（收盤 < 開盤）→ 當日收盤平倉
//  參數：--black=3
//
//  進場（家族共用）：收盤 > BB(20,2.0) 上軌 → 當日尾盤做多 1 口
//  純做多、最多 1 口；共用引擎見 strategy6_common.js
// ============================================================

defineStrategy(module, cliArgs => ({
  id: '6-14',
  name: '連續黑K出場',
  rule: '連續 black 根收黑 → 收盤平倉',
  config: { ...baseConfig(cliArgs), black: int(cliArgs.black, 3) },
  exit: ({ i, bar, bars, cfg }) => {
    for (let j = 0; j < cfg.black; j++) {
      if (i - j < 0 || bars[i - j].close >= bars[i - j].open) return null;
    }
    return { price: bar.close, reason: `連${cfg.black}黑` };
  },
}));
