# delta-neutral-bot

Hyperliquid × Extended のファンディングレート裁定を **デルタニュートラル** で自動運用する Bot。

## これは何？

- Long（買い）と Short（売り）を **別の取引所で同サイズ同時に建てる** ことで、
  価格変動リスクをほぼゼロにしたまま、両取引所のファンディング・レート（FR）の
  差益だけを取りに行く自動売買ボットです。
- メイン取引所: **Hyperliquid**、サブ取引所: **Extended (x10)**
- 動作環境: **Docker Compose** （Mac / Windows / Linux）

## できること

- 32 銘柄以上を常時スクリーニングし、FR 差が一定以上に開いたペアを自動エントリー
- 最大 3 ペアを並行保有（資金効率の最大化）
- 手数料回収ベースの動的エグジット（元が取れるまで保持、24 時間上限）
- リスクモニター（ドリフト検知、清算接近警告、サーキットブレーカー）
- `DRY_RUN` モードで実注文なしのシミュレーション可

## 必要なもの

- Hyperliquid アカウント（EVM ウォレット）+ 入金済み残高（**推奨 $500+**）
- Extended アカウント（Starknet ウォレット）+ 入金済み残高（**推奨 $500+**）
- Docker Desktop（Mac/Windows）または Docker Engine（Linux）
- PC: 常時稼働可能な環境（VPS でも OK）。CPU/メモリは軽量、**2GB RAM あれば十分**

## クイックスタート（5 ステップ）

1. **両取引所の口座作成 + 入金 + API キー発行**
   → 詳しくは [SETUP.md](SETUP.md) を参照
2. **リポジトリを clone**
   ```bash
   git clone https://github.com/Akira-bluemountain/delta-neutral-bot.git
   cd delta-neutral-bot
   ```
3. **設定ファイル作成**
   ```bash
   cp .env.example .env
   # .env をエディタで開き、API キーを入力
   ```
4. **最初は DRY_RUN で起動**（既定で `DRY_RUN=true` になっています）
   ```bash
   docker compose up -d
   docker compose logs -f dn-engine
   ```
5. **問題なければ本番モードに切り替え**
   ```bash
   # .env の DRY_RUN=true を DRY_RUN=false に書き換えて
   docker compose restart
   ```

## 詳しいセットアップ

- [SETUP.md](SETUP.md) — 口座開設〜API キー取得〜起動までの完全手順
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — うまく動かないときの対処集

## リスク

**必ず [DISCLAIMER.md](DISCLAIMER.md) を読んでから使ってください**。
暗号資産取引には**元本割れリスク**があり、本 bot にもバグや想定外の
動作によって**損失が発生する可能性**があります。

少額（例: 各取引所 $500 ずつ）から始めること、`DRY_RUN=true` で
十分検証してから本番移行することを強く推奨します。

## サポート・質問

- バグ報告 / 機能要望: GitHub Issues を利用してください
- Pull Request 歓迎

## ライセンス

[MIT License](LICENSE) — 自由に利用・改変・再配布できますが、本ソフトウェアは
無保証で提供されます。利用によって生じた損失について開発者は一切の責任を
負いません。
