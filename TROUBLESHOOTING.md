# TROUBLESHOOTING - 困ったときに読むページ

困ったらまずログを確認してください:

```bash
docker compose logs --tail 100 dn-engine
```

エラーメッセージに応じた対処を以下にまとめます。

---

## bot が起動しない

### `環境変数 XXX が設定されていません`

`.env` ファイルの該当項目が空です。
`.env.example` と見比べて全 6 項目が埋まっているか確認してください。

```bash
grep -v '^#' .env | grep '='
```

で `=` の右が空のものがないかチェック。

### `Cannot connect to Docker daemon`

Docker Desktop が起動していません。

- Mac: アプリケーションから Docker.app を起動
- Windows: スタートメニューから Docker Desktop
- Linux: `sudo systemctl start docker`

### `docker compose up` で build が長時間進まない

初回のイメージビルドは 3-5 分かかるのが普通です。

5 分以上動きがないなら:
1. `Ctrl+C` で中断
2. `docker compose down --rmi all` でイメージを削除
3. `docker compose up -d` で再試行
4. それでもダメなら `docker system prune -a` で Docker のキャッシュをクリア

---

## API 認証エラー

### `UNAUTHORIZED` / `Invalid signature`

API キーのコピペミスが最も多いです。以下を確認:

- `0x` プレフィックスが抜けていないか（HL Private Key / Stark 系は `0x` 始まり）
- 前後に空白・改行が入っていないか
- 大文字小文字を間違えていないか

### `API Wallet not authorized`（Hyperliquid）

API Wallet の発行後に「Authorize」ボタンを押し忘れているケースです。
https://app.hyperliquid.xyz/API を開き、リストに作成した API Wallet が
載っているか確認してください。

### `Invalid vault id` / `Account not found`（Extended）

サブアカウントの Vault ID を正しくコピーできていない可能性があります。
Extended の設定 → API 画面に表示される数字をそのまま `.env` に貼ってください。

---

## エントリーが発生しない

### ログには候補が出るのにエントリーしない

以下の理由が考えられます:

- `DRY_RUN=true` のまま → 実注文はスキップされます
- FR スプレッドが閾値（0.025%）に達していない → 現在の市場状況次第
- 候補がホワイトリスト外 → 現行 WL は 35 銘柄、それ以外はスキップ
- 並行上限に達している → 最大 3 ペア保有中は新規エントリーなし
- 証拠金不足 → 各取引所の `availableBalance` が $100 を下回っていると skip

### そもそも候補がゼロ

```
[DN戦略] エントリー候補: 0銘柄、並行上限3銘柄、実行予定: 0銘柄
```

は正常な状態です。FR スプレッドが閾値を下回っているだけで、機会を待っている状態。
**無理にエントリーしない**のが本 bot の設計です。

---

## Docker 関連のエラー

### `port is already allocated`

別のアプリが 3000 番ポートを使っています。
`docker-compose.yml` の `ports:` 行をコメントアウトするか、他のポートに変更してください。

### コンテナが `(unhealthy)` で死ぬ

`docker compose logs` でログを確認し、起動エラーが出ていないか調べてください。
ビルド時のエラーなら、`docker compose up -d --build` で再ビルドを試みます。

### `no space left on device`

Docker のイメージ・ボリュームでディスクを使い切っています:

```bash
docker system prune -a --volumes
```

で未使用イメージを削除（**使用中のコンテナは削除されません**）。

---

## 証拠金・残高のエラー

### `insufficient margin` / `insufficient balance`

- 取引所に入金した USDC がまだ反映されていない → 5-10 分待つ
- `.env` のアドレス違い（別のアカウントを指している）→ 再確認
- 手数料で残高が減っている → 取引所 UI で残高確認

---

## ペアが `manual_review` 状態になった

`manual_review` は「自動で復旧できない状態が発生したので人間が確認してほしい」というマークです。

- 各取引所の UI でポジションの有無を確認
- 残っていれば手動でクローズ
- ポジションがない場合は起動時の自動クリーンアップで closed に切り替わります

DB を手動で編集して closed にしたい場合:

```bash
docker compose exec dn-engine node -e "
const Database = require('better-sqlite3');
const db = new Database('/app/data/dn-engine.db');
db.prepare(\"UPDATE dn_pairs SET status = 'closed', close_reason = '手動クリア' WHERE id = ?\").run(XXX);
"
```

（`XXX` をペア ID に書き換え）

---

## その他

### ログが文字化けする

Windows の PowerShell / コマンドプロンプトだと日本語ログが文字化けすることがあります:

```powershell
chcp 65001
docker compose logs -f dn-engine
```

で UTF-8 に切り替えてください。

### それでも解決しない場合

- GitHub Issues で症状を報告してください
- 以下の情報を添えると対応が早まります:
  - OS（Mac/Windows/Linux）
  - Docker のバージョン（`docker --version`）
  - `.env` を削った上で直近 50 行のログ
  - `DRY_RUN` の値

> ⚠️ **ログに API キーや秘密鍵が含まれていないか必ず確認してから投稿してください**。
