const fs = require('fs');
const path = require('path');

// ============================================================
//  台指期 日K — 布林通道突破做多（strategy6 家族）共用引擎
// ============================================================
//  資料來源：day_data/stocks.ftx.json（每日 OHLCV）
//
//  進場（20 支共用，固定不變）：
//    收盤價 > 布林通道上軌 BB(20, 2.0) → 當日尾盤（收盤價）買進 1 口多單
//    純做多、最多持有 1 口；持倉中不再加碼
//
//  出場：由各 strategy6-N.js 提供，共 20 種機制
//
//  每點價值 200 元（大台），來回成本 240 元
//
//  ── 時序約定（避免未來函數）──────────────────────────
//    ‧ 進場在「訊號日收盤」成立，故持有期間的最高/最低從進場日「次一根」起算
//    ‧ 盤中觸價出場：停損/停利價位一律由 i-1 之前的資料算出，再與第 i 根的
//      low/high 比對；更新移動停損則排在出場判斷「之後」
//    ‧ 收盤出場：用第 i 根收盤價判斷並以該收盤價成交（尾盤決策）
//    ‧ 同一根同時觸發盤中觸價與收盤訊號時，盤中觸價優先
// ============================================================

// ── CLI 參數 (--key=value) ────────────────────────────────

function parseCli(argv) {
  return Object.fromEntries(
    argv.slice(2)
      .filter(a => a.startsWith('--'))
      .map(a => { const [k, v] = a.slice(2).split('='); return [k, v === undefined ? 'true' : v]; })
  );
}

const num = (v, d) => (v !== undefined ? parseFloat(v) : d);
const int = (v, d) => (v !== undefined ? parseInt(v, 10) : d);

function baseConfig(cliArgs) {
  return {
    dataFile:   path.join(__dirname, 'day_data', 'stocks.ftx.json'),
    startDate:  cliArgs.startDate || null,
    endDate:    cliArgs.endDate   || null,
    bbPeriod:   int(cliArgs.bb,     20),
    bbMult:     num(cliArgs.bbMult, 2.0),
    entryMode:  cliArgs.entryMode || 'level',   // level = 收盤在上軌之上就進場；cross = 需由下向上突破
    pointValue:   200,
    costPerTrade: 240,
    slippage:   num(cliArgs.slippage, 0),
  };
}

// ── 指標 ──────────────────────────────────────────────────
//  一律回傳與 bars 等長的陣列，暖身不足處為 null

function calcSMA(arr, period) {
  const out = new Array(arr.length).fill(null);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= period) sum -= arr[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function calcEMA(arr, period) {
  const out = new Array(arr.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < arr.length; i++) {
    if (i === period - 1) {
      let sum = 0;
      for (let j = 0; j < period; j++) sum += arr[i - j];
      prev = sum / period;
      out[i] = prev;
    } else if (i >= period) {
      prev = arr[i] * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

/* 布林通道：中軌 = SMA(n)，上下軌 = 中軌 ± mult × 母體標準差(n) */
function calcBB(closes, period, mult) {
  const mid = calcSMA(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  const width = new Array(closes.length).fill(null);   // 帶寬 =（上−下）/ 中
  for (let i = period - 1; i < closes.length; i++) {
    let sq = 0;
    for (let j = 0; j < period; j++) sq += (closes[i - j] - mid[i]) ** 2;
    const sd = Math.sqrt(sq / period);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
    width[i] = mid[i] !== 0 ? (upper[i] - lower[i]) / mid[i] : null;
  }
  return { mid, upper, lower, width };
}

function calcATR(bars, period) {
  const tr = new Array(bars.length).fill(null);
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  const out = new Array(bars.length).fill(null);
  if (period >= bars.length) return out;
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  out[period] = sum / period;
  for (let i = period + 1; i < bars.length; i++) {
    out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  }
  return out;
}

/* KD（台股慣用 9 日、平滑 1/3，K、D 初始 50）*/
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
    k[i] = prevK; d[i] = prevD;
  }
  return { k, d };
}

/* RSI（Wilder 平滑）*/
function calcRSI(closes, period) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gain += ch; else loss -= ch;
  }
  let ag = gain / period, al = loss / period;
  out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + (ch > 0 ?  ch : 0)) / period;
    al = (al * (period - 1) + (ch < 0 ? -ch : 0)) / period;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

function calcMACD(closes, fast, slow, signal) {
  const ef = calcEMA(closes, fast);
  const es = calcEMA(closes, slow);
  const macd = closes.map((_, i) => (ef[i] !== null && es[i] !== null ? ef[i] - es[i] : null));
  const start = macd.findIndex(v => v !== null);
  const compact = macd.slice(start).map(v => v);
  const sigCompact = calcEMA(compact, signal);
  const sig = new Array(closes.length).fill(null);
  for (let i = 0; i < sigCompact.length; i++) sig[start + i] = sigCompact[i];
  const hist = closes.map((_, i) => (macd[i] !== null && sig[i] !== null ? macd[i] - sig[i] : null));
  return { macd, signal: sig, hist };
}

/* 過去 period 根（不含當根）的最低 low — 海龜式出場用 */
function calcDonchianLow(bars, period) {
  const out = new Array(bars.length).fill(null);
  for (let i = period; i < bars.length; i++) {
    let ln = Infinity;
    for (let j = 1; j <= period; j++) if (bars[i - j].low < ln) ln = bars[i - j].low;
    out[i] = ln;
  }
  return out;
}

/* Parabolic SAR（Wilder）：回傳 { sar, isLong } */
function calcPSAR(bars, step, maxStep) {
  const sar = new Array(bars.length).fill(null);
  const isLong = new Array(bars.length).fill(null);
  if (bars.length < 2) return { sar, isLong };

  let long = bars[1].close >= bars[0].close;
  let af = step;
  let ep = long ? bars[1].high : bars[1].low;
  let cur = long ? bars[0].low : bars[0].high;
  sar[1] = cur; isLong[1] = long;

  for (let i = 2; i < bars.length; i++) {
    let next = cur + af * (ep - cur);
    if (long) {
      next = Math.min(next, bars[i - 1].low, bars[i - 2].low);
      if (bars[i].low < next) {                 // 翻空
        long = false; next = ep; ep = bars[i].low; af = step;
      } else if (bars[i].high > ep) { ep = bars[i].high; af = Math.min(af + step, maxStep); }
    } else {
      next = Math.max(next, bars[i - 1].high, bars[i - 2].high);
      if (bars[i].high > next) {                // 翻多
        long = true; next = ep; ep = bars[i].high; af = step;
      } else if (bars[i].low < ep) { ep = bars[i].low; af = Math.min(af + step, maxStep); }
    }
    cur = next;
    sar[i] = cur; isLong[i] = long;
  }
  return { sar, isLong };
}

// ── 資料與指標準備 ────────────────────────────────────────

function loadBars(cfg) {
  const raw = JSON.parse(fs.readFileSync(cfg.dataFile, 'utf-8'));
  return raw
    .map(b => ({ date: b.date, open: b.open, high: b.max, low: b.min, close: b.close, volume: b.volume }))
    .filter(b => (!cfg.startDate || b.date >= cfg.startDate) && (!cfg.endDate || b.date <= cfg.endDate))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

function buildIndicators(bars, cfg) {
  const closes = bars.map(b => b.close);
  return {
    closes,
    bb:    calcBB(closes, cfg.bbPeriod, cfg.bbMult),
    atr14: calcATR(bars, 14),
    atr22: calcATR(bars, 22),
    sma5:  calcSMA(closes, 5),
    sma20: calcSMA(closes, 20),
    kd:    calcKD(bars, 9),
    rsi14: calcRSI(closes, 14),
    macd:  calcMACD(closes, 12, 26, 9),
    donch: calcDonchianLow(bars, 10),
    psar:  calcPSAR(bars, 0.02, 0.2),
  };
}

// ── 回測引擎 ──────────────────────────────────────────────
//
//  spec = {
//    id, name, rule,                 // 文字描述
//    config,                         // 合併後的設定（含策略自訂參數）
//    warmup,                         // 起始索引（指標暖身）
//    onEntry(ctx),                   // 選用：回傳要掛在 position 上的欄位（停損價等）
//    exit(ctx) -> null | { price, reason }
//  }
//  ctx = { i, bar, prev, bars, ind, pos, cfg }
//
function runStrategy6(spec) {
  const cfg = spec.config;
  const bars = spec.bars || loadBars(cfg);
  const ind  = spec.ind  || buildIndicators(bars, cfg);
  const { upper } = ind.bb;

  const trades = [];
  let equity = 0, maxEquity = 0, maxDrawdown = 0;
  let pos = null;

  const warmup = Math.max(spec.warmup || 0, cfg.bbPeriod + 1, 30);

  for (let i = warmup; i < bars.length; i++) {
    const bar = bars[i], prev = bars[i - 1];
    if (upper[i] === null) continue;

    // ── 出場（先於進場判斷；盤中觸價由各策略自行用 bar.low 比對）──
    if (pos) {
      const res = spec.exit({ i, bar, prev, bars, ind, pos, cfg });
      if (res) {
        equity += closePosition(trades, pos, bars, i, res.price - cfg.slippage, res.reason, cfg);
        pos = null;
      } else {
        // 出場判斷之後才更新持有期間極值（移動停損下一根才會用到今天的高點）
        if (bar.high > pos.maxHigh) { pos.maxHigh = bar.high; pos.maxHighIdx = i; }
        if (bar.low  < pos.minLow)  pos.minLow  = bar.low;
        if (typeof spec.onBar === 'function') spec.onBar({ i, bar, prev, bars, ind, pos, cfg });
      }
    }

    // ── 進場：收盤 > 上軌 → 尾盤買進 ──
    if (!pos) {
      const above = bar.close > upper[i];
      const fresh = cfg.entryMode === 'cross'
        ? (upper[i - 1] !== null && prev.close <= upper[i - 1] && above)
        : above;
      if (fresh) {
        const price = bar.close + cfg.slippage;
        pos = {
          date: bar.date, idx: i, price,
          entryLow: bar.low, entryHigh: bar.high,
          maxHigh: price, maxHighIdx: i, minLow: price,
          barsHeld: 0,
        };
        if (typeof spec.onEntry === 'function') {
          Object.assign(pos, spec.onEntry({ i, bar, prev, bars, ind, pos, cfg }) || {});
        }
      }
    }

    if (pos) pos.barsHeld = i - pos.idx;
    if (equity > maxEquity) maxEquity = equity;
    const dd = maxEquity - equity;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // 資料結束仍有部位 → 末根收盤平倉（依家族慣例不計入統計，但要在報表裡攤開）
  let openPosition = null;
  if (pos) {
    const last = bars.length - 1;
    const exitPrice = bars[last].close - cfg.slippage;
    openPosition = {
      entryDate: pos.date,
      entryPrice: pos.price,
      lastDate: bars[last].date,
      lastClose: bars[last].close,
      holdDays: last - pos.idx,
      unrealizedPoints: +(exitPrice - pos.price).toFixed(2),
      unrealizedPnl: +((exitPrice - pos.price) * cfg.pointValue - cfg.costPerTrade).toFixed(0),
    };
    equity += closePosition(trades, pos, bars, last, exitPrice, '資料結束', cfg);
  }

  return buildReport(spec, trades, maxDrawdown, bars, openPosition);
}

// 持有期間（進場日次一根 ~ 出場日）的最高 high / 最低 low
function holdExtremes(bars, entryIdx, exitIdx) {
  let hi = -Infinity, lo = Infinity;
  for (let i = entryIdx + 1; i <= exitIdx; i++) {
    if (bars[i].high > hi) hi = bars[i].high;
    if (bars[i].low  < lo) lo = bars[i].low;
  }
  if (hi === -Infinity) { hi = bars[exitIdx].close; lo = bars[exitIdx].close; }
  return { hi, lo };
}

function closePosition(trades, pos, bars, exitIdx, exitPrice, reason, cfg) {
  const { hi, lo } = holdExtremes(bars, pos.idx, exitIdx);
  const pnlPoints = exitPrice - pos.price;
  const pnl = pnlPoints * cfg.pointValue - cfg.costPerTrade;
  trades.push({
    entryDate: pos.date, exitDate: bars[exitIdx].date,
    entryPrice: pos.price, exitPrice,
    holdDays: exitIdx - pos.idx,
    mfePoints: +(hi - pos.price).toFixed(2),   // 持有期間最大有利波動
    maePoints: +(lo - pos.price).toFixed(2),   // 持有期間最大不利波動
    pnlPoints, pnl, reason,
  });
  return pnl;
}

// ── 報表 ──────────────────────────────────────────────────

function buildReport(spec, trades, maxDrawdown, bars, openPosition) {
  const cfg = spec.config;
  const rt = trades.filter(t => t.reason !== '資料結束');
  const n = rt.length;
  const wins   = rt.filter(t => t.pnl > 0);
  const losses = rt.filter(t => t.pnl <= 0);
  const totalWin  = wins.reduce((s, t) => s + t.pnl, 0);
  const totalLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const totalPnl  = rt.reduce((s, t) => s + t.pnl, 0);
  const holdDays  = rt.reduce((s, t) => s + t.holdDays, 0);

  const yearMap = {};
  for (const t of rt) {
    const y = t.entryDate.slice(0, 4);
    (yearMap[y] = yearMap[y] || { pnl: 0, count: 0, wins: 0 });
    yearMap[y].pnl += t.pnl; yearMap[y].count++;
    if (t.pnl > 0) yearMap[y].wins++;
  }
  const yearlyPerformance = Object.entries(yearMap).sort().map(([year, d]) => ({
    year, pnl: +d.pnl.toFixed(0), trades: d.count, wins: d.wins,
    losses: d.count - d.wins, winRate: +((d.wins / d.count) * 100).toFixed(2),
  }));

  const reasonMap = {};
  for (const t of rt) {
    (reasonMap[t.reason] = reasonMap[t.reason] || { pnl: 0, count: 0, wins: 0 });
    reasonMap[t.reason].pnl += t.pnl; reasonMap[t.reason].count++;
    if (t.pnl > 0) reasonMap[t.reason].wins++;
  }
  const exitReasonStats = Object.entries(reasonMap).sort().map(([reason, d]) => ({
    reason, trades: d.count, wins: d.wins, losses: d.count - d.wins,
    winRate: +((d.wins / d.count) * 100).toFixed(2),
    pnl: +d.pnl.toFixed(0), avgPnl: +(d.pnl / d.count).toFixed(0),
  }));

  let cum = 0;
  const tradeDetails = rt.map((t, i) => {
    cum += t.pnl;
    return {
      id: i + 1, entryDate: t.entryDate, exitDate: t.exitDate,
      entryPrice: t.entryPrice, exitPrice: +t.exitPrice.toFixed(0),
      holdDays: t.holdDays, mfePoints: t.mfePoints, maePoints: t.maePoints,
      pnlPoints: +t.pnlPoints.toFixed(2), pnl: +t.pnl.toFixed(0),
      cumulativePnl: +cum.toFixed(0), exitReason: t.reason,
    };
  });

  const profitFactor = totalLoss > 0 ? totalWin / totalLoss : (totalWin > 0 ? Infinity : 0);

  /* 台指 25 年間由 4000 漲到 45000，但每點一律 200 元 →
     用台幣絕對金額排名會系統性偏袒近年。這裡同時算「相對名目本金的報酬率」，
     與指數點位無關，才能公平比較不同出場機制。 */
  const pcts = rt.map(t => (t.pnl / (t.entryPrice * cfg.pointValue)) * 100);
  const pctSum = pcts.reduce((s, v) => s + v, 0);
  const pctCompound = (pcts.reduce((s, v) => s * (1 + v / 100), 1) - 1) * 100;

  return {
    id: spec.id,
    strategy: `${spec.name} — 收盤 > BB(${cfg.bbPeriod},${cfg.bbMult}) 上軌尾盤做多（1口）｜出場：${spec.rule}`,
    exitRule: spec.rule,
    config: { ...cfg, dataFile: undefined },
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
      profitFactor: profitFactor === Infinity ? null : +profitFactor.toFixed(2),
      rewardRiskRatio: +(losses.length > 0 && wins.length > 0
        ? ((totalWin / wins.length) / (totalLoss / losses.length)).toFixed(2) : 0),
      maxDrawdown: +(-maxDrawdown).toFixed(0),
      pnlToMaxDD: +(maxDrawdown > 0 ? (totalPnl / maxDrawdown).toFixed(2) : 0),
      pctSum:      +pctSum.toFixed(2),
      avgPctPerTrade: +(n > 0 ? (pctSum / n).toFixed(3) : 0),
      pctCompound: +pctCompound.toFixed(1),
      avgHoldDays: +(n > 0 ? (holdDays / n).toFixed(1) : 0),
      exposureRatio: +((holdDays / bars.length) * 100).toFixed(2),
      buyHoldPnl: +((bars[bars.length - 1].close - bars[0].close) * cfg.pointValue).toFixed(0),
    },
    openPosition,
    exitReasonStats,
    yearlyPerformance,
    trades: tradeDetails,
  };
}

function printSummary(report) {
  const s = report.summary;
  console.log('='.repeat(72));
  console.log(`策略 ${report.id}：${report.strategy}`);
  console.log(`回測：${s.backtestPeriod.start} ~ ${s.backtestPeriod.end}（${s.backtestPeriod.tradingDays} 個交易日）`);
  console.log(`交易：${s.totalTrades} 次  勝率：${s.winRate}%  平均持有：${s.avgHoldDays} 日  在場比例：${s.exposureRatio}%`);
  console.log(`總損益：${s.totalPnl.toLocaleString()} 元  平均每筆：${s.avgPnl.toLocaleString()} 元`);
  console.log(`平均獲利：${s.avgWin.toLocaleString()}  平均虧損：${s.avgLoss.toLocaleString()}`);
  console.log(`最大單筆獲利：${s.maxWin.toLocaleString()}  最大單筆虧損：${s.maxLoss.toLocaleString()}`);
  console.log(`獲利因子：${s.profitFactor}  報酬風險比：${s.rewardRiskRatio}`);
  console.log(`最大回撤：${s.maxDrawdown.toLocaleString()} 元  總損益/最大回撤：${s.pnlToMaxDD}`);
  console.log(`與點位無關的報酬：累計 ${s.pctSum}%（複利 ${s.pctCompound}%）  平均每筆 ${s.avgPctPerTrade}%`);
  console.log(`買進持有對照：${s.buyHoldPnl.toLocaleString()} 元`);
  if (report.openPosition) {
    const o = report.openPosition;
    console.log(`⚠ 期末仍有未平倉部位：${o.entryDate} 進場 @${o.entryPrice}，抱到 ${o.lastDate}（${o.holdDays} 個交易日），` +
                `未實現 ${o.unrealizedPoints} 點 / ${o.unrealizedPnl.toLocaleString()} 元 — 未計入上方統計`);
  }
  console.log('='.repeat(72));
  if (report.exitReasonStats.length > 1) {
    console.log('\n出場原因統計：');
    for (const r of report.exitReasonStats) {
      console.log(`  ${r.reason.padEnd(18)} ${String(r.trades).padStart(4)} 次  勝率 ${String(r.winRate).padStart(6)}%  損益 ${String(r.pnl.toLocaleString()).padStart(12)} 元  平均 ${String(r.avgPnl.toLocaleString()).padStart(9)} 元`);
    }
  }
  console.log('\n年度績效：');
  for (const y of report.yearlyPerformance) {
    console.log(`  ${y.year}  ${String(y.pnl.toLocaleString()).padStart(12)} 元  勝率 ${String(y.winRate).padStart(6)}%  交易 ${String(y.trades).padStart(3)} 次`);
  }
}

function writeReport(report) {
  const p = path.join(__dirname, `strategy${report.id}_report.json`);
  fs.writeFileSync(p, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`報告已寫入：${p}`);
}

/* 各 strategy6-N.js 只要呼叫這支：直接執行就跑回測＋出報告，
   被 require 時只匯出 makeSpec 供 strategy6_compare.js 使用 */
function defineStrategy(mod, makeSpec) {
  mod.exports = { makeSpec };
  if (require.main === mod) {
    const cliArgs = parseCli(process.argv);
    const spec = makeSpec(cliArgs);
    const bars = loadBars(spec.config);
    console.log(`載入 ${bars.length} 個交易日 (${bars[0].date} ~ ${bars[bars.length - 1].date})\n`);
    const report = runStrategy6({ ...spec, bars, ind: buildIndicators(bars, spec.config) });
    writeReport(report);
    printSummary(report);
  }
}

module.exports = {
  parseCli, baseConfig, num, int,
  calcSMA, calcEMA, calcBB, calcATR, calcKD, calcRSI, calcMACD, calcDonchianLow, calcPSAR,
  loadBars, buildIndicators, runStrategy6, buildReport, printSummary, writeReport, defineStrategy,
};
