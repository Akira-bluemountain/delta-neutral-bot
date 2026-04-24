/**
 * Extended (x10) Stark 署名ユーティリティ
 * SNIP-12 注文ハッシュ + Stark ECDSA 署名
 */
import { typedData as starkTypedData, ec, constants } from "starknet";

const FIELD_PRIME = BigInt(constants.PRIME);

// Extended の StarknetDomain（MAINNET）
const EXTENDED_DOMAIN = {
  name: "Perpetuals",
  version: "v0",
  chainId: "SN_MAIN",
  revision: "1",
} as const;

// SNIP-12 型定義
const ORDER_TYPED_DATA_TYPES = {
  StarknetDomain: [
    { name: "name", type: "shortstring" },
    { name: "version", type: "shortstring" },
    { name: "chainId", type: "shortstring" },
    { name: "revision", type: "shortstring" },
  ],
  Order: [
    { name: "position_id", type: "felt" },
    { name: "base_asset_id", type: "felt" },
    { name: "base_amount", type: "felt" },
    { name: "quote_asset_id", type: "felt" },
    { name: "quote_amount", type: "felt" },
    { name: "fee_amount", type: "felt" },
    { name: "fee_asset_id", type: "felt" },
    { name: "expiration", type: "felt" },
    { name: "salt", type: "felt" },
  ],
} as const;

// --- マーケット L2 設定 ---

export interface ExtL2Config {
  collateralId: string; // hex e.g. "0x1"
  syntheticId: string; // hex e.g. "0x4254432d3600000000000000000000"
  syntheticResolution: number;
  collateralResolution: number;
}

// --- 金額変換 ---

// 負値を felt 表現に変換（StarkNet: -x → FIELD_PRIME - x）
function toFelt(value: bigint): string {
  if (value >= 0n) return value.toString();
  return (FIELD_PRIME + value).toString();
}

export interface OrderAmounts {
  baseAmount: bigint; // synthetic（正: ロング受取、負: ショート売却）
  quoteAmount: bigint; // collateral（正: 受取、負: 支払）
  feeAmount: bigint; // 常に正
}

/**
 * 注文金額を計算
 * @param isBuy - 買い注文かどうか
 * @param size - ベースアセット数量（人間可読、例: 0.01）
 * @param price - 価格（人間可読、例: 69000）
 * @param feeRate - 手数料率（例: 0.00025 = 0.025%）
 * @param l2Config - マーケットの L2 設定
 */
export function calculateOrderAmounts(
  isBuy: boolean,
  size: number,
  price: number,
  feeRate: number,
  l2Config: ExtL2Config
): OrderAmounts {
  // Human → Stark 変換（resolution を掛けて整数化）
  const syntheticRaw = BigInt(
    isBuy
      ? Math.ceil(size * l2Config.syntheticResolution) // 買い: 切り上げ
      : Math.floor(size * l2Config.syntheticResolution) // 売り: 切り捨て
  );

  const collateralRaw = BigInt(
    isBuy
      ? Math.ceil(size * price * l2Config.collateralResolution) // 買い: 切り上げ
      : Math.floor(size * price * l2Config.collateralResolution) // 売り: 切り捨て
  );

  // 手数料は常に切り上げ
  const feeAmount = BigInt(
    Math.ceil(
      Number(collateralRaw > 0n ? collateralRaw : -collateralRaw) * feeRate
    )
  );

  // 符号適用: 買い→担保を支払う（負）、売り→Syntheticを渡す（負）
  const baseAmount = isBuy ? syntheticRaw : -syntheticRaw;
  const quoteAmount = isBuy ? -collateralRaw : collateralRaw;

  return { baseAmount, quoteAmount, feeAmount };
}

// --- 注文ハッシュ計算（SNIP-12） ---

export interface OrderHashParams {
  positionId: string; // vault ID
  baseAssetId: string; // hex: syntheticId
  baseAmount: bigint;
  quoteAssetId: string; // hex: collateralId
  quoteAmount: bigint;
  feeAmount: bigint;
  feeAssetId: string; // hex: collateralId（手数料は担保建て）
  expiration: number; // Unix seconds（現在+14日）
  salt: number; // nonce
  publicKey: string; // Stark public key hex
}

export function computeOrderHash(params: OrderHashParams): string {
  const message = {
    position_id: params.positionId,
    base_asset_id: params.baseAssetId,
    base_amount: toFelt(params.baseAmount),
    quote_asset_id: params.quoteAssetId,
    quote_amount: toFelt(params.quoteAmount),
    fee_amount: params.feeAmount.toString(),
    fee_asset_id: params.feeAssetId,
    expiration: params.expiration.toString(),
    salt: params.salt.toString(),
  };

  const typedDataObj = {
    types: ORDER_TYPED_DATA_TYPES as unknown as Record<
      string,
      Array<{ name: string; type: string }>
    >,
    primaryType: "Order" as const,
    domain: { ...EXTENDED_DOMAIN },
    message,
  };

  return starkTypedData.getMessageHash(typedDataObj, params.publicKey);
}

// --- Stark ECDSA 署名 ---

export interface StarkSignature {
  r: string; // hex
  s: string; // hex
}

export function signOrderHash(
  orderHash: string,
  privateKey: string
): StarkSignature {
  // 秘密鍵の基本的な形式検証
  if (!privateKey || !/^0x[0-9a-fA-F]+$/.test(privateKey)) {
    throw new Error("[EXT署名] EXTENDED_STARK_PRIVATE_KEY の形式が不正です");
  }
  try {
    const sig = ec.starkCurve.sign(orderHash, privateKey);
    return {
      r: "0x" + sig.r.toString(16),
      s: "0x" + sig.s.toString(16),
    };
  } catch {
    // 秘密鍵やハッシュをエラーメッセージに含めない
    throw new Error("[EXT署名] Stark 署名生成失敗: 鍵またはハッシュが無効です");
  }
}

// --- 決済有効期限計算 ---

/**
 * 決済有効期限: 現在時刻 + 14日（秒単位、切り上げ）
 */
export function calcSettlementExpiration(orderExpiryMs: number): number {
  const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
  return Math.ceil((orderExpiryMs + fourteenDaysMs) / 1000);
}

// --- 統合: Settlement データ生成 ---

export interface SettlementData {
  signature: StarkSignature;
  starkKey: string;
  collateralPosition: string; // vault ID の文字列表現
  orderHash: string;
}

export function createSettlement(params: {
  isBuy: boolean;
  size: number;
  price: number;
  feeRate: number;
  l2Config: ExtL2Config;
  vaultId: string;
  publicKey: string;
  privateKey: string;
  nonce: number;
  orderExpiryMs: number;
}): SettlementData {
  const amounts = calculateOrderAmounts(
    params.isBuy,
    params.size,
    params.price,
    params.feeRate,
    params.l2Config
  );

  const expiration = calcSettlementExpiration(params.orderExpiryMs);

  const hashParams: OrderHashParams = {
    positionId: params.vaultId,
    baseAssetId: params.l2Config.syntheticId,
    baseAmount: amounts.baseAmount,
    quoteAssetId: params.l2Config.collateralId,
    quoteAmount: amounts.quoteAmount,
    feeAmount: amounts.feeAmount,
    feeAssetId: params.l2Config.collateralId,
    expiration,
    salt: params.nonce,
    publicKey: params.publicKey,
  };

  const orderHash = computeOrderHash(hashParams);
  const signature = signOrderHash(orderHash, params.privateKey);

  return {
    signature,
    starkKey: params.publicKey,
    collateralPosition: params.vaultId,
    orderHash,
  };
}
