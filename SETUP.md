# SETUP - 初めての方向け完全セットアップガイド

所要時間の目安: **約 60-90 分**（取引所口座作成と入金の待ち時間を含む）

---

## 全体の流れ

1. 両取引所の口座を作る & 入金する
2. 両取引所で API キーを発行する
3. Docker Desktop を入れる
4. この bot を clone する
5. `.env` ファイルに API キーを書き込む
6. `DRY_RUN=true` で動作確認
7. `DRY_RUN=false` に変えて本番起動

---

## 1. Hyperliquid の口座開設と API キー取得

### 1-1. アカウント作成

1. https://app.hyperliquid.xyz にアクセス
2. 右上の「Connect」ボタンから MetaMask 等の EVM ウォレットを接続
3. 初回は「Enable Trading」で Approve ボタンを押してトレーディング有効化
4. `Deposit` から USDC を入金（推奨 $500 以上、Arbitrum / Ethereum メインネット対応）

### 1-2. API Wallet の作成

Hyperliquid は、メインのウォレット秘密鍵を bot に渡さずに済むよう、
「API Wallet（エージェントウォレット）」を別途発行する仕組みです。

1. https://app.hyperliquid.xyz/API にアクセス
2. 「Generate」ボタンをクリック
3. 表示された以下 2 つをメモしておきます（あとで `.env` に貼り付け）:
   - **API Wallet Address** (0x... 42 文字)
   - **API Wallet Private Key** (0x... 66 文字)
4. 「Authorize」ボタンで API Wallet をメインウォレットに紐付け

> ⚠️ API Wallet Private Key は他人に絶対に見せないでください。
> 発行時の 1 回しか表示されないので、安全な場所にメモしてください。

---

## 2. Extended (x10) の口座開設と API キー取得

### 2-1. アカウント作成 + 入金

1. https://app.extended.exchange/ にアクセス
2. 「Connect Wallet」で EVM ウォレット or Starknet ウォレットを接続
3. 画面の指示に従ってアカウント登録とサブアカウント作成
4. `Deposit` から USDC を入金（推奨 $500 以上）

### 2-2. API キー発行

1. 右上のアイコン → `Settings` → `API`
2. `Create API Key` をクリック
3. 表示される以下 4 項目をメモ:
   - **API Key** (英数字の長い文字列)
   - **Stark Private Key** (0x... 66 文字)
   - **Stark Public Key** (0x... 66 文字)
   - **Vault ID** (数字)

> ⚠️ Stark Private Key はこの画面を閉じると**二度と見られません**。
> 必ずメモしてください。

---

## 3. Docker Desktop のインストール

既にインストール済みの場合はスキップしてください。

### Mac

1. https://docs.docker.com/desktop/install/mac-install/ からダウンロード
2. `.dmg` をダブルクリック → Applications にドラッグ
3. Docker Desktop を起動（初回はチュートリアルが出ますが Skip で OK）

### Windows

1. https://docs.docker.com/desktop/install/windows-install/ からダウンロード
2. WSL 2 のインストールを求められたら指示に従ってインストール
3. 再起動後、Docker Desktop を起動

### Linux

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# 一度ログアウト & ログインし直し
```

### インストール確認

ターミナル（Windows は PowerShell）で以下を実行:

```bash
docker --version
docker compose version
```

どちらもバージョンが表示されれば OK。

---

## 4. bot のダウンロード

ターミナルで以下を実行（任意のディレクトリで OK）:

```bash
git clone https://github.com/Akira-bluemountain/delta-neutral-bot.git
cd delta-neutral-bot
```

> git がインストールされていない場合:
> - Mac: `brew install git` または Xcode Command Line Tools (`xcode-select --install`)
> - Windows: https://git-scm.com/download/win からダウンロード
> - Linux: `sudo apt install git` など

---

## 5. `.env` ファイルの作成

```bash
cp .env.example .env
```

`.env` をテキストエディタで開き、先ほどメモした 6 項目を入力します:

```env
HL_API_WALLET_ADDRESS=0xあなたのアドレス
HL_API_WALLET_PRIVATE_KEY=0xあなたの秘密鍵

EXTENDED_API_KEY=あなたのAPIキー
EXTENDED_STARK_PRIVATE_KEY=0xあなたのStark秘密鍵
EXTENDED_STARK_PUBLIC_KEY=0xあなたのStark公開鍵
EXTENDED_VAULT_ID=あなたのVaultID

DRY_RUN=true
```

> ⚠️ `DRY_RUN=true` のまま保存してください。最初は必ずシミュレーションで動作確認します。

---

## 6. 起動（DRY_RUN モード）

```bash
docker compose up -d
```

初回はイメージのビルドで 3-5 分かかります。

起動後、ログを確認:

```bash
docker compose logs -f dn-engine
```

### 正常起動の目印

以下のような出力が見えれば OK:

```
[DB] 初期化完了: ./data/dn-engine.db
[DN戦略] ドライラン: ON（注文なし）
[リスク] 初期エクイティ設定: $XXXX
  hyperliquid: $XXXX 証拠金0.0% ポジ0件
  extended: $XXXX 証拠金0.0% ポジ0件
[スクリーニング] FR閾値通過: XX銘柄 / 230銘柄 (ホワイトリスト 35銘柄中 X銘柄が閾値通過)
[DN戦略] エントリー候補: X銘柄、並行上限3銘柄、実行予定: X銘柄
[DN戦略] サイクル完了
```

ログ確認を終えるには `Ctrl+C`。bot はバックグラウンドで動き続けます。

### よくある初回エラー

- `環境変数 HL_API_WALLET_ADDRESS が設定されていません`
  → `.env` のスペルと `=` の後に値が入っているか確認
- `Cannot connect to Docker daemon`
  → Docker Desktop が起動していることを確認
- 残高が $0 と表示される
  → API キーの権限、取引所への入金が反映されているか確認

---

## 7. 本番モードへの切り替え

ログで以下を確認してから本番モードに移ります:

- [x] 両取引所の残高が正しく取得できている
- [x] 起動から 5 分以上、エラーなく稼働している
- [x] スクリーニングが実行され、候補評価のログが出力されている

問題なければ `.env` を再度編集して本番モードへ:

```diff
- DRY_RUN=true
+ DRY_RUN=false
```

再起動:

```bash
docker compose restart
```

ログを確認し、`[DN戦略] ドライラン: OFF（実注文）` と
`モード: 本番（実注文あり）` が表示されれば本番稼働中です。

---

## 運用コマンド

| 操作 | コマンド |
|:---|:---|
| ログ閲覧（リアルタイム） | `docker compose logs -f dn-engine` |
| ログ閲覧（直近 100 行） | `docker compose logs --tail 100 dn-engine` |
| 停止 | `docker compose stop` |
| 再開 | `docker compose start` |
| 完全停止（コンテナ削除） | `docker compose down` |
| アップデート | `git pull && docker compose up -d --build` |

---

## 止めるときの注意

- `docker compose stop` は bot を止めるだけで、**取引所で保有中のポジションはそのまま残ります**
- ポジションを手動でクローズしたい場合は、各取引所の UI から直接決済してください
- その後 bot を再起動すると、取引所の残存ポジションと DB の不整合を検知して
  自動で arrangement してくれます（reconcile 機能）

---

## 次のステップ

- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — うまく動かないときの対処
- [DISCLAIMER.md](DISCLAIMER.md) — 必ず読んでほしいリスク説明
- [README.md](README.md) - 概要に戻る
