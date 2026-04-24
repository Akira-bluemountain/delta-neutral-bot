/**
 * Task B2 — 並行ペア保有のための純粋ヘルパー
 *
 * evaluateEntries / startup 幻影クリーンアップの条件判定を副作用のない関数に切り出し、
 * 境界値・組み合わせを単体テストで直接検証可能にする。
 * 振る舞いは既存フロー（dn-strategy.ts / index.ts）と完全に等価。
 */

/**
 * 幻影 manual_review ペアの判定述語。
 *
 * 幻影とは:
 *   - executeOpen で createDnPair 後、両側とも約定確認前に ambiguous/例外で escalateAmbiguous 経由
 *   - DB 上は status=manual_review だが long_size=0, short_size=0, opened_at=null
 *   - 取引所側にも実ポジションが存在しない（呼び出し側で要検証）
 *
 * 本述語は DB 記録のみから幻影「候補」を判定する。実際の closed 化は
 * 取引所 API で両ベニューのポジションが 0 件であることを確認した後に行う。
 */
export function isPhantomManualReviewCandidate(pair: {
  longSize: number;
  shortSize: number;
  openedAt: Date | null;
}): boolean {
  return (
    pair.longSize === 0 && pair.shortSize === 0 && pair.openedAt === null
  );
}

/**
 * エントリー候補リストから、実際に発注すべき候補を選別する。
 *
 * 排除条件（どれか 1 つでも該当したら除外）:
 *   1. 同一サイクル内で既にエントリー試行済みの銘柄（alreadyEntered）
 *   2. 別サイクルで既に open / opening / closing / manual_review の銘柄（isActive）
 *
 * 上限:
 *   maxEntries 件に達したらそれ以上返さない。
 *
 * 入力 sorted は呼び出し側で score 降順にソート済みの想定。
 */
export function filterEntryCandidates<T>(
  sorted: T[],
  keyFn: (c: T) => string,
  maxEntries: number,
  alreadyEntered: Set<string>,
  isActive: (symbol: string) => boolean
): T[] {
  const selected: T[] = [];
  if (maxEntries <= 0) return selected;

  for (const candidate of sorted) {
    if (selected.length >= maxEntries) break;
    const symbol = keyFn(candidate);
    if (alreadyEntered.has(symbol)) continue;
    if (isActive(symbol)) continue;
    selected.push(candidate);
  }
  return selected;
}

/**
 * エントリー成功時の availableByVenue 減算。
 * 残高が 0 を下回らないよう Math.max でガード。
 *
 * 実マージン消費は positionUsd * REQUIRED_MARGIN_RATIO (≈0.25) 程度だが、
 * 次候補判定の過剰割当を確実に防ぐため概算として positionUsd 丸ごと引く（保守的）。
 */
export function decrementAvailable<K>(
  available: Map<K, number>,
  venue: K,
  amount: number
): void {
  available.set(venue, Math.max(0, (available.get(venue) ?? 0) - amount));
}
