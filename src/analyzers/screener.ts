import { VENUES, SCREENING, DN_PARAMS } from "../core/config";
import { hlToExtSymbol } from "../core/symbol-mapping";
import {
  FundingRate,
  OrderBook,
  ScreeningResult,
  VenueId,
} from "../core/types";
import { getRecentFundingRates } from "../db/database";
import { fetchFundingRates, fetchOrderBook } from "../collectors/hyperliquid";
import {
  fetchFundingRates as fetchExtFundingRates,
  fetchOrderBook as fetchExtOrderBook,
} from "../collectors/extended";

/**
 * Task C2: max(|HL|, |EXT|) ベースで FR 閾値判定・ソート・切り詰めを行う純粋関数。
 *
 * 旧実装 (HL 単独): `hlRates.filter(r => |r.rate| >= min).sort(|r.rate| desc).slice(0, max)`
 *
 * 旧実装では EIGEN のように「HL ほぼ 0 / EXT 高 FR」の銘柄が screening で除外され、
 * strategy 層の FR 閾値判定 (Task C1) に到達しなかった。
 * デルタニュートラル戦略は両取引所の FR 差で稼ぐため、片側高 FR も捕捉対象とすべき。
 *
 * 新実装: 両取引所のうち高い方の |FR| で判定・ソート。EXT データ欠損銘柄は HL 単独
 * フォールバック（既存の「EXT に存在しない銘柄はスキップ」はループ内で従来通り機能する）。
 *
 * SCREENING.minFundingRate のコメント「両ベニュー対象を広く取る」と実装が一致する形。
 *
 * @param hlRates HL 銘柄の funding rate 一覧（HL 命名）
 * @param extRateMap EXT 命名 → FundingRate のマップ（kPEPE は 1000PEPE で登録される）
 * @param minFundingRate 最低閾値（絶対値、両ベニュー最大）
 * @param maxCandidates 返却上限（max ベース降順の上位 N）
 * @returns HL 命名の FundingRate 配列（元の HL rate を保持、下流処理はそのまま使用可）
 */
export function selectCandidatesByMaxFr(
  hlRates: FundingRate[],
  extRateMap: Map<string, FundingRate>,
  minFundingRate: number,
  maxCandidates: number
): FundingRate[] {
  return hlRates
    .map((r) => {
      const extRate = extRateMap.get(hlToExtSymbol(r.symbol));
      const maxAbs = Math.max(Math.abs(r.rate), Math.abs(extRate?.rate ?? 0));
      return { hlRate: r, maxAbs };
    })
    .filter((x) => x.maxAbs >= minFundingRate)
    .sort((a, b) => b.maxAbs - a.maxAbs)
    .slice(0, maxCandidates)
    .map((x) => x.hlRate);
}

// 既存Botのスコア計算式を完全再現
export function calculateScore(
  frNext: number,
  frPrev: number,
  cost: number,
  n: number = SCREENING.costRecoveryDays
): number {
  return (
    ((frNext + frPrev) * 3 * 365 * 100) / 2 +
    ((frNext - cost) * 365 * 100) / n
  );
}

// 板からスプレッド+スリッページを算出
export function calculateCost(
  orderBook: OrderBook,
  sizeUsd: number,
  venue: VenueId
): { spread: number; slippage: number; totalCost: number } {
  const config = VENUES[venue];

  if (orderBook.asks.length === 0 || orderBook.bids.length === 0) {
    return { spread: 0, slippage: 0, totalCost: config.makerFeeRate * 2 + config.takerFeeRate * 2 };
  }

  const bestAsk = orderBook.asks[0].price;
  const bestBid = orderBook.bids[0].price;
  const midPrice = (bestAsk + bestBid) / 2;
  const spread = (bestAsk - bestBid) / midPrice;

  // スリッページ推定: sizeUsd分の板厚を消費した場合の価格インパクト
  let slippage = 0;
  let remainingUsd = sizeUsd;
  let totalCostWeighted = 0;

  for (const ask of orderBook.asks) {
    const levelUsd = ask.price * ask.size;
    const consumed = Math.min(remainingUsd, levelUsd);
    totalCostWeighted += consumed * (ask.price - bestAsk) / bestAsk;
    remainingUsd -= consumed;
    if (remainingUsd <= 0) break;
  }
  if (sizeUsd > 0) {
    slippage = totalCostWeighted / sizeUsd;
  }

  // 合計コスト: spread + slippage + maker手数料×2 + taker手数料×2
  const totalCost =
    spread + slippage + config.makerFeeRate * 2 + config.takerFeeRate * 2;

  return { spread, slippage, totalCost };
}

// 過去FRの平均を取得
function getAveragePrevFr(
  venue: string,
  symbol: string,
  count: number
): number {
  const rates = getRecentFundingRates(venue, symbol, count);
  if (rates.length === 0) return 0;
  return rates.reduce((sum, r) => sum + r.rate, 0) / rates.length;
}

// メインスクリーニングフロー
export async function runScreening(): Promise<ScreeningResult[]> {
  console.log("[スクリーニング] 開始...");

  // 1. 両ベニューのFR取得
  const [hlRates, extRates] = await Promise.all([
    fetchFundingRates(),
    fetchExtFundingRates(),
  ]);

  // Extendedの銘柄マップ
  const extRateMap = new Map<string, FundingRate>();
  for (const r of extRates) {
    extRateMap.set(r.symbol, r);
  }

  // 2. FR閾値でフィルタ — Task C2: max(|HL|, |EXT|) 判定に変更
  //    （旧: HL 単独判定で EIGEN 等の片側高 FR 銘柄を逃していた）
  const candidates = selectCandidatesByMaxFr(
    hlRates,
    extRateMap,
    SCREENING.minFundingRate,
    SCREENING.maxCandidates
  );

  // ホワイトリスト内で FR 閾値を通過した銘柄数を可視化（Task B1）
  const whitelistSet = new Set(DN_PARAMS.symbolWhitelist);
  const whitelistedPassCount = candidates.filter((c) =>
    whitelistSet.has(c.symbol)
  ).length;
  const whitelistSize = DN_PARAMS.symbolWhitelist.length;

  // Task C2: ログに判定基準を明示（max(|HL|, |EXT|) ≥ X%）
  const minFrPct = (SCREENING.minFundingRate * 100).toFixed(4);
  console.log(
    `[スクリーニング] FR閾値通過: ${candidates.length}銘柄 / ${hlRates.length}銘柄` +
      ` (max(|HL|,|EXT|) ≥ ${minFrPct}% | ホワイトリスト ${whitelistSize}銘柄中 ${whitelistedPassCount}銘柄)`
  );

  // 3. 各銘柄のスコア計算
  const results: ScreeningResult[] = [];

  for (const hlRate of candidates) {
    const symbol = hlRate.symbol;  // HL 命名（kPEPE の可能性）
    // Task B4: HL の k 接頭銘柄 → EXT の 1000 接頭に変換して EXT 側を照会
    //   kPEPE  → 1000PEPE  (EXT 命名で lookup / 板取得)
    //   BTC    → BTC       (非倍率銘柄は変換なし、同一命名)
    const extSymbol = hlToExtSymbol(symbol);
    const extRate = extRateMap.get(extSymbol) || null;

    // Extended に存在しない銘柄はスキップ（DN戦略には両ベニュー必須）
    if (!extRate) {
      continue;
    }

    // 板情報取得
    let hlBook: OrderBook;
    let extBook: OrderBook;
    try {
      [hlBook, extBook] = await Promise.all([
        fetchOrderBook(symbol),       // HL 命名
        fetchExtOrderBook(extSymbol), // EXT 命名（倍率は "1000PEPE"、非倍率は HL と同名）
      ]);
    } catch (err) {
      console.warn(`[スクリーニング] ${symbol} 板情報取得失敗: ${err}`);
      continue;
    }

    // コスト計算
    const hlCostData = calculateCost(hlBook, SCREENING.depthCheckUsd, "hyperliquid");
    const extCostData = calculateCost(extBook, SCREENING.depthCheckUsd, "extended");

    // 過去FR平均
    const hlPrevFr = getAveragePrevFr("hyperliquid", symbol, SCREENING.numPrevFr);

    // 既存Botスコア（HL基準）
    const classicScore = calculateScore(
      hlRate.rate,
      hlPrevFr,
      hlCostData.totalCost
    );

    // Extended利用時のボーナス（maker0%によるコスト削減分）
    const costSaving = hlCostData.totalCost - extCostData.totalCost;
    const extendedBonus = costSaving > 0
      ? (costSaving * 365 * 100) / SCREENING.costRecoveryDays
      : 0;

    const compositeScore = classicScore + extendedBonus;

    // 推奨ベニュー: コストが低い方でshort
    const recommendedShortVenue: VenueId =
      extRate && extCostData.totalCost < hlCostData.totalCost
        ? "extended"
        : "hyperliquid";

    // 推定APY: FR年率 - コスト年率
    const bestCost = Math.min(hlCostData.totalCost, extCostData.totalCost);
    const estimatedApy = hlRate.annualized - bestCost * 365 * 100;

    results.push({
      symbol,
      classicScore,
      extendedBonus,
      compositeScore,
      hlFundingRate: hlRate,
      extFundingRate: extRate,
      hlSpread: hlCostData.spread,
      extSpread: extCostData.spread,
      hlCost: hlCostData.totalCost,
      extCost: extCostData.totalCost,
      recommendedShortVenue,
      estimatedApy,
    });
  }

  // スコア順にソート
  results.sort((a, b) => b.compositeScore - a.compositeScore);

  // コンソール出力（既存Bot形式を踏襲）
  printScreeningTable(results.slice(0, 20));

  return results;
}

// 既存Botのコンソール出力フォーマットを踏襲
function printScreeningTable(results: ScreeningResult[]): void {
  console.log(
    "Symbol".padEnd(12) +
      "Score[APY]".padEnd(12) +
      "FRnext %".padEnd(10) +
      "FRprev %".padEnd(10) +
      "Cost_HL %".padEnd(11) +
      "Cost_EXT %".padEnd(12) +
      "Recommend"
  );
  console.log("-".repeat(77));

  for (const r of results) {
    const frNext = (r.hlFundingRate.rate * 100).toFixed(4);
    const frPrev = r.extFundingRate
      ? (r.extFundingRate.rate * 100).toFixed(4)
      : "N/A";
    const costHl = (r.hlCost * 100).toFixed(4);
    const costExt = (r.extCost * 100).toFixed(4);
    const venue =
      r.recommendedShortVenue === "extended" ? "Extended" : "HL";

    console.log(
      r.symbol.padEnd(12) +
        r.compositeScore.toFixed(0).padEnd(12) +
        frNext.padEnd(10) +
        frPrev.padEnd(10) +
        costHl.padEnd(11) +
        costExt.padEnd(12) +
        venue
    );
  }
}
