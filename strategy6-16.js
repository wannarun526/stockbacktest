const { baseConfig, defineStrategy, num, int } = require('./strategy6_common');

// ============================================================
//  strategy6-16 — 中軌下彎出場
// ============================================================
//  出場：布林中軌（SMA20）當日 < 前一日（趨勢轉下）→ 當日收盤平倉
//  不等價格跌破中軌，中軌本身一轉頭就走
//
//  進場（家族共用）：收盤 > BB(20,2.0) 上軌 → 當日尾盤做多 1 口
//  純做多、最多 1 口；共用引擎見 strategy6_common.js
// ============================================================

defineStrategy(module, cliArgs => ({
  id: '6-16',
  name: '中軌下彎出場',
  rule: '中軌 SMA20 當日 < 前一日 → 收盤平倉',
  config: baseConfig(cliArgs),
  exit: ({ i, bar, ind }) => {
    const m = ind.bb.mid[i], pm = ind.bb.mid[i - 1];
    if (m !== null && pm !== null && m < pm) return { price: bar.close, reason: '中軌下彎' };
    return null;
  },
}));
