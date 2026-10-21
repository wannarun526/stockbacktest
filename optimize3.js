const fs   = require('fs');
const path = require('path');

// ── 參數範圍 ──────────────────────────────────────────────
const NW_H_MIN    = 5.0,  NW_H_MAX    = 100.0, NW_H_STEP    = 0.1;
const NW_MULT_MIN = 1.0,  NW_MULT_MAX = 3.0,  NW_MULT_STEP = 0.1;

const ATR_PERIOD     = 14;
const ATR_MULTIPLIER = 1.0;
const POINT_VALUE    = 200;
const COST_PER_TRADE = 240;
const SLIPPAGE       = 0;

// ── 指標工具 ──────────────────────────────────────────────

function calcATR(bars, period) {
  const tr = new Array(bars.length).fill(null);
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  const result = new Array(bars.length).fill(null);
  if (period >= bars.length) return result;
  let sum = 0;
  for (let i = 1; i <= period; i++) {
    if (tr[i] === null) return result;
    sum += tr[i];
  }
  result[period] = sum / period;
  for (let i = period + 1; i < bars.length; i++) {
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

// ── 策略回測（不產生報告，只回傳 totalPnl）──────────────

function closeTrade(pnls, entryPrice, exitPrice) {
  const pnl = (exitPrice - entryPrice) * POINT_VALUE - COST_PER_TRADE;
  pnls.push(pnl);
  return pnl;
}

function runBacktest(bars, atrArr, nwMean, nwMult) {
  const minIdx = ATR_PERIOD + 1;
  const positions = [];
  const pnls = [];

  for (let i = minIdx; i < bars.length; i++) {
    const bar  = bars[i];
    const atr  = atrArr[i];
    const mean = nwMean[i];
    if (atr === null || mean === null) continue;

    const lower     = mean - nwMult * atr;
    const prevLower = atrArr[i - 1] !== null ? nwMean[i - 1] - nwMult * atrArr[i - 1] : null;

    // 1. 尾盤出場：收盤 ≥ NW 中軸
    if (positions.length > 0 && bar.close >= mean) {
      const exitPrice = bar.close - SLIPPAGE;
      for (const pos of positions) closeTrade(pnls, pos.entryPrice, exitPrice);
      positions.length = 0;
    }

    // 2. 進場
    const prevClose = bars[i - 1].close;
    const cond1 = bar.close < lower;
    const cond2 = prevLower !== null && prevClose < prevLower && bar.close >= lower;
    if (cond1 || cond2) {
      positions.push({ entryPrice: bar.close + SLIPPAGE, entryReason: cond1 ? 1 : 2 });
    }
  }

  // 資料結束平倉
  if (positions.length > 0) {
    const lastClose = bars[bars.length - 1].close - SLIPPAGE;
    for (const pos of positions) closeTrade(pnls, pos.entryPrice, lastClose);
  }

  const wins   = pnls.filter(p => p > 0);
  const losses = pnls.filter(p => p <= 0);
  const totalPnl   = pnls.reduce((s, p) => s + p, 0);
  const totalWin   = wins.reduce((s, p) => s + p, 0);
  const totalLoss  = Math.abs(losses.reduce((s, p) => s + p, 0));
  const avgWin     = wins.length   > 0 ? totalWin  / wins.length   : 0;
  const avgLoss    = losses.length > 0 ? totalLoss / losses.length : 0;
  const rrRatio    = avgLoss > 0 && avgWin > 0 ? avgWin / avgLoss : 0;

  return { totalPnl, rrRatio, trades: pnls.length, wins: wins.length };
}

// ── 主程式 ────────────────────────────────────────────────

function main() {
  const raw  = JSON.parse(fs.readFileSync(path.join(__dirname, 'day_data', 'stocks.ftx.json'), 'utf-8'));
  const bars = raw
    .map(d => ({ date: d.date, open: d.open, high: d.max, low: d.min, close: d.close, volume: d.volume }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  console.log(`載入 ${bars.length} 個交易日 (${bars[0].date} ~ ${bars[bars.length - 1].date})`);

  const closes = bars.map(b => b.close);
  const atrArr = calcATR(bars, ATR_PERIOD);

  // 產生 nwH 列表（浮點精度處理）
  const hList    = [];
  const multList = [];
  for (let v = NW_H_MIN;    v <= NW_H_MAX    + 1e-9; v = +(v + NW_H_STEP).toFixed(10))    hList.push(+v.toFixed(1));
  for (let v = NW_MULT_MIN; v <= NW_MULT_MAX + 1e-9; v = +(v + NW_MULT_STEP).toFixed(10)) multList.push(+v.toFixed(1));

  const total = hList.length * multList.length;
  console.log(`\n開始網格搜索：nwH ${NW_H_MIN}~${NW_H_MAX} (${hList.length}個) × nwMult ${NW_MULT_MIN}~${NW_MULT_MAX} (${multList.length}個) = ${total} 組合`);
  console.log('每個 nwH 計算一次 NW Kernel，請稍候...\n');

  let best = { rrRatio: -Infinity, nwH: null, nwMult: null };
  const results = [];

  const startTime = Date.now();

  for (const nwH of hList) {
    process.stdout.write(`計算 nwH=${nwH.toFixed(1)} NW Kernel...`);
    const nwMean = calcNWKernel(closes, nwH);
    process.stdout.write(` 回測 ${multList.length} 個 nwMult 組合\n`);

    for (const nwMult of multList) {
      const r = runBacktest(bars, atrArr, nwMean, nwMult);
      results.push({ nwH, nwMult, rrRatio: +r.rrRatio.toFixed(4), totalPnl: +r.totalPnl.toFixed(0), trades: r.trades, wins: r.wins });
      if (r.rrRatio > best.rrRatio) {
        best = { rrRatio: +r.rrRatio.toFixed(4), totalPnl: +r.totalPnl.toFixed(0), trades: r.trades, wins: r.wins, nwH, nwMult };
      }
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n完成！耗時 ${elapsed} 秒\n`);

  // 排序輸出前10（依報酬風險比）
  results.sort((a, b) => b.rrRatio - a.rrRatio);
  console.log('='.repeat(75));
  console.log('Top 10 組合（依報酬風險比排序）：');
  console.log('='.repeat(75));
  console.log('  排名  nwH    nwMult   報酬風險比  總損益(元)       交易  勝率');
  console.log('-'.repeat(75));
  for (let i = 0; i < Math.min(10, results.length); i++) {
    const r = results[i];
    const winRate = r.trades > 0 ? (r.wins / r.trades * 100).toFixed(1) : '0.0';
    console.log(
      `  #${String(i + 1).padEnd(4)} ${String(r.nwH.toFixed(1)).padEnd(7)} ${String(r.nwMult.toFixed(1)).padEnd(9)} ${String(r.rrRatio.toFixed(4)).padEnd(12)} ${String(r.totalPnl.toLocaleString()).padEnd(17)} ${String(r.trades).padEnd(6)} ${winRate}%`
    );
  }
  console.log('='.repeat(75));
  console.log(`\n最佳組合：nwH=${best.nwH}  nwMult=${best.nwMult}  報酬風險比=${best.rrRatio}  總損益=${best.totalPnl.toLocaleString()} 元`);
  console.log(`執行命令：node strategy3.js --nwH=${best.nwH} --nwMult=${best.nwMult}`);

  // 寫出完整結果
  const outPath = path.join(__dirname, 'optimize3_result.json');
  fs.writeFileSync(outPath, JSON.stringify({ metric: 'rrRatio', best, top10: results.slice(0, 10), all: results }, null, 2), 'utf-8');
  console.log(`\n完整結果已寫入：${outPath}`);
}

main();
