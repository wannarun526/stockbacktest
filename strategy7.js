const fs = require('fs');
const path = require('path');

// ============================================================
//  台指期 日K — 11 月底進場的季節性策略（純做多，最多 1 口）
// ============================================================
//  資料來源：day_data/stocks.ftx.json（每日 OHLCV）
//
//  規則：
//    進場：每年 11 月「最後一個交易日」收盤買進 1 口多單
//
//    出場：
//      A. 同年 12 月最後一個交易日，若當時損益為正 → 該日收盤平倉
//      B. 同年 12 月最後一個交易日，若當時損益為負 → 續抱，
//         於隔年 1 月最後一個交易日收盤平倉（不論賺賠）
//
//  部位天然不重疊（11 月進、最晚隔年 1 月出），故恆滿足「最多 1 口」
//
//  每點價值 200 元（大台），來回成本 240 元
//
//  ── 「損益為正」的認定 ──────────────────────────────
//    預設 --pnlBasis=gross：12 月底收盤 > 進場價（不扣交易成本）
//    改用 --pnlBasis=net  ：扣掉 240 元成本（= 1.2 點）後仍為正才算
//
//  用法：
//    node strategy7.js
//    node strategy7.js --pnlBasis=net
//    node strategy7.js --startDate=2010-01-01 --slippage=2
// ============================================================

// ── 解析 CLI 參數 (--key=value) ──
const cliArgs = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v === undefined ? 'true' : v]; })
);

const CONFIG = {
  dataFile:     path.join(__dirname, 'day_data', 'stocks.ftx.json'),
  startDate:    cliArgs.startDate || null,
  endDate:      cliArgs.endDate   || null,
  pnlBasis:     cliArgs.pnlBasis  || 'gross',   // gross | net
  pointValue:   200,
  costPerTrade: 240,
  slippage:     cliArgs.slippage !== undefined ? parseFloat(cliArgs.slippage) : 0,
};

// ── 主策略 ────────────────────────────────────────────────

function runStrategy() {
  // 1. 讀取並排為升序
  const raw = JSON.parse(fs.readFileSync(CONFIG.dataFile, 'utf-8'));
  const bars = raw
    .map(b => ({ date: b.date, open: b.open, high: b.max, low: b.min, close: b.close, volume: b.volume }))
    .filter(b => (!CONFIG.startDate || b.date >= CONFIG.startDate) && (!CONFIG.endDate || b.date <= CONFIG.endDate))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  console.log(`載入 ${bars.length} 個交易日 (${bars[0].date} ~ ${bars[bars.length - 1].date})\n`);

  // 2. 每個「年-月」的最後一個交易日索引
  const lastOfMonth = new Map();          // 'YYYY-MM' → index
  bars.forEach((b, i) => lastOfMonth.set(b.date.slice(0, 7), i));

  // 3. 逐年模擬
  const trades = [];
  const firstYear = +bars[0].date.slice(0, 4);
  const lastYear  = +bars[bars.length - 1].date.slice(0, 4);
  const lastIdx   = bars.length - 1;

  for (let y = firstYear; y <= lastYear; y++) {
    const novIdx = lastOfMonth.get(`${y}-11`);
    if (novIdx === undefined) continue;                 // 當年沒有 11 月資料（頭尾年）

    const entryBar   = bars[novIdx];
    const entryPrice = entryBar.close + CONFIG.slippage;

    const decIdx = lastOfMonth.get(`${y}-12`);
    if (decIdx === undefined) {                         // 資料在 12 月前就結束
      pushTrade(trades, entryBar, bars[lastIdx], entryPrice, bars[lastIdx].close - CONFIG.slippage,
                '資料結束', null, lastIdx - novIdx);
      continue;
    }

    // ── 12 月底結算：判斷當下損益 ──
    const decBar     = bars[decIdx];
    const decPoints  = decBar.close - entryPrice;
    const decPnl     = decPoints * CONFIG.pointValue - CONFIG.costPerTrade;
    const decPositive = CONFIG.pnlBasis === 'net' ? decPnl > 0 : decPoints > 0;

    if (decPositive) {
      // 出場 A：12 月底收盤平倉
      pushTrade(trades, entryBar, decBar, entryPrice, decBar.close - CONFIG.slippage,
                '12月底獲利出場', decPoints, decIdx - novIdx);
      continue;
    }

    // 出場 B：虧損 → 續抱到隔年 1 月底
    const janIdx = lastOfMonth.get(`${y + 1}-01`);
    if (janIdx === undefined) {                         // 資料在隔年 1 月前就結束
      pushTrade(trades, entryBar, bars[lastIdx], entryPrice, bars[lastIdx].close - CONFIG.slippage,
                '資料結束', decPoints, lastIdx - novIdx);
      continue;
    }
    const janBar = bars[janIdx];
    pushTrade(trades, entryBar, janBar, entryPrice, janBar.close - CONFIG.slippage,
              '隔年1月底出場', decPoints, janIdx - novIdx);
  }

  // 4. 對照組：一律 12 月底出場（不把虧損單延到 1 月）
  const baseline = buildBaseline(bars, lastOfMonth, firstYear, lastYear);

  // 5. 報告
  const report = buildReport(trades, bars, baseline);
  const reportPath = path.join(__dirname, 'strategy7_report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`報告已寫入：${reportPath}`);
  printSummary(report);
}

// ── 輔助函式 ──────────────────────────────────────────────

function pushTrade(trades, entryBar, exitBar, entryPrice, exitPrice, reason, decPoints, holdDays) {
  const pnlPoints = exitPrice - entryPrice;
  trades.push({
    year:       +entryBar.date.slice(0, 4),
    entryDate:  entryBar.date,
    exitDate:   exitBar.date,
    holdDays,
    entryPrice,
    exitPrice,
    decPoints:  decPoints === null ? null : +decPoints.toFixed(2),  // 12 月底當下的帳面點數
    pnlPoints:  +pnlPoints.toFixed(2),
    pnl:        pnlPoints * CONFIG.pointValue - CONFIG.costPerTrade,
    reason,
  });
}

/* 對照組：同樣 11 月底進場，但一律在 12 月底出場 —
   用來回答「把虧損單延到 1 月，到底有沒有加分」 */
function buildBaseline(bars, lastOfMonth, firstYear, lastYear) {
  let total = 0, n = 0, wins = 0;
  for (let y = firstYear; y <= lastYear; y++) {
    const novIdx = lastOfMonth.get(`${y}-11`);
    const decIdx = lastOfMonth.get(`${y}-12`);
    if (novIdx === undefined || decIdx === undefined) continue;
    const entryPrice = bars[novIdx].close + CONFIG.slippage;
    const exitPrice  = bars[decIdx].close - CONFIG.slippage;
    const pnl = (exitPrice - entryPrice) * CONFIG.pointValue - CONFIG.costPerTrade;
    total += pnl; n++;
    if (pnl > 0) wins++;
  }
  return {
    rule:    '11月底進場 → 一律 12月底出場（不延到隔年1月）',
    trades:  n,
    wins,
    winRate: +(n > 0 ? ((wins / n) * 100).toFixed(2) : 0),
    totalPnl: +total.toFixed(0),
    avgPnl:   +(n > 0 ? (total / n).toFixed(0) : 0),
  };
}

function buildReport(allTrades, bars, baseline) {
  const rt = allTrades.filter(t => t.reason !== '資料結束');
  const n  = rt.length;
  const wins   = rt.filter(t => t.pnl > 0);
  const losses = rt.filter(t => t.pnl <= 0);
  const totalWin  = wins.reduce((s, t) => s + t.pnl, 0);
  const totalLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const totalPnl  = rt.reduce((s, t) => s + t.pnl, 0);

  // 已實現權益曲線的最大回撤（依出場時間排序）
  let equity = 0, peak = 0, maxDrawdown = 0;
  for (const t of rt) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  const reasonMap = {};
  for (const t of rt) {
    (reasonMap[t.reason] = reasonMap[t.reason] || { pnl: 0, count: 0, wins: 0 });
    reasonMap[t.reason].pnl += t.pnl;
    reasonMap[t.reason].count++;
    if (t.pnl > 0) reasonMap[t.reason].wins++;
  }
  const exitReasonStats = Object.entries(reasonMap).sort().map(([reason, d]) => ({
    reason, trades: d.count, wins: d.wins, losses: d.count - d.wins,
    winRate: +((d.wins / d.count) * 100).toFixed(2),
    pnl: +d.pnl.toFixed(0), avgPnl: +(d.pnl / d.count).toFixed(0),
  }));

  // 與點位無關的報酬率（台指 25 年漲 10 倍，絕對金額會偏袒近年）
  const pcts = rt.map(t => (t.pnl / (t.entryPrice * CONFIG.pointValue)) * 100);
  const pctSum = pcts.reduce((s, v) => s + v, 0);
  const holdDays = rt.reduce((s, t) => s + t.holdDays, 0);

  let cum = 0;
  const tradeDetails = rt.map((t, i) => {
    cum += t.pnl;
    return {
      id: i + 1, year: t.year,
      entryDate: t.entryDate, exitDate: t.exitDate,
      holdDays: t.holdDays,
      entryPrice: t.entryPrice, exitPrice: +t.exitPrice.toFixed(0),
      decPoints: t.decPoints,
      pnlPoints: t.pnlPoints,
      pnl: +t.pnl.toFixed(0),
      pctReturn: +((t.pnl / (t.entryPrice * CONFIG.pointValue)) * 100).toFixed(2),
      cumulativePnl: +cum.toFixed(0),
      exitReason: t.reason,
    };
  });

  const dropped = allTrades.filter(t => t.reason === '資料結束');

  return {
    strategy: '11月底收盤做多（1口）— 12月底獲利則出場，虧損則續抱至隔年1月底出場',
    config: { ...CONFIG, dataFile: undefined },
    summary: {
      backtestPeriod: { start: bars[0].date, end: bars[bars.length - 1].date, tradingDays: bars.length },
      totalTrades: n,
      wins: wins.length, losses: losses.length,
      winRate: +(n > 0 ? ((wins.length / n) * 100).toFixed(2) : 0),
      totalPnl: +totalPnl.toFixed(0),
      avgPnl:  +(n > 0 ? (totalPnl / n).toFixed(0) : 0),
      avgWin:  +(wins.length   > 0 ? (totalWin  / wins.length).toFixed(0) : 0),
      avgLoss: +(losses.length > 0 ? (-totalLoss / losses.length).toFixed(0) : 0),
      maxWin:  wins.length   > 0 ? +Math.max(...wins.map(t => t.pnl)).toFixed(0)   : 0,
      maxLoss: losses.length > 0 ? +Math.min(...losses.map(t => t.pnl)).toFixed(0) : 0,
      profitFactor: +(totalLoss > 0 ? (totalWin / totalLoss).toFixed(2) : 0),
      rewardRiskRatio: +(losses.length > 0 && wins.length > 0
        ? ((totalWin / wins.length) / (totalLoss / losses.length)).toFixed(2) : 0),
      maxDrawdown: +(-maxDrawdown).toFixed(0),
      pnlToMaxDD: +(maxDrawdown > 0 ? (totalPnl / maxDrawdown).toFixed(2) : 0),
      pctSum: +pctSum.toFixed(2),
      avgPctPerTrade: +(n > 0 ? (pctSum / n).toFixed(3) : 0),
      avgHoldDays: +(n > 0 ? (holdDays / n).toFixed(1) : 0),
      exposureRatio: +((holdDays / bars.length) * 100).toFixed(2),
      buyHoldPnl: +((bars[bars.length - 1].close - bars[0].close) * CONFIG.pointValue).toFixed(0),
    },
    baseline,
    excludedTrades: dropped,     // 資料結束才被迫平倉的部位，不計入統計
    exitReasonStats,
    trades: tradeDetails,
  };
}

function printSummary(report) {
  const s = report.summary, b = report.baseline;
  console.log('='.repeat(78));
  console.log(`策略：${report.strategy}`);
  console.log(`回測：${s.backtestPeriod.start} ~ ${s.backtestPeriod.end}（${s.backtestPeriod.tradingDays} 個交易日）`);
  console.log(`交易：${s.totalTrades} 次  勝率：${s.winRate}%  平均持有：${s.avgHoldDays} 個交易日  在場比例：${s.exposureRatio}%`);
  console.log(`總損益：${s.totalPnl.toLocaleString()} 元  平均每筆：${s.avgPnl.toLocaleString()} 元`);
  console.log(`平均獲利：${s.avgWin.toLocaleString()}  平均虧損：${s.avgLoss.toLocaleString()}`);
  console.log(`最大單筆獲利：${s.maxWin.toLocaleString()}  最大單筆虧損：${s.maxLoss.toLocaleString()}`);
  console.log(`獲利因子：${s.profitFactor}  報酬風險比：${s.rewardRiskRatio}`);
  console.log(`最大回撤：${s.maxDrawdown.toLocaleString()} 元  總損益/最大回撤：${s.pnlToMaxDD}`);
  console.log(`與點位無關的報酬：累計 ${s.pctSum}%  平均每筆 ${s.avgPctPerTrade}%`);
  console.log(`買進持有對照：${s.buyHoldPnl.toLocaleString()} 元`);
  console.log('='.repeat(78));

  console.log('\n出場原因統計：');
  for (const r of report.exitReasonStats) {
    console.log(`  ${r.reason.padEnd(16)} ${String(r.trades).padStart(3)} 次  勝率 ${String(r.winRate).padStart(6)}%  損益 ${String(r.pnl.toLocaleString()).padStart(12)} 元  平均 ${String(r.avgPnl.toLocaleString()).padStart(10)} 元`);
  }

  console.log(`\n對照組（${b.rule}）：`);
  console.log(`  ${b.trades} 次  勝率 ${b.winRate}%  總損益 ${b.totalPnl.toLocaleString()} 元  平均 ${b.avgPnl.toLocaleString()} 元`);
  const diff = report.summary.totalPnl - b.totalPnl;
  console.log(`  → 把虧損單延到隔年1月底：${diff >= 0 ? '+' : ''}${diff.toLocaleString()} 元`);

  if (report.excludedTrades.length) {
    console.log('\n⚠ 因資料結束被迫平倉、未計入統計：');
    for (const t of report.excludedTrades) {
      console.log(`  ${t.entryDate} 進場 @${t.entryPrice} → ${t.exitDate} @${t.exitPrice.toFixed(0)}（${t.pnl.toLocaleString()} 元）`);
    }
  }

  console.log('\n逐筆交易：');
  console.log('   年度  進場日        進場價   12月底帳面   出場日        出場價      損益(元)   報酬%   出場原因');
  for (const t of report.trades) {
    console.log(
      `  ${String(t.year).padStart(5)}  ${t.entryDate}  ${String(t.entryPrice).padStart(7)}  ` +
      `${String(t.decPoints === null ? '-' : t.decPoints).padStart(9)}點  ` +
      `${t.exitDate}  ${String(t.exitPrice).padStart(7)}  ${String(t.pnl.toLocaleString()).padStart(11)}  ` +
      `${String(t.pctReturn).padStart(6)}%  ${t.exitReason}`
    );
  }
}

runStrategy();
