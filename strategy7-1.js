const fs = require('fs');
const path = require('path');

// ============================================================
//  台指期 日K — 11 月底進場、12 月底出場（純做多，最多 1 口）
// ============================================================
//  資料來源：day_data/stocks.ftx.json（每日 OHLCV）
//
//  規則：
//    進場：每年 11 月「最後一個交易日」收盤買進 1 口多單
//    出場：同年 12 月「最後一個交易日」收盤平倉（不論賺賠）
//
//  部位天然不重疊（11 月進、12 月出），故恆滿足「最多 1 口」
//  這是 strategy7.js 的單純版 —— 不把虧損單延到隔年 1 月
//
//  每點價值 200 元（大台），來回成本 240 元
//
//  用法：
//    node strategy7-1.js
//    node strategy7-1.js --slippage=2
//    node strategy7-1.js --startDate=2010-01-01
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
      pushTrade(trades, entryBar, bars[lastIdx], entryPrice,
                bars[lastIdx].close - CONFIG.slippage, '資料結束', lastIdx - novIdx);
      continue;
    }

    const decBar = bars[decIdx];
    pushTrade(trades, entryBar, decBar, entryPrice,
              decBar.close - CONFIG.slippage, '12月底出場', decIdx - novIdx);
  }

  // 4. 對照組：虧損單延到隔年 1 月底（= strategy7.js 的規則）
  const baseline = buildBaseline(bars, lastOfMonth, firstYear, lastYear);

  // 5. 報告
  const report = buildReport(trades, bars, baseline);
  const reportPath = path.join(__dirname, 'strategy7-1_report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`報告已寫入：${reportPath}`);
  printSummary(report);
}

// ── 輔助函式 ──────────────────────────────────────────────

function pushTrade(trades, entryBar, exitBar, entryPrice, exitPrice, reason, holdDays) {
  const pnlPoints = exitPrice - entryPrice;
  trades.push({
    year:      +entryBar.date.slice(0, 4),
    entryDate: entryBar.date,
    exitDate:  exitBar.date,
    holdDays,
    entryPrice,
    exitPrice,
    pnlPoints: +pnlPoints.toFixed(2),
    pnl:       pnlPoints * CONFIG.pointValue - CONFIG.costPerTrade,
    reason,
  });
}

/* 對照組：同樣 11 月底進場，但 12 月底若虧損則續抱到隔年 1 月底
   —— 即 strategy7.js 的規則，用來回答「多那條分支划不划算」 */
function buildBaseline(bars, lastOfMonth, firstYear, lastYear) {
  let total = 0, n = 0, wins = 0, extended = 0;
  for (let y = firstYear; y <= lastYear; y++) {
    const novIdx = lastOfMonth.get(`${y}-11`);
    const decIdx = lastOfMonth.get(`${y}-12`);
    if (novIdx === undefined || decIdx === undefined) continue;

    const entryPrice = bars[novIdx].close + CONFIG.slippage;
    let exitIdx = decIdx;
    if (bars[decIdx].close - entryPrice <= 0) {         // 12 月底虧損 → 延到隔年 1 月底
      const janIdx = lastOfMonth.get(`${y + 1}-01`);
      if (janIdx === undefined) continue;               // 資料不足，略過不比
      exitIdx = janIdx;
      extended++;
    }
    const pnl = ((bars[exitIdx].close - CONFIG.slippage) - entryPrice) * CONFIG.pointValue - CONFIG.costPerTrade;
    total += pnl; n++;
    if (pnl > 0) wins++;
  }
  return {
    rule:     '11月底進場 → 12月底獲利出場、虧損則延到隔年1月底（= strategy7.js）',
    trades:   n,
    extended,
    wins,
    winRate:  +(n > 0 ? ((wins / n) * 100).toFixed(2) : 0),
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

  // 已實現權益曲線的最大回撤
  let equity = 0, peak = 0, maxDrawdown = 0;
  for (const t of rt) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

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
      pnlPoints: t.pnlPoints,
      pnl: +t.pnl.toFixed(0),
      pctReturn: +((t.pnl / (t.entryPrice * CONFIG.pointValue)) * 100).toFixed(2),
      cumulativePnl: +cum.toFixed(0),
      exitReason: t.reason,
    };
  });

  return {
    strategy: '11月底收盤做多（1口）— 12月底收盤直接平倉',
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
    excludedTrades: allTrades.filter(t => t.reason === '資料結束'),
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

  console.log(`\n對照組（${b.rule}）：`);
  console.log(`  ${b.trades} 次（其中 ${b.extended} 次延到 1 月）  勝率 ${b.winRate}%  總損益 ${b.totalPnl.toLocaleString()} 元  平均 ${b.avgPnl.toLocaleString()} 元`);
  const diff = s.totalPnl - b.totalPnl;
  console.log(`  → 本策略（一律 12 月底出場）相對於它：${diff >= 0 ? '+' : ''}${diff.toLocaleString()} 元`);

  if (report.excludedTrades.length) {
    console.log('\n⚠ 因資料結束被迫平倉、未計入統計：');
    for (const t of report.excludedTrades) {
      console.log(`  ${t.entryDate} 進場 @${t.entryPrice} → ${t.exitDate} @${t.exitPrice.toFixed(0)}（${t.pnl.toLocaleString()} 元）`);
    }
  }

  console.log('\n逐筆交易：');
  console.log('   年度  進場日        進場價   出場日        出場價    持有   損益(點)     損益(元)   報酬%');
  for (const t of report.trades) {
    console.log(
      `  ${String(t.year).padStart(5)}  ${t.entryDate}  ${String(t.entryPrice).padStart(7)}  ` +
      `${t.exitDate}  ${String(t.exitPrice).padStart(7)}  ${String(t.holdDays).padStart(3)}日  ` +
      `${String(t.pnlPoints).padStart(9)}  ${String(t.pnl.toLocaleString()).padStart(11)}  ${String(t.pctReturn).padStart(6)}%`
    );
  }
}

runStrategy();
