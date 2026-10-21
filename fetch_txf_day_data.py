import requests
import json
import os
import time
import argparse
from collections import defaultdict

FINMIND_URL = "https://api.finmindtrade.com/api/v4/data"
TWSE_FMTQIK_URL = "https://www.twse.com.tw/exchangeReport/FMTQIK"
TIMEOUT = 60  # seconds
MAX_RETRIES = 3


def fetch_data(dataset, data_id, start_date, end_date, token=None):
    params = {
        "dataset": dataset,
        "data_id": data_id,
        "start_date": start_date,
        "end_date": end_date,
    }
    if token:
        params["token"] = token

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = requests.get(FINMIND_URL, params=params, timeout=TIMEOUT)
            resp.raise_for_status()
            result = resp.json()
            if result.get("status") != 200:
                raise Exception(f"API error: {result.get('msg', 'Unknown error')}")
            return result.get("data", [])
        except requests.exceptions.HTTPError as e:
            status_code = e.response.status_code if e.response is not None else 0
            if status_code in (429, 502, 503, 504) and attempt < MAX_RETRIES:
                wait = 5 * attempt
                print(f"      HTTP {status_code}，{wait}s 後重試 ({attempt}/{MAX_RETRIES})...")
                time.sleep(wait)
            else:
                raise
        except requests.exceptions.Timeout:
            if attempt < MAX_RETRIES:
                wait = 5 * attempt
                print(f"      請求逾時，{wait}s 後重試 ({attempt}/{MAX_RETRIES})...")
                time.sleep(wait)
            else:
                raise


def process_futures_data(records):
    """
    依日期取近月合約，合併 after_market（夜盤）與 position（日盤）。
    參考 fetchMtxData.js 邏輯：
      - open  = after_market.open（若有），否則 position.open
      - max   = max(position.max, after_market.max)
      - min   = min(position.min, after_market.min)
      - close = position.settlement_price（若非 0），否則 position.close
    回傳 dict: date -> {open, max, min, close, contract_date}
    """
    from datetime import datetime

    date_records = defaultdict(list)
    for r in records:
        date_records[r["date"]].append(r)

    result = {}
    for date, rows in sorted(date_records.items()):
        dt = datetime.strptime(date, "%Y-%m-%d")
        ym_this = dt.strftime("%Y%m")
        ym_next = f"{dt.year + 1}01" if dt.month == 12 else f"{dt.year}{dt.month + 1:02d}"

        # 篩選近月（當月 or 次月）合約
        filtered = [r for r in rows if r["contract_date"] in (ym_this, ym_next)]
        if not filtered:
            filtered = rows  # fallback

        # 取第一個符合的（FinMind 回傳順序近月在前）
        pos  = next((r for r in filtered if r.get("trading_session") == "position"),    None)
        after = next((r for r in filtered if r.get("trading_session") == "after_market"), None)

        if not pos:
            continue

        open_price = int(float(after["open"] if after else pos["open"]))
        max_price  = int(max(float(pos["max"]), float(after["max"]) if after else float(pos["max"])))
        min_price  = int(min(float(pos["min"]), float(after["min"]) if after else float(pos["min"])))

        settlement = pos.get("settlement_price")
        close_price = (
            int(float(settlement))
            if settlement and float(settlement) != 0
            else int(float(pos["close"]))
        )

        result[date] = {
            "open": open_price,
            "max": max_price,
            "min": min_price,
            "close": close_price,
            "contract_date": pos["contract_date"],
        }
    return result


def fetch_taiex_volume_twse(start_date, end_date):
    """
    從台灣證交所 FMTQIK API 抓取每日加權指數成交金額。
    單位：百萬元（成交金額 ÷ 1,000,000），與台指期合約量級相近。
    回傳 dict: date (YYYY-MM-DD) -> volume (int)
    """
    from datetime import date as _date

    start = _date.fromisoformat(start_date)
    end   = _date.fromisoformat(end_date)

    # 展開需查詢的月份清單
    months, y, m = [], start.year, start.month
    while (y, m) <= (end.year, end.month):
        months.append((y, m))
        m += 1
        if m > 12:
            m, y = 1, y + 1

    volume_by_date = {}
    for y, m in months:
        print(f"      查詢 TWSE 成交量 {y}/{m:02d} ...")
        try:
            resp = requests.get(
                TWSE_FMTQIK_URL,
                params={"response": "json", "date": f"{y}{m:02d}01", "type": "ALL"},
                timeout=30,
            )
            resp.raise_for_status()
            data = resp.json()
            if data.get("stat") != "OK":
                print(f"        stat={data.get('stat')}，跳過")
                continue
            for row in data.get("data", []):
                if len(row) < 3:
                    continue
                # 日期格式：民國年 "115/04/01"
                parts = row[0].replace(",", "").split("/")
                if len(parts) != 3:
                    continue
                try:
                    iso_date = f"{int(parts[0]) + 1911:04d}-{int(parts[1]):02d}-{int(parts[2]):02d}"
                    # 成交金額（欄位 2），元 → 百萬元
                    volume_by_date[iso_date] = int(row[2].replace(",", "")) // 1_000_000
                except (ValueError, IndexError):
                    continue
        except Exception as e:
            print(f"        TWSE 錯誤: {e}")
        time.sleep(0.5)

    return volume_by_date


def main():
    parser = argparse.ArgumentParser(
        description="從 FinMind 抓取台指期日線（含夜盤）並以加權指數成交量輸出至 day_data/stocks.ftx.json"
    )
    parser.add_argument("--start_date", required=True, help="起始日期 (YYYY-MM-DD)")
    parser.add_argument("--end_date", help="結束日期 (YYYY-MM-DD)，未指定則與起始日期相同")
    parser.add_argument("--token", default="", help="FinMind API token（無 token 有請求頻率限制）")
    parser.add_argument(
        "--output", default="./day_data/stocks.ftx.json", help="輸出檔案路徑"
    )
    args = parser.parse_args()

    end_date = args.end_date or args.start_date
    token = args.token or None

    # 1. 台指期日線（含夜盤）
    print(f"[1/2] 抓取台指期 (TX) 日線: {args.start_date} ~ {end_date} ...")
    futures_records = fetch_data(
        "TaiwanFuturesDaily", "TX", args.start_date, end_date, token
    )
    print(f"      取得 {len(futures_records)} 筆")

    if not futures_records:
        print("未取得台指期資料，結束")
        return

    # 2. 加權指數成交量（台灣證交所 FMTQIK，單位：百萬元）
    print(f"[2/2] 抓取加權指數成交量 (TWSE): {args.start_date} ~ {end_date} ...")
    taiex_vol_by_date = fetch_taiex_volume_twse(args.start_date, end_date)
    print(f"      取得 {len(taiex_vol_by_date)} 筆")

    if not taiex_vol_by_date:
        print("警告：未取得加權指數成交量，volume 欄位將填 0")

    # 3. 整理
    futures_by_date = process_futures_data(futures_records)

    new_data = {}
    for date, f in futures_by_date.items():
        new_data[date] = {
            "date":          date,
            "contract_date": f["contract_date"],
            "open":          f["open"],
            "max":           f["max"],
            "min":           f["min"],
            "volume":        taiex_vol_by_date.get(date, 0),
            "close":         f["close"],
        }

    # 4. 讀取現有檔案並合併（移除 _id / futures_id）
    merged = {}
    if os.path.exists(args.output):
        with open(args.output, "r", encoding="utf-8") as fp:
            try:
                for item in json.load(fp):
                    clean = {k: v for k, v in item.items() if k not in ("_id", "futures_id")}
                    merged[clean["date"]] = clean
            except (json.JSONDecodeError, KeyError):
                print(f"警告：無法解析現有檔案 {args.output}，將覆蓋")

    merged.update(new_data)

    # 依日期降序排列（最新在前）
    output_list = sorted(merged.values(), key=lambda x: x["date"], reverse=True)

    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as fp:
        json.dump(output_list, fp, ensure_ascii=False, indent=2)

    print(f"\n完成！共 {len(output_list)} 筆，已寫入 {args.output}")


if __name__ == "__main__":
    main()
