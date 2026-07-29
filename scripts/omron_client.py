#!/usr/bin/env python3
"""OMRON connect（非公式API）から体組成を取得する共通部（omron_auth.py / garmin_fetch.py が使う）。

- ライブラリ: omramin（コミットf6b6623固定・2026-07-29監査済み）の omronconnect モジュール
- 日本アカウントはAPI v1（data-jp.omronconnect.com）
- 認証情報: ~/.omronconnect/config.json（リフレッシュトークンのみ・パスワード非保存）
- リフレッシュトークンは使用のたびにサーバー側でローテートされるため、接続直後に保存し直す
"""
import datetime
import json
import os

CONFIG_PATH = os.path.expanduser("~/.omronconnect/config.json")


def load_config():
    try:
        with open(CONFIG_PATH) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def save_config(cfg):
    os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
    os.chmod(os.path.dirname(CONFIG_PATH), 0o700)
    with open(CONFIG_PATH, "w") as f:
        json.dump(cfg, f)
    os.chmod(CONFIG_PATH, 0o600)


def connect(cfg):
    """保存済みトークンで接続し、ローテート後の新トークンを保存する。失敗時は例外"""
    from omronconnect import get_omron_connect

    oc = get_omron_connect(cfg["server"], cfg["country"])
    new_token = oc.refresh_oauth2(cfg["refreshToken"])
    if not new_token:
        raise RuntimeError("トークンリフレッシュ失敗（要再認証: scripts/omron_auth.py）")
    cfg["refreshToken"] = new_token
    save_config(cfg)
    return oc


class _Device:
    """get_measurements が参照する属性だけを持つ軽量デバイス。

    ライブラリの OmronDevice は serialID→MACアドレス→serialID の往復変換に
    バグがあり（serial_to_mac が末尾2バイトを落とし誤ったIDになる）、
    測定が0件になる。APIが返す deviceSerialID をそのまま保持して回避する
    """

    def __init__(self, name, serial, category, user):
        from omronconnect import DeviceCategory

        self.name = name
        self.serial = serial
        self.category = DeviceCategory.__members__[category]
        self.user = user


def to_device(cfg):
    d = cfg["device"]
    return _Device(d["name"], d["serialID"], d["category"], d["user"])


def list_scales(oc):
    """登録済み体組成計を (model, serialID, user) で列挙する（真のserialIDを保持するため自前実装）"""
    from omronconnect import DeviceCategory

    r = oc._client.post(
        f"{oc._server}{oc._APP_URL}/versions/current/synchronizeDeviceConfData",
        headers=oc._headers,
        json={"countOnlyFlag": 0, "lastSyncDate": 0},
    )
    r.raise_for_status()
    scales = {}
    for sync in r.json().get("returnedValue", {}).get("syncList", []):
        for cat in sync.get("deviceCategoryList", []):
            for model in cat.get("deviceModelList", []):
                for dev in model.get("deviceSerialIDList", []):
                    user = dev.get("userNumberInDevice")
                    if str(cat.get("deviceCategory")) != DeviceCategory.SCALE.value:
                        continue
                    if str(user) == "0":  # 0はデバイス自体でユーザープロファイルではない
                        continue
                    key = f"{dev['deviceSerialID']}:{user}"
                    scales[key] = {
                        "model": model.get("deviceModel"),
                        "serialID": dev["deviceSerialID"],
                        "user": int(user),
                    }
    return list(scales.values())


def _val(x):
    """APIは欠測を-1.0で返す"""
    return None if x is None or x < 0 else round(float(x), 1)


def fetch_daily(oc, device, start, end):
    """日付ISO文字列 → {weight, fat, muscle, visceral} の辞書を返す。

    同一日に複数測定がある場合は最後の測定を採用する
    （朝の測り直しを正とみなす。日付は測定記録自身のタイムゾーンで解釈）
    """
    frm = datetime.datetime.combine(
        start - datetime.timedelta(days=1), datetime.time()
    ).timestamp()
    out = {}
    for m in sorted(
        oc.get_measurements(device, searchDateFrom=int(frm * 1000)),
        key=lambda m: m.measurementDate,
    ):
        dt = datetime.datetime.fromtimestamp(m.measurementDate / 1000, tz=m.timeZone)
        ds = dt.date().isoformat()
        if start.isoformat() <= ds <= end.isoformat():
            out[ds] = {
                "weight": _val(m.weight),
                "fat": _val(m.bodyFatPercentage),
                "muscle": _val(m.skeletalMusclePercentage),
                "visceral": _val(m.visceralFatLevel),
            }
    return out
