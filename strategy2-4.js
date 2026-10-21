const fs = require('fs');
const path = require('path');

// ============================================================
//  台指期 日K — SMA5/11 交叉策略 + 各口獨立 ATR 追蹤停利（純做多，最多 2 口）
// ============================================================
//  資料來源：day_data/stocks.ftx.json（每日 OHLCV）
//
//  規則：
//    進場點1：未持倉情況下，SMA5 向上穿越 SMA11 → 當日收盤做多
//    進場點2：已持倉(1口進場點1)情況下，當天最低價 > 進場點1當天最高價 → 當日收盤加多 1 口
//
//    出場（各口獨立觸發，信號平倉除外）：
//      A. SMA5 向下穿越 SMA11 → 當日收盤全部平倉
//      B. 進場點1 當日最低 <= 進場點1 - 1.5×ATR → 以停損點位平倉進場點1
//      C. 進場點2 當日最低 <= 進場點2 - 1.5×ATR → 以停損點位平倉進場點2
//      D. 進場點1 追蹤停利線1（只升不降）：
//           每根 K 棒更新 candidate = 進場點1後最高收盤 − 1.5×ATR
//           若 candidate > 前一追蹤線 → 更新，否則維持
//           當日最低 < 追蹤線1 → 以追蹤線1平倉進場點1
//      E. 進場點2 追蹤停利線2（只升不降）：
//           每根 K 棒更新 candidate = 進場點2後最高收盤 − 1.5×ATR
//           若 candidate > 前一追蹤線 → 更新，否則維持
//           當日最低 < 追蹤線2 → 以追蹤線2平倉進場點2
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
  // 每項 entry: { entryPoint, date, price, barHigh?(進場點1), stopLoss, trailStop, highestClose }
  const trades = [];
  let equity = 0, maxEquity = 0, maxDrawdown = 0;

  let entries = [];

  const minIdx = Math.max(CONFIG.slowPeriod, CONFIG.atrPeriod) + 1;

  for (let i = minIdx; i < bars.length; i++) {
    const bar    = bars[i];
    const fast   = sma5[i],  prevFast = sma5[i - 1];
    const slow   = sma11[i], prevSlow = sma11[i - 1];
    const curAtr = atrArr[i];

    if (fast === null || slow === null || curAtr === null) continue;

    const bullCross = prevFast <= prevSlow && fast > slow; // 黃金交叉
    const bearCross = prevFast >= prevSlow && fast < slow; // 死亡交叉

    if (entries.length > 0) {
      // ── A. 死亡交叉 → 收盤全部平倉 ──
      if (bearCross) {
        const exitPrice = bar.close - CONFIG.slippage;
        for (const entry of entries) {
          recordTrade(trades, entry.date, bar.date, entry.price, exitPrice, entry.stopLoss, entry.trailStop, `進場點${entry.entryPoint}-信號平倉`, CONFIG);
          equity += trades[trades.length - 1].pnl;
        }
        entries = [];
      } else {
        // ── 各口獨立：先更新追蹤線，再依序檢查 B/C 停損、D/E 追蹤停利 ──
        const remaining = [];
        for (const entry of entries) {
          const label = `進場點${entry.entryPoint}`;

          // 更新追蹤停利線（只升不降）
          if (bar.close > entry.highestClose) entry.highestClose = bar.close;
          const candidate = entry.highestClose - CONFIG.trailMultiplier * curAtr;
          if (candidate > entry.trailStop) entry.trailStop = candidate;

          // B/C. 固定停損
          if (bar.low <= entry.stopLoss) {
            const exitPrice = +entry.stopLoss.toFixed(0) - CONFIG.slippage;
            recordTrade(trades, entry.date, bar.date, entry.price, exitPrice, entry.stopLoss, entry.trailStop, `${label}-停損`, CONFIG);
            equity += trades[trades.length - 1].pnl;
          }
          // D/E. 追蹤停利
          else if (bar.low < entry.trailStop) {
            const exitPrice = +entry.trailStop.toFixed(0) - CONFIG.slippage;
            recordTrade(trades, entry.date, bar.date, entry.price, exitPrice, entry.stopLoss, entry.trailStop, `${label}-追蹤停利`, CONFIG);
            equity += trades[trades.length - 1].pnl;
          }
          else {
            remaining.push(entry);
          }
        }
        entries = remaining;
      }
    }

    // ── 進場點1：無持倉 && 黃金交叉 → 收盤做多 ──
    if (entries.length === 0 && bullCross) {
      const entryPrice = bar.close + CONFIG.slippage;
      entries.push({
        entryPoint:   1,
        date:         bar.date,
        price:        entryPrice,
        barHigh:      bar.high,
        stopLoss:     entryPrice - CONFIG.atrMultiplier  * curAtr,
        trailStop:    entryPrice - CONFIG.trailMultiplier * curAtr,
        highestClose: bar.close,
      });
    }

    // ── 進場點2：持倉1口(進場點1) && 當日最低 > 進場點1當天最高 → 收盤加碼 ──
    if (entries.length === 1 && entries[0].entryPoint === 1 && bar.low > entries[0].barHigh) {
      const entryPrice = bar.close + CONFIG.slippage;
      entries.push({
        entryPoint:   2,
        date:         bar.date,
        price:        entryPrice,
        stopLoss:     entryPrice - CONFIG.atrMultiplier  * curAtr,
        trailStop:    entryPrice - CONFIG.trailMultiplier * curAtr,
        highestClose: bar.close,
      });
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
      recordTrade(trades, entry.date, lastBar.date, entry.price, exitPrice, entry.stopLoss, entry.trailStop, '資料結束', CONFIG);
      equity += trades[trades.length - 1].pnl;
    }
  }

  // 4. 報告
  const report = buildReport(trades, maxDrawdown);
  const reportPath = path.join(__dirname, 'strategy2-4_report.json');
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
