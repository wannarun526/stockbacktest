const fs = require('fs');
const path = require('path');
const { parseCli, loadBars, buildIndicators, runStrategy6 } = require('./strategy6_common');

// ============================================================
//  strategy6 家族 — 20 種出場機制一次跑完並排名
// ============================================================
//  進場固定：收盤 > BB(20,2.0) 上軌 → 尾盤做多 1 口
//  出場：strategy6-1.js ~ strategy6-20.js
//
//  用法：
//    node strategy6_compare.js
//    node strategy6_compare.js --sortBy=mar          # pnl | pf | mar | winRate | avgPnl
//    node strategy6_compare.js --oos=2016-01-01      # 另跑前/後兩段，檢查穩健度
//    node strategy6_compare.js --startDate=2015-01-01
//    node strategy6_compare.js --slippage=2          # 全部加 2 點滑價
// ============================================================

const cliArgs = parseCli(process.argv);
const IDS = Array.from({ length: 20 }, (_, i) => i + 1);

function runAll(startDate, endDate) {
  const args = { ...cliArgs };
  if (startDate) args.startDate = startDate;
  if (endDate)   args.endDate   = endDate;

  let bars = null, ind = null;
  return IDS.map(n => {
    const { makeSpec } = require(`./strategy6-${n}`);
    const spec = makeSpec(args);
    if (!bars) { bars = loadBars(spec.config); ind = buildIndicators(bars, spec.config); }
    return runStrategy6({ ...spec, bars, ind });
  });
}

const SORTERS = {
  pnl:     (a, b) => b.summary.totalPnl - a.summary.totalPnl,
  pf:      (a, b) => (b.summary.profitFactor || 0) - (a.summary.profitFactor || 0),
  mar:     (a, b) => b.summary.pnlToMaxDD - a.summary.pnlToMaxDD,
  winRate: (a, b) => b.summary.winRate - a.summary.winRate,
  avgPnl:  (a, b) => b.summary.avgPnl - a.summary.avgPnl,
  pct:     (a, b) => b.summary.pctSum - a.summary.pctSum,
  pctCmp:  (a, b) => b.summary.pctCompound - a.summary.pctCompound,
};

const fmt = (v, w) => String(Math.round(v).toLocaleString()).padStart(w);

function printTable(reports, title, sortBy) {
  const sorted = [...reports].sort(SORTERS[sortBy] || SORTERS.pnl);
  console.log('\n' + '='.repeat(118));
  console.log(title + `（依 ${sortBy} 排序）`);
  console.log('='.repeat(118));
  console.log('  #  策略   出場機制                        交易   勝率     總損益      獲利因子  最大回撤   損益/回撤  累計%   平均%/筆  持有');
  console.log('-'.repeat(118));
  sorted.forEach((r, rank) => {
    const s = r.summary;
    console.log(
      `${String(rank + 1).padStart(3)}  ${r.id.padEnd(6)} ${r.exitRule.slice(0, 28).padEnd(30)}` +
      `${String(s.totalTrades).padStart(5)} ${String(s.winRate).padStart(6)}% ` +
      `${fmt(s.totalPnl, 12)} ` +
      `${String(s.profitFactor === null ? '∞' : s.profitFactor).padStart(8)} ` +
      `${fmt(s.maxDrawdown, 11)} ${String(s.pnlToMaxDD).padStart(9)} ` +
      `${String(s.pctSum).padStart(8)}% ${String(s.avgPctPerTrade).padStart(7)}% ${String(s.avgHoldDays).padStart(5)}日`
    );
  });
  console.log('-'.repeat(118));
  const bh = reports[0].summary.buyHoldPnl;
  console.log(`買進持有對照：${bh.toLocaleString()} 元｜期間 ${reports[0].summary.backtestPeriod.start} ~ ${reports[0].summary.backtestPeriod.end}`);
  const open = sorted.filter(r => r.openPosition);
  if (open.length) {
    console.log('\n⚠ 期末仍有未平倉部位（未計入上方統計，數字越大代表該出場規則越接近「抱著不動」）：');
    for (const r of open) {
      const o = r.openPosition;
      console.log(`  ${r.id.padEnd(6)} ${o.entryDate} 進場，抱 ${String(o.holdDays).padStart(5)} 個交易日，` +
                  `未實現 ${String(o.unrealizedPnl.toLocaleString()).padStart(12)} 元`);
    }
  }
  return sorted;
}

// ── 主流程 ────────────────────────────────────────────────

const sortBy = cliArgs.sortBy || 'pnl';
const full = runAll(cliArgs.startDate, cliArgs.endDate);
const ranked = printTable(full, '布林通道突破做多 — 20 種出場機制比較', sortBy);

const out = {
  entryRule: '收盤 > BB(20,2.0) 上軌 → 當日尾盤做多 1 口（純做多、最多 1 口）',
  sortBy,
  period: full[0].summary.backtestPeriod,
  buyHoldPnl: full[0].summary.buyHoldPnl,
  ranking: ranked.map((r, i) => ({ rank: i + 1, id: r.id, exitRule: r.exitRule, openPosition: r.openPosition, ...r.summary })),
};

// ── 穩健度檢查：前後兩段分開跑 ──
if (cliArgs.oos) {
  const split = cliArgs.oos;
  const inS  = runAll(cliArgs.startDate, split);
  const outS = runAll(split, cliArgs.endDate);
  printTable(inS,  `【樣本內】~ ${split}`, sortBy);
  printTable(outS, `【樣本外】${split} ~`, sortBy);

  const byId = (arr, id) => arr.find(r => r.id === id).summary;
  console.log('\n' + '='.repeat(96));
  console.log(`穩健度：樣本內 / 樣本外 兩段都要賺錢才算過關（切點 ${split}）`);
  console.log('='.repeat(96));
  console.log('  策略    出場機制                        樣本內損益    樣本外損益   兩段都賺');
  console.log('-'.repeat(96));
  const robust = [];
  for (const r of ranked) {
    const a = byId(inS, r.id), b = byId(outS, r.id);
    const ok = a.totalPnl > 0 && b.totalPnl > 0;
    if (ok) robust.push(r.id);
    console.log(`  ${r.id.padEnd(7)} ${r.exitRule.slice(0, 28).padEnd(30)} ${fmt(a.totalPnl, 12)} ${fmt(b.totalPnl, 13)}   ${ok ? '✓' : '✗'}`);
  }
  console.log('-'.repeat(96));
  console.log(`過關：${robust.length}/20 → ${robust.join(', ') || '無'}`);
  out.oos = {
    split,
    inSample:  inS.map(r => ({ id: r.id, ...r.summary })),
    outSample: outS.map(r => ({ id: r.id, ...r.summary })),
    robustIds: robust,
  };
}

const p = path.join(__dirname, 'strategy6_compare_report.json');
fs.writeFileSync(p, JSON.stringify(out, null, 2), 'utf-8');
console.log(`\n比較結果已寫入：${p}`);
