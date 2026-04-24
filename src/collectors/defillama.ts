import axios from "axios";
import { ProtocolTvl, YieldPool } from "../core/types";
import { withRetry } from "../core/retry";
import { getDb } from "../db/database";

const LLAMA_BASE = "https://api.llama.fi";
const YIELDS_BASE = "https://yields.llama.fi";

// プロトコルTVL取得
export async function fetchProtocolTvl(
  protocol: string
): Promise<ProtocolTvl> {
  return withRetry(async () => {
    const res = await axios.get(`${LLAMA_BASE}/protocol/${protocol}`);
    const data = res.data;

    // TVLは直近値
    const tvl = data.currentChainTvls
      ? Object.values(data.currentChainTvls as Record<string, number>).reduce(
          (sum: number, v: number) => sum + v,
          0
        )
      : data.tvl?.[data.tvl.length - 1]?.totalLiquidityUSD ?? 0;

    // 24h変化率
    const tvlHistory = data.tvl || [];
    let change24h = 0;
    if (tvlHistory.length >= 2) {
      const latest = tvlHistory[tvlHistory.length - 1].totalLiquidityUSD;
      const prev = tvlHistory[tvlHistory.length - 2].totalLiquidityUSD;
      change24h = prev > 0 ? ((latest - prev) / prev) * 100 : 0;
    }

    const result: ProtocolTvl = {
      protocol,
      tvl,
      change24h,
      timestamp: new Date(),
    };

    // DB保存
    const stmt = getDb().prepare(`
      INSERT OR REPLACE INTO protocol_tvl (protocol, tvl, change_24h, timestamp)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(protocol, tvl, change24h, new Date().toISOString());

    console.log(
      `[DeFiLlama] ${protocol} TVL: $${(tvl / 1e6).toFixed(1)}M (${change24h >= 0 ? "+" : ""}${change24h.toFixed(2)}%)`
    );

    return result;
  }, `DeFiLlama TVL取得 ${protocol}`);
}

// 利回りプール一覧取得（Hyperliquid/Extended関連のみ）
export async function fetchYieldPools(): Promise<YieldPool[]> {
  return withRetry(async () => {
    const res = await axios.get(`${YIELDS_BASE}/pools`);
    const pools = res.data.data as Array<{
      pool: string;
      chain: string;
      project: string;
      symbol: string;
      tvlUsd: number;
      apy: number;
      apyBase: number;
      apyReward: number;
    }>;

    // Hyperliquid, Extended(x10)関連のプールのみフィルタ
    const relevantProjects = ["hyperliquid", "x10-finance", "x10", "extended"];
    const filtered = pools
      .filter((p) =>
        relevantProjects.some(
          (proj) =>
            p.project.toLowerCase().includes(proj) ||
            p.chain.toLowerCase().includes(proj)
        )
      )
      .map((p) => ({
        pool: p.pool,
        chain: p.chain,
        project: p.project,
        symbol: p.symbol,
        tvlUsd: p.tvlUsd,
        apy: p.apy || 0,
        apyBase: p.apyBase || 0,
        apyReward: p.apyReward || 0,
      }));

    console.log(
      `[DeFiLlama] 利回りプール: ${filtered.length}件（全${pools.length}件から抽出）`
    );

    return filtered;
  }, "DeFiLlama 利回りプール取得");
}

// Hyperliquid + Extended のTVLを一括更新
export async function updateAllTvl(): Promise<void> {
  console.log("[DeFiLlama] TVL一括更新開始");
  try {
    await fetchProtocolTvl("hyperliquid");
  } catch (err) {
    console.warn(`[DeFiLlama] Hyperliquid TVL取得失敗: ${err}`);
  }
  try {
    await fetchProtocolTvl("x10-exchange");
  } catch (err) {
    console.warn(`[DeFiLlama] Extended TVL取得失敗: ${err}`);
  }
}
