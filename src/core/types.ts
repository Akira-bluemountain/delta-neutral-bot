// ベニュー
export type VenueId = "hyperliquid" | "extended";

// ベニュー設定
export interface VenueConfig {
  id: VenueId;
  chain: string;
  fundingIntervalHours: number; // HL=1, Extended=8
  makerFeeRate: number; // HL=0.0001, Extended=0
  takerFeeRate: number; // HL=0.00035, Extended=0.00025
  apiBaseUrl: string;
}

// ファンディングレート
export interface FundingRate {
  venue: VenueId;
  symbol: string;
  rate: number; // 1回あたり
  annualized: number; // 年率換算
  nextFundingTime: Date;
  timestamp: Date;
}

// 2ベニュー間のFR比較
export interface FundingComparison {
  symbol: string;
  hyperliquid: FundingRate;
  extended: FundingRate | null; // Extendedに存在しない銘柄はnull
  spreadAnnualized: number; // 年率換算のFR差分
  bestShortVenue: VenueId; // FR受取が大きい方
  bestLongVenue: VenueId; // FR支払が安い方
  timestamp: Date;
}

// スクリーニング結果
export interface ScreeningResult {
  symbol: string;
  // 既存Botのスコア計算式を完全踏襲:
  // score = (fr_next + fr_prev)*3*365*100/2 + (fr_next - cost)*365*100/n
  classicScore: number;
  // Extended maker0% によるコスト優位を反映した拡張スコア
  extendedBonus: number;
  compositeScore: number;

  // ベニュー別データ
  hlFundingRate: FundingRate;
  extFundingRate: FundingRate | null;
  hlSpread: number;
  extSpread: number;
  hlCost: number; // maker+taker+slippage
  extCost: number; // maker0%+taker+slippage

  // 推奨
  recommendedShortVenue: VenueId;
  estimatedApy: number;
}

// FR裁定機会
export interface ArbitrageOpportunity {
  symbol: string;
  longVenue: VenueId; // FR支払が安い方でLong
  shortVenue: VenueId; // FR受取が大きい方でShort
  spreadAnnualized: number;
  estimatedDailyUsd: number; // $10K想定の日次収益
  confidence: "HIGH" | "MEDIUM" | "LOW";
  timestamp: Date;
}

// スマートマネー合意度
export interface SmartMoneyConsensus {
  symbol: string;
  longPercent: number; // 0-100
  shortPercent: number; // 0-100
  netBias: number; // -100 to +100
  walletCount: number;
  signal:
    | "STRONG_LONG"
    | "LEAN_LONG"
    | "NEUTRAL"
    | "LEAN_SHORT"
    | "STRONG_SHORT";
  timestamp: Date;
}

// Nansen関連の型
export interface NansenLeaderboardEntry {
  address: string;
  totalPnl: number;
  roi: number;
  accountValue: number;
  labels: string[];
  updatedAt: Date;
}

export interface NansenPosition {
  address: string;
  symbol: string;
  side: "long" | "short";
  positionValueUsd: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  timestamp: Date;
}

export interface NansenTrade {
  address: string;
  symbol: string;
  side: "buy" | "sell";
  valueUsd: number;
  price: number;
  timestamp: Date;
}

// 板情報
export interface OrderBookLevel {
  price: number;
  size: number;
}

export interface OrderBook {
  venue: VenueId;
  symbol: string;
  asks: OrderBookLevel[];
  bids: OrderBookLevel[];
  timestamp: Date;
}

// DeFiLlama
export interface ProtocolTvl {
  protocol: string;
  tvl: number;
  change24h: number;
  timestamp: Date;
}

export interface YieldPool {
  pool: string;
  chain: string;
  project: string;
  symbol: string;
  tvlUsd: number;
  apy: number;
  apyBase: number;
  apyReward: number;
}

// ===== ポジション管理 =====

// DNペアのライフサイクル
// - opening: 注文発射中（DBレコード作成済み、両側結果待ち）
// - open: 両側約定確定、稼働中
// - closing: 反対売買発射中、または片側失敗ロールバック中（自動回復可能）
// - closed: 終了
// - manual_review: 自動操作で安全に解消できない異常状態（AMBIGUOUS等）
//   このステータスのペアは新規エントリーをブロックし、人間の確認が必要
export type DnPairStatus =
  | "opening"
  | "open"
  | "closing"
  | "closed"
  | "manual_review";

// デルタニュートラルペア（Long + Short の組）
export interface DnPair {
  id: number;
  symbol: string;
  longVenue: VenueId;
  shortVenue: VenueId;
  status: DnPairStatus;
  targetSizeUsd: number;
  longSize: number; // ベースアセット数量（実約定ベース）
  shortSize: number;
  longEntryPrice: number;
  shortEntryPrice: number;
  openReason: string; // "FR裁定: 年率85%" 等
  closeReason: string | null;
  openedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  // Task B3: 手数料回収ベースの動的 minHold 制御
  expectedFeeUsd: number;       // 入場時に見積もる往復手数料（entry + exit、USD）
                                 // 旧ペアは 0、その場合は後方互換で minHold のみで判定
  accumulatedFrUsd: number;      // 保有中にリアルタイム累積する FR 受取（USD、60 秒更新）
                                 // 負値もそのまま記録（スプレッド反転の観測用）
  frBreakevenAt: Date | null;    // 手数料回収達成時刻（未達なら null）
                                 // expectedFeeUsd > 0 かつこれが null なら shouldClosePair で保持継続
}

// 注文ステータス
// - ambiguous: 取引所側状態が確認できない（送達失敗かつ verify 失敗）。
//              このステータスを残したまま自動回復してはならない。
export type OrderStatus =
  | "pending"
  | "open"
  | "partially_filled"
  | "filled"
  | "cancelled"
  | "rejected"
  | "ambiguous";

// 注文の発注モード（Phase A Task A1）
// - POST_ONLY: maker 指値でのみ発注。即時マッチする価格なら拒否される（HL では Alo）。
//              手数料が最安（HL maker 0.01%、EXT maker 0%）。
// - IOC:       Immediate or Cancel。即時マッチしない残量はキャンセル。POST_ONLY の
//              タイムアウト時のフォールバックや、ロールバック・クローズで使用。
// - MARKET:    旧実装との互換モード。実装上は IOC と同じ挙動だが、意図を明示するため残す。
export type OrderMode = "POST_ONLY" | "IOC" | "MARKET";

// 自アカウント注文
export interface OwnOrder {
  id: number;
  pairId: number | null; // DNペアに紐づかない単発注文はnull
  venue: VenueId;
  symbol: string;
  side: "buy" | "sell";
  orderType: "limit" | "market";
  price: number;
  size: number;
  filledSize: number;
  status: OrderStatus;
  venueOrderId: string | null; // 取引所側の注文ID
  createdAt: Date;
  updatedAt: Date;
}

// 自アカウント約定
export interface OwnTrade {
  id: number;
  orderId: number;
  pairId: number | null;
  venue: VenueId;
  symbol: string;
  side: "buy" | "sell";
  price: number;
  size: number;
  fee: number;
  feeRate: number;
  venueTradeId: string | null;
  timestamp: Date;
}

// ポジションスナップショット（ドリフト検出用）
export interface PositionSnapshot {
  id: number;
  pairId: number;
  longSize: number;
  shortSize: number;
  longValueUsd: number;
  shortValueUsd: number;
  driftPct: number; // Long/Short の数量差率
  netUnrealizedPnl: number;
  accumulatedFunding: number;
  timestamp: Date;
}

// ===== リスク管理 =====

export type RiskLevel = "OK" | "WARN" | "CRITICAL";

// 個別リスクアラート
export interface RiskAlert {
  level: RiskLevel;
  category: "drift" | "liquidation" | "margin" | "loss" | "drawdown" | "collateral";
  venue?: VenueId;
  symbol?: string;
  pairId?: number;
  message: string;
  value: number; // 検出された数値（ドリフト%、証拠金使用率%等）
  threshold: number; // 閾値
}

// ベニュー別口座サマリー
export interface VenueAccountSummary {
  venue: VenueId;
  equity: number;
  marginUsed: number;
  marginUsagePct: number;
  availableBalance: number;
  unrealizedPnl: number;
  positionCount: number;
}

// DNペアのリスク評価
export interface PairRiskAssessment {
  pairId: number;
  symbol: string;
  driftPct: number;
  longLiquidationProximityPct: number | null; // 清算までの距離%
  shortLiquidationProximityPct: number | null;
  netUnrealizedPnl: number;
  accumulatedFunding: number;
  alerts: RiskAlert[];
  // Task B3: 保有時間 / 手数料回収状況
  holdDurationMinutes: number | null;   // 保有時間（分）、opened_at 未設定なら null
  expectedFeeUsd: number;               // 往復手数料見積もり（旧ペアは 0）
  accumulatedFrUsd: number;             // 現在の FR 累積受取
  feeRecovered: boolean;                // fr_breakeven_at がセットされているか
}

// 統合リスクレポート
export interface RiskReport {
  timestamp: Date;
  overallLevel: RiskLevel;
  venues: VenueAccountSummary[];
  totalEquity: number;
  totalMarginUsed: number;
  totalUnrealizedPnl: number;
  pairs: PairRiskAssessment[];
  alerts: RiskAlert[];
  circuitBreakerTriggered: boolean;
}

// Hyperliquidメタ情報
export interface HyperliquidAssetMeta {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated: boolean;
}

export interface HyperliquidAssetCtx {
  funding: string;
  openInterest: string;
  prevDayPx: string;
  dayNtlVlm: string;
  premium: string;
  oraclePx: string;
  markPx: string;
  midPx: string;
  impactPxs: string[];
}
