/**
 * Task B4 — HL / EXT 倍率銘柄のシンボル変換層
 *
 * Hyperliquid と Extended では倍率銘柄の命名規則が異なる:
 *   HL:  kPEPE, kSHIB, kBONK, kLUNC, kFLOKI, kDOGS, kNEIRO
 *   EXT: 1000PEPE, 1000SHIB, 1000BONK
 *
 * 実 API 確認で 1 unit の価格が完全一致することを検証済（2026-04-24）:
 *   HL kPEPE midPx 0.003838  ≡  EXT 1000PEPE markPrice 0.003838
 *
 * ゆえに `1 HL unit = 1 EXT unit = 1000 base tokens` の同値関係が成立し、
 * 発注サイズに特別な倍率計算は不要。venue-native な命名への変換のみで完結する。
 *
 * DB 方針: dn_pairs.symbol は HL 命名（kPEPE）で統一保存。
 * EXT API 呼び出し直前のみ hlToExtSymbol で変換する。
 *
 * 正規表現 `[A-Z0-9]+`:
 *   現状の HL 倍率銘柄は全て英大文字だが、将来 kABC123 のような命名が出現しても
 *   破綻しないよう数字を許容する（大文字英字/数字どちらも受け入れ）。
 */

/**
 * HL 命名 → EXT 命名。
 *   kPEPE  → 1000PEPE
 *   BTC    → BTC  (非倍率銘柄はそのまま)
 */
export function hlToExtSymbol(hlSymbol: string): string {
  const match = hlSymbol.match(/^k([A-Z0-9]+)$/);
  return match ? `1000${match[1]}` : hlSymbol;
}

/**
 * EXT 命名 → HL 命名。
 *   1000PEPE → kPEPE
 *   BTC      → BTC
 */
export function extToHlSymbol(extSymbol: string): string {
  const match = extSymbol.match(/^1000([A-Z0-9]+)$/);
  return match ? `k${match[1]}` : extSymbol;
}

/**
 * 倍率銘柄かどうかの判定。
 * 注意: HL の実銘柄 `0G`, `2Z` 等の「数字で始まる通常銘柄」は false を返す。
 * （旧 parseMultiplierSymbol の ^(\d+)([A-Z]+)$ パターンでは誤検知していた）
 */
export function isMultiplierSymbol(symbol: string): boolean {
  return /^k[A-Z0-9]+$/.test(symbol) || /^1000[A-Z0-9]+$/.test(symbol);
}

/**
 * 正規化されたベース銘柄名を返す。
 *   kPEPE    → PEPE
 *   1000PEPE → PEPE
 *   BTC      → BTC (非倍率はそのまま)
 */
export function getBaseSymbol(symbol: string): string {
  const kMatch = symbol.match(/^k([A-Z0-9]+)$/);
  if (kMatch) return kMatch[1];
  const thousandMatch = symbol.match(/^1000([A-Z0-9]+)$/);
  if (thousandMatch) return thousandMatch[1];
  return symbol;
}
