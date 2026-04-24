/**
 * Extended (x10) 注文執行エンジン
 * API key 認証 + Stark 署名付き注文
 *
 * Phase 1 安全性原則:
 * - 注文 POST には withRetry を絶対に使わない（重複発注防止）
 * - 全注文に externalId(UUID) を付け、送信失敗時は get-order-by-external-id で実在確認
 * - 取引所が拒否したか送達失敗かを classification で区別
 */
import axios, { AxiosInstance } from "axios";
import { randomUUID } from "node:crypto";
import { VENUES, API_KEYS, EXECUTION_PARAMS } from "../core/config";
import { withRetry, sleep } from "../core/retry";
import { ExtL2Config } from "./ext-signing";
import {
  classifyExtPlacement,
  classifyPostOnlyTimeoutOutcome,
} from "./classification-helpers";

const BASE_URL = VENUES.extended.apiBaseUrl;
const USER_AGENT = "delta-neutral-engine/1.0";
const EXT_SIGNER_URL = process.env.EXT_SIGNER_URL || "http://ext-signer:3001";

// 認証付き axios インスタンス（読み取り・キャンセル・レバレッジ用）
const client: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  headers: {
    "User-Agent": USER_AGENT,
    "Content-Type": "application/json",
    "X-Api-Key": API_KEYS.extendedApiKey,
  },
  timeout: 10000,
});

// Python 署名サービス用 axios インスタンス
const signerClient: AxiosInstance = axios.create({
  baseURL: EXT_SIGNER_URL,
  headers: { "Content-Type": "application/json" },
  timeout: 30000,
});

// --- マーケット情報キャッシュ ---

interface ExtMarketInfo {
  name: string; // "BTC-USD"
  assetPrecision: number;
  collateralAssetPrecision: number;
  l2Config: ExtL2Config;
  tradingConfig: {
    minOrderSize: number;
    minOrderSizeChange: number;
    minPriceChange: number;
    maxLeverage: number;
    maxPositionValue: number;
  };
}

let marketCache: Map<string, ExtMarketInfo> | null = null;

export async function refreshMarketCache(): Promise<void> {
  const res = await withRetry(
    async () => client.get("/info/markets"),
    "Extended マーケット情報取得"
  );

  marketCache = new Map();
  for (const m of res.data.data) {
    if (!m.active || m.status !== "ACTIVE") continue;
    marketCache.set(m.name, {
      name: m.name,
      assetPrecision: m.assetPrecision,
      collateralAssetPrecision: m.collateralAssetPrecision,
      l2Config: {
        collateralId: m.l2Config.collateralId,
        syntheticId: m.l2Config.syntheticId,
        syntheticResolution: m.l2Config.syntheticResolution,
        collateralResolution: m.l2Config.collateralResolution,
      },
      tradingConfig: {
        minOrderSize: parseFloat(m.tradingConfig.minOrderSize),
        minOrderSizeChange: parseFloat(m.tradingConfig.minOrderSizeChange),
        minPriceChange: parseFloat(m.tradingConfig.minPriceChange),
        maxLeverage: parseFloat(m.tradingConfig.maxLeverage),
        maxPositionValue: parseFloat(m.tradingConfig.maxPositionValue),
      },
    });
  }
  console.log(`[EXT執行] マーケットキャッシュ更新: ${marketCache.size}銘柄`);
}

async function getMarketCache(): Promise<Map<string, ExtMarketInfo>> {
  if (!marketCache) await refreshMarketCache();
  return marketCache!;
}

// 内部シンボル("BTC") → マーケット名("BTC-USD")
function toMarketName(symbol: string): string {
  return `${symbol}-USD`;
}

function getMarketInfo(symbol: string): ExtMarketInfo {
  const name = toMarketName(symbol);
  if (!marketCache?.has(name)) {
    throw new Error(`[EXT執行] 未知のマーケット: ${name}`);
  }
  return marketCache.get(name)!;
}

// --- 注文発注 ---

export interface ExtPlaceOrderParams {
  symbol: string;
  isBuy: boolean;
  size: number;
  price: number;
  orderType?: "LIMIT" | "MARKET";
  timeInForce?: "GTT" | "IOC";
  postOnly?: boolean;
  reduceOnly?: boolean;
  // 呼び出し側で事前生成して渡す（strategy 層で DB 永続化のため）
  externalId?: string;
}

// 注文結果の3分類
// - "filled" / "rejected": 取引所側状態が確定（DB 反映可）
// - "ambiguous": 送達不明、検証も失敗 → 自動操作禁止、人間判断必須
// 注文結果の4分類（Task A1.5 で "timeout" 追加）
// - "filled" / "rejected": 取引所側状態が確定（DB 反映可）
// - "timeout": POST_ONLY が時間内に約定せず、cancel 成功確認済み（板に残っていない）
// - "ambiguous": 送達不明、検証も失敗 → 自動操作禁止、人間判断必須
export type ExtOrderOutcome = "filled" | "rejected" | "ambiguous" | "timeout";

export interface ExtOrderResult {
  success: boolean;
  outcome: ExtOrderOutcome;
  orderId?: number;
  externalId: string; // 必ず生成して呼び出し元に返す（DB 永続化必須）
  filledSize?: number;
  avgPrice?: number;
  error?: string;
  /**
   * 実際に約定に使用された発注モード（Phase A Task A1）。
   * POST_ONLY → IOC フォールバックが走った場合は "IOC" になる。
   */
  mode?: "POST_ONLY" | "IOC" | "MARKET";
  /** POST_ONLY が取引所に即時拒否されたフラグ。監視・統計用 */
  aloRejected?: boolean;
}

/**
 * Extended の externalId で注文実在確認
 * - found=true → 取引所側に存在（filled / pending / cancelled いずれかの状態）
 * - found=false → 取引所が受領していないことが確定（再送可能）
 * - null → 検証自体が失敗（取引所と通信不能）。AMBIGUOUS のまま扱う
 */
export interface ExtVerifyResult {
  found: boolean | null; // null = 検証失敗
  orderId?: number;
  status?: string;
  filledQty?: number;
  qty?: number;
  averagePrice?: number;
  side?: "BUY" | "SELL";
  market?: string;
  error?: string;
}

export async function verifyOrderByExternalId(
  externalId: string
): Promise<ExtVerifyResult> {
  // 検証は読み取り専用なので withRetry 可（最大3回）
  try {
    return await withRetry(async () => {
      const res = await signerClient.get(
        `/get-order-by-external-id/${encodeURIComponent(externalId)}`
      );
      const d = res.data as Record<string, unknown>;

      if (d.found === false) return { found: false };
      if (d.found === null || d.found === undefined) {
        return { found: null, error: (d.error as string) ?? "verification failed" };
      }
      return {
        found: true,
        orderId: d.orderId ? Number(d.orderId) : undefined,
        status: d.status as string,
        filledQty: d.filledQty ? parseFloat(d.filledQty as string) : 0,
        qty: d.qty ? parseFloat(d.qty as string) : undefined,
        averagePrice:
          d.averagePrice && d.averagePrice !== "None"
            ? parseFloat(d.averagePrice as string)
            : undefined,
        side: d.side as "BUY" | "SELL" | undefined,
        market: d.market as string | undefined,
      };
    }, `Extended 注文照会 ${externalId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { found: null, error: msg };
  }
}

/**
 * Extended の status 文字列を outcome に変換
 * Extended の OrderStatus: NEW, UNTRIGGERED, PARTIALLY_FILLED, FILLED,
 *   CANCELLED, REJECTED, EXPIRED
 */
function statusToOutcome(status: string | undefined): ExtOrderOutcome {
  if (!status) return "ambiguous";
  const s = status.toUpperCase();
  if (s.includes("FILLED") || s.includes("PARTIALLY")) return "filled";
  if (s.includes("NEW") || s.includes("UNTRIGGERED")) return "filled"; // 取引所受領済み
  if (s.includes("REJECT") || s.includes("CANCEL") || s.includes("EXPIRE")) {
    return "rejected";
  }
  return "ambiguous";
}

/**
 * 指値/成行注文（Python 署名サービス経由）
 *
 * 重要: 注文 POST 自体は **絶対にリトライしない**。
 * - 失敗時は externalId で取引所側を照会し、実在を確認してから outcome を確定する
 * - 検証も失敗した場合は ambiguous を返す（呼び出し側で人間判断へエスカレーション）
 */
export async function placeOrder(
  params: ExtPlaceOrderParams
): Promise<ExtOrderResult> {
  // 冪等性キー: 必ず1注文1 UUID（呼び出し元提供を優先、なければ生成）
  const externalId = params.externalId ?? randomUUID();

  await getMarketCache();
  const info = getMarketInfo(params.symbol);
  const marketName = toMarketName(params.symbol);

  // サイズ検証
  if (params.size < info.tradingConfig.minOrderSize) {
    return {
      success: false,
      outcome: "rejected",
      externalId,
      error: `最小注文数量未満: ${params.size} < ${info.tradingConfig.minOrderSize}`,
    };
  }

  // 価格サニティチェック
  if (!params.price || params.price <= 0 || !isFinite(params.price)) {
    return {
      success: false,
      outcome: "rejected",
      externalId,
      error: `不正な価格: ${params.price}`,
    };
  }

  // サイズを minOrderSizeChange の倍数に丸める（code 1121 Invalid quantity 対策）
  // 買い/売り共に floor（少なめに発注）で最小注文を下回らないように検証
  const sizeStep = info.tradingConfig.minOrderSizeChange;
  const sizeStr = roundToStepString(params.size, sizeStep, "floor");
  const sizeRounded = parseFloat(sizeStr);
  if (sizeRounded < info.tradingConfig.minOrderSize) {
    return {
      success: false,
      outcome: "rejected",
      externalId,
      error: `丸め後サイズが最小未満: ${sizeRounded} < ${info.tradingConfig.minOrderSize}`,
    };
  }

  // 価格を minPriceChange の倍数に整数空間で厳密に丸める（code 1141 Invalid price value 対策）
  // 買いは ceil（少し高め）、売りは floor（少し安め）で確実に板にマッチさせる
  const priceStr = roundToStepString(
    params.price,
    info.tradingConfig.minPriceChange,
    params.isBuy ? "ceil" : "floor"
  );

  const signerRequest = {
    externalId,
    market: marketName,
    side: params.isBuy ? "BUY" : "SELL",
    size: sizeStr,
    price: priceStr,
    orderType: params.orderType ?? "LIMIT",
    timeInForce: params.timeInForce ?? "GTT",
    postOnly: params.postOnly ?? false,
    reduceOnly: params.reduceOnly ?? false,
    expiryEpochMillis: Date.now() + 60 * 60 * 1000,
  };

  // ---- 単発送信（リトライ厳禁）----
  let httpRes: { data: Record<string, unknown> } | null = null;
  let sendError: string | null = null;
  let sendErrorClassification: "rejected" | "ambiguous" = "ambiguous";

  try {
    httpRes = await signerClient.post("/place-order", signerRequest);
  } catch (err) {
    const e = err as {
      response?: { data?: { error?: string; classification?: string } };
      message?: string;
    };
    sendError = e.response?.data?.error ?? e.message ?? String(err);
    const cls = e.response?.data?.classification;
    sendErrorClassification = cls === "rejected" ? "rejected" : "ambiguous";
    console.error(
      `[EXT執行] 署名サービス例外 ${marketName} ext=${externalId}: ${sendError} (${sendErrorClassification})`
    );
  }

  // ---- レスポンス受信成功 ----
  if (httpRes) {
    const d = httpRes.data;
    if (d.success === true) {
      // Phase 3: signer が返す filledQty / averagePrice を取得
      // IOC の場合 partial fill がありうるため、実約定量を正とする
      const rawFilledQty = d.filledQty as string | null;
      const rawAvgPrice = d.averagePrice as string | null;
      const orderStatus = d.orderStatus as string | null;
      const actualFilled =
        rawFilledQty && rawFilledQty !== "0" && rawFilledQty !== "None"
          ? parseFloat(rawFilledQty)
          : undefined;
      const actualAvgPrice =
        rawAvgPrice && rawAvgPrice !== "None"
          ? parseFloat(rawAvgPrice)
          : undefined;

      // Task A1.5: 注文タイプ別に filledQty=0 の意味を解釈する。
      //
      // - GTT (+ postOnly): filledQty=0, status=NEW は「板に resting している」正常状態。
      //   これを rejected と誤判定して IOC フォールバックすると、板に resting が残ったまま
      //   IOC と二重約定する（XMR#881 で実測された重複発注の根本原因）。
      // - IOC: filledQty=0 は「期限内に約定しなかった」= 実質的な拒否。
      //
      // 分類ロジックは classification-helpers.ts の classifyExtPlacement で一元管理。
      const classification = classifyExtPlacement({
        orderStatus,
        rawFilledQty,
        actualFilled,
        timeInForce: signerRequest.timeInForce,
        postOnly: signerRequest.postOnly,
      });

      if (classification === "rejected") {
        console.warn(
          `[EXT執行] 注文受付済みだが未約定: ${marketName} status=${orderStatus} filledQty=${rawFilledQty} ext=${externalId}`
        );
        return {
          success: false,
          outcome: "rejected",
          externalId,
          error: `注文受付済みだが未約定 (status=${orderStatus}, filledQty=${rawFilledQty})`,
        };
      }

      // classification === "resting" の場合は success=true, filledSize=undefined を返し、
      // 呼び出し元（openExtPostOnly）のポーリングで約定/タイムアウトを判定する。

      // partial fill の検出（IOC: 要求量 > 実約定量）
      if (actualFilled !== undefined && actualFilled < params.size * 0.99) {
        console.warn(
          `[EXT執行] PARTIAL FILL検出: ${marketName} 要求=${params.size} 実約定=${actualFilled} (${((actualFilled / params.size) * 100).toFixed(1)}%) ext=${externalId}`
        );
      }

      console.log(
        `[EXT執行] 注文成功: ${marketName} ${signerRequest.side} filled=${actualFilled ?? "?"} avgPx=${actualAvgPrice ?? "?"} status=${orderStatus ?? "?"} ext=${externalId}`
      );
      return {
        success: true,
        outcome: "filled",
        orderId: Number(d.orderId),
        externalId: String(d.externalId ?? externalId),
        filledSize: actualFilled,
        avgPrice: actualAvgPrice,
      };
    }

    // signer が success:false で classification を返してきた場合
    const errMsg = (d.error as string) ?? "unknown";
    const cls = (d.classification as string) ?? "ambiguous";

    if (cls === "rejected") {
      console.error(
        `[EXT執行] 注文拒否確定 ${marketName} ext=${externalId}: ${errMsg}`
      );
      return {
        success: false,
        outcome: "rejected",
        externalId,
        error: errMsg,
      };
    }
    // cls === "ambiguous" → 検証フローへ
    sendError = errMsg;
    sendErrorClassification = "ambiguous";
  }

  // ---- ここに来た時点で送達状態が不明 → 取引所に実在照会 ----
  console.warn(
    `[EXT執行] 送達不明 ${marketName} ext=${externalId}: 取引所照会で実在確認します`
  );

  if (sendErrorClassification === "rejected") {
    // signer が「明確な拒否」を返した場合は照会不要
    return {
      success: false,
      outcome: "rejected",
      externalId,
      error: sendError ?? "rejected",
    };
  }

  const verify = await verifyOrderByExternalId(externalId);

  if (verify.found === true) {
    const outcome = statusToOutcome(verify.status);
    console.log(
      `[EXT執行] 検証で実在確認 ${marketName} ext=${externalId} status=${verify.status} outcome=${outcome}`
    );
    if (outcome === "filled") {
      return {
        success: true,
        outcome: "filled",
        orderId: verify.orderId,
        externalId,
        filledSize: verify.filledQty,
        avgPrice: verify.averagePrice,
      };
    }
    return {
      success: false,
      outcome: "rejected",
      externalId,
      error: `verified status=${verify.status}`,
    };
  }

  if (verify.found === false) {
    console.log(
      `[EXT執行] 検証で未受領確定 ${marketName} ext=${externalId} → 安全に拒否扱い`
    );
    return {
      success: false,
      outcome: "rejected",
      externalId,
      error: sendError ?? "not received by exchange",
    };
  }

  // verify.found === null → 取引所と通信不能。AMBIGUOUS
  console.error(
    `[EXT執行] AMBIGUOUS ${marketName} ext=${externalId}: 送達+検証失敗 → 人間判断必須`
  );
  return {
    success: false,
    outcome: "ambiguous",
    externalId,
    error: `${sendError ?? "send failed"} | verify: ${verify.error ?? "failed"}`,
  };
}

// ============================================================
// Phase A Task A1: POST_ONLY + IOC フォールバック
// ============================================================

/** L2 orderbook キャッシュ（同一サイクル内の重複取得を抑制） */
interface ExtL2Cache {
  bestBid: number;
  bestAsk: number;
  fetchedAt: number;
}
const extL2Cache = new Map<string, ExtL2Cache>();

/**
 * Extended の best bid/ask を取得。
 * - EXECUTION_PARAMS.l2TimeoutMs で打ち切り
 * - EXECUTION_PARAMS.l2CacheTtlMs でキャッシュ
 * - 取得失敗時は null（呼び出し側は mid オフセット fallback）
 *
 * Extended は統計エンドポイント（/info/markets/:m/stats）で bidPrice/askPrice を提供。
 * これは stats のためキャッシュ TTL は短めで運用。
 */
export async function getExtBestBidAsk(
  symbol: string
): Promise<{ bestBid: number; bestAsk: number } | null> {
  const cached = extL2Cache.get(symbol);
  if (cached && Date.now() - cached.fetchedAt < EXECUTION_PARAMS.l2CacheTtlMs) {
    return { bestBid: cached.bestBid, bestAsk: cached.bestAsk };
  }

  try {
    const marketName = `${symbol}-USD`;
    const res = await client.get(`/info/markets/${marketName}/stats`, {
      timeout: EXECUTION_PARAMS.l2TimeoutMs,
    });
    const d = res.data.data;
    const bestBid = parseFloat(d.bidPrice);
    const bestAsk = parseFloat(d.askPrice);
    if (!isFinite(bestBid) || !isFinite(bestAsk) || bestBid <= 0 || bestAsk <= 0) {
      console.info(`[EXT執行] L2 best bid/ask 数値不正 ${symbol}`);
      return null;
    }
    extL2Cache.set(symbol, { bestBid, bestAsk, fetchedAt: Date.now() });
    return { bestBid, bestAsk };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.info(`[EXT執行] L2 取得失敗 ${symbol}: ${msg} → mid fallback`);
    return null;
  }
}

/**
 * externalId で Extended 注文の最新状態を1回だけ照会（Phase A Task A1）。
 * POST_ONLY ポーリング用。`verifyOrderByExternalId` は withRetry 付きで
 * 待ち時間が読めないため分離。
 */
export async function pollExtOrderStatus(externalId: string): Promise<{
  found: boolean | null;
  status?: string;
  orderId?: number;
  filledSize?: number;
  avgPrice?: number;
}> {
  try {
    const res = await signerClient.get(
      `/get-order-by-external-id/${encodeURIComponent(externalId)}`,
      { timeout: 3_000 }
    );
    const d = res.data as Record<string, unknown>;
    if (d.found === false) return { found: false };
    if (d.found === null || d.found === undefined) return { found: null };
    return {
      found: true,
      orderId: d.orderId ? Number(d.orderId) : undefined,
      status: d.status as string,
      filledSize: d.filledQty ? parseFloat(d.filledQty as string) : 0,
      avgPrice:
        d.averagePrice && d.averagePrice !== "None"
          ? parseFloat(d.averagePrice as string)
          : undefined,
    };
  } catch {
    return { found: null };
  }
}

/**
 * externalId 指定で Extended 注文をキャンセル（Phase A Task A1）。
 * signer の /cancel-order エンドポイントに externalId で投げる。
 */
export async function cancelExtByExternalId(
  externalId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await signerClient.post("/cancel-order", { externalId });
    return { success: res.data?.success === true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

/**
 * POST_ONLY で発注し、EXECUTION_PARAMS.postOnlyTimeoutSec 以内の約定を待つ（Task A1.5 で方針 Y に変更）。
 *
 * タイムアウト時は IOC フォールバックせず、cancel 成功を確認して "timeout" を返す。
 * cancel 失敗時は "ambiguous"。IOC 選択は呼び出し元（戦略層）の責務。
 *
 * 戻り値 outcome:
 * - "filled":    時間内に約定（部分約定含む、filledSize > 0）
 * - "timeout":   時間内に約定せず、cancel 成功確認済み（板に残っていない）
 * - "rejected":  取引所が即時拒否（status=CANCELLED/EXPIRED/REJECTED）
 * - "ambiguous": cancel 失敗 / 送達不明 → 板に残存可能性、自動回復禁止
 *
 * Extended は maker 料率 0% のため、POST_ONLY の手数料メリットが最大。
 */
export async function openExtPostOnly(params: {
  symbol: string;
  isBuy: boolean;
  size: number;
  reduceOnly?: boolean;
  externalId?: string;
}): Promise<ExtOrderResult> {
  await getMarketCache();
  const externalId = params.externalId ?? randomUUID();

  // --- 指値価格の算出 ---
  const stats = await getMarketStats(params.symbol);
  const mid = (stats.bidPrice + stats.askPrice) / 2;
  const l2 = await getExtBestBidAsk(params.symbol);
  const offsetRatio = EXECUTION_PARAMS.postOnlyOffsetBps / 10000;
  let plannedLimitPrice: number;
  if (params.isBuy) {
    const midOffset = mid * (1 - offsetRatio);
    plannedLimitPrice = l2 ? Math.min(midOffset, l2.bestBid) : midOffset;
  } else {
    const midOffset = mid * (1 + offsetRatio);
    plannedLimitPrice = l2 ? Math.max(midOffset, l2.bestAsk) : midOffset;
  }

  if (process.env.LOG_LEVEL === "debug") {
    console.debug(
      `[EXT執行] openPostOnly called ${params.symbol} side=${params.isBuy ? "buy" : "sell"} size=${params.size} ext=${externalId} mid=${mid} l2=${l2 ? `${l2.bestBid}/${l2.bestAsk}` : "none"} plannedLimitPrice=${plannedLimitPrice}`
    );
  }

  // --- POST_ONLY (LIMIT + postOnly) 発注 ---
  const postResult = await placeOrder({
    symbol: params.symbol,
    isBuy: params.isBuy,
    size: params.size,
    price: plannedLimitPrice,
    orderType: "LIMIT",
    timeInForce: "GTT",
    postOnly: true,
    reduceOnly: params.reduceOnly ?? false,
    externalId,
  });

  // POST_ONLY 即時拒否 → rejected を返す（IOC フォールバックしない）
  if (postResult.outcome === "rejected") {
    console.info(
      `[EXT執行] POST_ONLY拒否 ${params.symbol} ext=${externalId} error=${postResult.error ?? "unknown"}`
    );
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { recordAloResult } = require("../risk/monitor") as typeof import("../risk/monitor");
      recordAloResult(true);
    } catch {
      // ignore
    }
    return { ...postResult, mode: "POST_ONLY", aloRejected: true };
  }

  // 受領成功としてカウント
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { recordAloResult } = require("../risk/monitor") as typeof import("../risk/monitor");
    recordAloResult(false);
  } catch {
    // ignore
  }

  // ambiguous はそのまま返す（板残存可能性、自動回復禁止）
  if (postResult.outcome === "ambiguous") {
    return { ...postResult, mode: "POST_ONLY" };
  }

  // --- 約定ポーリング ---
  const timeoutMs = EXECUTION_PARAMS.postOnlyTimeoutSec * 1000;
  const start = Date.now();
  let lastFilledSize = postResult.filledSize ?? 0;
  let lastAvgPrice = postResult.avgPrice;
  let lastOrderId = postResult.orderId;
  let restingCancelledEarly = false;

  // 発注直後に既に filled なら即 return
  if (lastFilledSize >= params.size * 0.99) {
    return { ...postResult, mode: "POST_ONLY", filledSize: lastFilledSize };
  }

  while (Date.now() - start < timeoutMs) {
    const status = await pollExtOrderStatus(externalId);
    if (status.found === true) {
      if (status.filledSize !== undefined) {
        lastFilledSize = Math.max(lastFilledSize, status.filledSize);
      }
      if (status.avgPrice !== undefined) lastAvgPrice = status.avgPrice;
      if (status.orderId !== undefined) lastOrderId = status.orderId;
      if (lastFilledSize >= params.size * 0.99) {
        return {
          success: true,
          outcome: "filled",
          externalId,
          orderId: lastOrderId,
          filledSize: lastFilledSize,
          avgPrice: lastAvgPrice,
          mode: "POST_ONLY",
        };
      }
      const s = (status.status ?? "").toUpperCase();
      if (s.includes("CANCEL") || s.includes("EXPIRE") || s.includes("REJECT")) {
        // 板から外れた → ループ脱出して最終判定へ
        restingCancelledEarly = true;
        break;
      }
    }
    await sleep(EXECUTION_PARAMS.pollIntervalMs);
  }

  // --- タイムアウト / 早期キャンセル → cancel → 成功確認 ---
  // 既に板から外れていても cancel 呼び出しは冪等（signer 実装依存だが HL と同様に安全）
  const cancelResult = await cancelExtByExternalId(externalId);
  const finalStatus = await pollExtOrderStatus(externalId);
  if (finalStatus.filledSize !== undefined) {
    lastFilledSize = Math.max(lastFilledSize, finalStatus.filledSize);
  }
  if (finalStatus.avgPrice !== undefined) lastAvgPrice = finalStatus.avgPrice;
  if (finalStatus.orderId !== undefined) lastOrderId = finalStatus.orderId;

  // 早期に板から外れていた場合、cancel 成功確認、または取引所照会で CANCEL/EXPIRE/REJECT/FILL
  // が確認できた場合は「板に残っていない」とみなす。
  const finalStatusUpper = (finalStatus.status ?? "").toUpperCase();
  const verifiedNotResting =
    restingCancelledEarly ||
    finalStatus.found === false ||
    finalStatusUpper.includes("CANCEL") ||
    finalStatusUpper.includes("EXPIRE") ||
    finalStatusUpper.includes("REJECT") ||
    finalStatusUpper.includes("FILL");

  const outcome = classifyPostOnlyTimeoutOutcome({
    cancelSuccess: cancelResult.success,
    verifiedNotResting,
    filledSize: lastFilledSize,
  });

  if (outcome === "ambiguous") {
    console.warn(
      `[EXT執行] POST_ONLY cancel失敗 ${params.symbol} ext=${externalId} error=${cancelResult.error ?? "unknown"} filled=${lastFilledSize}/${params.size} → ambiguous`
    );
    return {
      success: false,
      outcome: "ambiguous",
      externalId,
      orderId: lastOrderId,
      filledSize: lastFilledSize,
      avgPrice: lastAvgPrice,
      error: `cancel failed: ${cancelResult.error ?? "unknown"}`,
      mode: "POST_ONLY",
    };
  }

  if (outcome === "filled") {
    if (lastFilledSize < params.size * 0.99) {
      console.info(
        `[EXT執行] POST_ONLY 部分約定 ${params.symbol} ext=${externalId} filled=${lastFilledSize}/${params.size}`
      );
    }
    return {
      success: true,
      outcome: "filled",
      externalId,
      orderId: lastOrderId,
      filledSize: lastFilledSize,
      avgPrice: lastAvgPrice,
      mode: "POST_ONLY",
    };
  }

  // outcome === "timeout"
  console.info(
    `[EXT執行] POST_ONLY タイムアウト ${params.symbol} ext=${externalId} filled=0/${params.size} → timeout (次サイクル再試行)`
  );
  return {
    success: false,
    outcome: "timeout",
    externalId,
    filledSize: 0,
    mode: "POST_ONLY",
  };
}

/**
 * モード指定で発注する統合 API（Phase A Task A1）。
 */
export async function openExtWithMode(params: {
  symbol: string;
  isBuy: boolean;
  size: number;
  mode: "POST_ONLY" | "IOC" | "MARKET";
  reduceOnly?: boolean;
  externalId?: string;
}): Promise<ExtOrderResult> {
  if (params.mode === "POST_ONLY") {
    return openExtPostOnly({
      symbol: params.symbol,
      isBuy: params.isBuy,
      size: params.size,
      reduceOnly: params.reduceOnly,
      externalId: params.externalId,
    });
  }
  const result = await marketOrder({
    symbol: params.symbol,
    isBuy: params.isBuy,
    size: params.size,
    reduceOnly: params.reduceOnly,
    externalId: params.externalId,
  });
  return { ...result, mode: params.mode };
}

/**
 * 成行注文（IOC + スリッページ）
 */
export async function marketOrder(params: {
  symbol: string;
  isBuy: boolean;
  size: number;
  slippage?: number;
  reduceOnly?: boolean;
  externalId?: string;
}): Promise<ExtOrderResult> {
  await getMarketCache();
  const info = getMarketInfo(params.symbol);

  // 現在価格取得
  const stats = await getMarketStats(params.symbol);
  const refPrice = params.isBuy ? stats.askPrice : stats.bidPrice;
  if (!refPrice || refPrice <= 0 || !isFinite(refPrice)) {
    return {
      success: false,
      outcome: "rejected",
      externalId: randomUUID(), // 注文未送信なので使い捨て
      error: `参考価格取得不可: ${params.symbol}`,
    };
  }
  const MAX_SLIPPAGE = 0.10; // 最大10%
  const slippage = Math.min(params.slippage ?? 0.005, MAX_SLIPPAGE);
  const price = params.isBuy
    ? refPrice * (1 + slippage)
    : refPrice * (1 - slippage);

  // minPriceChange への丸めは placeOrder 内で整数空間で厳密に実施
  return placeOrder({
    symbol: params.symbol,
    isBuy: params.isBuy,
    size: params.size,
    price,
    orderType: "MARKET",
    timeInForce: "IOC",
    reduceOnly: params.reduceOnly ?? false,
    externalId: params.externalId,
  });
}

// --- キャンセル ---

export async function cancelOrder(
  orderId: number
): Promise<{ success: boolean; error?: string }> {
  return withRetry(async () => {
    const res = await client.delete(`/user/orders/${orderId}`);
    if (res.data.status === "OK") {
      console.log(`[EXT執行] キャンセル成功: orderId=${orderId}`);
      return { success: true };
    }
    return {
      success: false,
      error: res.data.error?.message ?? `status=${res.data.status}`,
    };
  }, `Extended キャンセル ${orderId}`);
}

export async function cancelAllOrders(
  symbol?: string
): Promise<{ success: boolean; error?: string }> {
  const body: Record<string, unknown> = {};
  if (symbol) {
    body.markets = [toMarketName(symbol)];
  } else {
    body.cancelAll = true;
  }

  return withRetry(async () => {
    const res = await client.post("/user/orders/cancel-all", body);
    if (res.data.status === "OK") {
      console.log(
        `[EXT執行] 全キャンセル成功${symbol ? `: ${symbol}` : ""}`
      );
      return { success: true };
    }
    return {
      success: false,
      error: res.data.error?.message ?? `status=${res.data.status}`,
    };
  }, "Extended 全キャンセル");
}

// --- ポジション・残高照会（API key のみ） ---

export interface ExtPosition {
  id: number;
  market: string;
  side: "LONG" | "SHORT";
  leverage: number;
  size: number;
  value: number;
  openPrice: number;
  markPrice: number;
  liquidationPrice: number | null;
  unrealizedPnl: number;
  realizedPnl: number;
}

export interface ExtAccountState {
  equity: number;
  balance: number;
  availableBalance: number;
  unrealizedPnl: number;
  positions: ExtPosition[];
}

export async function getAccountState(): Promise<ExtAccountState> {
  const [balanceRes, posRes] = await Promise.all([
    withRetry(
      async () => client.get("/user/balance"),
      "Extended 残高取得"
    ),
    withRetry(
      async () => client.get("/user/positions"),
      "Extended ポジション取得"
    ),
  ]);

  const bal = balanceRes.data.data ?? {};
  const positions: ExtPosition[] = (posRes.data.data ?? []).map(
    (p: Record<string, unknown>) => ({
      id: p.id as number,
      market: p.market as string,
      side: p.side as "LONG" | "SHORT",
      leverage: parseFloat((p.leverage as string) ?? "0"),
      size: parseFloat((p.size as string) ?? "0"),
      value: parseFloat((p.value as string) ?? "0"),
      openPrice: parseFloat((p.openPrice as string) ?? "0"),
      markPrice: parseFloat((p.markPrice as string) ?? "0"),
      liquidationPrice: p.liquidationPrice
        ? parseFloat(p.liquidationPrice as string)
        : null,
      unrealizedPnl: parseFloat((p.unrealisedPnl as string) ?? "0"),
      realizedPnl: parseFloat((p.realisedPnl as string) ?? "0"),
    })
  );

  return {
    equity: parseFloat(bal.equity ?? "0"),
    balance: parseFloat(bal.balance ?? "0"),
    availableBalance: parseFloat(bal.availableForTrade ?? bal.availableBalance ?? "0"),
    unrealizedPnl: parseFloat(bal.unrealisedPnl ?? "0"),
    positions,
  };
}

// オープン注文取得
export interface ExtOpenOrder {
  id: number;
  market: string;
  side: "BUY" | "SELL";
  type: string;
  price: number;
  qty: number;
  filledQty: number;
  status: string;
  createdTime: number;
}

export async function getOpenOrders(
  symbol?: string
): Promise<ExtOpenOrder[]> {
  const params: Record<string, string> = {};
  if (symbol) params.market = toMarketName(symbol);

  return withRetry(async () => {
    const res = await client.get("/user/orders", { params });
    return (res.data.data ?? []).map((o: Record<string, unknown>) => ({
      id: o.id as number,
      market: o.market as string,
      side: o.side as "BUY" | "SELL",
      type: o.type as string,
      price: parseFloat((o.price as string) ?? "0"),
      qty: parseFloat((o.qty as string) ?? "0"),
      filledQty: parseFloat((o.filledQty as string) ?? "0"),
      status: o.status as string,
      createdTime: o.createdTime as number,
    }));
  }, "Extended オープン注文取得");
}

// マーケット統計（現在価格取得用）
interface MarketStats {
  lastPrice: number;
  askPrice: number;
  bidPrice: number;
  markPrice: number;
  indexPrice: number;
}

async function getMarketStats(symbol: string): Promise<MarketStats> {
  const marketName = toMarketName(symbol);
  return withRetry(async () => {
    const res = await client.get(`/info/markets/${marketName}/stats`);
    const d = res.data.data;
    return {
      lastPrice: parseFloat(d.lastPrice),
      askPrice: parseFloat(d.askPrice),
      bidPrice: parseFloat(d.bidPrice),
      markPrice: parseFloat(d.markPrice),
      indexPrice: parseFloat(d.indexPrice),
    };
  }, `Extended 統計取得 ${marketName}`);
}

// レバレッジ設定
export async function updateLeverage(
  symbol: string,
  leverage: number
): Promise<{ success: boolean; error?: string }> {
  const marketName = toMarketName(symbol);
  return withRetry(async () => {
    const res = await client.patch("/user/leverage", {
      market: marketName,
      leverage: leverage.toFixed(2),
    });
    if (res.data.status === "OK") {
      console.log(`[EXT執行] レバレッジ更新: ${marketName} ${leverage}x`);
      return { success: true };
    }
    return {
      success: false,
      error: res.data.error?.message ?? `status=${res.data.status}`,
    };
  }, `Extended レバレッジ更新 ${marketName}`);
}

// --- ユーティリティ ---

function countDecimalPlaces(n: number): number {
  const s = n.toString();
  const dot = s.indexOf(".");
  return dot < 0 ? 0 : s.length - dot - 1;
}

/**
 * 値を step の倍数に厳密に丸める（整数空間で計算して浮動小数点誤差を回避）
 * @param value 丸める対象の値
 * @param step 刻み幅（e.g. 0.00001, 0.1, 10）
 * @param mode "ceil" | "floor" | "round"
 * @returns step の倍数に丸められた値（文字列形式、正確な小数表現）
 */
function roundToStepString(
  value: number,
  step: number,
  mode: "ceil" | "floor" | "round"
): string {
  const decimals = countDecimalPlaces(step);
  const scale = Math.pow(10, decimals);
  // 整数空間に変換（step が 0.00001 なら scale = 100000）
  const valueInt = Math.round(value * scale);
  const stepInt = Math.round(step * scale);
  // step 単位数を計算
  const units = valueInt / stepInt;
  const fn = mode === "ceil" ? Math.ceil : mode === "floor" ? Math.floor : Math.round;
  const roundedUnits = fn(units);
  const resultInt = roundedUnits * stepInt;
  // 整数から文字列化（toFixed で小数点桁数を厳密に合わせる）
  return (resultInt / scale).toFixed(decimals);
}
