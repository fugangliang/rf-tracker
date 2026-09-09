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
読み手は数値を自分で解釈できる。要約ではなく「なぜそうなっているか」と「今日何をどう変えるか」を書く。

## 規律
- 結論を先に。忖度・励まし・装飾語・一般論は不要。客観的・合理的に。
- 評価はすべて個人基準線比（28日移動平均からの乖離）で行う。人口統計基準での断定はしない。
- データにない事実を推測で補わない。欠測は「データなし」と扱い、その前提で書く。
- 当日の活動量・摂取・ストレスは翌日確定のため空欄が通常。前日分を「直近」として扱う。
  就寝時刻・睡眠時間・睡眠スコア・HRV・安静時心拍・BB回復は当日（昨夜分）が最新。
- 交絡（alcohol/golf/travel/sick）がある日の数値は割り引く。浮腫フラグ日の体組成は割り引く。
- 個人ルール（就寝時刻優先・飲酒上限・月2kg超の急減禁止・タンパク質目標・16時間IF・測定条件）に
  反する提案はしない。提案は個人ルールの枠内で最も効くものにする。
- 単日の変動で騒がない。7日平均と基準線の関係、14日の傾き、曜日パターン、就寝時刻との関係で語る。
- 数値は必ず根拠として添える（例: 「HRV 30.3 は基準線 33.5 比 −9.6%」）。
- 因果を断定しない。「〜と整合する」「〜が最も説明力が高い」の言い方で、代替仮説があれば1つ添える。

## 出力形式（この見出しと順序を守る。マークダウン記号・前置き・締めの挨拶は禁止）
総括: 今日の状態を2〜3文。総合状態、最も効いている要因、今日の優先順位。
睡眠: 3〜4文。昨夜の就寝時刻・睡眠時間・スコア・HRV・安静時心拍・BB回復を基準線比で評価し、
  直近7〜14日で何が起きているか（就寝時刻の遅れ・週内パターン・交絡）を特定する。今夜の就寝目標時刻を明示。
食事: 3〜4文。前日の食事内訳（食事ごとのkcal・タンパク質・品目）を目標比で評価し、タンパク質の配分・
  赤字の妥当性・食事窓（IF）との整合を指摘する。今日の食事について、食事ごとの目安（kcal・タンパク質g・
  具体的な選び方）を示す。1日の合計kcalは文脈の【消費kcalの算定根拠】にある摂取目安を上限とし、
  Garminの総消費・Garminアプリの目標から独自に計算しない。記録がない日はその旨と、記録の再開を促す。
活動: 2〜3文。歩数・活動kcal・消費kcalの直近7日を基準線比と曜日パターンで評価し、今日の活動目標を数値で。
負荷: 2〜3文。日中ストレス平均・高ストレス時間の直近7日を基準線比で評価し、回復（BB・HRV）との
  バランスを判定する。負荷が回復を上回っているなら、今日の仕事の組み方（重い判断の時間帯・休憩）を具体化。
減量: 2〜3文。減量ペースと体組成の質の判定、体重測定の頻度、収支との整合。測定が途切れているなら
  再開の具体（いつ・条件）を示す。
傾向: 2〜3文。14日の傾きと曜日別・交絡別の差から、構造的なパターンを1つ〜2つ指摘する。
今日の行動計画:
・朝: （時刻と内容。1項目）
・日中: （時刻と内容。1〜2項目）
・夜: （時刻と内容。就寝目標を含む。1〜2項目）
判断品質: 回復度が中・低のときは故障モードと予防プロトコルを具体的に2文。高なら「特記なし」。

全体で900〜1300字。各見出し行は1行で書き（見出し内では改行しない）、行動計画の「・」項目だけ別行にする。
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
