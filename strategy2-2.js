const fs = require('fs');
const path = require('path');

// ============================================================
//  台指期 日K — SMA5/11 交叉策略 + ATR 追蹤停利（純做多）
// ============================================================
//  資料來源：day_data/stocks.ftx.json（每日 OHLCV）
//
//  規則：
//    進場：SMA5 向上穿越 SMA11 → 當日收盤做多
//    出場（擇一先觸發）：
//      A. SMA5 向下穿越 SMA11 → 當日收盤平倉
//      B. 當日最低價 <= 進場點 - 1.5 × ATR(14) → 以停損點位平倉
//      C. 追蹤停利線（只升不降）：
//           每根 K 棒收盤後更新 candidate = 最高收盤價 − 1.5 × ATR(14)
//           若 candidate > 前一追蹤線 → 更新追蹤線，否則維持不動
//           當日收盤價 < 追蹤線 → 以當日收盤價平倉
//
//  每點價值 200 元（大台），來回成本 240 元，滑價 0 點
// ============================================================

const CONFIG = {
  dataFile: path.join(__dirname, 'day_data', 'stocks.ftx.json'),
  fastPeriod:       5,
  slowPeriod:      11,
  atrPeriod:       14,
  atrMultiplier:   1.5,   // 固定停損倍數
  trailMultiplier: 1.5,   // 追蹤停利倍數
  pointValue:      200,
  costPerTrade:    240,
  slippage:          0,
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

function calcATR(bars, period) {
  // bars 升序；回傳等長陣列，不足回傳 null
  const tr = new Array(bars.length).fill(null);
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  const result = new Array(bars.length).fill(null);
  let seed = period; // 第一個 ATR 從 index = period 開始
  if (seed >= bars.length) return result;
  let sum = 0;
  for (let i = 1; i <= period; i++) {
    if (tr[i] === null) return result;
    sum += tr[i];
  }
  result[seed] = sum / period;
  for (let i = seed + 1; i < bars.length; i++) {
    if (tr[i] === null) continue;
    result[i] = (result[i - 1] * (period - 1) + tr[i]) / period;
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
  const sma5   = calcSMA(closes, CONFIG.fastPeriod);
  const sma11  = calcSMA(closes, CONFIG.slowPeriod);
  const atrArr = calcATR(bars, CONFIG.atrPeriod);

  // 3. 逐日模擬
  const trades = [];
  let equity = 0, maxEquity = 0, maxDrawdown = 0, winCount = 0;

  let position   = 0;   // 1 = 多, 0 = 無
  let entryPrice = 0;
  let entryDate  = '';
  let stopLoss   = 0;   // 固定停損（進場點 - 1.5 × ATR）
  let trailStop  = 0;   // 追蹤停利線（只升不降）
  let highestClose = 0; // 持倉期間最高收盤價

  const minIdx = Math.max(CONFIG.slowPeriod, CONFIG.atrPeriod) + 1;

  for (let i = minIdx; i < bars.length; i++) {
    const bar  = bars[i];
    const fast = sma5[i],   prevFast = sma5[i - 1];
    const slow = sma11[i],  prevSlow = sma11[i - 1];
    const curAtr = atrArr[i];

    if (fast === null || slow === null || curAtr === null) continue;

    const bullCross = prevFast <= prevSlow && fast > slow; // 黃金交叉
    const bearCross = prevFast >= prevSlow && fast < slow; // 死亡交叉

    if (position === 1) {
      // ── B. 固定停損：當日最低 <= 停損點 → 以停損點位出場 ──
      if (bar.low <= stopLoss) {
        const exitPrice = +stopLoss.toFixed(0) - CONFIG.slippage;
        recordTrade(trades, entryDate, bar.date, entryPrice, exitPrice, stopLoss, trailStop, '固定停損', CONFIG);
        const pnl = trades[trades.length - 1].pnl;
        equity += pnl;
        if (pnl > 0) winCount++;
        position = 0;

      } else {
        // ── C. 追蹤停利：更新最高收盤 → 更新追蹤線（只升不降）→ 收盤跌破即平倉 ──
        if (bar.close > highestClose) highestClose = bar.close;
        const candidate = highestClose - CONFIG.trailMultiplier * curAtr;
        if (candidate > trailStop) trailStop = candidate;

        if (bar.close < trailStop) {
          const exitPrice = bar.close - CONFIG.slippage;
          recordTrade(trades, entryDate, bar.date, entryPrice, exitPrice, stopLoss, trailStop, '追蹤停利', CONFIG);
          const pnl = trades[trades.length - 1].pnl;
          equity += pnl;
          if (pnl > 0) winCount++;
          position = 0;

        // ── A. 死亡交叉 → 收盤平倉 ──
        } else if (bearCross) {
          const exitPrice = bar.close - CONFIG.slippage;
          recordTrade(trades, entryDate, bar.date, entryPrice, exitPrice, stopLoss, trailStop, '信號平倉', CONFIG);
          const pnl = trades[trades.length - 1].pnl;
          equity += pnl;
          if (pnl > 0) winCount++;
          position = 0;
        }
      }
    }

    // ── 黃金交叉 且 無部位 → 收盤做多 ──
    if (position === 0 && bullCross) {
      position      = 1;
      entryPrice    = bar.close + CONFIG.slippage;
      entryDate     = bar.date;
      stopLoss      = entryPrice - CONFIG.atrMultiplier * curAtr;
      highestClose  = bar.close;
      trailStop     = highestClose - CONFIG.trailMultiplier * curAtr;
    }

    // 追蹤最大回撤
    if (equity > maxEquity) maxEquity = equity;
    const dd = maxEquity - equity;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // 資料結束仍有部位 → 末根收盤平倉
  if (position === 1) {
    const lastBar  = bars[bars.length - 1];
    const exitPrice = lastBar.close - CONFIG.slippage;
    recordTrade(trades, entryDate, lastBar.date, entryPrice, exitPrice, stopLoss, trailStop, '資料結束', CONFIG);
    const pnl = trades[trades.length - 1].pnl;
    equity += pnl;
    if (pnl > 0) winCount++;
  }

  // 4. 報告
  const report = buildReport(trades, maxDrawdown);
  const reportPath = path.join(__dirname, 'strategy2-2_report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`報告已寫入：${reportPath}`);
  printSummary(report);
}

// ── 輔助函式 ──────────────────────────────────────────────

function recordTrade(trades, entryDate, exitDate, entryPrice, exitPrice, stopLossPoint, trailStopPoint, reason, cfg) {
  const pnlPoints = exitPrice - entryPrice;
  const pnl = pnlPoints * cfg.pointValue - cfg.costPerTrade;
  trades.push({ entryDate, exitDate, entryPrice, exitPrice, stopLossPoint, trailStopPoint, pnlPoints, pnl, reason });
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
    pnl:     d.pnl,
    trades:  d.count,
    wins:    d.wins,
    losses:  d.count - d.wins,
    winRate: +((d.wins / d.count) * 100).toFixed(2),
  }));

  let cumPnl = 0;
  const tradeDetails = reportTrades.map((t, i) => {
    cumPnl += t.pnl;
    return {
      id:              i + 1,
      entryDate:       t.entryDate,
      exitDate:        t.exitDate,
      entryPrice:      t.entryPrice,
      stopLossPoint:   +t.stopLossPoint.toFixed(0),
      trailStopPoint:  +t.trailStopPoint.toFixed(0),
      exitPrice:       t.exitPrice,
      pnlPoints:       +t.pnlPoints.toFixed(2),
      pnl:             +t.pnl.toFixed(0),
      cumulativePnl:   +cumPnl.toFixed(0),
      exitReason:      t.reason,
    };
  });

  const reportEquity = reportTrades.reduce((s, t) => s + t.pnl, 0);
  const winCount     = wins.length;

  return {
    strategy: `SMA${CONFIG.fastPeriod}/SMA${CONFIG.slowPeriod} 黃金交叉做多 + ATR${CONFIG.atrPeriod}×${CONFIG.atrMultiplier} 固定停損 + ATR×${CONFIG.trailMultiplier} 追蹤停利`,
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
