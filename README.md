# RF基準線トラッカー PWA

個人基準線比（28日移動平均からの乖離）による回復度・体組成トラッカー。
仕様の正本は `docs_requirements_v1.md`（要件定義書 v1.0・**ローカルのみ、リポジトリ非収録**）。

- 完全ローカル（IndexedDB）・外部送信ゼロ・オフライン起動対応
- AI連携なし。抽出はClaudeチャット側、本アプリはJSONインポートのみ

## 構成

```
docs/        PWA本体（ビルド不要のvanilla JS。GitHub Pagesが/docsを配信）
data/        初回投入用バックフィル等（gitignore対象・後述）
test/        受け入れ＋単体テスト（node test/acceptance.js）
```

フォルダ名が `docs/` なのはGitHub Pagesのブランチ配信仕様（root または /docs のみ）のため。

## アプリURL

https://fugangliang.github.io/rf-tracker/

iPhone Safariで開く → 共有 → 「ホーム画面に追加」→ standalone起動。

## ローカル起動

```sh
cd docs && python3 -m http.server 8000
# → http://localhost:8000
```

Service Workerとmanifestは http(s) 経由でのみ有効（file:// 不可）。

## データ保護（重要）

以下は個人健康データのため **.gitignore済み＝リポジトリに含めない**（公開リポジトリのため）:

- `data/`（バックフィル・日次実測値）
- `docs_requirements_v1.md`（個人プロファイル・実測値を含む要件定義書）

アプリ本体はデータを一切含まず、データは端末のIndexedDBのみに存在する。
バックフィルは初回にインポート画面へ手動ペーストで投入する。

## 初回データ投入（受け入れ手順）

1. `data/backfill_import.json` の内容をインポートタブにペースト→取込（178件）
2. `data/daily_20260707-08.json` の内容を取込（2件）
3. 確認: 保全タブで総エントリ数180 / 状態タブで基準線比の実値表示 /
   エクスポート→再取込で完全一致

## テスト

```sh
node test/acceptance.js
```

受け入れ基準（要件§7）＋コアロジック単体検証（基準線窓・回復度しきい値・golf緩和・
浮腫シグネチャ・バリデーション・気分トラック）計34項目。
`data/` が無い環境では受け入れ部分をスキップし単体検証のみ実行する。

## 日次運用

Garmin/オムロンのスクショをClaudeチャットに貼付 → JSONを受け取る →
ホーム画面アイコン → 取込タブ → ペースト → 取込（4タップ以内）。
週1回、保全タブからエクスポート（7日超過でヘッダーに警告バッジ）。

## デプロイ

`main` にpush → GitHub Pages（/docs）に自動反映。
`docs/sw.js` の `VERSION` を上げるとクライアント側キャッシュが更新される。
