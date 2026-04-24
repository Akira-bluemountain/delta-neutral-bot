/**
 * リスク管理モニター
 * 両ベニュー統合監視、ドリフト検出、清算接近警告、サーキットブレーカー
 */
import { DN_PARAMS, RISK_PARAMS, EXECUTION_PARAMS, VENUES } from "../core/config";
import {
  RiskLevel,
  RiskAlert,
  RiskReport,
  VenueAccountSummary,
  PairRiskAssessment,
  DnPair,
  VenueId,
} from "../core/types";
import {
  getAccountState as getHlAccount,
  HlAccountState,
  HlPosition,
} from "../execution/hl-executor";
import {
  getAccountState as getExtAccount,
  ExtAccountState,
  ExtPosition,
} from "../execution/ext-executor";
import {
  getActiveDnPairs,
  updateDnPairStatus,
  savePositionSnapshot,
  getLatestSnapshot,
  updateDnPairAccumulatedFr,
  markDnPairBreakeven,
} from "../db/positions";
import { calculateAccumulatedFr } from "../strategy/fee-recovery-helpers";
import { fetchFundingRates as fetchHlFundingRates } from "../collectors/hyperliquid";
import { fetchFundingRates as fetchExtFundingRates } from "../collectors/extended";
import { hlToExtSymbol, extToHlSymbol } from "../core/symbol-mapping";
import { getMaxPositionUsd, isThinBookSymbol } from "../core/symbol-configs";

// サーキットブレーカー状態
let circuitBreakerActive = false;
let initialEquity: number | null = null;

// ===== Phase A Task A1: Alo (POST_ONLY) 拒否率モニタリング =====
// 直近 N 件のうち Alo 拒否された件数が閾値を超えたら警告通知。
// POST_ONLY 指値が攻めすぎている兆候を早期検出する。

/** POST_ONLY の発注結果履歴（true = Alo 拒否、false = 成功または正常な IOC フォールバック以外） */
const recentAloResults: boolean[] = [];
/** 前回の Alo 警告通知時刻（クールダウン判定用） */
let lastAloWarningAt = 0;

/**
 * Alo (POST_ONLY) の発注結果を記録する。
 * executor 側の openPostOnly から呼び出される。
 */
export function recordAloResult(rejected: boolean): void {
  recentAloResults.push(rejected);
  // サンプルサイズを超えたら古いものから削除（FIFO）
  while (recentAloResults.length > EXECUTION_PARAMS.aloRejectionSampleSize) {
    recentAloResults.shift();
  }
}

/**
 * 直近の Alo 拒否率をチェックし、閾値超なら警告通知を送る（Phase A Task A1）。
 * - サンプルが十分に溜まっていない（< サンプルサイズの半分）場合はスキップ
 * - クールダウン中（1時間以内に通知済み）はスキップ
 */
export function monitorAloRejectionRate(): void {
  const sampleSize = EXECUTION_PARAMS.aloRejectionSampleSize;
  const minSample = Math.floor(sampleSize / 2);

  if (recentAloResults.length < minSample) return;

  const rejectedCount = recentAloResults.filter((r) => r).length;
  const rate = rejectedCount / recentAloResults.length;

  if (rate < EXECUTION_PARAMS.aloRejectionWarnRate) return;

  const now = Date.now();
  if (now - lastAloWarningAt < EXECUTION_PARAMS.aloWarnCooldownMs) return;

  lastAloWarningAt = now;
  const msg =
    `[警告] POST_ONLY 拒否率が高い\n` +
    `直近 ${recentAloResults.length} 件中 ${rejectedCount} 件が拒否 ` +
    `(${(rate * 100).toFixed(1)}%、閾値 ${(EXECUTION_PARAMS.aloRejectionWarnRate * 100).toFixed(0)}%)\n` +
    `\n原因の可能性:\n` +
    `- POST_ONLY 指値オフセットが内側すぎる（板にすぐ sweep される）\n` +
    `- 市場ボラティリティが高く mid が頻繁に動く`;
  console.warn(msg);
}

/** 直近の Alo 拒否率（テスト・ダッシュボード用） */
export function getAloRejectionStats(): {
  sampleCount: number;
  rejectedCount: number;
  rate: number;
} {
  const rejectedCount = recentAloResults.filter((r) => r).length;
  return {
    sampleCount: recentAloResults.length,
    rejectedCount,
    rate:
      recentAloResults.length > 0
        ? rejectedCount / recentAloResults.length
        : 0,
  };
}

export function isCircuitBreakerActive(): boolean {
  return circuitBreakerActive;
}

export function resetCircuitBreaker(): void {
  circuitBreakerActive = false;
  console.log("[リスク] サーキットブレーカー解除");
}

export function setInitialEquity(equity: number): void {
  initialEquity = equity;
  console.log(`[リスク] 初期エクイティ設定: $${equity.toFixed(2)}`);
}

// --- メイン: リスクレポート生成 ---

export async function generateRiskReport(): Promise<RiskReport> {
  // 1. 両ベニューの口座状態を並列取得
  const [hlState, extState] = await Promise.all([
    getHlAccount().catch((): HlAccountState => ({
      accountValue: 0, totalMarginUsed: 0, withdrawable: 0, positions: [],
    })),
    getExtAccount().catch((): ExtAccountState => ({
      equity: 0, balance: 0, availableBalance: 0, unrealizedPnl: 0, positions: [],
    })),
  ]);

  // 2. ベニュー別サマリー
  const hlSummary = buildHlSummary(hlState);
  const extSummary = buildExtSummary(extState);
  const venues = [hlSummary, extSummary];

  const totalEquity = hlSummary.equity + extSummary.equity;
  const totalMarginUsed = hlSummary.marginUsed + extSummary.marginUsed;
  const totalUnrealizedPnl = hlSummary.unrealizedPnl + extSummary.unrealizedPnl;

  // 初期エクイティ未設定なら設定
  if (initialEquity === null && totalEquity > 0) {
    setInitialEquity(totalEquity);
  }

  // 3. アクティブDNペアのリスク評価
  const activePairs = getActiveDnPairs();
  const pairAssessments = activePairs.map((pair) =>
    assessPairRisk(pair, hlState, extState)
  );

  // 3.1. Task B3: 保有中ペアの FR 受取を累積し、手数料回収達成を検出
  //   - open ペアのみ対象（opening/closing/manual_review は対象外）
  //   - 現在の HL/EXT の FR レートを取得してペアごとに近似積算
  //   - 取得失敗時は skip（次サイクルで再試行、保守的）
  await updateFrAccrualForOpenPairs(activePairs);

  // 3.5. DB ↔ 取引所ポジション reconcile
  // (a) DB open ペアと取引所ポジションの突合（幻ペア検知）
  // (b) 取引所にあるが DB にペアがない孤立ポジション検知
  reconcilePairs(activePairs, hlState, extState);
  detectOrphanPositions(activePairs, hlState, extState);

  // 4. 口座レベルのアラート
  const accountAlerts: RiskAlert[] = [];
  checkMarginUsage(hlSummary, accountAlerts);
  checkMarginUsage(extSummary, accountAlerts);
  checkCollateralBuffer(hlState, extState, accountAlerts);
  checkUnrealizedLoss(totalUnrealizedPnl, accountAlerts);
  checkDrawdown(totalEquity, accountAlerts);

  // 5. 全アラート集約
  const allAlerts = [
    ...accountAlerts,
    ...pairAssessments.flatMap((p) => p.alerts),
  ];

  // 6. サーキットブレーカー判定
  const hasCritical = allAlerts.some((a) => a.level === "CRITICAL");
  if (hasCritical && !circuitBreakerActive) {
    circuitBreakerActive = true;
    console.error("[リスク] サーキットブレーカー発動: CRITICALアラート検出");
    const reasons = allAlerts
      .filter((a) => a.level === "CRITICAL")
      .map((a) => a.message)
      .join("; ");
    console.error(`[リスク] サーキットブレーカー理由: ${reasons}`);
  }

  // 7. 総合リスクレベル
  const overallLevel: RiskLevel = hasCritical
    ? "CRITICAL"
    : allAlerts.some((a) => a.level === "WARN")
      ? "WARN"
      : "OK";

  const report: RiskReport = {
    timestamp: new Date(),
    overallLevel,
    venues,
    totalEquity,
    totalMarginUsed,
    totalUnrealizedPnl,
    pairs: pairAssessments,
    alerts: allAlerts,
    circuitBreakerTriggered: circuitBreakerActive,
  };

  // 8. レポート出力
  logRiskReport(report);

  // 9. Alo 拒否率モニタリング（Task A1）
  monitorAloRejectionRate();

  return report;
}

// ===== Task B3: 保有中ペアの FR 受取累積 =====
// open ペアの accumulated_fr_usd を現在の HL/EXT FR レートから近似計算し、
// expected_fee_usd に達したら fr_breakeven_at をセットする。
//
// 呼び出し契機: generateRiskReport の 3.1 ステップ（60 秒ごと）
// 計算式: 1h あたり perHourRevenue × 経過 h = accumulated_fr_usd
//   - longVenueRate, shortVenueRate は現在のスポット 1h rate
//   - 実際は FR が 1h ごとに変動するため近似（誤差は Phase B4 で改善余地）
//
// 符号規約（calculateAccumulatedFr のドキュメント参照）:
//   perIntervalRevenue = -longVenueRate * longNotional + shortVenueRate * shortNotional
//   → 負値もクリップせずそのまま記録（スプレッド反転の観測用）。
async function updateFrAccrualForOpenPairs(activePairs: DnPair[]): Promise<void> {
  const openPairs = activePairs.filter(
    (p) => p.status === "open" && p.openedAt !== null
  );
  if (openPairs.length === 0) return;

  // 両ベニューから最新 FR を取得（失敗時は skip）
  let hlRates: Map<string, number>;
  let extRates: Map<string, number>;
  try {
    const [hlList, extList] = await Promise.all([
      fetchHlFundingRates(),
      fetchExtFundingRates(),
    ]);
    hlRates = new Map(hlList.map((r) => [r.symbol, r.rate]));
    extRates = new Map(extList.map((r) => [r.symbol, r.rate]));
  } catch (err) {
    console.warn(
      `[FR累積] FR 取得失敗、今サイクル skip: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  const hlIntervalHours = VENUES.hyperliquid.fundingIntervalHours;
  const extIntervalHours = VENUES.extended.fundingIntervalHours;
  // HL/EXT とも 1h の想定（config.ts で同値）。万一異なる場合はペア側で丸めるが
  // 実装としては両ベニューが同じ interval である前提を取る（config 同期前提）。
  const fundingIntervalHours = hlIntervalHours;
  if (hlIntervalHours !== extIntervalHours) {
    console.warn(
      `[FR累積] HL/EXT の fundingIntervalHours が不一致 (HL=${hlIntervalHours} / EXT=${extIntervalHours}) — HL 側を採用`
    );
  }

  const nowMs = Date.now();

  for (const pair of openPairs) {
    // Task B4: extRates は EXT 命名 (1000PEPE) をキーとするため、
    // pair.symbol (HL 命名 = kPEPE) から変換して lookup する。
    // 非倍率銘柄は hlToExtSymbol が恒等 (BTC → BTC) なので影響なし。
    const extKey = hlToExtSymbol(pair.symbol);
    const longRate =
      pair.longVenue === "hyperliquid"
        ? hlRates.get(pair.symbol)
        : extRates.get(extKey);
    const shortRate =
      pair.shortVenue === "hyperliquid"
        ? hlRates.get(pair.symbol)
        : extRates.get(extKey);

    if (longRate === undefined || shortRate === undefined) {
      // 取引所から該当銘柄が消えた（delist 等） — accumulated を更新しない
      continue;
    }

    const elapsedMs = nowMs - (pair.openedAt as Date).getTime();
    const accumulatedFrUsd = calculateAccumulatedFr({
      longVenueRate: longRate,
      shortVenueRate: shortRate,
      longSize: pair.longSize,
      shortSize: pair.shortSize,
      longEntryPrice: pair.longEntryPrice,
      shortEntryPrice: pair.shortEntryPrice,
      elapsedMs,
      fundingIntervalHours,
    });

    updateDnPairAccumulatedFr(pair.id, accumulatedFrUsd);

    // 手数料回収達成の検出（expected_fee_usd > 0 のペアのみ、既達成はスキップ）
    if (
      pair.expectedFeeUsd > 0 &&
      pair.frBreakevenAt === null &&
      accumulatedFrUsd >= pair.expectedFeeUsd
    ) {
      const isoNow = new Date(nowMs).toISOString();
      markDnPairBreakeven(pair.id, isoNow);
      console.log(
        `[FR回収] ${pair.symbol}#${pair.id} 手数料回収達成: ` +
          `FR受取 $${accumulatedFrUsd.toFixed(4)} >= 手数料 $${pair.expectedFeeUsd.toFixed(4)}`
      );
    }

    // スプレッド反転の可視化（負値はクリップせず警告レベルで記録）
    if (accumulatedFrUsd < 0) {
      // 60 秒ごとに出るのはノイズなので WARN は入れない。debug 相当のログのみ。
      console.log(
        `[FR累積] ${pair.symbol}#${pair.id} 現在累積 $${accumulatedFrUsd.toFixed(4)} (負値: スプレッド反転中)`
      );
    }
  }
}

// --- ベニュー別サマリー構築 ---

function buildHlSummary(state: HlAccountState): VenueAccountSummary {
  const marginPct =
    state.accountValue > 0
      ? (state.totalMarginUsed / state.accountValue) * 100
      : 0;
  return {
    venue: "hyperliquid",
    equity: state.accountValue,
    marginUsed: state.totalMarginUsed,
    marginUsagePct: marginPct,
    availableBalance: state.withdrawable,
    unrealizedPnl: state.positions.reduce((s, p) => s + p.unrealizedPnl, 0),
    positionCount: state.positions.length,
  };
}

function buildExtSummary(state: ExtAccountState): VenueAccountSummary {
  const marginPct =
    state.equity > 0
      ? ((state.equity - state.availableBalance) / state.equity) * 100
      : 0;
  return {
    venue: "extended",
    equity: state.equity,
    marginUsed: state.equity - state.availableBalance,
    marginUsagePct: marginPct,
    availableBalance: state.availableBalance,
    unrealizedPnl: state.unrealizedPnl,
    positionCount: state.positions.length,
  };
}

// --- DNペアのリスク評価 ---

function assessPairRisk(
  pair: DnPair,
  hlState: HlAccountState,
  extState: ExtAccountState
): PairRiskAssessment {
  const alerts: RiskAlert[] = [];

  // ドリフト計算
  const driftPct = calculateDrift(pair.longSize, pair.shortSize);

  // 清算接近チェック
  const longLiqProx = findLiquidationProximity(
    pair.symbol, pair.longVenue, hlState, extState
  );
  const shortLiqProx = findLiquidationProximity(
    pair.symbol, pair.shortVenue, hlState, extState
  );

  // 未実現PnL
  const netPnl = calculatePairPnl(pair, hlState, extState);

  // 累積ファンディング
  const latestSnap = getLatestSnapshot(pair.id);
  const accFunding = latestSnap?.accumulatedFunding ?? 0;

  // ドリフトアラート
  if (Math.abs(driftPct) >= RISK_PARAMS.driftCriticalPct) {
    alerts.push({
      level: "CRITICAL",
      category: "drift",
      symbol: pair.symbol,
      pairId: pair.id,
      message: `ポジションズレ ${driftPct.toFixed(2)}% — 自動補正が必要`,
      value: Math.abs(driftPct),
      threshold: RISK_PARAMS.driftCriticalPct,
    });
  } else if (Math.abs(driftPct) >= RISK_PARAMS.driftWarnPct) {
    alerts.push({
      level: "WARN",
      category: "drift",
      symbol: pair.symbol,
      pairId: pair.id,
      message: `ポジションズレ ${driftPct.toFixed(2)}% — 監視継続`,
      value: Math.abs(driftPct),
      threshold: RISK_PARAMS.driftWarnPct,
    });
  }

  // 清算接近アラート
  checkLiquidationProximity(longLiqProx, pair.longVenue, pair, alerts);
  checkLiquidationProximity(shortLiqProx, pair.shortVenue, pair, alerts);

  // スナップショット保存
  if (pair.status === "open" && (pair.longSize > 0 || pair.shortSize > 0)) {
    const longValueUsd = estimatePositionValue(
      pair.symbol, pair.longVenue, pair.longSize, hlState, extState
    );
    const shortValueUsd = estimatePositionValue(
      pair.symbol, pair.shortVenue, pair.shortSize, hlState, extState
    );
    savePositionSnapshot({
      pairId: pair.id,
      longSize: pair.longSize,
      shortSize: pair.shortSize,
      longValueUsd,
      shortValueUsd,
      driftPct,
      netUnrealizedPnl: netPnl,
      accumulatedFunding: accFunding,
      timestamp: new Date().toISOString(),
    });
  }

  // Task B3: 保有時間 / 手数料回収状況を計算
  const holdDurationMinutes = pair.openedAt
    ? Math.floor((Date.now() - pair.openedAt.getTime()) / 60000)
    : null;

  return {
    pairId: pair.id,
    symbol: pair.symbol,
    driftPct,
    longLiquidationProximityPct: longLiqProx,
    shortLiquidationProximityPct: shortLiqProx,
    netUnrealizedPnl: netPnl,
    accumulatedFunding: accFunding,
    alerts,
    holdDurationMinutes,
    expectedFeeUsd: pair.expectedFeeUsd,
    accumulatedFrUsd: pair.accumulatedFrUsd,
    feeRecovered: pair.frBreakevenAt !== null,
  };
}

// --- チェック関数群 ---

function checkMarginUsage(
  summary: VenueAccountSummary,
  alerts: RiskAlert[]
): void {
  if (summary.equity <= 0) return;

  if (summary.marginUsagePct >= RISK_PARAMS.marginUsageCriticalPct) {
    alerts.push({
      level: "CRITICAL",
      category: "margin",
      venue: summary.venue,
      message: `${summary.venue} 証拠金使用率 ${summary.marginUsagePct.toFixed(1)}% — 新規建て停止`,
      value: summary.marginUsagePct,
      threshold: RISK_PARAMS.marginUsageCriticalPct,
    });
  } else if (summary.marginUsagePct >= RISK_PARAMS.marginUsageWarnPct) {
    alerts.push({
      level: "WARN",
      category: "margin",
      venue: summary.venue,
      message: `${summary.venue} 証拠金使用率 ${summary.marginUsagePct.toFixed(1)}%`,
      value: summary.marginUsagePct,
      threshold: RISK_PARAMS.marginUsageWarnPct,
    });
  }
}

function checkCollateralBuffer(
  hlState: HlAccountState,
  extState: ExtAccountState,
  alerts: RiskAlert[]
): void {
  const threshold = DN_PARAMS.freeUsdtThreshold;

  if (hlState.withdrawable < threshold && hlState.accountValue > 0) {
    alerts.push({
      level: "WARN",
      category: "collateral",
      venue: "hyperliquid",
      message: `HL 出金可能残高 $${hlState.withdrawable.toFixed(0)} < 閾値 $${threshold}`,
      value: hlState.withdrawable,
      threshold,
    });
  }

  if (extState.availableBalance < threshold && extState.equity > 0) {
    alerts.push({
      level: "WARN",
      category: "collateral",
      venue: "extended",
      message: `Extended 利用可能残高 $${extState.availableBalance.toFixed(0)} < 閾値 $${threshold}`,
      value: extState.availableBalance,
      threshold,
    });
  }
}

function checkUnrealizedLoss(
  totalUnrealizedPnl: number,
  alerts: RiskAlert[]
): void {
  if (totalUnrealizedPnl < RISK_PARAMS.maxUnrealizedLossUsd) {
    alerts.push({
      level: "CRITICAL",
      category: "loss",
      message: `未実現損失 $${totalUnrealizedPnl.toFixed(2)} — 閾値 $${RISK_PARAMS.maxUnrealizedLossUsd} 超過`,
      value: totalUnrealizedPnl,
      threshold: RISK_PARAMS.maxUnrealizedLossUsd,
    });
  }
}

function checkDrawdown(totalEquity: number, alerts: RiskAlert[]): void {
  if (initialEquity === null || initialEquity <= 0) return;

  const drawdownPct = ((initialEquity - totalEquity) / initialEquity) * 100;
  if (drawdownPct >= RISK_PARAMS.maxDrawdownPct) {
    alerts.push({
      level: "CRITICAL",
      category: "drawdown",
      message: `ドローダウン ${drawdownPct.toFixed(1)}% (初期$${initialEquity.toFixed(0)} → 現在$${totalEquity.toFixed(0)})`,
      value: drawdownPct,
      threshold: RISK_PARAMS.maxDrawdownPct,
    });
  }
}

function checkLiquidationProximity(
  proximityPct: number | null,
  venue: VenueId,
  pair: DnPair,
  alerts: RiskAlert[]
): void {
  if (proximityPct === null) return;

  if (proximityPct <= RISK_PARAMS.liquidationCriticalPct) {
    alerts.push({
      level: "CRITICAL",
      category: "liquidation",
      venue,
      symbol: pair.symbol,
      pairId: pair.id,
      message: `${venue} ${pair.symbol} 清算まで ${proximityPct.toFixed(1)}%`,
      value: proximityPct,
      threshold: RISK_PARAMS.liquidationCriticalPct,
    });
  } else if (proximityPct <= RISK_PARAMS.liquidationWarnPct) {
    alerts.push({
      level: "WARN",
      category: "liquidation",
      venue,
      symbol: pair.symbol,
      pairId: pair.id,
      message: `${venue} ${pair.symbol} 清算まで ${proximityPct.toFixed(1)}%`,
      value: proximityPct,
      threshold: RISK_PARAMS.liquidationWarnPct,
    });
  }
}

// --- 計算ヘルパー ---

function calculateDrift(longSize: number, shortSize: number): number {
  const avg = (longSize + shortSize) / 2;
  if (avg === 0) return 0;
  return ((longSize - shortSize) / avg) * 100;
}

// Task B4: ペアの symbol は HL 命名で統一保存（kPEPE）。
// EXT 側のポジション照合は 1000PEPE-USD 市場名で行うため hlToExtSymbol で変換。
// 非倍率銘柄は変換恒等（BTC → BTC）なので副作用なし。

function findLiquidationProximity(
  symbol: string,
  venue: VenueId,
  hlState: HlAccountState,
  extState: ExtAccountState
): number | null {
  if (venue === "hyperliquid") {
    const pos = hlState.positions.find((p) => p.coin === symbol);
    if (!pos || pos.liquidationPrice === null) return null;
    const markPrice = pos.entryPrice; // 近似（実際はmarkPriceが望ましい）
    if (markPrice <= 0) return null;
    return (Math.abs(markPrice - pos.liquidationPrice) / markPrice) * 100;
  } else {
    const marketName = `${hlToExtSymbol(symbol)}-USD`;
    const pos = extState.positions.find((p) => p.market === marketName);
    if (!pos || pos.liquidationPrice === null) return null;
    if (pos.markPrice <= 0) return null;
    return (
      (Math.abs(pos.markPrice - pos.liquidationPrice) / pos.markPrice) * 100
    );
  }
}

function calculatePairPnl(
  pair: DnPair,
  hlState: HlAccountState,
  extState: ExtAccountState
): number {
  let pnl = 0;
  const extMarketName = `${hlToExtSymbol(pair.symbol)}-USD`;

  // Long側
  if (pair.longVenue === "hyperliquid") {
    const pos = hlState.positions.find((p) => p.coin === pair.symbol);
    if (pos) pnl += pos.unrealizedPnl;
  } else {
    const pos = extState.positions.find((p) => p.market === extMarketName);
    if (pos) pnl += pos.unrealizedPnl;
  }

  // Short側
  if (pair.shortVenue === "hyperliquid") {
    const pos = hlState.positions.find((p) => p.coin === pair.symbol);
    if (pos) pnl += pos.unrealizedPnl;
  } else {
    const pos = extState.positions.find((p) => p.market === extMarketName);
    if (pos) pnl += pos.unrealizedPnl;
  }

  return pnl;
}

function estimatePositionValue(
  symbol: string,
  venue: VenueId,
  size: number,
  hlState: HlAccountState,
  extState: ExtAccountState
): number {
  if (venue === "hyperliquid") {
    const pos = hlState.positions.find((p) => p.coin === symbol);
    return pos?.positionValue ?? 0;
  } else {
    const pos = extState.positions.find(
      (p) => p.market === `${hlToExtSymbol(symbol)}-USD`
    );
    return pos?.value ?? 0;
  }
}

// --- ログ出力 ---

function logRiskReport(report: RiskReport): void {
  const levelIcon =
    report.overallLevel === "CRITICAL"
      ? "!!!"
      : report.overallLevel === "WARN"
        ? "!"
        : "";

  console.log(
    `[リスク] ${levelIcon} 総合: ${report.overallLevel} | エクイティ: $${report.totalEquity.toFixed(2)} | 未実現PnL: $${report.totalUnrealizedPnl.toFixed(2)} | アラート: ${report.alerts.length}件`
  );

  for (const venue of report.venues) {
    if (venue.equity > 0) {
      console.log(
        `  ${venue.venue}: $${venue.equity.toFixed(2)} 証拠金${venue.marginUsagePct.toFixed(1)}% ポジ${venue.positionCount}件`
      );
    }
  }

  for (const pair of report.pairs) {
    // Task B3: 保有時間と手数料回収状況を可視化
    const holdStr =
      pair.holdDurationMinutes !== null
        ? `保有${Math.floor(pair.holdDurationMinutes / 60)}h${pair.holdDurationMinutes % 60}m`
        : "保有--";

    // Task B5: 薄板銘柄のサイズ上限表示
    const sizeStr = isThinBookSymbol(pair.symbol)
      ? ` | サイズ $${getMaxPositionUsd(pair.symbol)} (薄板)`
      : "";

    let feeStr = "";
    if (pair.expectedFeeUsd > 0) {
      const recoveryPct = (pair.accumulatedFrUsd / pair.expectedFeeUsd) * 100;
      const status = pair.feeRecovered
        ? `✓ 回収済`
        : `${recoveryPct.toFixed(0)}% 回収`;
      feeStr = ` | FR受取 $${pair.accumulatedFrUsd.toFixed(3)} / 手数料 $${pair.expectedFeeUsd.toFixed(3)} | ${status}`;
    } else {
      // 旧ペア（Task B3 以前）は expectedFeeUsd=0
      feeStr = " | (旧ペア、手数料見積なし)";
    }

    console.log(
      `  ${pair.symbol}[#${pair.pairId}]: ${holdStr}${sizeStr} | ドリフト${pair.driftPct.toFixed(2)}% PnL$${pair.netUnrealizedPnl.toFixed(2)}${feeStr}`
    );
  }

  for (const alert of report.alerts) {
    const prefix = alert.level === "CRITICAL" ? "  [!!!]" : "  [!]";
    console.log(`${prefix} ${alert.message}`);
  }

  if (report.circuitBreakerTriggered) {
    console.error("[リスク] サーキットブレーカー作動中 — 新規注文停止");
  }
}

// --- DB ↔ 取引所ポジション reconcile ---

type PositionMatchStatus = "matched" | "gone" | "wrong_direction";

interface PositionMatch {
  status: PositionMatchStatus;
  actualSize: number;
}

function matchPosition(
  symbol: string,
  venue: VenueId,
  expectedSide: "long" | "short",
  hlState: HlAccountState,
  extState: ExtAccountState
): PositionMatch {
  if (venue === "hyperliquid") {
    const pos = hlState.positions.find((p) => p.coin === symbol);
    if (!pos || pos.size === 0) return { status: "gone", actualSize: 0 };
    const isLong = pos.size > 0;
    const directionOk =
      (expectedSide === "long" && isLong) ||
      (expectedSide === "short" && !isLong);
    return directionOk
      ? { status: "matched", actualSize: Math.abs(pos.size) }
      : { status: "wrong_direction", actualSize: Math.abs(pos.size) };
  }

  // Task B4: 入力 symbol は HL 命名 (kPEPE)、EXT 市場名は 1000PEPE-USD 形式
  const marketName = `${hlToExtSymbol(symbol)}-USD`;
  const pos = extState.positions.find((p) => p.market === marketName);
  if (!pos || pos.size === 0) return { status: "gone", actualSize: 0 };
  const posIsLong = pos.side === "LONG";
  const directionOk =
    (expectedSide === "long" && posIsLong) ||
    (expectedSide === "short" && !posIsLong);
  return directionOk
    ? { status: "matched", actualSize: pos.size }
    : { status: "wrong_direction", actualSize: pos.size };
}

function reconcilePairs(
  activePairs: DnPair[],
  hlState: HlAccountState,
  extState: ExtAccountState
): void {
  for (const pair of activePairs) {
    if (pair.status !== "open") continue;

    const longMatch = matchPosition(
      pair.symbol,
      pair.longVenue,
      "long",
      hlState,
      extState
    );
    const shortMatch = matchPosition(
      pair.symbol,
      pair.shortVenue,
      "short",
      hlState,
      extState
    );

    // 方向逆転: 手動で反対ポジションを建てた等 → 即 manual_review
    if (longMatch.status === "wrong_direction" || shortMatch.status === "wrong_direction") {
      const msg =
        `[reconcile] ${pair.symbol}#${pair.id} ポジション方向逆転` +
        ` Long(${pair.longVenue})=${longMatch.status}` +
        ` Short(${pair.shortVenue})=${shortMatch.status}`;
      console.error(msg);
      updateDnPairStatus(pair.id, "manual_review", {
        closeReason: `reconcile: ポジション方向逆転を検知`,
      });
      continue;
    }

    // 両側消滅: 手動クローズ or 清算で取引所上にポジションが無い → DB を自動 closed
    if (longMatch.status === "gone" && shortMatch.status === "gone") {
      console.warn(
        `[reconcile] ${pair.symbol}#${pair.id} 両側ポジション消滅 → DB closed`
      );
      updateDnPairStatus(pair.id, "closed", {
        closeReason: "reconcile: 両側ポジション消滅（手動クローズ or 清算）",
      });
      continue;
    }

    // 片側消滅: ナケットポジション → manual_review
    if (longMatch.status === "gone" || shortMatch.status === "gone") {
      const goneSide = longMatch.status === "gone" ? "Long" : "Short";
      const goneVenue =
        longMatch.status === "gone" ? pair.longVenue : pair.shortVenue;
      const msg =
        `[reconcile] ${pair.symbol}#${pair.id} ${goneSide}(${goneVenue})が消滅 → manual_review`;
      console.error(msg);
      updateDnPairStatus(pair.id, "manual_review", {
        closeReason: `reconcile: ${goneSide}側ポジション消滅`,
      });
      continue;
    }

    // 両側存在: サイズ乖離チェック（DB記録と取引所実態の比較）
    const SIZE_DRIFT_THRESHOLD = 0.10; // 10%
    for (const { label, dbSize, actualSize, venue } of [
      { label: "Long", dbSize: pair.longSize, actualSize: longMatch.actualSize, venue: pair.longVenue },
      { label: "Short", dbSize: pair.shortSize, actualSize: shortMatch.actualSize, venue: pair.shortVenue },
    ]) {
      if (dbSize <= 0) continue;
      const drift = Math.abs(actualSize - dbSize) / dbSize;
      if (drift > SIZE_DRIFT_THRESHOLD) {
        console.warn(
          `[reconcile] ${pair.symbol}#${pair.id} ${label}(${venue}) サイズ乖離` +
          ` DB=${dbSize.toFixed(6)} 実態=${actualSize.toFixed(6)} (${(drift * 100).toFixed(1)}%)`
        );
      }
    }
  }
}

// --- 孤立ポジション検知 ---
// 取引所にポジションがあるが DB に対応する open ペアがないケースを検知。
// エグジット処理の不完全（片側だけ閉じ損ねた等）で発生する。
// 重複通知防止: 同じ孤立ポジションを5分以内に再通知しない

const orphanNotifiedAt = new Map<string, number>();
const ORPHAN_NOTIFY_COOLDOWN_MS = 5 * 60 * 1000;

function detectOrphanPositions(
  activePairs: DnPair[],
  hlState: HlAccountState,
  extState: ExtAccountState
): void {
  // DB の active ペアがカバーしている「ベニュー×シンボル×方向」の集合
  const covered = new Set<string>();
  for (const pair of activePairs) {
    if (pair.status !== "open") continue;
    covered.add(`${pair.longVenue}:${pair.symbol}:long`);
    covered.add(`${pair.shortVenue}:${pair.symbol}:short`);
  }

  const orphans: Array<{ venue: string; symbol: string; side: string; size: number }> = [];

  // HL ポジション
  for (const pos of hlState.positions) {
    if (pos.size === 0) continue;
    const side = pos.size > 0 ? "long" : "short";
    const key = `hyperliquid:${pos.coin}:${side}`;
    if (!covered.has(key)) {
      orphans.push({
        venue: "hyperliquid",
        symbol: pos.coin,
        side,
        size: Math.abs(pos.size),
      });
    }
  }

  // Extended ポジション
  // Task B4: EXT 命名 (1000PEPE) を HL 命名 (kPEPE) に変換して covered Set と突合
  // （covered は pair.symbol = HL 命名で登録されているため）
  // ログ出力・orphan レコードは HL 命名で統一（観測性と DB 整合性のため）
  for (const pos of extState.positions) {
    if (pos.size === 0) continue;
    const extBare = pos.market.replace("-USD", "");
    const symbol = extToHlSymbol(extBare);
    const side = pos.side === "LONG" ? "long" : "short";
    const key = `extended:${symbol}:${side}`;
    if (!covered.has(key)) {
      orphans.push({ venue: "extended", symbol, side, size: pos.size });
    }
  }

  if (orphans.length === 0) return;

  // 通知クールダウン確認
  const now = Date.now();
  const newOrphans = orphans.filter((o) => {
    const key = `${o.venue}:${o.symbol}:${o.side}`;
    const lastNotified = orphanNotifiedAt.get(key) ?? 0;
    if (now - lastNotified < ORPHAN_NOTIFY_COOLDOWN_MS) return false;
    orphanNotifiedAt.set(key, now);
    return true;
  });

  if (newOrphans.length === 0) return;

  const lines = newOrphans.map(
    (o) => `  ${o.venue} ${o.symbol} ${o.side.toUpperCase()} size=${o.size}`
  );
  const msg =
    `[reconcile] 孤立ポジション検知: ${newOrphans.length}件\n` +
    `DBに対応するopenペアがないポジションが取引所にあります:\n` +
    lines.join("\n") +
    `\n\n手動でクローズするか、原因を調査してください。`;

  console.warn(msg);
}
