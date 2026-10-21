const fs = require('fs');
const path = require('path');

// ============================================================
//  台指期 日K — SMA5/11 交叉策略 + ADX 趨勢過濾（純做多）
// ============================================================
//  資料來源：day_data/stocks.ftx.json（每日 OHLCV）
//
//  規則：
//    進場：SMA5 向上穿越 SMA11
//          且 ADX(14) >= adxThreshold（趨勢夠強）
//          且 +DI > -DI（多方方向確認）
//          → 當日收盤做多
//    出場（擇一先觸發）：
//      A. SMA5 向下穿越 SMA11 → 當日收盤平倉
//      B. 當日最低價 <= 進場點 - 1.5 × ATR(14) → 以停損價平倉
//
//  ADX 作用：過濾震盪盤的假突破，只在有明確趨勢時進場
//  每點價值 200 元（大台），來回成本 240 元，滑價 1 點
// ============================================================

const CONFIG = {
  dataFile: path.join(__dirname, 'day_data', 'stocks.ftx.json'),
  fastPeriod:    5,
  slowPeriod:   11,
  atrPeriod:    14,
  atrMultiplier: 1.5,
  adxPeriod:    14,   // ADX 計算週期
  adxThreshold: 20,   // ADX 低於此值視為無趨勢，不進場
  pointValue:   200,
  costPerTrade: 240,
  slippage:       1,
};

// ── 指標工具 ──────────────────────────────────────────────

// ADX / +DI / -DI（Wilder 平滑法）
// 回傳 { adx, plusDI, minusDI }，各為等長陣列，不足回傳 null
function calcADX(bars, period) {
  const n = bars.length;
  const adx    = new Array(n).fill(null);
  const plusDI = new Array(n).fill(null);
  const minusDI = new Array(n).fill(null);

  const tr   = new Array(n).fill(0);
  const plusDM  = new Array(n).fill(0);
  const minusDM = new Array(n).fill(0);

  for (let i = 1; i < n; i++) {
    const h = bars[i].high,  ph = bars[i - 1].high;
    const l = bars[i].low,   pl = bars[i - 1].low;
    const pc = bars[i - 1].close;

    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));

    const upMove   = h - ph;
    const downMove = pl - l;
    plusDM[i]  = (upMove > downMove && upMove > 0)   ? upMove   : 0;
    minusDM[i] = (downMove > upMove && downMove > 0) ? downMove : 0;
  }

  // Wilder 初始值（第 1~period 根加總）
  if (period >= n) return { adx, plusDI, minusDI };

  let smTR = 0, smPDM = 0, smMDM = 0;
  for (let i = 1; i <= period; i++) {
    smTR  += tr[i];
    smPDM += plusDM[i];
    smMDM += minusDM[i];
  }

  // 第一個 DI 值放在 index = period
  const dx = new Array(n).fill(null);

  const calcDI = (smP, smM, smT) => {
    const pdi = smT > 0 ? (100 * smP / smT) : 0;
    const mdi = smT > 0 ? (100 * smM / smT) : 0;
    const dxVal = (pdi + mdi) > 0 ? (100 * Math.abs(pdi - mdi) / (pdi + mdi)) : 0;
    return { pdi, mdi, dxVal };
  };

  let { pdi, mdi, dxVal } = calcDI(smPDM, smMDM, smTR);
  plusDI[period]  = pdi;
  minusDI[period] = mdi;
  dx[period]      = dxVal;

  for (let i = period + 1; i < n; i++) {
    smTR  = smTR  - smTR  / period + tr[i];
    smPDM = smPDM - smPDM / period + plusDM[i];
    smMDM = smMDM - smMDM / period + minusDM[i];
    const r = calcDI(smPDM, smMDM, smTR);
    plusDI[i]  = r.pdi;
    minusDI[i] = r.mdi;
    dx[i]      = r.dxVal;
  }

  // ADX = 前 period 個 DX 的平均作為種子，之後 Wilder 平滑
  const adxSeedStart = period;          // 第一個 DX
  const adxSeedEnd   = 2 * period - 1;  // 種子終點
  if (adxSeedEnd >= n) return { adx, plusDI, minusDI };

  let adxSum = 0;
  for (let i = adxSeedStart; i <= adxSeedEnd; i++) adxSum += dx[i];
  adx[adxSeedEnd] = adxSum / period;

  for (let i = adxSeedEnd + 1; i < n; i++) {
    adx[i] = (adx[i - 1] * (period - 1) + dx[i]) / period;
  }

  return { adx, plusDI, minusDI };
}

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
  const { adx: adxArr, plusDI, minusDI } = calcADX(bars, CONFIG.adxPeriod);

  // 3. 逐日模擬
  const trades = [];
  let equity = 0, maxEquity = 0, maxDrawdown = 0, winCount = 0;

  let position  = 0;   // 1 = 多, 0 = 無
  let entryPrice  = 0;
  let entryDate   = '';
  let stopLoss    = 0;

  const minIdx = Math.max(CONFIG.slowPeriod, CONFIG.atrPeriod, CONFIG.adxPeriod * 2) + 1;

  for (let i = minIdx; i < bars.length; i++) {
    const bar  = bars[i];
    const fast = sma5[i],   prevFast = sma5[i - 1];
    const slow = sma11[i],  prevSlow = sma11[i - 1];
    const curAtr = atrArr[i];
    const curAdx = adxArr[i];
    const curPDI = plusDI[i];
    const curMDI = minusDI[i];


    if (fast === null || slow === null || curAtr === null || curAdx === null) continue;

    const bullCross = prevFast <= prevSlow && fast > slow; // 黃金交叉
    const bearCross = prevFast >= prevSlow && fast < slow; // 死亡交叉

    // ADX 過濾：趨勢夠強 且 多方方向領先
    const adxFilter = curAdx >= CONFIG.adxThreshold && curPDI > curMDI;

    if (position === 1) {
      // ── 先檢查盤中停損（當日最低 <= 停損價）──
      if (bar.low <= stopLoss) {
        const exitPrice = stopLoss - CONFIG.slippage;
        recordTrade(trades, entryDate, bar.date, entryPrice, exitPrice, '停損', CONFIG);
        const pnl = trades[trades.length - 1].pnl;
        equity += pnl;
        if (pnl > 0) winCount++;
        position = 0;

      // ── 死亡交叉 → 收盤平倉 ──
      } else if (bearCross) {
        const exitPrice = bar.close - CONFIG.slippage;
        recordTrade(trades, entryDate, bar.date, entryPrice, exitPrice, '信號平倉', CONFIG);
        const pnl = trades[trades.length - 1].pnl;
        equity += pnl;
        if (pnl > 0) winCount++;
        position = 0;
      }
    }

    // ── 黃金交叉 + ADX 過濾 且 無部位 → 收盤做多 ──
    if (position === 0 && bullCross && adxFilter) {
      position   = 1;
      entryPrice = bar.close + CONFIG.slippage;
      entryDate  = bar.date;
      stopLoss   = entryPrice - CONFIG.atrMultiplier * curAtr;
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
    recordTrade(trades, entryDate, lastBar.date, entryPrice, exitPrice, '資料結束', CONFIG);
    const pnl = trades[trades.length - 1].pnl;
    equity += pnl;
    if (pnl > 0) winCount++;
  }

  // 4. 報告
  const report = buildReport(trades, maxDrawdown);
  const reportPath = path.join(__dirname, 'strategy2-1_report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`報告已寫入：${reportPath}`);
  printSummary(report);
}

// ── 輔助函式 ──────────────────────────────────────────────

function recordTrade(trades, entryDate, exitDate, entryPrice, exitPrice, reason, cfg) {
  const pnlPoints = exitPrice - entryPrice;
  const pnl = pnlPoints * cfg.pointValue - cfg.costPerTrade;
  trades.push({ entryDate, exitDate, entryPrice, exitPrice, pnlPoints, pnl, reason });
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
      id:            i + 1,
      entryDate:     t.entryDate,
      exitDate:      t.exitDate,
      entryPrice:    t.entryPrice,
      exitPrice:     t.exitPrice,
      pnlPoints:     +t.pnlPoints.toFixed(2),
      pnl:           +t.pnl.toFixed(0),
      cumulativePnl: +cumPnl.toFixed(0),
      exitReason:    t.reason,
    };
  });

  const reportEquity = reportTrades.reduce((s, t) => s + t.pnl, 0);
  const winCount     = wins.length;

  return {
    strategy: `SMA${CONFIG.fastPeriod}/SMA${CONFIG.slowPeriod} 黃金交叉做多 + ADX${CONFIG.adxPeriod}>=${CONFIG.adxThreshold} 過濾 + ATR${CONFIG.atrPeriod}×${CONFIG.atrMultiplier} 停損`,
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
