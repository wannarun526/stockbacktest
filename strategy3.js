const fs   = require('fs');
const path = require('path');

// ============================================================
//  台指期 日K — NW Envelope 反彈策略（純做多，允許加碼）
// ============================================================
//  資料來源：day_data/stocks.ftx.json（每日 OHLCV）
//
//  進場點1：不論持倉多少，收盤 < NW 下軌 → 尾盤買進
//  進場點2：昨日收盤 < 昨日 NW 下軌 且 今日收盤 ≥ NW 下軌 → 尾盤買進
//
//  出場點：尾盤收盤 ≥ NW 中軸 → 全部平倉
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
  nwH:           cliArgs.nwH   !== undefined ? parseFloat(cliArgs.nwH)   : 7.0,
  nwMult:        cliArgs.nwMult !== undefined ? parseFloat(cliArgs.nwMult) : 2.5,
  atrPeriod:     14,
  pointValue:    200,
  costPerTrade:  240,
  slippage:      0,
};

// ── 指標工具 ──────────────────────────────────────────────

function calcATR(bars, period) {
  const tr = new Array(bars.length).fill(null);
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  const result = new Array(bars.length).fill(null);
  const seed = period;
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

/* ── Nadaraya-Watson 核回歸 (Gaussian kernel, bandwidth=h) ──
   Causal（非重繪）版本：j 只走訪 0 ~ i，不使用未來資料
   nw[i] = Σ_{j=0}^{i} K((i-j)/h)·close[j] / Σ_{j=0}^{i} K((i-j)/h)
   K(u) = exp(-0.5·u²)                                                 */
function calcNWKernel(closes, h = 8.0) {
  const n = closes.length;
  const result = new Array(n);
  for (let i = 0; i < n; i++) {
    let sumW = 0, sumWY = 0;
    for (let j = 0; j <= i; j++) {       // ← 只看 0 ~ i，不偷看未來
      const d = (i - j) / h;
      const w = Math.exp(-0.5 * d * d);
      sumW  += w;
      sumWY += w * closes[j];
    }
    result[i] = +(sumWY / sumW).toFixed(1);
  }
  return result;
}

// ── 主策略 ────────────────────────────────────────────────

function runStrategy() {
  // 1. 讀取並排升序
  const raw  = JSON.parse(fs.readFileSync(CONFIG.dataFile, 'utf-8'));
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

  console.log('計算 NW Kernel Regression (O(n²))...');
  const atrArr  = calcATR(bars, CONFIG.atrPeriod);
  const nwMean  = calcNWKernel(closes, CONFIG.nwH);
  const nwLower = nwMean.map((v, i) =>
    atrArr[i] !== null ? v - CONFIG.nwMult * atrArr[i] : null
  );

  // 3. 逐日模擬
  const trades = [];
  let equity = 0, maxEquity = 0, maxDrawdown = 0, winCount = 0;

  // positions[]: { entryDate, entryPrice, stopLoss }
  const positions = [];

  const minIdx = CONFIG.atrPeriod + 1;

  for (let i = minIdx; i < bars.length; i++) {
    const bar   = bars[i];
    const mean  = nwMean[i];
    const lower = nwLower[i];

    if (mean === null || lower === null) continue;

    // ── 1. 尾盤出場：收盤 ≥ NW 中軸 → 全部平倉 ──
    if (positions.length > 0 && bar.close >= mean) {
      const exitPrice = bar.close - CONFIG.slippage;
      for (const pos of positions) {
        recordTrade(trades, pos.entryDate, bar.date, pos.entryPrice, exitPrice, pos.entryReason, '出場(NW中軸)', CONFIG);
        const t = trades[trades.length - 1];
        equity += t.pnl;
        if (t.pnl > 0) winCount++;
      }
      positions.length = 0;
    }

    // ── 3. 進場條件（不論持倉多少）──
    //   條件1：收盤 < NW 下軌
    //   條件2：昨日收盤 < 昨日 NW 下軌 且 今日收盤 ≥ 今日 NW 下軌（穿越下軌向上）
    const prevClose = bars[i - 1].close;
    const prevLower = nwLower[i - 1];
    const cond1 = bar.close < lower;
    const cond2 = prevLower !== null && prevClose < prevLower && bar.close >= lower;

    if (cond1 || cond2) {
      const entryPrice = bar.close + CONFIG.slippage;
      const reason = cond1 ? '進場1(破下軌)' : '進場2(穿越下軌)';
      positions.push({
        entryDate:   bar.date,
        entryPrice,
        entryReason: reason,
      });
    }

    // 追蹤最大回撤（基於已實現損益）
    if (equity > maxEquity) maxEquity = equity;
    const dd = maxEquity - equity;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // 4. 資料結束仍有部位 → 末根收盤全部平倉
  if (positions.length > 0) {
    const lastBar   = bars[bars.length - 1];
    const exitPrice = lastBar.close - CONFIG.slippage;
    for (const pos of positions) {
      recordTrade(trades, pos.entryDate, lastBar.date, pos.entryPrice, exitPrice, pos.entryReason, '資料結束', CONFIG);
      const t = trades[trades.length - 1];
      equity += t.pnl;
      if (t.pnl > 0) winCount++;
    }
    positions.length = 0;
  }

  // 5. 輸出報告
  const report = buildReport(trades, equity, maxDrawdown, winCount);
  const reportPath = path.join(__dirname, 'strategy3_report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`報告已寫入：${reportPath}`);
  printSummary(report);
}

// ── 輔助函式 ──────────────────────────────────────────────

function recordTrade(trades, entryDate, exitDate, entryPrice, exitPrice, entryReason, exitReason, cfg) {
  const pnlPoints = exitPrice - entryPrice;
  const pnl = pnlPoints * cfg.pointValue - cfg.costPerTrade;
  trades.push({ entryDate, exitDate, entryPrice, exitPrice, pnlPoints, pnl, entryReason, reason: exitReason });
}

function buildReport(trades, equity, maxDrawdown, winCount) {
  const totalTrades = trades.length;
  const wins   = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalWin  = wins.reduce((s, t) => s + t.pnl, 0);
  const totalLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  const yearMap = {};
  for (const t of trades) {
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
  const tradeDetails = trades.map((t, i) => {
    cumPnl += t.pnl;
    return {
      id:            i + 1,
      entryDate:     t.entryDate,
      exitDate:      t.exitDate,
      entryPrice:    t.entryPrice,
      exitPrice:     t.exitPrice,
      pnlPoints:     +t.pnlPoints.toFixed(2),
      pnl:           +t.pnl.toFixed(0),
      cumulativePnl: +cumPnl.toFixed(0),
      entryReason:   t.entryReason,
      exitReason:    t.reason,
    };
  });

  return {
    strategy: `NW Envelope 反彈策略 – 收盤 < NW下軌進場 | 收盤 ≥ NW中軸停利 | 最低 ≤ 進場-1×ATR停損 (h=${CONFIG.nwH}, mult=${CONFIG.nwMult})`,
    config: CONFIG,
    summary: {
      backtestPeriod: {
        start: trades.length > 0 ? trades[0].entryDate : null,
        end:   trades.length > 0 ? trades[trades.length - 1].exitDate : null,
      },
      totalTrades,
      wins:    winCount,
      losses:  totalTrades - winCount,
      winRate: +(totalTrades > 0 ? ((winCount / totalTrades) * 100).toFixed(2) : 0),
      totalPnl:        +equity.toFixed(0),
      avgPnl:          +(totalTrades > 0 ? (equity / totalTrades).toFixed(0) : 0),
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
  console.log('='.repeat(60));
  console.log(`策略：${report.strategy}`);
  console.log(`回測：${s.backtestPeriod.start} ~ ${s.backtestPeriod.end}`);
  console.log(`交易：${s.totalTrades} 次  勝率：${s.winRate}%`);
  console.log(`總損益：${s.totalPnl.toLocaleString()} 元  平均每筆：${s.avgPnl.toLocaleString()} 元`);
  console.log(`平均獲利：${s.avgWin.toLocaleString()}  平均虧損：${s.avgLoss.toLocaleString()}`);
  console.log(`獲利因子：${s.profitFactor}  報酬風險比：${s.rewardRiskRatio}`);
  console.log(`最大回撤：${s.maxDrawdown.toLocaleString()} 元`);
  console.log('='.repeat(60));
  console.log('\n年度績效：');
  for (const y of report.yearlyPerformance) {
    const pnlStr = String(y.pnl.toLocaleString()).padStart(14);
    console.log(`  ${y.year}  ${pnlStr} 元  勝率 ${String(y.winRate).padStart(5)}%  交易 ${y.trades} 次`);
  }
}

runStrategy();
