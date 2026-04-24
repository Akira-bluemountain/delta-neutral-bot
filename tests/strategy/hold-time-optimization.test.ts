/**
 * Task B3 — 保有時間最適化の境界値テスト
 *
 * 検証対象:
 *   1. config: minHoldMinutes=30, maxHoldMinutes=1440
 *   2. exceedsMaxHold (src/strategy/helpers.ts): 24h 上限判定
 *   3. calculateExpectedFee: 入場 actualMode + 退場 taker 前提の往復手数料
 *   4. calculateAccumulatedFr: FR 受取積算（1h interval、符号ルール、負値）
 *   5. shouldBlockClosureForFee: 手数料未回収ブロック + 旧ペア後方互換
 */

import { DN_PARAMS } from "../../src/core/config";
import { exceedsMaxHold, isWithinMinHold } from "../../src/strategy/helpers";
import {
  calculateExpectedFee,
  calculateAccumulatedFr,
  shouldBlockClosureForFee,
} from "../../src/strategy/fee-recovery-helpers";

describe("Task B3 config — minHold/maxHold", () => {
  it("minHoldMinutes が 30 分（セーフティ網、180→30 に縮小）", () => {
    expect(DN_PARAMS.minHoldMinutes).toBe(30);
  });

  it("maxHoldMinutes が 1440 分（24 時間強制クローズ上限）", () => {
    expect(DN_PARAMS.maxHoldMinutes).toBe(1440);
  });
});

describe("exceedsMaxHold — 24h 上限判定", () => {
  const t0 = 1_700_000_000_000; // 適当な epoch ms

  it("1439 分経過では false（まだ上限前）", () => {
    const now = t0 + 1439 * 60 * 1000;
    expect(exceedsMaxHold(t0, now, 1440)).toBe(false);
  });

  it("ちょうど 1440 分経過で true（境界は >= 側）", () => {
    const now = t0 + 1440 * 60 * 1000;
    expect(exceedsMaxHold(t0, now, 1440)).toBe(true);
  });

  it("1441 分経過では true", () => {
    const now = t0 + 1441 * 60 * 1000;
    expect(exceedsMaxHold(t0, now, 1440)).toBe(true);
  });

  it("isWithinMinHold との対称性: 30 分境界で相補関係", () => {
    const now = t0 + 30 * 60 * 1000;
    expect(isWithinMinHold(t0, now, 30)).toBe(false);
    expect(exceedsMaxHold(t0, now, 30)).toBe(true);
  });
});

describe("calculateExpectedFee — 往復手数料見積もり", () => {
  // HL: maker 0.01%, taker 0.035% (実 config)
  // EXT: maker 0%, taker 0.025% (実 config、maker は無料)
  const HL = { makerFeeRate: 0.0001, takerFeeRate: 0.00035 };
  const EXT = { makerFeeRate: 0, takerFeeRate: 0.00025 };

  it("両側 POST_ONLY 約定: HL maker 0.01% + EXT maker 0% + 両側 taker exit", () => {
    const longEntry = {
      actualMode: "POST_ONLY" as const,
      makerFeeRate: HL.makerFeeRate,
      takerFeeRate: HL.takerFeeRate,
      fillPrice: 1000,
      fillSize: 0.05,
    };
    const shortEntry = {
      actualMode: "POST_ONLY" as const,
      makerFeeRate: EXT.makerFeeRate,
      takerFeeRate: EXT.takerFeeRate,
      fillPrice: 1000,
      fillSize: 0.05,
    };
    const expected = calculateExpectedFee(longEntry, shortEntry);
    // Long entry: 1000 × 0.05 × 0.0001 = 0.005
    // Short entry: 1000 × 0.05 × 0 = 0
    // Long exit: 1000 × 0.05 × 0.00035 = 0.0175
    // Short exit: 1000 × 0.05 × 0.00025 = 0.0125
    // 合計: 0.005 + 0 + 0.0175 + 0.0125 = 0.035
    expect(expected).toBeCloseTo(0.035, 5);
  });

  it("IOC 両側（ambiguous フォールバック相当）: 全て taker", () => {
    const longEntry = {
      actualMode: "IOC" as const,
      makerFeeRate: HL.makerFeeRate,
      takerFeeRate: HL.takerFeeRate,
      fillPrice: 1000,
      fillSize: 0.05,
    };
    const shortEntry = {
      actualMode: "IOC" as const,
      makerFeeRate: EXT.makerFeeRate,
      takerFeeRate: EXT.takerFeeRate,
      fillPrice: 1000,
      fillSize: 0.05,
    };
    const expected = calculateExpectedFee(longEntry, shortEntry);
    // Long entry+exit: 1000 × 0.05 × 0.00035 × 2 = 0.035
    // Short entry+exit: 1000 × 0.05 × 0.00025 × 2 = 0.025
    expect(expected).toBeCloseTo(0.06, 5);
  });

  it("ポジションサイズ 0 → 手数料 0", () => {
    const zero = {
      actualMode: "POST_ONLY" as const,
      makerFeeRate: HL.makerFeeRate,
      takerFeeRate: HL.takerFeeRate,
      fillPrice: 1000,
      fillSize: 0,
    };
    expect(calculateExpectedFee(zero, zero)).toBe(0);
  });
});

describe("calculateAccumulatedFr — FR 受取積算 (1h interval)", () => {
  it("受取方向: Long=HL, Short=EXT、HL FR=-0.0001 (Long受取) → 正値", () => {
    const res = calculateAccumulatedFr({
      longVenueRate: -0.0001, // HL で Long は負 rate で受取
      shortVenueRate: 0,
      longSize: 0.05,
      shortSize: 0.05,
      longEntryPrice: 1000,
      shortEntryPrice: 1000,
      elapsedMs: 60 * 60 * 1000, // 1h
      fundingIntervalHours: 1,
    });
    // perIntervalRevenue = -(-0.0001) × (0.05 × 1000) + 0 × (0.05 × 1000) = 0.005
    // elapsedIntervals = 1
    expect(res).toBeCloseTo(0.005, 5);
  });

  it("受取方向: Long=HL, Short=EXT、EXT FR=+0.0001 (Short受取) → 正値", () => {
    const res = calculateAccumulatedFr({
      longVenueRate: 0,
      shortVenueRate: 0.0001,
      longSize: 0.05,
      shortSize: 0.05,
      longEntryPrice: 1000,
      shortEntryPrice: 1000,
      elapsedMs: 60 * 60 * 1000,
      fundingIntervalHours: 1,
    });
    // perIntervalRevenue = 0 + 0.0001 × 50 = 0.005
    expect(res).toBeCloseTo(0.005, 5);
  });

  it("スプレッド反転: perHourRevenue 負値もそのまま返す（クリップなし）", () => {
    const res = calculateAccumulatedFr({
      longVenueRate: 0.0001,   // Long 側が支払い
      shortVenueRate: -0.0001, // Short 側も支払い
      longSize: 0.05,
      shortSize: 0.05,
      longEntryPrice: 1000,
      shortEntryPrice: 1000,
      elapsedMs: 60 * 60 * 1000,
      fundingIntervalHours: 1,
    });
    // perIntervalRevenue = -0.0001 × 50 + (-0.0001) × 50 = -0.01
    expect(res).toBeLessThan(0);
    expect(res).toBeCloseTo(-0.01, 5);
  });

  it("2.5h 経過で 2.5 倍に近似積算（1h interval 想定）", () => {
    const res = calculateAccumulatedFr({
      longVenueRate: -0.0001,
      shortVenueRate: 0,
      longSize: 0.05,
      shortSize: 0.05,
      longEntryPrice: 1000,
      shortEntryPrice: 1000,
      elapsedMs: 2.5 * 60 * 60 * 1000,
      fundingIntervalHours: 1,
    });
    // 1h で 0.005 なら 2.5h で 0.0125
    expect(res).toBeCloseTo(0.0125, 5);
  });

  it("Long/Short で entry price が異なる（HL/EXT のスプレッド）", () => {
    const res = calculateAccumulatedFr({
      longVenueRate: -0.0001,
      shortVenueRate: 0.0001,
      longSize: 0.1,
      shortSize: 0.1,
      longEntryPrice: 1000,
      shortEntryPrice: 1001, // Short 側はわずかに高値
      elapsedMs: 60 * 60 * 1000,
      fundingIntervalHours: 1,
    });
    // perIntervalRevenue = -(-0.0001) × 100 + 0.0001 × 100.1 = 0.01 + 0.01001 = 0.02001
    expect(res).toBeCloseTo(0.02001, 5);
  });

  it("経過時間 0 → 累積も 0", () => {
    const res = calculateAccumulatedFr({
      longVenueRate: -0.0001,
      shortVenueRate: 0.0001,
      longSize: 0.05,
      shortSize: 0.05,
      longEntryPrice: 1000,
      shortEntryPrice: 1000,
      elapsedMs: 0,
      fundingIntervalHours: 1,
    });
    expect(res).toBe(0);
  });
});

describe("shouldBlockClosureForFee — 手数料未回収ブロック判定", () => {
  it("expectedFeeUsd=0 → 常に false（旧ペアは minHold ロジックへ）", () => {
    expect(
      shouldBlockClosureForFee({ expectedFeeUsd: 0, frBreakevenAt: null })
    ).toBe(false);
  });

  it("expectedFeeUsd<0 → 常に false（異常値の保護）", () => {
    expect(
      shouldBlockClosureForFee({ expectedFeeUsd: -1, frBreakevenAt: null })
    ).toBe(false);
  });

  it("expectedFeeUsd>0 かつ frBreakevenAt=null → true（保持継続）", () => {
    expect(
      shouldBlockClosureForFee({ expectedFeeUsd: 0.035, frBreakevenAt: null })
    ).toBe(true);
  });

  it("expectedFeeUsd>0 かつ frBreakevenAt=Date → false（通常判定へ）", () => {
    expect(
      shouldBlockClosureForFee({
        expectedFeeUsd: 0.035,
        frBreakevenAt: new Date("2026-04-24T12:00:00Z"),
      })
    ).toBe(false);
  });
});

describe("統合シナリオ: エントリーから手数料回収までの流れ", () => {
  // 実運用を模した連続計算
  const HL = { makerFeeRate: 0.0001, takerFeeRate: 0.00035 };
  const EXT = { makerFeeRate: 0, takerFeeRate: 0.00025 };

  it("XMR $50 の POST_ONLY 両側約定 → 1h FR 0.02% で break-even までかかる時間", () => {
    const entryPrice = 350;
    const size = 0.142857; // $50 / $350 ≈ 0.1428

    const expected = calculateExpectedFee(
      {
        actualMode: "POST_ONLY",
        makerFeeRate: HL.makerFeeRate,
        takerFeeRate: HL.takerFeeRate,
        fillPrice: entryPrice,
        fillSize: size,
      },
      {
        actualMode: "POST_ONLY",
        makerFeeRate: EXT.makerFeeRate,
        takerFeeRate: EXT.takerFeeRate,
        fillPrice: entryPrice,
        fillSize: size,
      }
    );
    // entry: HL maker 0.01% + EXT maker 0% on $50 notional = $0.005
    // exit: HL taker 0.035% + EXT taker 0.025% = $0.03
    // 合計 expected ≈ $0.035

    // 1h で 0.02% のスプレッドが継続したら FR 受取?
    // HL rate = -0.0001, EXT rate = +0.0001 と仮定（差 0.0002 = 0.02%）
    const onehRevenue = calculateAccumulatedFr({
      longVenueRate: -0.0001,
      shortVenueRate: 0.0001,
      longSize: size,
      shortSize: size,
      longEntryPrice: entryPrice,
      shortEntryPrice: entryPrice,
      elapsedMs: 60 * 60 * 1000,
      fundingIntervalHours: 1,
    });
    // perIntervalRevenue = 0.0001 × 50 + 0.0001 × 50 = 0.01 ($0.01 per hour)
    // expected $0.035 / $0.01 per hour = 3.5 hours で break-even

    expect(expected).toBeCloseTo(0.035, 4);
    expect(onehRevenue).toBeCloseTo(0.01, 5);

    // 3h で未回収、4h で到達
    const after3h = calculateAccumulatedFr({
      longVenueRate: -0.0001,
      shortVenueRate: 0.0001,
      longSize: size,
      shortSize: size,
      longEntryPrice: entryPrice,
      shortEntryPrice: entryPrice,
      elapsedMs: 3 * 60 * 60 * 1000,
      fundingIntervalHours: 1,
    });
    expect(after3h).toBeLessThan(expected);

    const after4h = calculateAccumulatedFr({
      longVenueRate: -0.0001,
      shortVenueRate: 0.0001,
      longSize: size,
      shortSize: size,
      longEntryPrice: entryPrice,
      shortEntryPrice: entryPrice,
      elapsedMs: 4 * 60 * 60 * 1000,
      fundingIntervalHours: 1,
    });
    expect(after4h).toBeGreaterThanOrEqual(expected);
  });
});
