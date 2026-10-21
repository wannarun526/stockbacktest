const { baseConfig, defineStrategy, num, int } = require('./strategy6_common');

// ============================================================
//  strategy6-5 — 純 ATR 停損（不停利）
// ============================================================
//  出場：盤中最低 ≤ 進場價 − k×ATR(14)（ATR 取進場當日值）
//  只停損不停利，測試「讓趨勢跑到底」的極端
//  參數：--atrMult=2
//
//  進場（家族共用）：收盤 > BB(20,2.0) 上軌 → 當日尾盤做多 1 口
//  純做多、最多 1 口；共用引擎見 strategy6_common.js
// ============================================================

defineStrategy(module, cliArgs => ({
  id: '6-5',
  name: '純 ATR 停損',
  rule: '盤中 ≤ 進場價 − atrMult×ATR(14) → 停損（不設停利）',
  config: { ...baseConfig(cliArgs), atrMult: num(cliArgs.atrMult, 2) },
  onEntry: ({ i, ind, pos, cfg }) => ({
    stop: pos.price - cfg.atrMult * (ind.atr14[i] || 0),
  }),
  exit: ({ bar, pos }) => (bar.low <= pos.stop ? { price: pos.stop, reason: 'ATR停損' } : null),
}));
