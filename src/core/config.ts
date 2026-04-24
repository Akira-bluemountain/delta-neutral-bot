import dotenv from "dotenv";
import { VenueConfig, VenueId } from "./types";
import {
  isMultiplierSymbol as _isMultiplierSymbol,
  getBaseSymbol as _getBaseSymbol,
} from "./symbol-mapping";

dotenv.config();

// 必須環境変数の検証
function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value || value.trim() === "") {
    throw new Error(`環境変数 ${key} が設定されていません`);
  }
  return value.trim();
}

// 任意環境変数（デフォルト値あり）
function optionalEnv(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

// ベニュー設定
export const VENUES: Record<VenueId, VenueConfig> = {
  hyperliquid: {
    id: "hyperliquid",
    chain: "hyperliquid_l1",
    fundingIntervalHours: 1,
    makerFeeRate: 0.0001,
    takerFeeRate: 0.00035,
    apiBaseUrl: "https://api.hyperliquid.xyz",
  },
  extended: {
    id: "extended",
    chain: "starknet",
    fundingIntervalHours: 1, // 実API確認: hourlyFundingRateCap あり、履歴も1h間隔
    makerFeeRate: 0, // 最大の強み
    takerFeeRate: 0.00025,
    apiBaseUrl: "https://api.starknet.extended.exchange/api/v1",
  },
};

// スクリーニングパラメータ
export const SCREENING = {
  minFundingRate: 0.00005, // 最低FR閾値（年率44%相当、両ベニュー対象を広く取る）
  numPrevFr: 2, // 過去FR参照数
  costRecoveryDays: 7, // コスト回収想定日数(n)
  depthCheckUsd: 1000, // 板厚チェック金額
  maxCandidates: 60, // スクリーニング候補数
};

// DN戦略パラメータ（テスト運用: $1,000規模）
export const DN_PARAMS = {
  pthOpen: [0.004, 0.0017] as [number, number], // [非証拠金, 証拠金]
  frOpen: 0.00025, // Task A2: [0.00005, 0.00003] → 0.00025 scalar (損益分岐×1.17、年率219%グロス) docs/BOT_SPEC.md §15
  pthClose: -0.0004,
  frClose: 0.00010, // Task A2: 0.00002 → 0.00010 (frOpen の 40%ライン)
  maxPositionUsd: 50, // IP フルサイクル成功確認済み → $50 に引き上げ
  minOrderUsd: 10, // 小額ポジション対応
  freeUsdtThreshold: 100, // テスト: 各ベニューに$100確保
  minHoldMinutes: 30, // Task B3: 180 → 30 (セーフティ網のみ。主制御は fr_breakeven_at 達成で切り替え)
  maxHoldMinutes: 1440, // Task B3: 新設。24h 上限で強制クローズ（手数料回収未達でも資金ロック防止）
  maxEntriesPerCycle: 3, // Task B2: 1 → 3 (複数ペア並行保有、資金効率 3 倍化、銘柄重複は dn-strategy 側で排除)
  minEntryScore: 10, // エントリー最低スコア（高確信度のみ）

  // ホワイトリスト: 両ベニューで取引可能・$50 サイズで最小注文を満たす銘柄
  //
  // Task B1 (2026-04-24) で 15 → 30 銘柄へ拡大。Phase A 本番テスト (30h+11h) で
  // 既存 15 銘柄では frOpen 閾値通過機会がほぼなく、エントリー頻度が合計 1 件に
  // 留まった反省を受け、両取引所で十分な流動性と小額発注適合性を持つ銘柄を追加。
  //
  // 選定基準:
  //   - Hyperliquid ∩ Extended の両取引所でアクティブ
  //   - $50 発注で両取引所の最小注文を満たす (hl minUSD <= $50, ext minUSD <= $50)
  //   - EXT 24h volume >= $200k（Tier 1 は $1M+, Tier 2 は $200k-1M）
  //   - HL 非 isolated 銘柄
  //
  // 各銘柄の HL szDecimals / EXT minOrderSize (base units) / EXT minUSD 参考値:
  //   既存 15 銘柄 (Phase A 時点で実績 or 選定):
  //     BTC  (HLszDec=5, EXTminSz=0.0001, EXTminUSD=$7.80)
  //     ETH  (HLszDec=4, EXTminSz=0.01,   EXTminUSD=$23.21)
  //     SOL  (HLszDec=2, EXTminSz=0.1,    EXTminUSD=$8.59)
  //     BNB  (HLszDec=3, EXTminSz=0.01,   EXTminUSD=$6.38)
  //     XRP  (HLszDec=0, EXTminSz=10,     EXTminUSD=$14.34)
  //     XMR  (HLszDec=3, EXTminSz=0.1,    EXTminUSD=$37.86)  // $50の76%占有
  //     LINK (HLszDec=1, EXTminSz=1,      EXTminUSD=$9.34)
  //     AVAX (HLszDec=2, EXTminSz=1,      EXTminUSD=$9.37)
  //     LTC  (HLszDec=2, EXTminSz=0.1,    EXTminUSD=$5.59)
  //     HYPE (HLszDec=2, EXTminSz=0.1,    EXTminUSD=$4.11)
  //     SUI  (HLszDec=1, EXTminSz=10,     EXTminUSD=$9.45)
  //     APT  (HLszDec=2, EXTminSz=1,      EXTminUSD=$0.95)
  //     UNI  (HLszDec=1, EXTminSz=1,      EXTminUSD=$3.28)
  //     TAO  (HLszDec=3, EXTminSz=0.1,    EXTminUSD=$25.05)
  //     DOGE (HLszDec=0, EXTminSz=100,    EXTminUSD=$9.71)
  //   Task B1 追加 Tier 1 (EXT $1M+/day, 10 銘柄):
  //     AAVE     (HLszDec=2, EXTminSz=0.1,  EXTminUSD=$9.36)
  //     CHIP     (HLszDec=0, EXTminSz=100,  EXTminUSD=$10.32)
  //     ZEC      (HLszDec=2, EXTminSz=0.1,  EXTminUSD=$34.04)  // $50の68%占有
  //     ENA      (HLszDec=0, EXTminSz=100,  EXTminUSD=$11.02)
  //     ADA      (HLszDec=0, EXTminSz=10,   EXTminUSD=$2.50)
  //     LIT      (HLszDec=0, EXTminSz=10,   EXTminUSD=$9.26)
  //     XPL      (HLszDec=0, EXTminSz=10,   EXTminUSD=$1.01)
  //     FARTCOIN (HLszDec=1, EXTminSz=10,   EXTminUSD=$1.99)
  //     MON      (HLszDec=0, EXTminSz=100,  EXTminUSD=$3.16)
  //     PUMP     (HLszDec=0, EXTminSz=1000, EXTminUSD=$1.78)
  //   Task B1 追加 Tier 2 (EXT $200k-1M/day, 5 銘柄):
  //     STRK  (HLszDec=0, EXTminSz=10, EXTminUSD=$4.23)
  //     TON   (HLszDec=1, EXTminSz=10, EXTminUSD=$13.14)
  //     AERO  (HLszDec=0, EXTminSz=10, EXTminUSD=$4.30)
  //     LDO   (HLszDec=1, EXTminSz=10, EXTminUSD=$3.84)
  //     KAITO (HLszDec=1, EXTminSz=10, EXTminUSD=$4.39)
  //   Task B1-extend 追加 Tier 3 (2026-04-24、48h FR 持続性データで選定、1 銘柄):
  //     GRASS (HLszDec=0, EXTminSz=10, EXTminUSD=$4.67)  // EXT 24h vol $756k
  //       根拠: 48h 観測で frOpen 突破 3/48 (6.3%)、frClose 突破 19/48 (39.6%)、
  //             max spread APY 275.5% — 非 WL 候補 18 銘柄中で最高の持続性。
  //             WIF は EXT vol $300k あるが 48h 一度も frOpen を突破せず見送り、
  //             AVNT は 4/48 突破実績があるが EXT vol $56k で Phase B2 に保留。
  //   Task B4 追加 Tier 4 (2026-04-24、倍率銘柄シンボル変換層経由、1 銘柄):
  //     kPEPE (HLszDec=0, EXTminSz=1000, EXTminUSD=$3.84)  // EXT 24h vol $1.45M
  //       ※ HL "kPEPE" ↔ EXT "1000PEPE" で同一銘柄。
  //         src/core/symbol-mapping.ts の hlToExtSymbol で発注時のみ変換。
  //         DB (dn_pairs.symbol) には HL 命名 "kPEPE" で保存。
  //         価格は両取引所で完全一致確認済 (1 unit = 1000 PEPE、実 API で検証)。
  //   Task B5 追加 薄板銘柄 ($10 tier、SYMBOL_CONFIGS で個別 maxPositionUsd 設定):
  //     kBONK (HLszDec=0, EXTminSz=1000, EXTminUSD=$6.35)   // EXT vol $64k → $10 tier
  //       ※ Tier 4 倍率銘柄 + 薄板。B4 のシンボル変換層経由 (1000BONK)。
  //     AVNT  (HLszDec=0, EXTminSz=10,   EXTminUSD=$1.52)   // EXT vol $42k → $10 tier
  //       根拠: 48h 観測で frOpen 突破 4/48 (B1-extend Phase 1 で最多実績)
  //     EIGEN (HLszDec=2, EXTminSz=10,   EXTminUSD=$1.82)   // EXT vol $67k → $10 tier
  //       根拠: B1 Phase 1 で 66.6% APY 観測実績あり
  //
  // 除外銘柄（Phase B6 以降で再検討）:
  //   CAKE: EXT 24h vol $95k あり活動度も中程度だが EXT min notional $15.03 のため
  //         $10 tier は物理的に発注不可。$20 tier を新設する場合は B6 で追加検討。
  //   VIRTUAL: EXT 24h vol $45k + 48h FR 活動度ほぼなし（frClose 突破 0/48）
  //   kSHIB/1000SHIB: EXT 24h vol $2.5k で事実上死、板が維持できていない
  //
  // 参考: docs/BOT_SPEC.md §15 ロードマップ Task B1 / Task B1-extend / Task B4 / Task B5
  symbolWhitelist: [
    // 既存 15 銘柄
    "BTC", "ETH", "SOL", "BNB", "XRP",
    "XMR", "LINK", "AVAX", "LTC", "HYPE",
    "SUI", "APT", "UNI", "TAO", "DOGE",
    // Task B1 Tier 1 追加（EXT $1M+/day）
    "AAVE", "CHIP", "ZEC", "ENA", "ADA",
    "LIT", "XPL", "FARTCOIN", "MON", "PUMP",
    // Task B1 Tier 2 追加（EXT $200k-1M/day）
    "STRK", "TON", "AERO", "LDO", "KAITO",
    // Task B1-extend Tier 3 追加（48h FR 持続性で選定）
    "GRASS",
    // Task B4 Tier 4 追加（倍率銘柄、シンボル変換層経由）
    "kPEPE",
    // Task B5 追加 薄板銘柄（$10 tier、SYMBOL_CONFIGS で個別サイズ上限設定）
    //   kBONK: HL 倍率銘柄 + 薄板（EXT 1000BONK）
    //   AVNT: 48h frOpen 突破 4/48 実績あり、EXT vol $42k 境界
    //   EIGEN: B1 Phase 1 で 66.6% APY 観測実績
    "kBONK", "AVNT", "EIGEN",
  ] as string[],
};

/**
 * 注文執行パラメータ（Phase A Task A1）
 * POST_ONLY + IOC fallback の挙動を制御する。
 *
 * 設計意図: 往復手数料 0.12% → 0.02% への削減。
 * POST_ONLY が約定すれば maker 料率（HL 0.01% / EXT 0%）、
 * 約定しなければ IOC で taker 料率に切り替えて必ず約定させる。
 */
export const EXECUTION_PARAMS = {
  /** POST_ONLY の最大待機時間（秒）。超えたら cancel → IOC にフォールバック */
  postOnlyTimeoutSec: 2,

  /**
   * POST_ONLY 指値の mid からのオフセット（bp = 1/10000）。
   * buy: max(mid × (1 - offsetBps/10000), best_bid) ※best_bid 取得可能時
   * sell: min(mid × (1 + offsetBps/10000), best_ask)
   *
   * TODO(Phase B2): postOnlyOffsetBps を銘柄価格帯で動的調整
   *   現状 1bp 固定は BTC/ETH で内側すぎる可能性あり（~$8 オフセット）。
   *   本番小額テストで約定率を見てから調整予定。
   */
  postOnlyOffsetBps: 1,

  /** IOC フォールバック時のスリッページ許容（bp）。mid から ±5bp で板マッチを狙う */
  iocMaxSlippageBps: 5,

  /** POST_ONLY 状態ポーリング間隔（ミリ秒） */
  pollIntervalMs: 200,

  /** L2 orderbook 取得のタイムアウト（ミリ秒）。超過時は mid オフセット fallback */
  l2TimeoutMs: 500,

  /** L2 orderbook キャッシュの TTL（ミリ秒）。同一サイクル内の重複取得を抑制 */
  l2CacheTtlMs: 2_000,

  /** Alo (POST_ONLY) 拒否率の警告閾値（0-1）。直近 N 件のうち超過したら警告通知 */
  aloRejectionWarnRate: 0.2,

  /** Alo 拒否率計算の対象件数（直近 N 件） */
  aloRejectionSampleSize: 100,

  /** Alo 警告通知のクールダウン（ミリ秒）。スパム防止 */
  aloWarnCooldownMs: 60 * 60 * 1000, // 1時間
} as const;

// リスク管理パラメータ（テスト運用: $1,000規模）
export const RISK_PARAMS = {
  // ドリフト（Long/Short数量ズレ）
  driftWarnPct: 3,
  driftCriticalPct: 5,
  // 清算接近
  liquidationWarnPct: 20,
  liquidationCriticalPct: 10,
  // 証拠金使用率
  marginUsageWarnPct: 70,
  marginUsageCriticalPct: 85,
  // サーキットブレーカー
  maxUnrealizedLossUsd: -50, // テスト: $50損失で警告
  maxDrawdownPct: 10, // 10%ドローダウンで停止
  // モニタリング間隔
  monitorIntervalMs: 30_000,
};

// APIキー設定（ユーザーが .env で設定する必須項目）
export const API_KEYS = {
  get hlWalletAddress(): string {
    return requireEnv("HL_API_WALLET_ADDRESS");
  },
  get hlWalletPrivateKey(): string {
    return requireEnv("HL_API_WALLET_PRIVATE_KEY");
  },
  get extendedApiKey(): string {
    return requireEnv("EXTENDED_API_KEY");
  },
  get extendedStarkPrivateKey(): string {
    return requireEnv("EXTENDED_STARK_PRIVATE_KEY");
  },
  get extendedStarkPublicKey(): string {
    return requireEnv("EXTENDED_STARK_PUBLIC_KEY");
  },
  get extendedVaultId(): string {
    return requireEnv("EXTENDED_VAULT_ID");
  },
};

// DB設定
export const DB_PATH = optionalEnv("DB_PATH", "./data/dn-engine.db");

// ポーリング間隔（ミリ秒）
export const INTERVALS = {
  fundingRate: 5 * 60 * 1000, // 5分
  screening: 1000, // 1秒
  apiMinDelay: 100, // API最低間隔 100ms
};

// 倍率銘柄判定（Task B4 で新 util に委譲）
//
// 旧実装: `^(\d+)([A-Z]+)$` パターンで、HL の 0G / 2Z を「倍率銘柄」と誤検知していた
// （本番ログで "[HL] 倍率銘柄検出: 2Z" が継続出力されていた latent bug）。
// 新実装: src/core/symbol-mapping.ts の isMultiplierSymbol / getBaseSymbol に委譲。
//   HL: k プレフィックス (kPEPE)
//   EXT: 1000 プレフィックス (1000PEPE)
// 両方ともに base の部分を baseSymbol として返す。
export function parseMultiplierSymbol(symbol: string): {
  multiplier: number;
  baseSymbol: string;
} {
  if (_isMultiplierSymbol(symbol)) {
    return { multiplier: 1000, baseSymbol: _getBaseSymbol(symbol) };
  }
  return { multiplier: 1, baseSymbol: symbol };
}
