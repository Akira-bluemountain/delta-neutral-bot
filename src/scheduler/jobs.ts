import cron from "node-cron";
import { RISK_PARAMS } from "../core/config";
import { runScreening } from "../analyzers/screener";
import { detectArbitrageOpportunities } from "../analyzers/funding-arbitrage";
import { generateRiskReport } from "../risk/monitor";
import { runStrategyCycle } from "../strategy/dn-strategy";
import { refreshAssetCache } from "../execution/hl-executor";
import { refreshMarketCache } from "../execution/ext-executor";

let isScreeningRunning = false;
let isFundingUpdateRunning = false;
let isRiskCheckRunning = false;
let isStrategyCycleRunning = false;

// 5分ごと: FR裁定機会の再評価（HL/EXT の最新 FR から）
async function fundingArbitrageJob(): Promise<void> {
  if (isFundingUpdateRunning) {
    console.log("[ジョブ] FR裁定検出: 前回実行中のためスキップ");
    return;
  }
  isFundingUpdateRunning = true;
  try {
    console.log("[ジョブ] FR裁定検出開始");
    await detectArbitrageOpportunities();
  } catch (err) {
    console.error(`[ジョブ] FR裁定検出エラー: ${err}`);
  } finally {
    isFundingUpdateRunning = false;
  }
}

// 30分ごと: HL/Extended アセット・マーケットキャッシュ更新
// delisting や仕様変更（szDecimals 変更等）を検知するため定期的に再取得
async function cacheRefreshJob(): Promise<void> {
  try {
    await Promise.all([refreshAssetCache(), refreshMarketCache()]);
  } catch (err) {
    console.error(`[ジョブ] キャッシュ更新エラー: ${err}`);
  }
}

// スクリーニングサイクル（60秒ごと）
let screeningInterval: ReturnType<typeof setInterval> | null = null;

async function screeningCycle(): Promise<void> {
  if (isScreeningRunning) return;
  isScreeningRunning = true;
  try {
    await runScreening();
  } catch (err) {
    console.error(`[ジョブ] スクリーニングエラー: ${err}`);
  } finally {
    isScreeningRunning = false;
  }
}

// リスクモニタージョブ（30秒ごと）
let riskMonitorInterval: ReturnType<typeof setInterval> | null = null;

async function riskMonitorCycle(): Promise<void> {
  if (isRiskCheckRunning) return;
  isRiskCheckRunning = true;
  try {
    await generateRiskReport();
  } catch (err) {
    console.error(`[ジョブ] リスクモニターエラー: ${err}`);
  } finally {
    isRiskCheckRunning = false;
  }
}

// DN戦略サイクル（1分ごと）
let strategyCycleInterval: ReturnType<typeof setInterval> | null = null;

async function strategyCycle(): Promise<void> {
  if (isStrategyCycleRunning) return;
  isStrategyCycleRunning = true;
  try {
    await runStrategyCycle();
  } catch (err) {
    console.error(`[ジョブ] 戦略サイクルエラー: ${err}`);
  } finally {
    isStrategyCycleRunning = false;
  }
}

// 全ジョブを開始
export function startAllJobs(): void {
  console.log("[スケジューラ] 全ジョブを開始");

  // 5分ごと: FR裁定検出
  cron.schedule("*/5 * * * *", fundingArbitrageJob);

  // 30分ごと（15分オフセット）: アセット・マーケットキャッシュ更新
  cron.schedule("15,45 * * * *", cacheRefreshJob);

  // 60秒ごと: スクリーニング
  screeningInterval = setInterval(screeningCycle, 60_000);

  // 30秒ごと: リスクモニター
  riskMonitorInterval = setInterval(riskMonitorCycle, RISK_PARAMS.monitorIntervalMs);

  // 60秒ごと: DN戦略サイクル
  strategyCycleInterval = setInterval(strategyCycle, 60_000);

  console.log("[スケジューラ] cronジョブ登録完了");
  console.log("  - FR裁定検出: 5分ごと");
  console.log("  - キャッシュ更新: 30分ごと（:15/:45）");
  console.log("  - スクリーニング: 60秒ごと");
  console.log("  - リスクモニター: 30秒ごと");
  console.log("  - DN戦略サイクル: 60秒ごと");
}

// 全ジョブを停止
export function stopAllJobs(): void {
  if (screeningInterval) {
    clearInterval(screeningInterval);
    screeningInterval = null;
  }
  if (riskMonitorInterval) {
    clearInterval(riskMonitorInterval);
    riskMonitorInterval = null;
  }
  if (strategyCycleInterval) {
    clearInterval(strategyCycleInterval);
    strategyCycleInterval = null;
  }
  cron.getTasks().forEach((task) => task.stop());
  console.log("[スケジューラ] 全ジョブ停止");
}
