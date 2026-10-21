const fs = require('fs');
const path = require('path');

// ============================================================
//  台指期 日K — SMA5/11 交叉策略 + KD 高檔轉折 / ATR 停損（純做多，最多 1 口）
// ============================================================
//  資料來源：day_data/stocks.ftx.json（每日 OHLCV）
//
//  規則：
//    進場：SMA5 向上穿越 SMA11 → 當日收盤做多
//
//    出場（擇一先觸發）：
//      A. SMA5 向下穿越 SMA11 → 當日收盤平倉
//      B. KD 的 K 值前一日 > 80 且當日 < 80 → 當日收盤平倉
//      C. 當日最低價 <= 進場點 − 1.5 × ATR(14) → 以停損價平倉
//
//    ※ C 為盤中觸價，優先於收盤才成立的 A、B
//
//  每點價值 200 元（大台），來回成本 240 元，滑價 0 點
// ============================================================

// ── 解析 CLI 參數 (--key=value) ──
const cliArgs = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v]; })
);

const CONFIG = {
  dataFile:      path.join(__dirname, 'day_data', 'stocks.ftx.json'),
  startDate:     cliArgs.startDate || null,   // 例：--startDate=2015-01-01
  endDate:       cliArgs.endDate   || null,
  fastPeriod:    cliArgs.fast   !== undefined ? parseInt(cliArgs.fast)    :  5,
  slowPeriod:    cliArgs.slow   !== undefined ? parseInt(cliArgs.slow)    : 11,
  atrPeriod:     cliArgs.atr    !== undefined ? parseInt(cliArgs.atr)     : 14,
  atrMultiplier: cliArgs.atrMult!== undefined ? parseFloat(cliArgs.atrMult): 1.5,
  kdPeriod:      cliArgs.kd     !== undefined ? parseInt(cliArgs.kd)      :  9,
  kdExitLevel:   cliArgs.kdLevel!== undefined ? parseFloat(cliArgs.kdLevel): 80,
  pointValue:    200,
  costPerTrade:  240,
  slippage:      0,
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
  const seed = period; // 第一個 ATR 從 index = period 開始
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

/* ── KD 隨機指標（台股慣用 9 日、平滑係數 1/3）──
   RSV = (C − Ln) / (Hn − Ln) × 100
   K = 2/3 × 前一日K + 1/3 × RSV
   D = 2/3 × 前一日D + 1/3 × K      （K、D 初始值 50）           */
function calcKD(bars, period) {
  const k = new Array(bars.length).fill(null);
  const d = new Array(bars.length).fill(null);
  let prevK = 50, prevD = 50;
  for (let i = period - 1; i < bars.length; i++) {
    let hn = -Infinity, ln = Infinity;
    for (let j = 0; j < period; j++) {
      if (bars[i - j].high > hn) hn = bars[i - j].high;
      if (bars[i - j].low  < ln) ln = bars[i - j].low;
    }
    const rsv = hn === ln ? 50 : ((bars[i].close - ln) / (hn - ln)) * 100;
    prevK = (2 / 3) * prevK + (1 / 3) * rsv;
    prevD = (2 / 3) * prevD + (1 / 3) * prevK;
    k[i] = prevK;
    d[i] = prevD;
  }
  return { k, d };
}

// ── 主策略 ────────────────────────────────────────────────

function runStrategy() {
  // 1. 讀取並排為升序
  const raw = JSON.parse(fs.readFileSync(CONFIG.dataFile, 'utf-8'));
  const bars = raw
    .map(b => ({
      date:   b.date,
      open:   b.open,
      high:   b.max,
      low:    b.min,
      close:  b.close,
      volume: b.volume,
    }))
    .filter(b => (!CONFIG.startDate || b.date >= CONFIG.startDate) &&
                 (!CONFIG.endDate   || b.date <= CONFIG.endDate))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  console.log(`載入 ${bars.length} 個交易日 (${bars[0].date} ~ ${bars[bars.length - 1].date})\n`);

  // 2. 計算指標
  const closes = bars.map(b => b.close);
  const fastArr = calcSMA(closes, CONFIG.fastPeriod);
  const slowArr = calcSMA(closes, CONFIG.slowPeriod);
  const atrArr  = calcATR(bars, CONFIG.atrPeriod);
  const { k: kArr, d: dArr } = calcKD(bars, CONFIG.kdPeriod);

  // 3. 逐日模擬
  const trades = [];
  let equity = 0, maxEquity = 0, maxDrawdown = 0;

  // position: { date, price, stopLoss, atrAtEntry }
  let position = null;

  const minIdx = Math.max(CONFIG.slowPeriod, CONFIG.atrPeriod, CONFIG.kdPeriod) + 1;

  for (let i = minIdx; i < bars.length; i++) {
    const bar    = bars[i];
    const fast   = fastArr[i], prevFast = fastArr[i - 1];
    const slow   = slowArr[i], prevSlow = slowArr[i - 1];
    const curAtr = atrArr[i];
    const curK   = kArr[i],   prevKv   = kArr[i - 1];

    if (fast === null || slow === null || curAtr === null || curK === null || prevKv === null) continue;

    const bullCross = prevFast <= prevSlow && fast > slow; // 黃金交叉
    const bearCross = prevFast >= prevSlow && fast < slow; // 死亡交叉
    const kdFall    = prevKv > CONFIG.kdExitLevel && curK < CONFIG.kdExitLevel; // K 由 80 上方跌破 80

    // ── 出場：C（盤中觸價）優先，其次 A、B（收盤成立）──
    if (position) {
      if (bar.low <= position.stopLoss) {
        const exitPrice = +position.stopLoss.toFixed(0) - CONFIG.slippage;
        equity += closePosition(trades, position, bar, exitPrice, '出場C(ATR停損)', CONFIG);
        position = null;
      } else if (bearCross) {
        const exitPrice = bar.close - CONFIG.slippage;
        equity += closePosition(trades, position, bar, exitPrice, '出場A(死亡交叉)', CONFIG);
        position = null;
      } else if (kdFall) {
        const exitPrice = bar.close - CONFIG.slippage;
        equity += closePosition(trades, position, bar, exitPrice, '出場B(K跌破80)', CONFIG);
        position = null;
      }
    }

    // ── 進場：無持倉 && 黃金交叉 → 收盤做多 ──
    if (!position && bullCross) {
      const entryPrice = bar.close + CONFIG.slippage;
      position = {
        date:       bar.date,
        price:      entryPrice,
        stopLoss:   entryPrice - CONFIG.atrMultiplier * curAtr,
        atrAtEntry: curAtr,
      };
    }

    // 追蹤最大回撤（基於已實現損益）
    if (equity > maxEquity) maxEquity = equity;
    const dd = maxEquity - equity;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // 資料結束仍有部位 → 末根收盤平倉（不計入統計）
  if (position) {
    const lastBar   = bars[bars.length - 1];
    const exitPrice = lastBar.close - CONFIG.slippage;
    equity += closePosition(trades, position, lastBar, exitPrice, '資料結束', CONFIG);
    position = null;
  }

  // 4. 報告
  const report = buildReport(trades, maxDrawdown, bars);
  const reportPath = path.join(__dirname, 'strategy4_report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`報告已寫入：${reportPath}`);
  printSummary(report);
}

// ── 輔助函式 ──────────────────────────────────────────────

function closePosition(trades, pos, bar, exitPrice, reason, cfg) {
  const pnlPoints = exitPrice - pos.price;
  const pnl = pnlPoints * cfg.pointValue - cfg.costPerTrade;
  trades.push({
    entryDate:     pos.date,
    exitDate:      bar.date,
    entryPrice:    pos.price,
    stopLossPoint: pos.stopLoss,
    exitPrice,
    pnlPoints,
    pnl,
    reason,
  });
  return pnl;
}

function buildReport(trades, maxDrawdown, bars) {
  const reportTrades = trades.filter(t => t.reason !== '資料結束');
  const totalTrades = reportTrades.length;
  const wins   = reportTrades.filter(t => t.pnl > 0);
  const losses = reportTrades.filter(t => t.pnl <= 0);
  const totalWin  = wins.reduce((s, t) => s + t.pnl, 0);
  const totalLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const totalPnl  = reportTrades.reduce((s, t) => s + t.pnl, 0);

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

  const reasonMap = {};
  for (const t of reportTrades) {
    if (!reasonMap[t.reason]) reasonMap[t.reason] = { pnl: 0, count: 0, wins: 0 };
    reasonMap[t.reason].pnl += t.pnl;
    reasonMap[t.reason].count++;
    if (t.pnl > 0) reasonMap[t.reason].wins++;
  }
  const exitReasonStats = Object.entries(reasonMap).sort().map(([reason, d]) => ({
    reason,
    trades:  d.count,
    wins:    d.wins,
    losses:  d.count - d.wins,
    winRate: +((d.wins / d.count) * 100).toFixed(2),
    pnl:     +d.pnl.toFixed(0),
    avgPnl:  +(d.pnl / d.count).toFixed(0),
  }));

  let cumPnl = 0;
  const tradeDetails = reportTrades.map((t, i) => {
    cumPnl += t.pnl;
    return {
      id:            i + 1,
      entryDate:     t.entryDate,
      exitDate:      t.exitDate,
      entryPrice:    t.entryPrice,
      stopLossPoint: +t.stopLossPoint.toFixed(0),
      exitPrice:     t.exitPrice,
      pnlPoints:     +t.pnlPoints.toFixed(2),
      pnl:           +t.pnl.toFixed(0),
      cumulativePnl: +cumPnl.toFixed(0),
      exitReason:    t.reason,
    };
  });

  return {
    strategy: `SMA${CONFIG.fastPeriod}/${CONFIG.slowPeriod} 交叉做多（1口）— 黃金交叉收盤進場 | 死亡交叉、K跌破${CONFIG.kdExitLevel}收盤出場 | 最低 ≤ 進場−${CONFIG.atrMultiplier}×ATR(${CONFIG.atrPeriod}) 停損`,
    config: CONFIG,
    summary: {
      backtestPeriod: {
        start:        bars[0].date,
        end:          bars[bars.length - 1].date,
        tradingDays:  bars.length,
      },
      totalTrades,
      wins:    wins.length,
      losses:  losses.length,
      winRate: +(totalTrades > 0 ? ((wins.length / totalTrades) * 100).toFixed(2) : 0),
      totalPnl:        +totalPnl.toFixed(0),
      avgPnl:          +(totalTrades   > 0 ? (totalPnl  / totalTrades).toFixed(0) : 0),
      avgWin:          +(wins.length   > 0 ? (totalWin  / wins.length).toFixed(0) : 0),
      avgLoss:         +(losses.length > 0 ? (-totalLoss / losses.length).toFixed(0) : 0),
      maxWin:          wins.length   > 0 ? +Math.max(...wins.map(t => t.pnl)).toFixed(0)   : 0,
      maxLoss:         losses.length > 0 ? +Math.min(...losses.map(t => t.pnl)).toFixed(0) : 0,
      profitFactor:    +(totalLoss > 0 ? (totalWin / totalLoss).toFixed(2) : 0),
      rewardRiskRatio: +(losses.length > 0 && wins.length > 0
        ? ((totalWin / wins.length) / (totalLoss / losses.length)).toFixed(2) : 0),
      maxDrawdown: +(-maxDrawdown).toFixed(0),
    },
    exitReasonStats,
    yearlyPerformance,
    trades: tradeDetails,
  };
}

function printSummary(report) {
  const s = report.summary;
  console.log('='.repeat(64));
  console.log(`策略：${report.strategy}`);
  console.log(`回測：${s.backtestPeriod.start} ~ ${s.backtestPeriod.end}（${s.backtestPeriod.tradingDays} 個交易日）`);
  console.log(`交易：${s.totalTrades} 次  勝率：${s.winRate}%`);
  console.log(`總損益：${s.totalPnl.toLocaleString()} 元  平均每筆：${s.avgPnl.toLocaleString()} 元`);
  console.log(`平均獲利：${s.avgWin.toLocaleString()}  平均虧損：${s.avgLoss.toLocaleString()}`);
  console.log(`最大單筆獲利：${s.maxWin.toLocaleString()}  最大單筆虧損：${s.maxLoss.toLocaleString()}`);
  console.log(`獲利因子：${s.profitFactor}  報酬風險比：${s.rewardRiskRatio}`);
  console.log(`最大回撤：${s.maxDrawdown.toLocaleString()} 元`);
  console.log('='.repeat(64));
  console.log('\n出場原因統計：');
  for (const r of report.exitReasonStats) {
    console.log(`  ${r.reason.padEnd(16)} ${String(r.trades).padStart(4)} 次  勝率 ${String(r.winRate).padStart(6)}%  損益 ${String(r.pnl.toLocaleString()).padStart(12)} 元  平均 ${String(r.avgPnl.toLocaleString()).padStart(9)} 元`);
  }
  console.log('\n年度績效：');
  for (const y of report.yearlyPerformance) {
    console.log(`  ${y.year}  ${String(y.pnl.toLocaleString()).padStart(12)} 元  勝率 ${String(y.winRate).padStart(6)}%  交易 ${String(y.trades).padStart(3)} 次`);
  }
}

runStrategy();
