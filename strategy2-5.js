const fs = require('fs');
const path = require('path');

// ============================================================
//  台指期 日K — SMA10/30 交叉 + MA60 趨勢過濾（純做多，最多 1 口）
// ============================================================
//  資料來源：day_data/stocks.ftx.json（每日 OHLCV）
//
//  規則：
//    進場：SMA10 向上穿越 SMA30
//          且 當日收盤 > MA60（站在長天期均線之上才接受買訊）
//          → 當日收盤做多
//    出場：
//      A. SMA10 向下穿越 SMA30 → 當日收盤平倉
//
//  MA60 只作為「進場過濾」，不作為出場條件：
//    持倉後即使收盤跌破 MA60 也不平倉，一律等死亡交叉。
//    （過濾的目的是不在下降趨勢中開新倉，不是把持倉打斷）
//
//  （無停損；與 strategy2-6.js 的差別只有這道 MA60 進場過濾）
//  每點價值 200 元（大台），來回成本 240 元，滑價 0 點
//
//  報告中每筆交易另附「持有期間最高／最低點位」：
//    部位在進場日「收盤」才成立，進場日盤中高低點發生在建倉之前，
//    故取「進場日的次一根 ~ 出場日（含）」區間內的最高 high、最低 low
// ============================================================

const CONFIG = {
  dataFile: path.join(__dirname, 'day_data', 'stocks.ftx.json'),
  fastPeriod:   10,
  slowPeriod:   30,
  trendPeriod:  60,   // 長天期趨勢過濾均線
  pointValue:   200,
  costPerTrade: 240,
  slippage:       0,
};

// ── 指標工具 ──────────────────────────────────────────────

function calcSMA(arr, period) {
  // 升序陣列（arr[0] 最舊），回傳等長陣列，不足回傳 null
  const result = new Array(arr.length).fill(null);
  for (let i = period - 1; i < arr.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) sum += arr[i - j];
    result[i] = sum / period;
  }
  return result;
}

// ── 主策略 ────────────────────────────────────────────────

function runStrategy() {
  // 1. 讀取並排為升序
  const raw = JSON.parse(fs.readFileSync(CONFIG.dataFile, 'utf-8'));
  const bars = raw
    .map(d => ({
      date:   d.date,
      open:   d.open,
      high:   d.max,
      low:    d.min,
      close:  d.close,
      volume: d.volume,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  console.log(`載入 ${bars.length} 個交易日 (${bars[0].date} ~ ${bars[bars.length - 1].date})\n`);

  // 2. 計算指標
  const closes = bars.map(b => b.close);
  const fastArr  = calcSMA(closes, CONFIG.fastPeriod);
  const slowArr  = calcSMA(closes, CONFIG.slowPeriod);
  const trendArr = calcSMA(closes, CONFIG.trendPeriod);

  // 3. 逐日模擬
  const trades = [];
  let equity = 0, maxEquity = 0, maxDrawdown = 0, winCount = 0;

  let position   = 0;   // 1 = 多, 0 = 無
  let entryPrice = 0;
  let entryDate  = '';
  let entryIdx   = -1;

  const minIdx = Math.max(CONFIG.slowPeriod, CONFIG.trendPeriod) + 1;

  for (let i = minIdx; i < bars.length; i++) {
    const bar   = bars[i];
    const fast  = fastArr[i], prevFast = fastArr[i - 1];
    const slow  = slowArr[i], prevSlow = slowArr[i - 1];
    const trend = trendArr[i];

    if (fast === null || slow === null || trend === null) continue;

    const bullCross = prevFast <= prevSlow && fast > slow; // 黃金交叉
    const bearCross = prevFast >= prevSlow && fast < slow; // 死亡交叉
    const aboveTrend = bar.close > trend;                  // 站上 MA60

    // ── 出場 A：死亡交叉 → 收盤平倉 ──
    if (position === 1 && bearCross) {
      const exitPrice = bar.close - CONFIG.slippage;
      recordTrade(trades, entryDate, bar.date, entryPrice, exitPrice, '信號平倉', CONFIG,
                  holdExtremes(bars, entryIdx, i));
      const pnl = trades[trades.length - 1].pnl;
      equity += pnl;
      if (pnl > 0) winCount++;
      position = 0;
    }

    // ── 黃金交叉 且 站上 MA60 且 無部位 → 收盤做多 ──
    if (position === 0 && bullCross && aboveTrend) {
      position   = 1;
      entryPrice = bar.close + CONFIG.slippage;
      entryDate  = bar.date;
      entryIdx   = i;
    }

    // 追蹤最大回撤
    if (equity > maxEquity) maxEquity = equity;
    const dd = maxEquity - equity;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // 資料結束仍有部位 → 末根收盤平倉
  if (position === 1) {
    const lastBar   = bars[bars.length - 1];
    const exitPrice = lastBar.close - CONFIG.slippage;
    recordTrade(trades, entryDate, lastBar.date, entryPrice, exitPrice, '資料結束', CONFIG,
                holdExtremes(bars, entryIdx, bars.length - 1));
    const pnl = trades[trades.length - 1].pnl;
    equity += pnl;
    if (pnl > 0) winCount++;
  }

  // 4. 報告
  const report = buildReport(trades, maxDrawdown);
  const reportPath = path.join(__dirname, 'strategy2-7_report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`報告已寫入：${reportPath}`);
  printSummary(report);
}

// ── 輔助函式 ──────────────────────────────────────────────

/* 持有期間的最高／最低點位
   部位於 entryIdx 收盤成立，故區間取 (entryIdx, exitIdx] */
function holdExtremes(bars, entryIdx, exitIdx) {
  const from = Math.min(entryIdx + 1, exitIdx);
  let highest = -Infinity, lowest = Infinity;
  for (let i = from; i <= exitIdx; i++) {
    if (bars[i].high > highest) highest = bars[i].high;
    if (bars[i].low  < lowest)  lowest  = bars[i].low;
  }
  return { highest, lowest };
}

function recordTrade(trades, entryDate, exitDate, entryPrice, exitPrice, reason, cfg, hold) {
  const pnlPoints = exitPrice - entryPrice;
  const pnl = pnlPoints * cfg.pointValue - cfg.costPerTrade;
  trades.push({
    entryDate, exitDate, entryPrice, exitPrice, pnlPoints, pnl, reason,
    highestDuringHold: hold.highest,
    lowestDuringHold:  hold.lowest,
  });
}

function buildReport(trades, maxDrawdown) {
  const reportTrades = trades.filter(t => t.reason !== '資料結束');
  const totalTrades = reportTrades.length;
  const wins   = reportTrades.filter(t => t.pnl > 0);
  const losses = reportTrades.filter(t => t.pnl <= 0);
  const totalWin  = wins.reduce((s, t) => s + t.pnl, 0);
  const totalLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  const yearMap = {};
  for (const t of reportTrades) {
    const y = t.entryDate.slice(0, 4);
    if (!yearMap[y]) yearMap[y] = { pnl: 0, count: 0, wins: 0 };
    yearMap[y].pnl += t.pnl;
    yearMap[y].count++;
    if (t.pnl > 0) yearMap[y].wins++;
  }
  const yearlyPerformance = Object.entries(yearMap).sort().map(([year, d]) => ({
    year,
    pnl:     +d.pnl.toFixed(0),
    trades:  d.count,
    wins:    d.wins,
    losses:  d.count - d.wins,
    winRate: +((d.wins / d.count) * 100).toFixed(2),
  }));

  let cumPnl = 0;
  const tradeDetails = reportTrades.map((t, i) => {
    cumPnl += t.pnl;
    return {
      id:                i + 1,
      entryDate:         t.entryDate,
      exitDate:          t.exitDate,
      entryPrice:        t.entryPrice,
      exitPrice:         t.exitPrice,
      highestDuringHold: t.highestDuringHold,   // 持有期間最高點位
      lowestDuringHold:  t.lowestDuringHold,    // 持有期間最低點位
      pnlPoints:         +t.pnlPoints.toFixed(2),
      pnl:               +t.pnl.toFixed(0),
      cumulativePnl:     +cumPnl.toFixed(0),
      exitReason:        t.reason,
    };
  });

  const reportEquity = reportTrades.reduce((s, t) => s + t.pnl, 0);
  const winCount     = wins.length;

  return {
    strategy: `SMA${CONFIG.fastPeriod}/SMA${CONFIG.slowPeriod} 黃金交叉做多 + MA${CONFIG.trendPeriod} 趨勢過濾 — 死亡交叉收盤平倉（無停損）`,
    config: CONFIG,
    summary: {
      backtestPeriod: {
        start: reportTrades.length > 0 ? reportTrades[0].entryDate : null,
        end:   reportTrades.length > 0 ? reportTrades[reportTrades.length - 1].exitDate : null,
      },
      totalTrades,
      wins:    winCount,
      losses:  totalTrades - winCount,
      winRate: +(totalTrades > 0 ? ((winCount / totalTrades) * 100).toFixed(2) : 0),
      totalPnl:        +reportEquity.toFixed(0),
      avgPnl:          +(totalTrades > 0 ? (reportEquity / totalTrades).toFixed(0) : 0),
      avgWin:          +(wins.length   > 0 ? (totalWin  / wins.length).toFixed(0)  : 0),
      avgLoss:         +(losses.length > 0 ? (-totalLoss / losses.length).toFixed(0) : 0),
      maxWin:          wins.length   > 0 ? +Math.max(...wins.map(t => t.pnl)).toFixed(0)   : 0,
      maxLoss:         losses.length > 0 ? +Math.min(...losses.map(t => t.pnl)).toFixed(0) : 0,
      profitFactor:    +(totalLoss > 0 ? (totalWin / totalLoss).toFixed(2) : 0),
      rewardRiskRatio: +(losses.length > 0 && wins.length > 0
        ? ((totalWin / wins.length) / (totalLoss / losses.length)).toFixed(2) : 0),
      maxDrawdown: +(-maxDrawdown).toFixed(0),
    },
    yearlyPerformance,
    trades: tradeDetails,
  };
}

function printSummary(report) {
  const s = report.summary;
  console.log('='.repeat(55));
  console.log(`策略：${report.strategy}`);
  console.log(`回測：${s.backtestPeriod.start} ~ ${s.backtestPeriod.end}`);
  console.log(`交易：${s.totalTrades} 次  勝率：${s.winRate}%`);
  console.log(`總損益：${s.totalPnl.toLocaleString()} 元  平均每筆：${s.avgPnl.toLocaleString()} 元`);
  console.log(`平均獲利：${s.avgWin.toLocaleString()}  平均虧損：${s.avgLoss.toLocaleString()}`);
  console.log(`最大單筆獲利：${s.maxWin.toLocaleString()}  最大單筆虧損：${s.maxLoss.toLocaleString()}`);
  console.log(`獲利因子：${s.profitFactor}  報酬風險比：${s.rewardRiskRatio}`);
  console.log(`最大回撤：${s.maxDrawdown.toLocaleString()} 元`);
  console.log('='.repeat(55));
  console.log('\n年度績效：');
  for (const y of report.yearlyPerformance) {
    const pnlStr = String(y.pnl.toLocaleString()).padStart(14);
    console.log(`  ${y.year}  ${pnlStr} 元  勝率 ${String(y.winRate).padStart(5)}%  交易 ${y.trades} 次`);
  }
}

runStrategy();
