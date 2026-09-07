#!/usr/bin/env python3
"""毎朝のアドバイス生成（v1.6.0）。写し（data/mirror.json）の文脈を Claude Code に無人で渡し、
当日の統合アドバイス（睡眠・食事・活動・負荷）を生成して同期ペイロードに同梱する。

- 文脈: scripts/advice_context.js（logic.js の基準線比・回復度・減量判定＋直近14日表）
- 個人ルール: docs/healthcare_baseline_doc_v1.md（ローカル・未追跡）を実行時に読み込む。
  公開リポジトリには置かない（本スクリプトの固定文には個人情報を書かない）
- 実行: `claude -p`（Claude Code CLI・RFのサブスクリプション）。ツール不使用・1ターン。
  cwd は data/advice/（CLAUDE.md自動探索で rf-tracker の指示書を読ませないため）
- 出力: data/advice/YYYY-MM-DD.md（履歴）と data/advice_latest.json（同期に同梱する最新）
- 失敗時（未ログイン・タイムアウト・空応答）は例外→呼び出し側は前回の advice_latest を据え置く

実行例:
  advice_gen.py                 # 写しの最終日で生成
  advice_gen.py --date 2026-09-07
  advice_gen.py --dry-run       # プロンプトを表示するだけ
"""
import argparse
import datetime
import json
import os
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ADVICE_DIR = os.path.join(ROOT, "data", "advice")
LATEST_PATH = os.path.join(ROOT, "data", "advice_latest.json")
BASELINE_DOC = os.path.join(ROOT, "docs", "healthcare_baseline_doc_v1.md")
CONTEXT_JS = os.path.join(ROOT, "scripts", "advice_context.js")
CLAUDE_BIN = "/opt/homebrew/bin/claude"
NODE_BIN = "/opt/homebrew/bin/node"
TIMEOUT_SEC = 300

INSTRUCTIONS = """あなたはRF（利用者本人）専属の生理データアナリスト兼パーソナルトレーナーである。
以下の「個人ルール・知見」と「本日の文脈データ」だけを根拠に、今日のアドバイスを日本語で書く。

## 規律
- 結論を先に。忖度・励まし・装飾語は不要。客観的・合理的に。
- 評価はすべて個人基準線比（28日移動平均からの乖離）で行う。人口統計基準での断定はしない。
- データにない事実を推測で補わない。欠測は「データなし」と扱い、それを前提に書く。
- 当日の活動量・摂取・ストレスは翌日確定のため空欄が通常。前日分を「直近」として扱う。
- 交絡（alcohol/golf/travel/sick）がある日の数値は割り引く。浮腫フラグ日の体組成は割り引く。
- 個人ルール（就寝時刻優先・飲酒上限・月2kg超の急減禁止・タンパク質目標・測定条件）に反する
  提案はしない。判断品質への影響（故障モード対応表）は回復度が中・低のときだけ触れる。
- 単日の変動で騒がない。7日平均と基準線の関係、直近14日の傾きで語る。

## 出力形式（この形式以外を出力しない。見出し記号・マークダウン・前置き・締めの挨拶は禁止）
総括: （今日の状態を1文。総合状態と主因）
睡眠: （睡眠スコア・HRV・安静時心拍・BB回復を基準線比で1〜2文）
食事: （摂取kcal・タンパク質・赤字の直近7日を目標比で1〜2文。未記録日が多ければその旨）
活動: （歩数・活動kcalの直近7日を基準線比で1文）
負荷: （日中ストレス平均・高ストレス時間を基準線比で1文。回復とのバランス）
減量: （減量ペースと体組成の質の判定を1文。体重未測定が続くならその指摘）
今日の一手: （最も効く行動を1つ。具体的・今日中に実行可能・数値付き）
判断品質: （回復度が中・低のときのみ。故障モードと予防プロトコルを1文。高なら「特記なし」）

全体で400字以内。各行は1行で書く（行内で改行しない）。
"""


def build_prompt(date):
    ctx = subprocess.run([NODE_BIN, CONTEXT_JS] + ([date] if date else []),
                         capture_output=True, text=True, timeout=60)
    if ctx.returncode != 0:
        raise RuntimeError(f"文脈生成失敗: {ctx.stderr.strip()[:300]}")
    try:
        with open(BASELINE_DOC, encoding="utf-8") as f:
            rules = f.read()
    except FileNotFoundError:
        rules = "（基準線ドキュメントなし）"
    today = datetime.date.today()
    wd = "月火水木金土日"[today.weekday()]
    return (f"{INSTRUCTIONS}\n## 本日: {today.isoformat()}（{wd}）\n\n"
            f"## 個人ルール・知見（基準線ドキュメント）\n{rules}\n\n"
            f"## 本日の文脈データ\n{ctx.stdout}\n"), ctx.stdout


def run_claude(prompt):
    os.makedirs(ADVICE_DIR, exist_ok=True)
    env = dict(os.environ)
    env.setdefault("PATH", "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")
    r = subprocess.run(
        [CLAUDE_BIN, "-p", "--output-format", "text", "--max-turns", "1"],
        input=prompt, capture_output=True, text=True, timeout=TIMEOUT_SEC, cwd=ADVICE_DIR, env=env)
    out = (r.stdout or "").strip()
    if r.returncode != 0 or not out or "Not logged in" in out:
        raise RuntimeError(f"claude失敗 rc={r.returncode}: {(out or r.stderr).strip()[:200]}")
    if "総括:" not in out:
        raise RuntimeError(f"想定外の応答: {out[:200]}")
    return out


def generate(date=None):
    """返り値: {date, text, generatedAt}。履歴と最新を保存する"""
    prompt, ctx = build_prompt(date)
    target = date
    if not target:
        for line in ctx.splitlines():
            if line.startswith("【状態ヘッダー "):
                target = line[len("【状態ヘッダー "):].rstrip("】")
                break
    text = run_claude(prompt)
    advice = {"date": target, "text": text,
              "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")}
    os.makedirs(ADVICE_DIR, exist_ok=True)
    with open(os.path.join(ADVICE_DIR, f"{target}.md"), "w", encoding="utf-8") as f:
        f.write(f"# アドバイス {target}（生成 {advice['generatedAt']}）\n\n{text}\n")
    with open(LATEST_PATH, "w", encoding="utf-8") as f:
        json.dump(advice, f, ensure_ascii=False)
    return advice


def load_latest():
    try:
        with open(LATEST_PATH, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--date")
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args()
    if a.dry_run:
        print(build_prompt(a.date)[0])
        return
    adv = generate(a.date)
    print(f"生成: {adv['date']} ({adv['generatedAt']})\n{adv['text']}")


if __name__ == "__main__":
    main()
