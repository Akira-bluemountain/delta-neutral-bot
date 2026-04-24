/**
 * Task URGENT-FIX — floatToWire 境界値テスト
 *
 * CHIP#888/#890 インシデント (2026-04-24) の根本原因となった floatToWire の
 * 8 桁小数境界 / 1e-12 許容誤差の動作を単体で検証する。
 */

import { floatToWire } from "../../src/execution/hl-signing";

describe("floatToWire — 境界値", () => {
  describe("正常系（丸め誤差なし）", () => {
    it("整数は末尾ゼロ除去して返す", () => {
      expect(floatToWire(100)).toBe("100");
      expect(floatToWire(0)).toBe("0");
      expect(floatToWire(1)).toBe("1");
    });

    it("小数 8 桁ちょうどは通る", () => {
      expect(floatToWire(0.12345678)).toBe("0.12345678");
    });

    it("末尾ゼロを除去する", () => {
      expect(floatToWire(1.5)).toBe("1.5");
      expect(floatToWire(1.50000000)).toBe("1.5");
      expect(floatToWire(100.1)).toBe("100.1");
    });

    it("負の値も 8 桁まで通る", () => {
      expect(floatToWire(-0.12345678)).toBe("-0.12345678");
    });

    it("-0 は 0 に正規化される", () => {
      expect(floatToWire(-0)).toBe("0");
    });

    it("HL 実 API が返す形式の価格を通す", () => {
      expect(floatToWire(0.090587)).toBe("0.090587");
      expect(floatToWire(95000)).toBe("95000");
      expect(floatToWire(3500.3)).toBe("3500.3");
    });
  });

  describe("異常系（丸め誤差で throw）", () => {
    it("CHIP#888 実エラー値 0.0950684922 で throw", () => {
      // 本番 2026-04-24 18:20 JST 実際のエラー値
      expect(() => floatToWire(0.0950684922)).toThrow(/丸め誤差/);
    });

    it("CHIP#890 実エラー値 0.09258674039999999 で throw", () => {
      // 本番 2026-04-24 22:00 JST 実際のエラー値（IEEE 754 誤差込み）
      expect(() => floatToWire(0.09258674039999999)).toThrow(/丸め誤差/);
    });

    it("midPrice × 1.0001 系の浮動小数誤差で throw", () => {
      // openPostOnly で発生する典型パターン
      const midPrice = 0.090578;
      const offsetRatio = 0.0001;
      const raw = midPrice * (1 + offsetRatio); // 0.09058705780000001
      expect(() => floatToWire(raw)).toThrow(/丸め誤差/);
    });

    it("9 桁目以降が 1e-12 を超える値で throw", () => {
      // toFixed(8) が落とす分が 1e-12 を超える境界
      expect(() => floatToWire(0.123456789)).toThrow(/丸め誤差/);
    });

    it("エラーメッセージに元の値が含まれる", () => {
      try {
        floatToWire(0.0950684922);
        fail("should throw");
      } catch (e) {
        expect((e as Error).message).toContain("0.0950684922");
      }
    });
  });
});
