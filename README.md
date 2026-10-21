# 台指期貨量化策略研究平台

## 作品概述（Description）

一套針對**台灣加權股價指數期貨（TXF，大台）**的量化交易研究平台，從資料抓取、
策略回測到圖表視覺化全部自建，不依賴任何商用回測框架。

涵蓋三個部分：

1. **資料管線** — 以 Python 串接 FinMind 與永豐 Shioaji API，建立兩份本地資料集：
   - 日線 `day_data/stocks.ftx.json`：2001-04-09 ~ 2026-08-21，共 6,249 個交易日 OHLCV
   - 1 分 K `minute_data/YYYY-MM-DD.json`：2020-03-02 起逐日一檔，共 1,900+ 個交易日
2. **回測引擎** — 34 支 Node.js 腳本、7 個策略家族，同一套績效口徑下互相對照：

   | 家族 | 主題 | 資料 |
   |---|---|---|
   | strategy1 | 開盤區間突破（ORB）日內當沖 | 1 分 K |
   | strategy2 系列 | SMA 均線交叉 + ADX 過濾 / ATR 追蹤停利 / 加碼 / MA60 過濾 | 日線 |
   | strategy3 + optimize3 | Nadaraya-Watson 核回歸通道反彈 + 參數網格搜尋 | 日線 |
   | strategy4 | SMA 交叉 + KD 高檔轉折 + ATR 停損 | 日線 |
   | strategy5 | 把逐日歷史餵給 LLM 由它逐日決策的實驗 | 日線 |
   | strategy6-1 ~ 6-20 | **固定進場、20 種出場機制的受控比較** | 日線 |
   | strategy7 / 7-1 | 11 月底進場的季節性策略 | 日線 |

3. **視覺化** — 單檔 `index.html`（ECharts 5），把日 K、均線、布林通道、NW 通道、
   量能、VR、ADX、BBW、ATR、RSI 疊在多窗格圖上，並直接載入策略報表繪出
   進出場標記與累積損益曲線。

專案的重點不在「找到會賺錢的策略」，而在**建立一個能公平比較策略的環境**：
統一的成本與滑價假設、統一的績效指標、內建買進持有對照組、樣本內／外切分，
以及對結果的誠實檢討（獲利集中度、樣本數不足、絕對金額偏袒近年等，見下方各章結論）。

## 實作方式（Implementation）

### 資料層（Python）

| 檔案 | 說明 |
|---|---|
| `fetch_txf_day_data.py` | 由 FinMind API 抓台指期日線，含 HTTP 429/5xx 指數退避重試、分段抓取與合併，另併入 TWSE FMTQIK 成交資訊 |
| `fetch_txf_tick.py` | 由 Shioaji (>=1.7.0) `kbars` 抓 1 分 K。期貨用近月連續合約 `TXFR1`（結算自動換月）、指數用交易所代碼 `IX0001`，兩者對齊後逐日落檔 |
| `strategy1_exe.py` | Shioaji 即時報價訂閱，供策略上線前的盤中驗證 |

資料一律落成本地 JSON，回測完全離線執行，確保每次跑出來的數字可重現。

### 回測引擎（Node.js，零相依）

- **單檔即可執行**：每支策略都是獨立的 `node strategyX.js`，統一吃 `--key=value` 形式的
  CLI 參數（`--startDate` `--endDate` `--slippage` …），跑完輸出 `strategyX_report.json`。
- **技術指標全部自行實作**，不用任何 TA 套件：SMA / EMA / 布林通道 / ATR / KD / RSI /
  MACD / ADX+DI / Donchian / Parabolic SAR / Nadaraya-Watson 高斯核回歸。
- **統一的交易假設**：大台每點 200 元、來回成本 240 元、滑價可調；純做多、
  部位上限 1~2 口；訊號日收盤成交（部分策略可切 `--exec=nextOpen`）。
- **統一的績效口徑**：交易明細、勝率、獲利因子、最大回撤、損益／回撤比、
  在場比例、平均持有天數、`pctSum` / `pctCompound`（與點位無關的報酬率）、
  未平倉部位 `openPosition`，以及內建的買進持有 `baseline` 對照。

### 幾個刻意的設計決定

- **避免未來函數**：Nadaraya-Watson 採 causal（非重繪）版本，`nw[i]` 只用 `0..i` 的資料，
  不像常見的 TradingView 版本會回頭修改歷史值。
- **成交時序的嚴謹性**：部位在進場日「收盤」才成立，因此交易紀錄的「持有期間最高／最低」
  是從進場日的**次一根** K 棒才開始算；盤中觸價的停損優先於收盤才成立的訊號出場。
- **引擎與策略分離**：`strategy6_common.js` 把資料載入、指標計算、部位管理、
  報表產生全部抽出，20 支子策略各自只剩一個 `exit()` callback（多數不到 25 行）。
  進場條件完全相同，差異只在出場，才能把「出場機制」這個變因單獨拉出來比較。
- **批次比較與穩健度檢查**：`strategy6_compare.js` 一次跑完 20 種並依指定指標排名，
  `--oos=2016-01-01` 可切成樣本內／外兩段分別計算，檢查績效是否只來自特定年代。
- **參數最佳化**：`optimize3.js` 對 NW 通道做網格搜尋（h 5.0~100.0、mult 1.0~3.0，
  步長 0.1，約 19,000 組），結果落 `optimize3_result.json` 供挑參數與觀察過擬合。
- **LLM 決策實驗（strategy5）**：每個交易日把「累積到當日」的逐日 OHLCV 組成 prompt，
  要求模型回傳 typed JSON 決策，再用同一套引擎回測。實作上處理了三個問題——
  用 JSONL 快取讓中斷可續跑且換門檻重算不再花錢、用 token 預算把過早的資料壓成年度 K 線
  以塞進 context、stateless 模式可並行呼叫而 stateful 模式（把持倉也餵進去）必須循序。
  需特別注意 **look-ahead bias**：模型的訓練資料本就含這段台股歷史，回測數字要大幅打折看待。

### 視覺化（index.html）

單一 HTML 檔、ECharts 5 走 CDN，開檔即用。載入 `day_data/stocks.ftx.json` 與
策略報表（目前接 `strategy6-16_report.json`），繪出：

- 主圖：K 線 + MA5/11/20/60/180/200/240 + 布林通道與 NW 通道（含帶狀填色）
- 副圖：成交量與量能均線、VR、ADX(14)、BBW(%)、ATR(14) 與 ATR 停損線、RSI(7)/RSI(14)
- 疊圖：策略的進場／出場標記與累積損益曲線
- 右上角可即時調整 NW 的 `h` 與 `mult` 並重算通道

---

## 使用方式

```
  $python3 fetch_txf_tick.py --api_key="$SJ_API_KEY" --secret_key="$SJ_SECRET_KEY" --ca_passwd="$SJ_CA_PASSWD" --person_id="$SJ_PERSON_ID" --start_date="2026-03-26" --end_date="2026-03-27"
```

```
  $python3 fetch_txf_day_data.py --start_date 2026-04-01 --end_date 2026-04-11
```

```
  $node strategy3.js --nwH=7.0 --nwMult=2.5
```
## SMA 交叉系列（strategy2 家族）

```
  $node strategy2.js     # 基準 SMA5/11 金叉做多、死叉平倉（無停損）
  $node strategy2-6.js   # SMA10/30 —— 放慢均線，交易 306→111 次
  $node strategy2-7.js   # SMA10/30 + MA60 進場過濾（MA60 只擋新倉，不打斷持倉）
  $node strategy2-8.js   # 2-7 的訊號 + 2-3 的加碼架構（最多 2 口，預設不停損）
  $node strategy2_compare.js   # 一次跑完 2 / 2-6 / 2-7 / 2-8 並列表比較
```

## KD 短中期六法回測（4-1 ~ 4-6）

```
  $node strategy4_compare.js                        # 一次跑完六種並列表比較
  $node strategy4_compare.js --startDate=2015-01-01 # 只比較近十年
  $node strategy4_compare.js --stopPct=3 --base=1   # 六者都加 3% 停損，並附 strategy4.js 基準
```

```
  $node strategy4-1.js --lowZone=20 --highZone=80 --weakZone=50   # 黃金/死亡交叉（只取低檔金叉、高檔死叉）
  $node strategy4-2.js --oversold=20 --overbought=80              # 超買超賣反轉
  $node strategy4-3.js --dullDays=3 --dullLevel=80                # 高檔鈍化順勢
  $node strategy4-4.js --pivotWindow=3 --divLowZone=40            # 背離
  $node strategy4-5.js --weekKd=9 --weekMode=running              # 多週期共振（週 KD 定方向）
  $node strategy4-6.js --ma1=20 --ma2=60                          # 均線趨勢過濾
```

共通參數：`--startDate` `--endDate` `--kd=9` `--stopPct=0`（百分比停損，0 = 不停損）`--slippage=0`
六者皆為純做多、最多 1 口、訊號日收盤進出場；共用引擎在 `strategy4_common.js`。

## Jev 逐日決策回測（strategy5）

把 `day_data/stocks.ftx.json` 從 2001-04-09 起，逐日以「累積到當天」的 OHLCV
餵給 [jev](https://jevtypesafeai.com)（TypeSafe AI System One 模型），
由它決策，再回測。純做多、最多 1 口。

```
  $node strategy5.js --dryRun                              # 不呼叫 API，用 SMA5/20 假決策驗證回測引擎
  $node strategy5.js --apiKey=jv_live_xxxxx --limit=200    # 只跑前 200 個交易日試水溫
  $node strategy5.js --apiKey=jv_live_xxxxx                # 全段 6249 個交易日（約 122M input tok、$5 上下、10~20 分）
  $node strategy5.js --signal=noul --threshold=0.55        # 改用機率門檻重算（吃快取，不再花錢）
  $node strategy5.js --mode=stateful                       # 把當下持倉也餵給 jev（循序呼叫，較慢）
```

API key 優先序：`--apiKey=`（別名 `--key=`）> `JEV_API_KEY` > `TYPESAFE_API_KEY`。
寫在指令列會留在 shell history，介意的話改用 `export JEV_API_KEY=jv_live_xxxxx`。

端點依 key 前綴自動選擇，兩者是**同一個 jev 模型**、request/response 格式相同，可用 `--endpoint=` 覆寫：

| key 前綴 | 端點 | 取得 |
|---|---|---|
| `jv_live_...` | `https://jevtypesafeai.com/api/v1/decide` | <https://jevtypesafeai.com/pricing#get-key> |
| `sk-...` | `https://api.typesafe.ai/v1/systemone` | <https://console.typesafe.ai>（官方文件 <https://docs.typesafe.ai>） |

決策結果寫入 `strategy5_cache.jsonl`（JSONL，可中斷續跑），績效寫入 `strategy5_report.json`。

共通參數：`--startDate` `--endDate` `--limit` `--exec=close|nextOpen` `--slippage=0`
`--concurrency=6` `--tokenBudget=24000` `--maxBars=0`

※ jev context 為 32k tokens，全段逐日資料約 122M tokens 塞不下。
  腳本會在 token 預算內盡量餵滿逐日資料，更早的壓成年度 K 線；
  預設參數下自 2008-12-04 起開始截斷（最少仍餵 1532 個交易日逐日資料），
  報表的 `jev.contextTruncated` 與 console 都會標示。

## 布林通道突破做多 — 20 種出場機制（strategy6 家族）

進場 20 支共用、固定不變：**收盤 > BB(20, 2.0) 上軌 → 當日尾盤（收盤價）買進 1 口多單**，
純做多、最多 1 口。出場各自不同，共用引擎在 `strategy6_common.js`。

```
  $node strategy6_compare.js                      # 一次跑完 20 種並排名
  $node strategy6_compare.js --sortBy=pct         # pnl | pf | mar | pct | pctCmp | winRate | avgPnl
  $node strategy6_compare.js --oos=2016-01-01     # 另跑樣本內/外兩段，檢查穩健度
  $node strategy6_compare.js --slippage=2         # 全部加 2 點滑價
  $node strategy6-16.js                           # 單跑某一支
```

| 檔案 | 出場機制 | 檔案 | 出場機制 |
|---|---|---|---|
| `strategy6-1.js`  | 收盤跌破中軌 | `strategy6-11.js` | MACD 柱由正轉負 |
| `strategy6-2.js`  | 收盤跌破下軌 | `strategy6-12.js` | SMA5 下穿 SMA20 |
| `strategy6-3.js`  | 收盤跌回上軌之下 | `strategy6-13.js` | 跌破進場日最低價 |
| `strategy6-4.js`  | 固定 +tp% 停利 / −sl% 停損 | `strategy6-14.js` | 連續 N 根黑K |
| `strategy6-5.js`  | 純 ATR 停損（不停利） | `strategy6-15.js` | 布林帶寬自高點收縮 shrink% |
| `strategy6-6.js`  | ATR 移動停損 | `strategy6-16.js` | 中軌 SMA20 下彎 |
| `strategy6-7.js`  | 百分比移動停損 | `strategy6-17.js` | 海龜式（跌破 10 日低） |
| `strategy6-8.js`  | 固定持有 N 日 | `strategy6-18.js` | +tp% 停利 + 中軌停損 |
| `strategy6-9.js`  | KD 高檔轉折（K 跌破 80） | `strategy6-19.js` | 兩段式保本移動停損 |
| `strategy6-10.js` | RSI(14) 超買 | `strategy6-20.js` | Parabolic SAR 翻空 |

共通參數：`--startDate` `--endDate` `--bb=20` `--bbMult=2` `--slippage=0`
`--entryMode=level|cross`（level = 收盤在上軌之上就進場；cross = 需由下向上突破）
各策略另有自己的參數（`--tp` `--sl` `--atrMult` `--trail` `--hold` `--black` `--shrink` `--trigger` …）。

### 結論（2001-04-09 ~ 2026-08-21，無滑價）

**最優：`strategy6-16.js`（中軌 SMA20 下彎出場）** — 台幣金額、百分比報酬、風險調整後三種排法都是第 1：
83 筆、勝率 53.0%、總損益 6,236,080 元、獲利因子 4.58、最大回撤 −280,520 元、損益/回撤 22.2、
累計報酬 233.3%、平均持有 29.1 日。次佳為 `strategy6-2.js`（跌破下軌）。

讀這些數字時要注意三件事：

1. **絕對金額會偏袒近年**：台指 25 年間由 4000 漲到 45000，但每點一律 200 元。
   報表的 `pctSum` / `pctCompound`（與點位無關的報酬率）才適合跨年代比較。
   所幸兩種排法的冠軍一致，結論不是近年放大造成的。
2. **獲利高度集中**：6-16 的前 5 筆交易貢獻 76% 的總損益，2016 年後貢獻 81%。
3. **`6-5` 與 `6-13` 會退化成買進持有**：只設停損、停損價又不上移，2009-03-11 進場後
   再也沒被觸及，一路抱到資料結束。報表的 `openPosition` 欄位會把這筆未平倉部位
   （未實現 +8,075,760 元）攤開，不要只看那 4 筆全虧的已實現紀錄。

買進持有對照：總損益 7,943,800 元、最大回撤 −1,628,400 元、在場比例 100%。
6-16 用 38.6% 的在場時間拿到 78% 的報酬，最大回撤只有 1/5.8。

## 11 月底進場的季節性策略（strategy7）

```
  $node strategy7.js
  $node strategy7.js --pnlBasis=net      # 「損益為正」改成扣掉 240 元成本後才算
  $node strategy7.js --slippage=2
  $node strategy7.js --startDate=2010-01-01
```

規則（純做多、最多 1 口；部位天然不重疊）：

- **進場**：每年 11 月最後一個交易日收盤買進 1 口
- **出場 A**：同年 12 月最後一個交易日，若當時損益為正 → 該日收盤平倉
- **出場 B**：若為負 → 續抱至隔年 1 月最後一個交易日收盤平倉（不論賺賠）

`--pnlBasis` 決定「損益為正」怎麼算：`gross`（預設，12 月底收盤 > 進場價）或
`net`（扣掉 240 元成本後仍為正）。2001–2025 這 25 年兩者結果相同。

### 結果（2001-04-09 ~ 2026-08-21，無滑價）

25 次交易、勝率 92%、總損益 1,761,200 元、獲利因子 7.87、最大回撤 −229,440 元、
在場比例僅 10.4%（平均持有 25.9 個交易日）、累計報酬 95.3%。

| 出場原因 | 次數 | 勝率 | 損益 | 平均 |
|---|---|---|---|---|
| 12月底獲利出場 | 20 | 100% | 1,840,600 | 92,030 |
| 隔年1月底出場 | 5 | 60% | −79,400 | −15,880 |

**「虧損就延到 1 月」這條規則是有效的，但樣本很薄。** 對照組（一律 12 月底出場）
總損益 1,586,400 元，延到 1 月多賺 174,800 元 —— 那 5 次若在 12 月底認賠是 −254,200 元，
延到 1 月變成 −79,400 元。但這 174,800 元幾乎全由 2022（−667 點 → +92,960 元）與
2002（−265 點 → +70,160 元）兩次貢獻，而 2007 那次反而從 −25,440 元惡化到 −229,440 元。
**25 年只觸發 5 次，不足以斷言這條規則穩健。**

另外要注意報酬風險比只有 0.68（平均獲利 87,717 / 平均虧損 128,140）——
高勝率但賠錢時賠得比賺錢時多，典型的季節性策略型態。
買進持有同期為 7,943,800 元，但在場比例 100%、最大回撤 −1,628,400 元。

## 11 月底進場、12 月底出場（strategy7-1）

`strategy7.js` 的單純版 —— 不把虧損單延到隔年 1 月。

```
  $node strategy7-1.js
  $node strategy7-1.js --slippage=2
  $node strategy7-1.js --startDate=2010-01-01
```

- **進場**：每年 11 月最後一個交易日收盤買進 1 口
- **出場**：同年 12 月最後一個交易日收盤平倉（不論賺賠）

### strategy7 vs strategy7-1（2001-04-09 ~ 2026-08-21，無滑價）

| 指標 | 7-1（一律 12 月底出） | 7（虧損延到 1 月） | 較佳 |
|---|---|---|---|
| 交易次數 | 25 | 25 | — |
| 勝率 | 80% | 92% | 7 |
| 總損益 | 1,586,400 元 | 1,761,200 元 | 7 |
| 累計報酬（與點位無關） | 85.0% | 95.3% | 7 |
| 獲利因子 | 7.24 | 7.87 | 7 |
| **報酬風險比** | **1.81** | 0.68 | **7-1** |
| **最大回撤** | **−133,640 元** | −229,440 元 | **7-1** |
| **總損益 / 最大回撤** | **11.87** | 7.68 | **7-1** |
| 在場比例 | 8.83% | 10.37% | 7-1 |

**延到 1 月多賺 174,800 元（+11%），代價是最大回撤幾乎翻倍、報酬風險比從 1.81 掉到 0.68。**
原因是 2007 那次：12 月底只小虧 25,440 元，延到 2008-01-31 變成虧 229,440 元，
一次就把整條權益曲線的最大回撤從 −133,640 推到 −229,440。
風險調整後 7-1 反而比較好；而且 7 多出來的那條分支 25 年只觸發 5 次，樣本太薄。

兩支的對照組都內建在各自的報表裡（`baseline` 欄位），數字互相驗證一致。
