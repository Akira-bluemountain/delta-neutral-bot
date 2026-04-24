/**
 * Task B5 — 銘柄別 maxPositionUsd override の検証
 *
 * 検証対象:
 *   1. getMaxPositionUsd: 既存銘柄はデフォルト ($50)、薄板銘柄は override ($10)
 *   2. SYMBOL_CONFIGS の登録内容（+3 銘柄: kBONK, AVNT, EIGEN）
 *   3. 除外銘柄が SYMBOL_CONFIGS に含まれないこと（CAKE, VIRTUAL は Phase B6 送り）
 *   4. 既存 32 銘柄が SYMBOL_CONFIGS に含まれないこと（デフォルト $50 維持）
 *   5. isThinBookSymbol 判定（ログ表示用）
 */

import { DN_PARAMS } from "../../src/core/config";
import {
  SYMBOL_CONFIGS,
  getMaxPositionUsd,
  isThinBookSymbol,
} from "../../src/core/symbol-configs";

// 既存 32 銘柄（Task B4 時点）
const EXISTING_32 = [
  "BTC", "ETH", "SOL", "BNB", "XRP",
  "XMR", "LINK", "AVAX", "LTC", "HYPE",
  "SUI", "APT", "UNI", "TAO", "DOGE",
  "AAVE", "CHIP", "ZEC", "ENA", "ADA",
  "LIT", "XPL", "FARTCOIN", "MON", "PUMP",
  "STRK", "TON", "AERO", "LDO", "KAITO",
  "GRASS", "kPEPE",
] as const;

// Task B5 で追加する薄板銘柄
const THIN_BOOK_SYMBOLS = ["kBONK", "AVNT", "EIGEN"] as const;

// Phase 2 で除外した銘柄（Phase B6 以降で再検討）
const EXCLUDED_FROM_B5 = ["CAKE", "VIRTUAL", "kSHIB"] as const;

describe("getMaxPositionUsd — 銘柄別上限取得", () => {
  it("XMR → 50 (既存銘柄、デフォルト)", () => {
    expect(getMaxPositionUsd("XMR")).toBe(50);
  });

  it("kBONK → 10 (B5 追加薄板)", () => {
    expect(getMaxPositionUsd("kBONK")).toBe(10);
  });

  it("AVNT → 10 (B5 追加薄板)", () => {
    expect(getMaxPositionUsd("AVNT")).toBe(10);
  });

  it("EIGEN → 10 (B5 追加薄板)", () => {
    expect(getMaxPositionUsd("EIGEN")).toBe(10);
  });

  it("UNKNOWN_XXX → 50 (未登録銘柄はデフォルト)", () => {
    expect(getMaxPositionUsd("UNKNOWN_XXX")).toBe(50);
  });

  it("kPEPE → 50 (Tier 4 倍率銘柄だが vol 十分で通常サイズ)", () => {
    expect(getMaxPositionUsd("kPEPE")).toBe(50);
  });

  it("デフォルトは DN_PARAMS.maxPositionUsd と一致 (50)", () => {
    expect(getMaxPositionUsd("ZZZ_NOT_IN_CONFIG")).toBe(
      DN_PARAMS.maxPositionUsd
    );
  });
});

describe("SYMBOL_CONFIGS — 登録内容", () => {
  it.each(THIN_BOOK_SYMBOLS)(
    "%s が SYMBOL_CONFIGS に含まれる (maxPositionUsd=10)",
    (sym) => {
      expect(SYMBOL_CONFIGS[sym]).toBeDefined();
      expect(SYMBOL_CONFIGS[sym].maxPositionUsd).toBe(10);
    }
  );

  it.each(EXISTING_32)(
    "既存銘柄 %s は SYMBOL_CONFIGS に含まれない (デフォルト $50 維持)",
    (sym) => {
      expect(SYMBOL_CONFIGS[sym]).toBeUndefined();
    }
  );

  it.each(EXCLUDED_FROM_B5)(
    "Phase B5 除外銘柄 %s は SYMBOL_CONFIGS に含まれない",
    (sym) => {
      expect(SYMBOL_CONFIGS[sym]).toBeUndefined();
    }
  );

  it("SYMBOL_CONFIGS のエントリ数は薄板銘柄と一致（他の銘柄が混入していない）", () => {
    expect(Object.keys(SYMBOL_CONFIGS).sort()).toEqual(
      [...THIN_BOOK_SYMBOLS].sort()
    );
  });
});

describe("isThinBookSymbol — 薄板判定", () => {
  it("kBONK → true", () => {
    expect(isThinBookSymbol("kBONK")).toBe(true);
  });

  it("AVNT → true", () => {
    expect(isThinBookSymbol("AVNT")).toBe(true);
  });

  it("EIGEN → true", () => {
    expect(isThinBookSymbol("EIGEN")).toBe(true);
  });

  it("XMR → false (通常サイズ $50)", () => {
    expect(isThinBookSymbol("XMR")).toBe(false);
  });

  it("kPEPE → false (倍率銘柄だが通常サイズ)", () => {
    expect(isThinBookSymbol("kPEPE")).toBe(false);
  });

  it("UNKNOWN → false (未登録はデフォルト扱い)", () => {
    expect(isThinBookSymbol("UNKNOWN")).toBe(false);
  });
});
