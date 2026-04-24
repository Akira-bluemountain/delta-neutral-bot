/**
 * Hyperliquid EIP-712 署名ユーティリティ
 * Python SDK signing.py の TypeScript 移植
 */
import { ethers } from "ethers";
import { encode } from "@msgpack/msgpack";

// --- 定数 ---
const PHANTOM_DOMAIN = {
  name: "Exchange",
  version: "1",
  chainId: 1337,
  verifyingContract: "0x0000000000000000000000000000000000000000",
} as const;

const AGENT_TYPES = {
  Agent: [
    { name: "source", type: "string" },
    { name: "connectionId", type: "bytes32" },
  ],
} as const;

// --- 公開型 ---

export type Tif = "Gtc" | "Ioc" | "Alo";

export interface OrderTypeWire {
  limit?: { tif: Tif };
  trigger?: { isMarket: boolean; triggerPx: string; tpsl: "tp" | "sl" };
}

export interface OrderWire {
  a: number; // アセットインデックス
  b: boolean; // isBuy
  p: string; // 価格
  s: string; // 数量
  r: boolean; // reduceOnly
  t: OrderTypeWire;
  c?: string; // cloid
}

export type Grouping = "na" | "normalTpsl" | "positionTpsl";

export interface OrderAction {
  type: "order";
  orders: OrderWire[];
  grouping: Grouping;
}

export interface CancelAction {
  type: "cancel";
  cancels: Array<{ a: number; o: number }>;
}

/**
 * cloid によるキャンセル（Phase A Task A1 で追加）
 * POST_ONLY 注文をタイムアウト時にキャンセルする際、oid を取得せずに
 * cloid で直接キャンセルできる HL の専用エンドポイント。
 */
export interface CancelByCloidAction {
  type: "cancelByCloid";
  cancels: Array<{ asset: number; cloid: string }>;
}

export interface UpdateLeverageAction {
  type: "updateLeverage";
  asset: number;
  isCross: boolean;
  leverage: number;
}

export type ExchangeAction =
  | OrderAction
  | CancelAction
  | CancelByCloidAction
  | UpdateLeverageAction;

export interface SignedPayload {
  action: ExchangeAction;
  nonce: number;
  signature: { r: string; s: string; v: number };
  vaultAddress?: string | null;
}

// --- float → wire 変換 ---

export function floatToWire(x: number): string {
  const rounded = x.toFixed(8);
  if (Math.abs(parseFloat(rounded) - x) >= 1e-12) {
    throw new Error(`floatToWire 丸め誤差: ${x}`);
  }
  // "-0" 対策
  if (rounded === "-0.00000000") return "0";
  // 末尾の不要なゼロを除去
  let s = rounded.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return s;
}

// --- 注文ワイヤフォーマット構築 ---

export function buildOrderWire(params: {
  assetIndex: number;
  isBuy: boolean;
  price: number;
  size: number;
  reduceOnly: boolean;
  orderType: OrderTypeWire;
  cloid?: string;
}): OrderWire {
  const wire: OrderWire = {
    a: params.assetIndex,
    b: params.isBuy,
    p: floatToWire(params.price),
    s: floatToWire(params.size),
    r: params.reduceOnly,
    t: params.orderType,
  };
  if (params.cloid) {
    wire.c = params.cloid;
  }
  return wire;
}

export function buildOrderAction(
  orders: OrderWire[],
  grouping: Grouping = "na"
): OrderAction {
  return { type: "order", orders, grouping };
}

// --- アクションハッシュ ---

export function actionHash(
  action: ExchangeAction,
  vaultAddress: string | null,
  nonce: number
): Uint8Array {
  // msgpack シリアライズ
  const packed = encode(action);

  // nonce を 8バイト big-endian で追加
  const nonceBytes = new Uint8Array(8);
  const view = new DataView(nonceBytes.buffer);
  // nonce は ms タイムスタンプ（53bit以内）なので上位4バイト + 下位4バイトに分割
  view.setUint32(0, Math.floor(nonce / 0x100000000));
  view.setUint32(4, nonce >>> 0);

  // vault フラグ
  let vaultBytes: Uint8Array;
  if (vaultAddress === null || vaultAddress === undefined) {
    vaultBytes = new Uint8Array([0x00]);
  } else {
    const addrBytes = addressToBytes(vaultAddress);
    vaultBytes = new Uint8Array(1 + addrBytes.length);
    vaultBytes[0] = 0x01;
    vaultBytes.set(addrBytes, 1);
  }

  // 結合
  const combined = new Uint8Array(
    packed.length + nonceBytes.length + vaultBytes.length
  );
  combined.set(packed, 0);
  combined.set(nonceBytes, packed.length);
  combined.set(vaultBytes, packed.length + nonceBytes.length);

  return ethers.getBytes(ethers.keccak256(combined));
}

// --- ファントムエージェント ---

function constructPhantomAgent(
  hash: Uint8Array,
  isMainnet: boolean
): { source: string; connectionId: string } {
  return {
    source: isMainnet ? "a" : "b",
    connectionId: ethers.hexlify(hash),
  };
}

// --- 署名 ---

export async function signL1Action(
  wallet: ethers.Wallet,
  action: ExchangeAction,
  vaultAddress: string | null,
  nonce: number,
  isMainnet: boolean
): Promise<{ r: string; s: string; v: number }> {
  const hash = actionHash(action, vaultAddress, nonce);
  const phantomAgent = constructPhantomAgent(hash, isMainnet);

  const sig = await wallet.signTypedData(
    // domain（chainIdをnumberで渡す）
    {
      name: PHANTOM_DOMAIN.name,
      version: PHANTOM_DOMAIN.version,
      chainId: PHANTOM_DOMAIN.chainId,
      verifyingContract: PHANTOM_DOMAIN.verifyingContract,
    },
    // types
    { Agent: [...AGENT_TYPES.Agent] },
    // value
    phantomAgent
  );

  return splitSignature(sig);
}

// --- ユーティリティ ---

function addressToBytes(address: string): Uint8Array {
  const hex = address.startsWith("0x") ? address.slice(2) : address;
  return ethers.getBytes("0x" + hex);
}

function splitSignature(sig: string): { r: string; s: string; v: number } {
  const { r, s, v } = ethers.Signature.from(sig);
  return { r, s, v };
}

export function getTimestampMs(): number {
  return Date.now();
}
