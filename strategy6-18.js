const { baseConfig, defineStrategy, num, int } = require('./strategy6_common');

// ============================================================
//  strategy6-18 — 停利 + 中軌停損（組合）
// ============================================================
//  出場 A：盤中觸及 進場價 ×(1+tp%) → 停利（優先）
//  出場 B：收盤跌破布林中軌 → 收盤平倉
//  參數：--tp=5
//
//  進場（家族共用）：收盤 > BB(20,2.0) 上軌 → 當日尾盤做多 1 口
//  純做多、最多 1 口；共用引擎見 strategy6_common.js
// ============================================================

defineStrategy(module, cliArgs => ({
  id: '6-18',
  name: '停利 + 中軌停損',
  rule: '盤中 +tp% 停利；或收盤 < 中軌平倉',
  config: { ...baseConfig(cliArgs), tp: num(cliArgs.tp, 5) },
  onEntry: ({ pos, cfg }) => ({ tpPrice: pos.price * (1 + cfg.tp / 100) }),
  exit: ({ i, bar, ind, pos, cfg }) => {
    if (bar.high >= pos.tpPrice) return { price: pos.tpPrice, reason: `停利+${cfg.tp}%` };
    const mid = ind.bb.mid[i];
    if (mid !== null && bar.close < mid) return { price: bar.close, reason: '跌破中軌' };
    return null;
  },
}));
