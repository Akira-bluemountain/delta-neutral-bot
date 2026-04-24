import axios from "axios";
import { VENUES, parseMultiplierSymbol } from "../core/config";
import { FundingRate, OrderBook, HyperliquidAssetMeta, HyperliquidAssetCtx } from "../core/types";
import { withRetry } from "../core/retry";
import { saveFundingRate } from "../db/database";

const BASE_URL = VENUES.hyperliquid.apiBaseUrl;

// 全ペアの中値取得
export async function fetchAllMids(): Promise<Record<string, string>> {
  return withRetry(async () => {
    const res = await axios.post(`${BASE_URL}/info`, { type: "allMids" });
    return res.data as Record<string, string>;
  }, "HL allMids取得");
}

// 板情報取得
export async function fetchOrderBook(symbol: string): Promise<OrderBook> {
  return withRetry(async () => {
    const res = await axios.post(`${BASE_URL}/info`, {
      type: "l2Book",
      coin: symbol,
    });

    const levels = res.data.levels as Array<Array<{ px: string; sz: string; n: number }>>;
    // levels[0] = bids, levels[1] = asks
    const bids = (levels[0] || []).map((l) => ({
      price: parseFloat(l.px),
      size: parseFloat(l.sz),
    }));
    const asks = (levels[1] || []).map((l) => ({
      price: parseFloat(l.px),
      size: parseFloat(l.sz),
    }));

    return {
      venue: "hyperliquid" as const,
      symbol,
      bids,
      asks,
      timestamp: new Date(),
    };
  }, `HL 板情報取得 ${symbol}`);
}

// メタ情報 + アセットコンテキスト取得
export async function fetchMetaAndAssetCtxs(): Promise<{
  meta: { universe: HyperliquidAssetMeta[] };
  assetCtxs: HyperliquidAssetCtx[];
}> {
  return withRetry(async () => {
    const res = await axios.post(`${BASE_URL}/info`, {
      type: "metaAndAssetCtxs",
    });
    // レスポンスは [meta, assetCtxs] の2要素配列
    const [meta, assetCtxs] = res.data as [
      { universe: HyperliquidAssetMeta[] },
      HyperliquidAssetCtx[]
    ];
    return { meta, assetCtxs };
  }, "HL メタ情報取得");
}

// 全銘柄のファンディングレート取得
export async function fetchFundingRates(): Promise<FundingRate[]> {
  const { meta, assetCtxs } = await fetchMetaAndAssetCtxs();
  const now = new Date();
  const rates: FundingRate[] = [];

  for (let i = 0; i < meta.universe.length; i++) {
    const asset = meta.universe[i];
    const ctx = assetCtxs[i];
    if (!ctx || !ctx.funding) continue;

    const rate = parseFloat(ctx.funding);
    // 1時間FRなので年率 = rate × 24 × 365
    const annualized = rate * 24 * 365 * 100;

    const fundingRate: FundingRate = {
      venue: "hyperliquid",
      symbol: asset.name,
      rate,
      annualized,
      nextFundingTime: new Date(
        now.getTime() +
          (60 - now.getMinutes()) * 60 * 1000 -
          now.getSeconds() * 1000
      ),
      timestamp: now,
    };
    rates.push(fundingRate);

    // DB保存
    saveFundingRate(
      "hyperliquid",
      asset.name,
      rate,
      annualized,
      fundingRate.nextFundingTime.toISOString(),
      now.toISOString()
    );
  }

  // 倍率銘柄のログ出力
  const multiplierSymbols = rates.filter(
    (r) => parseMultiplierSymbol(r.symbol).multiplier > 1
  );
  if (multiplierSymbols.length > 0) {
    console.log(
      `[HL] 倍率銘柄検出: ${multiplierSymbols.map((r) => r.symbol).join(", ")}`
    );
  }

  console.log(`[HL] FR取得完了: ${rates.length}銘柄`);
  return rates;
}

// 板からスプレッド計算
export function calculateSpread(orderBook: OrderBook): number {
  if (orderBook.asks.length === 0 || orderBook.bids.length === 0) return 0;
  const bestAsk = orderBook.asks[0].price;
  const bestBid = orderBook.bids[0].price;
  const midPrice = (bestAsk + bestBid) / 2;
  return (bestAsk - bestBid) / midPrice;
}
