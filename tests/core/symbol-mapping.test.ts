/**
 * Task B4 — シンボル変換ユーティリティの境界値テスト
 *
 * 検証対象:
 *   1. hlToExtSymbol: HL 命名 (kPEPE) → EXT 命名 (1000PEPE)
 *   2. extToHlSymbol: EXT 命名 (1000PEPE) → HL 命名 (kPEPE)
 *   3. isMultiplierSymbol: 倍率銘柄判定 + 既存 latent bug の誤検知解消 (0G/2Z)
 *   4. getBaseSymbol: 正規化ベース (PEPE, SHIB, ...)
 *   5. Round-trip 性
 *   6. parseMultiplierSymbol の下位互換 + 0G/2Z 誤検知解消
 */

import {
  hlToExtSymbol,
  extToHlSymbol,
  isMultiplierSymbol,
  getBaseSymbol,
} from "../../src/core/symbol-mapping";
import { parseMultiplierSymbol } from "../../src/core/config";

describe("hlToExtSymbol — HL → EXT 変換", () => {
  it("kPEPE → 1000PEPE", () => {
    expect(hlToExtSymbol("kPEPE")).toBe("1000PEPE");
  });

  it("kSHIB → 1000SHIB", () => {
    expect(hlToExtSymbol("kSHIB")).toBe("1000SHIB");
  });

  it("kBONK → 1000BONK", () => {
    expect(hlToExtSymbol("kBONK")).toBe("1000BONK");
  });

  it("BTC → BTC (非倍率銘柄は恒等)", () => {
    expect(hlToExtSymbol("BTC")).toBe("BTC");
  });

  it("空文字 → 空文字 (エッジケース)", () => {
    expect(hlToExtSymbol("")).toBe("");
  });

  it("KAITO → KAITO (大文字 K は倍率ではない)", () => {
    // KAITO は Task B1 Tier 2 で追加した通常銘柄。
    // `^k([A-Z0-9]+)$` (小文字 k) なので誤変換されない。
    expect(hlToExtSymbol("KAITO")).toBe("KAITO");
  });
});

describe("extToHlSymbol — EXT → HL 変換", () => {
  it("1000PEPE → kPEPE", () => {
    expect(extToHlSymbol("1000PEPE")).toBe("kPEPE");
  });

  it("1000BONK → kBONK", () => {
    expect(extToHlSymbol("1000BONK")).toBe("kBONK");
  });

  it("BTC → BTC (非倍率銘柄は恒等)", () => {
    expect(extToHlSymbol("BTC")).toBe("BTC");
  });

  it("100BTC → 100BTC (1000 以外の数字接頭は変換対象外)", () => {
    expect(extToHlSymbol("100BTC")).toBe("100BTC");
  });
});

describe("isMultiplierSymbol — 倍率銘柄判定", () => {
  it("kPEPE → true", () => {
    expect(isMultiplierSymbol("kPEPE")).toBe(true);
  });

  it("1000PEPE → true", () => {
    expect(isMultiplierSymbol("1000PEPE")).toBe(true);
  });

  it("BTC → false", () => {
    expect(isMultiplierSymbol("BTC")).toBe(false);
  });

  it("0G → false (latent bug 解消: 旧 ^(\\d+)([A-Z]+)$ では誤検知)", () => {
    // 0G は HL の実銘柄。旧 parseMultiplierSymbol パターンでは
    // `multiplier=0, baseSymbol="G"` と誤判定されていた。
    expect(isMultiplierSymbol("0G")).toBe(false);
  });

  it("2Z → false (同上、本番ログ '[HL] 倍率銘柄検出: 2Z' の原因)", () => {
    expect(isMultiplierSymbol("2Z")).toBe(false);
  });

  it("KAITO → false (大文字 K 始まりは倍率ではない)", () => {
    expect(isMultiplierSymbol("KAITO")).toBe(false);
  });

  it("k → false (k のみ、base 部分が必要)", () => {
    expect(isMultiplierSymbol("k")).toBe(false);
  });

  it("1000 → false (1000 のみ、base 部分が必要)", () => {
    expect(isMultiplierSymbol("1000")).toBe(false);
  });
});

describe("getBaseSymbol — 正規化ベース", () => {
  it("kPEPE → PEPE", () => {
    expect(getBaseSymbol("kPEPE")).toBe("PEPE");
  });

  it("1000PEPE → PEPE", () => {
    expect(getBaseSymbol("1000PEPE")).toBe("PEPE");
  });

  it("BTC → BTC (非倍率は恒等)", () => {
    expect(getBaseSymbol("BTC")).toBe("BTC");
  });

  it("kBONK → BONK", () => {
    expect(getBaseSymbol("kBONK")).toBe("BONK");
  });

  it("1000SHIB → SHIB", () => {
    expect(getBaseSymbol("1000SHIB")).toBe("SHIB");
  });
});

describe("Round-trip 性", () => {
  it("extToHlSymbol(hlToExtSymbol(kPEPE)) === kPEPE", () => {
    expect(extToHlSymbol(hlToExtSymbol("kPEPE"))).toBe("kPEPE");
  });

  it("extToHlSymbol(hlToExtSymbol(BTC)) === BTC (非倍率の恒等性)", () => {
    expect(extToHlSymbol(hlToExtSymbol("BTC"))).toBe("BTC");
  });

  it("hlToExtSymbol(extToHlSymbol(1000PEPE)) === 1000PEPE", () => {
    expect(hlToExtSymbol(extToHlSymbol("1000PEPE"))).toBe("1000PEPE");
  });
});

describe("parseMultiplierSymbol — 下位互換 + latent bug 解消", () => {
  it("kPEPE → multiplier=1000, baseSymbol=PEPE (旧実装では multiplier=1 で破綻)", () => {
    const res = parseMultiplierSymbol("kPEPE");
    expect(res.multiplier).toBe(1000);
    expect(res.baseSymbol).toBe("PEPE");
  });

  it("1000PEPE → multiplier=1000, baseSymbol=PEPE (旧実装との後方互換)", () => {
    const res = parseMultiplierSymbol("1000PEPE");
    expect(res.multiplier).toBe(1000);
    expect(res.baseSymbol).toBe("PEPE");
  });

  it("BTC → multiplier=1, baseSymbol=BTC", () => {
    const res = parseMultiplierSymbol("BTC");
    expect(res.multiplier).toBe(1);
    expect(res.baseSymbol).toBe("BTC");
  });

  it("0G → multiplier=1, baseSymbol=0G (latent bug 解消: 旧 multiplier=0, baseSymbol=G)", () => {
    const res = parseMultiplierSymbol("0G");
    expect(res.multiplier).toBe(1);
    expect(res.baseSymbol).toBe("0G");
  });

  it("2Z → multiplier=1, baseSymbol=2Z (latent bug 解消: 旧 multiplier=2, baseSymbol=Z)", () => {
    const res = parseMultiplierSymbol("2Z");
    expect(res.multiplier).toBe(1);
    expect(res.baseSymbol).toBe("2Z");
  });
});
