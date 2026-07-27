#!/usr/bin/env python3
"""Garmin Connect 初回認証（1回だけTerminalで対話実行する）。

実行: ~/Documents/rf-tracker/.venv/bin/python ~/Documents/rf-tracker/scripts/garmin_auth.py
トークンは ~/.garminconnect/ に保存され、以後 garmin_fetch.py が無人で使う。
パスワードはトークン取得にのみ使い、どこにも保存しない。
"""
import getpass
import os

from garminconnect import Garmin

TOKEN_DIR = os.path.expanduser("~/.garminconnect")


def main():
    email = input("Garmin Connect メールアドレス: ").strip()
    password = getpass.getpass("パスワード（表示されません）: ")
    api = Garmin(
        email=email,
        password=password,
        prompt_mfa=lambda: input("MFAコード（メール/SMSの6桁）: ").strip(),
    )
    api.login(TOKEN_DIR)  # 認証成功時にトークンをTOKEN_DIRへ自動保存する
    os.chmod(TOKEN_DIR, 0o700)
    name = getattr(api, "display_name", None) or getattr(api, "full_name", None)
    print(f"\n認証成功（アカウント: {name}）。トークンを {TOKEN_DIR} に保存した。")
    print("動作確認: .venv/bin/python scripts/garmin_fetch.py --since 2026-07-21 --stdout")


if __name__ == "__main__":
    main()
