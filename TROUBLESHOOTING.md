# TROUBLESHOOTING - 困ったときに読むページ

困ったらまずログを確認してください:

```
docker compose logs --tail 100 dn-engine
```

> 💡 **🪟 Windows で日本語が文字化けする場合**: PowerShell で先に `chcp 65001` を実行してから上記コマンド。

エラーメッセージに応じた対処を以下にまとめます。

---

## bot が起動しない

### `環境変数 XXX が設定されていません`

`.env` ファイルの該当項目が空です。
`.env.example` と見比べて全 6 項目が埋まっているか確認してください。

#### 🍎 Mac / 🐧 Linux

```bash
grep -v '^#' .env | grep '='
```

#### 🪟 Windows (PowerShell)

```powershell
Get-Content .env | Select-String -NotMatch '^#' | Select-String '='
```

で `=` の右が空のものがないかチェック。

### `Cannot connect to Docker daemon`

Docker Desktop が起動していません。

* **🍎 Mac**: アプリケーションから Docker.app を起動 → メニューバーのクジラアイコンが緑になるまで待つ
* **🪟 Windows**: スタートメニューから Docker Desktop を起動 → タスクトレイ(画面右下)のクジラアイコンが緑になるまで待つ
* **🐧 Linux**: `sudo systemctl start docker`

> 🪟 Windows で「Docker Desktop is starting...」のまま進まない場合:
> - WSL2 が正しくインストールされているか確認: PowerShell で `wsl --status`
> - Docker Desktop を一度終了して再起動
> - PC の再起動

### `docker: 'compose' is not a docker command` (🪟 Windows)

古い Docker のため、コマンドを `docker-compose` (ハイフン)に置き換えてください:

```
docker-compose up -d
docker-compose logs -f dn-engine
```

または Docker Desktop を最新版にアップデート。

### `docker compose up` で build が長時間進まない

初回のイメージビルドは 3-5 分かかるのが普通です。

5 分以上動きがないなら:

1. `Ctrl+C` で中断
2. `docker compose down --rmi all` でイメージを削除
3. `docker compose up -d` で再試行
4. それでもダメなら `docker system prune -a` で Docker のキャッシュをクリア

> 🪟 Windows でビルドが極端に遅い場合:
> - **OneDrive 同期下にプロジェクトがないか確認** → OneDrive 外に移動
> - **ウイルス対策ソフトの除外設定**: Docker Desktop の Settings → Resources → File sharing で除外
> - WSL2 のメモリ不足: `C:\Users\<ユーザー名>\.wslconfig` で `memory=4GB` 等に増やす

---

## API 認証エラー

### `UNAUTHORIZED` / `Invalid signature`

API キーのコピペミスが最も多いです。以下を確認:

* `0x` プレフィックスが抜けていないか(HL Private Key / Stark 系は `0x` 始まり)
* 前後に空白・改行が入っていないか
* 大文字小文字を間違えていないか
* **🪟 Windows メモ帳で保存した場合**: 文字コードが UTF-8 BOM 付きになっていないか
  → 名前を付けて保存 → エンコードを「UTF-8」(BOM なし)で保存し直し
  → またはVS Code / Notepad++ で開き直して保存

### `API Wallet not authorized` (Hyperliquid)

API Wallet の発行後に「Authorize」ボタンを押し忘れているケースです。
<https://app.hyperliquid.xyz/API> を開き、リストに作成した API Wallet が
載っているか確認してください。

### `Invalid vault id` / `Account not found` (Extended)

サブアカウントの Vault ID を正しくコピーできていない可能性があります。
Extended の設定 → API 画面に表示される数字をそのまま `.env` に貼ってください。

---

## エントリーが発生しない

### ログには候補が出るのにエントリーしない

以下の理由が考えられます:

* `DRY_RUN=true` のまま → 実注文はスキップされます
* FR スプレッドが閾値(0.015%)に達していない → 現在の市場状況次第
* 候補がホワイトリスト外 → 現行 WL は 35 銘柄、それ以外はスキップ
* 並行上限に達している → 最大 3 ペア保有中は新規エントリーなし
* 証拠金不足 → 各取引所の `availableBalance` が $100 を下回っていると skip

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

```
docker system prune -a --volumes
```

で未使用イメージを削除(**使用中のコンテナは削除されません**)。

### 🪟 Windows: WSL2 のメモリを大量消費する

WSL2 はデフォルトで PC の物理メモリの最大 50% を確保します。
制限したい場合は `C:\Users\<ユーザー名>\.wslconfig` を作成:

```
[wsl2]
memory=4GB
processors=2
swap=2GB
```

作成後、PowerShell で WSL を再起動:

```powershell
wsl --shutdown
```

その後 Docker Desktop を再起動。

### 🪟 Windows: パス長エラー (260 文字制限)

Windows のパス長制限(260 文字)に引っかかった場合は、プロジェクトを浅い階層に移動してください
(例: `C:\dev\delta-neutral-bot`)。

---

## 証拠金・残高のエラー

### `insufficient margin` / `insufficient balance`

* 取引所に入金した USDC がまだ反映されていない → 5-10 分待つ
* `.env` のアドレス違い(別のアカウントを指している)→ 再確認
* 手数料で残高が減っている → 取引所 UI で残高確認

---

## ペアが `manual_review` 状態になった

`manual_review` は「自動で復旧できない状態が発生したので人間が確認してほしい」というマークです。

* 各取引所の UI でポジションの有無を確認
* 残っていれば手動でクローズ
* ポジションがない場合は起動時の自動クリーンアップで closed に切り替わります

DB を手動で編集して closed にしたい場合:

#### 🍎 Mac / 🐧 Linux

```bash
docker compose exec dn-engine node -e "
const Database = require('better-sqlite3');
const db = new Database('/app/data/dn-engine.db');
db.prepare(\"UPDATE dn_pairs SET status = 'closed', close_reason = '手動クリア' WHERE id = ?\").run(XXX);
"
```

#### 🪟 Windows (PowerShell)

```powershell
docker compose exec dn-engine node -e "const Database = require('better-sqlite3'); const db = new Database('/app/data/dn-engine.db'); db.prepare(\`\"UPDATE dn_pairs SET status = 'closed', close_reason = '手動クリア' WHERE id = ?\`\").run(XXX);"
```

(`XXX` をペア ID に書き換え)

---

## OS 別の特殊な問題

### 🪟 Windows: 改行コード問題

Windows の改行コード(CRLF)で `.env` を保存すると、ごく稀に Docker 側で値の末尾に改行が混入することがあります。

症状: API 認証エラーが取れない、値が正しいはずなのに失敗する

対処:

```powershell
# PowerShell で改行コードを LF に変換
(Get-Content .env -Raw) -replace "`r`n", "`n" | Set-Content .env -NoNewline
```

または VS Code で `.env` を開き、右下の `CRLF` をクリック → `LF` に変更 → 保存。

### 🪟 Windows: Docker Desktop が突然落ちる

* WSL2 のメモリ不足が原因のことが多い → `.wslconfig` で memory 増設
* Hyper-V と WSL2 の競合 → BIOS で仮想化機能(VT-x / SVM)が有効か確認
* それでもダメなら Docker Desktop を完全アンインストール → WSL リセット (`wsl --unregister Ubuntu`) → 再インストール

### 🍎 Mac: M1/M2/M3/M4 で ARM 警告

```
WARNING: The requested image's platform (linux/amd64) does not match the detected host platform (linux/arm64/v8)
```

警告は出ますが動作に問題はありません。気になる場合は `docker-compose.yml` の各サービスに `platform: linux/amd64` を追加。

### 🐧 Linux: `permission denied` エラー

```bash
sudo usermod -aG docker $USER
# ログアウト & 再ログイン
```

または都度 `sudo` を付けて実行。

---

## その他

### ログが文字化けする

#### 🪟 Windows PowerShell / コマンドプロンプト

```powershell
chcp 65001
docker compose logs -f dn-engine
```

で UTF-8 に切り替えてください。永続化したい場合は PowerShell プロファイルに追加:

```powershell
notepad $PROFILE
# 開いたファイルに以下を追記して保存
chcp 65001 | Out-Null
```

#### 🍎 Mac / 🐧 Linux

通常は文字化けしません。発生する場合はターミナルの文字コード設定を UTF-8 に。

### git pull が失敗する

ローカルで `.env` 等を編集していると pull に失敗することがあります:

```bash
git stash
git pull
git stash pop
```

または `.env` だけは `.gitignore` 済みなので、他のファイルを変更していなければ通常通り pull できます。

### それでも解決しない場合

* GitHub Issues で症状を報告してください
* 以下の情報を添えると対応が早まります:
  + OS (Mac/Windows/Linux、Windows ならバージョン)
  + Docker のバージョン (`docker --version`)
  + `.env` を削った上で直近 50 行のログ
  + `DRY_RUN` の値
  + 🪟 Windows なら: PowerShell or コマンドプロンプトのどちらを使ったか

> ⚠️ **ログに API キーや秘密鍵が含まれていないか必ず確認してから投稿してください**。
