#!/usr/bin/env python3
"""Garmin Connectから日次データ（sleep/rhr/bb/hrv）を取得し、アプリ取込用JSONを生成する。

- 前回生成した日の翌日〜今日だけを出力する（状態: data/auto_fetch_state.json）。
  同一日付の再取込はmood・weight等を消すため、重複出力を構造的に避ける設計。
- 出力先: data/import/auto_daily_latest.json（固定名・上書き）と
  iCloud Drive の rf-tracker/auto_daily_latest.json（iPhoneショートカットが読む）
- 列マッピングはCSV運用（CLAUDE.md 2026-07-16確定）と同一:
  睡眠スコア→sleep / 安静時心拍→rhr / bodyBatteryChange→bb / 夜間HRV→hrv
  （CSVの「Body Battery」列＝睡眠中の回復量＝sleep APIのbodyBatteryChange。
    2026-07-27にCSV実績値7日分と突合し全一致を確認済み）

実行例:
  garmin_fetch.py                      # 通常運用（前回以降〜今日）
  garmin_fetch.py --since 2026-07-21   # 日付指定で再生成（検証・欠落追補用。状態は更新しない）
  garmin_fetch.py --stdout             # ファイルを書かず内容表示のみ
"""
import argparse
import datetime
import json
import os
import sys

TOKEN_DIR = os.path.expanduser("~/.garminconnect")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE_PATH = os.path.join(ROOT, "data", "auto_fetch_state.json")
OUT_LOCAL = os.path.join(ROOT, "data", "import", "auto_daily_latest.json")
# アプリの「ファイルから取込」が読む場所（iPhoneのファイルApp→iCloud Drive→rf-tracker）。
# ファイル名は日付付き（garmin_YYYYMMDD.json）。固定名はiOSピッカーが古い版を
# 掴むことがあるため使わない。書き込み前に旧garmin_*.jsonを削除し常に1本だけ置く
ICLOUD_DIR = os.path.expanduser("~/Library/Mobile Documents/com~apple~CloudDocs/rf-tracker")
MAX_BACKFILL_DAYS = 28  # 状態ファイル欠損時の暴走防止


def log(msg):
    print(f"[{datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}")


def empty_entry(date):
    return {
        "date": date, "hrv": None, "rhr": None, "sleep": None, "bb": None,
        "weight": None, "mood": None, "fat": None, "muscle": None, "visceral": None,
        "confounds": [], "excludeBaseline": False, "edema": False, "note": "",
    }


def safe(fn, *args):
    """取得失敗はそのフィールドのみnullに落とす（1項目の失敗で全体を止めない）"""
    try:
        return fn(*args)
    except Exception as e:
        log(f"  取得失敗 {fn.__name__}{args}: {e}")
        return None


def fetch_sleep(api, d):
    """睡眠スコアと bodyBatteryChange（睡眠中BB回復量＝CSVのBody Battery列と同一）"""
    js = api.get_sleep_data(d) or {}
    dto = js.get("dailySleepDTO") or {}
    score = ((dto.get("sleepScores") or {}).get("overall") or {}).get("value")
    return score, js.get("bodyBatteryChange")


def fetch_rhr(api, d):
    js = api.get_rhr_day(d) or {}
    metrics = ((js.get("allMetrics") or {}).get("metricsMap") or {})
    vals = metrics.get("WELLNESS_RESTING_HEART_RATE") or []
    return vals[0].get("value") if vals else None


def fetch_hrv(api, d):
    js = api.get_hrv_data(d) or {}
    return (js.get("hrvSummary") or {}).get("lastNightAvg")


def load_state():
    try:
        with open(STATE_PATH) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--since", help="この日付から今日まで取得（状態は更新しない）")
    p.add_argument("--stdout", action="store_true", help="ファイルを書かず表示のみ")
    args = p.parse_args()

    from garminconnect import Garmin

    if not os.path.isdir(TOKEN_DIR):
        log(f"未認証（{TOKEN_DIR} なし）。先に scripts/garmin_auth.py をTerminalで実行する")
        sys.exit(0)  # launchd常駐時にエラー扱いにしない

    today = datetime.date.today()
    if args.since:
        start = datetime.date.fromisoformat(args.since)
    else:
        last = load_state().get("lastDate")
        start = (datetime.date.fromisoformat(last) + datetime.timedelta(days=1)
                 if last else today - datetime.timedelta(days=6))
        start = max(start, today - datetime.timedelta(days=MAX_BACKFILL_DAYS))
    if start > today:
        log("新規日付なし（本日分は生成済み）")
        return

    api = Garmin()
    try:
        api.login(TOKEN_DIR)
    except Exception as e:
        log(f"トークンでのログイン失敗（要再認証: scripts/garmin_auth.py）: {e}")
        sys.exit(0)  # launchd常駐時にエラー扱いにしない
    log(f"取得範囲: {start} 〜 {today}")

    entries = []
    d = start
    while d <= today:
        ds = d.isoformat()
        e = empty_entry(ds)
        e["sleep"], e["bb"] = safe(fetch_sleep, api, ds) or (None, None)
        rhr = safe(fetch_rhr, api, ds)
        e["rhr"] = int(round(rhr)) if rhr is not None else None  # APIはfloatで返す
        e["hrv"] = safe(fetch_hrv, api, ds)
        got = {k: e[k] for k in ("sleep", "rhr", "hrv", "bb")}
        if any(v is not None for v in got.values()):
            entries.append(e)
            log(f"  {ds}: {got}")
        else:
            log(f"  {ds}: データなし（スキップ）")
        d += datetime.timedelta(days=1)

    if not entries:
        log("取得できた日がないため出力なし")
        return

    payload = json.dumps(entries, ensure_ascii=False)
    if args.stdout:
        print(payload)
        return

    os.makedirs(os.path.dirname(OUT_LOCAL), exist_ok=True)
    with open(OUT_LOCAL, "w") as f:
        f.write(payload)
    os.makedirs(ICLOUD_DIR, exist_ok=True)
    for old in os.listdir(ICLOUD_DIR):
        if old.startswith("garmin_") and old.endswith(".json"):
            os.remove(os.path.join(ICLOUD_DIR, old))
    fname = f"garmin_{entries[-1]['date'].replace('-', '')}.json"
    with open(os.path.join(ICLOUD_DIR, fname), "w") as f:
        f.write(payload)
    log(f"出力: {len(entries)}件 → {OUT_LOCAL} / iCloud Drive {fname}")

    if not args.since:  # --since は検証・追補用のため状態を進めない
        with open(STATE_PATH, "w") as f:
            json.dump({"lastDate": entries[-1]["date"]}, f)


if __name__ == "__main__":
    main()
