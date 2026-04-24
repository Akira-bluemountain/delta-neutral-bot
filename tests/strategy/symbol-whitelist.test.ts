/**
 * Task B1 / B1-extend / B4 / B5 — ホワイトリスト拡大の構成検証
 *
 * 検証対象:
 *   1. DN_PARAMS.symbolWhitelist の構造（件数・重複・空白混入なし）
 *   2. 既存 15 銘柄の継続保持（Task B1 で既存銘柄の削除は禁止）
 *   3. Task B1 で追加した Tier 1/2 の 15 銘柄が全て含まれること
 *   4. Task B1-extend で追加した Tier 3 の 1 銘柄 (GRASS) が含まれること
 *   5. Task B4 で追加した Tier 4 の 1 銘柄 (kPEPE) が含まれること
 *   6. Task B5 で追加した薄板 3 銘柄 (kBONK, AVNT, EIGEN) が含まれること
 *   7. passesEntryFilter が依存している `Array.includes` のセマンティクスで
 *      新規銘柄が実際に通過すること（src/strategy/dn-strategy.ts:225 のロジック再現）
 *   8. 今スコープ外とした銘柄（CAKE: $10 tier 不可 / VIRTUAL: FR 活動ほぼなし）が
 *      含まれていないこと
 */

import { DN_PARAMS } from "../../src/core/config";

// Task B1 で継続保持する既存 15 銘柄（Phase A 時点のホワイトリスト）
const EXISTING_SYMBOLS = [
  "BTC", "ETH", "SOL", "BNB", "XRP",
  "XMR", "LINK", "AVAX", "LTC", "HYPE",
  "SUI", "APT", "UNI", "TAO", "DOGE",
] as const;

// Task B1 で追加する 15 銘柄（Tier 1: 10, Tier 2: 5）
const NEW_TIER1 = [
  "AAVE", "CHIP", "ZEC", "ENA", "ADA",
  "LIT", "XPL", "FARTCOIN", "MON", "PUMP",
] as const;
const NEW_TIER2 = [
  "STRK", "TON", "AERO", "LDO", "KAITO",
] as const;

// Task B1-extend で追加する 1 銘柄（Tier 3: 48h FR 持続性で選定）
const NEW_TIER3 = ["GRASS"] as const;

// Task B4 で追加する 1 銘柄（Tier 4: 倍率銘柄シンボル変換層経由）
const NEW_TIER4 = ["kPEPE"] as const;

// Task B5 で追加する 3 銘柄（薄板 $10 tier、SYMBOL_CONFIGS で個別上限設定）
//   kBONK: Tier 4 倍率銘柄 + 薄板、EXT 1000BONK
//   AVNT: 48h frOpen 突破 4/48 実績、EXT vol $42k 境界
//   EIGEN: B1 Phase 1 で 66.6% APY 観測実績
const NEW_TIER5_THIN = ["kBONK", "AVNT", "EIGEN"] as const;

// 今スコープ外（Phase B6 以降で再検討）:
//   - CAKE: EXT min notional $15.03 のため $10 tier 不可
//   - VIRTUAL: EXT vol $45k + 48h FR 活動度ほぼなし (frClose 突破 0/48)
//   - kSHIB: EXT vol $2.5k 事実上死、板維持できず
//   - EXT 命名で直接入れてはいけない: 1000PEPE, 1000SHIB, 1000BONK
//     （Task B4 以降は DB/WL とも HL 命名で統一、変換は発注直前のみ）
const OUT_OF_SCOPE = [
  "CAKE", "VIRTUAL", "kSHIB",
  "1000PEPE", "1000SHIB", "1000BONK",
] as const;

describe("symbolWhitelist — 構造検証", () => {
  it("合計 35 銘柄", () => {
    expect(DN_PARAMS.symbolWhitelist.length).toBe(35);
  });

  it("重複なし", () => {
    const unique = new Set(DN_PARAMS.symbolWhitelist);
    expect(unique.size).toBe(DN_PARAMS.symbolWhitelist.length);
  });

  it("各エントリは trim 済みの非空文字列", () => {
    for (const s of DN_PARAMS.symbolWhitelist) {
      expect(typeof s).toBe("string");
      expect(s.length).toBeGreaterThan(0);
      expect(s).toBe(s.trim());
    }
  });
});

describe("symbolWhitelist — 既存銘柄の継続保持", () => {
  it.each(EXISTING_SYMBOLS)(
    "既存銘柄 %s が引き続き含まれる（Task B1 は追加のみで削除禁止）",
    (symbol) => {
      expect(DN_PARAMS.symbolWhitelist).toContain(symbol);
    }
  );
});

describe("symbolWhitelist — Task B1 新規追加銘柄", () => {
  it.each(NEW_TIER1)(
    "Tier 1 銘柄 %s が追加されている（EXT $1M+/day）",
    (symbol) => {
      expect(DN_PARAMS.symbolWhitelist).toContain(symbol);
    }
  );

  it.each(NEW_TIER2)(
    "Tier 2 銘柄 %s が追加されている（EXT $200k-1M/day）",
    (symbol) => {
      expect(DN_PARAMS.symbolWhitelist).toContain(symbol);
    }
  );
});

describe("symbolWhitelist — Task B1-extend 新規追加銘柄", () => {
  it.each(NEW_TIER3)(
    "Tier 3 銘柄 %s が追加されている（48h FR 持続性 frOpen 3/48, frClose 19/48）",
    (symbol) => {
      expect(DN_PARAMS.symbolWhitelist).toContain(symbol);
    }
  );
});

describe("symbolWhitelist — Task B4 新規追加銘柄（倍率銘柄）", () => {
  it.each(NEW_TIER4)(
    "Tier 4 銘柄 %s が追加されている（HL kPEPE ↔ EXT 1000PEPE、symbol-mapping 経由）",
    (symbol) => {
      expect(DN_PARAMS.symbolWhitelist).toContain(symbol);
    }
  );
});

describe("symbolWhitelist — Task B5 新規追加銘柄（薄板 $10 tier）", () => {
  it.each(NEW_TIER5_THIN)(
    "薄板銘柄 %s が追加されている（SYMBOL_CONFIGS で maxPositionUsd=10）",
    (symbol) => {
      expect(DN_PARAMS.symbolWhitelist).toContain(symbol);
    }
  );
});

describe("symbolWhitelist — Phase B1 スコープ外の銘柄は含まない", () => {
  it.each(OUT_OF_SCOPE)("%s は含まれない（Phase B2 で再検討）", (symbol) => {
    expect(DN_PARAMS.symbolWhitelist).not.toContain(symbol);
  });
});

describe("passesEntryFilter のホワイトリスト通過セマンティクス", () => {
  // src/strategy/dn-strategy.ts:225 のロジック:
  //   if (DN_PARAMS.symbolWhitelist.length > 0 && !DN_PARAMS.symbolWhitelist.includes(s.symbol)) reject
  // → 拡大前は新規銘柄で reject されていたが、拡大後は pass する
  const wouldPassWhitelistCheck = (symbol: string): boolean => {
    return (
      DN_PARAMS.symbolWhitelist.length === 0 ||
      DN_PARAMS.symbolWhitelist.includes(symbol)
    );
  };

  it.each([...NEW_TIER1, ...NEW_TIER2, ...NEW_TIER3, ...NEW_TIER4, ...NEW_TIER5_THIN])(
    "新規銘柄 %s はホワイトリスト判定を通過する",
    (symbol) => {
      expect(wouldPassWhitelistCheck(symbol)).toBe(true);
    }
  );

  it.each(EXISTING_SYMBOLS)(
    "既存銘柄 %s はホワイトリスト判定を通過する（後方互換）",
    (symbol) => {
      expect(wouldPassWhitelistCheck(symbol)).toBe(true);
    }
  );

  it.each(OUT_OF_SCOPE)(
    "スコープ外銘柄 %s はホワイトリスト判定で除外される",
    (symbol) => {
      expect(wouldPassWhitelistCheck(symbol)).toBe(false);
    }
  );

  it("完全に未知のシンボルはホワイトリスト判定で除外される", () => {
    expect(wouldPassWhitelistCheck("DOES_NOT_EXIST")).toBe(false);
    expect(wouldPassWhitelistCheck("")).toBe(false);
  });

  it("大文字小文字は区別される（HL 命名規約: 大文字前提）", () => {
    // 実 HL API は大文字を返すが、万一小文字化された場合に誤通過しないことを確認
    expect(wouldPassWhitelistCheck("btc")).toBe(false);
    expect(wouldPassWhitelistCheck("aave")).toBe(false);
  });
});
