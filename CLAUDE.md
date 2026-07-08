# CLAUDE.md — RF基準線トラッカーPWA

## ステータス

**運用フェーズ**（2026-07-08 受け入れ完了・アーティファクト版は廃止済み）。
正本はPWAのIndexedDB＋週次エクスポートファイル。

- アプリURL: https://fugangliang.github.io/rf-tracker/
- リポジトリ: https://github.com/fugangliang/rf-tracker（public）

## 不変の決定事項

- **仕様の正は `docs_requirements_v1.md`（ローカルのみ・push禁止）。コアロジック（§4: 28日基準線・回復度判定・golf緩和・気分トラック・浮腫検出）は変更禁止**
- **`data/`・`docs_requirements_v1.md` は個人健康データのためpush厳禁**（.gitignore済み。公開リポジトリである）。公開履歴にも個人データなし（push前に履歴再構成済み）——これを維持する
- インポートJSONスキーマは変更禁止（旧 deep/water キーは無視して受理）
- PWA本体は `docs/`（GitHub Pagesブランチ配信 main:/docs の制約による命名）。ビルド不要のvanilla JS

## 変更・デプロイ手順

1. `docs/` を編集 → `node test/acceptance.js`（34項目、data/があれば受け入れ含む）
2. **`docs/sw.js` の `VERSION` を上げる**（忘れるとクライアントのキャッシュが更新されない）
3. commit → push → Pagesに自動反映（約15秒）
- ghトークンに workflow スコープなし。`.github/workflows/` はpush不可（ブランチ配信を採用した理由）

## 運用

- 日次: スクショ→Claudeチャットで抽出→JSONを取込タブにペースト
- 週次: 保全タブからエクスポート → `data/exports/` に保存（7日超過でアプリに警告バッジ）

## 要確認（未決）

- 主観-客観乖離フラグの「基準以下/良好」は厳密な大小（mood < / > 基準線平均）で実装。
  現行アーティファクト版v1.2の実装と同一かは未照合 `[要確認]`
- golf緩和は実装・合成データ検証済みだが、実データではまだ非発動（2026-07-08は緩和前判定が「高」）
