/**
 * Hyperliquid 注文執行エンジン
 * 署名付き注文発注、キャンセル、ポジション取得、レバレッジ設定
 *
 * Phase 1 安全性原則:
 * - 注文 POST には withRetry を絶対に使わない（重複発注防止）
 * - 全注文に cloid (16byte hex) を付け、送信失敗時は orderStatus で実在確認
 */
import axios from "axios";
import { randomBytes } from "node:crypto";
import { ethers } from "ethers";
import { VENUES, API_KEYS, EXECUTION_PARAMS } from "../core/config";
import { HyperliquidAssetMeta } from "../core/types";
import { classifyPostOnlyTimeoutOutcome } from "./classification-helpers";
import { withRetry, sleep } from "../core/retry";
import { fetchMetaAndAssetCtxs } from "../collectors/hyperliquid";
import {
  OrderWire,
  OrderTypeWire,
  Tif,
  Grouping,
  ExchangeAction,
  SignedPayload,
  buildOrderWire,
  buildOrderAction,
  signL1Action,
  floatToWire,
  getTimestampMs,
} from "./hl-signing";

const BASE_URL = VENUES.hyperliquid.apiBaseUrl;
const IS_MAINNET = true;
const DEFAULT_SLIPPAGE = 0.05; // 5%

// --- アセットインデックスキャッシュ ---
let assetCache: Map<string, { index: number; szDecimals: number; maxLeverage: number }> | null = null;

async function getAssetCache(): Promise<typeof assetCache & {}> {
  if (assetCache) return assetCache;
  await refreshAssetCache();
  return assetCache!;
}

export async function refreshAssetCache(): Promise<void> {
  const { meta } = await fetchMetaAndAssetCtxs();
  assetCache = new Map();
  for (let i = 0; i < meta.universe.length; i++) {
    const asset = meta.universe[i];
    assetCache.set(asset.name, {
      index: i,
      szDecimals: asset.szDecimals,
      maxLeverage: asset.maxLeverage,
    });
  }
  console.log(`[HL執行] アセットキャッシュ更新: ${assetCache.size}銘柄`);
}

function getAssetInfo(symbol: string) {
  if (!assetCache?.has(symbol)) {
    throw new Error(`[HL執行] 未知のシンボル: ${symbol}（キャッシュ更新が必要）`);
  }
  return assetCache.get(symbol)!;
}

// --- ウォレット ---
let walletInstance: ethers.Wallet | null = null;

function getWallet(): ethers.Wallet {
  if (!walletInstance) {
    const pk = API_KEYS.hlWalletPrivateKey;
    if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
      throw new Error("[HL執行] HL_API_WALLET_PRIVATE_KEY の形式が不正です");
    }
    try {
      walletInstance = new ethers.Wallet(pk);
    } catch {
      throw new Error("[HL執行] ウォレット初期化失敗: 秘密鍵が無効です");
    }
    // 秘密鍵から導出されるアドレスと設定アドレスの一致を検証
    const derivedAddress = walletInstance.address.toLowerCase();
    const configAddress = API_KEYS.hlWalletAddress.toLowerCase();
    if (derivedAddress !== configAddress) {
      walletInstance = null;
      throw new Error(
        `[HL執行] アドレス不整合: 秘密鍵の導出アドレスと HL_API_WALLET_ADDRESS が一致しません`
      );
    }
  }
  return walletInstance;
}

// --- 価格・数量ユーティリティ ---

// サイズを szDecimals に丸める
function roundSize(size: number, szDecimals: number): number {
  const factor = Math.pow(10, szDecimals);
  return Math.floor(size * factor) / factor; // 切り捨て（注文超過防止）
}

// 価格をHL仕様で丸める
// - 最大5有効桁数
// - Perpの最大小数点桁数 = 6 - szDecimals
function roundPrice(price: number, szDecimals: number): number {
  if (price <= 0) return 0;
  const maxDecimals = Math.max(0, 6 - szDecimals);
  const maxSigFigs = 5;

  // 1. 有効桁数で丸める
  let rounded = parseFloat(price.toPrecision(maxSigFigs));

  // 2. 小数点桁数も制限
  const factor = Math.pow(10, maxDecimals);
  rounded = Math.round(rounded * factor) / factor;

  return rounded;
}

// スリッページ適用価格
function applySlippage(
  price: number,
  isBuy: boolean,
  slippage: number,
  szDecimals: number
): number {
  const adjusted = isBuy ? price * (1 + slippage) : price * (1 - slippage);
  return roundPrice(adjusted, szDecimals);
}

// --- 署名付きリクエスト送信 ---

/**
 * 署名付き注文 POST（**リトライ厳禁**）
 * 一度だけ送信し、結果は呼び出し元で classification + verify する。
 */
async function signAndPostOnce(
  action: ExchangeAction,
  vaultAddress: string | null = null
): Promise<unknown> {
  const wallet = getWallet();
  const nonce = getTimestampMs();

  const signature = await signL1Action(
    wallet,
    action,
    vaultAddress,
    nonce,
    IS_MAINNET
  );

  const payload: SignedPayload = {
    action,
    nonce,
    signature,
    vaultAddress,
  };

  const res = await axios.post(`${BASE_URL}/exchange`, payload, {
    timeout: 15_000,
  });
  return res.data;
}

/**
 * 状態変更を伴わないアクション（cancel, updateLeverage 等）用にリトライ可能版を残す。
 * cancel は冪等（既にキャンセル済みでも安全）、updateLeverage も同様。
 * **注文には絶対使わない**。
 */
async function signAndPostIdempotent(
  action: ExchangeAction,
  label: string,
  vaultAddress: string | null = null
): Promise<unknown> {
  return withRetry(
    () => signAndPostOnce(action, vaultAddress),
    `HL ${label}`
  );
}

// --- 注文発注 ---

export interface PlaceOrderParams {
  symbol: string;
  isBuy: boolean;
  size: number; // ベースアセット数量
  price: number;
  orderType?: { tif: Tif }; // デフォルト: GTC
  reduceOnly?: boolean;
  cloid?: string;
}

// 注文結果の4分類
// - "filled" / "rejected": 取引所側状態が確定（DB 反映可）
// - "timeout": POST_ONLY が時間内に約定せず、cancel 成功確認済み（板に残っていない）
// - "ambiguous": 送達不明、検証も失敗 → 自動操作禁止、人間判断必須
export type OrderOutcome = "filled" | "rejected" | "ambiguous" | "timeout";

export interface OrderResult {
  success: boolean;
  outcome: OrderOutcome;
  oid?: number;
  cloid: string; // 必ず生成して呼び出し元に返す
  filledSize?: number;
  avgPrice?: number;
  error?: string;
  /**
   * 実際に約定に使用された発注モード（Phase A Task A1）。
   * POST_ONLY → IOC フォールバックが走った場合は "IOC" になる。
   * 既存呼び出し元への互換維持のため optional。
   */
  mode?: "POST_ONLY" | "IOC" | "MARKET";
  /** Alo（POST_ONLY）が取引所に拒否されたフラグ。監視・統計用 */
  aloRejected?: boolean;
}

// HL cloid フォーマット: 0x + 32 hex 文字 (= 16 bytes)
export function generateCloid(): string {
  return "0x" + randomBytes(16).toString("hex");
}

/**
 * 指値注文（**注文 POST はリトライ厳禁**）
 *
 * フロー:
 * 1. cloid を必ず生成（呼び出し元指定があればそれを使う）
 * 2. signAndPostOnce で1回だけ送信
 * 3. レスポンス受信成功 → parseOrderResponse で outcome 判定
 * 4. 例外 / タイムアウト → cloid で実在検証
 *    - 検証 found=true → filled 扱い
 *    - 検証 found=false → rejected 扱い
 *    - 検証も失敗 → ambiguous（人間判断必須）
 */
export async function placeOrder(params: PlaceOrderParams): Promise<OrderResult> {
  const cache = await getAssetCache();
  const info = getAssetInfo(params.symbol);
  const cloid = params.cloid ?? generateCloid();

  const size = roundSize(params.size, info.szDecimals);
  if (size <= 0) {
    return {
      success: false,
      outcome: "rejected",
      cloid,
      error: "数量がszDecimalsの最小単位未満",
    };
  }

  // 価格サニティチェック: 0以下 or NaN を拒否
  if (!params.price || params.price <= 0 || !isFinite(params.price)) {
    return {
      success: false,
      outcome: "rejected",
      cloid,
      error: `不正な価格: ${params.price}`,
    };
  }

  // URGENT-FIX (2026-04-25): 二段目防御。呼び出し側が roundPrice を忘れても
  // floatToWire 境界違反を起こさないよう placeOrder 自身で最終丸めを行う。
  // 既に丸め済みでも同値なので副作用なし。
  const price = roundPrice(params.price, info.szDecimals);
  if (price <= 0) {
    return {
      success: false,
      outcome: "rejected",
      cloid,
      error: `丸め後の価格が 0 以下: raw=${params.price}`,
    };
  }

  const tif = params.orderType?.tif ?? "Gtc";
  const orderType: OrderTypeWire = { limit: { tif } };

  const wire = buildOrderWire({
    assetIndex: info.index,
    isBuy: params.isBuy,
    price,
    size,
    reduceOnly: params.reduceOnly ?? false,
    orderType,
    cloid,
  });

  const action = buildOrderAction([wire]);

  // ---- 単発送信（リトライ厳禁）----
  let httpRes: unknown = null;
  let sendError: string | null = null;
  try {
    httpRes = await signAndPostOnce(action);
  } catch (err) {
    sendError = err instanceof Error ? err.message : String(err);
    console.error(
      `[HL執行] 注文 POST 例外 ${params.symbol} cloid=${cloid}: ${sendError}`
    );
  }

  // レスポンス受信成功 → 通常パース
  if (httpRes !== null) {
    const parsed = parseOrderResponse(
      httpRes as {
        status: string;
        response?: { type: string; data?: { statuses: Array<Record<string, unknown>> } };
      },
      cloid
    );
    // 明確な成功 / 拒否はそのまま返す
    if (parsed.outcome !== "ambiguous") return parsed;
    // ambiguous（venue が中途半端なレスポンスを返した）→ 検証フローへ
    sendError = parsed.error ?? "ambiguous response";
  }

  // ---- 送達不明 → cloid で取引所照会 ----
  console.warn(
    `[HL執行] 送達不明 ${params.symbol} cloid=${cloid}: 取引所照会で実在確認します`
  );

  const verify = await verifyOrderByCloid(cloid);

  if (verify.found === true) {
    console.log(
      `[HL執行] 検証で実在確認 ${params.symbol} cloid=${cloid} status=${verify.status}`
    );
    return {
      success: true,
      outcome: "filled",
      oid: verify.oid,
      cloid,
      filledSize: verify.filledSize,
      avgPrice: verify.avgPrice,
    };
  }

  if (verify.found === false) {
    console.log(
      `[HL執行] 検証で未受領確定 ${params.symbol} cloid=${cloid} → 安全に拒否扱い`
    );
    return {
      success: false,
      outcome: "rejected",
      cloid,
      error: sendError ?? "not received by exchange",
    };
  }

  // verify.found === null → AMBIGUOUS
  console.error(
    `[HL執行] AMBIGUOUS ${params.symbol} cloid=${cloid}: 送達+検証失敗 → 人間判断必須`
  );
  return {
    success: false,
    outcome: "ambiguous",
    cloid,
    error: `${sendError ?? "send failed"} | verify: ${verify.error ?? "failed"}`,
  };
}

/**
 * cloid で HL 上の注文を実在照会
 * - found=true → 注文が取引所側に存在（filled / resting / cancelled いずれか）
 * - found=false → 取引所が未受領（"unknownOid" レスポンス）
 * - null → 検証自体が失敗
 */
export interface HlVerifyResult {
  found: boolean | null;
  oid?: number;
  status?: string;
  filledSize?: number;
  avgPrice?: number;
  error?: string;
}

export async function verifyOrderByCloid(
  cloid: string
): Promise<HlVerifyResult> {
  const address = API_KEYS.hlWalletAddress;
  try {
    return await withRetry(async () => {
      const res = await axios.post(
        `${BASE_URL}/info`,
        { type: "orderStatus", user: address, oid: cloid },
        { timeout: 10_000 }
      );
      const d = res.data as Record<string, unknown>;
      // HL returns { status: "order", order: { order: {...}, status: "..." } }
      // or { status: "unknownOid" }
      if (d.status === "unknownOid") {
        return { found: false };
      }
      if (d.status === "order" && d.order) {
        const orderWrapper = d.order as Record<string, unknown>;
        const inner = orderWrapper.order as Record<string, unknown> | undefined;
        const orderStatus = orderWrapper.status as string | undefined;

        // resting / filled / canceled / triggered etc.
        const oid = inner?.oid as number | undefined;
        const sz = inner?.sz as string | undefined;
        const origSz = inner?.origSz as string | undefined;
        // 残量(sz) と 発注量(origSz) から filledSize を推定
        const filled =
          sz !== undefined && origSz !== undefined
            ? parseFloat(origSz) - parseFloat(sz)
            : undefined;

        return {
          found: true,
          oid,
          status: orderStatus,
          filledSize: filled,
        };
      }
      // 想定外のレスポンス形状 → 検証失敗扱い
      return { found: null, error: `unexpected status: ${JSON.stringify(d).slice(0, 200)}` };
    }, `HL 注文照会 ${cloid}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { found: null, error: msg };
  }
}

// ============================================================
// Phase A Task A1: POST_ONLY + IOC フォールバック
// ============================================================

/** L2 orderbook キャッシュ（同一サイクル内の重複取得を抑制） */
interface L2Cache {
  bestBid: number;
  bestAsk: number;
  fetchedAt: number;
}
const l2Cache = new Map<string, L2Cache>();

/**
 * HL の L2 orderbook から best bid/ask を取得。
 * - EXECUTION_PARAMS.l2TimeoutMs で打ち切り
 * - EXECUTION_PARAMS.l2CacheTtlMs でキャッシュ
 * - 取得失敗時は null を返す（呼び出し側は mid オフセットに fallback）
 */
export async function getBestBidAsk(
  symbol: string
): Promise<{ bestBid: number; bestAsk: number } | null> {
  const cached = l2Cache.get(symbol);
  if (cached && Date.now() - cached.fetchedAt < EXECUTION_PARAMS.l2CacheTtlMs) {
    return { bestBid: cached.bestBid, bestAsk: cached.bestAsk };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EXECUTION_PARAMS.l2TimeoutMs);
    try {
      const res = await axios.post(
        `${BASE_URL}/info`,
        { type: "l2Book", coin: symbol },
        { signal: controller.signal, timeout: EXECUTION_PARAMS.l2TimeoutMs }
      );
      clearTimeout(timer);
      // HL l2Book レスポンス形状: { coin, time, levels: [bids[], asks[]] }
      // bids[0], asks[0] がベストプライス。各レベルは { px: string, sz: string, n: number }
      const levels = (res.data?.levels ?? []) as Array<
        Array<{ px: string; sz: string; n: number }>
      >;
      if (levels.length < 2 || !levels[0].length || !levels[1].length) {
        console.info(`[HL執行] L2 orderbook 形式不正 ${symbol} → mid オフセットに fallback`);
        return null;
      }
      const bestBid = parseFloat(levels[0][0].px);
      const bestAsk = parseFloat(levels[1][0].px);
      if (!isFinite(bestBid) || !isFinite(bestAsk) || bestBid <= 0 || bestAsk <= 0) {
        console.info(`[HL執行] L2 best bid/ask 数値不正 ${symbol}`);
        return null;
      }
      l2Cache.set(symbol, { bestBid, bestAsk, fetchedAt: Date.now() });
      return { bestBid, bestAsk };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.info(`[HL執行] L2 orderbook 取得失敗 ${symbol}: ${msg} → mid オフセットに fallback`);
    return null;
  }
}

/**
 * cloid 指定で HL 注文をキャンセル（Phase A Task A1）。
 * cancelByCloid は冪等（既にキャンセル済み・約定済みでも安全）→ リトライ可。
 */
export async function cancelByCloid(
  symbol: string,
  cloid: string
): Promise<{ success: boolean; error?: string }> {
  const info = getAssetInfo(symbol);
  const action: ExchangeAction = {
    type: "cancelByCloid",
    cancels: [{ asset: info.index, cloid }],
  };
  try {
    const res = (await signAndPostIdempotent(
      action,
      `cancelByCloid ${symbol} ${cloid}`
    )) as { status: string };
    if (res.status === "ok") {
      return { success: true };
    }
    return { success: false, error: `cancelByCloid status=${res.status}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

/**
 * 注文の現在状態を1回だけ照会（Phase A Task A1）。
 * `verifyOrderByCloid` は withRetry 付きで待ち時間が読めないため、ポーリング用に
 * withRetry なしの1回照会版を分離。
 */
export async function pollOrderStatus(
  cloid: string
): Promise<{
  found: boolean | null;
  status?: string;
  oid?: number;
  filledSize?: number;
  avgPrice?: number;
}> {
  const address = API_KEYS.hlWalletAddress;
  try {
    const res = await axios.post(
      `${BASE_URL}/info`,
      { type: "orderStatus", user: address, oid: cloid },
      { timeout: 3_000 }
    );
    const d = res.data as Record<string, unknown>;
    if (d.status === "unknownOid") return { found: false };
    if (d.status === "order" && d.order) {
      const wrapper = d.order as Record<string, unknown>;
      const inner = wrapper.order as Record<string, unknown> | undefined;
      const orderStatus = wrapper.status as string | undefined;
      const oid = inner?.oid as number | undefined;
      const sz = inner?.sz as string | undefined;
      const origSz = inner?.origSz as string | undefined;
      const filledSize =
        sz !== undefined && origSz !== undefined
          ? parseFloat(origSz) - parseFloat(sz)
          : undefined;
      return { found: true, status: orderStatus, oid, filledSize };
    }
    return { found: null };
  } catch {
    return { found: null };
  }
}

/**
 * POST_ONLY（Alo）で発注し、EXECUTION_PARAMS.postOnlyTimeoutSec 以内の約定を待つ。
 *
 * Task A1.5 で方針 Y に変更: タイムアウト時は IOC フォールバックせず、
 * cancel 成功を確認して "timeout" を返す。cancel 失敗時は "ambiguous"。
 * IOC 選択は呼び出し元（戦略層）の責務。
 *
 * 価格決定: min(mid × (1 - offsetBps), best_bid)（buy の場合）
 *           max(mid × (1 + offsetBps), best_ask)（sell の場合）
 * L2 取得失敗時は mid オフセットのみで決定。
 *
 * 戻り値 outcome:
 * - "filled":    時間内に約定（部分約定含む、filledSize > 0）
 * - "timeout":   時間内に約定せず、cancel 成功確認済み（板に残っていない）
 * - "rejected":  取引所が Alo を即時拒否（= 即時マッチ価格だった）
 * - "ambiguous": cancel 失敗 / 送達不明 → 板に残存可能性、自動回復禁止
 */
export async function openPostOnly(params: {
  symbol: string;
  isBuy: boolean;
  size: number;
  reduceOnly?: boolean;
  cloid?: string;
}): Promise<OrderResult> {
  await getAssetCache();
  const info = getAssetInfo(params.symbol);
  const cloid = params.cloid ?? generateCloid();

  // --- 指値価格の算出 ---
  // URGENT-FIX (2026-04-25): midPrice × (1 ± offsetBps/10000) は IEEE 754 の性質で
  // 8 桁超の小数を生むため、placeOrder に渡す前に roundPrice で HL 仕様
  // (5 有効桁 & 6 - szDecimals 小数桁) に丸める必要がある。
  // 未丸めだと buildOrderWire → floatToWire が throw し AMBIGUOUS 化する
  // （CHIP#888/#890 インシデント根本原因）。
  const midPrice = await getMidPrice(params.symbol);
  const l2 = await getBestBidAsk(params.symbol);
  const offsetRatio = EXECUTION_PARAMS.postOnlyOffsetBps / 10000;
  let plannedLimitPrice: number;
  if (params.isBuy) {
    const midOffset = midPrice * (1 - offsetRatio);
    const rawPrice = l2 ? Math.min(midOffset, l2.bestBid) : midOffset;
    plannedLimitPrice = roundPrice(rawPrice, info.szDecimals);
  } else {
    const midOffset = midPrice * (1 + offsetRatio);
    const rawPrice = l2 ? Math.max(midOffset, l2.bestAsk) : midOffset;
    plannedLimitPrice = roundPrice(rawPrice, info.szDecimals);
  }

  if (process.env.LOG_LEVEL === "debug") {
    console.debug(
      `[HL執行] openPostOnly called ${params.symbol} side=${params.isBuy ? "buy" : "sell"} size=${params.size} cloid=${cloid} mid=${midPrice} l2=${l2 ? `${l2.bestBid}/${l2.bestAsk}` : "none"} plannedLimitPrice=${plannedLimitPrice}`
    );
  }

  // --- POST_ONLY (Alo) 発注 ---
  const postResult = await placeOrder({
    symbol: params.symbol,
    isBuy: params.isBuy,
    size: params.size,
    price: plannedLimitPrice,
    orderType: { tif: "Alo" },
    reduceOnly: params.reduceOnly ?? false,
    cloid,
  });

  // Alo が即時拒否 → rejected を返す（IOC フォールバックしない、呼び出し元判断）
  if (postResult.outcome === "rejected") {
    console.info(
      `[HL執行] POST_ONLY拒否 ${params.symbol} cloid=${cloid} error=${postResult.error ?? "unknown"}`
    );
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { recordAloResult } = require("../risk/monitor") as typeof import("../risk/monitor");
      recordAloResult(true);
    } catch {
      // monitor 未ロード時は無視（テスト環境等）
    }
    return { ...postResult, mode: "POST_ONLY", aloRejected: true };
  }

  // Alo 受領成功 → 成功としてカウント
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { recordAloResult } = require("../risk/monitor") as typeof import("../risk/monitor");
    recordAloResult(false);
  } catch {
    // ignore
  }

  // ambiguous は板残存可能性あり、そのまま返す（自動回復禁止）
  if (postResult.outcome === "ambiguous") {
    return { ...postResult, mode: "POST_ONLY" };
  }

  // --- outcome === "filled" だがここでは「受領済み」を意味する
  //     POST_ONLY は板に resting で載っているだけの可能性もあるため、実約定をポーリング ---
  const timeoutMs = EXECUTION_PARAMS.postOnlyTimeoutSec * 1000;
  const start = Date.now();
  let lastFilledSize = 0;
  let lastOid: number | undefined;
  while (Date.now() - start < timeoutMs) {
    const status = await pollOrderStatus(cloid);
    if (status.found === true) {
      if (status.filledSize !== undefined) lastFilledSize = status.filledSize;
      if (status.oid !== undefined) lastOid = status.oid;
      // 99%以上約定したら成立とみなす（丸め誤差吸収）
      if (lastFilledSize >= params.size * 0.99) {
        return {
          success: true,
          outcome: "filled",
          cloid,
          oid: lastOid,
          filledSize: lastFilledSize,
          mode: "POST_ONLY",
        };
      }
      // filled でも cancelled でもなく resting → 継続ポーリング
    }
    await sleep(EXECUTION_PARAMS.pollIntervalMs);
  }

  // --- タイムアウト → cancel → 成功確認で timeout / ambiguous を返却 ---
  const cancelResult = await cancelByCloid(params.symbol, cloid);

  // キャンセル後に最終約定量を再確認（キャンセル直前に少し約定していた可能性）
  const finalStatus = await pollOrderStatus(cloid);
  if (finalStatus.filledSize !== undefined) {
    lastFilledSize = Math.max(lastFilledSize, finalStatus.filledSize);
  }
  if (finalStatus.oid !== undefined) lastOid = finalStatus.oid;

  // HL の場合、cancel 失敗時の「残存していない確認」は orderStatus で
  // cancelled/filled 等が取れるかで判定。finalStatus.found === false なら
  // 取引所が不明扱い（未受領 or 消えた）なので残存なし扱い。
  const finalStatusStr = (finalStatus.status ?? "").toLowerCase();
  const verifiedNotResting =
    finalStatus.found === false ||
    finalStatusStr.includes("cancel") ||
    finalStatusStr.includes("fill") ||
    finalStatusStr.includes("triggered");

  const outcome = classifyPostOnlyTimeoutOutcome({
    cancelSuccess: cancelResult.success,
    verifiedNotResting,
    filledSize: lastFilledSize,
  });

  if (outcome === "ambiguous") {
    console.warn(
      `[HL執行] POST_ONLY cancel失敗 ${params.symbol} cloid=${cloid} error=${cancelResult.error ?? "unknown"} filled=${lastFilledSize}/${params.size} → ambiguous`
    );
    return {
      success: false,
      outcome: "ambiguous",
      cloid,
      oid: lastOid,
      filledSize: lastFilledSize,
      error: `cancel failed: ${cancelResult.error ?? "unknown"}`,
      mode: "POST_ONLY",
    };
  }

  if (outcome === "filled") {
    if (lastFilledSize < params.size * 0.99) {
      console.info(
        `[HL執行] POST_ONLY 部分約定 ${params.symbol} cloid=${cloid} filled=${lastFilledSize}/${params.size}`
      );
    }
    return {
      success: true,
      outcome: "filled",
      cloid,
      oid: lastOid,
      filledSize: lastFilledSize,
      mode: "POST_ONLY",
    };
  }

  // outcome === "timeout"
  console.info(
    `[HL執行] POST_ONLY タイムアウト ${params.symbol} cloid=${cloid} filled=0/${params.size} → timeout (次サイクル再試行)`
  );
  return {
    success: false,
    outcome: "timeout",
    cloid,
    filledSize: 0,
    mode: "POST_ONLY",
  };
}

/**
 * モード指定で開発注する統合 API（Phase A Task A1）。
 * - POST_ONLY: maker 料率狙い、タイムアウトで IOC にフォールバック
 * - IOC:       即時約定（既存 marketOrder と同等）
 * - MARKET:    IOC の別名（後方互換）
 */
export async function openWithMode(params: {
  symbol: string;
  isBuy: boolean;
  size: number;
  mode: "POST_ONLY" | "IOC" | "MARKET";
  reduceOnly?: boolean;
  cloid?: string;
}): Promise<OrderResult> {
  if (params.mode === "POST_ONLY") {
    return openPostOnly({
      symbol: params.symbol,
      isBuy: params.isBuy,
      size: params.size,
      reduceOnly: params.reduceOnly,
      cloid: params.cloid,
    });
  }
  // IOC / MARKET は既存 marketOrder と同じ挙動
  const result = await marketOrder({
    symbol: params.symbol,
    isBuy: params.isBuy,
    size: params.size,
    reduceOnly: params.reduceOnly,
    cloid: params.cloid,
  });
  return { ...result, mode: params.mode };
}

/**
 * 成行注文（IOC指値 + スリッページ）
 */
export async function marketOrder(params: {
  symbol: string;
  isBuy: boolean;
  size: number;
  slippage?: number;
  reduceOnly?: boolean;
  cloid?: string;
}): Promise<OrderResult> {
  const cache = await getAssetCache();
  const info = getAssetInfo(params.symbol);

  // 現在の中値を取得
  const midPrice = await getMidPrice(params.symbol);
  const MAX_SLIPPAGE = 0.10; // 最大10%
  const slippage = Math.min(params.slippage ?? DEFAULT_SLIPPAGE, MAX_SLIPPAGE);
  const price = applySlippage(midPrice, params.isBuy, slippage, info.szDecimals);

  return placeOrder({
    symbol: params.symbol,
    isBuy: params.isBuy,
    size: params.size,
    price,
    orderType: { tif: "Ioc" },
    reduceOnly: params.reduceOnly ?? false,
    cloid: params.cloid,
  });
}

/**
 * 一括注文（**注文 POST はリトライ厳禁**）
 * ※ 現在 strategy 層では未使用。将来使う場合の参考実装。
 */
export async function bulkOrders(
  orders: PlaceOrderParams[],
  grouping: Grouping = "na"
): Promise<OrderResult[]> {
  await getAssetCache();
  const wires: OrderWire[] = [];
  const cloids: string[] = [];

  for (const order of orders) {
    const info = getAssetInfo(order.symbol);
    const size = roundSize(order.size, info.szDecimals);
    if (size <= 0) continue;
    // URGENT-FIX (2026-04-25): price にも roundPrice を適用（floatToWire 境界違反防止）
    const price = roundPrice(order.price, info.szDecimals);
    if (price <= 0) continue;
    const cloid = order.cloid ?? generateCloid();
    cloids.push(cloid);

    const tif = order.orderType?.tif ?? "Gtc";
    wires.push(
      buildOrderWire({
        assetIndex: info.index,
        isBuy: order.isBuy,
        price,
        size,
        reduceOnly: order.reduceOnly ?? false,
        orderType: { limit: { tif } },
        cloid,
      })
    );
  }

  if (wires.length === 0) {
    return [
      {
        success: false,
        outcome: "rejected",
        cloid: generateCloid(),
        error: "有効な注文なし",
      },
    ];
  }

  const action = buildOrderAction(wires, grouping);
  let httpRes: unknown = null;
  let sendError: string | null = null;
  try {
    httpRes = await signAndPostOnce(action);
  } catch (err) {
    sendError = err instanceof Error ? err.message : String(err);
  }

  if (httpRes !== null) {
    return parseBulkOrderResponse(
      httpRes as {
        status: string;
        response?: { type: string; data?: { statuses: Array<Record<string, unknown>> } };
      },
      cloids
    );
  }

  // バルク失敗 → cloid ごとに verify
  const results: OrderResult[] = [];
  for (const cloid of cloids) {
    const v = await verifyOrderByCloid(cloid);
    if (v.found === true) {
      results.push({
        success: true,
        outcome: "filled",
        cloid,
        oid: v.oid,
        filledSize: v.filledSize,
      });
    } else if (v.found === false) {
      results.push({
        success: false,
        outcome: "rejected",
        cloid,
        error: sendError ?? "not received",
      });
    } else {
      results.push({
        success: false,
        outcome: "ambiguous",
        cloid,
        error: `${sendError ?? "send failed"} | verify: ${v.error ?? "failed"}`,
      });
    }
  }
  return results;
}

// --- キャンセル ---

// キャンセルは冪等（既にキャンセル済み・約定済みでも安全）→ リトライ可
export async function cancelOrder(
  symbol: string,
  oid: number
): Promise<{ success: boolean; error?: string }> {
  const info = getAssetInfo(symbol);

  const action: ExchangeAction = {
    type: "cancel",
    cancels: [{ a: info.index, o: oid }],
  };

  const res = await signAndPostIdempotent(action, `cancel ${symbol} ${oid}`) as {
    status: string;
    response?: unknown;
  };

  if (res.status === "ok") {
    console.log(`[HL執行] キャンセル成功: ${symbol} oid=${oid}`);
    return { success: true };
  }
  return { success: false, error: `キャンセル失敗: status=${res.status}` };
}

export async function cancelAllOrders(
  symbol: string,
  oids: number[]
): Promise<{ success: boolean; error?: string }> {
  const info = getAssetInfo(symbol);

  const action: ExchangeAction = {
    type: "cancel",
    cancels: oids.map((o) => ({ a: info.index, o })),
  };

  const res = await signAndPostIdempotent(action, `bulk cancel ${symbol}`) as {
    status: string;
  };
  return {
    success: res.status === "ok",
    error: res.status !== "ok" ? `一括キャンセル失敗: status=${res.status}` : undefined,
  };
}

// --- レバレッジ設定 ---

export async function updateLeverage(
  symbol: string,
  leverage: number,
  isCross: boolean = true
): Promise<{ success: boolean; error?: string }> {
  const info = getAssetInfo(symbol);

  if (leverage > info.maxLeverage) {
    return { success: false, error: `最大レバレッジ超過: ${leverage} > ${info.maxLeverage}` };
  }

  const action: ExchangeAction = {
    type: "updateLeverage",
    asset: info.index,
    isCross,
    leverage,
  };

  // updateLeverage は冪等（同じ値の再設定は安全）→ リトライ可
  const res = await signAndPostIdempotent(action, `updateLeverage ${symbol}`) as {
    status: string;
  };
  if (res.status === "ok") {
    console.log(`[HL執行] レバレッジ更新: ${symbol} ${leverage}x (${isCross ? "cross" : "isolated"})`);
  }
  return {
    success: res.status === "ok",
    error: res.status !== "ok" ? `レバレッジ更新失敗: status=${res.status}` : undefined,
  };
}

// --- ポジション・残高照会 ---

export interface HlPosition {
  coin: string;
  size: number; // 正=Long, 負=Short
  entryPrice: number;
  positionValue: number;
  unrealizedPnl: number;
  liquidationPrice: number | null;
  leverage: number;
  marginUsed: number;
  cumFundingAll: number;
}

export interface HlAccountState {
  accountValue: number;
  totalMarginUsed: number;
  withdrawable: number;
  positions: HlPosition[];
}

export async function getAccountState(): Promise<HlAccountState> {
  const address = API_KEYS.hlWalletAddress;

  return withRetry(async () => {
    const res = await axios.post(`${BASE_URL}/info`, {
      type: "clearinghouseState",
      user: address,
    });
    const data = res.data;

    const positions: HlPosition[] = (data.assetPositions || []).map(
      (ap: Record<string, unknown>) => {
        const p = ap.position as Record<string, string>;
        return {
          coin: p.coin,
          size: parseFloat(p.szi),
          entryPrice: parseFloat(p.entryPx || "0"),
          positionValue: parseFloat(p.positionValue || "0"),
          unrealizedPnl: parseFloat(p.unrealizedPnl || "0"),
          liquidationPrice: p.liquidationPx ? parseFloat(p.liquidationPx) : null,
          leverage: (p.leverage as unknown as { value: number })?.value ?? 0,
          marginUsed: parseFloat(p.marginUsed || "0"),
          cumFundingAll: parseFloat(
            (p.cumFunding as unknown as { allTime: string })?.allTime ?? "0"
          ),
        };
      }
    );

    const margin = data.marginSummary || data.crossMarginSummary || {};
    return {
      accountValue: parseFloat(margin.accountValue || "0"),
      totalMarginUsed: parseFloat(margin.totalMarginUsed || "0"),
      withdrawable: parseFloat(data.withdrawable || "0"),
      positions,
    };
  }, "HL アカウント状態取得");
}

// オープン注文取得
export interface HlOpenOrder {
  coin: string;
  oid: number;
  side: "B" | "A"; // B=Buy, A=Ask(Sell)
  price: number;
  size: number;
  timestamp: number;
}

export async function getOpenOrders(): Promise<HlOpenOrder[]> {
  const address = API_KEYS.hlWalletAddress;

  return withRetry(async () => {
    const res = await axios.post(`${BASE_URL}/info`, {
      type: "openOrders",
      user: address,
    });
    return (res.data as Array<Record<string, unknown>>).map((o) => ({
      coin: o.coin as string,
      oid: o.oid as number,
      side: o.side as "B" | "A",
      price: parseFloat(o.limitPx as string),
      size: parseFloat(o.sz as string),
      timestamp: o.timestamp as number,
    }));
  }, "HL オープン注文取得");
}

// 中値取得
async function getMidPrice(symbol: string): Promise<number> {
  return withRetry(async () => {
    const res = await axios.post(`${BASE_URL}/info`, { type: "allMids" });
    const mids = res.data as Record<string, string>;
    const mid = mids[symbol];
    if (!mid) throw new Error(`中値取得不可: ${symbol}`);
    return parseFloat(mid);
  }, `HL 中値取得 ${symbol}`);
}

// --- マルチテナント用エクスポート ---
// UserExecutor が使う内部関数を公開（既存のシングルユーザー API はそのまま）
export { getAssetInfo, getAssetCache, roundSize, roundPrice, applySlippage, getMidPrice };

// --- レスポンスパーサー ---

// レスポンスから安全にエラー情報だけ抽出（署名・ペイロード全体をログに含めない）
function safeErrorMessage(res: Record<string, unknown>): string {
  const status = res.status ?? "unknown";
  const response = res.response as Record<string, unknown> | undefined;
  const errType = response?.type ?? "";
  return `status=${status} type=${errType}`;
}

export function parseOrderResponse(
  res: {
    status: string;
    response?: { type: string; data?: { statuses: Array<Record<string, unknown>> } };
  },
  cloid: string
): OrderResult {
  // ステータス自体が "ok" でない、または statuses 配列が無い → AMBIGUOUS
  // (HL から正常な application-level レスポンスを受け取れていないため、
  //  実際に注文が通ったか取引所側でしか分からない)
  if (res.status !== "ok" || !res.response?.data?.statuses?.length) {
    return {
      success: false,
      outcome: "ambiguous",
      cloid,
      error: safeErrorMessage(res as Record<string, unknown>),
    };
  }

  const s = res.response.data.statuses[0];

  if (s.resting) {
    const resting = s.resting as { oid: number };
    return { success: true, outcome: "filled", oid: resting.oid, cloid };
  }
  if (s.filled) {
    const filled = s.filled as { totalSz: string; avgPx: string; oid: number };
    return {
      success: true,
      outcome: "filled",
      oid: filled.oid,
      cloid,
      filledSize: parseFloat(filled.totalSz),
      avgPrice: parseFloat(filled.avgPx),
    };
  }
  if (s.error) {
    // 取引所が明確にエラーを返した → REJECTED 確定
    return {
      success: false,
      outcome: "rejected",
      cloid,
      error: s.error as string,
    };
  }

  // 想定外のステータス形状 → AMBIGUOUS
  return {
    success: false,
    outcome: "ambiguous",
    cloid,
    error: `不明なステータス: ${JSON.stringify(s).slice(0, 200)}`,
  };
}

function parseBulkOrderResponse(
  res: {
    status: string;
    response?: { type: string; data?: { statuses: Array<Record<string, unknown>> } };
  },
  cloids: string[]
): OrderResult[] {
  if (res.status !== "ok" || !res.response?.data?.statuses) {
    const err = safeErrorMessage(res as Record<string, unknown>);
    return cloids.map((cloid) => ({
      success: false,
      outcome: "ambiguous" as const,
      cloid,
      error: err,
    }));
  }

  return res.response.data.statuses.map((s, idx) => {
    const cloid = cloids[idx];
    if (s.resting) {
      const resting = s.resting as { oid: number };
      return { success: true, outcome: "filled" as const, oid: resting.oid, cloid };
    }
    if (s.filled) {
      const filled = s.filled as { totalSz: string; avgPx: string; oid: number };
      return {
        success: true,
        outcome: "filled" as const,
        oid: filled.oid,
        cloid,
        filledSize: parseFloat(filled.totalSz),
        avgPrice: parseFloat(filled.avgPx),
      };
    }
    if (s.error) {
      return {
        success: false,
        outcome: "rejected" as const,
        cloid,
        error: s.error as string,
      };
    }
    return {
      success: false,
      outcome: "ambiguous" as const,
      cloid,
      error: `不明なステータス: ${JSON.stringify(s).slice(0, 200)}`,
    };
  });
}
