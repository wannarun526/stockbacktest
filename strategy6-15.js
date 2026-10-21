const { baseConfig, defineStrategy, num, int } = require('./strategy6_common');

// ============================================================
//  strategy6-15 — 布林帶寬收縮出場
// ============================================================
//  出場：帶寬（上−下）/中 自持有期間高點回落 ≥ shrink% → 收盤平倉
//  波動收斂＝突破動能衰竭
//  參數：--shrink=30
//
//  進場（家族共用）：收盤 > BB(20,2.0) 上軌 → 當日尾盤做多 1 口
//  純做多、最多 1 口；共用引擎見 strategy6_common.js
// ============================================================

defineStrategy(module, cliArgs => ({
  id: '6-15',
  name: '布林帶寬收縮出場',
  rule: '帶寬自持有期間高點回落 ≥ shrink% → 收盤平倉',
  config: { ...baseConfig(cliArgs), shrink: num(cliArgs.shrink, 30) },
  onEntry: ({ i, ind }) => ({ maxWidth: ind.bb.width[i] || 0 }),
  exit: ({ i, bar, ind, pos, cfg }) => {
    const w = ind.bb.width[i];
    if (w !== null && pos.maxWidth > 0 && w <= pos.maxWidth * (1 - cfg.shrink / 100)) {
      return { price: bar.close, reason: `帶寬縮${cfg.shrink}%` };
    }
    return null;
  },
  onBar: ({ i, ind, pos }) => {
    const w = ind.bb.width[i];
    if (w !== null && w > pos.maxWidth) pos.maxWidth = w;
  },
}));
