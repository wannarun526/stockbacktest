const { baseConfig, defineStrategy, num, int } = require('./strategy6_common');

// ============================================================
//  strategy6-9 — KD 高檔轉折出場
// ============================================================
//  出場：K 值前一日 > 80 且當日 < 80 → 當日收盤平倉
//  參數：--kdLevel=80
//
//  進場（家族共用）：收盤 > BB(20,2.0) 上軌 → 當日尾盤做多 1 口
//  純做多、最多 1 口；共用引擎見 strategy6_common.js
// ============================================================

defineStrategy(module, cliArgs => ({
  id: '6-9',
  name: 'KD 高檔轉折出場',
  rule: 'K 由 kdLevel 上方跌破 → 收盤平倉',
  config: { ...baseConfig(cliArgs), kdLevel: num(cliArgs.kdLevel, 80) },
  exit: ({ i, bar, ind, cfg }) => {
    const k = ind.kd.k[i], pk = ind.kd.k[i - 1];
    if (k !== null && pk !== null && pk > cfg.kdLevel && k < cfg.kdLevel) {
      return { price: bar.close, reason: `K跌破${cfg.kdLevel}` };
    }
    return null;
  },
}));
