/**
 * Task C2 — screener の max(|HL|, |EXT|) ベース FR フィルタ境界値テスト
 *
 * 旧実装: filter は HL 単独 |FR| で判定、EIGEN 等の「HL ほぼ 0 / EXT 高 FR」を除外
 * 新実装: filter / sort を max(|HL|, |EXT|) ベースに変更、片側高 FR も捕捉
 *
 * selectCandidatesByMaxFr は pure function で DB / API 依存なし、
 * テストは fixture（FundingRate オブジェクト配列 + Map）だけで完結。
 */

import { selectCandidatesByMaxFr } from "../../src/analyzers/screener";
import { FundingRate } from "../../src/core/types";

function makeHlRate(symbol: string, rate: number): FundingRate {
  return {
    venue: "hyperliquid",
    symbol,
    rate,
    annualized: rate * 24 * 365 * 100,
    nextFundingTime: new Date(),
    timestamp: new Date(),
  };
}

function makeExtRate(symbol: string, rate: number): FundingRate {
  return {
    venue: "extended",
    symbol,
    rate,
    annualized: rate * 24 * 365 * 100,
    nextFundingTime: new Date(),
    timestamp: new Date(),
  };
}

function makeExtMap(entries: Array<[string, number]>): Map<string, FundingRate> {
  const m = new Map<string, FundingRate>();
  for (const [sym, rate] of entries) m.set(sym, makeExtRate(sym, rate));
  return m;
}

const MIN = 0.00005; // SCREENING.minFundingRate 現行値（年率 44% 相当）
const MAX_N = 60;

describe("selectCandidatesByMaxFr — Task C2 max(|HL|,|EXT|) フィルタ", () => {
  it("[ケース1] HL 高 / EXT 低 → 通過（既存挙動互換）", () => {
    const hlRates = [makeHlRate("BTC", 0.001)];
    const extMap = makeExtMap([["BTC", 0.00001]]);
    const result = selectCandidatesByMaxFr(hlRates, extMap, MIN, MAX_N);
    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe("BTC");
  });

  it("[ケース2] HL 低 / EXT 高 → 通過（新挙動、EIGEN ケース）", () => {
    // EIGEN 実測: HL -0.0016% = -0.000016, EXT -0.015% = -0.00015
    const hlRates = [makeHlRate("EIGEN", -0.000016)];
    const extMap = makeExtMap([["EIGEN", -0.00015]]);
    const result = selectCandidatesByMaxFr(hlRates, extMap, MIN, MAX_N);
    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe("EIGEN");
    // HL rate がそのまま保持されていることも確認（下流処理互換）
    expect(result[0].rate).toBe(-0.000016);
  });

  it("[ケース3] 両側低 → 除外", () => {
    const hlRates = [makeHlRate("LOW", 0.00001)];
    const extMap = makeExtMap([["LOW", 0.00001]]);
    const result = selectCandidatesByMaxFr(hlRates, extMap, MIN, MAX_N);
    expect(result).toHaveLength(0);
  });

  it("[ケース4] 両側高 → 通過", () => {
    const hlRates = [makeHlRate("HOT", 0.001)];
    const extMap = makeExtMap([["HOT", 0.002]]);
    const result = selectCandidatesByMaxFr(hlRates, extMap, MIN, MAX_N);
    expect(result).toHaveLength(1);
  });

  it("[ケース5] EXT データなし + HL 高 → 通過（HL 単独フォールバック）", () => {
    const hlRates = [makeHlRate("HLONLY", 0.001)];
    const extMap = makeExtMap([]);
    const result = selectCandidatesByMaxFr(hlRates, extMap, MIN, MAX_N);
    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe("HLONLY");
  });

  it("[ケース6] EXT データなし + HL 低 → 除外", () => {
    const hlRates = [makeHlRate("WEAK", 0.00001)];
    const extMap = makeExtMap([]);
    const result = selectCandidatesByMaxFr(hlRates, extMap, MIN, MAX_N);
    expect(result).toHaveLength(0);
  });

  it("[ケース7] 両側 0 → 除外", () => {
    const hlRates = [makeHlRate("ZERO", 0)];
    const extMap = makeExtMap([["ZERO", 0]]);
    const result = selectCandidatesByMaxFr(hlRates, extMap, MIN, MAX_N);
    expect(result).toHaveLength(0);
  });

  it("[ケース8] 境界値 HL=min, EXT=0 → 通過（>= 判定）", () => {
    const hlRates = [makeHlRate("BOUND_HL", MIN)];
    const extMap = makeExtMap([["BOUND_HL", 0]]);
    const result = selectCandidatesByMaxFr(hlRates, extMap, MIN, MAX_N);
    expect(result).toHaveLength(1);
  });

  it("[ケース9] 境界値 EXT=min, HL=0 → 通過", () => {
    const hlRates = [makeHlRate("BOUND_EXT", 0)];
    const extMap = makeExtMap([["BOUND_EXT", MIN]]);
    const result = selectCandidatesByMaxFr(hlRates, extMap, MIN, MAX_N);
    expect(result).toHaveLength(1);
  });

  it("[ケース10] 境界値 HL=min-ε, EXT=min-ε → 除外", () => {
    const eps = 1e-9;
    const hlRates = [makeHlRate("BELOW", MIN - eps)];
    const extMap = makeExtMap([["BELOW", MIN - eps]]);
    const result = selectCandidatesByMaxFr(hlRates, extMap, MIN, MAX_N);
    expect(result).toHaveLength(0);
  });

  it("[ケース11] 負の FR は絶対値で判定", () => {
    const hlRates = [makeHlRate("NEG", -0.001)];
    const extMap = makeExtMap([["NEG", 0.00001]]);
    const result = selectCandidatesByMaxFr(hlRates, extMap, MIN, MAX_N);
    expect(result).toHaveLength(1);
  });

  it("[ケース12] 倍率銘柄 kPEPE(HL)/1000PEPE(EXT) 変換経由で通過", () => {
    // HL は kPEPE 命名、EXT Map は 1000PEPE 命名で登録される想定
    const hlRates = [makeHlRate("kPEPE", 0.00001)]; // HL 単独では除外される低さ
    const extMap = makeExtMap([["1000PEPE", 0.001]]); // EXT で高 FR
    const result = selectCandidatesByMaxFr(hlRates, extMap, MIN, MAX_N);
    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe("kPEPE"); // HL 命名で返る（下流互換）
  });

  it("[ケース13] maxCandidates で切り詰め（上位 N のみ返却）", () => {
    const hlRates = Array.from({ length: 100 }, (_, i) =>
      makeHlRate(`SYM${i}`, 0.001 + i * 1e-6)
    );
    const extMap = makeExtMap(
      Array.from({ length: 100 }, (_, i) => [`SYM${i}`, 0] as [string, number])
    );
    const result = selectCandidatesByMaxFr(hlRates, extMap, MIN, MAX_N);
    expect(result).toHaveLength(MAX_N);
  });

  it("[ケース14] ソート順は max(|HL|,|EXT|) 降順（EXT 高が HL 高より上位）", () => {
    const hlRates = [
      makeHlRate("HLHIGH", 0.001),   // max = 0.001
      makeHlRate("EXTHIGH", 0.00001), // max = 0.01 (EXT)
      makeHlRate("MID", 0.0005),      // max = 0.0005
    ];
    const extMap = makeExtMap([
      ["HLHIGH", 0.00001],
      ["EXTHIGH", 0.01],
      ["MID", 0],
    ]);
    const result = selectCandidatesByMaxFr(hlRates, extMap, MIN, MAX_N);
    expect(result.map((r) => r.symbol)).toEqual(["EXTHIGH", "HLHIGH", "MID"]);
  });

  it("[ケース15] 空配列入力は空配列返却", () => {
    const result = selectCandidatesByMaxFr([], new Map(), MIN, MAX_N);
    expect(result).toEqual([]);
  });

  it("[追加] 符号が HL/EXT で反対でも max 判定は絶対値の大きい方", () => {
    // HL +0.0001, EXT -0.002 → max(0.0001, 0.002) = 0.002
    const hlRates = [makeHlRate("OPP", 0.0001)];
    const extMap = makeExtMap([["OPP", -0.002]]);
    const result = selectCandidatesByMaxFr(hlRates, extMap, MIN, MAX_N);
    expect(result).toHaveLength(1);
  });

  it("[追加] 混在フィルタ: 一部通過・一部除外・一部 EXT なし", () => {
    const hlRates = [
      makeHlRate("PASS_HL", 0.001),         // HL 高
      makeHlRate("PASS_EXT", 0.00001),      // EXT 高
      makeHlRate("FAIL_BOTH", 0.00001),     // 両側低
      makeHlRate("PASS_NOEXT", 0.001),      // HL 高、EXT データなし
      makeHlRate("FAIL_NOEXT", 0.00001),    // HL 低、EXT データなし
    ];
    const extMap = makeExtMap([
      ["PASS_HL", 0.00001],
      ["PASS_EXT", 0.002],
      ["FAIL_BOTH", 0.00001],
    ]);
    const result = selectCandidatesByMaxFr(hlRates, extMap, MIN, MAX_N);
    const passed = result.map((r) => r.symbol).sort();
    expect(passed).toEqual(["PASS_EXT", "PASS_HL", "PASS_NOEXT"]);
  });
});
