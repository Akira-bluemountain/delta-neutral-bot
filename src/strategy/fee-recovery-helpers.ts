/**
 * Task B3 — 手数料回収ベースの動的 minHold 用の純粋ヘルパー
 *
 * 副作用のない関数として実装し、境界値・組み合わせを単体テストで直接検証可能にする。
 * 手数料率 / funding interval は必ず引数で受け取る（config ハードコード禁止、
 * 呼び出し側で VENUES[venue] から参照して注入）。
 *
 * 主な責務:
 *   1. calculateExpectedFee: 往復手数料の見積もり（entry + exit、USD 建て）
 *   2. calculateAccumulatedFr: 保有期間中の FR 受取累積の近似計算
 *   3. shouldBlockClosureForFee: 手数料未回収時の閉鎖ブロック判定
 */

export type VenueMode = "POST_ONLY" | "IOC" | "MARKET";

export interface TradeFeeContext {
  /** 適用した約定モード（POST_ONLY→maker、それ以外→taker） */
  actualMode: VenueMode;
  /** 対象ベニューの maker 手数料率（例 HL=0.0001） */
  makerFeeRate: number;
  /** 対象ベニューの taker 手数料率（例 HL=0.00035） */
  takerFeeRate: number;
  /** 実約定価格（USD） */
  fillPrice: number;
  /** 実約定サイズ（base asset） */
  fillSize: number;
}

/**
 * 往復手数料（entry + exit）の USD 建て見積もり。
 *
 * 入場:
 *   - POST_ONLY で約定した側は maker fee、IOC フォールバックや MARKET なら taker fee
 * 退場:
 *   - executeClose は現在 IOC 前提なので両側 taker fee を仮定
 *
 * 実際の exit 手数料は own_trades に記録されるので、ここでは見積もりとしての位置付け。
 */
export function calculateExpectedFee(
  longEntry: TradeFeeContext,
  shortEntry: TradeFeeContext
): number {
  const entryFeeRate = (ctx: TradeFeeContext): number =>
    ctx.actualMode === "POST_ONLY" ? ctx.makerFeeRate : ctx.takerFeeRate;

  const longEntryFee =
    longEntry.fillPrice * longEntry.fillSize * entryFeeRate(longEntry);
  const shortEntryFee =
    shortEntry.fillPrice * shortEntry.fillSize * entryFeeRate(shortEntry);

  // 退場は IOC 前提 → taker 料率を適用（見積もり、実際は own_trades の fee が真値）
  const longExitFee =
    longEntry.fillPrice * longEntry.fillSize * longEntry.takerFeeRate;
  const shortExitFee =
    shortEntry.fillPrice * shortEntry.fillSize * shortEntry.takerFeeRate;

  return longEntryFee + shortEntryFee + longExitFee + shortExitFee;
}

/**
 * 保有中の FR 受取累積の近似計算（Task B3）。
 *
 * 仮定:
 *   - FR レートはエントリー以降一定（近似、実際は 1h ごとに変動するため誤差あり）
 *   - ファンディング間隔は両ベニュー 1h（config.ts VENUES.fundingIntervalHours 参照）
 *
 * 符号ルール:
 *   - Long 側: longVenueRate < 0 なら受取（正）、> 0 なら支払（負）
 *   - Short 側: shortVenueRate > 0 なら受取（正）、< 0 なら支払（負）
 *   - ペア合成: -longVenueRate × longNotional + shortVenueRate × shortNotional
 *
 * 返り値は USD 建ての時間積算。負値もそのまま返す（スプレッド反転の観測用）。
 */
export function calculateAccumulatedFr(params: {
  longVenueRate: number;       // 1 期間あたりの FR rate（小数、例 0.0001 = 0.01%）
  shortVenueRate: number;
  longSize: number;            // 実約定サイズ（base asset）
  shortSize: number;
  longEntryPrice: number;      // USD per base asset
  shortEntryPrice: number;
  elapsedMs: number;           // 入場からの経過ミリ秒
  fundingIntervalHours: number; // 両ベニュー共通 1h 前提だが引数で受け取る
}): number {
  const longNotional = params.longSize * params.longEntryPrice;
  const shortNotional = params.shortSize * params.shortEntryPrice;

  // 1 funding interval あたりの受取額（USD）
  const perIntervalRevenue =
    -params.longVenueRate * longNotional +
    params.shortVenueRate * shortNotional;

  const intervalMs = params.fundingIntervalHours * 60 * 60 * 1000;
  const elapsedIntervals = params.elapsedMs / intervalMs;

  return perIntervalRevenue * elapsedIntervals;
}

/**
 * shouldClosePair 内で「手数料回収未達のため保持継続すべきか」を判定。
 *
 * 後方互換性:
 *   - expected_fee_usd === 0 の旧ペア（Task B3 以前）は false を返し、
 *     既存の minHold / FR 反転 / スプレッド消滅 判定に委ねる
 *
 * 判定ロジック:
 *   - expectedFeeUsd > 0 かつ frBreakevenAt === null のとき true（保持継続）
 *   - それ以外は false（通常のクローズ判定へ進める）
 */
export function shouldBlockClosureForFee(pair: {
  expectedFeeUsd: number;
  frBreakevenAt: Date | null;
}): boolean {
  if (pair.expectedFeeUsd <= 0) return false; // 後方互換（旧ペア）
  return pair.frBreakevenAt === null;
}
