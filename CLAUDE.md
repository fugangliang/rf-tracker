# CLAUDE.md — RF基準線トラッカーPWA

## ステータス（2026-07-16時点）

**運用フェーズ・v1.1**（受け入れ完了→アーティファクト版廃止→状態ヘッダー強化まで完了）。
正本は「iPhoneホーム画面版のIndexedDB」＋週次エクスポートファイル。

- アプリURL: https://fugangliang.github.io/rf-tracker/
- リポジトリ: https://github.com/fugangliang/rf-tracker（public）
- claude.ai抽出プロジェクト: 立ち上げ済み（カスタム指示= `EXTRACTION_PROMPT.md`）
- 週次エクスポートの保管先: `data/exports/`（初回分 2026-07-08 保存済み）
- 2026-07-16: 睡眠CSV（7/10〜7/16）から `data/daily_20260710-16.json` を生成し
  AirDropでRFに引き渡し（hrvは全件null。下記「Garmin書き出しCSV」節参照）

### 最優先（2026-07-29中断時点・iCloud同期復旧の途中）

birdの同期DBが7/27 16:38（iCloud Drive初有効化の瞬間）に破損し、Mac→iCloudの
アップロードが全停止中（`brctl dump` の corrupted_db_info で確認済み。quota・ネットは正常）。
iPhoneはトラッカーJSONの新版・日報HTML新版を受け取れない状態。復旧手順の途中で中断:

1. RFがTerminal.appにフルディスクアクセス（FDA）を付与 →
   `killall bird` → `mv ~/Library/Application\ Support/CloudDocs ~/Library/Application\ Support/CloudDocs.broken-20260729`
2. bird再構築後の確認（Claude担当）: `brctl dump | grep corrupted` が消えること →
   `brctl evict`→再DL のラウンドトリップで配信ファイルの実アップロードを確認
3. iPhoneで `garmin_20260729.json`（7/29の1件入り）が見え、アプリ「ファイルから取込」→取込1件→総194件
4. **作業完了後、TerminalのFDAをオフに戻すようRFにリマインドする（約束済み）**
5. 復旧不能なら代替案B＝iMessage自分宛て自動配信（構築5分・RF合意済みの選択肢）に切替

### セッション再開時の確認事項（RF側の未確認2点＋繰越）

1. iPhoneホーム画面版でv1.1表示（総合状態・信号チップ・コメント）が反映されたか
2. 保全タブで目標体重を設定したか（未設定だと体重コメントに目標差が出ない）
3. moodのn≥7到達後（7/14頃〜）、主観-客観乖離フラグの挙動に違和感がないか →「要確認（未決）」参照
4. `daily_20260710-16.json` をiPhoneで取込済みか（保全タブで総エントリ数を確認）
5. 7/10〜7/16の夜間HRVが未投入。APIで取得可能になったが、再取込は当該日のmood・weightを
   消すため実施保留（RFがmood再入力を許容するなら7日分の完全JSONを生成できる）`[要確認]`
6. ~~7/9のデータ欠落~~ → 2026-07-27解消: `data/import/daily_gap_20260709-0720.json`
   （7/9・7/17〜20の5日分・HRV含む）を生成済み。iPhoneでの取込待ち
8. ~~欠落分の取込~~ → 2026-07-29解消: 7/9〜7/28の13件はiPhone取込済み（RF確認済み・総193件）。
   7/29の1件は `garmin_20260729.json` で取込待ち→完了したか要確認
9. （2026-07-29新規）MacのiCloud Drive同期を7/27に初有効化した。それまで
   `~/Library/Mobile Documents/com~apple~CloudDocs/` はローカル専用の張りぼてで、
   有効化時にクラウド実体へ置換され旧ローカル配置物（rf-tracker・日報）は消えた→両方復元済み。
   日報ビューアのiPhone閲覧（94_日報自動化）はこの有効化により初めて機能するようになった
7. `docs/healthcare_baseline_doc_v1.md`・`docs/healthcare_v2_instructions.md`（未追跡）が
   公開配信対象の `docs/` 直下にある。個人情報を含むならpush前に `data/` 等へ移動 `[要確認]`

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

## 運用ルール（2026-07-08確定）

### 正本の一本化（最重要）

- **正本は「iPhoneホーム画面版アプリ」のIndexedDB＋週次エクスポートファイルの2つだけ**
- 取込・手入力は**常にホーム画面アイコンから**行う。iOSはホーム画面版とSafariタブ版でストレージが別。
  Safariタブ・Macブラウザで開いた画面には入力しない（入力しても正本に反映されない）
- クラウド同期はない（仕様§8）。端末間の受け渡しはエクスポート→取込が唯一の手段

### 日次（毎朝・スマホ完結）

0. （初回のみ・**2026-07-08実施済み**）claude.aiに専用プロジェクトを作成し、
   `EXTRACTION_PROMPT.md` の内容をカスタム指示に登録する。
   通常チャットは過去のやりとりを認識しないため、抽出ルールはプロジェクトに常駐させる
1. Garmin／オムロンのスクショを**そのプロジェクト内の新規チャット**に貼付 → JSONが返る
2. JSONをコピー → ホーム画面のトラッカー → 取込タブ → ペースト → 取込
3. 状態ヘッダーを確認。必要なら「全文コピー」でレーンAに携行
4. 気分（1〜5）など機器にないデータは記録タブで手入力（同一日付は上書き＝追記ではない点に注意）

### 週次（バックアップ）

1. 「要バックアップ」バッジが出たら（＝前回から7日超過）、保全タブからエクスポート
2. iPhoneのファイルApp「ダウンロード」に保存される → iCloud Drive/AirDropでMacへ →
   `~/Documents/rf-tracker/data/exports/` に移動（Time Machine対象・push対象外）

### Garmin書き出しCSVからの一括取込（2026-07-16確定）

- **`data/` のフォルダ構成（2026-07-27確定）**: DLしたCSV（睡眠・HRVステータス・体組成等）→ `data/input/`
  （日付付きにリネーム。例: `睡眠260727.csv`）、アプリに取り込むJSON（backfill・daily追補・omron）→ `data/import/`、
  週次エクスポート → `data/exports/`。`data/` 直下にファイルを置かない。`data/` ごとgitignore済みのためpush対象外
- 「睡眠」CSVの列マッピング: スコア→sleep、安静時心拍→rhr、Body Battery→bb
- **「睡眠」CSVの「HRVステータス」列は7日平均であり、夜間HRV（hrv）には使えない**
  （2026-06-28で検証: 睡眠CSV=35、HRVステータスCSVの夜間HRV=32・7日平均=35。backfillは32を採用）。
  hrvは「HRVステータス」CSV（夜間HRV列、日付は「7月 6日」形式）から取る。無ければ null
- 取込は同一日付を**丸ごと置換**する（IndexedDB put）。既に日次取込済みの日付に
  null入りJSONを再取込すると mood・weight 等が消えるため、未取込の日付だけ取り込む

### Garmin自動取得（2026-07-27構築・07-29確定＝仕様§8変更なし）

- 構成: `scripts/garmin_fetch.py`（venv: `.venv/`・非公式`garminconnect`ライブラリ）を
  launchd（`scripts/com.rf.rf-tracker.garmin.plist`→`~/Library/LaunchAgents/`）で毎朝9:30に実行
  → sleep/rhr/bb/hrv を取得し `data/import/auto_daily_latest.json`（ローカル控え・固定名）と
  iCloud Drive `rf-tracker/garmin_YYYYMMDD.json`（日付付き・旧日分は自動削除で常に1本）に出力
- iPhone側（v1.2.0〜）: アプリ取込タブ →「ファイルから取込」→ iCloud Drive → rf-tracker →
  当日のJSONを選択（選択と同時に取込まで実行される）
- **iOSショートカット方式は3案とも不安定（ブックマーク失敗・Shortcutsフォルダ同期不達・
  クリップボード空）のため2026-07-29に廃止**。iCloud配信ファイル名を日付付きにしたのは
  iOSのピッカーが固定名の古い版を掴む事故の構造的排除のため
- **重複取込によるmood・weight消失を防ぐため、前回生成日の翌日以降だけを出力する**
  （状態: `data/auto_fetch_state.json`。`--since` 指定時は状態を進めない＝検証・欠落追補用）
- 認証: 初回のみ `scripts/garmin_auth.py` をTerminalで対話実行（トークンは `~/.garminconnect/`・
  パスワード非保存）。トークン失効時も同スクリプトで再認証
- 非公式APIのためGarmin側変更で壊れ得る。壊れたら従来のCSV運用（上節）に一時退避
- フィールドマッピングは2026-07-27に7/21〜27のCSV実績値と全フィールド突合し完全一致を確認済み。
  **CSVの「Body Battery」列の正体は起床時値ではなく睡眠中回復量（sleep APIのbodyBatteryChange）**
- 環境: venvはuv管理Python 3.12（システムPython 3.9では旧garthしか入らずSSO変更で401になる）。
  認証済み（2026-07-27）・launchd登録済み（`launchctl list | grep rf-tracker` で確認可）

### 例外時の処理

| 事象 | 処理 |
|---|---|
| iPhoneにiCloudの新ファイルが出ない／中身が古い | Mac→iCloudの同期スタック（birdが「caught-up」と偽装するタイプ・2026-07-29発生）。`killall bird` でデーモン再起動→数分で復旧。RFは「同期詰まり」とClaudeに言えばよい |
| 誤入力 | 同一日付のJSONを再取込 or 記録タブで上書き（置換される） |
| 測定条件不一致の日 | 記録タブで「基準線から除外」をON |
| 体調不良（sick） | confoundsにsickを付ければ基準線からは自動除外 |
| 機種変更・復元 | 最新エクスポートを新端末で取込。目標体重（端末ローカル設定）は保全タブで再設定 |
| データ破損疑い | 最新エクスポートと突合（Claude Codeに「エクスポートを検証」と依頼） |

### アプリの変更・改修

- Claude workspace から「トラッカー」で指示（ルーティング表参照）。仕様§4のコアロジックは変更禁止
- デプロイ手順は上記「変更・デプロイ手順」節（sw.js VERSION上げ忘れ注意）
- `data/`・要件定義書・エクスポートファイルはpush厳禁（公開リポジトリ）

## v1.1 表示レイヤー（2026-07-08追加・コアロジック§4は不変更）

- 総合状態: **不調**=回復度（golf緩和後）が中/低、**好調**=回復度高・3指標全青・平均乖離≥+5%、**平常**=その他、基準構築中=判定保留
- 信号: 青 >−10% / 黄 ≤−10% / 赤 ≤−20%（回復度しきい値と同一）。安静時心拍は反転で 黄≥+5% / 赤≥+10%
- 状態評価コメント（体調・体重・体脂肪率）: ルールベース決定的生成。推移は直近28日平均vs前28日平均（各窓n≥5）
- 目標体重は端末ローカル設定（保全タブ→IndexedDB meta）。**公開ソースに個人値を埋め込まない**
- 基準線n表示は n=X/28（28日窓中の有効記録数。全履歴を使わないのは§4.1の移動基準線設計による）

## 要確認（未決）

- 主観-客観乖離フラグの「基準以下/良好」は厳密な大小（mood < / > 基準線平均）で実装。
  現行アーティファクト版v1.2の実装と同一かは未照合 `[要確認]`
- golf緩和は実装・合成データ検証済みだが、実データではまだ非発動（2026-07-08は緩和前判定が「高」）
