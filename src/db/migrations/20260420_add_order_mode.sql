-- Phase A Task A1: own_orders テーブルに order_mode カラムを追加。
-- POST_ONLY / IOC / MARKET のいずれで約定した注文かを記録し、
-- 事後分析で maker/taker 料率効果を測定できるようにする。
-- 既存レコード（マイグレーション前の注文）は DEFAULT 'MARKET' が入る。

ALTER TABLE own_orders ADD COLUMN order_mode TEXT DEFAULT 'MARKET';

-- インデックス: モード別集計クエリの高速化
CREATE INDEX IF NOT EXISTS idx_own_orders_mode ON own_orders(order_mode);
