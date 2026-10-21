const fs = require('fs');
const path = require('path');

// ============================================================
//  台指期 1 分 K — 開盤區間突破策略 (Opening Range Breakout)
// ============================================================
//  規則：
//    1. 取日盤前 15 分鐘 (08:46~09:00) 的最高價 / 最低價建立「開盤區間」
//    2. 09:01 之後：
//       - 收盤價突破區間高點 → 做多
//       - 收盤價跌破區間低點 → 做空
//    3. 停損：區間反向邊界（做多停損 = 區間低點，做空停損 = 區間高點）
//    4. 停利：獲利達區間寬度 × 倍數
//    5. 每日最多交易 N 次，13:25 前強制平倉
//    6. 每點價值 200 元（台指期大台）
// ============================================================

// --- 參數設定 ---
const CONFIG = {
  dataDir: path.join(__dirname, 'day_data'),
  startDate: '2020-03-02',
  endDate: '2026-03-26',

  // 開盤區間時段 (HH:MM)
  rangeStart: '08:46',
  rangeEnd: '09:20',

  // 可交易時段
  tradeStart: '09:20',
  tradeEnd: '13:44',

  // 停利倍數（相對於區間寬度）
  tpMultiplier: 2.0,

  // 每日最大交易次數
  maxTradesPerDay: 2,

  // 最小區間寬度（點數），太小的區間不做
  minRangeSize: 20,

  // 每點價值
  pointValue: 200,

  // 交易成本（來回，含手續費 + 稅）
  costPerTrade: 240,

  // 滑價（單邊點數）
  slippage: 1,

  // --- tse_volume 量能過濾 ---
  // 突破當根的 tse_volume 必須 >= 近 N 根均量 × 倍數才進場
  tseVolLookback: 5,        // 回看幾根 K 棒計算均量
  tseVolMultiplier: 1.2,    // 突破根量 >= 均量 × 此倍數
};

// --- 工具函式 ---
function getTime(datetimeStr) {
  return datetimeStr.split(' ')[1]; // "HH:MM:SS" or "HH:MM"
}

function timeInRange(time, start, end) {
  const t = time.slice(0, 5); // 取 HH:MM
  return t >= start && t <= end;
}

function loadDayData(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw);
}

// --- 主策略 ---
function runStrategy() {
  const files = fs.readdirSync(CONFIG.dataDir)
    .filter(f => f.endsWith('.json'))
    .filter(f => {
      const date = f.replace('.json', '');
      return date >= CONFIG.startDate && date <= CONFIG.endDate;
    })
    .sort();

  console.log(`載入 ${files.length} 個交易日資料 (${files[0]} ~ ${files[files.length - 1]})\n`);

  const allTrades = [];
  let equity = 0;
  let maxEquity = 0;
  let maxDrawdown = 0;
  let winCount = 0;
  let lossCount = 0;

  for (const file of files) {
    const date = file.replace('.json', '');
    const bars = loadDayData(path.join(CONFIG.dataDir, file));

    // 1. 篩選日盤 K 棒
    const dayBars = bars.filter(b => {
      const t = getTime(b.datetime).slice(0, 5);
      return t >= '08:45' && t <= '13:45';
    });

    if (dayBars.length === 0) continue;

    // 2. 計算開盤區間
    const rangeBars = dayBars.filter(b =>
      timeInRange(getTime(b.datetime), CONFIG.rangeStart, CONFIG.rangeEnd)
    );

    if (rangeBars.length === 0) continue;

    const rangeHigh = Math.max(...rangeBars.map(b => b.high));
    const rangeLow = Math.min(...rangeBars.map(b => b.low));
    const rangeSize = rangeHigh - rangeLow;

    if (rangeSize < CONFIG.minRangeSize) continue;

    // 3. 交易時段 K 棒
    const tradeBars = dayBars.filter(b =>
      timeInRange(getTime(b.datetime), CONFIG.tradeStart, CONFIG.tradeEnd)
    );

    if (tradeBars.length === 0) continue;

    // 4. 模擬當日交易
    let position = 0;  // 1=多, -1=空, 0=無
    let entryPrice = 0;
    let stopLoss = 0;
    let takeProfit = 0;
    let dayTradeCount = 0;
    let usedDirection = {};  // 記錄已使用的突破方向，防止同方向重複進場

    for(var index = 0; index < tradeBars.length; index++) {
      const bar = tradeBars[index];
      const time = getTime(bar.datetime).slice(0, 5);

      // 強制平倉時間
      if (time >= CONFIG.tradeEnd && position !== 0) {
        const exitPrice = bar.close + (position === 1 ? -CONFIG.slippage : CONFIG.slippage);
        const pnlPoints = position === 1
          ? exitPrice - entryPrice
          : entryPrice - exitPrice;
        const pnl = pnlPoints * CONFIG.pointValue - CONFIG.costPerTrade;

        const pending = allTrades.pop(); // 取回進場暫存
        allTrades.push({
          date,
          direction: position === 1 ? '多' : '空',
          entry: entryPrice,
          exit: exitPrice,
          entryTime: pending._entryTime || '',
          exitTime: bar.datetime,
          pnlPoints,
          pnl,
          reason: '收盤平倉',
        });

        equity += pnl;
        if (pnl > 0) winCount++; else lossCount++;
        position = 0;
        break;
      }

      if (position === 0 && dayTradeCount < CONFIG.maxTradesPerDay) {
        // 嘗試進場（同方向不重複進場）
        if (bar.high > rangeHigh && !usedDirection[1]) {
          // 突破高點 → 做多
          position = 1;
          entryPrice = rangeHigh + CONFIG.slippage;
          stopLoss = rangeLow;
          takeProfit = rangeHigh + rangeSize * CONFIG.tpMultiplier;
          dayTradeCount++;
          usedDirection[1] = true;
          allTrades.push({ _entryTime: bar.datetime, _entryPrice: entryPrice });
        } else if (bar.low < rangeLow && !usedDirection[-1]) {
          // 跌破低點 → 做空
          position = -1;
          entryPrice = rangeLow - CONFIG.slippage;
          stopLoss = rangeHigh;
          takeProfit = rangeLow - rangeSize * CONFIG.tpMultiplier;
          dayTradeCount++;
          usedDirection[-1] = true;
          allTrades.push({ _entryTime: bar.datetime, _entryPrice: entryPrice });
        }
      } else if (position !== 0) {
        // 檢查停損 / 停利
        let exitPrice = null;
        let reason = '';

        if (position === 1) {
          if (bar.low <= stopLoss) {
            exitPrice = stopLoss - CONFIG.slippage;
            reason = '停損';
          } else if (bar.high >= takeProfit) {
            exitPrice = takeProfit - CONFIG.slippage;
            reason = '停利';
          }
        } else {
          if (bar.high >= stopLoss) {
            exitPrice = stopLoss + CONFIG.slippage;
            reason = '停損';
          } else if (bar.low <= takeProfit) {
            exitPrice = takeProfit + CONFIG.slippage;
            reason = '停利';
          }
        }

        if (exitPrice !== null) {
          const pending = allTrades.pop(); // 取回進場暫存
          const pnlPoints = position === 1
            ? exitPrice - entryPrice
            : entryPrice - exitPrice;
          const pnl = pnlPoints * CONFIG.pointValue - CONFIG.costPerTrade;

          allTrades.push({
            date,
            direction: position === 1 ? '多' : '空',
            entry: entryPrice,
            exit: exitPrice,
            entryTime: pending._entryTime,
            exitTime: bar.datetime,
            pnlPoints,
            pnl,
            reason,
          });

          equity += pnl;
          if (pnl > 0) winCount++; else lossCount++;
          position = 0;
        }
      }
    }

    // 日結束時若仍有部位，以最後一根 K 收盤平倉
    if (position !== 0) {
      const lastBar = tradeBars[tradeBars.length - 1];
      const exitPrice = lastBar.close + (position === 1 ? -CONFIG.slippage : CONFIG.slippage);
      const pending = allTrades.pop();
      const pnlPoints = position === 1
        ? exitPrice - entryPrice
        : entryPrice - exitPrice;
      const pnl = pnlPoints * CONFIG.pointValue - CONFIG.costPerTrade;

      allTrades.push({
        date,
        direction: position === 1 ? '多' : '空',
        entry: entryPrice,
        exit: exitPrice,
        entryTime: pending._entryTime || '',
        exitTime: lastBar.datetime,
        pnlPoints,
        pnl,
        reason: '收盤平倉',
      });

      equity += pnl;
      if (pnl > 0) winCount++; else lossCount++;
    }

    // 追蹤最大回撤
    if (equity > maxEquity) maxEquity = equity;
    const dd = maxEquity - equity;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // --- 過濾掉暫存記錄 ---
  const trades = allTrades.filter(t => t.date);

  // --- 產生 JSON 報告 ---
  const report = buildReport(trades, equity, maxDrawdown, winCount);
  const reportPath = path.join(__dirname, 'strategy1_report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`報告已寫入：${reportPath}`);
}

// --- 組建報告物件 ---
function buildReport(trades, equity, maxDrawdown, winCount) {
  const totalTrades = trades.length;
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalWin = wins.reduce((s, t) => s + t.pnl, 0);
  const totalLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  // 按年統計
  const yearMap = {};
  for (const t of trades) {
    const year = t.date.slice(0, 4);
    if (!yearMap[year]) yearMap[year] = { pnl: 0, count: 0, wins: 0 };
    yearMap[year].pnl += t.pnl;
    yearMap[year].count++;
    if (t.pnl > 0) yearMap[year].wins++;
  }

  const yearlyPerformance = Object.entries(yearMap).sort().map(([year, d]) => ({
    year,
    pnl: d.pnl,
    trades: d.count,
    wins: d.wins,
    losses: d.count - d.wins,
    winRate: +((d.wins / d.count) * 100).toFixed(2),
  }));

  // 每筆交易加上累計損益
  let cumPnl = 0;
  const tradeDetails = trades.map((t, i) => {
    cumPnl += t.pnl;
    return {
      id: i + 1,
      date: t.date,
      direction: t.direction,
      entryTime: t.entryTime,
      exitTime: t.exitTime,
      entryPrice: t.entry,
      exitPrice: t.exit,
      pnlPoints: t.pnlPoints,
      pnl: t.pnl,
      cumulativePnl: cumPnl,
      exitReason: t.reason,
    };
  });

  return {
    strategy: '開盤區間突破 (Opening Range Breakout)',
    config: CONFIG,
    summary: {
      backtestPeriod: {
        start: trades.length > 0 ? trades[0].date : null,
        end: trades.length > 0 ? trades[trades.length - 1].date : null,
      },
      totalTrades,
      wins: winCount,
      losses: totalTrades - winCount,
      winRate: +(totalTrades > 0 ? ((winCount / totalTrades) * 100).toFixed(2) : 0),
      totalPnl: equity,
      avgPnl: +(totalTrades > 0 ? (equity / totalTrades).toFixed(0) : 0),
      avgWin: +(wins.length > 0 ? (totalWin / wins.length).toFixed(0) : 0),
      avgLoss: +(losses.length > 0 ? (-totalLoss / losses.length).toFixed(0) : 0),
      maxWin: Math.max(...trades.map(t => t.pnl), 0),
      maxLoss: Math.min(...trades.map(t => t.pnl), 0),
      profitFactor: +(totalLoss > 0 ? (totalWin / totalLoss).toFixed(2) : 0),
      rewardRiskRatio: +(losses.length > 0 && wins.length > 0
        ? ((totalWin / wins.length) / (totalLoss / losses.length)).toFixed(2) : 0),
      maxDrawdown: -maxDrawdown,
    },
    yearlyPerformance,
    trades: tradeDetails,
  };
}

// --- 執行 ---
runStrategy();
