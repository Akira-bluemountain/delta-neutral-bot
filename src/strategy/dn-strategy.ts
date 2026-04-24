/**
 * デルタニュートラル戦略ロジック
 * スクリーニング → エントリー判定 → 並列注文 → DB追跡 → エグジット判定
 */
import { DN_PARAMS, VENUES } from "../core/config";
import {
  ScreeningResult,
  ArbitrageOpportunity,
  DnPair,
  VenueId,
  VenueAccountSummary,
} from "../core/types";
import { runScreening } from "../analyzers/screener";
import { detectArbitrageOpportunities } from "../analyzers/funding-arbitrage";
import {
  meetsFrThreshold,
  isWithinMinHold,
  exceedsMaxHold,
  isFrSpreadCollapsed,
} from "./helpers";
import { decrementAvailable } from "./parallel-entry-helpers";
import {
  shouldBlockClosureForFee,
  calculateExpectedFee,
} from "./fee-recovery-helpers";
import { hlToExtSymbol } from "../core/symbol-mapping";
import { getMaxPositionUsd, isThinBookSymbol } from "../core/symbol-configs";
import { isCircuitBreakerActive, generateRiskReport } from "../risk/monitor";
import { randomUUID } from "node:crypto";
import {
  openWithMode as hlOpenWithMode,
  updateLeverage as hlUpdateLeverage,
  generateCloid,
} from "../execution/hl-executor";
import {
  openExtWithMode,
} from "../execution/ext-executor";
import {
  createDnPair,
  updateDnPairStatus,
  finalizeOpenedPair,
  getActiveDnPairs,
  getActiveDnPairBySymbol,
  createOrder,
  updateOrderStatus,
  recordTrade,
} from "../db/positions";

// --- ドライランモード ---
let dryRun = true;

export function setDryRun(enabled: boolean): void {
  dryRun = enabled;
  console.log(`[DN戦略] ドライラン: ${enabled ? "ON（注文なし）" : "OFF（実注文）"}`);
}

export function isDryRun(): boolean {
  return dryRun;
}

// --- ロールバック後クールダウン ---
// ロールバックした銘柄に再エントリーしない期間（ZORA 13連続ロールバック防止）
const ROLLBACK_COOLDOWN_MS = 60 * 60 * 1000; // 60分
const rollbackCooldowns = new Map<string, number>();

export function setRollbackCooldown(symbol: string): void {
  rollbackCooldowns.set(symbol, Date.now());
  console.log(`[DN戦略] ${symbol} ロールバッククールダウン設定（${ROLLBACK_COOLDOWN_MS / 60000}分間エントリー禁止）`);
}

function isInRollbackCooldown(symbol: string): boolean {
  const lastRollback = rollbackCooldowns.get(symbol);
  if (!lastRollback) return false;
  if (Date.now() - lastRollback >= ROLLBACK_COOLDOWN_MS) {
    rollbackCooldowns.delete(symbol);
    return false;
  }
  return true;
}

// --- FR切り替わり直後の抑制 ---
const FR_COOLDOWN_MS = 20 * 60 * 1000; // 20分
let lastFrSwitchTime: Date | null = null;

export function notifyFrSwitch(): void {
  lastFrSwitchTime = new Date();
  console.log("[DN戦略] FR切り替わり検出 → 20分間閾値更新を回避");
}

function isInFrCooldown(): boolean {
  if (!lastFrSwitchTime) return false;
  return Date.now() - lastFrSwitchTime.getTime() < FR_COOLDOWN_MS;
}

// --- メイン: 戦略サイクル ---

export interface StrategyCycleResult {
  evaluated: number;
  opened: string[];
  closed: string[];
  skipped: string[];
  errors: string[];
}

export async function runStrategyCycle(): Promise<StrategyCycleResult> {
  const result: StrategyCycleResult = {
    evaluated: 0,
    opened: [],
    closed: [],
    skipped: [],
    errors: [],
  };

  // 1. サーキットブレーカーチェック
  if (isCircuitBreakerActive()) {
    console.log("[DN戦略] サーキットブレーカー作動中 → スキップ");
    return result;
  }

  // 2. リスクレポート取得
  const riskReport = await generateRiskReport();
  if (riskReport.overallLevel === "CRITICAL") {
    console.log("[DN戦略] リスクCRITICAL → 新規エントリー停止");
    // エグジット判定のみ実施
    await evaluateExits(result);
    return result;
  }

  // 3. エグジット判定（既存ペア）
  await evaluateExits(result);

  // 4. エントリー判定（新規）
  await evaluateEntries(result, riskReport.venues);

  logCycleResult(result);

  return result;
}

// --- エントリー判定 ---

interface EntryCandidate {
  screening: ScreeningResult;
  arbitrage: ArbitrageOpportunity | null;
  score: number;
}

async function evaluateEntries(
  result: StrategyCycleResult,
  venueSummaries: VenueAccountSummary[]
): Promise<void> {
  const availableByVenue = new Map<VenueId, number>();
  for (const v of venueSummaries) {
    availableByVenue.set(v.venue, v.availableBalance);
  }

  // スクリーニング + 裁定検出
  const [screenings, arbitrages] = await Promise.all([
    runScreening(),
    detectArbitrageOpportunities(),
  ]);

  const arbMap = new Map<string, ArbitrageOpportunity>();
  for (const arb of arbitrages) {
    arbMap.set(arb.symbol, arb);
  }

  // 候補評価
  const candidates: EntryCandidate[] = [];
  for (const s of screenings.slice(0, 20)) {
    result.evaluated++;
    const arb = arbMap.get(s.symbol) ?? null;

    // フィルタ条件
    if (!passesEntryFilter(s, arb, availableByVenue)) {
      result.skipped.push(s.symbol);
      continue;
    }

    // 統合スコア
    const score = calculateEntryScore(s, arb);
    candidates.push({ screening: s, arbitrage: arb, score });
  }

  // スコア順でソート、上位から実行
  candidates.sort((a, b) => b.score - a.score);

  // Task B2: 複数ペア並行保有
  //   - 上位 maxEntriesPerCycle 件まで pair-level sequential にエントリー
  //   - 同一サイクル内の銘柄重複を防止（DB コミット前の在庫チェック）
  //   - エントリー成功時に availableByVenue から positionUsd を減算し
  //     次候補の calculatePositionSizePerVenue へ反映（過剰割当防止）
  const maxEntries = DN_PARAMS.maxEntriesPerCycle;
  const willRun = Math.min(candidates.length, maxEntries);
  console.log(
    `[DN戦略] エントリー候補: ${candidates.length}銘柄、並行上限${maxEntries}銘柄、実行予定: ${willRun}銘柄`
  );

  const enteredThisCycle = new Set<string>();
  let openedCount = 0;

  // filterEntryCandidates: 同一サイクル重複排除 + 既 open スキップ + maxEntries 上限
  // ただしループ内で動的に enteredThisCycle が更新されるため、pre-filter は
  // 初期状態（別サイクル既 open のみ）に基づく。サイクル内重複は per-candidate で再判定。
  for (const candidate of candidates) {
    if (openedCount >= maxEntries) break;
    const symbol = candidate.screening.symbol;

    // 同一サイクル内の重複防止（DB コミット前でも検出できる）
    if (enteredThisCycle.has(symbol)) {
      console.log(
        `[DN戦略] ${symbol} スキップ: 同一サイクル内で既に並行エントリー試行済み`
      );
      continue;
    }

    // 直前に他サイクル処理で open になった可能性を再チェック
    const existing = getActiveDnPairBySymbol(symbol);
    if (existing) {
      console.log(
        `[DN戦略] ${symbol} スキップ: 既 open (dn_pairs#${existing.id} で保有中)`
      );
      continue;
    }

    try {
      const outcome = await executeOpen(candidate, result, availableByVenue);
      if (outcome === "filled" || outcome === "partial") {
        enteredThisCycle.add(symbol);
        openedCount++;
        console.log(
          `[DN戦略] ${symbol} エントリー処理完了（並行 ${openedCount}/${maxEntries} ペア）`
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`${symbol}: ${msg}`);
      console.error(`[DN戦略] エントリーエラー ${symbol}: ${msg}`);
    }
  }
}

function passesEntryFilter(
  s: ScreeningResult,
  arb: ArbitrageOpportunity | null,
  availableByVenue: Map<VenueId, number>
): boolean {
  const reject = (reason: string): boolean => {
    console.log(`[DN戦略] ${s.symbol} スキップ: ${reason}`);
    return false;
  };

  if (DN_PARAMS.symbolWhitelist.length > 0 && !DN_PARAMS.symbolWhitelist.includes(s.symbol)) {
    return reject("ホワイトリスト外");
  }
  if (getActiveDnPairBySymbol(s.symbol)) return reject("既存ペアあり");
  if (isInRollbackCooldown(s.symbol)) return reject("ロールバッククールダウン中");
  if (isInFrCooldown()) return reject("FR切り替わり20分以内");
  if (!s.extFundingRate) return reject("Extendedに銘柄なし");

  // FR判定: 両ベニューの大きい方の絶対値 or スプレッドで評価
  const hlRate = s.hlFundingRate.rate;
  const extRate = s.extFundingRate.rate;
  const maxAbsRate = Math.max(Math.abs(hlRate), Math.abs(extRate));
  const spread = Math.abs(hlRate - extRate);
  const frOpen = DN_PARAMS.frOpen;
  if (!meetsFrThreshold(maxAbsRate, spread, frOpen)) {
    return reject(
      `FR/スプレッド不足: max=${(maxAbsRate * 100).toFixed(4)}%, spread=${(spread * 100).toFixed(4)}% < ${(frOpen * 100).toFixed(4)}%`
    );
  }

  // スコア判定: 高確信度のみエントリー（手数料負けを防止）
  const hasHighConfArb = arb && arb.confidence === "HIGH" && arb.spreadAnnualized > 50;
  if (!hasHighConfArb && s.compositeScore < DN_PARAMS.minEntryScore) {
    return reject(`スコア不足: ${s.compositeScore.toFixed(1)} < ${DN_PARAMS.minEntryScore}`);
  }

  // APY判定: HIGH信頼度裁定機会はバイパス
  if (!hasHighConfArb && s.estimatedApy <= 0) {
    return reject(`APY非正: ${s.estimatedApy.toFixed(1)}%`);
  }

  // ベニュー別ポジションサイズ判定 (Task B5: 銘柄別 maxPositionUsd を適用)
  const longVenue: VenueId = s.recommendedShortVenue === "hyperliquid" ? "extended" : "hyperliquid";
  const shortVenue: VenueId = s.recommendedShortVenue;
  const longAvail = availableByVenue.get(longVenue) ?? 0;
  const shortAvail = availableByVenue.get(shortVenue) ?? 0;
  const positionUsd = calculatePositionSizePerVenue(s.symbol, longAvail, shortAvail);
  if (positionUsd < DN_PARAMS.minOrderUsd) {
    return reject(
      `ポジションサイズ不足: $${positionUsd.toFixed(0)} < $${DN_PARAMS.minOrderUsd}` +
      ` (Long ${longVenue}=$${longAvail.toFixed(0)}, Short ${shortVenue}=$${shortAvail.toFixed(0)})`
    );
  }

  return true;
}

function calculateEntryScore(
  s: ScreeningResult,
  arb: ArbitrageOpportunity | null
): number {
  let score = s.compositeScore;

  // 裁定スプレッドが大きいほどボーナス
  if (arb) {
    score += arb.spreadAnnualized * 0.5;
    if (arb.confidence === "HIGH") score += 20;
  }

  return score;
}

// --- ポジションサイズ計算（ベニュー別） ---

// 必要証拠金の概算係数（cross 5x 想定 + 安全バッファ）
// 片側 positionUsd に対し、最低この比率の利用可能残高を要求
const REQUIRED_MARGIN_RATIO = 0.25;

/**
 * ベニュー別の利用可能残高から、両ベニューが安全に支えられる最大ポジションサイズを算出。
 *
 * 旧設計（totalEquity * 0.2）は HL $50 / EXT $200 のように偏った場合に
 * 合算$250 × 20% = $50 を両側に要求 → HL が margin error を起こす根本原因だった。
 *
 * 新設計:
 * 1. 各ベニューの「freeUsdtThreshold を確保した後の実質利用可能額」を算出
 * 2. 実質利用可能額 / REQUIRED_MARGIN_RATIO = そのベニューが支えられる最大ポジション
 * 3. 両ベニューの小さい方と 銘柄別の maxPositionUsd (Task B5) の min を取る
 *
 * Task B5: symbol 引数を追加。SYMBOL_CONFIGS に登録された薄板銘柄では小さい上限
 * （例: $10）を適用、未登録銘柄は DN_PARAMS.maxPositionUsd ($50) にフォールバック。
 */
function calculatePositionSizePerVenue(
  symbol: string,
  longVenueAvailable: number,
  shortVenueAvailable: number
): number {
  const threshold = DN_PARAMS.freeUsdtThreshold;

  const longEffective = Math.max(0, longVenueAvailable - threshold);
  const shortEffective = Math.max(0, shortVenueAvailable - threshold);

  const longMax = longEffective / REQUIRED_MARGIN_RATIO;
  const shortMax = shortEffective / REQUIRED_MARGIN_RATIO;

  const symbolMax = getMaxPositionUsd(symbol);
  return Math.min(longMax, shortMax, symbolMax);
}

// --- エントリー実行 ---

// Task B2: 戻り値で並行エントリーループの状態遷移を正確にハンドル
//   - "filled":  両側約定、次候補のために availableByVenue 減算済み
//   - "partial": 片側約定→ロールバック、または ambiguous／manual_review 化
//                （実ポジションが発生または AMBIGUOUS。同銘柄の再試行は今サイクル行わない）
//   - "failed":  発注前バリデーション失敗 or 両側 timeout/rejected で残ポジなし
//                （次候補が同銘柄の場合は enteredThisCycle 判定で自然にスキップされる）
export type OpenOutcome = "filled" | "partial" | "failed";

async function executeOpen(
  candidate: EntryCandidate,
  result: StrategyCycleResult,
  availableByVenue: Map<VenueId, number>
): Promise<OpenOutcome> {
  const s = candidate.screening;
  const symbol = s.symbol;
  const longVenue: VenueId = s.recommendedShortVenue === "hyperliquid" ? "extended" : "hyperliquid";
  const shortVenue: VenueId = s.recommendedShortVenue;

  // FR正ならShort有利（Short@shortVenue + Long@longVenue）
  const reason = `FR裁定: ${symbol} APY${s.estimatedApy.toFixed(1)}% score=${candidate.score.toFixed(0)}`;

  // Task B5: 薄板銘柄ラベル（$10 tier 等）をエントリーログに明示
  const thinBookLabel = isThinBookSymbol(symbol)
    ? ` (薄板 $${getMaxPositionUsd(symbol)})`
    : "";
  console.log(
    `[DN戦略] エントリー候補: ${symbol}${thinBookLabel} Long=${longVenue} Short=${shortVenue} | ${reason}`
  );

  if (dryRun) {
    console.log(`[DN戦略] ドライラン: ${symbol} エントリースキップ（実注文なし）`);
    result.opened.push(`${symbol}(dry)`);
    return "filled";  // DRY_RUN では並行上限カウントに含める（擬似成功）
  }

  // ポジションサイズ（USD → ベースアセット数量）
  const midPrice = await getMidPrice(symbol);
  if (midPrice <= 0) {
    result.errors.push(`${symbol}: 中値取得不可`);
    return "failed";
  }

  // ベニュー別利用可能残高から安全なポジションサイズを算出
  // （旧設計: totalEquity合算の20% → 偏りがあると片側 margin error）
  // （新設計: 各ベニューの availableBalance - freeUsdtThreshold で独立計算）
  // Task B2: availableByVenue は前のエントリー成功時に減算されているため、
  //          3 ペア目の判定でも正しく残高が反映される
  // Task B5: 銘柄別 maxPositionUsd を適用（薄板銘柄は $10 で頭打ち）
  const longAvail = availableByVenue.get(longVenue) ?? 0;
  const shortAvail = availableByVenue.get(shortVenue) ?? 0;
  const positionUsd = calculatePositionSizePerVenue(symbol, longAvail, shortAvail);
  const size = positionUsd / midPrice;

  if (size <= 0 || positionUsd < DN_PARAMS.minOrderUsd) {
    result.errors.push(
      `${symbol}: ポジションサイズ不足 $${positionUsd.toFixed(2)}` +
      ` (Long ${longVenue}=$${longAvail.toFixed(0)}, Short ${shortVenue}=$${shortAvail.toFixed(0)})`
    );
    return "failed";
  }

  // 1. DBにペア作成
  const pairId = createDnPair({
    symbol,
    longVenue,
    shortVenue,
    targetSizeUsd: positionUsd,
    openReason: reason,
  });

  // 2. 両ベニューに並列注文
  // Phase A Task A1: entry は POST_ONLY（maker 料率狙い、タイムアウトで IOC フォールバック）
  const [longResult, shortResult] = await Promise.all([
    executeVenueOrder(longVenue, symbol, true, size, midPrice, pairId, false, "POST_ONLY"),
    executeVenueOrder(shortVenue, symbol, false, size, midPrice, pairId, false, "POST_ONLY"),
  ]);

  // 3. 結果処理 — outcome ベースで4分岐（Task A1.5 方針 Y）
  // (a) 両側 filled → 正常
  // (b) いずれかが ambiguous → 自動回復禁止、manual_review
  // (c) 両側 timeout or rejected（約定なし）→ 次サイクル再試行、DB closed
  // (d) 片側 filled + 片側 timeout/rejected → 約定側を reduce-only でロールバック
  //
  // 方針 Y: POST_ONLY 未約定（timeout）は失敗として扱い、IOC フォールバックしない。
  // 手数料負けの回避と、板に残存中の IOC 二重発注を防止（XMR#881 の根本原因対処）。

  if (longResult.outcome === "ambiguous" || shortResult.outcome === "ambiguous") {
    await escalateAmbiguous(
      pairId,
      symbol,
      "エントリー時AMBIGUOUS検知",
      longResult,
      shortResult,
      longVenue,
      shortVenue
    );
    result.errors.push(`${symbol}: AMBIGUOUS → manual_review`);
    return "partial";
  }

  if (longResult.outcome === "filled" && shortResult.outcome === "filled") {
    // Task B3: 往復手数料（entry + exit）を見積もって dn_pairs.expected_fee_usd に記録
    // - actualMode は executor が返す実際の発注モード（POST_ONLY / IOC / MARKET）
    // - 退場は executeClose が常に IOC 前提のため taker fee を両側で適用
    // - 手数料率は config.ts の VENUES[venue] を参照（ハードコード禁止）
    const longActualMode = longResult.actualMode ?? "POST_ONLY";
    const shortActualMode = shortResult.actualMode ?? "POST_ONLY";
    const longFilled = longResult.filledSize ?? size;
    const shortFilled = shortResult.filledSize ?? size;
    const longPrice = longResult.avgPrice ?? midPrice;
    const shortPrice = shortResult.avgPrice ?? midPrice;
    const expectedFeeUsd = calculateExpectedFee(
      {
        actualMode: longActualMode,
        makerFeeRate: VENUES[longVenue].makerFeeRate,
        takerFeeRate: VENUES[longVenue].takerFeeRate,
        fillPrice: longPrice,
        fillSize: longFilled,
      },
      {
        actualMode: shortActualMode,
        makerFeeRate: VENUES[shortVenue].makerFeeRate,
        takerFeeRate: VENUES[shortVenue].takerFeeRate,
        fillPrice: shortPrice,
        fillSize: shortFilled,
      }
    );

    // 原子的反映: サイズ / 約定価格 / expected_fee_usd / status=open / opened_at を 1 UPDATE で
    // 「open だが expected_fee_usd 未記録」の窓を完全排除（Phase 1 懸念 #2 対応）
    finalizeOpenedPair(pairId, {
      longSize: longFilled,
      shortSize: shortFilled,
      longEntryPrice: longPrice,
      shortEntryPrice: shortPrice,
      expectedFeeUsd,
    });
    result.opened.push(symbol);
    console.log(
      `[DN戦略] エントリー完了: ${symbol} pairId=${pairId} | ` +
        `往復手数料見積 $${expectedFeeUsd.toFixed(4)} ` +
        `(Long=${longActualMode}, Short=${shortActualMode})`
    );

    // Task B2: 次候補の判定のために availableByVenue から positionUsd を減算
    decrementAvailable(availableByVenue, longVenue, positionUsd);
    decrementAvailable(availableByVenue, shortVenue, positionUsd);

    return "filled";
  }

  // ---- ここは両側 outcome が確定しているが片側以上が timeout/rejected ----
  const sideDesc = (r: VenueOrderResult, label: string): string =>
    r.outcome === "filled"
      ? ""
      : `${label}: ${r.outcome}${r.error ? `(${r.error})` : ""}`;
  const errors = [
    sideDesc(longResult, `Long(${longVenue})`),
    sideDesc(shortResult, `Short(${shortVenue})`),
  ]
    .filter(Boolean)
    .join(", ");
  result.errors.push(`${symbol}: ${errors}`);

  // 約定済み片側を reduce-only 反対売買でロールバック
  const filledSide =
    longResult.outcome === "filled"
      ? {
          side: "long" as const,
          venue: longVenue,
          isCloseBuy: false,
          filled: longResult.filledSize ?? size,
        }
      : shortResult.outcome === "filled"
        ? {
            side: "short" as const,
            venue: shortVenue,
            isCloseBuy: true,
            filled: shortResult.filledSize ?? size,
          }
        : null;

  if (!filledSide) {
    // 両側 timeout or rejected（約定なし）→ 安全に closed
    // 方針 Y: 次サイクルで再試行（既存スクリーニングが FR 閾値等で候補判定する）
    const allTimeout =
      longResult.outcome === "timeout" && shortResult.outcome === "timeout";
    const closeReason = allTimeout
      ? `両側POST_ONLY タイムアウト（次サイクル再試行）: ${errors}`
      : `両側約定失敗: ${errors}`;
    updateDnPairStatus(pairId, "closed", { closeReason });
    if (allTimeout) {
      console.log(`[DN戦略] 両側 POST_ONLY タイムアウト ${symbol}: 次サイクル再試行`);
    } else {
      console.error(`[DN戦略] 両側約定失敗 ${symbol}: ${errors}`);
    }
    // Task B2: 両側とも約定せず安全に closed。次候補へ（同銘柄は enteredThisCycle 設定なしで自然スキップ）
    return "failed";
  }

  console.log(
    `[DN戦略] 自動ロールバック開始 ${symbol}: ${filledSide.venue} ${filledSide.side} ${filledSide.filled} を反対売買 (errors: ${errors})`
  );

  // ロールバックは IOC（デフォルト）で即時約定を狙う。POST_ONLY は使わない。
  const rollback = await executeVenueOrder(
    filledSide.venue,
    symbol,
    filledSide.isCloseBuy,
    filledSide.filled,
    midPrice,
    pairId,
    true // reduceOnly
  );

  if (rollback.outcome === "filled") {
    updateDnPairStatus(pairId, "closed", {
      closeReason: `片側失敗→自動ロールバック成功: ${errors}`,
    });
    console.log(`[DN戦略] ロールバック成功 ${symbol}: ${filledSide.venue}`);
    setRollbackCooldown(symbol);
    return "partial";  // Task B2: ロールバック成功でも当該サイクルの同銘柄試行は完了
  }

  if (rollback.outcome === "ambiguous") {
    // ロールバック自体が AMBIGUOUS になった → 絶対に触らない
    await escalateAmbiguous(
      pairId,
      symbol,
      "ロールバックAMBIGUOUS",
      longResult,
      shortResult,
      longVenue,
      shortVenue
    );
    return "partial";
  }

  // rollback.outcome === "rejected" / "timeout" — IOC で約定しなかった稀なケース
  // ポジションが残存している可能性 → 手動確認
  // （IOC では timeout は発生しないはずだが、型安全のため明示ハンドリング）
  await escalateAmbiguous(
    pairId,
    symbol,
    `ロールバック失敗(${rollback.outcome}: ${rollback.error ?? "unknown"})`,
    longResult,
    shortResult,
    longVenue,
    shortVenue
  );
  return "partial";
}

// --- エグジット判定 ---

async function evaluateExits(result: StrategyCycleResult): Promise<void> {
  const activePairs = getActiveDnPairs();

  for (const pair of activePairs) {
    if (pair.status !== "open") continue;

    const shouldClose = await shouldClosePair(pair);
    if (!shouldClose.close) continue;

    console.log(`[DN戦略] エグジット判定: ${pair.symbol} 理由=${shouldClose.reason}`);

    if (dryRun) {
      console.log(`[DN戦略] ドライラン: ${pair.symbol} エグジットスキップ（実注文なし）`);
      result.closed.push(`${pair.symbol}(dry)`);
      continue;
    }

    try {
      await executeClose(pair, shouldClose.reason);
      result.closed.push(pair.symbol);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`${pair.symbol} close: ${msg}`);
    }
  }
}

async function shouldClosePair(
  pair: DnPair
): Promise<{ close: boolean; reason: string }> {
  const nowMs = Date.now();

  // 0-a. 最低保持時間チェック (セーフティ網、Task B3 で 180→30 分に縮小)
  // 30 分以内は FR 反転・スプレッド消滅の判定にも到達させない（early-return）。
  // エントリー直後の瞬間的なスプレッド消滅による即クローズで手数料消費するのを防ぐ。
  if (
    pair.openedAt &&
    isWithinMinHold(pair.openedAt.getTime(), nowMs, DN_PARAMS.minHoldMinutes)
  ) {
    return { close: false, reason: "" };
  }

  // 0-b. 最大保持時間チェック (Task B3: 24h 上限で強制クローズ)
  // 手数料回収未達でも 24h を超えたら解放（資金ロック防止）。
  // expected_fee_usd=0 の旧ペアにもこのルールは適用される。
  if (
    pair.openedAt &&
    exceedsMaxHold(pair.openedAt.getTime(), nowMs, DN_PARAMS.maxHoldMinutes)
  ) {
    return {
      close: true,
      reason: `最大保持時間 ${DN_PARAMS.maxHoldMinutes} 分到達（強制クローズ）`,
    };
  }

  // 0-c. 手数料回収チェック (Task B3: expected_fee_usd > 0 のペアのみ)
  // 後方互換: expected_fee_usd=0 の旧ペア（Task B3 以前）は false が返り通常判定へ。
  // expected_fee_usd>0 かつ fr_breakeven_at=null なら保持継続（FR 反転等も無視）。
  if (shouldBlockClosureForFee(pair)) {
    return { close: false, reason: "" };
  }

  // 1. 現在のFRを取得
  const screenings = await runScreening();
  const current = screenings.find((s) => s.symbol === pair.symbol);

  if (!current) {
    return { close: true, reason: "スクリーニングから消失" };
  }

  // 2. FR方向反転チェック（根本的なクローズ理由）
  // エントリー時: shortVenue で Short（FR受取）していた
  // FR方向が反転 = Short側が支払いに変わった = 裁定の前提が崩れた
  const hlRate = current.hlFundingRate.rate;
  const extRate = current.extFundingRate?.rate ?? 0;

  // Short しているベニューの FR が負（= Short が支払い側）になったら方向反転
  const shortVenueFr =
    pair.shortVenue === "hyperliquid" ? hlRate : extRate;
  const longVenueFr =
    pair.longVenue === "hyperliquid" ? hlRate : extRate;

  // Short ベニューの FR が負 = Short が支払う側 = 裁定逆転
  // かつ Long ベニューの FR も正でない = 両方不利
  if (shortVenueFr < 0 && longVenueFr <= 0) {
    return {
      close: true,
      reason: `FR方向反転: Short(${pair.shortVenue})FR=${(shortVenueFr * 100).toFixed(4)}% Long(${pair.longVenue})FR=${(longVenueFr * 100).toFixed(4)}%`,
    };
  }

  // 3. FR スプレッドが消滅（両ベニューのFR差がほぼゼロ）
  if (isFrSpreadCollapsed(hlRate, extRate, DN_PARAMS.frClose)) {
    const spread = Math.abs(hlRate - extRate);
    return {
      close: true,
      reason: `FRスプレッド消滅: ${(spread * 100).toFixed(4)}% < 閾値${(DN_PARAMS.frClose * 100).toFixed(4)}%`,
    };
  }

  // スコアの一時的な揺れでは閉じない（旧ロジックの「スコア悪化」「APY負転」を廃止）
  return { close: false, reason: "" };
}

// --- エグジット実行 ---

async function executeClose(pair: DnPair, reason: string): Promise<void> {
  console.log(`[DN戦略] エグジット実行: ${pair.symbol}[#${pair.id}] ${reason}`);

  updateDnPairStatus(pair.id, "closing");

  const midPrice = await getMidPrice(pair.symbol);
  if (midPrice <= 0) {
    console.error(`[DN戦略] エグジット中止 ${pair.symbol}: 中値取得不可`);
    // 次サイクルで再試行できるよう open に戻す
    updateDnPairStatus(pair.id, "open");
    return;
  }

  // 両ベニューで反対売買（reduceOnly）
  const [closeLong, closeShort] = await Promise.all([
    executeVenueOrder(
      pair.longVenue,
      pair.symbol,
      false,
      pair.longSize,
      midPrice,
      pair.id,
      true
    ),
    executeVenueOrder(
      pair.shortVenue,
      pair.symbol,
      true,
      pair.shortSize,
      midPrice,
      pair.id,
      true
    ),
  ]);

  // AMBIGUOUS は最優先でエスカレート
  if (closeLong.outcome === "ambiguous" || closeShort.outcome === "ambiguous") {
    await escalateAmbiguous(
      pair.id,
      pair.symbol,
      "エグジット時AMBIGUOUS検知",
      closeLong,
      closeShort,
      pair.longVenue,
      pair.shortVenue
    );
    return;
  }

  if (closeLong.outcome === "filled" && closeShort.outcome === "filled") {
    updateDnPairStatus(pair.id, "closed", { closeReason: reason });
    console.log(`[DN戦略] エグジット完了: ${pair.symbol}[#${pair.id}]`);
    return;
  }

  // 片側 rejected — 反対側の片足が残存している可能性が高い
  // 自動で再試行せず manual_review にして人間判断を待つ
  const errors = [
    closeLong.outcome === "rejected" ? `CloseLong: ${closeLong.error}` : "",
    closeShort.outcome === "rejected" ? `CloseShort: ${closeShort.error}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  console.error(`[DN戦略] エグジット部分失敗 ${pair.symbol}: ${errors}`);
  await escalateAmbiguous(
    pair.id,
    pair.symbol,
    `エグジット片側失敗(${errors})`,
    closeLong,
    closeShort,
    pair.longVenue,
    pair.shortVenue
  );
}

// --- ベニュー別注文実行 ---

// 統一 outcome（HL/EXT 両 executor から伝播）
// Task A1.5 で "timeout" 追加: POST_ONLY が時間内に約定せず cancel 成功した状態。
// 板に残っていない（重複発注リスクなし）ため、次サイクルで安全に再試行可能。
type VenueOrderOutcome = "filled" | "rejected" | "ambiguous" | "timeout";

interface VenueOrderResult {
  outcome: VenueOrderOutcome;
  success: boolean; // outcome === "filled"
  filledSize?: number;
  avgPrice?: number;
  error?: string;
  // 取引所側の冪等性キー（HL: cloid, EXT: externalId）
  // DB own_orders.venue_order_id に注文発射前から記録される
  clientOrderId: string;
  // 取引所側の数値 ID（filled 時のみ）
  venueOrderId?: string;
  // Task B3: 実際に適用された発注モード（手数料見積もりで maker/taker を判定）
  // POST_ONLY: maker fee、IOC/MARKET: taker fee
  actualMode?: "POST_ONLY" | "IOC" | "MARKET";
}

async function executeVenueOrder(
  venue: VenueId,
  symbol: string,
  isBuy: boolean,
  size: number,
  price: number,
  pairId: number,
  reduceOnly: boolean = false,
  // Phase A Task A1: 発注モード。
  // - "POST_ONLY": entry で使用。maker 料率、2秒タイムアウトで IOC にフォールバック
  // - "IOC": rollback / close / デフォルト。即時約定優先
  // - "MARKET": レガシー互換
  mode: "POST_ONLY" | "IOC" | "MARKET" = "IOC"
): Promise<VenueOrderResult> {
  const side = isBuy ? ("buy" as const) : ("sell" as const);

  // 冪等性キーを発射前に生成
  const clientOrderId =
    venue === "hyperliquid" ? generateCloid() : randomUUID();

  // DB レコードを発射前に作成（プロセスクラッシュでも追跡可能に）
  const orderId = createOrder({
    pairId,
    venue,
    symbol,
    side,
    orderType: "market",
    price,
    size,
    orderMode: mode,
  });
  updateOrderStatus(orderId, "open", { venueOrderId: clientOrderId });

  // ベニュー別 executor 呼び出し
  // executor 側で withRetry は使わず、失敗時は実在検証で outcome を確定する
  let outcome: VenueOrderOutcome = "ambiguous";
  let filledSize: number | undefined;
  let avgPrice: number | undefined;
  let error: string | undefined;
  let venueOrderId: string | undefined;
  let finalClientOrderId: string = clientOrderId;
  // POST_ONLY → IOC フォールバック後の最終約定モード（fee 算出に使用）
  let actualMode: "POST_ONLY" | "IOC" | "MARKET" = mode;

  try {
    if (venue === "hyperliquid") {
      // HL は HL 命名をそのまま使う（symbol は常に HL 命名 = DB 保存命名）
      // HL は銘柄ごとに初回 updateLeverage が必須。未設定だと Insufficient margin になる。
      // cross 5x をデフォルトで設定（冪等: 既設定なら上書き、コスト軽微）
      await hlUpdateLeverage(symbol, 5, true);

      const res = await hlOpenWithMode({
        symbol,
        isBuy,
        size,
        mode,
        reduceOnly,
        cloid: clientOrderId,
      });
      outcome = res.outcome;
      filledSize = res.filledSize;
      avgPrice = res.avgPrice;
      error = res.error;
      venueOrderId = res.oid !== undefined ? String(res.oid) : undefined;
      // POST_ONLY → IOC フォールバック時、最終約定した cloid は新規発行
      finalClientOrderId = res.cloid;
      actualMode = res.mode ?? mode;
    } else {
      // Task B4: EXT は 1000 接頭の命名が必要（kPEPE → 1000PEPE）
      // 非倍率銘柄では hlToExtSymbol は恒等関数（BTC → BTC）なので安全に適用可
      const extSymbol = hlToExtSymbol(symbol);
      const res = await openExtWithMode({
        symbol: extSymbol,
        isBuy,
        size,
        mode,
        reduceOnly,
        externalId: clientOrderId,
      });
      outcome = res.outcome;
      filledSize = res.filledSize;
      avgPrice = res.avgPrice;
      error = res.error;
      venueOrderId = res.orderId !== undefined ? String(res.orderId) : undefined;
      finalClientOrderId = res.externalId;
      actualMode = res.mode ?? mode;
    }
  } catch (err) {
    // executor が想定外の例外を投げた場合（ネットワーク以外のバグ等）
    // 状態が確定できないので AMBIGUOUS として返す
    error = err instanceof Error ? err.message : String(err);
    console.error(
      `[${venue}注文 想定外例外] ${symbol} cid=${clientOrderId}: ${error.slice(0, 200)}`
    );
    outcome = "ambiguous";
  }

  // fee rate は最終モードで決定
  // POST_ONLY 約定 → maker rate, IOC/MARKET → taker rate
  const feeRate =
    actualMode === "POST_ONLY"
      ? VENUES[venue].makerFeeRate
      : VENUES[venue].takerFeeRate;

  // DB 反映
  if (outcome === "filled") {
    const actualSize = filledSize ?? size;
    const actualPrice = avgPrice ?? price;
    updateOrderStatus(orderId, "filled", {
      filledSize: actualSize,
      // POST_ONLY → IOC フォールバック時は最終約定した cloid/externalId に更新
      venueOrderId: venueOrderId ?? finalClientOrderId,
      orderMode: actualMode,
    });
    recordTrade({
      orderId,
      pairId,
      venue,
      symbol,
      side,
      price: actualPrice,
      size: actualSize,
      fee: actualPrice * actualSize * feeRate,
      feeRate,
      venueTradeId: venueOrderId ?? null,
      timestamp: new Date().toISOString(),
    });
  } else if (outcome === "rejected" || outcome === "timeout") {
    // timeout は「約定せず cancel 成功」= 板に残っていない = rejected と同じ DB 扱い。
    // 戦略層では timeout と rejected を区別して扱うが、own_orders は「約定しなかった」として rejected で記録。
    updateOrderStatus(orderId, "rejected");
  } else {
    // ambiguous
    updateOrderStatus(orderId, "ambiguous");
  }

  return {
    outcome,
    success: outcome === "filled",
    filledSize,
    avgPrice,
    error,
    clientOrderId,
    venueOrderId,
    actualMode,
  };
}

// AMBIGUOUS 検知時の緊急通知 + manual_review 化
async function escalateAmbiguous(
  pairId: number,
  symbol: string,
  context: string,
  longResult: VenueOrderResult,
  shortResult: VenueOrderResult,
  longVenue: VenueId,
  shortVenue: VenueId
): Promise<void> {
  const lines = [
    `[緊急] ${symbol}#${pairId} ${context}`,
    `自動回復不可: 取引所側状態が確認できません。手動確認が必要です。`,
    ``,
    `Long(${longVenue}) outcome=${longResult.outcome} cid=${longResult.clientOrderId}`,
    `  venueOrderId=${longResult.venueOrderId ?? "(none)"} err=${longResult.error ?? "-"}`,
    `Short(${shortVenue}) outcome=${shortResult.outcome} cid=${shortResult.clientOrderId}`,
    `  venueOrderId=${shortResult.venueOrderId ?? "(none)"} err=${shortResult.error ?? "-"}`,
    ``,
    `対応: 各ベニューUIで上記clientOrderIdを検索し実ポジションを確認、`,
    `必要なら手動クローズし DB 上の本ペアを closed に更新してください。`,
    `本銘柄(${symbol})への新規エントリーは manual_review 解除まで自動ブロックされます。`,
  ].join("\n");

  console.error(lines);
  updateDnPairStatus(pairId, "manual_review", {
    closeReason: `AMBIGUOUS: ${context}`,
  });
}

// --- 中値取得ヘルパー ---

async function getMidPrice(symbol: string): Promise<number> {
  try {
    const { fetchAllMids } = await import("../collectors/hyperliquid");
    const mids = await fetchAllMids();
    const mid = mids[symbol];
    return mid ? parseFloat(mid) : 0;
  } catch {
    return 0;
  }
}

// --- ログ ---

function logCycleResult(result: StrategyCycleResult): void {
  const parts = [
    `評価${result.evaluated}件`,
    result.opened.length > 0 ? `エントリー${result.opened.join(",")}` : null,
    result.closed.length > 0 ? `エグジット${result.closed.join(",")}` : null,
    result.errors.length > 0 ? `エラー${result.errors.length}件` : null,
  ].filter(Boolean);

  console.log(`[DN戦略] サイクル完了: ${parts.join(" | ")}`);
}
