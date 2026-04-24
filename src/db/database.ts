import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { DB_PATH } from "../core/config";
import { runMigrations } from "./migration-runner";

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    throw new Error("DBが初期化されていません。initDb()を先に呼んでください");
  }
  return db;
}

export function initDb(): Database.Database {
  // データディレクトリ作成
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // 1. ベーステーブルを作成（CREATE TABLE IF NOT EXISTS で冪等）
  createTables(db);

  // 2. マイグレーションを適用（schema_migrations で履歴管理、冪等）
  runMigrations(db);

  console.log(`[DB] 初期化完了: ${DB_PATH}`);
  return db;
}

function createTables(db: Database.Database): void {
  db.exec(`
    -- ファンディングレート履歴
    CREATE TABLE IF NOT EXISTS funding_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venue TEXT NOT NULL,
      symbol TEXT NOT NULL,
      rate REAL NOT NULL,
      annualized REAL NOT NULL,
      next_funding_time TEXT,
      timestamp TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(venue, symbol, timestamp)
    );

    CREATE INDEX IF NOT EXISTS idx_fr_venue_symbol
      ON funding_rates(venue, symbol, timestamp DESC);

    -- Nansenリーダーボード
    CREATE TABLE IF NOT EXISTS nansen_leaderboard (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      address TEXT NOT NULL UNIQUE,
      total_pnl REAL NOT NULL,
      roi REAL NOT NULL,
      account_value REAL NOT NULL,
      labels TEXT, -- JSON配列
      updated_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Nansenポジション
    CREATE TABLE IF NOT EXISTS nansen_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      address TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      position_value_usd REAL NOT NULL,
      entry_price REAL NOT NULL,
      mark_price REAL NOT NULL,
      unrealized_pnl REAL NOT NULL,
      timestamp TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_np_symbol
      ON nansen_positions(symbol, timestamp DESC);

    -- Nansenトレード
    CREATE TABLE IF NOT EXISTS nansen_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      address TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      value_usd REAL NOT NULL,
      price REAL NOT NULL,
      timestamp TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_nt_symbol
      ON nansen_trades(symbol, timestamp DESC);

    -- DeFiLlama TVLキャッシュ
    CREATE TABLE IF NOT EXISTS protocol_tvl (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      protocol TEXT NOT NULL,
      tvl REAL NOT NULL,
      change_24h REAL,
      timestamp TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(protocol, timestamp)
    );

    -- スクリーニング結果
    CREATE TABLE IF NOT EXISTS screening_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      classic_score REAL NOT NULL,
      extended_bonus REAL NOT NULL,
      composite_score REAL NOT NULL,
      hl_funding_rate REAL,
      ext_funding_rate REAL,
      hl_cost REAL,
      ext_cost REAL,
      recommended_short_venue TEXT,
      estimated_apy REAL,
      timestamp TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sr_timestamp
      ON screening_results(timestamp DESC);

    -- FR裁定機会
    CREATE TABLE IF NOT EXISTS arbitrage_opportunities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      long_venue TEXT NOT NULL,
      short_venue TEXT NOT NULL,
      spread_annualized REAL NOT NULL,
      estimated_daily_usd REAL NOT NULL,
      confidence TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_ao_timestamp
      ON arbitrage_opportunities(timestamp DESC);

    -- ===== ポジション管理テーブル =====

    -- DNペア（Long + Short の組）
    CREATE TABLE IF NOT EXISTS dn_pairs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      long_venue TEXT NOT NULL,
      short_venue TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'opening',
      target_size_usd REAL NOT NULL,
      long_size REAL NOT NULL DEFAULT 0,
      short_size REAL NOT NULL DEFAULT 0,
      long_entry_price REAL NOT NULL DEFAULT 0,
      short_entry_price REAL NOT NULL DEFAULT 0,
      open_reason TEXT NOT NULL,
      close_reason TEXT,
      opened_at TEXT,
      closed_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_dn_pairs_status
      ON dn_pairs(status);

    CREATE INDEX IF NOT EXISTS idx_dn_pairs_symbol
      ON dn_pairs(symbol, status);

    -- 自アカウント注文
    CREATE TABLE IF NOT EXISTS own_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pair_id INTEGER,
      venue TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      order_type TEXT NOT NULL,
      price REAL NOT NULL,
      size REAL NOT NULL,
      filled_size REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      venue_order_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (pair_id) REFERENCES dn_pairs(id)
    );

    CREATE INDEX IF NOT EXISTS idx_own_orders_pair
      ON own_orders(pair_id);

    CREATE INDEX IF NOT EXISTS idx_own_orders_status
      ON own_orders(status);

    -- 自アカウント約定
    CREATE TABLE IF NOT EXISTS own_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      pair_id INTEGER,
      venue TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      price REAL NOT NULL,
      size REAL NOT NULL,
      fee REAL NOT NULL DEFAULT 0,
      fee_rate REAL NOT NULL DEFAULT 0,
      venue_trade_id TEXT,
      timestamp TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (order_id) REFERENCES own_orders(id),
      FOREIGN KEY (pair_id) REFERENCES dn_pairs(id)
    );

    CREATE INDEX IF NOT EXISTS idx_own_trades_pair
      ON own_trades(pair_id);

    -- ポジションスナップショット（ドリフト検出用）
    CREATE TABLE IF NOT EXISTS position_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pair_id INTEGER NOT NULL,
      long_size REAL NOT NULL,
      short_size REAL NOT NULL,
      long_value_usd REAL NOT NULL,
      short_value_usd REAL NOT NULL,
      drift_pct REAL NOT NULL,
      net_unrealized_pnl REAL NOT NULL DEFAULT 0,
      accumulated_funding REAL NOT NULL DEFAULT 0,
      timestamp TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (pair_id) REFERENCES dn_pairs(id)
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_pair
      ON position_snapshots(pair_id, timestamp DESC);

    -- ===== マルチテナント: ユーザー管理テーブル =====

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT,
      plan TEXT NOT NULL DEFAULT 'free',
      bot_enabled INTEGER NOT NULL DEFAULT 0,
      dry_run INTEGER NOT NULL DEFAULT 1,
      max_position_usd REAL NOT NULL DEFAULT 20,
      free_usdt_threshold REAL NOT NULL DEFAULT 100,
      claude_calls_today INTEGER NOT NULL DEFAULT 0,
      claude_calls_reset_at TEXT,
      stripe_customer_id TEXT UNIQUE,
      stripe_subscription_id TEXT UNIQUE,
      subscription_status TEXT DEFAULT 'inactive',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_api_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      venue TEXT NOT NULL,
      key_name TEXT NOT NULL,
      encrypted_value TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, key_name)
    );

    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user
      ON refresh_tokens(user_id) WHERE revoked = 0;
  `);
}

// FR履歴保存
export function saveFundingRate(
  venue: string,
  symbol: string,
  rate: number,
  annualized: number,
  nextFundingTime: string | null,
  timestamp: string
): void {
  const stmt = getDb().prepare(`
    INSERT OR REPLACE INTO funding_rates (venue, symbol, rate, annualized, next_funding_time, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(venue, symbol, rate, annualized, nextFundingTime, timestamp);
}

// 直近N件のFR取得
export function getRecentFundingRates(
  venue: string,
  symbol: string,
  limit: number
): Array<{ rate: number; annualized: number; timestamp: string }> {
  const stmt = getDb().prepare(`
    SELECT rate, annualized, timestamp
    FROM funding_rates
    WHERE venue = ? AND symbol = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `);
  return stmt.all(venue, symbol, limit) as Array<{
    rate: number;
    annualized: number;
    timestamp: string;
  }>;
}

// Nansenリーダーボード保存
export function saveLeaderboardEntry(
  address: string,
  totalPnl: number,
  roi: number,
  accountValue: number,
  labels: string[],
  updatedAt: string
): void {
  const stmt = getDb().prepare(`
    INSERT OR REPLACE INTO nansen_leaderboard (address, total_pnl, roi, account_value, labels, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(address, totalPnl, roi, accountValue, JSON.stringify(labels), updatedAt);
}

// リーダーボードアドレス一覧取得
export function getLeaderboardAddresses(): string[] {
  const rows = getDb()
    .prepare("SELECT address FROM nansen_leaderboard ORDER BY total_pnl DESC")
    .all() as Array<{ address: string }>;
  return rows.map((r) => r.address);
}

// Nansenポジション保存（一括）
export function saveNansenPositions(
  positions: Array<{
    address: string;
    symbol: string;
    side: string;
    positionValueUsd: number;
    entryPrice: number;
    markPrice: number;
    unrealizedPnl: number;
    timestamp: string;
  }>
): void {
  const stmt = getDb().prepare(`
    INSERT INTO nansen_positions (address, symbol, side, position_value_usd, entry_price, mark_price, unrealized_pnl, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMany = getDb().transaction(
    (
      items: Array<{
        address: string;
        symbol: string;
        side: string;
        positionValueUsd: number;
        entryPrice: number;
        markPrice: number;
        unrealizedPnl: number;
        timestamp: string;
      }>
    ) => {
      for (const p of items) {
        stmt.run(
          p.address,
          p.symbol,
          p.side,
          p.positionValueUsd,
          p.entryPrice,
          p.markPrice,
          p.unrealizedPnl,
          p.timestamp
        );
      }
    }
  );
  insertMany(positions);
}

// シンボルごとのNansenポジション取得
export function getNansenPositionsBySymbol(
  symbol: string
): Array<{
  address: string;
  symbol: string;
  side: string;
  position_value_usd: number;
}> {
  return getDb()
    .prepare(
      `
    SELECT address, symbol, side, position_value_usd
    FROM nansen_positions
    WHERE symbol = ?
    AND timestamp = (SELECT MAX(timestamp) FROM nansen_positions WHERE symbol = ?)
  `
    )
    .all(symbol, symbol) as Array<{
    address: string;
    symbol: string;
    side: string;
    position_value_usd: number;
  }>;
}
