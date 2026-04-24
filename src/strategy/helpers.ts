/**
 * 戦略ロジックの純粋述語ヘルパー（Task A2）
 *
 * passesEntryFilter / shouldClosePair の境界値判定を
 * 外部依存のない純粋関数に切り出し、境界値テストで直接検証可能にする。
 * 既存ロジックの挙動は完全に維持する（振る舞い変更なし）。
 */

/**
 * FR 閾値判定：エントリーを許可するか。
 * maxAbsRate（両ベニュー FR の大きい方の絶対値）と spread（FR 差の絶対値）の
 * いずれか一方でも frOpen を満たせばエントリー可。
 *
 * 旧実装: `if (maxAbsRate < frOpen && spread < frOpen) reject`
 * 論理等価: `maxAbsRate >= frOpen || spread >= frOpen`
 */
export function meetsFrThreshold(
  maxAbsRate: number,
  spread: number,
  frOpen: number
): boolean {
  return maxAbsRate >= frOpen || spread >= frOpen;
}

/**
 * 最低保持時間チェック：ペアが minHoldMinutes 経過前かどうか。
 * true を返す間は shouldClosePair で early-return（クローズ判定スキップ）。
 *
 * 設計意図：minHoldMinutes 経過前は FR 反転・スプレッド消滅の判定にも
 * 到達させない（BOT_SPEC §4 の「経過前は絶対にクローズしない」仕様）。
 */
export function isWithinMinHold(
  openedAtMs: number,
  nowMs: number,
  minHoldMinutes: number
): boolean {
  const holdMs = nowMs - openedAtMs;
  const minMs = minHoldMinutes * 60 * 1000;
  return holdMs < minMs;
}

/**
 * 最大保持時間判定：ペアが maxHoldMinutes を超過したか（Task B3）。
 * true を返したら shouldClosePair で強制クローズ（24h 上限）。
 *
 * 設計意図：手数料回収未達でも 24h を超えたら強制的に解放し、
 * 想定外の長期保有による資金ロックと資金効率悪化を防ぐ。
 */
export function exceedsMaxHold(
  openedAtMs: number,
  nowMs: number,
  maxHoldMinutes: number
): boolean {
  const holdMs = nowMs - openedAtMs;
  const maxMs = maxHoldMinutes * 60 * 1000;
  return holdMs >= maxMs;
}

/**
 * FR スプレッド消滅判定：両ベニューの FR 差が frClose を下回ったか。
 * true の場合は裁定余地が消滅しているため shouldClosePair でクローズをトリガー。
 */
export function isFrSpreadCollapsed(
  hlRate: number,
  extRate: number,
  frClose: number
): boolean {
  const spread = Math.abs(hlRate - extRate);
  return spread < frClose;
}
