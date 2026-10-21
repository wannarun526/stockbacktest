const { baseConfig, defineStrategy, num, int } = require('./strategy6_common');

// ============================================================
//  strategy6-6 — ATR 移動停損
// ============================================================
//  出場：盤中最低 ≤（持有期間最高價 − k×ATR(14)）→ 停損價出場
//  停損只上移不下移；最高價取到前一根為止，避免未來函數
//  參數：--atrMult=2
//
//  進場（家族共用）：收盤 > BB(20,2.0) 上軌 → 當日尾盤做多 1 口
//  純做多、最多 1 口；共用引擎見 strategy6_common.js
// ============================================================

defineStrategy(module, cliArgs => ({
  id: '6-6',
  name: 'ATR 移動停損',
  rule: '盤中 ≤ 持有最高 − atrMult×ATR(14) → 出場',
  config: { ...baseConfig(cliArgs), atrMult: num(cliArgs.atrMult, 2) },
  onEntry: ({ i, ind, pos, cfg }) => ({ trail: pos.price - cfg.atrMult * (ind.atr14[i] || 0) }),
  exit: ({ bar, pos }) => (bar.low <= pos.trail ? { price: pos.trail, reason: 'ATR移動停損' } : null),
  onBar: ({ i, ind, pos, cfg }) => {
    const atr = ind.atr14[i];
    if (atr === null) return;
    const lvl = pos.maxHigh - cfg.atrMult * atr;
    if (lvl > pos.trail) pos.trail = lvl;   // 只上移
  },
}));
