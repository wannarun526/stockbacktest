const fs = require('fs');
const path = require('path');

// ============================================================
//  台指期 日K — SMA5/11 交叉策略（純做多，最多 2 口）
// ============================================================
//  資料來源：day_data/stocks.ftx.json（每日 OHLCV）
//
//  規則：
//    進場點1：未持倉情況下，SMA5 向上穿越 SMA11 → 當日收盤做多
//    進場點2：已持倉(1口)情況下，當天最低價 > 進場點1當天最高價 → 當日收盤再加多 1 口
//
//    出場（擇一先觸發，全部平倉）：
//      A. SMA5 向下穿越 SMA11 → 當日收盤全部平倉
//      B. 當日最低價 <= 進場點1 - 1.5 × ATR(14) → 以停損價全部平倉
//
//  每點價值 200 元（大台），來回成本 240 元，滑價 1 點
// ============================================================

const CONFIG = {
  dataFile: path.join(__dirname, 'day_data', 'stocks.ftx.json'),
  fastPeriod:    5,
  slowPeriod:   11,
  atrPeriod:    14,
  atrMultiplier: 1.5,
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

  // entries：已開倉清單，每項 {date, price, barHigh(僅進場點1有)}
  let entries  = [];
  let stopLoss = 0;  // 以進場點1的進場價計算

  const minIdx = Math.max(CONFIG.slowPeriod, CONFIG.atrPeriod) + 1;

  for (let i = minIdx; i < bars.length; i++) {
    const bar    = bars[i];
    const fast   = sma5[i],  prevFast = sma5[i - 1];
    const slow   = sma11[i], prevSlow = sma11[i - 1];
    const curAtr = atrArr[i];

    if (fast === null || slow === null || curAtr === null) continue;

    const bullCross = prevFast <= prevSlow && fast > slow; // 黃金交叉
    const bearCross = prevFast >= prevSlow && fast < slow; // 死亡交叉

    // ── 持倉中：先檢查出場條件 ──
    if (entries.length > 0) {
      // A. 停損：當日最低 <= 進場點1 - 1.5×ATR → 以停損價全部平倉
      if (bar.low <= stopLoss) {
        const exitPrice = +stopLoss.toFixed(0) - CONFIG.slippage;
        for (const [idx, entry] of entries.entries()) {
          const reason = idx === 0 ? '進場點1-停損' : '進場點2-停損';
          recordTrade(trades, entry.date, bar.date, entry.price, exitPrice, stopLoss, reason, CONFIG);
          const pnl = trades[trades.length - 1].pnl;
          equity += pnl;
          if (pnl > 0) winCount++;
        }
        entries = [];

      // B. 死亡交叉 → 收盤全部平倉
      } else if (bearCross) {
        const exitPrice = bar.close - CONFIG.slippage;
        for (const [idx, entry] of entries.entries()) {
          const reason = idx === 0 ? '進場點1-信號平倉' : '進場點2-信號平倉';
          recordTrade(trades, entry.date, bar.date, entry.price, exitPrice, stopLoss, reason, CONFIG);
          const pnl = trades[trades.length - 1].pnl;
          equity += pnl;
          if (pnl > 0) winCount++;
        }
        entries = [];
      }
    }

    // ── 進場點1：無持倉 && 黃金交叉 → 收盤做多 1 口 ──
    if (entries.length === 0 && bullCross) {
      const entryPrice = bar.close + CONFIG.slippage;
      entries.push({ date: bar.date, price: entryPrice, barHigh: bar.high });
      stopLoss = entryPrice - CONFIG.atrMultiplier * curAtr;
    }

    // ── 進場點2：持倉 1 口 && 當日最低 > 進場點1當天最高 → 收盤加碼 1 口 ──
    if (entries.length === 1 && bar.low > entries[0].barHigh) {
      const entryPrice = bar.close + CONFIG.slippage;
      entries.push({ date: bar.date, price: entryPrice });
    }

    // 追蹤最大回撤
    if (equity > maxEquity) maxEquity = equity;
    const dd = maxEquity - equity;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // 資料結束仍有部位 → 末根收盤全部平倉
  if (entries.length > 0) {
    const lastBar   = bars[bars.length - 1];
    const exitPrice = lastBar.close - CONFIG.slippage;
    for (const entry of entries) {
      recordTrade(trades, entry.date, lastBar.date, entry.price, exitPrice, stopLoss, '資料結束', CONFIG);
      const pnl = trades[trades.length - 1].pnl;
      equity += pnl;
      if (pnl > 0) winCount++;
    }
  }

  // 4. 報告
  const report = buildReport(trades, maxDrawdown);
  const reportPath = path.join(__dirname, 'strategy2-3_report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`報告已寫入：${reportPath}`);
  printSummary(report);
}

// ── 輔助函式 ──────────────────────────────────────────────

function recordTrade(trades, entryDate, exitDate, entryPrice, exitPrice, stopLossPoint, reason, cfg) {
  const pnlPoints = exitPrice - entryPrice;
  const pnl = pnlPoints * cfg.pointValue - cfg.costPerTrade;
  trades.push({ entryDate, exitDate, entryPrice, exitPrice, stopLossPoint, pnlPoints, pnl, reason });
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
      id:             i + 1,
      entryDate:      t.entryDate,
      exitDate:       t.exitDate,
      entryPrice:     t.entryPrice,
      stopLossPoint:  +t.stopLossPoint.toFixed(0),
      exitPrice:      t.exitPrice,
      pnlPoints:      +t.pnlPoints.toFixed(2),
      pnl:            +t.pnl.toFixed(0),
      cumulativePnl:  +cumPnl.toFixed(0),
      exitReason:     t.reason,
    };
  });

  const reportEquity = reportTrades.reduce((s, t) => s + t.pnl, 0);
  const reportWins   = wins.length;

  return {
    strategy: `SMA${CONFIG.fastPeriod}/SMA${CONFIG.slowPeriod} 黃金交叉做多 + ATR${CONFIG.atrPeriod}×${CONFIG.atrMultiplier} 停損`,
    config: CONFIG,
    summary: {
      backtestPeriod: {
        start: reportTrades.length > 0 ? reportTrades[0].entryDate : null,
        end:   reportTrades.length > 0 ? reportTrades[reportTrades.length - 1].exitDate : null,
      },
      totalTrades,
      wins:    reportWins,
      losses:  totalTrades - reportWins,
      winRate: +(totalTrades > 0 ? ((reportWins / totalTrades) * 100).toFixed(2) : 0),
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
