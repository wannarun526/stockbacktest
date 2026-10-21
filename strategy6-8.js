const { baseConfig, defineStrategy, num, int } = require('./strategy6_common');

// ============================================================
//  strategy6-8 — 固定持有天數出場
// ============================================================
//  出場：持有滿 N 個交易日 → 當日收盤平倉
//  時間出場，不看價格；測突破後的動能半衰期
//  參數：--hold=10
//
//  進場（家族共用）：收盤 > BB(20,2.0) 上軌 → 當日尾盤做多 1 口
//  純做多、最多 1 口；共用引擎見 strategy6_common.js
// ============================================================

defineStrategy(module, cliArgs => ({
  id: '6-8',
  name: '固定持有天數出場',
  rule: '持有滿 hold 日 → 收盤平倉',
  config: { ...baseConfig(cliArgs), hold: int(cliArgs.hold, 10) },
  exit: ({ i, bar, pos, cfg }) =>
    (i - pos.idx >= cfg.hold ? { price: bar.close, reason: `持有滿${cfg.hold}日` } : null),
}));
