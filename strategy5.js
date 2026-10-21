const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// ============================================================
//  台指期 日K — Codex CLI（gpt-6-luna）逐日決策（純做多，最多 1 口）
// ============================================================
//  資料來源：day_data/stocks.ftx.json（每日 OHLCV）
//
//  規則：
//    每個交易日尾盤，把「從 2001-04-09 到當日為止」的逐日
//    open / max / min / close / volume 餵給 codex，請它決策，
//    再依決策回測。最多持有 1 口，只能做多。
//
//  ※ 決策引擎：本機 codex CLI（`codex exec`），走 ChatGPT 訂閱登入
//    （`codex login status` 要顯示 Logged in using ChatGPT），不需要 API key。
//    用 `--output-schema` 強制回傳 typed JSON，取代原本 jev 的 typed decision。
//
//  ※ 模型選擇：預設 gpt-6-luna + reasoning effort low。
//    可用檔位（由輕到重）：gpt-6-luna < gpt-5.6-terra < gpt-6-sol < gpt-6-astra < gpt-6-pro。
//    這個任務是 6249 次輕量分類，luna 最快；要比較品質可用 --model= 換檔。
//
//  ※ 真正的限制不再是 context，而是訂閱額度：
//    codex 的 agent 系統提示本身約 16k tokens，加上全段逐日資料 ~110k，
//    單次約 126k tokens。全段 6249 次 ≈ 790M tokens，Plus 週額度撐不完。
//    建議先 --limit=200 試水溫，或用 --tokenBudget 壓低餵入量。
//    決策有快取（strategy5_cache.jsonl），中斷可續跑、不會重複消耗額度。
//
//  ※ 沒有 logprobs：up_prob 是模型自報的數字，校準不可靠。
//    --signal=noul --threshold= 仍可用，但門檻意義比 jev 的 probabilities 弱很多。
//
//  ※ look-ahead bias：模型訓練資料含 2001~ 的台股歷史，它「記得」後面發生什麼。
//    回測數字要大幅打折看待，這是換用通用 LLM 的固有代價。
//
//  兩種模式：
//    --mode=stateless（預設）每日獨立問「今天尾盤該持有多單還是空手」，
//                     決策與持倉無關 → 可並行呼叫、可快取、可換門檻重跑
//    --mode=stateful  把目前持倉（進場日/價/未實現損益）一併餵給 codex，
//                     問「進場/觀望」或「續抱/平倉」→ 必須循序呼叫
//
//  每點價值 200 元（大台），來回成本 240 元
// ============================================================
//
//  用法：
//    node strategy5.js --limit=200                  # 只跑前 200 個交易日（建議先這樣）
//    node strategy5.js                              # 全段回測（會吃掉大量訂閱額度）
//    node strategy5.js --dryRun                     # 不呼叫 codex，用假決策驗證引擎
//    node strategy5.js --model=gpt-6-sol            # 換模型檔位
//    node strategy5.js --effort=medium              # 換 reasoning effort（low/medium/high）
//    node strategy5.js --signal=noul --threshold=0.55   # 改用機率門檻（吃快取，不再花額度）
//    node strategy5.js --concurrency=1              # 遇到 rate limit 就降併發
// ============================================================

// ── 解析 CLI 參數 (--key=value) ──
const cliArgs = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v === undefined ? 'true' : v]; })
);

const CONFIG = {
  dataFile:     path.join(__dirname, 'day_data', 'stocks.ftx.json'),
  cacheFile:    path.join(__dirname, cliArgs.cacheFile || 'strategy5_cache.jsonl'),
  reportFile:   path.join(__dirname, cliArgs.reportFile || 'strategy5_report.json'),
  startDate:    cliArgs.startDate || '2001-04-09',
  endDate:      cliArgs.endDate   || null,
  limit:        cliArgs.limit     !== undefined ? parseInt(cliArgs.limit)      : 0,   // 0 = 全部

  // codex CLI
  codexBin:     cliArgs.codexBin  || 'codex',
  model:        cliArgs.model     || 'gpt-6-luna',
  effort:       cliArgs.effort    || 'low',         // low | medium | high
  timeoutMs:    cliArgs.timeoutMs !== undefined ? parseInt(cliArgs.timeoutMs) : 180000,
  mode:         cliArgs.mode      || 'stateless',   // stateless | stateful
  concurrency:  cliArgs.concurrency !== undefined ? parseInt(cliArgs.concurrency) : 2,
  maxRetries:   cliArgs.maxRetries  !== undefined ? parseInt(cliArgs.maxRetries)  : 5,
  dryRun:       cliArgs.dryRun === 'true',

  // 決策 → 部位
  signal:       cliArgs.signal    || 'stance',      // stance（模型的 choice） | noul（機率門檻）
  threshold:    cliArgs.threshold !== undefined ? parseFloat(cliArgs.threshold) : 0.5,
  horizon:      cliArgs.horizon   !== undefined ? parseInt(cliArgs.horizon)     : 5,  // up_prob 的展望天數
  exec:         cliArgs.exec      || 'close',       // close（訊號日收盤） | nextOpen（隔日開盤）

  // context 預算（gpt-6-luna 裝得下全段，預設不截斷；想省額度就調低）
  tokenBudget:  cliArgs.tokenBudget !== undefined ? parseInt(cliArgs.tokenBudget) : 120000,
  charsPerToken: cliArgs.charsPerToken !== undefined ? parseFloat(cliArgs.charsPerToken) : 3.0,
  minBars:      cliArgs.minBars   !== undefined ? parseInt(cliArgs.minBars)  : 60,
  maxBars:      cliArgs.maxBars   !== undefined ? parseInt(cliArgs.maxBars)  : 0,   // 0 = 只受 token 預算限制

  // 成本（走 ChatGPT 訂閱，邊際金錢成本為 0；真正的成本是週額度）
  pointValue:   200,
  costPerTrade: 240,
  slippage:     cliArgs.slippage  !== undefined ? parseFloat(cliArgs.slippage) : 0,
};

// ── 決策快取（JSONL，可中斷續跑）─────────────────────────

function loadCache(file) {
  const map = new Map();
  if (!fs.existsSync(file)) return map;
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(line); map.set(o.key, o.value); } catch { /* 略過壞掉的行 */ }
  }
  return map;
}

function appendCache(file, key, value) {
  fs.appendFileSync(file, JSON.stringify({ key, value }) + '\n', 'utf-8');
}

// ── 餵給 codex 的 state 文字 ──────────────────────────────

function barLine(b) {
  return `${b.date},${b.open},${b.high},${b.low},${b.close},${b.volume}`;
}

function yearlyDigest(bars) {
  // bars 升序，壓成每年一列 K 線
  const out = [];
  let cur = null;
  for (const b of bars) {
    const y = b.date.slice(0, 4);
    if (!cur || cur.year !== y) {
      if (cur) out.push(cur);
      cur = { year: y, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
    } else {
      if (b.high > cur.high) cur.high = b.high;
      if (b.low  < cur.low)  cur.low  = b.low;
      cur.close = b.close;
      cur.volume += b.volume;
    }
  }
  if (cur) out.push(cur);
  return out.map(y => `${y.year}年,${y.open},${y.high},${y.low},${y.close},${y.volume}`);
}

/* 在 token 預算內，盡量把「從第一天到今天」的逐日資料全部餵進去；
   塞不下的更早期資料壓成年度 K 線。回傳 { text, dailyBars, truncated } */
function buildState(bars, lines, prefix, i, position, cfg) {
  const charBudget = Math.floor(cfg.tokenBudget * cfg.charsPerToken) - 900; // 900 留給標題與持倉區塊
  let n = i + 1;
  if (cfg.maxBars > 0) n = Math.min(n, cfg.maxBars);
  // prefix[k] = lines[0..k-1] 的總長度 → 最近 n 天的長度 = prefix[i+1] - prefix[i+1-n]
  while (n > cfg.minBars && prefix[i + 1] - prefix[i + 1 - n] > charBudget) {
    n = Math.max(cfg.minBars, Math.floor(n * 0.9));
  }
  const truncated = n < i + 1;

  const parts = [];
  parts.push('台灣加權股價指數期貨（TXF，大台）日線資料，最舊在上、最新在下。');
  parts.push('欄位：日期,開盤,最高,最低,收盤,成交量');
  parts.push('');

  if (truncated) {
    const older = bars.slice(0, i + 1 - n);
    parts.push(`## 早期歷史（${older[0].date} ~ ${older[older.length - 1].date}，壓縮為年度K線）`);
    parts.push(...yearlyDigest(older));
    parts.push('');
  }

  parts.push(`## 逐日資料（${bars[i + 1 - n].date} ~ ${bars[i].date}，共 ${n} 個交易日）`);
  for (let k = i + 1 - n; k <= i; k++) parts.push(lines[k]);
  parts.push('');

  const today = bars[i];
  parts.push(`## 今日`);
  parts.push(`${today.date}，自 ${bars[0].date} 起第 ${i + 1} 個交易日，收盤 ${today.close}。`);

  if (cfg.mode === 'stateful') {
    if (position) {
      const unreal = today.close - position.price;
      parts.push(`目前部位：持有 1 口多單，進場日 ${position.date}，進場價 ${position.price}，` +
                 `未實現損益 ${unreal >= 0 ? '+' : ''}${unreal.toFixed(0)} 點。`);
    } else {
      parts.push('目前部位：空手。');
    }
  }

  return { text: parts.join('\n'), dailyBars: n, truncated };
}

// ── 問 codex 的問題（指令 + JSON Schema）──────────────────

/* 回傳 { variant, instructions, schema }。
   variant 同時是 schema 檔名，三種變體各寫一次檔後重複使用。 */
function buildAsk(cfg, hasPosition) {
  const upField = {
    type: 'number',
    description: `以今日收盤價為基準，${cfg.horizon} 個交易日後收盤價高於今日收盤價的機率，0~1 之間。`,
  };
  const confField = {
    type: 'number',
    description: '你對這個決策的信心，0~1 之間。',
  };

  const mk = (variant, instructions, choiceField) => ({
    variant,
    instructions,
    schema: {
      type: 'object',
      properties: { ...choiceField, up_prob: upField, confidence: confField },
      required: [...Object.keys(choiceField), 'up_prob', 'confidence'],
      additionalProperties: false,
    },
  });

  if (cfg.mode === 'stateful') {
    return hasPosition
      ? mk('stateful-hold',
           '你是台指期日線波段交易員，手上有 1 口多單。根據以上歷史資料，決定今天尾盤要怎麼做。\n' +
           '  hold＝續抱：後續走勢仍偏多，這口多單繼續留倉\n' +
           '  sell＝平倉：後續走勢轉弱或不明，今天尾盤把這口多單平掉',
           { action: { type: 'string', enum: ['hold', 'sell'], description: '續抱或平倉。' } })
      : mk('stateful-flat',
           '你是台指期日線波段交易員，目前空手，只做多、最多持有一口。根據以上歷史資料，決定今天尾盤要怎麼做。\n' +
           '  buy＝進場：後續走勢偏多，今天尾盤買進一口多單\n' +
           '  wait＝觀望：後續走勢偏空或不明，維持空手',
           { action: { type: 'string', enum: ['buy', 'wait'], description: '進場或觀望。' } });
  }

  return mk('stateless',
            '你是台指期日線波段交易員，只做多、最多持有一口。根據以上歷史資料，決定今天尾盤收盤後應該持有的部位。\n' +
            '  long＝做多：後續走勢偏多，應持有一口多單\n' +
            '  flat＝空手：後續走勢偏空或不明，應空手',
            { stance: { type: 'string', enum: ['long', 'flat'], description: '做多或空手。' } });
}

function buildPrompt(state, ask) {
  return [
    ask.instructions,
    '',
    '不要讀取或寫入任何檔案、不要執行任何指令，只依據以下資料判斷。',
    '只輸出符合 schema 的 JSON，不要有其他文字。',
    '',
    '════════ 資料 ════════',
    state,
  ].join('\n');
}

// ── 呼叫 codex CLI ────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* schema 檔與 codex 的工作目錄都放在一個暫存資料夾，
   避免 agent 在專案目錄裡亂逛。 */
let WORKDIR = null;
const SCHEMA_FILES = new Map();

function ensureWorkdir() {
  if (!WORKDIR) WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'strategy5-codex-'));
  return WORKDIR;
}

function schemaFileFor(ask) {
  if (!SCHEMA_FILES.has(ask.variant)) {
    const f = path.join(ensureWorkdir(), `schema.${ask.variant}.json`);
    fs.writeFileSync(f, JSON.stringify(ask.schema, null, 2), 'utf-8');
    SCHEMA_FILES.set(ask.variant, f);
  }
  return SCHEMA_FILES.get(ask.variant);
}

function spawnCodex(prompt, schemaFile, cfg) {
  return new Promise((resolve, reject) => {
    const dir = ensureWorkdir();
    const outFile = path.join(dir, `out.${crypto.randomBytes(8).toString('hex')}.json`);
    const args = [
      'exec',
      '--ignore-user-config',       // 不載入 ~/.codex/config.toml（跳過 notify hook 與 plugins）
      '--ephemeral',               // 不把 6249 個 session 寫到磁碟
      '--skip-git-repo-check',
      '--cd', dir,
      '-s', 'read-only',
      '--color', 'never',
      '-m', cfg.model,
      '-c', `model_reasoning_effort=${cfg.effort}`,
      '--output-schema', schemaFile,
      '-o', outFile,
    ];

    const child = spawn(cfg.codexBin, args, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', settled = false;

    const timer = setTimeout(() => {
      if (!settled) { settled = true; child.kill('SIGKILL'); reject(new Error(`codex 逾時（${cfg.timeoutMs}ms）`)); }
    }, cfg.timeoutMs);

    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', err => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      reject(new Error(`無法啟動 ${cfg.codexBin}：${err.message}`));
    });

    child.on('close', code => {
      if (settled) return;
      settled = true; clearTimeout(timer);

      const tail = (stderr + stdout).slice(-400).trim();
      if (code !== 0) {
        try { fs.unlinkSync(outFile); } catch { /* 可能本來就沒產生 */ }
        return reject(new Error(`codex 離開碼 ${code}：${tail}`));
      }
      if (!fs.existsSync(outFile)) return reject(new Error(`codex 未產生輸出：${tail}`));

      let parsed;
      const rawOut = fs.readFileSync(outFile, 'utf-8');
      try { parsed = JSON.parse(rawOut); }
      catch { try { fs.unlinkSync(outFile); } catch {} return reject(new Error(`codex 輸出不是 JSON：${rawOut.slice(0, 300)}`)); }
      try { fs.unlinkSync(outFile); } catch { /* 清不掉就留著 */ }

      // 「tokens used\n126,431」→ 真實用量。codex 把這段摘要寫在 stderr，不是 stdout
      const m = (stderr + stdout).match(/tokens used\s+([\d,]+)/);
      const tokens = m ? parseInt(m[1].replace(/,/g, ''), 10) : 0;

      resolve({ answer: parsed, tokens });
    });

    // 資料量大（單次可達 330KB），走 stdin 而不是 argv，避免撞 ARG_MAX
    child.stdin.on('error', () => { /* 子程序先掛掉時忽略 EPIPE */ });
    child.stdin.end(prompt, 'utf-8');
  });
}

async function callCodex(prompt, schemaFile, cfg) {
  let lastErr;
  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      return await spawnCodex(prompt, schemaFile, cfg);
    } catch (err) {
      lastErr = err;
      if (/找不到|ENOENT|無法啟動/.test(err.message)) throw err;   // 環境問題，重試無意義
      if (attempt === cfg.maxRetries) break;
      // rate limit 要等久一點
      const rateLimited = /rate.?limit|usage limit|429|quota/i.test(err.message);
      await sleep(Math.min(rateLimited ? 300000 : 30000, (rateLimited ? 15000 : 1000) * 2 ** attempt));
    }
  }
  throw lastErr;
}

/* --dryRun 用的假決策：SMA5 > SMA20 就做多。
   純粹拿來驗證回測引擎與報表，不代表模型的判斷。 */
function fakeDecide(bars, i) {
  const sma = p => {
    if (i + 1 < p) return null;
    let s = 0;
    for (let k = 0; k < p; k++) s += bars[i - k].close;
    return s / p;
  };
  const f = sma(5), s = sma(20);
  const bull = f !== null && s !== null && f > s;
  return {
    pick: bull ? 'long' : 'flat',
    raw: bull ? 'long' : 'flat',
    prob: bull ? 0.62 : 0.38,
    noul: bull ? 0.62 : 0.38,
    confidence: 0.5,
    inputTokens: 0,
    model: 'dryRun',
  };
}

// 把 codex 的回答正規化成 { pick: 'long'|'flat', ... }
function normalize(res, cfg, hasPosition) {
  const a = res.answer || {};
  const up = typeof a.up_prob === 'number' ? a.up_prob : null;
  let raw, pick;

  if (cfg.mode === 'stateful') {
    raw = a.action;
    if (hasPosition) pick = raw === 'sell' ? 'flat' : 'long';
    else             pick = raw === 'buy'  ? 'long' : 'flat';
  } else {
    raw = a.stance;
    pick = raw === 'long' ? 'long' : 'flat';
  }
  if (!raw) throw new Error(`codex 回應缺少決策欄位：${JSON.stringify(a).slice(0, 300)}`);

  return {
    pick,
    raw,
    prob: null,                  // 沒有 logprobs，拿不到各選項機率
    noul: up,
    confidence: typeof a.confidence === 'number' ? a.confidence : null,
    inputTokens: res.tokens || 0,
    model: cfg.model,
  };
}

// 決策 → 目標部位（true = 持有多單）
function wantsLong(dec, cfg) {
  if (cfg.signal === 'noul') {
    if (typeof dec.noul !== 'number') return dec.pick === 'long';
    return dec.noul >= cfg.threshold;
  }
  return dec.pick === 'long';
}

// ── 併發控制（依序寫回結果）─────────────────────────────

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) break;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ── 前置檢查：codex 可用且已登入 ─────────────────────────

function checkCodex(cfg) {
  return new Promise(resolve => {
    const child = spawn(cfg.codexBin, ['login', 'status'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('error', () => resolve({ ok: false, reason: `找不到 ${cfg.codexBin}，請先安裝 codex CLI` }));
    child.on('close', code => {
      if (code !== 0 || /not logged in|logged out/i.test(out)) {
        return resolve({ ok: false, reason: `codex 尚未登入，請先執行：${cfg.codexBin} login\n${out.trim()}` });
      }
      resolve({ ok: true, auth: out.trim() });
    });
  });
}

// ── 主流程 ────────────────────────────────────────────────

async function run() {
  const cfg = CONFIG;

  if (!cfg.dryRun) {
    const chk = await checkCodex(cfg);
    if (!chk.ok) {
      console.error(chk.reason);
      console.error('也可以先用 --dryRun 驗證回測引擎（不呼叫 codex）。');
      process.exit(1);
    }
    console.log(`codex：${chk.auth}`);
  }

  // 1. 讀取並排為升序
  const raw = JSON.parse(fs.readFileSync(cfg.dataFile, 'utf-8'));
  let bars = raw
    .map(b => ({ date: b.date, open: b.open, high: b.max, low: b.min, close: b.close, volume: b.volume }))
    .filter(b => (!cfg.startDate || b.date >= cfg.startDate) && (!cfg.endDate || b.date <= cfg.endDate))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (cfg.limit > 0) bars = bars.slice(0, cfg.limit);

  console.log(`載入 ${bars.length} 個交易日 (${bars[0].date} ~ ${bars[bars.length - 1].date})`);
  console.log(`模型：${cfg.model}（effort ${cfg.effort}）｜模式：${cfg.mode}｜訊號：${cfg.signal}` +
              `${cfg.signal === 'noul' ? `（門檻 ${cfg.threshold}）` : ''}｜執行：${cfg.exec}` +
              `${cfg.dryRun ? '｜*** dryRun（未呼叫 codex）***' : ''}\n`);

  // 逐日資料列與長度前綴和（buildState 用來 O(1) 決定塞得下幾天）
  const lines = bars.map(barLine);
  const prefix = new Array(lines.length + 1).fill(0);
  for (let k = 0; k < lines.length; k++) prefix[k + 1] = prefix[k] + lines[k].length + 1;

  const cache = loadCache(cfg.cacheFile);
  const usage = { calls: 0, cached: 0, inputTokens: 0, firstTruncatedDate: null, minDailyBars: Infinity };

  const decide = async (i, position) => {
    const { text, dailyBars, truncated } = buildState(bars, lines, prefix, i, position, cfg);
    if (truncated) {
      if (!usage.firstTruncatedDate) usage.firstTruncatedDate = bars[i].date;
      if (dailyBars < usage.minDailyBars) usage.minDailyBars = dailyBars;
    }

    if (cfg.dryRun) return { ...fakeDecide(bars, i), dailyBars, truncated };

    const ask = buildAsk(cfg, !!position);
    const prompt = buildPrompt(text, ask);
    const key = crypto.createHash('sha1')
      .update(`${cfg.model}|${cfg.effort}|${cfg.mode}|${prompt}`)
      .digest('hex');

    const hit = cache.get(key);
    if (hit) { usage.cached++; return { ...hit, dailyBars, truncated }; }

    const res = await callCodex(prompt, schemaFileFor(ask), cfg);
    const dec = normalize(res, cfg, !!position);
    cache.set(key, dec);
    appendCache(cfg.cacheFile, key, dec);
    usage.calls++;
    usage.inputTokens += dec.inputTokens;
    return { ...dec, dailyBars, truncated };
  };

  const progress = (done, total) =>
    process.stdout.write(`\r  決策進度 ${done}/${total}（codex ${usage.calls} 次、快取 ${usage.cached}、` +
                         `tokens ${(usage.inputTokens / 1e6).toFixed(2)}M）   `);

  // 2. 取得每日決策
  const decisions = new Array(bars.length).fill(null);
  const t0 = Date.now();

  if (cfg.mode === 'stateless') {
    // 決策與持倉無關 → 可並行
    const idx = bars.map((_, i) => i);
    let done = 0;
    await mapPool(idx, cfg.concurrency, async i => {
      decisions[i] = await decide(i, null);
      if (++done % 10 === 0 || done === bars.length) progress(done, bars.length);
    });
    process.stdout.write('\n\n');
  }

  // 3. 逐日回測
  const trades = [];
  let equity = 0, maxEquity = 0, maxDrawdown = 0;
  let position = null;           // { date, price }
  let pendingEntry = false, pendingExit = false;   // --exec=nextOpen 用
  const stanceCount = { long: 0, flat: 0 };

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];

    // 隔日開盤執行前一日訊號
    if (cfg.exec === 'nextOpen') {
      if (pendingExit && position) {
        equity += closePosition(trades, position, bar, bar.open - cfg.slippage, '訊號平倉', cfg);
        position = null;
      }
      pendingExit = false;
      if (pendingEntry && !position) position = { date: bar.date, price: bar.open + cfg.slippage };
      pendingEntry = false;
    }

    let dec = decisions[i];
    if (!dec) {                    // stateful：循序決策（需要當下持倉）
      dec = await decide(i, position);
      decisions[i] = dec;
      if ((i + 1) % 10 === 0 || i === bars.length - 1) progress(i + 1, bars.length);
    }

    const long = wantsLong(dec, cfg);
    stanceCount[long ? 'long' : 'flat']++;

    if (cfg.exec === 'close') {
      if (position && !long) {
        equity += closePosition(trades, position, bar, bar.close - cfg.slippage, '訊號平倉', cfg);
        position = null;
      } else if (!position && long) {
        position = { date: bar.date, price: bar.close + cfg.slippage };
      }
    } else {
      if (position && !long) pendingExit = true;
      else if (!position && long) pendingEntry = true;
    }

    if (equity > maxEquity) maxEquity = equity;
    const dd = maxEquity - equity;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }
  if (cfg.mode === 'stateful') process.stdout.write('\n\n');

  // 資料結束仍有部位 → 末根收盤平倉（不計入統計）
  if (position) {
    const lastBar = bars[bars.length - 1];
    equity += closePosition(trades, position, lastBar, lastBar.close - cfg.slippage, '資料結束', cfg);
    position = null;
  }

  // 4. 報告
  const elapsed = (Date.now() - t0) / 1000;
  const report = buildReport(trades, maxDrawdown, bars, decisions, usage, stanceCount, elapsed, cfg);
  fs.writeFileSync(cfg.reportFile, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`報告已寫入：${cfg.reportFile}`);
  printSummary(report);

  if (WORKDIR) { try { fs.rmSync(WORKDIR, { recursive: true, force: true }); } catch { /* 清不掉就留著 */ } }
}

// ── 輔助函式 ──────────────────────────────────────────────

function closePosition(trades, pos, bar, exitPrice, reason, cfg) {
  const pnlPoints = exitPrice - pos.price;
  const pnl = pnlPoints * cfg.pointValue - cfg.costPerTrade;
  trades.push({
    entryDate: pos.date, exitDate: bar.date,
    entryPrice: pos.price, exitPrice,
    pnlPoints, pnl, reason,
  });
  return pnl;
}

function buildReport(trades, maxDrawdown, bars, decisions, usage, stanceCount, elapsed, cfg) {
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

  let cumPnl = 0;
  const tradeDetails = reportTrades.map((t, i) => {
    cumPnl += t.pnl;
    return {
      id: i + 1,
      entryDate: t.entryDate, exitDate: t.exitDate,
      entryPrice: t.entryPrice, exitPrice: t.exitPrice,
      pnlPoints: +t.pnlPoints.toFixed(2),
      pnl: +t.pnl.toFixed(0),
      cumulativePnl: +cumPnl.toFixed(0),
      exitReason: t.reason,
    };
  });

  // 買進持有（Buy & Hold）對照
  const bhPoints = bars[bars.length - 1].close - bars[0].close;

  const decided = decisions.filter(Boolean);
  const avgNoul = decided.filter(d => typeof d.noul === 'number');
  const inMarketDays = stanceCount.long;

  const safeConfig = { ...cfg };
  delete safeConfig.dataFile;     // 絕對路徑，報告裡不需要
  delete safeConfig.cacheFile;
  delete safeConfig.reportFile;

  return {
    strategy: `codex CLI（${cfg.model}）逐日決策做多（1口）— ${cfg.mode} 模式、訊號 ${cfg.signal}` +
              `${cfg.signal === 'noul' ? `（門檻 ${cfg.threshold}）` : ''}、${cfg.exec === 'close' ? '訊號日收盤' : '隔日開盤'}進出場`,
    config: safeConfig,
    codex: {
      model:            cfg.model,
      effort:           cfg.effort,
      auth:             'ChatGPT 訂閱（codex CLI）',
      apiCalls:         usage.calls,
      cacheHits:        usage.cached,
      totalTokens:      usage.inputTokens,
      elapsedSeconds:   +elapsed.toFixed(1),
      secondsPerCall:   usage.calls > 0 ? +(elapsed / usage.calls).toFixed(1) : null,
      contextTruncated: usage.firstTruncatedDate !== null,
      firstTruncatedDate: usage.firstTruncatedDate,
      minDailyBarsFed:  Number.isFinite(usage.minDailyBars) ? usage.minDailyBars : bars.length,
      longDays:         stanceCount.long,
      flatDays:         stanceCount.flat,
      longDayRatio:     +((stanceCount.long / (stanceCount.long + stanceCount.flat)) * 100).toFixed(2),
      avgUpProb:        avgNoul.length ? +(avgNoul.reduce((s, d) => s + d.noul, 0) / avgNoul.length).toFixed(4) : null,
      note:             '模型自報的 up_prob 無 logprobs 校準；訓練資料含同期台股歷史，有 look-ahead bias。',
    },
    summary: {
      backtestPeriod: { start: bars[0].date, end: bars[bars.length - 1].date, tradingDays: bars.length },
      totalTrades,
      wins: wins.length,
      losses: losses.length,
      winRate: +(totalTrades > 0 ? ((wins.length / totalTrades) * 100).toFixed(2) : 0),
      totalPnl: +totalPnl.toFixed(0),
      avgPnl:   +(totalTrades   > 0 ? (totalPnl   / totalTrades).toFixed(0) : 0),
      avgWin:   +(wins.length   > 0 ? (totalWin   / wins.length).toFixed(0) : 0),
      avgLoss:  +(losses.length > 0 ? (-totalLoss / losses.length).toFixed(0) : 0),
      maxWin:   wins.length   > 0 ? +Math.max(...wins.map(t => t.pnl)).toFixed(0)   : 0,
      maxLoss:  losses.length > 0 ? +Math.min(...losses.map(t => t.pnl)).toFixed(0) : 0,
      profitFactor: +(totalLoss > 0 ? (totalWin / totalLoss).toFixed(2) : 0),
      rewardRiskRatio: +(losses.length > 0 && wins.length > 0
        ? ((totalWin / wins.length) / (totalLoss / losses.length)).toFixed(2) : 0),
      maxDrawdown: +(-maxDrawdown).toFixed(0),
      exposureRatio: +((inMarketDays / bars.length) * 100).toFixed(2),
      buyHoldPnl: +(bhPoints * cfg.pointValue).toFixed(0),
    },
    yearlyPerformance,
    trades: tradeDetails,
  };
}

function printSummary(report) {
  const s = report.summary, c = report.codex;
  console.log('='.repeat(72));
  console.log(`策略：${report.strategy}`);
  console.log(`回測：${s.backtestPeriod.start} ~ ${s.backtestPeriod.end}（${s.backtestPeriod.tradingDays} 個交易日）`);
  console.log(`交易：${s.totalTrades} 次  勝率：${s.winRate}%  在場比例：${s.exposureRatio}%`);
  console.log(`總損益：${s.totalPnl.toLocaleString()} 元  平均每筆：${s.avgPnl.toLocaleString()} 元`);
  console.log(`平均獲利：${s.avgWin.toLocaleString()}  平均虧損：${s.avgLoss.toLocaleString()}`);
  console.log(`最大單筆獲利：${s.maxWin.toLocaleString()}  最大單筆虧損：${s.maxLoss.toLocaleString()}`);
  console.log(`獲利因子：${s.profitFactor}  報酬風險比：${s.rewardRiskRatio}`);
  console.log(`最大回撤：${s.maxDrawdown.toLocaleString()} 元`);
  console.log(`買進持有對照：${s.buyHoldPnl.toLocaleString()} 元`);
  console.log('-'.repeat(72));
  console.log(`codex：${c.model}（effort ${c.effort}）｜呼叫 ${c.apiCalls} 次（快取 ${c.cacheHits}）｜` +
              `tokens ${(c.totalTokens / 1e6).toFixed(2)}M｜${c.elapsedSeconds}s` +
              (c.secondsPerCall !== null ? `（每次約 ${c.secondsPerCall}s）` : ''));
  console.log(`決策分佈：做多 ${c.longDays} 日 / 空手 ${c.flatDays} 日（${c.longDayRatio}%）` +
              (c.avgUpProb !== null ? `｜平均上漲機率 ${c.avgUpProb}` : ''));
  if (c.contextTruncated) {
    console.log(`⚠ tokenBudget 塞不下全段逐日資料：自 ${c.firstTruncatedDate} 起改為「近期逐日 + 早期年度K線」，` +
                `最少只餵 ${c.minDailyBarsFed} 個交易日的逐日資料。`);
  }
  console.log('='.repeat(72));
  console.log('\n年度績效：');
  for (const y of report.yearlyPerformance) {
    console.log(`  ${y.year}  ${String(y.pnl.toLocaleString()).padStart(12)} 元  勝率 ${String(y.winRate).padStart(6)}%  交易 ${String(y.trades).padStart(3)} 次`);
  }
}

run().catch(err => {
  console.error('\n執行失敗：', err.message);
  if (WORKDIR) { try { fs.rmSync(WORKDIR, { recursive: true, force: true }); } catch {} }
  process.exit(1);
});
