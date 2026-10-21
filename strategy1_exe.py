import os
import sys
import signal
import shioaji as sj
from shioaji import constant as sc
from datetime import datetime

# ============================================================
#  台指期即時報價 — 使用 Shioaji API
# ============================================================
#  使用方式：
#    設定環境變數後執行：
#      export SJ_API_KEY="你的API_KEY"
#      export SJ_SECRET_KEY="你的SECRET_KEY"
#      python3 strategy1_exe.py
#
#    或直接帶入參數：
#      python3 strategy1_exe.py <API_KEY> <SECRET_KEY>
# ============================================================

def get_credentials():
    if len(sys.argv) >= 3:
        return sys.argv[1], sys.argv[2]
    api_key = os.environ.get("SJ_API_KEY")
    secret_key = os.environ.get("SJ_SECRET_KEY")
    if not api_key or not secret_key:
        print("請提供 API 金鑰：")
        print("  方式一：export SJ_API_KEY=xxx && export SJ_SECRET_KEY=xxx")
        print("  方式二：python3 strategy1_exe.py <API_KEY> <SECRET_KEY>")
        sys.exit(1)
    return api_key, secret_key


def main():
    api_key, secret_key = get_credentials()

    # --- 初始化 & 登入 ---
    api = sj.Shioaji()
    print("登入中...")
    accounts = api.login(api_key=api_key, secret_key=secret_key)
    print(f"登入成功！帳號：{accounts}")

    # --- 取得台指期近月合約 ---
    # Contracts.Futures.TXF 底下會有各月份合約，取第一個（近月）
    txf = min(
        [c for c in api.Contracts.Futures.TXF
         if c.code[-2:] not in ("R1", "R2")],
        key=lambda c: c.delivery_date
    )
    print(f"訂閱合約：{txf.code} ({txf.name})，到期日：{txf.delivery_date}")

    # --- 註冊 Tick 回呼 ---
    @api.on_tick_fop_v1()
    def on_tick(exchange, tick):
        t = tick.datetime.strftime("%H:%M:%S.%f")[:-3]
        arrow = "▲" if tick.close >= tick.open else "▼"
        print(
            f"[{t}] {arrow} 成交 {tick.close:>8.0f}  "
            f"量 {tick.volume:>5}  "
            f"總量 {tick.total_volume:>8}"
        )

    # --- 註冊 BidAsk 回呼 ---
    @api.on_bidask_fop_v1()
    def on_bidask(exchange, bidask):
        t = bidask.datetime.strftime("%H:%M:%S.%f")[:-3]
        print(
            f"[{t}]    "
            f"買 {bidask.bid_price[0]:>8.0f} x {bidask.bid_volume[0]:<5}  "
            f"賣 {bidask.ask_price[0]:>8.0f} x {bidask.ask_volume[0]:<5}"
        )

    # --- 訂閱 Tick ---
    api.quote.subscribe(txf, quote_type=sc.QuoteType.Tick, version=sc.QuoteVersion.v1)
    # --- 訂閱五檔 ---
    api.quote.subscribe(txf, quote_type=sc.QuoteType.BidAsk, version=sc.QuoteVersion.v1)

    print("\n即時報價已啟動，按 Ctrl+C 結束...\n")

    # --- 等待直到中斷 ---
    def shutdown(sig, frame):
        print("\n正在登出...")
        api.quote.unsubscribe(txf, quote_type=sc.QuoteType.Tick, version=sc.QuoteVersion.v1)
        api.quote.unsubscribe(txf, quote_type=sc.QuoteType.BidAsk, version=sc.QuoteVersion.v1)
        api.logout()
        print("已登出，程式結束。")
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)
    signal.pause()


if __name__ == "__main__":
    main()
