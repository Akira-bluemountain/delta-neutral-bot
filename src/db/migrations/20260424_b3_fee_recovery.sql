-- Task B3: 保有時間最適化（手数料回収ベースの動的 minHold）
--
-- dn_pairs に 3 カラム追加:
--   expected_fee_usd    : 入場時に見積もる往復手数料（entry + exit、USD 建て）
--                         exit は IOC 前提で taker fee × 2 として概算
--   accumulated_fr_usd  : 保有中にリアルタイム累積する FR 受取（60 秒ごと更新）
--   fr_breakeven_at     : 手数料回収達成時刻（ISO8601 UTC、NULL なら未達）
--
-- 既存 886 行には自動的に DEFAULT 0 / NULL が入り、expected_fee_usd=0 で
-- shouldBlockClosureForFee が false を返す後方互換仕様（旧ペアは minHold のみで判定）。
--
-- 参考: docs/BOT_SPEC.md §15 ロードマップ Task B3 / Phase 1 調査報告 (2026-04-24)

ALTER TABLE dn_pairs ADD COLUMN expected_fee_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE dn_pairs ADD COLUMN accumulated_fr_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE dn_pairs ADD COLUMN fr_breakeven_at TEXT;
