const { baseConfig, defineStrategy, num, int } = require('./strategy6_common');

// ============================================================
//  strategy6-19 — 兩段式保本移動停損
// ============================================================
//  第一段：未獲利達 trigger% 前，固定停損 進場價 ×(1−sl%)
//  第二段：盤中曾獲利達 trigger% 後，停損上移為
//            max(進場價, 持有最高 ×(1−trail%))　→ 至少保本
//  參數：--trigger=3 --sl=2 --trail=2
//
//  進場（家族共用）：收盤 > BB(20,2.0) 上軌 → 當日尾盤做多 1 口
//  純做多、最多 1 口；共用引擎見 strategy6_common.js
// ============================================================

defineStrategy(module, cliArgs => ({
  id: '6-19',
  name: '兩段式保本移動停損',
  rule: '達 trigger% 前固定 −sl% 停損；達標後保本並改 trail% 移動停損',
  config: {
    ...baseConfig(cliArgs),
    trigger: num(cliArgs.trigger, 3),
    sl:      num(cliArgs.sl,      2),
    trail:   num(cliArgs.trail,   2),
  },
  onEntry: ({ pos, cfg }) => ({
    stop:  pos.price * (1 - cfg.sl / 100),
    armed: false,
  }),
  exit: ({ bar, pos }) =>
    (bar.low <= pos.stop ? { price: pos.stop, reason: pos.armed ? '保本移動停損' : '初始停損' } : null),
  onBar: ({ bar, pos, cfg }) => {
    if (!pos.armed && bar.high >= pos.price * (1 + cfg.trigger / 100)) pos.armed = true;
    if (pos.armed) {
      const lvl = Math.max(pos.price, pos.maxHigh * (1 - cfg.trail / 100));
      if (lvl > pos.stop) pos.stop = lvl;
    }
  },
}));
