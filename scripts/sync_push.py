#!/usr/bin/env python3
"""Mac側の写し（data/mirror.json）を更新し、AES-256-GCMで暗号化して非公開リポジトリへ push する。

- 写し: 最新エクスポートを種にし、毎朝の自動取得エントリを項目単位でマージ（アプリの
  parseImport merge と同じ規則: 数値は非nullのみ上書き、confounds/noteは空なら既存保持、
  excludeBaseline/edemaはOR）。iPhone側の手入力は写しには戻らない（週次エクスポートで追いつく）
- 暗号化: 鍵は data/sync_key.txt（base64url 32バイト・0600・gitignore対象）。IV 12バイト。
  エンベロープ {v:1, alg:'AES-256-GCM', iv, ct(ciphertext||tag), updated} を data.enc として配信
- push: gh CLI の Contents API（ローカルcloneを持たない）。gh未認証・ネット不通は例外→呼び出し側でログのみ
- 要件§6の例外（2026-09-07 RF承認・C案）: 暗号文のみを RF の非公開リポジトリに置く

実行例:
  sync_push.py --gen-key                     # 鍵を生成し設定文字列とQR(PNG)を出力（初回のみ）
  sync_push.py --seed data/exports/xxx.json  # 写しを種ファイルで初期化（既存の写しは上書き）
  sync_push.py --merge data/import/xxx.json  # 自動取得JSONを写しにマージ（pushしない）
  sync_push.py --push                        # 写しを暗号化して push（garmin_fetch から毎朝自動）
  sync_push.py --status                      # 写しの件数と鍵の有無
"""
import argparse
import base64
import datetime
import json
import os
import secrets
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MIRROR_PATH = os.path.join(ROOT, "data", "mirror.json")
KEY_PATH = os.path.join(ROOT, "data", "sync_key.txt")
QR_PATH = os.path.join(ROOT, "data", "sync_setup_qr.png")
REPO = "fugangliang/rf-tracker-data"
ENC_FILE = "data.enc"
NUMERIC_FIELDS = ["hrv", "rhr", "sleep", "bb", "weight", "mood", "fat", "muscle", "visceral",
                  "steps", "kcalOut", "kcalActive", "kcalIn", "protein", "stress", "stressHighMin"]


def b64url(b):
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def b64url_decode(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def load_key():
    with open(KEY_PATH) as f:
        return b64url_decode(f.read().strip())


def gen_key():
    if os.path.exists(KEY_PATH):
        raise SystemExit(f"鍵は既に存在する: {KEY_PATH}（再生成する場合は先に削除。iPhone側も再設定が必要）")
    key = secrets.token_bytes(32)
    os.makedirs(os.path.dirname(KEY_PATH), exist_ok=True)
    with open(KEY_PATH, "w") as f:
        f.write(b64url(key) + "\n")
    os.chmod(KEY_PATH, 0o600)
    setup = f"rfsync1:{REPO}:{b64url(key)}"
    try:
        import qrcode
        qrcode.make(setup).save(QR_PATH)
        print(f"QR: {QR_PATH}")
    except Exception as e:  # QRは補助手段
        print(f"QR生成スキップ: {e}")
    print(f"設定文字列（保全タブ「自動同期」に貼る）:\n{setup}")


def load_mirror():
    try:
        with open(MIRROR_PATH) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def save_mirror(entries):
    entries = sorted(entries, key=lambda e: e["date"])
    os.makedirs(os.path.dirname(MIRROR_PATH), exist_ok=True)
    with open(MIRROR_PATH, "w") as f:
        json.dump(entries, f, ensure_ascii=False)
    return entries


def normalize(e):
    out = {"date": e["date"]}
    for k in NUMERIC_FIELDS:
        v = e.get(k)
        out[k] = v if isinstance(v, (int, float)) and not isinstance(v, bool) else None
    out["confounds"] = [c for c in (e.get("confounds") or []) if isinstance(c, str)]
    out["excludeBaseline"] = e.get("excludeBaseline") is True
    out["edema"] = e.get("edema") is True
    out["note"] = e.get("note") if isinstance(e.get("note"), str) else ""
    return out


def merge_entry(old, new):
    """アプリの parseImport(merge) と同じ規則"""
    m = dict(old)
    for k in NUMERIC_FIELDS:
        if new.get(k) is not None:
            m[k] = new[k]
    if new.get("confounds"):
        m["confounds"] = new["confounds"]
    m["excludeBaseline"] = old.get("excludeBaseline") is True or new.get("excludeBaseline") is True
    m["edema"] = old.get("edema") is True or new.get("edema") is True
    if new.get("note"):
        m["note"] = new["note"]
    return m


def merge_into_mirror(incoming):
    """incoming（自動取得エントリ list）を写しにマージして保存。返り値: (総件数, 更新件数)"""
    by_date = {e["date"]: normalize(e) for e in load_mirror()}
    changed = 0
    for raw in incoming:
        e = normalize(raw)
        before = by_date.get(e["date"])
        merged = merge_entry(before, e) if before else e
        if merged != before:
            changed += 1
        by_date[e["date"]] = merged
    entries = save_mirror(list(by_date.values()))
    return len(entries), changed


def encrypt_envelope(payload: bytes, key: bytes):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    iv = secrets.token_bytes(12)
    ct = AESGCM(key).encrypt(iv, payload, None)  # ciphertext||tag（WebCrypto互換）
    return {"v": 1, "alg": "AES-256-GCM", "iv": b64url(iv), "ct": b64url(ct),
            "updated": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")}


def gh_api(args, input_json=None):
    cmd = ["gh", "api"] + args
    r = subprocess.run(cmd, input=input_json, capture_output=True, text=True, timeout=60)
    return r.returncode, r.stdout, r.stderr


def push_envelope(env):
    """Contents API で data.enc を作成/更新。返り値: commit sha"""
    content_b64 = base64.b64encode(json.dumps(env).encode()).decode()
    rc, out, _ = gh_api(["-H", "Accept: application/vnd.github+json", f"/repos/{REPO}/contents/{ENC_FILE}"])
    sha = json.loads(out).get("sha") if rc == 0 else None
    body = {"message": f"sync {env['updated']}", "content": content_b64}
    if sha:
        body["sha"] = sha
    rc, out, err = gh_api(["-X", "PUT", f"/repos/{REPO}/contents/{ENC_FILE}", "--input", "-"], json.dumps(body))
    if rc != 0:
        raise RuntimeError(f"push失敗: {err.strip()[:300]}")
    return json.loads(out)["commit"]["sha"]


def build_payload(entries, advice=None):
    """平文ペイロード v2: {v:2, entries:[...], advice:{date,text,generatedAt}|null}
    （アプリ sync.js parsePayload は v1=配列 も受理する）"""
    return json.dumps({"v": 2, "entries": entries, "advice": advice}, ensure_ascii=False).encode()


def push_mirror(advice=None):
    entries = load_mirror()
    if not entries:
        raise RuntimeError("写しが空（--seed で初期化する）")
    env = encrypt_envelope(build_payload(entries, advice), load_key())
    sha = push_envelope(env)
    return len(entries), env["updated"], sha


def update_and_push(incoming, advice=None):
    """garmin_fetch から呼ぶ入口。写しをマージして push。返り値: 説明文字列"""
    total, changed = merge_into_mirror(incoming)
    n, updated, sha = push_mirror(advice)
    return f"写し{total}件（更新{changed}）{'＋アドバイス' + advice['date'] if advice else ''}→ {REPO}/{ENC_FILE} {updated} commit {sha[:7]}"


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--gen-key", action="store_true")
    p.add_argument("--seed", help="写しを初期化する種ファイル（エクスポートJSON）")
    p.add_argument("--merge", help="自動取得JSONを写しにマージ（pushはしない）")
    p.add_argument("--push", action="store_true")
    p.add_argument("--status", action="store_true")
    a = p.parse_args()
    if a.gen_key:
        gen_key()
    if a.seed:
        with open(a.seed) as f:
            data = json.load(f)
        entries = save_mirror([normalize(e) for e in (data if isinstance(data, list) else [data])])
        print(f"写しを初期化: {len(entries)}件（{entries[0]['date']}〜{entries[-1]['date']}）")
    if a.merge:
        with open(a.merge) as f:
            data = json.load(f)
        print("マージ: 総%d件・更新%d件" % merge_into_mirror(data if isinstance(data, list) else [data]))
    if a.push:
        try:
            import advice_gen
            adv = advice_gen.load_latest()
        except Exception:
            adv = None
        n, updated, sha = push_mirror(adv)
        print(f"push: {n}件 {updated} commit {sha[:7]}")
    if a.status or not any([a.gen_key, a.seed, a.merge, a.push]):
        m = load_mirror()
        print(f"写し: {len(m)}件" + (f"（{m[0]['date']}〜{m[-1]['date']}）" if m else "") +
              f" / 鍵: {'あり' if os.path.exists(KEY_PATH) else 'なし'}")


if __name__ == "__main__":
    main()
