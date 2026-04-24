/**
 * Task A1.5 — 注文分類ヘルパーの境界値テスト
 *
 * M1 の critical bug（EXT resting 誤判定）および M2/M3 の POST_ONLY
 * タイムアウト判定を純粋関数レベルで検証する。
 */

import {
  classifyExtPlacement,
  classifyPostOnlyTimeoutOutcome,
} from "../../src/execution/classification-helpers";

describe("classifyExtPlacement — M1 critical fix (resting vs rejected)", () => {
  describe("GTT / postOnly の resting 判定", () => {
    it("status=NEW, filledQty=0, timeInForce=GTT, postOnly=true → resting", () => {
      // 実測された誤判定ケース（XMR#881 根本原因）
      expect(
        classifyExtPlacement({
          orderStatus: "NEW",
          rawFilledQty: "0",
          actualFilled: undefined,
          timeInForce: "GTT",
          postOnly: true,
        })
      ).toBe("resting");
    });

    it("status=OPEN, filledQty=0, timeInForce=GTT, postOnly=true → resting", () => {
      expect(
        classifyExtPlacement({
          orderStatus: "OPEN",
          rawFilledQty: "0",
          actualFilled: undefined,
          timeInForce: "GTT",
          postOnly: true,
        })
      ).toBe("resting");
    });

    it('status=NEW, filledQty="0E-18" (signer 側の表現揺れ), postOnly=true → resting', () => {
      expect(
        classifyExtPlacement({
          orderStatus: "NEW",
          rawFilledQty: "0E-18",
          actualFilled: undefined,
          timeInForce: "GTT",
          postOnly: true,
        })
      ).toBe("resting");
    });

    it("GTT + postOnly=false でも resting と判定（GTT の時点で resting 可能）", () => {
      expect(
        classifyExtPlacement({
          orderStatus: "NEW",
          rawFilledQty: "0",
          actualFilled: undefined,
          timeInForce: "GTT",
          postOnly: false,
        })
      ).toBe("resting");
    });
  });

  describe("IOC の拒否判定（旧実装動作を保存）", () => {
    it("status=NEW, filledQty=0, timeInForce=IOC → rejected（IOC は期限切れ）", () => {
      expect(
        classifyExtPlacement({
          orderStatus: "NEW",
          rawFilledQty: "0",
          actualFilled: undefined,
          timeInForce: "IOC",
          postOnly: false,
        })
      ).toBe("rejected");
    });
  });

  describe("明示的な拒否状態 → rejected（TIF 問わず）", () => {
    it("status=CANCELLED → rejected", () => {
      expect(
        classifyExtPlacement({
          orderStatus: "CANCELLED",
          rawFilledQty: "0",
          actualFilled: undefined,
          timeInForce: "GTT",
          postOnly: true,
        })
      ).toBe("rejected");
    });

    it("status=EXPIRED → rejected", () => {
      expect(
        classifyExtPlacement({
          orderStatus: "EXPIRED",
          rawFilledQty: "0",
          actualFilled: undefined,
          timeInForce: "GTT",
          postOnly: true,
        })
      ).toBe("rejected");
    });

    it("status=REJECTED → rejected", () => {
      expect(
        classifyExtPlacement({
          orderStatus: "REJECTED",
          rawFilledQty: "0",
          actualFilled: undefined,
          timeInForce: "GTT",
          postOnly: true,
        })
      ).toBe("rejected");
    });

    it("status=PARTIALLY_CANCELLED 等の包含マッチでも rejected", () => {
      expect(
        classifyExtPlacement({
          orderStatus: "PARTIALLY_CANCELLED",
          rawFilledQty: "0",
          actualFilled: undefined,
          timeInForce: "GTT",
          postOnly: true,
        })
      ).toBe("rejected");
    });
  });

  describe("約定あり → filled", () => {
    it("status=FILLED, actualFilled>0 → filled", () => {
      expect(
        classifyExtPlacement({
          orderStatus: "FILLED",
          rawFilledQty: "0.132",
          actualFilled: 0.132,
          timeInForce: "GTT",
          postOnly: true,
        })
      ).toBe("filled");
    });

    it("部分約定（actualFilled 取得済み）→ filled", () => {
      expect(
        classifyExtPlacement({
          orderStatus: "PARTIALLY_FILLED",
          rawFilledQty: "0.05",
          actualFilled: 0.05,
          timeInForce: "GTT",
          postOnly: true,
        })
      ).toBe("filled");
    });
  });
});

describe("classifyPostOnlyTimeoutOutcome — M2/M3 timeout/ambiguous 判定", () => {
  describe("cancel 成功パス", () => {
    it("cancel success + filledSize=0 → timeout", () => {
      expect(
        classifyPostOnlyTimeoutOutcome({
          cancelSuccess: true,
          verifiedNotResting: false,
          filledSize: 0,
        })
      ).toBe("timeout");
    });

    it("cancel success + filledSize>0 → filled（部分約定含む）", () => {
      expect(
        classifyPostOnlyTimeoutOutcome({
          cancelSuccess: true,
          verifiedNotResting: false,
          filledSize: 0.05,
        })
      ).toBe("filled");
    });
  });

  describe("cancel 失敗パス", () => {
    it("cancel failure + verifiedNotResting=false → ambiguous（板残存可能性）", () => {
      expect(
        classifyPostOnlyTimeoutOutcome({
          cancelSuccess: false,
          verifiedNotResting: false,
          filledSize: 0,
        })
      ).toBe("ambiguous");
    });

    it("cancel failure だが 取引所照会で残存なし確認 → timeout として扱う", () => {
      expect(
        classifyPostOnlyTimeoutOutcome({
          cancelSuccess: false,
          verifiedNotResting: true,
          filledSize: 0,
        })
      ).toBe("timeout");
    });

    it("cancel failure + verifiedNotResting=true + filledSize>0 → filled", () => {
      expect(
        classifyPostOnlyTimeoutOutcome({
          cancelSuccess: false,
          verifiedNotResting: true,
          filledSize: 0.1,
        })
      ).toBe("filled");
    });

    it("cancel failure + verifiedNotResting=false + filledSize>0 → ambiguous（部分約定しているが板残存の可能性）", () => {
      // 方針 Y: 板残存の可能性がある以上、部分約定があっても自動回復せず人間判断
      expect(
        classifyPostOnlyTimeoutOutcome({
          cancelSuccess: false,
          verifiedNotResting: false,
          filledSize: 0.05,
        })
      ).toBe("ambiguous");
    });
  });
});
