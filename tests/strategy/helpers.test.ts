/**
 * Task A2 戦略ロジック境界値テスト
 *
 * src/strategy/helpers.ts の純粋述語を境界値・符号・組み合わせで検証する。
 * これらの述語は passesEntryFilter / shouldClosePair の境界判定部分を
 * そのまま担っているため、本テストで挙動を確定すれば既存フローが
 * 新しい frOpen / frClose / minHoldMinutes 値の下で仕様通りに動くことを
 * 強く保証できる。
 */

import {
  meetsFrThreshold,
  isWithinMinHold,
  isFrSpreadCollapsed,
} from "../../src/strategy/helpers";

// Task C1 で確定した新値。テストではこの値を固定して境界を検証する。
// 履歴: Task A2 frOpen=0.00025 (年率 219%) → Task C1 frOpen=0.00015 (年率 131%)
//       Task A2 frClose=0.00010 (年率 88%)  → Task C1 frClose=0.00006 (年率 53%)
const FR_OPEN = 0.00015;
const FR_CLOSE = 0.00006;
const MIN_HOLD_MINUTES = 180;

describe("meetsFrThreshold (frOpen=0.00015, Task C1)", () => {
  it("maxAbsRate がちょうど frOpen でエントリー可（境界は >= 側）", () => {
    expect(meetsFrThreshold(FR_OPEN, 0, FR_OPEN)).toBe(true);
  });

  it("spread がちょうど frOpen でエントリー可", () => {
    expect(meetsFrThreshold(0, FR_OPEN, FR_OPEN)).toBe(true);
  });

  it("両方とも frOpen - ε で拒否", () => {
    const epsilon = 1e-9;
    expect(meetsFrThreshold(FR_OPEN - epsilon, FR_OPEN - epsilon, FR_OPEN)).toBe(false);
  });

  it("maxAbsRate が frOpen + ε でエントリー可（spread が不足でも OR 条件で許可）", () => {
    const epsilon = 1e-9;
    expect(meetsFrThreshold(FR_OPEN + epsilon, 0, FR_OPEN)).toBe(true);
  });

  it("spread が frOpen + ε でエントリー可（maxAbsRate が不足でも OR 条件で許可）", () => {
    const epsilon = 1e-9;
    expect(meetsFrThreshold(0, FR_OPEN + epsilon, FR_OPEN)).toBe(true);
  });

  it("maxAbsRate=0 かつ spread=0 は拒否（FR も裁定余地もなし）", () => {
    expect(meetsFrThreshold(0, 0, FR_OPEN)).toBe(false);
  });

  it("Task A2 → C1 緩和: 旧値 0.00025 では拒否されていた入力が新値 0.00015 で通過", () => {
    // Task A2 時代の閾値
    const oldFrOpen = 0.00025;
    // A2 境界未満・C1 境界以上の実レート（例: 0.00020）は旧値では拒否、新値では通過
    const rateBetweenThresholds = 0.00020;
    expect(meetsFrThreshold(rateBetweenThresholds, 0, oldFrOpen)).toBe(false);
    expect(meetsFrThreshold(rateBetweenThresholds, 0, FR_OPEN)).toBe(true);
    // 新値 0.00015 境界ちょうどでも通過
    expect(meetsFrThreshold(FR_OPEN, 0, FR_OPEN)).toBe(true);
    // 新値でも 0.00015 未満は拒否
    expect(meetsFrThreshold(FR_OPEN - 1e-9, FR_OPEN - 1e-9, FR_OPEN)).toBe(false);
  });
});

describe("isWithinMinHold (minHoldMinutes=180)", () => {
  const openedAtMs = 1_700_000_000_000; // 任意の基準時刻
  const minMs = MIN_HOLD_MINUTES * 60 * 1000; // 10_800_000 ms

  it("179 分経過時点は within（close 判定スキップが必要）", () => {
    const nowMs = openedAtMs + 179 * 60 * 1000;
    expect(isWithinMinHold(openedAtMs, nowMs, MIN_HOLD_MINUTES)).toBe(true);
  });

  it("180 分ちょうどは within ではない（境界は経過後扱い、< 演算）", () => {
    const nowMs = openedAtMs + minMs;
    expect(isWithinMinHold(openedAtMs, nowMs, MIN_HOLD_MINUTES)).toBe(false);
  });

  it("180 分 - 1ms は within", () => {
    const nowMs = openedAtMs + minMs - 1;
    expect(isWithinMinHold(openedAtMs, nowMs, MIN_HOLD_MINUTES)).toBe(true);
  });

  it("181 分経過時点は within ではない（通常のクローズ判定開始）", () => {
    const nowMs = openedAtMs + 181 * 60 * 1000;
    expect(isWithinMinHold(openedAtMs, nowMs, MIN_HOLD_MINUTES)).toBe(false);
  });

  it("旧値 240 分は minHold=180 基準で within ではない（パラメータ変更の効果確認）", () => {
    const nowMs = openedAtMs + 240 * 60 * 1000;
    expect(isWithinMinHold(openedAtMs, nowMs, MIN_HOLD_MINUTES)).toBe(false);
  });
});

describe("isFrSpreadCollapsed (frClose=0.00006, Task C1)", () => {
  it("spread がちょうど frClose は消滅扱いではない（< 演算で境界は保持側）", () => {
    expect(isFrSpreadCollapsed(FR_CLOSE, 0, FR_CLOSE)).toBe(false);
  });

  it("spread が frClose - ε は消滅扱い（クローズ）", () => {
    const epsilon = 1e-9;
    expect(isFrSpreadCollapsed(FR_CLOSE - epsilon, 0, FR_CLOSE)).toBe(true);
  });

  it("spread が frClose + ε は消滅扱いではない（保持継続）", () => {
    const epsilon = 1e-9;
    expect(isFrSpreadCollapsed(FR_CLOSE + epsilon, 0, FR_CLOSE)).toBe(false);
  });

  it("hlRate と extRate が符号反対でも絶対差で評価される", () => {
    // 保持例: spread = |0.00005 − (−0.00003)| = 0.00008 > frClose=0.00006 → 消滅しない
    expect(isFrSpreadCollapsed(0.00005, -0.00003, FR_CLOSE)).toBe(false);
    // 崩壊例: spread = |0.00003 − (−0.00001)| = 0.00004 < frClose=0.00006 → 消滅
    expect(isFrSpreadCollapsed(0.00003, -0.00001, FR_CLOSE)).toBe(true);
  });

  it("両レートが同じ（spread=0）は消滅扱い", () => {
    expect(isFrSpreadCollapsed(0.00015, 0.00015, FR_CLOSE)).toBe(true);
  });
});

/**
 * shouldClosePair の early-return 構造の論理的検証（Task A2 §A2-2-1-3 訂正版）。
 *
 * dn-strategy.ts:570-576 の shouldClosePair は以下の構造:
 *   if (pair.openedAt && isWithinMinHold(...)) {
 *     return { close: false, reason: "" };  ← early-return
 *   }
 *   // ...以降 FR 反転 / スプレッド消滅チェック
 *
 * したがって isWithinMinHold が true を返す限り、後続の FR 反転や
 * スプレッド消滅チェックには到達しない。これは BOT_SPEC §4「最低保持時間
 * 経過前は絶対にクローズしない」仕様と整合する。
 *
 * 本ブロックでは helper レベルでこの前提を確認する（shouldClosePair 本体は
 * runScreening 等の外部依存を持つため T2 スコープ外）。
 */
describe("shouldClosePair early-return 構造の論理検証（Task A2 §A2-2-1-3）", () => {
  const openedAtMs = 1_700_000_000_000;
  const nowMsAt179min = openedAtMs + 179 * 60 * 1000;

  it("179 分時点は isWithinMinHold=true → shouldClosePair は早期 return する構造", () => {
    expect(isWithinMinHold(openedAtMs, nowMsAt179min, MIN_HOLD_MINUTES)).toBe(true);
  });

  it("179 分時点で FR 反転条件（Short FR が負）が揃っていても、isWithinMinHold=true なので判定は走らない", () => {
    // シナリオ: Short ベニューの FR=-0.001 という強い反転。
    // 通常なら shouldClosePair の [2] FR 方向反転ブロックでクローズされる状況。
    // しかし isWithinMinHold=true のため [0] で早期 return され、[2] に到達しない。
    expect(isWithinMinHold(openedAtMs, nowMsAt179min, MIN_HOLD_MINUTES)).toBe(true);
    // 参考: isFrSpreadCollapsed などの独立述語は別問題として、単体では
    // 確かにクローズ条件を示しうるが、shouldClosePair のフローではスキップされる。
  });

  it("179 分時点でスプレッド消滅条件（spread < frClose）が揃っていても、isWithinMinHold=true なので判定は走らない", () => {
    // シナリオ: 両ベニュー FR がほぼ一致（spread=0.00001 < frClose=0.00006）。
    // 通常なら [3] スプレッド消滅ブロックでクローズされる状況。
    expect(isWithinMinHold(openedAtMs, nowMsAt179min, MIN_HOLD_MINUTES)).toBe(true);
    // 独立に isFrSpreadCollapsed を評価すれば true（クローズ条件成立）:
    expect(isFrSpreadCollapsed(0.00001, 0, FR_CLOSE)).toBe(true);
    // だが shouldClosePair のフロー順では isWithinMinHold の early-return が先行し、
    // スプレッド消滅チェックには到達しない。これが BOT_SPEC §4 の仕様。
  });

  it("181 分時点は isWithinMinHold=false → FR 反転/スプレッド消滅チェックへ進む", () => {
    const nowMsAt181min = openedAtMs + 181 * 60 * 1000;
    expect(isWithinMinHold(openedAtMs, nowMsAt181min, MIN_HOLD_MINUTES)).toBe(false);
    // この時点以降、shouldClosePair は通常のクローズ判定を実施する。
  });
});
