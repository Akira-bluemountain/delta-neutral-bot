import { FundingComparison, ArbitrageOpportunity, FundingRate, VenueId } from "../core/types";
import { VENUES } from "../core/config";
import { fetchFundingRates as fetchHlFunding } from "../collectors/hyperliquid";
import { fetchFundingRates as fetchExtFunding } from "../collectors/extended";
import { getDb } from "../db/database";

// 2ベニュー間のFR比較を生成
export function compareFundingRates(
  hlRates: FundingRate[],
  extRates: FundingRate[]
): FundingComparison[] {
  const extMap = new Map<string, FundingRate>();
  for (const r of extRates) {
    extMap.set(r.symbol, r);
  }

  return hlRates.map((hl) => {
    const ext = extMap.get(hl.symbol) || null;

    // スプレッド: HL年率 - Extended年率（正ならHLの方がFR高い）
    const spreadAnnualized = ext
      ? hl.annualized - ext.annualized
      : 0;

    // FR受取が大きい方でshort、支払が安い方でlong
    let bestShortVenue: VenueId;
    let bestLongVenue: VenueId;

    if (!ext || hl.rate >= (ext?.rate ?? 0)) {
      bestShortVenue = "hyperliquid";
      bestLongVenue = ext ? "extended" : "hyperliquid";
    } else {
      bestShortVenue = "extended";
      bestLongVenue = "hyperliquid";
    }

    return {
      symbol: hl.symbol,
      hyperliquid: hl,
      extended: ext,
      spreadAnnualized,
      bestShortVenue,
      bestLongVenue,
      timestamp: new Date(),
    };
  });
}

// FR裁定機会を検出（年率50%以上のスプレッド）
export function detectArbitrage(
  comparisons: FundingComparison[]
): ArbitrageOpportunity[] {
  return comparisons
    .filter((c) => c.extended !== null && Math.abs(c.spreadAnnualized) > 50)
    .map((c) => ({
      symbol: c.symbol,
      longVenue:
        c.spreadAnnualized > 0
          ? ("extended" as VenueId)
          : ("hyperliquid" as VenueId),
      shortVenue:
        c.spreadAnnualized > 0
          ? ("hyperliquid" as VenueId)
          : ("extended" as VenueId),
      spreadAnnualized: Math.abs(c.spreadAnnualized),
      estimatedDailyUsd: (Math.abs(c.spreadAnnualized) / 365) * (10000 / 100),
      confidence: (Math.abs(c.spreadAnnualized) > 100
        ? "HIGH"
        : "MEDIUM") as "HIGH" | "MEDIUM" | "LOW",
      timestamp: new Date(),
    }))
    .sort((a, b) => b.spreadAnnualized - a.spreadAnnualized);
}

// 裁定機会をDBに保存
function saveArbitrageOpportunities(
  opportunities: ArbitrageOpportunity[]
): void {
  const stmt = getDb().prepare(`
    INSERT INTO arbitrage_opportunities (symbol, long_venue, short_venue, spread_annualized, estimated_daily_usd, confidence, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = getDb().transaction((items: ArbitrageOpportunity[]) => {
    for (const opp of items) {
      stmt.run(
        opp.symbol,
        opp.longVenue,
        opp.shortVenue,
        opp.spreadAnnualized,
        opp.estimatedDailyUsd,
        opp.confidence,
        opp.timestamp.toISOString()
      );
    }
  });

  insertMany(opportunities);
}

// メイン: FR取得→比較→裁定検出→保存
export async function detectArbitrageOpportunities(): Promise<
  ArbitrageOpportunity[]
> {
  console.log("[FR裁定] 検出開始...");

  const [hlRates, extRates] = await Promise.all([
    fetchHlFunding(),
    fetchExtFunding(),
  ]);

  const comparisons = compareFundingRates(hlRates, extRates);
  const opportunities = detectArbitrage(comparisons);

  if (opportunities.length > 0) {
    saveArbitrageOpportunities(opportunities);
    console.log(
      `[FR裁定] ${opportunities.length}件の裁定機会を検出`
    );
    for (const opp of opportunities.slice(0, 5)) {
      console.log(
        `  ${opp.symbol}: Long=${opp.longVenue} Short=${opp.shortVenue} 年率${opp.spreadAnnualized.toFixed(1)}% 日次$${opp.estimatedDailyUsd.toFixed(2)} [${opp.confidence}]`
      );
    }
  } else {
    console.log("[FR裁定] 裁定機会なし");
  }

  return opportunities;
}
