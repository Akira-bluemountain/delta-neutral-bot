import axios, { AxiosInstance } from "axios";
import { VENUES } from "../core/config";
import { FundingRate, OrderBook } from "../core/types";
import { withRetry } from "../core/retry";
import { saveFundingRate } from "../db/database";

const BASE_URL = VENUES.extended.apiBaseUrl;
const USER_AGENT = "delta-neutral-engine/1.0";

// 共通 axios インスタンス（User-Agent必須）
const client: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  headers: { "User-Agent": USER_AGENT },
  timeout: 10000,
});

// Extended マーケット名 ↔ 内部シンボル変換
// Extended: "BTC-USD", "1000PEPE-USD" → 内部: "BTC", "1000PEPE"
export function toMarketName(symbol: string): string {
  return `${symbol}-USD`;
}

export function toInternalSymbol(marketName: string): string {
  return marketName.replace(/-USD$/, "");
}

// --- Extended API レスポンス型 ---
interface ExtMarket {
  name: string;
  active: boolean;
  status: string;
  marketStats: {
    fundingRate: string;
    nextFundingRate: number; // epoch ms
    markPrice: string;
    indexPrice: string;
    askPrice: string;
    bidPrice: string;
    lastPrice: string;
    openInterest: string;
  };
  tradingConfig: {
    minOrderSize: string;
    maxLeverage: string;
  };
}

interface ExtMarketsResponse {
  status: string;
  data: ExtMarket[];
}

interface ExtOrderBookResponse {
  status: string;
  data: {
    market: string;
    bid: Array<{ qty: string; price: string }>;
    ask: Array<{ qty: string; price: string }>;
  };
}

// 全銘柄のファンディングレート取得（/info/markets から現在FRを抽出）
export async function fetchFundingRates(): Promise<FundingRate[]> {
  const markets = await fetchMarkets();
  const now = new Date();
  const rates: FundingRate[] = [];

  for (const market of markets) {
    const rate = parseFloat(market.marketStats.fundingRate);
    if (isNaN(rate)) continue;

    const symbol = toInternalSymbol(market.name);
    // 1時間FRなので年率 = rate × 24 × 365
    const annualized = rate * 24 * 365 * 100;
    const nextFundingTime = new Date(market.marketStats.nextFundingRate);
    if (isNaN(nextFundingTime.getTime())) continue;

    const fundingRate: FundingRate = {
      venue: "extended",
      symbol,
      rate,
      annualized,
      nextFundingTime,
      timestamp: now,
    };
    rates.push(fundingRate);

    saveFundingRate(
      "extended",
      symbol,
      rate,
      annualized,
      nextFundingTime.toISOString(),
      now.toISOString()
    );
  }

  console.log(`[Extended] FR取得完了: ${rates.length}銘柄`);
  return rates;
}

// 板情報取得
export async function fetchOrderBook(symbol: string): Promise<OrderBook> {
  const marketName = toMarketName(symbol);

  return withRetry(async () => {
    const res = await client.get<ExtOrderBookResponse>(
      `/info/markets/${marketName}/orderbook`
    );

    if (res.data.status !== "OK" || !res.data.data) {
      throw new Error(`Extended orderbook エラー: ${marketName} status=${res.data.status}`);
    }

    const { bid, ask } = res.data.data;

    return {
      venue: "extended" as const,
      symbol,
      bids: (bid || []).map((l) => ({
        price: parseFloat(l.price),
        size: parseFloat(l.qty),
      })),
      asks: (ask || []).map((l) => ({
        price: parseFloat(l.price),
        size: parseFloat(l.qty),
      })),
      timestamp: new Date(),
    };
  }, `Extended 板情報取得 ${symbol}`);
}

// 利用可能シンボル一覧（内部シンボル形式で返す）
export async function fetchAvailableSymbols(): Promise<string[]> {
  const markets = await fetchMarkets();
  return markets.map((m) => toInternalSymbol(m.name));
}

// API疎通テスト
export async function isExtendedAvailable(): Promise<boolean> {
  try {
    const res = await client.get<ExtMarketsResponse>("/info/markets", {
      params: { market: "BTC-USD" },
      timeout: 5000,
    });
    return res.data.status === "OK";
  } catch {
    return false;
  }
}

// マーケット一覧取得（内部用、アクティブなもののみ）
async function fetchMarkets(): Promise<ExtMarket[]> {
  return withRetry(async () => {
    const res = await client.get<ExtMarketsResponse>("/info/markets");

    if (res.data.status !== "OK") {
      throw new Error(`Extended markets エラー: ${res.data.status}`);
    }

    return res.data.data.filter(
      (m) => m.active && m.status === "ACTIVE"
    );
  }, "Extended マーケット一覧取得");
}
