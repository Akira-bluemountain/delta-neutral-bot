import { getDb } from "./database";
import {
  DnPair,
  DnPairStatus,
  OwnOrder,
  OrderStatus,
  OwnTrade,
  PositionSnapshot,
  VenueId,
} from "../core/types";

// ===== DNペア =====

// DNペア作成（opening状態で作成）
export function createDnPair(params: {
  symbol: string;
  longVenue: VenueId;
  shortVenue: VenueId;
  targetSizeUsd: number;
  openReason: string;
}): number {
  const stmt = getDb().prepare(`
    INSERT INTO dn_pairs (symbol, long_venue, short_venue, status, target_size_usd, open_reason)
    VALUES (?, ?, ?, 'opening', ?, ?)
  `);
  const result = stmt.run(
    params.symbol,
    params.longVenue,
    params.shortVenue,
    params.targetSizeUsd,
    params.openReason
  );
  return Number(result.lastInsertRowid);
}

// DNペア取得
export function getDnPair(id: number): DnPair | null {
  const row = getDb()
    .prepare("SELECT * FROM dn_pairs WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToDnPair(row) : null;
}

// ステータスでDNペア一覧取得
export function getDnPairsByStatus(status: DnPairStatus): DnPair[] {
  const rows = getDb()
    .prepare("SELECT * FROM dn_pairs WHERE status = ? ORDER BY created_at DESC")
    .all(status) as Record<string, unknown>[];
  return rows.map(rowToDnPair);
}

// アクティブな（opening or open）DNペア一覧
export function getActiveDnPairs(): DnPair[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM dn_pairs WHERE status IN ('opening', 'open') ORDER BY created_at DESC"
    )
    .all() as Record<string, unknown>[];
  return rows.map(rowToDnPair);
}

// シンボルでアクティブDNペア取得
// closing / manual_review もブロック対象に含める
// （自動ロールバック失敗・AMBIGUOUS 等の残骸が残った場合に
//   同銘柄での新規エントリーを止め、手動対応を促す）
export function getActiveDnPairBySymbol(symbol: string): DnPair | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM dn_pairs
       WHERE symbol = ?
         AND status IN ('opening', 'open', 'closing', 'manual_review')
       LIMIT 1`
    )
    .get(symbol) as Record<string, unknown> | undefined;
  return row ? rowToDnPair(row) : null;
}

// DNペアステータス更新
//
// Task B2 修正 (#885 close_reason=null の根本原因):
// 従来は manual_review / opening / closing ステータス更新時に extra.closeReason が
// silently 捨てられていた。escalateAmbiguous は closeReason を渡していたのに DB に
// 書かれず、#885 CHIP 等で close_reason=null となり原因追跡が困難だった。
// 修正: manual_review では close_reason を保存（既存値は COALESCE で保持）。
// opening / closing は過渡状態で closeReason を持たない運用なので従来どおり status のみ。
export function updateDnPairStatus(
  id: number,
  status: DnPairStatus,
  extra?: { closeReason?: string }
): void {
  if (status === "open") {
    getDb()
      .prepare(
        "UPDATE dn_pairs SET status = ?, opened_at = datetime('now') WHERE id = ?"
      )
      .run(status, id);
  } else if (status === "closed") {
    getDb()
      .prepare(
        "UPDATE dn_pairs SET status = ?, close_reason = ?, closed_at = datetime('now') WHERE id = ?"
      )
      .run(status, extra?.closeReason ?? null, id);
  } else if (status === "manual_review") {
    // Task B2: 渡された closeReason があれば上書き、なければ既存値を保持
    getDb()
      .prepare(
        "UPDATE dn_pairs SET status = ?, close_reason = COALESCE(?, close_reason) WHERE id = ?"
      )
      .run(status, extra?.closeReason ?? null, id);
  } else {
    // opening / closing 等の過渡状態: status のみ更新
    getDb()
      .prepare("UPDATE dn_pairs SET status = ? WHERE id = ?")
      .run(status, id);
  }
}

// DNペアのポジションサイズ更新（約定反映時に使用）
export function updateDnPairSizes(
  id: number,
  longSize: number,
  shortSize: number,
  longEntryPrice: number,
  shortEntryPrice: number
): void {
  getDb()
    .prepare(
      `UPDATE dn_pairs
       SET long_size = ?, short_size = ?, long_entry_price = ?, short_entry_price = ?
       WHERE id = ?`
    )
    .run(longSize, shortSize, longEntryPrice, shortEntryPrice, id);
}

// ===== Task B3: 手数料回収ベースの動的 minHold =====

// 入場完了の原子的反映。両側 filled 確定時に以下を 1 つの UPDATE でまとめて書き込み:
//   - サイズ / 約定価格
//   - 往復手数料見積もり（expected_fee_usd）
//   - status='open' + opened_at=datetime('now')
// これにより「open だが expected_fee_usd が未記録」という窓を完全に排除する
// （shouldBlockClosureForFee が誤って保持解除しないことを保証）。
export function finalizeOpenedPair(
  id: number,
  params: {
    longSize: number;
    shortSize: number;
    longEntryPrice: number;
    shortEntryPrice: number;
    expectedFeeUsd: number;
  }
): void {
  getDb()
    .prepare(
      `UPDATE dn_pairs
       SET long_size = ?,
           short_size = ?,
           long_entry_price = ?,
           short_entry_price = ?,
           expected_fee_usd = ?,
           status = 'open',
           opened_at = datetime('now')
       WHERE id = ?`
    )
    .run(
      params.longSize,
      params.shortSize,
      params.longEntryPrice,
      params.shortEntryPrice,
      params.expectedFeeUsd,
      id
    );
}

// 累積 FR 受取を更新（60 秒ごとの risk モニタサイクルから呼ばれる）
// 負値もそのまま記録する（スプレッド反転の観測用）
export function updateDnPairAccumulatedFr(
  id: number,
  accumulatedFrUsd: number
): void {
  getDb()
    .prepare("UPDATE dn_pairs SET accumulated_fr_usd = ? WHERE id = ?")
    .run(accumulatedFrUsd, id);
}

// 手数料回収達成時刻を記録（fr_breakeven_at が null のペアに対して 1 回だけセット）
export function markDnPairBreakeven(id: number, isoTimestamp: string): void {
  getDb()
    .prepare(
      // fr_breakeven_at が既にセット済みなら上書きしない（最初の到達時刻を保持）
      `UPDATE dn_pairs
       SET fr_breakeven_at = ?
       WHERE id = ? AND fr_breakeven_at IS NULL`
    )
    .run(isoTimestamp, id);
}

// ===== 注文 =====

// 注文作成
// orderMode (Phase A Task A1): POST_ONLY / IOC / MARKET のいずれで発注したかを記録。
// 省略時は 'MARKET'（後方互換）。
export function createOrder(params: {
  pairId: number | null;
  venue: VenueId;
  symbol: string;
  side: "buy" | "sell";
  orderType: "limit" | "market";
  price: number;
  size: number;
  orderMode?: "POST_ONLY" | "IOC" | "MARKET";
}): number {
  const stmt = getDb().prepare(`
    INSERT INTO own_orders (pair_id, venue, symbol, side, order_type, price, size, status, order_mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `);
  const result = stmt.run(
    params.pairId,
    params.venue,
    params.symbol,
    params.side,
    params.orderType,
    params.price,
    params.size,
    params.orderMode ?? "MARKET"
  );
  return Number(result.lastInsertRowid);
}

// 注文ステータス更新
// orderMode (Phase A Task A1): POST_ONLY → IOC フォールバック時に最終モードに書き換え。
export function updateOrderStatus(
  id: number,
  status: OrderStatus,
  extra?: {
    filledSize?: number;
    venueOrderId?: string;
    orderMode?: "POST_ONLY" | "IOC" | "MARKET";
  }
): void {
  const sets: string[] = ["status = ?", "updated_at = datetime('now')"];
  const values: unknown[] = [status];

  if (extra?.filledSize !== undefined) {
    sets.push("filled_size = ?");
    values.push(extra.filledSize);
  }
  if (extra?.venueOrderId !== undefined) {
    sets.push("venue_order_id = ?");
    values.push(extra.venueOrderId);
  }
  if (extra?.orderMode !== undefined) {
    sets.push("order_mode = ?");
    values.push(extra.orderMode);
  }
  values.push(id);

  getDb()
    .prepare(`UPDATE own_orders SET ${sets.join(", ")} WHERE id = ?`)
    .run(...values);
}

// 注文取得
export function getOrder(id: number): OwnOrder | null {
  const row = getDb()
    .prepare("SELECT * FROM own_orders WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToOrder(row) : null;
}

// DNペアに紐づく注文一覧
export function getOrdersByPair(pairId: number): OwnOrder[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM own_orders WHERE pair_id = ? ORDER BY created_at DESC"
    )
    .all(pairId) as Record<string, unknown>[];
  return rows.map(rowToOrder);
}

// アクティブ注文（pending/open/partially_filled）
export function getActiveOrders(): OwnOrder[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM own_orders WHERE status IN ('pending', 'open', 'partially_filled') ORDER BY created_at DESC"
    )
    .all() as Record<string, unknown>[];
  return rows.map(rowToOrder);
}

// ===== 約定 =====

// 約定記録
export function recordTrade(params: {
  orderId: number;
  pairId: number | null;
  venue: VenueId;
  symbol: string;
  side: "buy" | "sell";
  price: number;
  size: number;
  fee: number;
  feeRate: number;
  venueTradeId: string | null;
  timestamp: string;
}): number {
  const stmt = getDb().prepare(`
    INSERT INTO own_trades (order_id, pair_id, venue, symbol, side, price, size, fee, fee_rate, venue_trade_id, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    params.orderId,
    params.pairId,
    params.venue,
    params.symbol,
    params.side,
    params.price,
    params.size,
    params.fee,
    params.feeRate,
    params.venueTradeId,
    params.timestamp
  );
  return Number(result.lastInsertRowid);
}

// DNペアの約定一覧
export function getTradesByPair(pairId: number): OwnTrade[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM own_trades WHERE pair_id = ? ORDER BY timestamp DESC"
    )
    .all(pairId) as Record<string, unknown>[];
  return rows.map(rowToTrade);
}

// ===== スナップショット =====

// スナップショット記録
export function savePositionSnapshot(params: {
  pairId: number;
  longSize: number;
  shortSize: number;
  longValueUsd: number;
  shortValueUsd: number;
  driftPct: number;
  netUnrealizedPnl: number;
  accumulatedFunding: number;
  timestamp: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO position_snapshots
        (pair_id, long_size, short_size, long_value_usd, short_value_usd, drift_pct, net_unrealized_pnl, accumulated_funding, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.pairId,
      params.longSize,
      params.shortSize,
      params.longValueUsd,
      params.shortValueUsd,
      params.driftPct,
      params.netUnrealizedPnl,
      params.accumulatedFunding,
      params.timestamp
    );
}

// 直近スナップショット取得
export function getLatestSnapshot(pairId: number): PositionSnapshot | null {
  const row = getDb()
    .prepare(
      "SELECT * FROM position_snapshots WHERE pair_id = ? ORDER BY timestamp DESC LIMIT 1"
    )
    .get(pairId) as Record<string, unknown> | undefined;
  return row ? rowToSnapshot(row) : null;
}

// ドリフト閾値超えのスナップショット検索
export function getDriftAlerts(
  pairId: number,
  thresholdPct: number,
  limit: number = 10
): PositionSnapshot[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM position_snapshots
       WHERE pair_id = ? AND ABS(drift_pct) > ?
       ORDER BY timestamp DESC LIMIT ?`
    )
    .all(pairId, thresholdPct, limit) as Record<string, unknown>[];
  return rows.map(rowToSnapshot);
}

// ===== 行変換ヘルパー =====

function rowToDnPair(row: Record<string, unknown>): DnPair {
  return {
    id: row.id as number,
    symbol: row.symbol as string,
    longVenue: row.long_venue as VenueId,
    shortVenue: row.short_venue as VenueId,
    status: row.status as DnPairStatus,
    targetSizeUsd: row.target_size_usd as number,
    longSize: row.long_size as number,
    shortSize: row.short_size as number,
    longEntryPrice: row.long_entry_price as number,
    shortEntryPrice: row.short_entry_price as number,
    openReason: row.open_reason as string,
    closeReason: (row.close_reason as string) || null,
    openedAt: row.opened_at ? new Date(row.opened_at as string) : null,
    closedAt: row.closed_at ? new Date(row.closed_at as string) : null,
    createdAt: new Date(row.created_at as string),
    // Task B3: migration で追加されたカラム。旧レコードは DEFAULT 0 / NULL
    expectedFeeUsd: (row.expected_fee_usd as number) ?? 0,
    accumulatedFrUsd: (row.accumulated_fr_usd as number) ?? 0,
    frBreakevenAt: row.fr_breakeven_at
      ? new Date(row.fr_breakeven_at as string)
      : null,
  };
}

function rowToOrder(row: Record<string, unknown>): OwnOrder {
  return {
    id: row.id as number,
    pairId: (row.pair_id as number) || null,
    venue: row.venue as VenueId,
    symbol: row.symbol as string,
    side: row.side as "buy" | "sell",
    orderType: row.order_type as "limit" | "market",
    price: row.price as number,
    size: row.size as number,
    filledSize: row.filled_size as number,
    status: row.status as OrderStatus,
    venueOrderId: (row.venue_order_id as string) || null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function rowToTrade(row: Record<string, unknown>): OwnTrade {
  return {
    id: row.id as number,
    orderId: row.order_id as number,
    pairId: (row.pair_id as number) || null,
    venue: row.venue as VenueId,
    symbol: row.symbol as string,
    side: row.side as "buy" | "sell",
    price: row.price as number,
    size: row.size as number,
    fee: row.fee as number,
    feeRate: row.fee_rate as number,
    venueTradeId: (row.venue_trade_id as string) || null,
    timestamp: new Date(row.timestamp as string),
  };
}

function rowToSnapshot(row: Record<string, unknown>): PositionSnapshot {
  return {
    id: row.id as number,
    pairId: row.pair_id as number,
    longSize: row.long_size as number,
    shortSize: row.short_size as number,
    longValueUsd: row.long_value_usd as number,
    shortValueUsd: row.short_value_usd as number,
    driftPct: row.drift_pct as number,
    netUnrealizedPnl: row.net_unrealized_pnl as number,
    accumulatedFunding: row.accumulated_funding as number,
    timestamp: new Date(row.timestamp as string),
  };
}
