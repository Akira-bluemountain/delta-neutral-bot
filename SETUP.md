# SETUP - 初めての方向け完全セットアップガイド

所要時間の目安: **約 60-90 分**(取引所口座作成と入金の待ち時間を含む)

> 💡 **このガイドは Mac / Windows / Linux すべてに対応しています**。
> OS によって手順が違う箇所は **🍎 Mac** / **🪟 Windows** / **🐧 Linux** のラベルで分けて説明します。

---

## 全体の流れ

1. 両取引所の口座を作る & 入金する
2. 両取引所で API キーを発行する
3. Docker Desktop を入れる
4. ターミナル(または PowerShell)を開く
5. この bot を clone する
6. `.env` ファイルに API キーを書き込む
7. `DRY_RUN=true` で動作確認
8. `DRY_RUN=false` に変えて本番起動

---

## 1. Hyperliquid の口座開設と API キー取得

### 1-1. アカウント作成

1. <https://app.hyperliquid.xyz> にアクセス
2. 右上の「Connect」ボタンから MetaMask 等の EVM ウォレットを接続
3. 初回は「Enable Trading」で Approve ボタンを押してトレーディング有効化
4. `Deposit` から USDC を入金(推奨 $500 以上、Arbitrum / Ethereum メインネット対応)

### 1-2. API Wallet の作成

Hyperliquid は、メインのウォレット秘密鍵を bot に渡さずに済むよう、
「API Wallet(エージェントウォレット)」を別途発行する仕組みです。

1. <https://app.hyperliquid.xyz/API> にアクセス
2. 「Generate」ボタンをクリック
3. 表示された以下 2 つをメモしておきます(あとで `.env` に貼り付け):
   * **API Wallet Address** (0x... 42 文字)
   * **API Wallet Private Key** (0x... 66 文字)
4. 「Authorize」ボタンで API Wallet をメインウォレットに紐付け

> ⚠️ API Wallet Private Key は他人に絶対に見せないでください。
> 発行時の 1 回しか表示されないので、安全な場所にメモしてください。

---

## 2. Extended (x10) の口座開設と API キー取得

### 2-1. アカウント作成 + 入金

1. <https://app.extended.exchange/> にアクセス
2. 「Connect Wallet」で EVM ウォレット or Starknet ウォレットを接続
3. 画面の指示に従ってアカウント登録とサブアカウント作成
4. `Deposit` から USDC を入金(推奨 $500 以上)

### 2-2. API キー発行

1. 右上のアイコン → `Settings` → `API`
2. `Create API Key` をクリック
3. 表示される以下 4 項目をメモ:
   * **API Key** (英数字の長い文字列)
   * **Stark Private Key** (0x... 66 文字)
   * **Stark Public Key** (0x... 66 文字)
   * **Vault ID** (数字)

> ⚠️ Stark Private Key はこの画面を閉じると**二度と見られません**。
> 必ずメモしてください。

---

## 3. Docker Desktop のインストール

既にインストール済みの場合はスキップしてください。

### 🍎 Mac

1. <https://docs.docker.com/desktop/install/mac-install/> からダウンロード
   * Apple Silicon (M1/M2/M3/M4) → 「Mac with Apple chip」を選ぶ
   * Intel Mac → 「Mac with Intel chip」を選ぶ
2. `.dmg` をダブルクリック → Applications にドラッグ
3. Docker Desktop を起動(初回はチュートリアルが出ますが Skip で OK)
4. メニューバーのクジラアイコンが緑(Running)になれば OK

### 🪟 Windows

> **重要**: Windows 10/11 64bit が必要です。Home エディションでも動きます。

#### 事前準備: WSL2 のインストール

スタートメニューで「PowerShell」を検索 → 右クリック → **「管理者として実行」** で開いて、以下を実行:

```powershell
wsl --install
```

完了後、PC を再起動してください。

#### Docker Desktop インストール

1. <https://docs.docker.com/desktop/install/windows-install/> から「Docker Desktop for Windows」をダウンロード
2. `Docker Desktop Installer.exe` をダブルクリック
3. インストールウィザードで「Use WSL 2 instead of Hyper-V」にチェックが入った状態のまま「OK」
4. インストール完了後、PC を再起動
5. スタートメニューから「Docker Desktop」を起動
6. 利用規約に同意 → サインアップはスキップ可
7. タスクトレイ(画面右下)のクジラアイコンが緑(Running)になれば OK

> ⚠️ **会社 PC や VPN 環境**だとファイアウォールでブロックされる場合があります。
> その場合は IT 管理者に相談してください。

#### Windows ユーザー向けの注意点

* **OneDrive 配下にファイルを置かない**
  「ドキュメント」「デスクトップ」が OneDrive 同期下にあると、Docker のボリュームマウントで問題が起きます。
  → `C:\Users\<ユーザー名>\Projects\` のように OneDrive 外にフォルダを作ってください。
* **日本語フォルダ名を避ける**
  「ドキュメント」「デスクトップ」など日本語名フォルダ配下では一部ツールで問題が起きます。
  → 英数字だけのパス(例: `C:\dev\`)を使ってください。
* **ウイルス対策ソフトの除外設定**
  Docker のボリュームを Windows Defender がスキャンすると非常に遅くなります。
  Docker Desktop の Settings → Resources → File sharing で除外設定可能。

### 🐧 Linux

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# 一度ログアウト & ログインし直し
```

### インストール確認(全 OS 共通)

ターミナルを開いて(次セクション参照)以下を実行:

```
docker --version
docker compose version
```

どちらもバージョン番号が表示されれば OK。

> 💡 **古い Docker の場合**: `docker compose` (スペース) ではなく `docker-compose` (ハイフン) と表示されることがあります。
> その場合は本ガイドの `docker compose` を `docker-compose` に置き換えて読んでください。

---

## 4. ターミナルを開く

このあとの作業はすべて「ターミナル」(コマンドを入力する画面)で行います。OS によって名前と開き方が違います。

### 🍎 Mac

* **Spotlight** で検索: `Cmd + Space` → 「ターミナル」と入力 → Enter
* または `アプリケーション` → `ユーティリティ` → `ターミナル.app`

### 🪟 Windows

**PowerShell** を使います(コマンドプロンプトではなく PowerShell 推奨):

* **スタートメニュー** で `PowerShell` と検索 → クリック
* または `Win + X` キー → `Windows PowerShell` を選択
* Windows 11 なら「ターミナル」(Windows Terminal) でも OK

> ⚠️ **「コマンドプロンプト」(cmd.exe) ではなく PowerShell を使ってください**。
> 日本語ログがきれいに表示されます。

### 🐧 Linux

ディストリビューションのターミナルアプリ (GNOME Terminal / Konsole 等)を開いてください。

---

## 5. bot のダウンロード

ターミナルで作業フォルダに移動してから clone します。

### 🍎 Mac / 🐧 Linux

```bash
# ホームディレクトリ配下に Projects フォルダを作って移動(任意)
mkdir -p ~/Projects && cd ~/Projects

# clone
git clone https://github.com/Akira-bluemountain/delta-neutral-bot.git
cd delta-neutral-bot
```

### 🪟 Windows (PowerShell)

```powershell
# C:\dev に作業フォルダを作って移動(OneDrive 外がおすすめ)
mkdir C:\dev -Force
cd C:\dev

# clone
git clone https://github.com/Akira-bluemountain/delta-neutral-bot.git
cd delta-neutral-bot
```

### git がインストールされていない場合

* **🍎 Mac**: `brew install git` または Xcode Command Line Tools (`xcode-select --install`)
* **🪟 Windows**: <https://git-scm.com/download/win> から Git for Windows をダウンロード&インストール
  * インストール時の選択肢は基本デフォルトで OK
  * 「Adjusting your PATH environment」では `Git from the command line and also from 3rd-party software` を選ぶ
  * インストール後、**PowerShell を一度閉じて再度開いて**から `git --version` を確認
* **🐧 Linux**: `sudo apt install git` (Ubuntu/Debian) など

---

## 6. `.env` ファイルの作成

### コピーコマンド

#### 🍎 Mac / 🐧 Linux

```bash
cp .env.example .env
```

#### 🪟 Windows (PowerShell)

```powershell
Copy-Item .env.example .env
```

> 💡 コマンドプロンプト (cmd.exe) を使っている場合は `copy .env.example .env`

### `.env` をエディタで開く

#### 🍎 Mac

```bash
# VS Code がある人
code .env

# それ以外
open -a TextEdit .env
```

#### 🪟 Windows

```powershell
# VS Code がある人(おすすめ)
code .env

# メモ帳で開く
notepad .env
```

> ⚠️ **🪟 Windows のメモ帳の注意**:
> - **保存時の文字コードは「UTF-8」(BOM なし)** を選ぶこと
>   (ファイル → 名前を付けて保存 → 下部の「エンコード」で「UTF-8」を選択)
> - 改行コードは「LF」「CRLF」どちらでも動きますが、推奨は LF
> - **可能なら VS Code か Notepad++ を使う方が安全**(これらは UTF-8 LF がデフォルト)
> - VS Code 無料: <https://code.visualstudio.com/>
> - Notepad++ 無料: <https://notepad-plus-plus.org/>

#### 🐧 Linux

```bash
nano .env  # または vi .env
```

### 入力する項目

エディタで開いたら、先ほどメモした 6 項目を入力します:

```
HL_API_WALLET_ADDRESS=0xあなたのアドレス
HL_API_WALLET_PRIVATE_KEY=0xあなたの秘密鍵

EXTENDED_API_KEY=あなたのAPIキー
EXTENDED_STARK_PRIVATE_KEY=0xあなたのStark秘密鍵
EXTENDED_STARK_PUBLIC_KEY=0xあなたのStark公開鍵
EXTENDED_VAULT_ID=あなたのVaultID

DRY_RUN=true
```

> ⚠️ **入力時の注意**:
> - `=` の前後にスペースを入れない
> - 値を `"` (ダブルクォート) で囲まない
> - 行末に余計な空白を入れない
> - 各行の最後で改行する

> ⚠️ `DRY_RUN=true` のまま保存してください。最初は必ずシミュレーションで動作確認します。

---

## 7. 起動 (DRY_RUN モード)

ターミナル(PowerShell)で `delta-neutral-bot` フォルダにいることを確認してから:

```
docker compose up -d
```

初回はイメージのビルドで 3-5 分かかります。

起動後、ログを確認:

```
docker compose logs -f dn-engine
```

### 🪟 Windows で日本語が文字化けする場合

PowerShell で以下を最初に実行してから docker compose logs を打ってください:

```powershell
chcp 65001
```

これで UTF-8 表示に切り替わります。

### 正常起動の目印

以下のような出力が見えれば OK:

```
[DB] 初期化完了: ./data/dn-engine.db
[DN戦略] ドライラン: ON(注文なし)
[リスク] 初期エクイティ設定: $XXXX
  hyperliquid: $XXXX 証拠金0.0% ポジ0件
  extended: $XXXX 証拠金0.0% ポジ0件
[スクリーニング] FR閾値通過: XX銘柄 / 230銘柄 (ホワイトリスト 35銘柄中 X銘柄が閾値通過)
[DN戦略] エントリー候補: X銘柄、並行上限3銘柄、実行予定: X銘柄
[DN戦略] サイクル完了
```

ログ確認を終えるには `Ctrl+C`。bot はバックグラウンドで動き続けます。

### よくある初回エラー

| エラー | 対処 |
| --- | --- |
| `環境変数 HL_API_WALLET_ADDRESS が設定されていません` | `.env` のスペルと `=` の後に値が入っているか確認 |
| `Cannot connect to Docker daemon` | Docker Desktop が起動していることを確認 (🪟 Windows はタスクトレイのクジラアイコンが緑か) |
| 残高が $0 と表示される | API キーの権限、取引所への入金が反映されているか確認 |
| 🪟 `'compose' is not a docker command` | 古い Docker のため `docker-compose` (ハイフン) を使う |
| 🪟 `docker: command not found` | Docker Desktop が起動していない、または PowerShell を再起動 |

---

## 8. 本番モードへの切り替え

ログで以下を確認してから本番モードに移ります:

* 両取引所の残高が正しく取得できている
* 起動から 5 分以上、エラーなく稼働している
* スクリーニングが実行され、候補評価のログが出力されている

問題なければ `.env` を再度編集して本番モードへ:

```
- DRY_RUN=true
+ DRY_RUN=false
```

再起動:

```
docker compose restart
```

ログを確認し、`[DN戦略] ドライラン: OFF(実注文)` と
`モード: 本番(実注文あり)` が表示されれば本番稼働中です。

---

## 運用コマンド

| 操作 | コマンド |
| --- | --- |
| ログ閲覧(リアルタイム) | `docker compose logs -f dn-engine` |
| ログ閲覧(直近 100 行) | `docker compose logs --tail 100 dn-engine` |
| 停止 | `docker compose stop` |
| 再開 | `docker compose start` |
| 完全停止(コンテナ削除) | `docker compose down` |
| アップデート | `git pull && docker compose up -d --build` |

> 💡 **🪟 Windows PowerShell の `&&` 注意**:
> 古い PowerShell (5.x) では `&&` が使えません。その場合は 2 行に分けて実行してください:
> ```powershell
> git pull
> docker compose up -d --build
> ```
> Windows 11 標準の PowerShell 7 / Windows Terminal なら `&&` が使えます。

---

## 止めるときの注意

* `docker compose stop` は bot を止めるだけで、**取引所で保有中のポジションはそのまま残ります**
* ポジションを手動でクローズしたい場合は、各取引所の UI から直接決済してください
* その後 bot を再起動すると、取引所の残存ポジションと DB の不整合を検知して
  自動で arrangement してくれます (reconcile 機能)

---

## OS 別: PC を 24h 稼働させるコツ

### 🍎 Mac

* システム設定 → ロック画面 → ディスプレイがオフになるまでの時間 → なし(または十分長く)
* システム設定 → エネルギー → 「コンピュータを自動でスリープさせない」にチェック
* 蓋を閉じても動かしたい場合: クラムシェルモード (外部ディスプレイ接続)
* 推奨: 専用の VPS 利用 (AWS Lightsail / さくら VPS / Vultr 等、月 $5-10)

### 🪟 Windows

* 設定 → システム → 電源とバッテリー → 画面とスリープ → 「電源接続時、PC をスリープ状態にする」を「なし」
* ノート PC の場合、コントロールパネル → 電源オプション → 「カバーを閉じたときの動作」を「何もしない」に
* WSL2 のメモリ制限を緩めたい場合は `C:\Users\<ユーザー名>\.wslconfig` を作成:
  ```
  [wsl2]
  memory=4GB
  processors=2
  ```
* 推奨: 専用の VPS 利用

### 🐧 Linux

* `systemd` で常駐サービス化 or `tmux/screen` でセッション保持
* デスクトップ環境なら電源管理設定でスリープを無効化
* サーバー構成が一番安定

---

## 次のステップ

* [TROUBLESHOOTING.md](https://github.com/Akira-bluemountain/delta-neutral-bot/blob/main/TROUBLESHOOTING.md) — うまく動かないときの対処
* [DISCLAIMER.md](https://github.com/Akira-bluemountain/delta-neutral-bot/blob/main/DISCLAIMER.md) — 必ず読んでほしいリスク説明
* [README.md](https://github.com/Akira-bluemountain/delta-neutral-bot/blob/main/README.md) - 概要に戻る
