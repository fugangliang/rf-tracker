#!/usr/bin/env python3
"""Garmin Connect 初回認証（1回だけTerminalで対話実行する）。

実行: ~/Documents/rf-tracker/.venv/bin/python ~/Documents/rf-tracker/scripts/garmin_auth.py
トークンは ~/.garminconnect/ に保存され、以後 garmin_fetch.py が無人で使う。
パスワードはトークン取得にのみ使い、どこにも保存しない。
"""
import getpass
import os

import garth

TOKEN_DIR = os.path.expanduser("~/.garminconnect")


def main():
    email = input("Garmin Connect メールアドレス: ").strip()
    password = getpass.getpass("パスワード（表示されません）: ")
    garth.login(email, password)  # MFA有効時はコード入力を求められる
    garth.save(TOKEN_DIR)
    os.chmod(TOKEN_DIR, 0o700)
    print(f"\n認証成功。トークンを {TOKEN_DIR} に保存した。")
    print("動作確認: .venv/bin/python scripts/garmin_fetch.py --since 2026-07-21 --stdout")


if __name__ == "__main__":
    main()
