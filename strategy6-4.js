const { baseConfig, defineStrategy, num, int } = require('./strategy6_common');

// ============================================================
//  strategy6-4 — 固定百分比停利停損
// ============================================================
//  出場：盤中觸及 進場價 ×(1+tp%) 停利，或 ×(1−sl%) 停損
//  同一根同時觸及時，保守起見以停損優先
//  參數：--tp=5 --sl=3
//
//  進場（家族共用）：收盤 > BB(20,2.0) 上軌 → 當日尾盤做多 1 口
//  純做多、最多 1 口；共用引擎見 strategy6_common.js
// ============================================================

defineStrategy(module, cliArgs => ({
  id: '6-4',
  name: '固定百分比停利停損',
  rule: '盤中 +tp% 停利 / −sl% 停損',
  config: { ...baseConfig(cliArgs), tp: num(cliArgs.tp, 5), sl: num(cliArgs.sl, 3) },
  onEntry: ({ pos, cfg }) => ({
    tpPrice: pos.price * (1 + cfg.tp / 100),
    slPrice: pos.price * (1 - cfg.sl / 100),
  }),
  exit: ({ bar, pos }) => {
    if (bar.low  <= pos.slPrice) return { price: pos.slPrice, reason: '停損' };
    if (bar.high >= pos.tpPrice) return { price: pos.tpPrice, reason: '停利' };
    return null;
  },
}));
