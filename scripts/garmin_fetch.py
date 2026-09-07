#!/usr/bin/env python3
"""Garmin Connect＋OMRON connectから日次データを取得し、アプリ取込用JSONを生成する。

- Garmin: sleep/rhr/bb/hrv＋活動量 steps/kcalOut/kcalActive（v1.4.0〜）、
  OMRON: weight/fat/muscle/visceral（体組成）。
  活動量は当日分を常にnullにする（9:30時点は日中途中の部分値のため）。前日以前は
  ローリング7日再配信＋マージ取込（非nullのみ上書き）で翌日以降に確定値へ自己修正される。
  kcalIn/protein（摂取kcal・タンパク質）はGarmin Connect+の栄養トラッキング
  （nutrition-service の dailyNutritionContent）から取得（2026-09-07〜）。食事ログが
  ない日はnull（0にしない＝マージで手入力を潰さない）。当日分は活動量と同様にnull。
  取込が同一日付を丸ごと置換する仕様のため、両者を同一エントリにマージして
  1ファイル/日で出力する（別ファイルにすると互いのデータを消し合う）
- OMRONは未認証・取得失敗時はスキップしGarmin分のみで続行する（omron_client.py参照）
- 常に直近7日分（今日を含む）を出力する（2026-08-10改訂・ローリング方式）。
  アプリ側取込がマージ方式（非nullのみ更新・v1.3.0〜）になったため重複配信は安全。
  取込を数日飛ばしても次の1回で追いつき、時計未同期・OMRON転送遅れの日も
  7日以内なら翌日以降の再配信で自動的に埋まる。
  状態（data/auto_fetch_state.json）はOMRON取りこぼし検出と観測用に維持。
- 出力先: data/import/auto_daily_latest.json（固定名・上書き）と
  iCloud Drive の rf-tracker/garmin_YYYYMMDD.json（アプリ「ファイルから取込」が読む・予備経路）
- v1.5.0〜 自動同期: sync_push.py で写し（data/mirror.json）にマージ→AES-256-GCM暗号化→
  非公開リポジトリ rf-tracker-data/data.enc へ push。アプリは起動時に取得・復号・マージ取込
- 列マッピングはCSV運用（CLAUDE.md 2026-07-16確定）と同一:
  睡眠スコア→sleep / 安静時心拍→rhr / bodyBatteryChange→bb / 夜間HRV→hrv
  （CSVの「Body Battery」列＝睡眠中の回復量＝sleep APIのbodyBatteryChange。
    2026-07-27にCSV実績値7日分と突合し全一致を確認済み）

実行例:
  garmin_fetch.py                      # 通常運用（直近7日〜今日のローリング窓）
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
WINDOW_DAYS = 7  # 通常運用の出力窓（今日を含む直近7日。マージ取込前提で重複配信は安全）
OMRON_TRACK_START = "2026-07-30"  # 自動化開始日。これ以前の測定は取りこぼし判定の対象外
OMRON_LOOKBACK_DAYS = 7  # 取りこぼし検出の遡り日数（これを過ぎた未配信日は検出から外れる）


def log(msg):
    print(f"[{datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}")


def empty_entry(date):
    return {
        "date": date, "hrv": None, "rhr": None, "sleep": None, "bb": None,
        "weight": None, "mood": None, "fat": None, "muscle": None, "visceral": None,
        "steps": None, "kcalOut": None, "kcalActive": None,  # Garmin活動量（v1.4.0）
        "kcalIn": None, "protein": None,  # Garmin Connect+ 栄養トラッキング（食事ログなしはNone）
        "stress": None, "stressHighMin": None,  # Garmin 日中ストレス（v1.6.0・負荷の代理変数）
        "bedHour": None, "sleepHrs": None,  # 就寝時刻（0:30=24.5）・睡眠時間h（v1.6.1・当日分も出す）
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
    """睡眠スコア・bodyBatteryChange（睡眠中BB回復量）・就寝時刻（小数時・24時以降は+24）・睡眠時間h"""
    js = api.get_sleep_data(d) or {}
    dto = js.get("dailySleepDTO") or {}
    score = ((dto.get("sleepScores") or {}).get("overall") or {}).get("value")
    bed_hour = sleep_hrs = None
    start_local = dto.get("sleepStartTimestampLocal")  # ローカル時刻をUTCエポックとして表現したms
    if isinstance(start_local, (int, float)) and start_local > 0:
        t = datetime.datetime.fromtimestamp(start_local / 1000, tz=datetime.timezone.utc)
        h = t.hour + t.minute / 60
        bed_hour = round(h + 24 if h < 12 else h, 2)
    secs = dto.get("sleepTimeSeconds")
    if isinstance(secs, (int, float)) and secs > 0:
        sleep_hrs = round(secs / 3600, 2)
    return score, js.get("bodyBatteryChange"), bed_hour, sleep_hrs


NUTRITION_DIR = os.path.join(ROOT, "data", "nutrition")


def save_nutrition_detail(api, d):
    """前日以前の食事内訳（食事ごとのkcal/PFC・品名）をMacローカルに保存（アドバイス生成の文脈用・配信しない）"""
    js = api.get_nutrition_daily_food_log(d) or {}
    meals = []
    for md in js.get("mealDetails") or []:
        c = md.get("mealNutritionContent") or {}
        foods = [(f.get("foodMetaData") or {}).get("foodName") for f in md.get("loggedFoods") or []]
        foods = [x for x in foods if x]
        if not foods and not c.get("calories"):
            continue
        meals.append({"name": (md.get("meal") or {}).get("mealName"), "calories": c.get("calories"),
                      "protein": c.get("protein"), "fat": c.get("fat"), "carbs": c.get("carbs"), "foods": foods})
    if not meals:
        return False
    tot = js.get("dailyNutritionContent") or {}
    goals = js.get("dailyNutritionGoals") or {}
    os.makedirs(NUTRITION_DIR, exist_ok=True)
    with open(os.path.join(NUTRITION_DIR, f"{d}.json"), "w") as f:
        json.dump({"date": d, "meals": meals,
                   "total": {k: tot.get(k) for k in ("calories", "protein", "fat", "carbs")},
                   "goals": {k: goals.get(k) for k in ("calories", "protein")}}, f, ensure_ascii=False)
    return True


def fetch_rhr(api, d):
    js = api.get_rhr_day(d) or {}
    metrics = ((js.get("allMetrics") or {}).get("metricsMap") or {})
    vals = metrics.get("WELLNESS_RESTING_HEART_RATE") or []
    return vals[0].get("value") if vals else None


def fetch_hrv(api, d):
    js = api.get_hrv_data(d) or {}
    return (js.get("hrvSummary") or {}).get("lastNightAvg")


def fetch_activity(api, d):
    """日次サマリーから 歩数 / 総消費kcal / 活動kcal / 平均ストレス / 高ストレス分（いずれもGarmin推定）"""
    js = api.get_user_summary(d) or {}
    to_int = lambda v: int(round(v)) if isinstance(v, (int, float)) else None
    stress = js.get("averageStressLevel")
    stress = to_int(stress) if isinstance(stress, (int, float)) and stress >= 0 else None  # 未計測は-1
    high = js.get("highStressDuration")
    high_min = int(round(high / 60)) if isinstance(high, (int, float)) and high >= 0 else None
    return (to_int(js.get("totalSteps")), to_int(js.get("totalKilocalories")),
            to_int(js.get("activeKilocalories")), stress, high_min)


def fetch_nutrition(api, d):
    """Garmin Connect+ 栄養トラッキングの日次合計（摂取kcal / タンパク質g）。
    食事ログが1件もない日は dailyNutritionContent が無い or calories=0 → (None, None)。
    ※ user_summary の consumedKilocalories は Connect+ 食事ログを反映しない（2026-09-07確認）"""
    js = api.get_nutrition_daily_food_log(d) or {}
    c = js.get("dailyNutritionContent") or {}
    kcal = c.get("calories")
    if not isinstance(kcal, (int, float)) or kcal <= 0:
        return None, None
    prot = c.get("protein")
    return int(round(kcal)), (int(round(prot)) if isinstance(prot, (int, float)) else None)


def merge_omron(entries_by_date, start, today, prev_delivered):
    """OMRON connectから体組成（weight/fat/muscle/visceral）を取得し同一日付にマージする。

    未認証・取得失敗時はログを残してGarmin分のみで続行する（自動取得全体を止めない）。
    ローリング7日配信＋マージ取込（v1.3.0〜）により、Bluetooth転送が9:30に
    間に合わなかった日も7日以内なら翌日以降の再配信で自動的に埋まる。
    取りこぼし検出は「7日窓を過ぎてから届いた測定」だけを拾う安全網として維持。
    返り値: (今回体組成を配信した日付list, 取りこぼし日付list)
    """
    import omron_client

    cfg = omron_client.load_config()
    if not cfg:
        log("OMRON: 未認証のためスキップ（有効化は scripts/omron_auth.py をTerminalで実行）")
        return [], []
    try:
        oc = omron_client.connect(cfg)
        lookback = start - datetime.timedelta(days=OMRON_LOOKBACK_DAYS)
        daily = omron_client.fetch_daily(oc, omron_client.to_device(cfg), lookback, today)
    except Exception as e:
        log(f"OMRON: 取得失敗のため体組成なしで続行（続くなら要再認証: scripts/omron_auth.py）: {e}")
        return [], []
    delivered = []
    for ds, vals in sorted(daily.items()):
        if ds >= start.isoformat():
            e = entries_by_date.setdefault(ds, empty_entry(ds))
            e.update(vals)
            delivered.append(ds)
            log(f"  {ds}: OMRON {vals}")
    if not delivered:
        log("OMRON: 対象期間の測定なし")
    gaps = [ds for ds in sorted(daily)
            if OMRON_TRACK_START <= ds < start.isoformat() and ds not in prev_delivered]
    if gaps:
        log(f"OMRON: 取りこぼし{len(gaps)}日分 {gaps} → 記録タブで手入力が必要")
    return delivered, gaps


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
    state = load_state()
    if args.since:
        start = datetime.date.fromisoformat(args.since)
    else:
        start = today - datetime.timedelta(days=WINDOW_DAYS - 1)

    api = Garmin()
    try:
        api.login(TOKEN_DIR)
    except Exception as e:
        log(f"トークンでのログイン失敗（要再認証: scripts/garmin_auth.py）: {e}")
        sys.exit(0)  # launchd常駐時にエラー扱いにしない
    log(f"取得範囲: {start} 〜 {today}")

    entries_by_date = {}
    d = start
    while d <= today:
        ds = d.isoformat()
        e = empty_entry(ds)
        e["sleep"], e["bb"], e["bedHour"], e["sleepHrs"] = safe(fetch_sleep, api, ds) or (None, None, None, None)
        rhr = safe(fetch_rhr, api, ds)
        e["rhr"] = int(round(rhr)) if rhr is not None else None  # APIはfloatで返す
        e["hrv"] = safe(fetch_hrv, api, ds)
        if d < today:  # 当日は日中途中の部分値になるため出力しない（翌日以降の再配信で確定）
            e["steps"], e["kcalOut"], e["kcalActive"], e["stress"], e["stressHighMin"] = \
                safe(fetch_activity, api, ds) or (None, None, None, None, None)
            e["kcalIn"], e["protein"] = safe(fetch_nutrition, api, ds) or (None, None)
            safe(save_nutrition_detail, api, ds)
        got = {k: e[k] for k in ("sleep", "rhr", "hrv", "bb", "bedHour", "sleepHrs", "steps", "kcalOut", "kcalActive", "kcalIn", "protein", "stress", "stressHighMin")}
        if any(v is not None for v in got.values()):
            entries_by_date[ds] = e
            log(f"  {ds}: {got}")
        else:
            log(f"  {ds}: Garminデータなし")
        d += datetime.timedelta(days=1)

    delivered, gaps = merge_omron(entries_by_date, start, today,
                                  set(state.get("omronDates", [])))
    entries = [entries_by_date[ds] for ds in sorted(entries_by_date)]

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
    # ファイル名は実行日基準（最終エントリ日基準だと当日データ未同期の日に古い日付へ
    # 退行し、iOSピッカーでの取り違えや旧名レコードへの上書きが起きる。2026-08-11発生）
    fname = f"garmin_{today.isoformat().replace('-', '')}.json"
    with open(os.path.join(ICLOUD_DIR, fname), "w") as f:
        f.write(payload)
    log(f"出力: {len(entries)}件 → {OUT_LOCAL} / iCloud Drive {fname}")

    # v1.5.0 自動同期: Mac側の写しにマージし、暗号化して非公開リポジトリへ push
    # （失敗してもiCloud配信は済んでいるので従来の「ファイルから取込」で運用継続できる）
    try:
        import sync_push
        total, changed = sync_push.merge_into_mirror(entries)
        log(f"写し: {total}件（更新{changed}）")
    except Exception as e:
        log(f"写し更新失敗（iCloud配信は完了済み）: {e}")
        return
    # v1.6.0 アドバイス生成（Claude Code無人実行）。失敗時は前回分を据え置く
    advice = None
    try:
        import advice_gen
        advice = advice_gen.generate()
        log(f"アドバイス生成: {advice['date']}")
    except Exception as e:
        import advice_gen as _ag
        advice = _ag.load_latest()
        log(f"アドバイス生成失敗（前回分{advice['date'] if advice else 'なし'}を据え置き）: {e}")
    try:
        n, updated, sha = sync_push.push_mirror(advice)
        log(f"同期: {n}件{'＋アドバイス' if advice else ''} → {sync_push.REPO}/{sync_push.ENC_FILE} {updated} commit {sha[:7]}")
    except Exception as e:
        log(f"同期push失敗（iCloud配信は完了済み。手動: scripts/sync_push.py --push）: {e}")

    if not args.since:  # --since は検証・追補用のため状態を進めない
        # omronDates=体組成を配信済みの日付（取りこぼし誤検出の防止用・直近60日分）。
        # omronGaps=現在の取りこぼし。セッション再開時にClaudeが確認しRFにリマインドする
        omron_dates = sorted(set(state.get("omronDates", [])) | set(delivered))[-60:]
        with open(STATE_PATH, "w") as f:
            json.dump({"lastDate": entries[-1]["date"],
                       "omronDates": omron_dates, "omronGaps": gaps}, f)


if __name__ == "__main__":
    main()
