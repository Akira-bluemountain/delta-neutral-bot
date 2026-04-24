/**
 * 注文発注レスポンスの分類ヘルパー（Task A1.5）
 *
 * POST_ONLY + IOC フォールバック廃止 + 方針 Y に伴い、以下の分類ロジックを純粋関数として抽出:
 *   1. EXT placeOrder の成功レスポンスを filled/resting/rejected に分類
 *      → 旧実装では GTT POST_ONLY の resting (status=NEW, filledQty=0) を
 *         rejected と誤判定していたため、Time-in-Force を考慮した判定に修正
 *   2. POST_ONLY タイムアウト後の最終 outcome を決定
 *      → cancel 成否 + 残存検証 + 部分約定量から filled/timeout/ambiguous を決定
 *
 * これらは呼び出し元（ext-executor / hl-executor）の副作用ロジック（HTTP 呼び出し、
 * 署名、ログ出力）から切り離された純粋関数のため、単体テストで境界値を直接検証可能。
 */

/**
 * Extended signer の place-order 成功レスポンス（success=true）を受けて、
 * 注文が「約定済み / 板に resting 中 / 拒否扱い」のいずれかを判定する。
 *
 * rejected 条件:
 *   (a) status が CANCELLED/EXPIRED/REJECTED のいずれかを含む
 *   (b) IOC 系（resting 不可）で filledQty=0 かつ actualFilled が未取得
 *       → IOC は板に載らず期限切れで約定しなかった = 実質的拒否
 *
 * resting 条件:
 *   - timeInForce=GTT または postOnly=true で filledQty=0 かつ非キャンセル状態
 *
 * filled 条件:
 *   - 上記いずれでもない（部分/全量約定あり）
 */
export type ExtPlacementClassification = "filled" | "resting" | "rejected";

export function classifyExtPlacement(params: {
  orderStatus: string | null | undefined;
  rawFilledQty: string | null | undefined;
  actualFilled: number | undefined;
  timeInForce: string;
  postOnly: boolean;
}): ExtPlacementClassification {
  const statusUpper = (params.orderStatus ?? "").toUpperCase();
  const isExpiredOrCancelled =
    statusUpper.includes("CANCEL") ||
    statusUpper.includes("EXPIRE") ||
    statusUpper.includes("REJECT");

  if (isExpiredOrCancelled) return "rejected";

  const zeroFill =
    params.rawFilledQty === "0" || params.rawFilledQty === "0E-18";
  const isRestingCapable =
    params.timeInForce === "GTT" || params.postOnly === true;

  // IOC 系で filledQty=0 → 拒否扱い（旧実装の動作を保存）
  if (!isRestingCapable && zeroFill && params.actualFilled === undefined) {
    return "rejected";
  }

  // GTT/postOnly で filledQty=0 → resting（Task A1.5 critical fix）
  if (isRestingCapable && zeroFill && params.actualFilled === undefined) {
    return "resting";
  }

  // それ以外（部分/全量約定あり）→ filled
  return "filled";
}

/**
 * POST_ONLY タイムアウト後の最終 outcome 決定。
 *
 * - cancel 成功 or 取引所照会で残存していないことが確認できた:
 *     filledSize > 0 → "filled"（部分約定含む）
 *     filledSize === 0 → "timeout"（次サイクル再試行可）
 * - cancel 失敗 かつ 残存していないことも確認できない:
 *     "ambiguous"（板に残存している可能性、二次発注禁止）
 */
export type PostOnlyTimeoutOutcome = "filled" | "timeout" | "ambiguous";

export function classifyPostOnlyTimeoutOutcome(params: {
  cancelSuccess: boolean;
  verifiedNotResting: boolean;
  filledSize: number;
}): PostOnlyTimeoutOutcome {
  const isEffectivelyClean = params.cancelSuccess || params.verifiedNotResting;
  if (!isEffectivelyClean) return "ambiguous";
  if (params.filledSize > 0) return "filled";
  return "timeout";
}
