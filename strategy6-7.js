const { baseConfig, defineStrategy, num, int } = require('./strategy6_common');

// ============================================================
//  strategy6-7 — 百分比移動停損
// ============================================================
//  出場：盤中最低 ≤ 持有期間最高價 ×(1 − p%) → 停損價出場
//  參數：--trail=5
//
//  進場（家族共用）：收盤 > BB(20,2.0) 上軌 → 當日尾盤做多 1 口
//  純做多、最多 1 口；共用引擎見 strategy6_common.js
// ============================================================

defineStrategy(module, cliArgs => ({
  id: '6-7',
  name: '百分比移動停損',
  rule: '盤中 ≤ 持有最高 ×(1−trail%) → 出場',
  config: { ...baseConfig(cliArgs), trail: num(cliArgs.trail, 5) },
  onEntry: ({ pos, cfg }) => ({ stop: pos.price * (1 - cfg.trail / 100) }),
  exit: ({ bar, pos }) => (bar.low <= pos.stop ? { price: pos.stop, reason: '移動停損' } : null),
  onBar: ({ pos, cfg }) => {
    const lvl = pos.maxHigh * (1 - cfg.trail / 100);
    if (lvl > pos.stop) pos.stop = lvl;
  },
}));
