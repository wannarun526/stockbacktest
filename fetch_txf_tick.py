#!/usr/bin/env python3
"""
抓取台指期 (TXF) 1 分 K 線資料 —— 適用 Shioaji >= 1.7.0

與舊版的主要差異：
  * 指數改用交易所代碼：加權指數為 IX0001（舊的 001 / TSE001 已失效）
  * 合約查詢建議改用 api.contracts.get(code)
  * KBars 轉 DataFrame 使用 kbars.dict()
  * 抓歷史資料不需要 CA 憑證（CA 只有下單才需要），此處改為可選

用法：
  python fetch_txf_kbars.py --api_key XXX --secret_key YYY \
      --start_date 2026-08-01 --end_date 2026-08-08
"""

from __future__ import annotations

import argparse
import json
import os
import time
from datetime import date, datetime, timedelta

import pandas as pd
import shioaji as sj

# ---------------------------------------------------------------------------
# 常數
# ---------------------------------------------------------------------------
FUTURES_CODE = "TXFR1"          # 台指期近月連續合約（結算日自動換月）
INDEX_CODE = "IX0001"           # 發行量加權股價指數（1.7.0 起的交易所代碼）
FUTURES_HISTORY_START = date(2020, 3, 22)   # 期貨歷史資料最早日期
INDEX_HISTORY_START = date(2020, 3, 2)      # 指數歷史資料最早日期


# ---------------------------------------------------------------------------
# 工具函式
# ---------------------------------------------------------------------------
def kbars_to_df(kbars) -> pd.DataFrame:
    """把 Shioaji 的 KBars 物件轉成 DataFrame，ts 轉為 datetime。"""
    if kbars is None:
        return pd.DataFrame()

    df = pd.DataFrame(kbars.dict())
    if df.empty or "ts" not in df.columns:
        return pd.DataFrame()

    df["ts"] = pd.to_datetime(df["ts"], unit="ns")
    return df.sort_values("ts").reset_index(drop=True)


def fetch_kbars_with_retry(api, contract, date_str, retries=2, backoff=3.0):
    """單日 kbars 查詢，失敗時重試。全部失敗回傳 None。"""
    for attempt in range(retries + 1):
        try:
            return api.kbars(contract=contract, start=date_str, end=date_str)
        except Exception as exc:  # noqa: BLE001 — 網路/限流錯誤都先接住
            if attempt == retries:
                print(f"  ✗ 查詢失敗（已重試 {retries} 次）：{exc}")
                return None
            wait = backoff * (attempt + 1)
            print(f"  ! 查詢失敗，{wait:.0f} 秒後重試：{exc}")
            time.sleep(wait)
    return None


# ---------------------------------------------------------------------------
# 單日抓取
# ---------------------------------------------------------------------------
def fetch_single_day(api, contract, index_contract, date_str, out_dir) -> bool:
    """抓取單日 1 分 K 線並寫成 JSON。成功回傳 True。"""
    print(f"\n正在抓取 {date_str} 的 1 分 K 線資料...")

    kbars = fetch_kbars_with_retry(api, contract, date_str)
    df = kbars_to_df(kbars)

    if df.empty:
        print(f"  {date_str} 無資料（可能非交易日）")
        return False

    print(f"  期貨：{len(df)} 筆")

    # ---- 加權指數（可選）------------------------------------------------
    index_volume_map: dict[str, int] = {}
    if index_contract is not None:
        index_df = kbars_to_df(fetch_kbars_with_retry(api, index_contract, date_str))
        if index_df.empty:
            print("  加權指數：無資料")
        else:
            index_volume_map = {
                ts.strftime("%Y-%m-%d %H:%M:%S"): int(vol)
                for ts, vol in zip(index_df["ts"], index_df["Volume"])
            }
            print(f"  加權指數：{len(index_df)} 筆")

    # ---- 組資料 ----------------------------------------------------------
    # 注意：期貨有夜盤（15:00~次日 05:00），指數只有 09:00~13:30，
    # 夜盤時段的 index_volume 會是 0，屬正常現象。
    records = [
        {
            "datetime": (dt_str := row.ts.strftime("%Y-%m-%d %H:%M:%S")),
            "open": float(row.Open),
            "high": float(row.High),
            "low": float(row.Low),
            "close": float(row.Close),
            "volume": int(row.Volume),
            "tse_volume": index_volume_map.get(dt_str, 0),
        }
        for row in df.itertuples(index=False)
    ]

    os.makedirs(out_dir, exist_ok=True)
    output_file = os.path.join(out_dir, f"{date_str}.json")
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(records, f, ensure_ascii=False, indent=2)

    print(f"  → 已儲存 {output_file}")
    return True


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
def fetch_txf_1min_kbars(
    start_date: str,
    end_date: str,
    api_key: str,
    secret_key: str,
    out_dir: str = "./minute_data",
    sleep_sec: float = 1.0,
    skip_index: bool = False,
    include_weekends: bool = False,
    overwrite: bool = False,
    ca_path: str | None = None,
    ca_passwd: str | None = None,
    person_id: str | None = None,
) -> None:
    start = datetime.strptime(start_date, "%Y-%m-%d").date()
    end = datetime.strptime(end_date, "%Y-%m-%d").date()

    if start > end:
        raise ValueError("start_date 不可晚於 end_date")
    if start < FUTURES_HISTORY_START:
        raise ValueError(
            f"期貨歷史資料最早只到 {FUTURES_HISTORY_START}，請調整 start_date"
        )

    api = sj.Shioaji()

    print("正在登入永豐金證券 API...")
    api.login(api_key=api_key, secret_key=secret_key)
    print("登入成功！")

    # CA 憑證只有下單才需要；抓歷史資料可略過。
    if ca_path and ca_passwd and person_id:
        api.activate_ca(ca_path=ca_path, ca_passwd=ca_passwd, person_id=person_id)
        print("CA 憑證已啟用")

    try:
        contract = api.contracts.get(FUTURES_CODE)
        if contract is None:
            raise RuntimeError(f"找不到合約 {FUTURES_CODE}")

        index_contract = None
        if not skip_index:
            index_contract = api.contracts.get(INDEX_CODE)
            if index_contract is None:
                print(f"警告：找不到指數合約 {INDEX_CODE}，將略過指數資料")

        print(f"\n開始抓取 {start_date} ~ {end_date} 的資料...")

        success = skipped = failed = 0
        current = start

        while current <= end:
            date_str = current.isoformat()

            # 週末沒有交易，直接跳過以節省流量
            if not include_weekends and current.weekday() >= 5:
                current += timedelta(days=1)
                continue

            output_file = os.path.join(out_dir, f"{date_str}.json")
            if not overwrite and os.path.exists(output_file):
                print(f"\n{date_str} 已存在，略過")
                skipped += 1
                current += timedelta(days=1)
                continue

            if fetch_single_day(api, contract, index_contract, date_str, out_dir):
                success += 1
            else:
                failed += 1

            current += timedelta(days=1)
            if current <= end and sleep_sec > 0:
                time.sleep(sleep_sec)

        print("\n========== 完成 ==========")
        print(f"成功：{success} 天")
        print(f"略過（已存在）：{skipped} 天")
        print(f"失敗／無資料：{failed} 天")

    finally:
        api.logout()
        print("已登出")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main() -> None:
    parser = argparse.ArgumentParser(description="抓取台指期 1 分 K 線資料 (Shioaji >= 1.7.0)")
    parser.add_argument("--api_key", required=True, help="Shioaji API Key")
    parser.add_argument("--secret_key", required=True, help="Shioaji Secret Key")
    parser.add_argument("--start_date", required=True, help="起始日期 (YYYY-MM-DD)")
    parser.add_argument("--end_date", help="結束日期 (YYYY-MM-DD)，未指定則同起始日期")
    parser.add_argument("--out_dir", default="./minute_data", help="輸出目錄")
    parser.add_argument("--sleep", type=float, default=1.0, help="每日之間的間隔秒數")
    parser.add_argument("--skip_index", action="store_true", help="不抓加權指數資料")
    parser.add_argument("--include_weekends", action="store_true", help="連週末也一併查詢")
    parser.add_argument("--overwrite", action="store_true", help="覆寫已存在的檔案")
    # 以下僅在你要用同一支程式下單時才需要
    parser.add_argument("--ca_path", help="CA 憑證路徑（抓資料不需要）")
    parser.add_argument("--ca_passwd", help="CA 憑證密碼（抓資料不需要）")
    parser.add_argument("--person_id", help="身分證字號（抓資料不需要）")

    args = parser.parse_args()
    end_date = args.end_date or args.start_date

    fetch_txf_1min_kbars(
        start_date=args.start_date,
        end_date=end_date,
        api_key=args.api_key,
        secret_key=args.secret_key,
        out_dir=args.out_dir,
        sleep_sec=args.sleep,
        skip_index=args.skip_index,
        include_weekends=args.include_weekends,
        overwrite=args.overwrite,
        ca_path=args.ca_path,
        ca_passwd=args.ca_passwd,
        person_id=args.person_id,
    )


if __name__ == "__main__":
    main()