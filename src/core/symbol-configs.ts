/**
 * Task B5 — 銘柄別ポジションサイズ override
 *
 * 通常は DN_PARAMS.maxPositionUsd ($50) を全銘柄で共通適用するが、
 * EXT 24h vol が $50k-$100k 程度の薄板銘柄では $50 サイズだと板占有率が
 * 過大になるため、個別に小さい上限値を設ける。
 *
 * 設計原則:
 *   - 既存銘柄は SYMBOL_CONFIGS に記載しない → デフォルト ($50) にフォールバック
 *   - 追加時は「EXT 24h vol のティア」に従う:
 *       $1M+          → 登録不要（$50 デフォルト）
 *       $500k-$1M     → $30 予備
 *       $200k-$500k   → $20 予備
 *       $50k-$200k    → $10
 *       $50k 未満     → WL に追加しない（発注禁止）
 *   - EXT minOrderSize × markPrice（= EXT min notional）が指定 tier を
 *     超える銘柄は物理的に発注不可なので除外する（例: CAKE $20 tier 要）
 *
 * 運用で EXT vol が変動した場合、SYMBOL_CONFIGS から該当銘柄を削除すると
 * 即座にデフォルト $50 にフォールバックする。
 * （逆に $50 → $10 化したい場合もここに追記するだけ。コード変更不要）
 */

import { DN_PARAMS } from "./config";

export interface SymbolConfig {
  /** 銘柄別の maxPositionUsd override（未指定時は DN_PARAMS.maxPositionUsd） */
  maxPositionUsd: number;
}

/**
 * 銘柄別の config override マップ。
 * 記載のない銘柄は getMaxPositionUsd が DN_PARAMS にフォールバックする。
 */
export const SYMBOL_CONFIGS: Record<string, SymbolConfig> = {
  // Task B5 追加 薄板銘柄（EXT 24h vol $50k-$100k）:
  //   kBONK    (EXT 1000BONK, EXT vol $64k)  — B4 の倍率銘柄処理と統合
  //   AVNT     (EXT vol $42k, 境界ラインだが 48h frOpen 突破実績 4 回)
  //   EIGEN    (EXT vol $67k、B1 Phase 1 で 66.6% APY 観測実績)
  //
  // 除外（Phase B6 以降で再検討）:
  //   CAKE     — EXT min notional $15 のため $10 tier 不可（$20 tier 要）
  //   VIRTUAL  — EXT vol $45k + 48h FR 活動度ほぼなし
  //   kSHIB    — EXT vol $2.5k 事実上死
  kBONK: { maxPositionUsd: 10 },
  AVNT: { maxPositionUsd: 10 },
  EIGEN: { maxPositionUsd: 10 },
};

/**
 * 銘柄別の maxPositionUsd を取得。未登録銘柄は DN_PARAMS.maxPositionUsd。
 */
export function getMaxPositionUsd(symbol: string): number {
  return SYMBOL_CONFIGS[symbol]?.maxPositionUsd ?? DN_PARAMS.maxPositionUsd;
}

/**
 * 該当銘柄が「薄板扱い」（DN_PARAMS のデフォルトより小さい maxPositionUsd）
 * かどうかを判定。ログ表示用。
 */
export function isThinBookSymbol(symbol: string): boolean {
  return getMaxPositionUsd(symbol) < DN_PARAMS.maxPositionUsd;
}
