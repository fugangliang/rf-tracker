#!/usr/bin/env python3
"""OMRON connect 初回認証（1回だけTerminalで対話実行する）。

実行: ~/Documents/rf-tracker/.venv/bin/python ~/Documents/rf-tracker/scripts/omron_auth.py
オムロンコネクトアプリと同じメールアドレス・パスワードでログインし、
リフレッシュトークンと体組成計のデバイス情報を ~/.omronconnect/config.json に保存する。
以後 garmin_fetch.py が無人で使う。パスワードは認証にのみ使い、どこにも保存しない。
トークン失効時も本スクリプトで再認証する。
"""
import datetime
import getpass

from omronconnect import get_omron_connect
from regionserver import get_servers_for_country_code

import omron_client

COUNTRY = "JP"


def main():
    email = input("オムロンコネクト メールアドレス: ").strip()
    password = getpass.getpass("パスワード（表示されません）: ")

    oc = refresh = server = None
    for s in get_servers_for_country_code(COUNTRY) or []:
        try:
            oc = get_omron_connect(s, COUNTRY)
            refresh = oc.login(email, password)
            if refresh:
                server = s
                break
        except Exception as e:
            print(f"  {s}: 接続失敗 ({e})")
    if not refresh:
        raise SystemExit("認証失敗。オムロンコネクトアプリと同じメールアドレス・パスワードか確認する")
    print(f"認証成功: {server}")

    scales = omron_client.list_scales(oc)
    if not scales:
        raise SystemExit("体組成計が見つからない（オムロンコネクトに機器登録されているか確認）")
    sel = scales[0]
    if len(scales) > 1:
        for i, s in enumerate(scales):
            print(f"  [{i}] {s['model']} (ユーザー{s['user']})")
        sel = scales[int(input("使用する体組成計の番号: "))]
    name = f"{sel['model']}:{sel['user']}"
    print(f"体組成計: {name}")

    omron_client.save_config({
        "server": server, "country": COUNTRY, "refreshToken": refresh,
        "device": {"name": name, "serialID": sel["serialID"],
                   "category": "SCALE", "user": sel["user"]},
    })
    print(f"設定を {omron_client.CONFIG_PATH} に保存した。")

    dev = omron_client.to_device(omron_client.load_config())
    today = datetime.date.today()
    daily = omron_client.fetch_daily(oc, dev, today - datetime.timedelta(days=7), today)
    print("\n動作確認（直近7日の体組成）:")
    if not daily:
        print("  測定データなし")
    for ds, v in sorted(daily.items()):
        print(f"  {ds}: 体重{v['weight']}kg 体脂肪{v['fat']}% 骨格筋{v['muscle']}% 内臓脂肪Lv{v['visceral']}")


if __name__ == "__main__":
    main()
