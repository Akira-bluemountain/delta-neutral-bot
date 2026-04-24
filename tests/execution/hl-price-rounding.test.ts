/**
 * Task URGENT-FIX — HL 価格丸めの property test
 *
 * CHIP#888/#890 インシデント再発防止のため、以下を検証:
 * 1. roundPrice は 35 銘柄 × 各 szDecimals で HL 仕様（5 有効桁、6-szDec 小数桁）を満たす
 * 2. roundPrice を通した値は必ず floatToWire を通る
 * 3. midPrice × (1 ± offsetBps/10000) の raw 値は high probability で throw する
 *    （修正前の再現 = 回帰防止）
 * 4. 35 銘柄代表価格 × ±10% 揺らぎの property test で floatToWire throw ゼロ
 */

import { floatToWire } from "../../src/execution/hl-signing";
import { roundPrice } from "../../src/execution/hl-executor";

/**
 * WL 35 銘柄の代表メタデータ（szDecimals / 現実的な mid 価格帯）。
 * 価格は 2026-04-24 時点の参考値。本テストは価格の絶対値ではなく丸めの挙動を検証する。
 */
const WL_SYMBOLS: Array<{ name: string; szDec: number; mids: number[] }> = [
  // Tier 0 既存 15 銘柄
  { name: "BTC", szDec: 5, mids: [95000, 100000, 110000, 90123.45] },
  { name: "ETH", szDec: 4, mids: [3500, 3000, 4000, 3333.33] },
  { name: "SOL", szDec: 2, mids: [180, 200, 150, 175.55] },
  { name: "BNB", szDec: 3, mids: [600, 650, 700] },
  { name: "XRP", szDec: 0, mids: [2.5, 3.0, 2.15] },
  { name: "XMR", szDec: 4, mids: [170, 180, 165.23] },
  { name: "LINK", szDec: 2, mids: [15, 20, 18.33] },
  { name: "AVAX", szDec: 2, mids: [35, 40, 32.15] },
  { name: "LTC", szDec: 2, mids: [100, 120, 105.55] },
  { name: "HYPE", szDec: 2, mids: [20, 25, 22.45] },
  { name: "SUI", szDec: 1, mids: [3.5, 4.0, 2.85] },
  { name: "APT", szDec: 2, mids: [7, 8, 6.45] },
  { name: "UNI", szDec: 2, mids: [7, 10, 8.77] },
  { name: "TAO", szDec: 3, mids: [400, 500, 450.55] },
  { name: "DOGE", szDec: 0, mids: [0.15, 0.20, 0.17] },
  // Tier 1 B1 追加
  { name: "AAVE", szDec: 3, mids: [150, 200, 175.33] },
  { name: "CHIP", szDec: 0, mids: [0.090578, 0.094950, 0.092586] }, // インシデント銘柄
  { name: "ZEC", szDec: 3, mids: [50, 60, 55.55] },
  { name: "ENA", szDec: 0, mids: [0.5, 0.6, 0.55] },
  { name: "ADA", szDec: 0, mids: [0.5, 0.8, 0.65] },
  { name: "LIT", szDec: 0, mids: [0.9, 1.2, 1.05] },
  { name: "XPL", szDec: 0, mids: [0.10, 0.15, 0.12] },
  { name: "FARTCOIN", szDec: 1, mids: [0.2, 0.3, 0.25] },
  { name: "MON", szDec: 0, mids: [0.03, 0.04, 0.035] },
  { name: "PUMP", szDec: 0, mids: [0.0018, 0.002, 0.00185] },
  // Tier 2 B1 追加
  { name: "STRK", szDec: 0, mids: [0.4, 0.5, 0.42] },
  { name: "TON", szDec: 1, mids: [3.5, 4.0, 3.75] },
  { name: "AERO", szDec: 0, mids: [0.4, 0.5, 0.43] },
  { name: "LDO", szDec: 1, mids: [1.0, 1.5, 1.25] },
  { name: "KAITO", szDec: 1, mids: [0.9, 1.2, 1.05] },
  // Tier 3 B1-extend
  { name: "GRASS", szDec: 1, mids: [0.42381, 0.50, 0.38] },
  // Tier 4 B4 倍率銘柄
  { name: "kPEPE", szDec: 0, mids: [0.003844, 0.004, 0.0035] },
  // Tier 5 B5 薄板
  { name: "kBONK", szDec: 0, mids: [0.006397, 0.007, 0.0058] },
  { name: "AVNT", szDec: 0, mids: [0.1542, 0.18, 0.14] },
  { name: "EIGEN", szDec: 2, mids: [0.1821, 0.20, 0.16] },
];

/** EXECUTION_PARAMS.postOnlyOffsetBps と同値。 */
const POST_ONLY_OFFSET_BPS = 1;

describe("roundPrice — HL 仕様遵守", () => {
  it("価格が 0 以下なら 0 を返す", () => {
    expect(roundPrice(0, 0)).toBe(0);
    expect(roundPrice(-1, 0)).toBe(0);
  });

  it("szDecimals 0 → 最大小数 6 桁 & 有効 5 桁", () => {
    // toPrecision(5) で先に有効桁を絞る
    expect(roundPrice(0.12345678, 0)).toBe(0.123460);  // 5 有効桁は 0.12346
    expect(roundPrice(100.12345, 0)).toBe(100.12);     // 5 有効桁
  });

  it("szDecimals 5 → 最大小数 1 桁 & 有効 5 桁", () => {
    // 5 有効桁: 95000.123 → 95000（6 桁目の .1 は落ちる）
    expect(roundPrice(95000.123, 5)).toBe(95000);
    // 95009.5 は 5 有効桁で 95010
    expect(roundPrice(95009.5, 5)).toBe(95010);
    // 5 桁に収まる値なら小数 1 桁が残る
    expect(roundPrice(9000.5, 5)).toBe(9000.5);
  });

  it("CHIP インシデント raw 価格を 6 桁に丸める", () => {
    // 0.09058705780000001 → toPrecision(5)=0.090587 → 6 小数 OK
    expect(roundPrice(0.09058705780000001, 0)).toBe(0.090587);
    // 0.09258674039999999 → toPrecision(5)=0.092587 → 6 小数 OK
    expect(roundPrice(0.09258674039999999, 0)).toBeCloseTo(0.092587, 6);
  });
});

describe("roundPrice → floatToWire pipeline — 全 WL 銘柄の property test", () => {
  it("35 銘柄すべてが WL に登録されている", () => {
    // WL 数の sanity check（config と同期）
    expect(WL_SYMBOLS.length).toBe(35);
  });

  for (const sym of WL_SYMBOLS) {
    describe(`${sym.name} (szDec=${sym.szDec})`, () => {
      for (const mid of sym.mids) {
        // buy side (midPrice × (1 - offsetBps/10000))
        it(`buy midPrice=${mid}: roundPrice → floatToWire 通過`, () => {
          const offsetRatio = POST_ONLY_OFFSET_BPS / 10000;
          const midOffset = mid * (1 - offsetRatio);
          const rounded = roundPrice(midOffset, sym.szDec);
          expect(() => floatToWire(rounded)).not.toThrow();
        });

        // sell side (midPrice × (1 + offsetBps/10000))
        it(`sell midPrice=${mid}: roundPrice → floatToWire 通過`, () => {
          const offsetRatio = POST_ONLY_OFFSET_BPS / 10000;
          const midOffset = mid * (1 + offsetRatio);
          const rounded = roundPrice(midOffset, sym.szDec);
          expect(() => floatToWire(rounded)).not.toThrow();
        });

        // ±10% 揺らぎで property test（価格が動いても丸めが効く）
        it(`midPrice=${mid} ±10% 揺らぎ全て通過`, () => {
          const offsetRatio = POST_ONLY_OFFSET_BPS / 10000;
          for (let pct = -10; pct <= 10; pct++) {
            const perturbed = mid * (1 + pct / 100);
            if (perturbed <= 0) continue;
            for (const side of [-1, 1]) {
              const raw = perturbed * (1 + side * offsetRatio);
              const rounded = roundPrice(raw, sym.szDec);
              expect(() => floatToWire(rounded)).not.toThrow();
            }
          }
        });
      }
    });
  }
});

describe("修正前動作の回帰防止 — raw 価格が throw することを記録", () => {
  it("CHIP 事故再現: raw 価格は floatToWire で throw する", () => {
    // この挙動が変われば (例: HL SDK が 1e-12 許容を緩和) テスト失敗で気付ける
    expect(() => floatToWire(0.0950684922)).toThrow();
    expect(() => floatToWire(0.09258674039999999)).toThrow();
  });

  it("修正効果の確認: 事故値も roundPrice 経由なら通る", () => {
    expect(floatToWire(roundPrice(0.0950684922, 0))).toBe("0.095068");
    expect(floatToWire(roundPrice(0.09258674039999999, 0))).toBe("0.092587");
  });
});
